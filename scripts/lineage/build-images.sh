#!/usr/bin/env bash
# ============================================================================
# BUILD LINEAGE IMAGES
# ============================================================================
# Builds all Docker images required for the lineage stack:
#   localhost/authbridge:lineage-plugin  — authbridge proxy with lineage plugin
#   localhost/lineage-service:latest     — data lineage REST service
#   localhost/weather-tool:lineage       — weather MCP tool (wttr.in backend)
#   localhost/kagenti-backend:lineage    — kagenti backend (lineage API + DELETE routes)
#   localhost/kagenti-ui:lineage         — kagenti UI (Execution Flow + Phoenix link)
#
# Run from the kagenti repo root. The sibling repos must already be cloned:
#
#   mkdir -p ~/development && cd ~/development
#   git clone -b lineage_plugin git@github.com:s-and-p-team/kagenti.git
#   git clone -b lineage_plugin git@github.com:s-and-p-team/kagenti-extensions.git
#   git clone -b lineage_plugin git@github.com:s-and-p-team/data_lineage.git
#   git clone -b lineage_plugin git@github.com:s-and-p-team/agent-examples.git
#
# Usage
# -----
#   scripts/lineage/build-images.sh            # build all images
#   scripts/lineage/build-images.sh --help
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

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    sed -n '/^# Usage/,/^# ====/p' "$0" | sed 's/^# \{0,2\}//'
    exit 0
fi

EXTENSIONS_DIR="$(cd "$REPO_ROOT/../kagenti-extensions" 2>/dev/null || true; pwd)"
DATA_LINEAGE_DIR="$(cd "$REPO_ROOT/../data_lineage" 2>/dev/null || true; pwd)"
AGENT_EXAMPLES_DIR="$(cd "$REPO_ROOT/../agent-examples" 2>/dev/null || true; pwd)"

# ── Verify sibling repos exist ────────────────────────────────────────────────
missing=()
[[ -d "$REPO_ROOT/../kagenti-extensions/.git" ]] || missing+=("kagenti-extensions")
[[ -d "$REPO_ROOT/../data_lineage/.git" ]] || missing+=("data_lineage")
[[ -d "$REPO_ROOT/../agent-examples/.git" ]] || missing+=("agent-examples")

if [[ ${#missing[@]} -gt 0 ]]; then
    log_error "Missing sibling repositories: ${missing[*]}"
    echo ""
    echo "Clone them next to kagenti/ on the lineage_plugin branch:"
    echo ""
    for repo in "${missing[@]}"; do
        echo "  git clone -b lineage_plugin git@github.com:s-and-p-team/${repo}.git 2>/dev/null || \\"
        echo "    git clone git@github.com:kagenti/agent-examples.git  # (use main branch for agent-examples)"
    done
    echo ""
    exit 1
fi

EXTENSIONS_DIR="$REPO_ROOT/../kagenti-extensions"
DATA_LINEAGE_DIR="$REPO_ROOT/../data_lineage"
AGENT_EXAMPLES_DIR="$REPO_ROOT/../agent-examples"

# ── Warn if sibling repos are on unexpected branches ─────────────────────────
for repo_path in "$EXTENSIONS_DIR" "$DATA_LINEAGE_DIR"; do
    repo_name="$(basename "$repo_path")"
    branch="$(git -C "$repo_path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
    if [[ "$branch" != "lineage_plugin" ]]; then
        log_warn "$repo_name is on branch '$branch', expected 'lineage_plugin'"
    fi
done

# ── Build authbridge image ────────────────────────────────────────────────────
log_phase "Build 1/5: authbridge (lineage plugin)"

AUTHBRIDGE_CTX="$EXTENSIONS_DIR/authbridge"
log_info "Build context: $AUTHBRIDGE_CTX"
log_info "Image: localhost/authbridge:lineage-plugin"

docker build \
    -f "$AUTHBRIDGE_CTX/cmd/authbridge-proxy/Dockerfile" \
    -t localhost/authbridge:lineage-plugin \
    "$AUTHBRIDGE_CTX"

log_success "localhost/authbridge:lineage-plugin built"

# ── Build lineage-service image ───────────────────────────────────────────────
log_phase "Build 2/5: lineage-service"

LINEAGE_SVC_CTX="$DATA_LINEAGE_DIR/lineage_service"
log_info "Build context: $LINEAGE_SVC_CTX"
log_info "Image: localhost/lineage-service:latest"

docker build \
    -t localhost/lineage-service:latest \
    "$LINEAGE_SVC_CTX"

log_success "localhost/lineage-service:latest built"

# ── Build weather-tool image ──────────────────────────────────────────────────
log_phase "Build 3/5: weather-tool (wttr.in backend)"

WEATHER_TOOL_CTX="$AGENT_EXAMPLES_DIR/mcp/weather_tool"
log_info "Build context: $WEATHER_TOOL_CTX"
log_info "Image: localhost/weather-tool:lineage"

docker build \
    -t localhost/weather-tool:lineage \
    "$WEATHER_TOOL_CTX"

log_success "localhost/weather-tool:lineage built"

# ── Build kagenti-backend image ───────────────────────────────────────────────
log_phase "Build 4/5: kagenti-backend (lineage DELETE routes)"

log_info "Build context: $REPO_ROOT/kagenti"
log_info "Image: localhost/kagenti-backend:lineage"

docker build \
    -f "$REPO_ROOT/kagenti/backend/Dockerfile" \
    -t localhost/kagenti-backend:lineage \
    "$REPO_ROOT/kagenti"

log_success "localhost/kagenti-backend:lineage built"

# ── Build kagenti-ui image ────────────────────────────────────────────────────
log_phase "Build 5/5: kagenti-ui (Execution Flow + Phoenix link)"

log_info "Build context: $REPO_ROOT/kagenti"
log_info "Image: localhost/kagenti-ui:lineage"

docker build \
    -f "$REPO_ROOT/kagenti/ui-v2/Dockerfile" \
    -t localhost/kagenti-ui:lineage \
    "$REPO_ROOT/kagenti"

log_success "localhost/kagenti-ui:lineage built"

echo ""
echo -e "${GREEN}${BOLD}All 5 images built successfully.${NC}"
echo ""
echo "Next step:"
echo "  scripts/lineage/deploy-lineage.sh"
echo ""
