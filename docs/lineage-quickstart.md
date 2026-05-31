# Data Lineage Quickstart

This guide walks through deploying the full data lineage stack on a local Kind
cluster so that agent trust provenance hops are captured end-to-end and visible
in the UI.

## What you get

- **Trajectories tab** — per-request trust chains showing every hop from
  principal → agent → tool / LLM, with timing and source/target identity
- **Hop Log** — a flat list of all hops with a right-side detail panel (click
  any row to inspect span attributes, model name, duration, etc.)
- **Sequence** — swimlane diagram with CHAIN/TOOL color coding and a toggle to
  hide MCP protocol setup calls (hidden by default for readability)
- **Graph** — ReactFlow DAG with arrows labeled ×N for multi-hop edges; click
  an arrow to inspect each call individually via tabbed panels
- **Delegation Graph** — aggregate view of which agents invoke which agents
  across all requests
- **Principal Paths** — which principals triggered a specific agent → tool path
- **Delete runs** — per-row checkboxes + "Delete selected" / "Clear all" in the
  Trajectories list

All data is captured transparently by the `lineage-telemetry` authbridge plugin —
no changes to agent code are required.

---

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| `kind` | 0.22 |
| `kubectl` | 1.28 |
| `helm` | 3.14 |
| `docker` | 24 |

---

## Step a — Clone the three repos

All three repos must be siblings of each other on the `lineage_plugin` branch.
`kagenti-operator` and `agent-examples` are **not** needed locally — the operator
is bundled in the kagenti Helm chart, and the weather demo agent is built in-cluster
by Shipwright directly from GitHub.

```bash
mkdir -p ~/development && cd ~/development

git clone -b lineage_plugin git@github.com:s-and-p-team/kagenti.git
git clone -b lineage_plugin git@github.com:s-and-p-team/kagenti-extensions.git
git clone -b lineage_plugin git@github.com:s-and-p-team/data_lineage.git
```

Expected layout:
```
~/development/
  kagenti/            ← lineage_plugin branch
  kagenti-extensions/ ← lineage_plugin branch
  data_lineage/       ← lineage_plugin branch
```

---

## Step b — Build the images

```bash
cd ~/development/kagenti
scripts/lineage/build-images.sh
```

This builds two Docker images (~2 minutes on first run for Go module downloads):

- `localhost/authbridge:lineage-plugin` — authbridge proxy with the lineage-telemetry plugin compiled in
- `localhost/lineage-service:latest` — the data lineage REST service

---

## Step c — Deploy everything

```bash
cd ~/development/kagenti
scripts/lineage/deploy-lineage.sh
```

This takes ~15–20 minutes on the first run. It:

1. Creates a Kind cluster (`kagenti`) and installs all platform dependencies
   (Keycloak, SPIRE, Istio, OTel collector, Tekton) via `kind-full-test.sh`
2. Loads both images into the Kind cluster
3. Overrides the authbridge sidecar image so the lineage plugin is active in agent pods
4. Enables the lineage feature flag on the kagenti backend
5. Deploys Postgres + lineage-service + configures the OTel pipeline
6. Restarts agent pods in `team1` so they pick up the new authbridge sidecar

When it finishes it prints the lineage UI URL and a test curl command.

**If your cluster is already up** (e.g. you're iterating on lineage code only):

```bash
scripts/lineage/deploy-lineage.sh --skip-platform
```

---

## Step d — Send a test query and verify

In a second terminal, port-forward the weather agent:

```bash
kubectl port-forward -n team1 svc/weather-service 8000:8080
```

Send a query (use any city):

```bash
curl -s 'http://localhost:8000/weather?city=Paris' | jq .
```

Navigate to `http://kagenti-ui.localtest.me:8080` and click **Data Lineage**
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
kubectl logs -n team1 -l app=weather-service -c authbridge --tail=50 | grep lineage

# 2. Is the OTel collector receiving and forwarding them?
kubectl logs -n kagenti-system deploy/otel-collector --tail=50 | grep lineage

# 3. Is the lineage-service receiving spans?
kubectl logs -n kagenti-system deploy/lineage-service --tail=20

# 4. Does the API return runs?
kubectl port-forward -n kagenti-system svc/lineage-service 8001:8000 &
curl -s http://localhost:8001/runs | jq length
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
