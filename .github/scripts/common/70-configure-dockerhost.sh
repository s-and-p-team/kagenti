#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/env-detect.sh"
source "$SCRIPT_DIR/../lib/logging.sh"

log_step "70" "Configuring dockerhost service"

# Get Docker/Podman host IP (filter for IPv4 — EndpointSlice requires addressType: IPv4)
# Docker format:  .[].IPAM.Config[].Gateway  (uppercase, nested under IPAM)
# Podman format:  .[].subnets[].gateway       (lowercase, top-level subnets array)
_NETWORK_JSON=$(docker network inspect kind)
DOCKER_HOST_IP=$(echo "$_NETWORK_JSON" | jq -r '
  ( .[].IPAM.Config[]? | select(.Gateway != null) | .Gateway ),
  ( .[].subnets[]?      | select(.gateway != null) | .gateway )
  ' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)

if [ -z "$DOCKER_HOST_IP" ] || [ "$DOCKER_HOST_IP" = "null" ]; then
    log_error "Could not determine Docker host IP"
    echo "$_NETWORK_JSON" | jq '.[0] | {IPAM, subnets}'
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
