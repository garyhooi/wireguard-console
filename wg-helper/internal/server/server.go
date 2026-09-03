package server

import (
	"net"
	"net/http"
)

type Server struct {
	handler http.Handler
}

func New(handler http.Handler) *Server {
	return &Server{handler: handler}
}

func (s *Server) Serve(listener net.Listener) error {
	srv := &http.Server{
		Handler: s.handler,
	}
	return srv.Serve(listener)
}
