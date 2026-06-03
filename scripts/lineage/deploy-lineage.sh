#!/usr/bin/env bash
# ============================================================================
# DEPLOY LINEAGE STACK
# ============================================================================
# Wires the lineage stack into a running Kagenti Kind cluster.
# Run after kind-full-test.sh (base platform) and scripts/lineage/build-images.sh.
#
# Run from the kagenti repo root:
#   cd ~/development/kagenti
#   scripts/lineage/deploy-lineage.sh
#
# What this script does
# ---------------------
#   1. Loads localhost/authbridge:lineage-plugin into Kind
#   2. Loads localhost/lineage-service:latest into Kind
#   3. Helm-upgrades the kagenti chart to:
#        - override the authbridge sidecar image to the lineage-plugin build
#        - enable the lineage feature flag
#   4. Helm-upgrades kagenti-deps to enable the lineageService component
#      (Postgres + lineage-service + OTel pipeline)
#   5. Restarts team1 agent pods so they pick up the new authbridge sidecar
#   6. Waits for lineage-service and kagenti-backend to be ready
#   7. Prints the lineage UI URL and a test curl command
#
# Usage
# -----
#   scripts/lineage/deploy-lineage.sh           # deploy lineage stack
#   scripts/lineage/deploy-lineage.sh --dry-run # print commands without running
#   scripts/lineage/deploy-lineage.sh --help
#
# Prerequisites
# -------------
#   - Kagenti Kind cluster is up (.github/scripts/local-setup/kind-full-test.sh)
#   - Both images built: scripts/lineage/build-images.sh
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
BOLD='\033[1m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}→${NC} $1"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
log_error()   { echo -e "${RED}✗${NC} $1" >&2; }
log_phase()   { echo -e "\n${BOLD}${BLUE}══ $1 ══${NC}"; }
log_step()    { echo -e "  ${BLUE}▸${NC} $1"; }

# ── Defaults ─────────────────────────────────────────────────────────────────
CLUSTER_NAME="${CLUSTER_NAME:-kagenti}"
DOMAIN="${DOMAIN:-localtest.me}"
DRY_RUN=false

# ── Interrupt handling ────────────────────────────────────────────────────────
cleanup() {
    echo ""
    log_error "Interrupted."
    pkill -P $$ 2>/dev/null || true
    exit 130
}
trap cleanup SIGINT SIGTERM

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)  DRY_RUN=true; shift ;;
        --help|-h)
            sed -n '/^# Usage/,/^# Prerequisites/p' "$0" | sed 's/^# \{0,2\}//'
            exit 0
            ;;
        *)
            log_error "Unknown argument: $1"
            echo "Run with --help for usage."
            exit 1
            ;;
    esac
done

run_cmd() {
    if $DRY_RUN; then
        echo "  [dry-run] $*"
    else
        "$@"
    fi
}

# ── Sanity checks ─────────────────────────────────────────────────────────────
if ! kubectl cluster-info &>/dev/null; then
    log_error "kubectl cannot reach the cluster."
    log_error "Run .github/scripts/local-setup/kind-full-test.sh --skip-cluster-destroy first."
    exit 1
fi

for img in "localhost/authbridge:lineage-plugin" "localhost/lineage-service:latest"; do
    if ! docker image inspect "$img" &>/dev/null; then
        log_error "Image not found: $img"
        log_error "Run scripts/lineage/build-images.sh first."
        exit 1
    fi
done

# ── Step 1: Load images into Kind ────────────────────────────────────────────
log_phase "STEP 1: Load images into Kind"

log_step "Loading localhost/authbridge:lineage-plugin ..."
run_cmd kind load docker-image localhost/authbridge:lineage-plugin --name "$CLUSTER_NAME"
log_success "authbridge loaded"

log_step "Loading localhost/lineage-service:latest ..."
run_cmd kind load docker-image localhost/lineage-service:latest --name "$CLUSTER_NAME"
log_success "lineage-service loaded"

# Detect the name under which Kind/containerd stored the lineage-service image.
# Podman prefixes local images with 'localhost/' when loaded into Kind.
_KIND_LINEAGE_IMG=$(docker exec "${CLUSTER_NAME}-control-plane" \
    crictl images 2>/dev/null \
    | awk '/lineage-service/{print $1":"$2}' | head -1 || true)
if [[ -n "$_KIND_LINEAGE_IMG" && "$_KIND_LINEAGE_IMG" != ":" ]]; then
    LINEAGE_IMAGE="${_KIND_LINEAGE_IMG%%:*}"
    LINEAGE_IMAGE_TAG="${_KIND_LINEAGE_IMG##*:}"
    log_info "lineage-service stored in Kind as: ${LINEAGE_IMAGE}:${LINEAGE_IMAGE_TAG}"
else
    LINEAGE_IMAGE="localhost/lineage-service"
    LINEAGE_IMAGE_TAG="latest"
fi

# ── Step 2: Helm upgrade — kagenti (authbridge override + lineage flag) ───────
log_phase "STEP 2: Override authbridge sidecar image + enable lineage feature flag"

run_cmd helm upgrade kagenti "$REPO_ROOT/charts/kagenti/" \
    -n kagenti-system \
    --reuse-values \
    --set "kagenti-operator-chart.defaults.images.authbridge=localhost/authbridge:lineage-plugin" \
    --set "featureFlags.lineage=true" \
    --wait --timeout 5m

log_success "kagenti chart upgraded"

# ── Step 3: Helm upgrade — kagenti-deps (lineageService + OTel pipeline) ─────
log_phase "STEP 3: Enable lineage service and OTel pipeline"

run_cmd helm upgrade kagenti-deps "$REPO_ROOT/charts/kagenti-deps/" \
    -n kagenti-system \
    --reuse-values \
    --set "components.lineageService.enabled=true" \
    --set "lineageService.image.repository=${LINEAGE_IMAGE}" \
    --set "lineageService.image.tag=${LINEAGE_IMAGE_TAG}" \
    --set "lineageService.image.pullPolicy=Never" \
    --wait --timeout 10m

log_success "kagenti-deps chart upgraded"

# ── Step 4: Restart team1 so agents pick up the new authbridge sidecar ───────
log_phase "STEP 4: Restart agent pods (pick up new authbridge sidecar)"

run_cmd kubectl rollout restart deployment -n team1
log_step "Waiting for team1 rollout ..."
run_cmd kubectl rollout status deployment -n team1 --timeout=120s
log_success "team1 agents restarted"

# ── Step 5: Wait for lineage-service ─────────────────────────────────────────
log_phase "STEP 5: Wait for lineage-service to be ready"

run_cmd kubectl rollout status deployment/lineage-service \
    -n kagenti-system --timeout=180s || {
    log_error "lineage-service did not become ready within 3 minutes."
    kubectl describe pods -n kagenti-system -l app=lineage-service 2>/dev/null | tail -20 || true
    exit 1
}
log_success "lineage-service is ready"

# ── Step 6: Restart kagenti-backend to pick up KAGENTI_FEATURE_FLAG_LINEAGE ──
log_step "Restarting kagenti-backend ..."
run_cmd kubectl rollout restart deployment/kagenti-backend -n kagenti-system 2>/dev/null || true
run_cmd kubectl rollout status deployment/kagenti-backend -n kagenti-system \
    --timeout=120s 2>/dev/null || log_warn "kagenti-backend rollout status timed out (non-fatal)"
log_success "kagenti-backend restarted"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}Lineage stack deployed successfully.${NC}"
echo ""
echo "  Lineage UI:  http://kagenti-ui.${DOMAIN}:8080  → Execution Flow (left nav)"
echo ""
echo "Send a test query (port-forward directly to the agent on pod port 8001 — no auth needed):"
echo "  POD=\$(kubectl get pod -n team1 -l app.kubernetes.io/name=weather-service -o jsonpath='{.items[0].metadata.name}')"
echo "  kubectl port-forward -n team1 pod/\$POD 8000:8001 &"
echo "  curl -s -X POST http://localhost:8000/ \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"message/send\",\"params\":{\"message\":{\"role\":\"user\",\"messageId\":\"test-001\",\"parts\":[{\"kind\":\"text\",\"text\":\"What is the weather in Paris?\"}]},\"metadata\":{}}}' \\"
echo "    | jq .result.artifacts[0].parts[0].text"
echo ""
echo "Within ~30 seconds the Trajectories tab should show a run."
echo "See docs/lineage-quickstart.md for the full UI walkthrough."
echo ""
