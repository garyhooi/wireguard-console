package main

import (
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
	socketPath := os.Getenv("WG_HELPER_SOCKET")
	if socketPath == "" {
		log.Fatal("WG_HELPER_SOCKET environment variable is required")
	}

	if err := os.MkdirAll(fmt.Sprintf("%s", socketPath), 0700); err != nil {
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

	client, err := wgctrl.New()
	if err != nil {
		log.Fatalf("Failed to create wgctrl client: %v", err)
	}
	defer client.Close()

	handler := api.NewHandler(client)
	srv := server.New(handler)

	go func() {
		log.Printf("wg-helper listening on %s", socketFile)
		if err := srv.Serve(listener); err != nil {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down wg-helper...")
	listener.Close()
}
