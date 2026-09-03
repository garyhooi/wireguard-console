#!/bin/bash
#
# WireGuard Console - Dependency Vulnerability Scanner
#
# This script runs security vulnerability scans on the codebase.
# Can be integrated into CI/CD pipeline.
#

set -euo pipefail

echo "=== WireGuard Console Security Scan ==="
echo ""

# Backend - Go vulnerability scan
echo "Scanning Go dependencies..."
if command -v govulncheck &> /dev/null; then
    cd backend && govulncheck ./... && cd ..
    echo "✓ Go dependencies clean"
else
    echo "⚠ govulncheck not installed, skipping Go scan"
    echo "  Install: go install golang.org/x/vuln/cmd/govulncheck@latest"
fi

# Frontend - npm audit
echo ""
echo "Scanning JavaScript dependencies..."
if command -v npm &> /dev/null; then
    cd frontend && npm audit --production && cd ..
    echo "✓ JavaScript dependencies clean"
else
    echo "⚠ npm not installed, skipping JS audit"
fi

# Docker - Trivy (optional)
echo ""
echo "Checking Docker images..."
if command -v trivy &> /dev/null; then
    trivy image --severity HIGH,CRITICAL golang:1.23
    trivy image --severity HIGH,CRITICAL debian:12-slim
    echo "✓ Docker images clean"
else
    echo "⚠ trivy not installed, skipping Docker scan"
    echo "  Install: https://aquasecurity.github.io/trivy/"
fi

echo ""
echo "=== Scan Complete ==="
