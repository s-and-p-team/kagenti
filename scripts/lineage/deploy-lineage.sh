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
#   1. Loads all 5 lineage images into Kind
#   2. Overrides the authbridge sidecar image + enables capture_io + lineage flag
#   3. Enables lineageService component (Postgres + lineage-service + OTel pipeline)
#   4. Restarts team1 agent pods so they pick up the new authbridge sidecar
#   5. Deploys custom weather-tool (wttr.in), kagenti-backend (DELETE routes),
#      and kagenti-ui (Execution Flow + Phoenix link)
#   6. Waits for all deployments to be ready
#   7. (--phoenix) Waits for Phoenix to be ready (accessible at http://phoenix.localtest.me:8080)
#   8. Prints the lineage UI URL and a test curl command
#
# Usage
# -----
#   scripts/lineage/deploy-lineage.sh            # deploy lineage stack
#   scripts/lineage/deploy-lineage.sh --phoenix  # also enable Phoenix (http://phoenix.localtest.me:8080)
#   scripts/lineage/deploy-lineage.sh --dry-run  # print commands without running
#   scripts/lineage/deploy-lineage.sh --help
#
# Prerequisites
# -------------
#   - Kagenti Kind cluster is up (.github/scripts/local-setup/kind-full-test.sh)
#   - All images built: scripts/lineage/build-images.sh
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
PHOENIX=false

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
        --phoenix)  PHOENIX=true; shift ;;
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

for img in "localhost/authbridge:lineage-plugin" "localhost/lineage-service:latest" \
           "localhost/weather-tool:lineage" "localhost/kagenti-backend:lineage" \
           "localhost/kagenti-ui:lineage"; do
    if ! docker image inspect "$img" &>/dev/null; then
        log_error "Image not found: $img"
        log_error "Run scripts/lineage/build-images.sh first."
        exit 1
    fi
done

# ── Step 1: Load images into Kind ────────────────────────────────────────────
log_phase "STEP 1: Load images into Kind"

for img in \
    "localhost/authbridge:lineage-plugin" \
    "localhost/lineage-service:latest" \
    "localhost/weather-tool:lineage" \
    "localhost/kagenti-backend:lineage" \
    "localhost/kagenti-ui:lineage"; do
    log_step "Loading $img ..."
    run_cmd kind load docker-image "$img" --name "$CLUSTER_NAME"
    log_success "$img loaded"
done

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

# Detect actual names for the other local images (Podman prefix handling).
_kind_img() {
    local pattern="$1" fallback="$2"
    local img
    img=$(docker exec "${CLUSTER_NAME}-control-plane" crictl images 2>/dev/null \
          | awk "/${pattern}/{print \$1\":\"\$2}" | head -1 || true)
    [[ -n "$img" && "$img" != ":" ]] && echo "$img" || echo "$fallback"
}
WEATHER_TOOL_IMAGE=$(_kind_img 'weather-tool.*lineage' 'localhost/weather-tool:lineage')
BACKEND_IMAGE=$(_kind_img 'kagenti-backend.*lineage' 'localhost/kagenti-backend:lineage')
UI_IMAGE=$(_kind_img 'kagenti-ui.*lineage' 'localhost/kagenti-ui:lineage')

# ── Step 2: Helm upgrade — kagenti (authbridge override + lineage flag) ───────
log_phase "STEP 2: Override authbridge sidecar image + enable lineage feature flag"

_KAGENTI_PHOENIX_FLAG=""
$PHOENIX && _KAGENTI_PHOENIX_FLAG="--set components.phoenix.enabled=true"

run_cmd helm upgrade kagenti "$REPO_ROOT/charts/kagenti/" \
    -n kagenti-system \
    --reuse-values \
    --set "kagenti-operator-chart.defaults.images.authbridge=localhost/authbridge:lineage-plugin" \
    --set "featureFlags.lineage=true" \
    --set "authBridge.lineage.captureIO=true" \
    ${_KAGENTI_PHOENIX_FLAG} \
    --wait --timeout 5m

log_success "kagenti chart upgraded"

# ── Step 3: Helm upgrade — kagenti-deps (lineageService + OTel pipeline) ─────
log_phase "STEP 3: Enable lineage service and OTel pipeline"

_DEPS_PHOENIX_FLAG=""
$PHOENIX && _DEPS_PHOENIX_FLAG="--set components.phoenix.enabled=true"

run_cmd helm upgrade kagenti-deps "$REPO_ROOT/charts/kagenti-deps/" \
    -n kagenti-system \
    --reuse-values \
    --set "components.lineageService.enabled=true" \
    --set "lineageService.image.repository=${LINEAGE_IMAGE}" \
    --set "lineageService.image.tag=${LINEAGE_IMAGE_TAG}" \
    --set "lineageService.image.pullPolicy=Never" \
    ${_DEPS_PHOENIX_FLAG} \
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

# ── Step 6: Deploy custom backend / UI / weather-tool images ─────────────────
log_phase "STEP 6: Deploy custom backend, UI, and weather-tool"

# kagenti-backend — adds lineage DELETE routes
log_step "Patching kagenti-backend image → ${BACKEND_IMAGE} ..."
run_cmd kubectl set image deployment/kagenti-backend \
    backend="${BACKEND_IMAGE}" -n kagenti-system 2>/dev/null || true
run_cmd kubectl patch deployment kagenti-backend -n kagenti-system --type=json \
    -p '[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"Never"}]' \
    2>/dev/null || true

# kagenti-ui — Execution Flow source_id fix + Phoenix link in hop detail
log_step "Patching kagenti-ui image → ${UI_IMAGE} ..."
run_cmd kubectl set image deployment/kagenti-ui \
    frontend="${UI_IMAGE}" -n kagenti-system 2>/dev/null || true
run_cmd kubectl patch deployment kagenti-ui -n kagenti-system --type=json \
    -p '[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"Never"}]' \
    2>/dev/null || true

# weather-tool — uses wttr.in instead of the broken open-meteo forecast endpoint
log_step "Patching weather-tool image → ${WEATHER_TOOL_IMAGE} ..."
run_cmd kubectl set image deployment/weather-tool \
    mcp="${WEATHER_TOOL_IMAGE}" -n team1 2>/dev/null || true
run_cmd kubectl patch deployment weather-tool -n team1 --type=json \
    -p '[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"Never"}]' \
    2>/dev/null || true

# Wait for all three rollouts
for dep_ns in "kagenti-backend:kagenti-system" "kagenti-ui:kagenti-system" "weather-tool:team1"; do
    dep="${dep_ns%%:*}"
    ns="${dep_ns##*:}"
    run_cmd kubectl rollout status "deployment/${dep}" -n "$ns" --timeout=120s \
        2>/dev/null || log_warn "${dep} rollout timed out (non-fatal)"
done
log_success "custom images deployed"

# ── Step 7: Restart kagenti-backend to pick up KAGENTI_FEATURE_FLAG_LINEAGE ──
log_step "Restarting kagenti-backend ..."
run_cmd kubectl rollout restart deployment/kagenti-backend -n kagenti-system 2>/dev/null || true
run_cmd kubectl rollout status deployment/kagenti-backend -n kagenti-system \
    --timeout=120s 2>/dev/null || log_warn "kagenti-backend rollout status timed out (non-fatal)"
log_success "kagenti-backend restarted"

# ── Step 8 (optional): Wait for Phoenix ──────────────────────────────────────
if $PHOENIX; then
    log_phase "STEP 8: Wait for Phoenix"

    run_cmd kubectl rollout status statefulset/phoenix \
        -n kagenti-system --timeout=180s || {
        log_error "Phoenix did not become ready within 3 minutes."
        kubectl describe pods -n kagenti-system -l app=phoenix 2>/dev/null | tail -20 || true
        exit 1
    }
    log_success "Phoenix is ready"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}Lineage stack deployed successfully.${NC}"
echo ""
echo "  Lineage UI:  http://kagenti-ui.${DOMAIN}:8080  → Execution Flow (left nav)"
if $PHOENIX; then
    echo "  Phoenix UI:  http://phoenix.${DOMAIN}:8080"
fi
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
