package api

import (
	"reflect"
	"testing"
)

func TestFirstCatchallPos(t *testing.T) {
	const header = "num   pkts bytes target     prot opt in     out     source               destination\n"

	cases := []struct {
		name    string
		listing string
		want    int
	}{
		{
			name: "oracle cloud image",
			listing: "Chain FORWARD (policy DROP 0 packets, 0 bytes)\n" + header +
				"1        0     0 DOCKER-USER  all  --  *      *       0.0.0.0/0            0.0.0.0/0\n" +
				"2        0     0 REJECT       all  --  *      *       0.0.0.0/0            0.0.0.0/0            reject-with icmp-host-prohibited\n",
			want: 2,
		},
		{
			name:    "no catch-all",
			listing: header + "1        3   252 ACCEPT       all  --  *      *       10.8.0.0/24          0.0.0.0/0\n",
			want:    0,
		},
		{
			name:    "drop catch-all",
			listing: "1 0 0 DROP all -- * * 0.0.0.0/0 0.0.0.0/0\n",
			want:    1,
		},
		{
			name:    "empty",
			listing: "",
			want:    0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := firstCatchallPos(tc.listing); got != tc.want {
				t.Fatalf("firstCatchallPos() = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestForwardRuleArgs(t *testing.T) {
	rule := []string{"-s", "10.8.0.0/24", "-j", "ACCEPT"}
	const header = "num   pkts bytes target     prot opt in     out     source               destination\n"
	oracle := header + "1        0     0 REJECT       all  --  *      *       0.0.0.0/0            0.0.0.0/0            reject-with icmp-host-prohibited\n"

	if got, want := forwardRuleArgs("FORWARD", rule, oracle), []string{"-I", "FORWARD", "1", "-s", "10.8.0.0/24", "-j", "ACCEPT"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("forwardRuleArgs before catch-all = %v, want %v", got, want)
	}
	if got, want := forwardRuleArgs("FORWARD", rule, ""), []string{"-A", "FORWARD", "-s", "10.8.0.0/24", "-j", "ACCEPT"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("forwardRuleArgs without catch-all = %v, want %v", got, want)
	}
}

func TestWGPortAcceptArgs(t *testing.T) {
	if got := wgPortAcceptArgs(0); got != nil {
		t.Fatalf("wgPortAcceptArgs(0) = %v, want nil", got)
	}
	got := wgPortAcceptArgs(51820)
	want := [][]string{
		{"-C", "INPUT", "-p", "udp", "--dport", "51820", "-j", "ACCEPT"},
		{"-I", "INPUT", "1", "-p", "udp", "--dport", "51820", "-j", "ACCEPT"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("wgPortAcceptArgs(51820) = %v, want %v", got, want)
	}
}
