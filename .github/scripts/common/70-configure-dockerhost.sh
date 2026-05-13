#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/env-detect.sh"
source "$SCRIPT_DIR/../lib/logging.sh"

log_step "70" "Configuring dockerhost service"

# Get Docker host IP that pods use to reach the macOS host.
# Priority:
#  1. host.docker.internal from the Kind node's /etc/hosts — this is the
#     IP Podman Desktop injects so containers can reach the macOS host; it
#     is the same IP that pods resolve when they call host.docker.internal.
#  2. Fallback: gateway from docker network inspect (works for plain Docker).
DOCKER_HOST_IP=$(docker exec kagenti-control-plane grep -m1 'host\.docker\.internal' /etc/hosts 2>/dev/null \
    | awk '{print $1}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)

if [ -z "$DOCKER_HOST_IP" ]; then
    log_info "host.docker.internal not in Kind node /etc/hosts, falling back to network gateway"
    DOCKER_HOST_IP=$(docker network inspect kind | jq -r '
      .[0] |
      ((.IPAM.Config // []) | .[] | select(.Gateway != null) | .Gateway),
      ((.subnets // []) | .[] | select(.gateway != null) | .gateway)
    ' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
fi

if [ -z "$DOCKER_HOST_IP" ] || [ "$DOCKER_HOST_IP" = "null" ]; then
    log_error "Could not determine Docker host IP"
    docker network inspect kind | jq '.[].IPAM.Config[]'
    exit 1
fi

log_info "Docker host IP: ${DOCKER_HOST_IP}"

# Apply service configuration
cat <<EOF | kubectl apply -f -
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: dockerhost
  namespace: team1
  labels:
    kubernetes.io/service-name: dockerhost
addressType: IPv4
endpoints:
- addresses:
  - ${DOCKER_HOST_IP}
  conditions:
    ready: true
ports:
- name: ollama
  port: 11434
  protocol: TCP
---
apiVersion: v1
kind: Service
metadata:
  name: dockerhost
  namespace: team1
spec:
  clusterIP: None
EOF

kubectl get service dockerhost -n team1
kubectl get endpointslice dockerhost -n team1

log_success "Dockerhost configured"
