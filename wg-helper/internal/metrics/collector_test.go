package metrics

import (
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fixtureRoot builds a fake proc tree under a temp dir and returns its path.
func fixtureRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "proc", "loadavg"), "0.42 0.55 0.48 1/234 5678\n")
	writeFile(t, filepath.Join(root, "proc", "uptime"), "3564000.00 9000000.00\n")
	writeFile(t, filepath.Join(root, "proc", "meminfo"), `
MemTotal:       16384000 kB
MemFree:          500000 kB
MemAvailable:    8000000 kB
SwapTotal:        2000000 kB
SwapFree:         2000000 kB
`)
	return root
}

const statTwoCores = `cpu  1000 0 500 9000 0 0 0 0 0 0
cpu0 400 0 200 4500 0 0 0 0 0 0
cpu1 600 0 300 4500 0 0 0 0 0 0
intr 12345
ctxt 999
`

func TestReadCPUSample(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "proc", "stat"), statTwoCores)

	s, ok := readCPUSample(filepath.Join(root, "proc", "stat"))
	if !ok {
		t.Fatal("readCPUSample failed")
	}
	if s.cores != 2 {
		t.Errorf("cores = %d, want 2", s.cores)
	}
	// total = 1000+0+500+9000(+0 iowait…) = 10500; idle = 9000 (+0 iowait)
	if s.total != 10500 {
		t.Errorf("total = %d, want 10500", s.total)
	}
	if s.idle != 9000 {
		t.Errorf("idle = %d, want 9000", s.idle)
	}
}

func TestCPUPercent(t *testing.T) {
	// Sample A: 1000 busy ticks of 10000 total. Sample B: 2000 busy of 10000
	// → +1000 busy of +0 total is impossible, so instead:
	// A total 10000 idle 9000; B total 20000 idle 15000
	// dTotal = 10000, dIdle = 6000, busy = 40%.
	a := cpuSample{idle: 9000, total: 10000}
	b := cpuSample{idle: 15000, total: 20000}
	if got := cpuPercent(a, b); math.Abs(got-40) > 1e-9 {
		t.Errorf("cpuPercent = %v, want 40", got)
	}

	// No-progress second sample → 0.
	if got := cpuPercent(b, b); got != 0 {
		t.Errorf("cpuPercent(equal) = %v, want 0", got)
	}

	// Full busy: idle delta 0.
	c := cpuSample{idle: 9000, total: 10000}
	d := cpuSample{idle: 9000, total: 20000}
	if got := cpuPercent(c, d); got != 100 {
		t.Errorf("cpuPercent(full busy) = %v, want 100", got)
	}

	// Counter wrap (second < first) → 0, not negative.
	e := cpuSample{idle: 0, total: 5}
	f := cpuSample{idle: 4, total: 0}
	if got := cpuPercent(f, e); got != 0 {
		t.Errorf("cpuPercent(wrap) = %v, want 0", got)
	}
}

func TestCollectMemoryLoadUptime(t *testing.T) {
	c := NewCollector(fixtureRoot(t))
	s := c.Collect()

	if s.Mem.Total != 16384000*1024 {
		t.Errorf("mem total = %d", s.Mem.Total)
	}
	// used = total - available = 8384000 kB
	if want := uint64(8384000 * 1024); s.Mem.Used != want {
		t.Errorf("mem used = %d, want %d", s.Mem.Used, want)
	}
	if math.Abs(s.Mem.Percent-100*float64(s.Mem.Used)/float64(s.Mem.Total)) > 0.01 {
		t.Errorf("mem percent %v inconsistent with used/total", s.Mem.Percent)
	}
	// Swap full-free → used 0, percent 0.
	if s.Swap.Used != 0 || s.Swap.Percent != 0 {
		t.Errorf("swap used=%d pct=%v, want 0/0", s.Swap.Used, s.Swap.Percent)
	}
	if s.Load[0] != 0.42 || s.Load[1] != 0.55 || s.Load[2] != 0.48 {
		t.Errorf("load = %v", s.Load)
	}
	if s.UptimeSec != 3564000 {
		t.Errorf("uptime = %d", s.UptimeSec)
	}
}

func TestCollectEmptyRootDegrades(t *testing.T) {
	// A collector whose proc files are missing must return a zero-ish
	// snapshot, not panic or hang.
	c := NewCollector(t.TempDir())
	s := c.Collect()
	if s.Host.AgentVersion == "" {
		t.Error("agent version empty")
	}
	_ = s
}

func TestFillDiskFromFixture(t *testing.T) {
	root := fixtureRoot(t)
	// Create two real dirs the fixture mount table points at.
	os.MkdirAll(filepath.Join(root, "a"), 0o755)
	os.MkdirAll(filepath.Join(root, "b"), 0o755)
	writeFile(t, filepath.Join(root, "proc", "mounts"), `
/dev/sda1 / ext4 rw 0 0
/dev/sda2 /a ext4 rw 0 0
/dev/sdb1 /b xfs rw 0 0
proc /proc proc rw 0 0
tmpfs /dev/shm tmpfs rw 0 0
/dev/loop0 /snap squashfs ro 0 0
none /cgroup cgroup2 rw 0 0
`)
	// Root != "/" → fillDisk statfs'es via Root+path.
	c := NewCollector(root)
	c.Root = root + "/host" // emulate the container's /host prefix…
	// …but the mount table lives under Root/proc. Rebuild fixture under /host.
	hostRoot := filepath.Join(root, "host")
	writeFile(t, filepath.Join(hostRoot, "proc", "mounts"), `
/dev/sda1 / ext4 rw 0 0
/dev/sda2 /a ext4 rw 0 0
/dev/sdb1 /b xfs rw 0 0
proc /proc proc rw 0 0
`)
	os.MkdirAll(filepath.Join(hostRoot, "a"), 0o755)
	os.MkdirAll(filepath.Join(hostRoot, "b"), 0o755)

	var s Snapshot
	c.fillDisk(&s)
	if len(s.Disk) != 3 {
		t.Fatalf("disk entries = %d (%+v), want 3", len(s.Disk), s.Disk)
	}
	// Biggest first sorting is by statfs size; assert the set of mounts.
	got := map[string]bool{}
	for _, d := range s.Disk {
		got[d.Mount] = true
		if d.Device == "" || d.FS == "" {
			t.Errorf("disk entry missing dev/fs: %+v", d)
		}
		if d.Percent < 0 || d.Percent > 100 {
			t.Errorf("disk percent out of range: %+v", d)
		}
	}
	for _, m := range []string{"/", "/a", "/b"} {
		if !got[m] {
			t.Errorf("missing mount %q in %v", m, s.Disk)
		}
	}
}

func TestFillDiskSkipsPseudoFS(t *testing.T) {
	root := fixtureRoot(t)
	writeFile(t, filepath.Join(root, "proc", "mounts"), `
proc /proc proc rw 0 0
sysfs /sys sysfs rw 0 0
tmpfs /dev/shm tmpfs rw 0 0
cgroup /sys/fs/cgroup cgroup2 rw 0 0
/dev/loop0 /snap squashfs ro 0 0
`)
	c := NewCollector(root)
	var s Snapshot
	c.fillDisk(&s)
	if len(s.Disk) != 0 {
		t.Errorf("pseudo filesystems leaked into disk list: %+v", s.Disk)
	}
}

func TestFillNetRates(t *testing.T) {
	root := fixtureRoot(t)
	devFile := filepath.Join(root, "proc", "net", "dev")
	writeFile(t, devFile, `
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth0: 1000    10    0    0    0     0          0         0     1000    10    0    0    0     0       0          0
  wg0:  500     5    0    0    0     0          0         0      500     5    0    0    0     0       0          0
`)
	c := NewCollector(root)

	// First fillNet: baseline only → no entries.
	var s Snapshot
	c.fillNet(&s)
	if len(s.Net) != 0 {
		t.Fatalf("first fillNet produced entries: %+v", s.Net)
	}

	// Second fillNet: seed a 10s-old baseline with +1000/+2000 byte deltas.
	c.mu.Lock()
	c.netPrev = map[string]netCounters{
		"eth0": {rx: 0, tx: 0},
		"wg0":  {rx: 500, tx: 500},
	}
	c.netAt = time.Now().Add(-10 * time.Second)
	c.mu.Unlock()

	s = Snapshot{}
	c.fillNet(&s)
	if len(s.Net) != 2 {
		t.Fatalf("second fillNet entries = %d, want 2 (%+v)", len(s.Net), s.Net)
	}
	byIface := map[string]NetInfo{}
	for _, n := range s.Net {
		byIface[n.Interface] = n
	}
	eth0 := byIface["eth0"]
	if math.Abs(eth0.RxBps-100) > 0.1 || math.Abs(eth0.TxBps-100) > 0.1 {
		t.Errorf("eth0 rates = rx %.1f tx %.1f, want 100/100", eth0.RxBps, eth0.TxBps)
	}
	wg0 := byIface["wg0"]
	if wg0.RxBps != 0 || wg0.TxBps != 0 {
		t.Errorf("wg0 rates = rx %.1f tx %.1f, want 0/0", wg0.RxBps, wg0.TxBps)
	}
}

func TestUnescapeMountPath(t *testing.T) {
	if got := unescapeMountPath(`/mnt/my\040disk`); got != "/mnt/my disk" {
		t.Errorf("got %q", got)
	}
	if got := unescapeMountPath("/plain"); got != "/plain" {
		t.Errorf("got %q", got)
	}
}

func TestPct(t *testing.T) {
	if got := pct(0, 0); got != 0 {
		t.Errorf("pct(0,0) = %v", got)
	}
	if got := pct(50, 100); got != 50 {
		t.Errorf("pct(50,100) = %v", got)
	}
}
