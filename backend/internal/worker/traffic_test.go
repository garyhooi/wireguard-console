package worker

import "testing"

func TestCounterDeltas(t *testing.T) {
	cases := []struct {
		name           string
		prevRX, prevTX uint64
		curRX, curTX   uint64
		wantRX, wantTX int64
	}{
		{"monotonic forward", 1000, 2000, 1500, 2500, 500, 500},
		{"no traffic", 1000, 2000, 1000, 2000, 0, 0},
		{"zero baseline", 0, 0, 500, 600, 500, 600},
		// Kernel counter reset (peer/interface re-applied, reboot): the new
		// counter is smaller than the previous reading. That is a reset, not
		// negative traffic — both deltas must be 0, never a uint64 wrap to
		// ~2^64 that would store a huge negative int64 sample.
		{"rx reset to zero", 9000, 3000, 0, 3400, 0, 400},
		{"tx reset to zero", 9000, 3000, 9300, 0, 300, 0},
		{"both reset to zero", 9000, 3000, 0, 0, 0, 0},
		{"partial reset upwards from zero", 0, 0, 700, 0, 700, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gotRX, gotTX := counterDeltas(c.prevRX, c.prevTX, c.curRX, c.curTX)
			if gotRX != c.wantRX || gotTX != c.wantTX {
				t.Errorf("counterDeltas(%d,%d,%d,%d) = (%d,%d), want (%d,%d)",
					c.prevRX, c.prevTX, c.curRX, c.curTX, gotRX, gotTX, c.wantRX, c.wantTX)
			}
		})
	}
}
