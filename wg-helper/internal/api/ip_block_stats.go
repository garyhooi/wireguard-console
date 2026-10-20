package api

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// ipBlockCounter is one sampled nftables drop-rule counter.
type ipBlockCounter struct {
	SourceIP string `json:"source_ip"` // "" = global rule (all peers)
	CIDR     string `json:"cidr"`
	Family   string `json:"family"` // "ipv4" | "ipv6"
	Packets  uint64 `json:"packets"`
	Bytes    uint64 `json:"bytes"`
}

// parseIPBlockStats extracts counters + comments from "nft -j list table"
// JSON. nft's JSON schema is stable: each element with a "rule" key contains an
// "expr" array whose objects include {"counter":{packets,bytes}} and
// {"comment":"wgc ipblk src=<src|*> dst=<cidr>"}. Rules without our comment are
// ignored (defensive: hand-added rules must not break accounting).
func parseIPBlockStats(raw []byte, family string) ([]ipBlockCounter, error) {
	var doc struct {
		Nftables []map[string]json.RawMessage `json:"nftables"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse nft json: %w", err)
	}

	out := []ipBlockCounter{}
	for _, element := range doc.Nftables {
		ruleRaw, ok := element["rule"]
		if !ok {
			continue
		}
		var rule struct {
			Expr []map[string]json.RawMessage `json:"expr"`
		}
		if err := json.Unmarshal(ruleRaw, &rule); err != nil {
			continue
		}
		var comment string
		var packets, bytes uint64
		haveCounter := false
		for _, expr := range rule.Expr {
			if rawComment, ok := expr["comment"]; ok {
				_ = json.Unmarshal(rawComment, &comment)
			}
			if rawCounter, ok := expr["counter"]; ok {
				var counter struct {
					Packets uint64 `json:"packets"`
					Bytes   uint64 `json:"bytes"`
				}
				if err := json.Unmarshal(rawCounter, &counter); err == nil {
					packets, bytes = counter.Packets, counter.Bytes
					haveCounter = true
				}
			}
		}
		if !haveCounter || comment == "" {
			continue
		}
		fields := strings.Fields(comment)
		// "wgc ipblk src=<src|*> dst=<cidr>"
		if len(fields) != 4 || fields[0] != "wgc" || fields[1] != "ipblk" {
			continue
		}
		source := strings.TrimPrefix(fields[2], "src=")
		dest := strings.TrimPrefix(fields[3], "dst=")
		if source == "*" {
			source = ""
		}
		if dest == "" || dest == fields[3] {
			continue
		}
		out = append(out, ipBlockCounter{SourceIP: source, CIDR: dest, Family: family, Packets: packets, Bytes: bytes})
	}
	return out, nil
}

// IPBlockStats returns the cumulative counters for every IP-block drop rule of
// an interface, both families. A missing table is not an error (no rules yet).
func IPBlockStats(iface string) ([]ipBlockCounter, error) {
	nft, err := nftBinary()
	if err != nil {
		return nil, err
	}

	nftMu.Lock()
	defer nftMu.Unlock()

	out := []ipBlockCounter{}
	for _, family := range []string{"ip", "ip6"} {
		tableV4, tableV6 := guardTableNames(ipBlockTablePrefixV4, ipBlockTablePrefixV6, iface)
		table := tableV4
		if family == "ip6" {
			table = tableV6
		}
		cmd := exec.Command(nft, "-j", "list", "table", family, table)
		raw, err := cmd.CombinedOutput()
		if err != nil {
			msg := strings.ToLower(string(raw) + " " + err.Error())
			if strings.Contains(msg, "no such file or directory") || strings.Contains(msg, "does not exist") {
				continue // no rules for this family (table deleted)
			}
			return nil, fmt.Errorf("nft list %s %s: %w (%s)", family, table, err, strings.TrimSpace(string(raw)))
		}
		counters, err := parseIPBlockStats(raw, familyName(family))
		if err != nil {
			return nil, err
		}
		out = append(out, counters...)
	}
	return out, nil
}

func familyName(family string) string {
	if family == "ip6" {
		return "ipv6"
	}
	return "ipv4"
}
