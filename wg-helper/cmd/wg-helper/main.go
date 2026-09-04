package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/wireguard-console/wg-helper/internal/api"
	"github.com/wireguard-console/wg-helper/internal/server"
	"golang.zx2c4.com/wireguard/wgctrl"
)

func main() {
	client, err := wgctrl.New()
	if err != nil {
		log.Fatalf("Failed to create wgctrl client: %v", err)
	}
	defer client.Close()

	handler := api.NewHandler(client)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Distributed-node agent mode: the console is remote; this process
	// polls it and applies state locally. No unix socket needed.
	agentURL := os.Getenv("WGCONSOLE_URL")
	agentToken := os.Getenv("WGCONSOLE_NODE_TOKEN")
	agentNodeID := os.Getenv("WGCONSOLE_NODE_ID")
	if agentURL != "" && agentToken != "" && agentNodeID != "" {
		agent := api.NewAgent(handler, agentURL, agentToken, agentNodeID)
		go agent.Run(ctx)
		log.Println("wg-helper running in agent mode (polling console for desired state)")
	} else {
		socketPath := os.Getenv("WG_HELPER_SOCKET")
		if socketPath == "" {
			log.Fatal("Set WG_HELPER_SOCKET (local mode) or WGCONSOLE_URL/WGCONSOLE_NODE_TOKEN/WGCONSOLE_NODE_ID (agent mode)")
		}
		if err := os.MkdirAll(socketPath, 0700); err != nil {
			log.Fatalf("Failed to create socket directory: %v", err)
		}
		socketFile := fmt.Sprintf("%s/wg-helper.sock", socketPath)
		if err := os.Remove(socketFile); err != nil && !os.IsNotExist(err) {
			log.Fatalf("Failed to remove existing socket: %v", err)
		}
		listener, err := net.Listen("unix", socketFile)
		if err != nil {
			log.Fatalf("Failed to listen on socket: %v", err)
		}
		defer listener.Close()

		srv := server.New(handler)
		go func() {
			log.Printf("wg-helper listening on %s", socketFile)
			if err := srv.Serve(listener); err != nil {
				log.Fatalf("Server failed: %v", err)
			}
		}()
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("Shutting down wg-helper...")
	cancel()
}
