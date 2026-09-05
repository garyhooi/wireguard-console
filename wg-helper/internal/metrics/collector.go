// Package metrics collects host-level resource snapshots (CPU, memory,
// disk, load, uptime, network) for the console's server-monitoring page.
//
// The wg-helper agent runs inside a container with --network host but not
// host PID/mount namespaces.
//
// CPU/memory/load/uptime/net come from /proc files that are kernel-global
// (not namespaced): /proc/stat, /proc/meminfo, /proc/loadavg,
// /proc/uptime and (with --network host) /proc/net/dev report HOST values
// even from inside the container. They are therefore always read from the
// process's NATIVE /proc (ProcRoot is empty in production) — no bind mount
// is needed or wanted for them.
//
// Disk usage is the exception: statfs(2) resolves paths in the container's
// own mount namespace, so reading the container's overlay would be wrong.
// The installer bind-mounts the host root read-only at /host
// (-v /:/host:ro,rslave). The host's real filesystems then appear inside
// the container as /host (and any submounts under /host/...), which the
// collector statfs'es directly. HostRoot is "" on a bare host (local
// mode) and "/host" in the agent container.
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

// Collector reads one host snapshot.
type Collector struct {
	// ProcRoot prefixes /proc reads. Empty in production: the native /proc
	// inside a --network host container already reflects the host kernel.
	// Tests point it at a fixture tree.
	ProcRoot string

	// HostRoot is the host filesystem root as visible to this process:
	// "" for a bare host (local mode, statfs native paths), "/host" when
	// the host root is bind-mounted into the agent container.
	HostRoot string

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

func NewCollector(procRoot, hostRoot string) *Collector {
	return &Collector{ProcRoot: procRoot, HostRoot: hostRoot, netPrev: map[string]netCounters{}}
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

// procFile returns the native proc path for p (/proc/...), prefixed with
// ProcRoot when set (tests only). Proc reads MUST NOT go through HostRoot:
// the host /proc is not reachable via a root bind mount.
func (c *Collector) procFile(p string) string {
	return c.ProcRoot + p
}

// hostFile returns the host-filesystem path for p, prefixed with HostRoot
// ("/host/etc/os-release" inside the agent container, "/etc/os-release" on
// a bare host). Only used for statfs targets and host identity files that
// the bind mount actually exposes.
func (c *Collector) hostFile(p string) string {
	return c.HostRoot + p
}

// readProc returns the trimmed contents of a native proc file.
func (c *Collector) readProc(p string) (string, error) {
	b, err := os.ReadFile(c.procFile(p))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// readHost returns the trimmed contents of a host-filesystem file.
func (c *Collector) readHost(p string) (string, error) {
	b, err := os.ReadFile(c.hostFile(p))
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
	path := c.procFile("/proc/stat")
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
	raw, err := c.readProc("/proc/loadavg")
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
	raw, err := c.readProc("/proc/uptime")
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
	raw, err := c.readProc("/proc/meminfo")
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

// mountCandidate is one host filesystem discovered from the mount table.
type mountCandidate struct {
	dev, path, fs string // path = in-container path to statfs
	label         string // path shown in the UI (host path)
}

// parseMountCandidates reads a /proc/mounts body and returns the real
// filesystems the collector should statfs, deduped by device.
//
// hostRoot is the host filesystem root as visible to this process:
//
//   - "" (bare host): keep every non-pseudo mount; path == label.
//   - "/host" (agent container): the container's own /proc/mounts lists the
//     /host bind and any propagated host submounts (/host/boot, ...) plus
//     container-local mounts (overlay "/", /proc, /sys, tmpfs ...). Only
//     /host-prefixed entries are kept, labeled with the stripped host path
//     ("/", "/boot") for display.
func parseMountCandidates(raw, hostRoot string) []mountCandidate {
	type line struct{ dev, path, fs string }
	var lines []line
	seen := map[string]bool{} // dedupe by device so binds don't double-count
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
		lines = append(lines, line{dev: dev, path: path, fs: fs})
	}

	cands := make([]mountCandidate, 0, len(lines))
	for _, ln := range lines {
		label := ln.path
		if hostRoot != "" && hostRoot != "/" {
			if ln.path != hostRoot && !strings.HasPrefix(ln.path, hostRoot+"/") {
				continue // container-local mount, not a host filesystem
			}
			label = strings.TrimPrefix(ln.path, hostRoot)
			if label == "" {
				label = "/"
			}
		}
		cands = append(cands, mountCandidate{dev: ln.dev, path: ln.path, fs: ln.fs, label: label})
	}

	sort.Slice(cands, func(i, j int) bool {
		di, dj := strings.Count(cands[i].path, "/"), strings.Count(cands[j].path, "/")
		if di != dj {
			return di < dj // shallow mounts ("/") first
		}
		return cands[i].path < cands[j].path
	})
	return cands
}

// fillDisk statfs'es the host's real filesystems and fills s.Disk.
//
// The mount table is read from the process's NATIVE /proc/mounts: on a bare
// host that is the host's own table; in the agent container it lists the
// /host bind (HostRoot "/host"), which is exactly the set of host
// filesystems visible to the container. Each candidate is statfs'ed at its
// in-container path (/host, /host/boot, ...), which resolves to the host's
// real filesystem through the bind.
func (c *Collector) fillDisk(s *Snapshot) {
	raw, err := c.readProc("/proc/mounts")
	if err != nil {
		return
	}
	for _, m := range parseMountCandidates(raw, c.HostRoot) {
		var st syscall.Statfs_t
		if err := syscall.Statfs(m.path, &st); err != nil {
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
			Mount: m.label, Device: m.dev, FS: m.fs,
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
	raw, err := c.readProc("/proc/net/dev")
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
	// Hostname: inside the container /etc/hostname is the container's own,
	// so prefer the host's when the bind is present, else fall back.
	if hn, err := c.readHost("/etc/hostname"); err == nil && hn != "" {
		h.Hostname = hn
	} else if hn, err := os.Hostname(); err == nil {
		h.Hostname = hn
	}
	// Kernel is kernel-global — native proc is correct and always present.
	if raw, err := c.readProc("/proc/sys/kernel/osrelease"); err == nil {
		h.Kernel = raw
	}
	if b, err := os.ReadFile(c.hostFile("/etc/os-release")); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				h.OS = strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
				break
			}
		}
	}
	s.Host = h
}
