# Data Lineage Quickstart

This guide walks through deploying the data lineage stack on a local Kind
cluster and verifying that agent trust provenance hops are captured end-to-end.

## What you get

- **Trajectories tab** — per-request trust chains showing every hop from
  principal → agent → tool, with timing and outcome
- **Delegation Graph tab** — aggregate view of which agents invoke which agents
  across all requests
- **Principal Paths tab** — shows which principals triggered a specific
  agent → tool path

All data is captured transparently by the `lineage-telemetry` authbridge sidecar
plugin — no changes to agent code are required.

---

## Prerequisites

| Tool | Minimum version | Notes |
|------|----------------|-------|
| `kind` | 0.22 | Local Kubernetes |
| `kubectl` | 1.28 | Cluster access |
| `helm` | 3.14 | Chart management |
| `docker` | 24 | Image builds |
| `uv` | 0.4 | Python test runner (for `--test`) |

The base Kagenti platform must already be installed on the cluster. If you
haven't done that yet:

```bash
.github/scripts/local-setup/kind-full-test.sh --skip-cluster-destroy
```

---

## One-command setup

```bash
scripts/deploy-lineage.sh --demo-agents --test
```

This does everything:

1. Enables the `lineageService` Helm component and the `lineage` feature flag
2. Deploys `weather-service` (A2A agent) and `weather-tool` (MCP tool)
3. Runs the lineage E2E tests (Phase 1 traffic + Phase 2 validation)

A successful run ends with:

```
══ PHASE 4: All lineage E2E tests passed ══

Lineage stack deployment complete.

  Lineage UI:  http://kagenti-ui.localtest.me:8080  → Data Lineage tab
```

---

## Step-by-step

### 1. Deploy the lineage stack

```bash
scripts/deploy-lineage.sh --demo-agents
```

The script upgrades two Helm releases:

- **`kagenti-deps`** — adds the `lineage-service` (FastAPI + PostgreSQL) and
  extends the OTel collector pipeline with `filter/lineage` and
  `transform/lineage_to_trust` processors
- **`kagenti`** — sets `featureFlags.lineage=true` and injects the
  `lineage-telemetry` plugin config into every agent namespace's authbridge
  ConfigMap

### 2. Send a weather query

Open a second terminal and port-forward the weather agent:

```bash
kubectl port-forward -n team1 svc/weather-service 8000:8080
```

Then send a query:

```bash
curl -s http://localhost:8000/weather?city=Paris | jq .
```

### 3. Open the lineage UI

Navigate to `http://kagenti-ui.localtest.me:8080` and click **Data Lineage**
in the left nav.

Within ~30 seconds the **Trajectories** tab should show one or more runs. Click
a run to see the DAG with colour-coded hops:

| Colour | Hop kind | Meaning |
|--------|----------|---------|
| Blue | `principal_to_agent` | End-user or service reaching the agent |
| Green | `agent_to_agent` | Agent delegating to another agent (A2A) |
| Orange | `agent_to_tool` | Agent calling an MCP tool |

### 4. Filter by principal, agent, or time range

Use the filter bar at the top of each tab:

- **Principal** — filter to a specific Keycloak user subject (`sub` claim)
- **Agent** — filter to runs that touched a specific agent workload
- **Tool** — used with agent filter in the Principal Paths tab to find who
  triggered an exact agent → tool path
- **Time range** — 1 h / 24 h / 7 d / all

---

## Verifying the pipeline manually

If hops are not appearing, check each layer in order:

```bash
# 1. Is the authbridge plugin emitting spans?
kubectl logs -n team1 deploy/weather-service -c authbridge | grep lineage

# 2. Is the OTel collector receiving and forwarding them?
kubectl logs -n kagenti-system deploy/otel-collector | grep lineage

# 3. Is the lineage-service receiving POSTed spans?
kubectl logs -n kagenti-system deploy/lineage-service | tail -20

# 4. Does the API return runs?
kubectl port-forward -n kagenti-system svc/kagenti-backend 8002:8000 &
curl -s http://localhost:8002/api/v1/lineage/runs | jq length
```

---

## Running the E2E tests standalone

After traffic has been generated (Step 2 above), run the observability phase:

```bash
export KAGENTI_BACKEND_URL=http://localhost:8002
export KAGENTI_CONFIG_FILE=deployments/envs/dev_values_lineage.yaml

cd kagenti
uv run pytest tests/e2e/common/test_lineage_traces.py -v -m observability
```

Expected output:

```
PASSED tests/e2e/common/test_lineage_traces.py::TestLineageServiceConnectivity::test_lineage_runs_endpoint_reachable
PASSED tests/e2e/common/test_lineage_traces.py::TestLineageDataCapture::test_lineage_runs_appear
PASSED tests/e2e/common/test_lineage_traces.py::TestLineageDataCapture::test_run_has_valid_structure
PASSED tests/e2e/common/test_lineage_traces.py::TestLineageDataCapture::test_trajectory_has_hops
PASSED tests/e2e/common/test_lineage_traces.py::TestLineageDataCapture::test_trajectory_hop_kinds
```

---

## Teardown

The lineage stack is additive — to disable it, run a `helm upgrade` that omits
the lineage values file and removes the component:

```bash
helm upgrade kagenti-deps charts/kagenti-deps/ -n kagenti-system \
  --reuse-values \
  --set components.lineageService.enabled=false \
  --wait

helm upgrade kagenti charts/kagenti/ -n kagenti-system \
  --reuse-values \
  --set featureFlags.lineage=false \
  --wait
```

To destroy the entire cluster:

```bash
.github/scripts/local-setup/kind-full-test.sh --include-cluster-destroy
```
