package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// Agent is the distributed-node loop: it polls the console for the
// desired state of every server assigned to this node and applies it to
// the local kernel, then reports the outcome. No inbound ports needed on
// the node — the agent always connects out.
type Agent struct {
	handler *Handler
	url     string
	token   string
	nodeID  string
	prev    map[string]bool // interface names from the last successful poll
}

func NewAgent(h *Handler, url, token, nodeID string) *Agent {
	return &Agent{handler: h, url: url, token: token, nodeID: nodeID, prev: map[string]bool{}}
}

func (a *Agent) Run(ctx context.Context) {
	log.Printf("agent: polling %s as node %s every 15s", a.url, a.nodeID)
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	a.cycle()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.cycle()
		}
	}
}

type desiredServer struct {
	ID            string `json:"id"`
	InterfaceName string `json:"interface_name"`
	ListenPort    int    `json:"listen_port"`
	PrivateKey    string `json:"private_key"`
	Address       string `json:"address"`
	NatCIDR       string `json:"nat_cidr"`
	Endpoint      string `json:"endpoint"`
	Peers         []struct {
		PublicKey string `json:"public_key"`
		AllowedIP string `json:"allowed_ip"`
	} `json:"peers"`
}

type desiredState struct {
	NodeID  string          `json:"node_id"`
	Servers []desiredServer `json:"servers"`
}

func (a *Agent) cycle() {
	state, err := a.fetchState()
	if err != nil {
		log.Printf("agent: fetch failed: %v", err)
		a.report("error", err.Error())
		return
	}

	details := ""
	current := map[string]bool{}
	for _, srv := range state.Servers {
		current[srv.InterfaceName] = true
		peers := []applyPeer{}
		for _, p := range srv.Peers {
			peers = append(peers, applyPeer{PublicKey: p.PublicKey, AllowedIP: p.AllowedIP})
		}
		warnings := a.handler.applyState(applyRequest{
			InterfaceName: srv.InterfaceName,
			ListenPort:    srv.ListenPort,
			PrivateKey:    srv.PrivateKey,
			Address:       srv.Address,
			NatCIDR:       srv.NatCIDR,
			Peers:         peers,
		})
		if len(warnings) > 0 {
			details += srv.InterfaceName + ": " + fmt.Sprint(warnings) + "; "
		}
	}

	// Remove interfaces that are no longer desired on this node.
	for iface := range a.prev {
		if !current[iface] {
			log.Printf("agent: removing stale interface %s", iface)
			a.handler.removeInterface(iface)
		}
	}
	a.prev = current

	status := "ok"
	if details != "" {
		status = "warning"
	}
	a.report(status, details)
}

func (a *Agent) fetchState() (*desiredState, error) {
	req, err := http.NewRequest(http.MethodGet,
		fmt.Sprintf("%s/api/nodes/%s/state", a.url, a.nodeID), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("state endpoint returned %d: %s", resp.StatusCode, string(body))
	}
	var state desiredState
	if err := json.NewDecoder(resp.Body).Decode(&state); err != nil {
		return nil, err
	}
	return &state, nil
}

func (a *Agent) report(status, details string) {
	body, _ := json.Marshal(map[string]string{"status": status, "details": details})
	req, err := http.NewRequest(http.MethodPost,
		fmt.Sprintf("%s/api/nodes/%s/report", a.url, a.nodeID), bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	req.Header.Set("Content-Type", "application/json")
	if resp, err := http.DefaultClient.Do(req); err == nil {
		resp.Body.Close()
	}
}
