package server

import (
	"net"
	"net/http"
	"time"
)

type Server struct {
	handler http.Handler
}

func New(handler http.Handler) *Server {
	return &Server{handler: handler}
}

func (s *Server) Serve(listener net.Listener) error {
	srv := &http.Server{
		Handler:           s.handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second, // /apply runs a handful of wg/iptables commands
		IdleTimeout:       30 * time.Second,
	}
	return srv.Serve(listener)
}
