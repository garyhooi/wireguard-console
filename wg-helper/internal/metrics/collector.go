// Package metrics collects host-level resource snapshots (CPU, memory,
// disk, load, uptime, network) for the console's server-monitoring page.
//
// The wg-helper agent runs inside a container with --network host but not
// host PID/mount namespaces. Kernel-global proc files (/proc/stat,
// /proc/meminfo, /proc/loadavg, /proc/uptime) are visible host-wide from
// inside the container, so CPU/memory/load/uptime need no special setup.
// Disk usage is the exception: statfs(2) resolves paths in the container's
// own mount namespace, so the installer bind-mounts the host root read-only
// at /host (-v /:/host:ro,rslave). With slave propagation the host's proc
// and mounts appear under /host, so every path is read through a root
// prefix (Root): "/" for bare local mode, "/host" inside docker. statfs
// then sees the host's real filesystems via the bind mount.
package metrics

import (
	"bufio"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Version is stamped at build time via
//
//	-ldflags "-X github.com/wireguard-console/wg-helper/internal/metrics.Version=vX.Y.Z"
//
// and reported with every snapshot so the console can hint when an agent is
// too old to send metrics.
var Version = "dev"

// sampleWindow is the sleep between the two /proc/stat reads used to
// compute CPU percent. A package var so tests can shorten it.
var sampleWindow = 500 * time.Millisecond

// Collector reads one host snapshot. Root prefixes every proc/mount path.
type Collector struct {
	Root string

	mu      sync.Mutex
	netPrev map[string]netCounters // previous poll's per-interface counters
	netAt   time.Time              // when netPrev was captured
}

type netCounters struct{ rx, tx uint64 }

type CPUInfo struct {
	Cores   int     `json:"cores"`
	Percent float64 `json:"percent"` // aggregate busy % over the sample window, 0-100
}

type MemInfo struct {
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Percent float64 `json:"percent"` // 0-100
}

type DiskInfo struct {
	Mount   string  `json:"mount"`
	Device  string  `json:"device"`
	FS      string  `json:"fs"`
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Percent float64 `json:"percent"` // 0 when Total is 0
}

type NetInfo struct {
	Interface string  `json:"interface"`
	RxBps     float64 `json:"rx_bps"` // bytes/sec since the previous snapshot
	TxBps     float64 `json:"tx_bps"`
}

type HostInfo struct {
	Hostname     string `json:"hostname"`
	OS           string `json:"os"`
	Arch         string `json:"arch"`
	Kernel       string `json:"kernel"`
	AgentVersion string `json:"agent_version"`
}

type Snapshot struct {
	CPU         CPUInfo    `json:"cpu"`
	Load        [3]float64 `json:"load"`
	Mem         MemInfo    `json:"mem"`
	Swap        MemInfo    `json:"swap"`
	Disk        []DiskInfo `json:"disk"`
	Net         []NetInfo  `json:"net"`
	UptimeSec   int64      `json:"uptime_s"`
	Host        HostInfo   `json:"host"`
	CollectedAt time.Time  `json:"collected_at"`
}

func NewCollector(root string) *Collector {
	return &Collector{Root: root, netPrev: map[string]netCounters{}}
}

// Collect returns one host snapshot. Individual subsystems degrade to zero
// values on error rather than failing the whole report: a node that cannot
// read disk usage still reports CPU/memory.
func (c *Collector) Collect() Snapshot {
	s := Snapshot{CollectedAt: time.Now().UTC()}
	c.fillCPU(&s)
	c.fillLoad(&s)
	c.fillMem(&s)
	c.fillDisk(&s)
	c.fillNet(&s)
	c.fillUptime(&s)
	c.fillHost(&s)
	return s
}

// readFile returns the trimmed contents of Root-relative path p.
func (c *Collector) readFile(p string) (string, error) {
	b, err := os.ReadFile(c.Root + p)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// ---- CPU ----

// cpuSample is one parsed reading of /proc/stat.
type cpuSample struct {
	idle  uint64
	total uint64
	cores int
}

// readCPUSample parses the aggregate "cpu " line (idle = idle + iowait) and
// counts per-core lines. ok=false on any read/parse failure.
func readCPUSample(path string) (cpuSample, bool) {
	f, err := os.Open(path)
	if err != nil {
		return cpuSample{}, false
	}
	defer f.Close()

	var sample cpuSample
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 64*1024)
	onAgg := false
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "cpu") {
			break // /proc/stat lists cpus first
		}
		if strings.HasPrefix(line, "cpu ") {
			onAgg = true
			fields := strings.Fields(line)
			if len(fields) < 6 {
				return cpuSample{}, false
			}
			vals := make([]uint64, 0, len(fields)-1)
			for _, f := range fields[1:] {
				v, err := strconv.ParseUint(f, 10, 64)
				if err != nil {
					return cpuSample{}, false
				}
				vals = append(vals, v)
			}
			// Standard order: user nice system idle iowait irq softirq steal…
			for i, v := range vals {
				sample.total += v
				// idle = field 3, iowait = field 4 (0-based into vals).
				if i == 3 || i == 4 {
					sample.idle += v
				}
			}
			continue
		}
		// Per-core line "cpu0 …"
		sample.cores++
	}
	if err := sc.Err(); err != nil || !onAgg {
		return cpuSample{}, false
	}
	if sample.cores == 0 {
		sample.cores = 1
	}
	return sample, true
}

func (c *Collector) fillCPU(s *Snapshot) {
	path := c.Root + "/proc/stat"
	first, ok := readCPUSample(path)
	if !ok {
		return
	}
	// A short sleep gives a usable delta; total collection stays far under
	// the agent's 15 s cycle.
	time.Sleep(sampleWindow)
	second, ok := readCPUSample(path)
	if !ok {
		s.CPU.Cores = first.cores
		return
	}
	busy := cpuPercent(first, second)
	s.CPU = CPUInfo{Cores: first.cores, Percent: busy}
}

// cpuPercent computes aggregate busy % between two /proc/stat samples.
// second must be taken after first; a counter wrap or no-progress second
// sample yields 0.
func cpuPercent(first, second cpuSample) float64 {
	if second.total <= first.total {
		return 0
	}
	dTotal := second.total - first.total
	if dTotal == 0 {
		return 0
	}
	dIdle := second.idle - first.idle
	if dIdle > dTotal {
		dIdle = dTotal
	}
	busy := 100 * (1 - float64(dIdle)/float64(dTotal))
	if busy < 0 {
		busy = 0
	}
	if busy > 100 {
		busy = 100
	}
	return busy
}

// ---- Load / uptime ----

func (c *Collector) fillLoad(s *Snapshot) {
	raw, err := c.readFile("/proc/loadavg")
	if err != nil {
		return
	}
	fields := strings.Fields(raw)
	if len(fields) < 3 {
		return
	}
	for i := 0; i < 3; i++ {
		v, err := strconv.ParseFloat(fields[i], 64)
		if err != nil {
			return
		}
		s.Load[i] = v
	}
}

func (c *Collector) fillUptime(s *Snapshot) {
	raw, err := c.readFile("/proc/uptime")
	if err != nil {
		return
	}
	fields := strings.Fields(raw)
	if len(fields) < 1 {
		return
	}
	if v, err := strconv.ParseFloat(fields[0], 64); err == nil {
		s.UptimeSec = int64(v)
	}
}

// ---- Memory ----

func (c *Collector) fillMem(s *Snapshot) {
	kv := map[string]uint64{}
	raw, err := c.readFile("/proc/meminfo")
	if err != nil {
		return
	}
	sc := bufio.NewScanner(strings.NewReader(raw))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		key := strings.TrimSuffix(fields[0], ":")
		v, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		kv[key] = v * 1024 // meminfo is in kB
	}

	if total, ok := kv["MemTotal"]; ok && total > 0 {
		used := total - kv["MemAvailable"]
		if used > total {
			used = total
		}
		s.Mem = MemInfo{Total: total, Used: used, Percent: pct(used, total)}
	}
	if total, ok := kv["SwapTotal"]; ok && total > 0 {
		used := total - kv["SwapFree"]
		if used > total {
			used = total
		}
		s.Swap = MemInfo{Total: total, Used: used, Percent: pct(used, total)}
	}
}

func pct(used, total uint64) float64 {
	if total == 0 {
		return 0
	}
	return 100 * float64(used) / float64(total)
}

// ---- Disk ----

// skipFS lists filesystem types that are not real disks (pseudo/synthetic
// filesystems the UI must never show as disk usage).
var skipFS = map[string]bool{
	"proc": true, "sysfs": true, "devtmpfs": true, "tmpfs": true,
	"devpts": true, "cgroup": true, "cgroup2": true, "pstore": true,
	"securityfs": true, "debugfs": true, "tracefs": true, "fusectl": true,
	"configfs": true, "bpf": true, "autofs": true, "mqueue": true,
	"hugetlbfs": true, "ramfs": true, "squashfs": true, "iso9660": true,
}

// fillDisk parses the host mount table and statfs'es each real filesystem.
// Which table is read depends on Root:
//
//   - Root "/" (bare local mode): /proc/mounts is the host's own table and
//     statfs paths resolve directly.
//   - Root "/host" (agent container): /host/proc/mounts is the host's table
//     (slave propagation) and each host path is statfs'ed via the /host
//     prefix, which resolves to the host's real filesystem through the bind.
//
// statfs failures (unreachable mounts) are skipped silently.
func (c *Collector) fillDisk(s *Snapshot) {
	raw, err := c.readFile("/proc/mounts")
	if err != nil {
		return
	}
	type mount struct{ dev, path, fs string }
	var mounts []mount
	seen := map[string]bool{} // dedupe by device so bind mounts don't double-count
	sc := bufio.NewScanner(strings.NewReader(raw))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		// dev path fs opts freq passno
		if len(fields) < 3 {
			continue
		}
		dev, path, fs := fields[0], unescapeMountPath(fields[1]), fields[2]
		if skipFS[fs] || strings.HasPrefix(dev, "/dev/loop") {
			continue
		}
		if seen[dev] {
			continue
		}
		seen[dev] = true
		mounts = append(mounts, mount{dev: dev, path: path, fs: fs})
	}

	sort.Slice(mounts, func(i, j int) bool {
		di, dj := strings.Count(mounts[i].path, "/"), strings.Count(mounts[j].path, "/")
		if di != dj {
			return di < dj // shallow mounts ("/") first
		}
		return mounts[i].path < mounts[j].path
	})

	for _, m := range mounts {
		var st syscall.Statfs_t
		statPath := m.path
		if c.Root != "" && c.Root != "/" {
			statPath = c.Root + m.path
		}
		if err := syscall.Statfs(statPath, &st); err != nil {
			continue
		}
		total := st.Blocks * uint64(st.Bsize)
		free := st.Bavail * uint64(st.Bsize)
		if total == 0 {
			continue
		}
		used := total - free
		if used > total {
			used = total
		}
		s.Disk = append(s.Disk, DiskInfo{
			Mount: m.path, Device: m.dev, FS: m.fs,
			Total: total, Used: used, Percent: pct(used, total),
		})
	}
	// Biggest first so the card's top mounts are the interesting ones.
	sort.Slice(s.Disk, func(i, j int) bool { return s.Disk[i].Total > s.Disk[j].Total })
	if len(s.Disk) > 12 {
		s.Disk = s.Disk[:12]
	}
}

// unescapeMountPath converts the \040 (space) and \011 (tab) escapes used in
// /proc/mounts back to the real characters.
func unescapeMountPath(p string) string {
	p = strings.ReplaceAll(p, `\040`, " ")
	p = strings.ReplaceAll(p, `\011`, "\t")
	return p
}

// ---- Net ----

// fillNet reports per-interface byte rates using the delta since the
// previous Collect call. The first call yields no entries (no baseline yet).
func (c *Collector) fillNet(s *Snapshot) {
	raw, err := c.readFile("/proc/net/dev")
	if err != nil {
		return
	}
	now := map[string]netCounters{}
	sc := bufio.NewScanner(strings.NewReader(raw))
	for sc.Scan() {
		line := sc.Text()
		if !strings.Contains(line, ":") {
			continue // header lines
		}
		parts := strings.SplitN(line, ":", 2)
		iface := strings.TrimSpace(parts[0])
		fields := strings.Fields(parts[1])
		if len(fields) < 9 {
			continue
		}
		// rx bytes = field 0, tx bytes = field 8
		rx, err1 := strconv.ParseUint(fields[0], 10, 64)
		tx, err2 := strconv.ParseUint(fields[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		now[iface] = netCounters{rx: rx, tx: tx}
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	elapsed := time.Since(c.netAt)
	if elapsed > 0 && c.netAt.Unix() != 0 {
		for iface, cur := range now {
			prev, ok := c.netPrev[iface]
			if !ok {
				continue
			}
			var dRx, dTx uint64
			if cur.rx >= prev.rx {
				dRx = cur.rx - prev.rx
			}
			if cur.tx >= prev.tx {
				dTx = cur.tx - prev.tx
			}
			secs := elapsed.Seconds()
			s.Net = append(s.Net, NetInfo{
				Interface: iface,
				RxBps:     float64(dRx) / secs,
				TxBps:     float64(dTx) / secs,
			})
		}
		sort.Slice(s.Net, func(i, j int) bool { return s.Net[i].Interface < s.Net[j].Interface })
		if len(s.Net) > 8 {
			s.Net = s.Net[:8]
		}
	}
	c.netPrev = now
	c.netAt = time.Now()
}

// ---- Host ----

func (c *Collector) fillHost(s *Snapshot) {
	h := HostInfo{
		OS:           runtime.GOOS,
		Arch:         runtime.GOARCH,
		AgentVersion: Version,
	}
	if hn, err := os.Hostname(); err == nil {
		h.Hostname = hn
	}
	if raw, err := c.readFile("/proc/sys/kernel/osrelease"); err == nil {
		h.Kernel = raw
	}
	if b, err := os.ReadFile(c.Root + "/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				h.OS = strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
				break
			}
		}
	}
	s.Host = h
}
