#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/env-detect.sh"
source "$SCRIPT_DIR/../lib/logging.sh"

log_step "70" "Configuring dockerhost service"

# Get the host IP as seen from inside Kind containers.
#
# On Podman/macOS the macOS host is reachable via host.containers.internal
# (injected into /etc/hosts of every container by Podman), NOT via the
# kind-network gateway. Prefer that when available.
#
# Fallback: Docker/Podman network gateway from 'docker network inspect kind'
#   Docker format:  .[].IPAM.Config[].Gateway  (uppercase, nested under IPAM)
#   Podman format:  .[].subnets[].gateway       (lowercase, top-level subnets array)
CONTROL_PLANE="${CLUSTER_NAME:-kagenti}-control-plane"
DOCKER_HOST_IP=$(docker exec "$CONTROL_PLANE" \
    sh -c "getent hosts host.containers.internal 2>/dev/null | awk '{print \$1}' | head -1" 2>/dev/null || true)

if [ -z "$DOCKER_HOST_IP" ] || [ "$DOCKER_HOST_IP" = "null" ]; then
    log_info "host.containers.internal not found — falling back to network gateway"
    _NETWORK_JSON=$(docker network inspect kind)
    DOCKER_HOST_IP=$(echo "$_NETWORK_JSON" | jq -r '
      ( .[].IPAM.Config[]? | select(.Gateway != null) | .Gateway ),
      ( .[].subnets[]?      | select(.gateway != null) | .gateway )
      ' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
fi

if [ -z "$DOCKER_HOST_IP" ] || [ "$DOCKER_HOST_IP" = "null" ]; then
    log_error "Could not determine Docker host IP"
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
