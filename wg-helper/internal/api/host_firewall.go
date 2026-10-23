package api

import (
	"os/exec"
	"strconv"
	"strings"
)

// forwardRuleArgs builds the iptables argv that installs rule (for example
// {"-s", "10.8.0.0/24", "-j", "ACCEPT"}) into chain so the kernel actually
// reaches it.
//
// A bare -A append is wrong on hosts whose chain ends in a catch-all
// REJECT/DROP: Oracle Cloud's Ubuntu images ship such a FORWARD chain
// (/etc/iptables/rules.v4, loaded by netfilter-persistent), so an appended
// ACCEPT never matches — the tunnel handshakes but peers get no internet.
// When the chain has a catch-all, insert the rule before it; otherwise keep
// the historical append so hosts without one behave exactly as before.
func forwardRuleArgs(chain string, rule []string, listing string) []string {
	if pos := firstCatchallPos(listing); pos > 0 {
		return append([]string{"-I", chain, strconv.Itoa(pos)}, rule...)
	}
	return append([]string{"-A", chain}, rule...)
}

// firstCatchallPos returns the rule number of the first REJECT/DROP rule in
// the output of "iptables -nvL <chain> --line-numbers", or 0 when the chain
// has none.
func firstCatchallPos(listing string) int {
	for _, line := range strings.Split(listing, "\n") {
		fields := strings.Fields(line)
		// Columns: num, pkts, bytes, target, prot, opt, in, out, source, destination.
		if len(fields) < 4 {
			continue
		}
		if fields[3] != "REJECT" && fields[3] != "DROP" {
			continue
		}
		if n, err := strconv.Atoi(fields[0]); err == nil {
			return n
		}
	}
	return 0
}

// wgPortAcceptArgs returns the iptables check/insert argv pair that admits
// the WireGuard listen port on the host INPUT chain. The installer opens
// the default port, but a port changed in the console after install (or a
// node host whose firewall the installer never touched) would otherwise be
// REJECTed by the image's ruleset while the cloud side allows it. Inserting
// at the top mirrors the DNS INPUT acceptance below and keeps a custom port
// reachable; the -C check makes it idempotent.
func wgPortAcceptArgs(port int) [][]string {
	if port <= 0 {
		return nil
	}
	dport := strconv.Itoa(port)
	return [][]string{
		{"-C", "INPUT", "-p", "udp", "--dport", dport, "-j", "ACCEPT"},
		{"-I", "INPUT", "1", "-p", "udp", "--dport", dport, "-j", "ACCEPT"},
	}
}

// ensureWGPortAccept idempotently admits the WireGuard UDP port on the host
// INPUT chain (see wgPortAcceptArgs). Best-effort: the caller logs the
// returned error as a warning, never as a failed reconcile.
func ensureWGPortAccept(port int) error {
	args := wgPortAcceptArgs(port)
	if len(args) != 2 {
		return nil
	}
	if err := run(exec.Command("iptables", args[0]...)); err == nil {
		return nil
	}
	if err := run(exec.Command("iptables", args[1]...)); err != nil {
		return err
	}
	return nil
}
