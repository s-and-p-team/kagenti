#!/usr/bin/env bash
# ============================================================================
# DEPLOY LINEAGE STACK
# ============================================================================
# Deploys (or upgrades) the Kagenti data lineage stack on a running Kind
# cluster. The cluster must already be up with the base Kagenti platform
# installed (scripts/kind/setup-kagenti.sh or kind-full-test.sh).
#
# What this script does
# ---------------------
#   1. Upgrades kagenti-deps to enable the lineage-service component
#      (PostgreSQL + lineage-service + OTel pipeline)
#   2. Upgrades kagenti to enable the lineage feature flag and wire
#      the lineage-telemetry authbridge plugin into all agent namespaces
#   3. Waits for the lineage-service to be ready
#   4. (--demo-agents) deploys weather-service and weather-tool from
#      agent-examples into team1 if not already present
#   5. (--test)        runs the lineage E2E smoke tests (Phase 1 + Phase 2)
#
# Usage
# -----
#   scripts/deploy-lineage.sh                   # deploy only
#   scripts/deploy-lineage.sh --phoenix         # deploy + Phoenix (http://phoenix.localtest.me:8080)
#   scripts/deploy-lineage.sh --demo-agents     # deploy + weather agents
#   scripts/deploy-lineage.sh --demo-agents --test  # deploy + agents + E2E tests
#   scripts/deploy-lineage.sh --test            # E2E tests only (no re-deploy)
#   scripts/deploy-lineage.sh --skip-deploy     # alias for --test only
#   scripts/deploy-lineage.sh --cluster-name my-cluster
#
# Options
#   --phoenix          Enable Phoenix and expose at http://phoenix.localtest.me:8080
#   --demo-agents      Deploy weather-service (A2A) and weather-tool (MCP)
#                      into team1 namespace (required for E2E tests)
#   --test             Run lineage E2E tests after deployment
#                      Implies --demo-agents if they are not already running
#   --skip-deploy      Skip helm upgrades; jump straight to --demo-agents/--test
#   --cluster-name N   Kind cluster name (default: $CLUSTER_NAME or 'kagenti')
#   --dry-run          Print helm/kubectl commands without executing them
#   --help             Show this help
#
# Prerequisites
# -------------
#   - kind cluster is running and kubectl context is pointing at it
#   - Kagenti base platform is deployed (kagenti-deps + kagenti charts)
#   - uv (for running pytest in --test mode)
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Colour helpers ────────────────────────────────────────────────────────────
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
DO_DEPLOY=true
DO_AGENTS=false
DO_TEST=false
DRY_RUN=false
SKIP_BUILD=false
PHOENIX=false

# ── Interrupt handling ────────────────────────────────────────────────────────
cleanup() {
    echo ""
    log_error "Interrupted. Killing child processes..."
    pkill -P $$ 2>/dev/null || true
    sleep 1
    pkill -9 -P $$ 2>/dev/null || true
    exit 130
}
trap cleanup SIGINT SIGTERM

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --phoenix)       PHOENIX=true; shift ;;
        --demo-agents)   DO_AGENTS=true; shift ;;
        --test)          DO_TEST=true; DO_AGENTS=true; shift ;;
        --skip-deploy)   DO_DEPLOY=false; shift ;;
        --skip-build)    SKIP_BUILD=true; shift ;;
        --cluster-name)  CLUSTER_NAME="$2"; shift 2 ;;
        --dry-run)       DRY_RUN=true; shift ;;
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
    log_error "kubectl cannot reach the cluster. Is the kubeconfig set up correctly?"
    exit 1
fi

# ── OTel endpoint (in-cluster) ────────────────────────────────────────────────
OTEL_ENDPOINT="${OTEL_ENDPOINT:-http://otel-collector.kagenti-system.svc.cluster.local:4317}"

# ── lineage-service image settings ───────────────────────────────────────────
# For Kind we build locally and use pullPolicy=Never (no registry).
# Override with LINEAGE_IMAGE / LINEAGE_IMAGE_TAG for a real registry.
LINEAGE_IMAGE="${LINEAGE_IMAGE:-lineage-service}"
LINEAGE_IMAGE_TAG="${LINEAGE_IMAGE_TAG:-latest}"
LINEAGE_IMAGE_PULL_POLICY="${LINEAGE_IMAGE_PULL_POLICY:-Never}"
DATA_LINEAGE_REPO="${DATA_LINEAGE_REPO:-$REPO_ROOT/../data_lineage}"

# ============================================================================
# PHASE 0: Build and load lineage-service image into Kind
# ============================================================================
if $DO_DEPLOY && ! $SKIP_BUILD; then
    log_phase "PHASE 0: Build lineage-service image"

    LINEAGE_SVC_DIR="$DATA_LINEAGE_REPO/lineage_service"
    if [[ ! -f "$LINEAGE_SVC_DIR/Dockerfile" ]]; then
        log_error "Dockerfile not found at $LINEAGE_SVC_DIR/Dockerfile"
        log_error "Clone the data_lineage repo next to kagenti or set DATA_LINEAGE_REPO="
        exit 1
    fi

    log_step "Building $LINEAGE_IMAGE:$LINEAGE_IMAGE_TAG from $LINEAGE_SVC_DIR..."
    run_cmd docker build -t "${LINEAGE_IMAGE}:${LINEAGE_IMAGE_TAG}" "$LINEAGE_SVC_DIR"
    log_success "Image built"

    log_step "Loading image into Kind cluster '$CLUSTER_NAME'..."
    run_cmd kind load docker-image "${LINEAGE_IMAGE}:${LINEAGE_IMAGE_TAG}" --name "$CLUSTER_NAME"
    log_success "Image loaded into Kind"

    # Podman prefixes local images with 'localhost/' when stored in Kind's
    # container runtime (e.g. 'lineage-service' -> 'localhost/lineage-service').
    # Discover the actual stored name so the Helm --set uses the right reference.
    _KIND_IMAGE=$(docker exec "${CLUSTER_NAME}-control-plane" \
        crictl images 2>/dev/null \
        | awk '/lineage-service/{print $1":"$2}' | head -1)
    if [[ -n "$_KIND_IMAGE" && "$_KIND_IMAGE" != ":" ]]; then
        LINEAGE_IMAGE="${_KIND_IMAGE%%:*}"
        LINEAGE_IMAGE_TAG="${_KIND_IMAGE##*:}"
        log_info "Image stored in Kind as: ${LINEAGE_IMAGE}:${LINEAGE_IMAGE_TAG}"
    fi

    log_phase "PHASE 0: Complete"
    echo ""
fi

# If --skip-build, still detect the stored image name from the Kind node
if $DO_DEPLOY && $SKIP_BUILD; then
    _KIND_IMAGE=$(docker exec "${CLUSTER_NAME}-control-plane" \
        crictl images 2>/dev/null \
        | awk '/lineage-service/{print $1":"$2}' | head -1)
    if [[ -n "$_KIND_IMAGE" && "$_KIND_IMAGE" != ":" ]]; then
        LINEAGE_IMAGE="${_KIND_IMAGE%%:*}"
        LINEAGE_IMAGE_TAG="${_KIND_IMAGE##*:}"
        log_info "Using existing image in Kind: ${LINEAGE_IMAGE}:${LINEAGE_IMAGE_TAG}"
    fi
fi

# ============================================================================
# PHASE 1: Helm upgrades
# ============================================================================
if $DO_DEPLOY; then
    log_phase "PHASE 1: Helm — enable lineage components"

    # ── 1a. kagenti-deps: enable lineageService component ────────────────────
    # NOTE: dev_values_lineage.yaml is an installer-overlay file (nested under
    # charts.kagenti-deps.values.*). Helm's --values reads it literally, so
    # the nested path would not reach the chart. Use --set flags instead.
    log_step "Upgrading kagenti-deps (lineageService + OTel pipeline)..."

    _DEPS_PHOENIX_FLAG=""
    $PHOENIX && _DEPS_PHOENIX_FLAG="--set components.phoenix.enabled=true"

    run_cmd helm upgrade kagenti-deps "$REPO_ROOT/charts/kagenti-deps/" \
        -n kagenti-system \
        --reuse-values \
        --set components.lineageService.enabled=true \
        --set "lineageService.image.repository=${LINEAGE_IMAGE}" \
        --set "lineageService.image.tag=${LINEAGE_IMAGE_TAG}" \
        --set "lineageService.image.pullPolicy=${LINEAGE_IMAGE_PULL_POLICY}" \
        ${_DEPS_PHOENIX_FLAG} \
        --wait --timeout 15m

    log_success "kagenti-deps upgraded"

    # ── 1a-post. Ensure lineage-service deployment has the correct image ───────
    # Helm upgrade can store the right values but leave the Deployment unchanged
    # when the previous rollout was stuck in progressDeadlineExceeded. Patch
    # directly if the current spec diverges from what we just set.
    _CURRENT_IMG=$(kubectl get deployment lineage-service -n kagenti-system \
        -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)
    _WANT_IMG="${LINEAGE_IMAGE}:${LINEAGE_IMAGE_TAG}"
    if [[ -n "$_CURRENT_IMG" && "$_CURRENT_IMG" != "$_WANT_IMG" ]]; then
        log_warn "Deployment image is '$_CURRENT_IMG', expected '$_WANT_IMG' — patching..."
        run_cmd kubectl set image deployment/lineage-service \
            "lineage-service=${_WANT_IMG}" -n kagenti-system
        run_cmd kubectl patch deployment lineage-service -n kagenti-system \
            --type=json \
            -p "[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/imagePullPolicy\",\"value\":\"${LINEAGE_IMAGE_PULL_POLICY}\"}]"
        log_success "Deployment image patched to '$_WANT_IMG'"
    fi

    # ── 1b. kagenti: enable lineage feature flag ──────────────────────────────
    log_step "Upgrading kagenti (lineage feature flag + authbridge plugin)..."

    _KAGENTI_PHOENIX_FLAG=""
    $PHOENIX && _KAGENTI_PHOENIX_FLAG="--set components.phoenix.enabled=true"

    run_cmd helm upgrade kagenti "$REPO_ROOT/charts/kagenti/" \
        -n kagenti-system \
        --reuse-values \
        --set featureFlags.lineage=true \
        --set "authBridge.lineage.otelEndpoint=${OTEL_ENDPOINT}" \
        ${_KAGENTI_PHOENIX_FLAG} \
        --wait --timeout 15m

    log_success "kagenti upgraded"

    # ── 1c. Wait for lineage-service ──────────────────────────────────────────
    log_step "Waiting for lineage-service deployment to be ready..."
    run_cmd kubectl rollout status deployment/lineage-service \
        -n kagenti-system --timeout=180s || {
        log_error "lineage-service did not become ready within 3 minutes."
        log_info "Pod events:"
        kubectl describe pods -n kagenti-system -l app=lineage-service 2>/dev/null | tail -20 || true
        exit 1
    }
    log_success "lineage-service is ready"

    # ── 1d. Wait for backend to pick up new KAGENTI_FEATURE_FLAG_LINEAGE env ──
    log_step "Restarting kagenti-backend to pick up lineage feature flag..."
    run_cmd kubectl rollout restart deployment/kagenti-backend -n kagenti-system 2>/dev/null || true
    run_cmd kubectl rollout status deployment/kagenti-backend -n kagenti-system \
        --timeout=120s 2>/dev/null || log_warn "kagenti-backend rollout status timed out (non-fatal)"
    log_success "kagenti-backend restarted"

    # ── 1e. Wait for Phoenix (if requested) ──────────────────────────────────
    if $PHOENIX; then
        log_step "Waiting for Phoenix deployment to be ready..."
        run_cmd kubectl rollout status deployment/phoenix \
            -n kagenti-system --timeout=180s || {
            log_error "Phoenix did not become ready within 3 minutes."
            kubectl describe pods -n kagenti-system -l app=phoenix 2>/dev/null | tail -20 || true
            exit 1
        }
        log_success "Phoenix is ready"
    fi

    log_phase "PHASE 1: Complete"
    echo ""
fi

# ============================================================================
# PHASE 2: Deploy demo agents (weather chain)
# ============================================================================
if $DO_AGENTS; then
    log_phase "PHASE 2: Deploy demo agents"

    # Only deploy if not already running
    WT_RUNNING=$(kubectl get deployment weather-tool  -n team1 --ignore-not-found -o name 2>/dev/null || true)
    WS_RUNNING=$(kubectl get deployment weather-service -n team1 --ignore-not-found -o name 2>/dev/null || true)

    if [[ -z "$WT_RUNNING" ]]; then
        log_step "Deploying weather-tool..."
        run_cmd bash "$REPO_ROOT/.github/scripts/kagenti-operator/72-deploy-weather-tool.sh"
        log_success "weather-tool deployed"
    else
        log_info "weather-tool already running — skipping deploy"
    fi

    if [[ -z "$WS_RUNNING" ]]; then
        log_step "Deploying weather-service..."
        run_cmd bash "$REPO_ROOT/.github/scripts/kagenti-operator/74-deploy-weather-agent.sh"
        log_success "weather-service deployed"
    else
        log_info "weather-service already running — skipping deploy"
    fi

    # Wait for agents to settle
    log_step "Waiting for weather-service rollout..."
    run_cmd kubectl rollout status deployment/weather-service -n team1 --timeout=120s
    log_step "Waiting for weather-tool rollout..."
    run_cmd kubectl rollout status deployment/weather-tool -n team1 --timeout=120s

    log_phase "PHASE 2: Complete"
    echo ""
fi

# ============================================================================
# PHASE 3: Smoke test via curl (quick connectivity check before E2E)
# ============================================================================
if $DO_DEPLOY || $DO_AGENTS; then
    log_phase "PHASE 3: Quick connectivity smoke test"

    BACKEND_URL="http://localhost:8002"
    LINEAGE_HEALTH_URL="${BACKEND_URL}/api/v1/lineage/runs"

    # Start a temporary port-forward for the backend if not already running
    _BACKEND_PF_PID=""
    if ! curl -sf "${BACKEND_URL}/health" >/dev/null 2>&1; then
        log_step "Starting temporary port-forward for kagenti-backend (localhost:8002)..."
        kubectl port-forward -n kagenti-system svc/kagenti-backend 8002:8000 \
            >/tmp/lineage-pf-backend.log 2>&1 &
        _BACKEND_PF_PID=$!
        sleep 3
    fi

    _pf_cleanup() {
        if [[ -n "$_BACKEND_PF_PID" ]]; then
            kill "$_BACKEND_PF_PID" 2>/dev/null || true
        fi
    }
    trap _pf_cleanup EXIT

    # Check lineage endpoint responds
    for i in {1..10}; do
        if curl -sf "$LINEAGE_HEALTH_URL" >/dev/null 2>&1; then
            log_success "lineage/runs endpoint reachable (${BACKEND_URL})"
            break
        fi
        if [[ $i -eq 10 ]]; then
            log_warn "lineage/runs endpoint not responding after 10s — feature flag may be off or backend not ready"
            log_info "Check: kubectl logs -n kagenti-system deploy/kagenti-backend | tail -20"
        fi
        sleep 1
    done

    log_phase "PHASE 3: Complete"
    echo ""
fi

# ============================================================================
# PHASE 4: E2E tests
# ============================================================================
if $DO_TEST; then
    log_phase "PHASE 4: E2E lineage tests"

    cd "$REPO_ROOT/kagenti"

    # Install test deps if needed
    if command -v uv &>/dev/null; then
        if ! uv run python -c "import httpx" &>/dev/null 2>&1; then
            log_step "Installing test dependencies (uv sync --extra test)..."
            (cd "$REPO_ROOT" && uv sync --extra test)
        fi
        PYTEST_CMD="uv run pytest"
    else
        PYTEST_CMD="pytest"
    fi

    # ── Set up port-forwards needed for tests ────────────────────────────────
    log_step "Starting port-forwards for E2E tests..."
    bash "$REPO_ROOT/.github/scripts/common/85-start-port-forward.sh"

    export KAGENTI_BACKEND_URL="http://localhost:8002"
    export AGENT_URL="http://localhost:8000"
    # Point conftest.py at the lineage values file so requires_features works
    export KAGENTI_CONFIG_FILE="${KAGENTI_CONFIG_FILE:-$REPO_ROOT/deployments/envs/dev_values_lineage.yaml}"

    log_info "KAGENTI_CONFIG_FILE: $KAGENTI_CONFIG_FILE"
    log_info "KAGENTI_BACKEND_URL: $KAGENTI_BACKEND_URL"

    PYTEST_TARGET="tests/e2e/common/test_lineage_traces.py"
    PYTEST_OPTS="-v --timeout=180 --tb=short"

    # Phase 1: generate traffic by running agent conversation tests (non-observability)
    log_step "Phase 1 — generating traffic (agent conversation tests)..."
    eval "$PYTEST_CMD tests/e2e/common/test_agent_conversation.py \
        $PYTEST_OPTS \
        -m 'not observability' \
        --junit-xml=../test-results/lineage-phase1-results.xml" || {
        log_error "Agent conversation tests failed (Phase 1)"
        exit 1
    }
    log_success "Phase 1 complete"

    # Phase 2: validate lineage data captured
    log_step "Phase 2 — validating lineage data..."
    eval "$PYTEST_CMD $PYTEST_TARGET \
        $PYTEST_OPTS \
        -m 'observability' \
        --junit-xml=../test-results/lineage-phase2-results.xml" || {
        log_error "Lineage observability tests failed (Phase 2)"
        log_info "Hints:"
        log_info "  kubectl logs -n kagenti-system deploy/lineage-service | tail -30"
        log_info "  kubectl logs -n kagenti-system deploy/otel-collector    | tail -30"
        log_info "  kubectl logs -n team1 weather-service-<pod> -c authbridge | tail -30"
        exit 1
    }
    log_success "Phase 2 complete"

    log_phase "PHASE 4: All lineage E2E tests passed"
    echo ""
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}Lineage stack deployment complete.${NC}"
echo ""
echo "  Lineage UI:     http://kagenti-ui.${DOMAIN}:8080  → Data Lineage tab"
echo "  Backend API:    http://localhost:8002/api/v1/lineage/runs  (port-forward)"
echo "  Lineage svc:    kubectl port-forward -n kagenti-system svc/lineage-service 8001:8000"
if $PHOENIX; then
    echo "  Phoenix UI:     http://phoenix.${DOMAIN}:8080"
fi
echo ""
echo "Next steps:"
echo "  1. Open the Lineage UI tab and send a weather query"
echo "  2. Watch hops appear in the Trajectories tab within ~30s"
echo "  3. See docs/lineage-quickstart.md for the full walkthrough"
echo ""
