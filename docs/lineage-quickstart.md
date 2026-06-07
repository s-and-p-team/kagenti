# Data Lineage Quickstart

This guide walks through deploying the full data lineage stack on a local Kind
cluster so that agent trust provenance hops are captured end-to-end and visible
in the UI.

## What you get

- **Trajectories tab** — per-request trust chains showing every hop from
  principal → agent → tool / LLM, with timing and source/target identity
- **Hop Log** — a flat list of all hops with a right-side detail panel (click
  any row to inspect span attributes, model name, duration, and the actual
  prompt/completion or tool arguments/result). `agent_to_llm` hops include a
  **"View prompt & completion in Phoenix →"** link that opens the full trace.
- **Sequence** — swimlane diagram with CHAIN/TOOL color coding and a toggle to
  hide MCP protocol setup calls (hidden by default for readability)
- **Graph** — ReactFlow DAG with arrows labeled ×N for multi-hop edges; click
  an arrow to inspect each call individually via tabbed panels
- **Delegation Graph** — aggregate view of which agents invoke which agents
  across all requests
- **Principal Paths** — which principals triggered a specific agent → tool path
- **Delete runs** — per-row checkboxes + "Delete selected" / "Clear all" in the
  Trajectories list

All data is captured transparently by the `lineage-telemetry` authbridge plugin
with `capture_io: true` — no changes to agent code are required. The plugin
parses the parsed inference/MCP/A2A extensions already populated by upstream
parsers and attaches `input.value` / `output.value` to every hop span, making
prompt, completion, and tool call data visible in both Execution Flow and Phoenix.

---

## Prerequisites

| Tool | Minimum version | Notes |
|------|----------------|-------|
| `git` | any | |
| `kind` | 0.22 | |
| `kubectl` | 1.28 | |
| `helm` | 3.14 | |
| `docker` | 24 | Docker Desktop or Podman Desktop |
| `jq` | any | used in verification commands |
| `ollama` | any | must be running locally with `qwen2.5:3b` pulled |

SSH access to `github.com` is required — the clone commands use SSH (`git@github.com:…`).
If you only have HTTPS access, replace `git@github.com:s-and-p-team/` with
`https://github.com/s-and-p-team/` in the clone commands below.

Ollama must be running and reachable on `localhost:11434` before step c.
Pull the model once if you haven't already:
```bash
ollama pull qwen2.5:3b
```

---

## Step a — Clone the four repos

All four repos must be siblings of each other. Three use the `lineage_plugin`
branch; `agent-examples` uses its main branch.

```bash
mkdir -p ~/development && cd ~/development

git clone -b lineage_plugin git@github.com:s-and-p-team/kagenti.git
git clone -b lineage_plugin git@github.com:s-and-p-team/kagenti-extensions.git
git clone -b lineage_plugin git@github.com:s-and-p-team/data_lineage.git
git clone              git@github.com:s-and-p-team/agent-examples.git
```

Expected layout:
```
~/development/
  kagenti/            ← lineage_plugin branch
  kagenti-extensions/ ← lineage_plugin branch
  data_lineage/       ← lineage_plugin branch
  agent-examples/     ← main branch
```

---

## Step b — Build the images

```bash
cd ~/development/kagenti
scripts/lineage/build-images.sh
```

This builds five Docker images (~5 minutes on first run):

| Image | Source | Purpose |
|-------|--------|---------|
| `localhost/authbridge:lineage-plugin` | kagenti-extensions | authbridge with lineage-telemetry plugin + `capture_io` |
| `localhost/lineage-service:latest` | data_lineage | lineage REST service + Postgres schema |
| `localhost/weather-tool:lineage` | agent-examples | weather MCP tool (wttr.in backend) |
| `localhost/kagenti-backend:lineage` | kagenti | backend with lineage DELETE routes |
| `localhost/kagenti-ui:lineage` | kagenti | UI with Execution Flow input/output + Phoenix link |

---

## Step c — Deploy the base platform

```bash
cd ~/development/kagenti
./.github/scripts/local-setup/kind-full-test.sh --skip-cluster-destroy
```

This creates a Kind cluster (`kagenti`), installs all platform dependencies
(Keycloak, SPIRE, Istio, OTel collector, Shipwright), deploys the kagenti platform,
deploys the weather agent demo, and runs the E2E test suite. It takes
~30–40 minutes on the first run (image pulls + E2E tests).

To skip the E2E tests and save ~10 minutes:

```bash
./.github/scripts/local-setup/kind-full-test.sh --skip-cluster-destroy --skip-test
```

When it finishes, verify the platform is healthy:

```bash
./.github/scripts/local-setup/show-services.sh
```

---

## Step d — Wire the lineage stack

```bash
cd ~/development/kagenti
scripts/lineage/deploy-lineage.sh
```

To also deploy Phoenix (accessible at `http://phoenix.localtest.me:8080`):

```bash
scripts/lineage/deploy-lineage.sh --phoenix
```

This takes ~5–10 minutes (cluster is already up). It:

1. Loads all 5 images into the Kind cluster
2. Overrides the authbridge sidecar image so the lineage plugin is active in agent pods (with `capture_io=true` so input/output data is captured on every hop)
3. Enables the lineage feature flag on the kagenti backend
4. Deploys Postgres + lineage-service + configures the OTel pipeline
5. Restarts agent pods in `team1` so they pick up the new authbridge sidecar
6. Deploys the custom weather-tool (wttr.in), backend, and UI images
7. Restarts `kagenti-backend` so it picks up the `KAGENTI_FEATURE_FLAG_LINEAGE=true` setting

When it finishes it prints the lineage UI URL and a test curl command.

---

## Step e — Send a test query and verify

The weather-service speaks the A2A (JSON-RPC) protocol. Port-forward directly to
the agent container (port 8001) to bypass the authbridge JWT check for local testing:

```bash
POD=$(kubectl get pod -n team1 -l app.kubernetes.io/name=weather-service \
  -o jsonpath='{.items[0].metadata.name}')
kubectl port-forward -n team1 pod/$POD 8000:8001 &
```

Send a query (use any city):

```bash
curl -s -X POST http://localhost:8000/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "message/send",
    "params": {
      "message": {
        "role": "user", "messageId": "test-001",
        "parts": [{"kind": "text", "text": "What is the weather in Paris?"}]
      },
      "metadata": {}
    }
  }' | jq .result.artifacts[0].parts[0].text
```

Navigate to `http://kagenti-ui.localtest.me:8080` and click **Execution Flow**
in the left navigation. Within ~30 seconds the **Trajectories** tab should show
a run. Click it to open the trajectory detail.

---

## Trajectory detail — UI walkthrough

### Hop Log tab

A flat list of all hops with Kind badge, source/target, and duration. Click any
row to open the detail panel on the right showing full span attributes. The
**CHAIN** pill hides MCP protocol setup calls (`agent_to_service` kind) by
default — click it to show them.

### Sequence tab

Swimlane diagram ordered by time. Hops are color-coded:

| Colour | Hop kind | Meaning |
|--------|----------|---------|
| Blue-grey | `agent_to_service` | MCP protocol setup / init (CHAIN) |
| Green | `agent_to_tool` | Agent calling an MCP tool |
| Blue | `principal_to_agent` | End-user reaching the entry agent |
| Orange | `agent_to_agent` | Agent delegating to another agent |
| Purple | `agent_to_llm` | Agent calling an LLM |

The sticky header has a **CHAIN** toggle (hidden by default) to declutter the
view.

### Graph tab

ReactFlow DAG. Principal node at the top. Click any node or arrow:

- **Node** — right panel shows all hops to/from that workload
- **Arrow** — right panel shows the hop details; arrows labeled ×N have numbered
  tabs so you can inspect each individual call

---

## Verifying the pipeline manually

If hops are not appearing, check each layer in order:

```bash
# 1. Is the authbridge lineage plugin emitting spans?
kubectl logs -n team1 -l app.kubernetes.io/name=weather-service -c authbridge-proxy --tail=50 | grep lineage

# 2. Is the OTel collector receiving and forwarding them?
kubectl logs -n kagenti-system deploy/otel-collector --tail=50 | grep lineage

# 3. Is the lineage-service receiving spans?
kubectl logs -n kagenti-system deploy/lineage-service --tail=20

# 4. Does the API return runs?
kubectl port-forward -n kagenti-system svc/lineage-service 8001:8000 &
curl -s http://localhost:8001/runs | jq length
```

---

## Troubleshooting

### Pods stuck in `Pending` — Insufficient CPU

Kind clusters have limited CPU headroom. Each agent pod gets an injected
`authbridge-proxy` sidecar that by default requests `100m` CPU. On a busy
cluster these requests can exhaust the schedulable budget even when actual
utilisation is low.

Diagnose:
```bash
kubectl describe pod -n team1 -l app.kubernetes.io/name=weather-service | grep -A3 Events
# Look for: 0/1 nodes are available: 1 Insufficient cpu
```

Fix — set sidecar CPU requests to `0` in the platform config:
```bash
kubectl get configmap kagenti-platform-config -n kagenti-system -o json \
  | python3 -c "
import sys, json, yaml
cm = json.load(sys.stdin)
cfg = yaml.safe_load(cm['data']['config.yaml'])
for comp in ['authbridge', 'envoyProxy', 'proxyInit']:
    for section in ['requests', 'limits']:
        cfg['resources'].get(comp, {}).get(section, {})['cpu'] = '0'
cm['data']['config.yaml'] = yaml.dump(cfg)
print(json.dumps(cm))
" | kubectl apply -f -

kubectl rollout restart deployment/kagenti-controller-manager -n kagenti-system
kubectl rollout status  deployment/kagenti-controller-manager -n kagenti-system --timeout=60s
kubectl rollout restart deployment/weather-service -n team1
```

---

## Teardown

Remove the lineage stack but keep the cluster:

```bash
# Disable lineage feature flag and lineageService component
helm upgrade kagenti charts/kagenti/ -n kagenti-system --reuse-values \
  --set "featureFlags.lineage=false" \
  --set "kagenti-operator-chart.defaults.images.authbridge=ghcr.io/kagenti/kagenti-extensions/authbridge:v0.6.0-alpha.4"

helm upgrade kagenti-deps charts/kagenti-deps/ -n kagenti-system --reuse-values \
  --set "components.lineageService.enabled=false"
```

To destroy the entire cluster:

```bash
./.github/scripts/local-setup/kind-full-test.sh --include-cluster-destroy
```
