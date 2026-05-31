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

## Repo layout

Three repos are needed, all on the `lineage_plugin` branch, as siblings.
`kagenti-operator` and `agent-examples` are **not** needed locally — the operator
is bundled in the kagenti Helm chart, and the weather demo agent is built in-cluster
by Shipwright directly from GitHub.

```bash
mkdir -p ~/development && cd ~/development

git clone git@github.com:s-and-p-team/kagenti.git
cd kagenti && git checkout lineage_plugin && cd ..

git clone git@github.com:s-and-p-team/kagenti-extensions.git
cd kagenti-extensions && git checkout lineage_plugin && cd ..

git clone git@github.com:s-and-p-team/data_lineage.git
cd data_lineage && git checkout lineage_plugin && cd ..
```

Expected layout:
```
~/development/
  kagenti/            ← lineage_plugin branch
  kagenti-extensions/ ← lineage_plugin branch
  data_lineage/       ← lineage_plugin branch
```

---

## Step 1 — Build the authbridge image with the lineage plugin

The lineage plugin lives in `kagenti-extensions/authbridge/authlib/plugins/lineage/`
and is compiled into the `authbridge-proxy` binary. Build it from the
`authbridge/` context (not the repo root):

```bash
cd ~/development/kagenti-extensions/authbridge
docker build -f cmd/authbridge-proxy/Dockerfile \
  -t localhost/authbridge:lineage-plugin .
```

This takes ~2 minutes on first build (Go module download + compile).

---

## Step 2 — Build the lineage-service image

```bash
cd ~/development/data_lineage
docker build -t localhost/lineage-service:latest lineage_service/
```

---

## Step 3 — Deploy the base platform

From the kagenti repo root:

```bash
cd ~/development/kagenti
./.github/scripts/local-setup/kind-full-test.sh --skip-cluster-destroy
```

This creates a Kind cluster (`kagenti`), installs all dependencies (Keycloak,
SPIRE, Istio, OTel collector, Tekton), deploys the kagenti platform, and runs
the weather agent demo. It takes ~15–20 minutes on the first run.

When it finishes, verify the platform is healthy:

```bash
./.github/scripts/local-setup/show-services.sh
```

---

## Step 4 — Load images into Kind and override authbridge

Load both images into the Kind cluster and update the operator's sidecar image
so it injects the lineage-plugin build into new and restarted pods:

```bash
cd ~/development/kagenti

kind load docker-image localhost/authbridge:lineage-plugin --name kagenti
kind load docker-image localhost/lineage-service:latest --name kagenti

# Override the authbridge sidecar image for all agent namespaces
helm upgrade kagenti charts/kagenti/ -n kagenti-system --reuse-values \
  --set "kagenti-operator-chart.defaults.images.authbridge=localhost/authbridge:lineage-plugin"

# Restart agent pods so they pick up the new authbridge sidecar
kubectl rollout restart deployment -n team1
kubectl rollout status deployment -n team1 --timeout=120s
```

---

## Step 5 — Deploy the lineage stack

Run the deploy script from the kagenti repo root (it expects to be run there
because it calls `helm upgrade charts/kagenti-deps/` and `docker build kagenti/`):

```bash
cd ~/development/kagenti
bash ../data_lineage/lineage_service/manifests/deploy.sh
```

The script:

1. Creates `lineage-postgres-credentials` secret (skipped if it already exists)
2. Deploys Postgres and runs the schema bootstrap Job
3. Deploys the lineage-service pod + Service + HTTPRoute
4. Patches the OTel collector to add the `filter/lineage` + `transform/lineage_to_trust`
   processors and the `otlphttp/lineage` exporter
5. Builds the kagenti-ui from local source and loads it into Kind (captures the
   new Hop Log, CHAIN toggle, and multi-hop edge UI)
6. Enables `KAGENTI_FEATURE_FLAG_LINEAGE=true` on the kagenti-backend

When the script finishes it prints the lineage UI URL.

---

## Step 6 — Send a test query and verify

Open a second terminal and port-forward the weather agent:

```bash
kubectl port-forward -n team1 svc/weather-service 8000:8080
```

Send a query (use any city):

```bash
curl -s http://localhost:8000/weather?city=Paris | jq .
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
bash ~/development/data_lineage/lineage_service/manifests/undeploy.sh

# Remove credentials secret (not deleted by undeploy.sh)
kubectl delete secret lineage-postgres-credentials -n kagenti-system --ignore-not-found

# Re-enable the default authbridge image
helm upgrade kagenti charts/kagenti/ -n kagenti-system --reuse-values \
  --set "kagenti-operator-chart.defaults.images.authbridge=ghcr.io/kagenti/kagenti-extensions/authbridge:v0.6.0-alpha.4"
```

To destroy the entire cluster:

```bash
./.github/scripts/local-setup/kind-full-test.sh --include-cluster-destroy
```
