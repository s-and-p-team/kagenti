# Copyright 2025 IBM Corp.
# Licensed under the Apache License, Version 2.0

"""
Data Lineage Traces E2E Tests.

Validates that trust provenance hops are captured in the lineage-service after
E2E tests run. These tests MUST run AFTER other E2E tests (especially
test_agent_conversation.py) which generate lineage spans by invoking the
weather agent through the authbridge sidecar with the lineage-telemetry plugin.

The tests are marked with @pytest.mark.observability to run in phase 2 of the
two-phase test execution:
  - Phase 1: pytest -m "not observability"  (runs agent tests, generates spans)
  - Phase 2: pytest -m "observability"      (validates lineage data in service)

Prerequisites:
  - lineageService component enabled in Helm values
  - lineage feature flag enabled (featureFlags.lineage: true)
  - lineage-telemetry authbridge plugin installed on agent sidecars
  - OTel collector configured with filter/lineage + transform/lineage_to_trust

Usage:
    # Run after Phase 1 traffic generation
    pytest kagenti/tests/e2e/ -v -m "observability"

    # Standalone (requires Phase 1 traffic to have been generated)
    pytest kagenti/tests/e2e/common/test_lineage_traces.py -v
"""

import logging
import os
import subprocess
import time
import uuid

import httpx
import pytest

logger = logging.getLogger(__name__)

# Expected hop kinds emitted by the lineage-telemetry authbridge plugin
EXPECTED_HOP_KINDS = {"principal_to_agent", "agent_to_agent", "agent_to_tool"}

# Maximum time to wait for lineage data to appear after traffic generation
LINEAGE_WAIT_TIMEOUT_SECONDS = 120


# =============================================================================
# Helpers
# =============================================================================


def get_backend_url(is_openshift: bool) -> str:
    """
    Resolve the Kagenti backend API base URL.

    Priority:
    1. KAGENTI_BACKEND_URL environment variable
    2. OpenShift: discover kagenti-ui route (the ingress proxies /api/* to backend)
    3. Kind: localhost:8002 (port-forward)
    """
    url = os.environ.get("KAGENTI_BACKEND_URL")
    if url:
        return url.rstrip("/")

    if is_openshift:
        result = subprocess.run(
            [
                "kubectl",
                "get",
                "route",
                "kagenti-ui",
                "-n",
                "kagenti-system",
                "-o",
                "jsonpath={.spec.host}",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0 and result.stdout:
            return f"https://{result.stdout}"
        pytest.fail(
            "Could not discover kagenti-ui route for backend API access. "
            "Set KAGENTI_BACKEND_URL env var as a workaround."
        )

    # Kind cluster: expect port-forward on 8002
    return "http://localhost:8002"


def wait_for_lineage_runs(
    client: httpx.Client,
    backend_url: str,
    min_count: int = 1,
    timeout_seconds: int = LINEAGE_WAIT_TIMEOUT_SECONDS,
    poll_interval: float = 5.0,
    backoff_factor: float = 1.5,
    max_interval: float = 15.0,
) -> list:
    """
    Poll GET /api/v1/lineage/runs until at least `min_count` runs appear.

    Returns the list of runs on success; raises TimeoutError on failure.
    """
    start = time.time()
    interval = poll_interval
    attempt = 0

    while time.time() - start < timeout_seconds:
        attempt += 1
        try:
            resp = client.get(f"{backend_url}/api/v1/lineage/runs", timeout=15.0)
            if resp.status_code == 200:
                runs = resp.json()
                if isinstance(runs, list) and len(runs) >= min_count:
                    elapsed = time.time() - start
                    logger.info(
                        "Found %d lineage run(s) after %d attempts (%.1fs)",
                        len(runs),
                        attempt,
                        elapsed,
                    )
                    return runs
                count = len(runs) if isinstance(runs, list) else 0
                logger.info(
                    "Attempt %d: %d run(s) found, waiting for %d (next in %.1fs)",
                    attempt,
                    count,
                    min_count,
                    interval,
                )
            else:
                logger.warning(
                    "Attempt %d: lineage/runs returned HTTP %d",
                    attempt,
                    resp.status_code,
                )
        except (httpx.RequestError, ValueError) as exc:
            logger.warning("Attempt %d: error polling lineage/runs: %s", attempt, exc)

        time.sleep(interval)
        interval = min(interval * backoff_factor, max_interval)

    elapsed = time.time() - start
    raise TimeoutError(
        f"Timed out waiting for {min_count} lineage run(s) after {elapsed:.1f}s "
        f"({attempt} attempts). Check OTel collector filter/transform pipeline and "
        f"lineage-service logs."
    )


# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture(scope="module")
def lineage_http_client(is_openshift, openshift_ingress_ca):
    """Synchronous httpx.Client configured for the target environment."""
    if is_openshift:
        import ssl

        ssl_ctx = ssl.create_default_context(cafile=openshift_ingress_ca)
        return httpx.Client(verify=ssl_ctx, timeout=30.0)
    return httpx.Client(timeout=30.0)


@pytest.fixture(scope="module")
def backend_url(is_openshift):
    """Resolve and return the Kagenti backend base URL."""
    return get_backend_url(is_openshift)


# =============================================================================
# Test Classes
# =============================================================================


@pytest.mark.observability
@pytest.mark.requires_features(["lineageService"])
class TestLineageServiceConnectivity:
    """Verify the lineage proxy endpoint is reachable via the backend."""

    def test_lineage_runs_endpoint_reachable(
        self, backend_url: str, lineage_http_client: httpx.Client
    ):
        """
        GET /api/v1/lineage/runs should return HTTP 200 (even if empty list).

        Failures here indicate either the lineage feature flag is not wired up
        in the backend, or the service itself is not running.
        """
        try:
            resp = lineage_http_client.get(
                f"{backend_url}/api/v1/lineage/runs", timeout=15.0
            )
        except httpx.ConnectError as exc:
            pytest.skip(
                f"Backend not accessible at {backend_url}. "
                f"Port-forward may not be set up. Error: {exc}"
            )

        assert resp.status_code == 200, (
            f"Expected HTTP 200 from /api/v1/lineage/runs, got {resp.status_code}. "
            f"Response: {resp.text[:500]}"
        )
        data = resp.json()
        assert isinstance(data, list), (
            f"Expected JSON array from /api/v1/lineage/runs, got: {type(data)}"
        )


@pytest.mark.observability
@pytest.mark.requires_features(["lineageService"])
class TestLineageDataCapture:
    """
    Validate that lineage hops were captured after agent traffic was generated.

    These tests depend on Phase 1 having run test_agent_conversation.py with
    the lineage-telemetry authbridge plugin active on the weather agent sidecar.
    """

    def test_lineage_runs_appear(
        self, backend_url: str, lineage_http_client: httpx.Client
    ):
        """At least one trust provenance run should exist after Phase 1 traffic."""
        try:
            runs = wait_for_lineage_runs(
                lineage_http_client,
                backend_url,
                min_count=1,
                timeout_seconds=LINEAGE_WAIT_TIMEOUT_SECONDS,
            )
        except httpx.ConnectError as exc:
            pytest.skip(
                f"Backend not accessible at {backend_url}. Error: {exc}"
            )

        assert len(runs) >= 1, (
            "No lineage runs found. "
            "Verify the OTel collector lineage pipeline is active and the "
            "lineage-telemetry authbridge plugin is installed on agent sidecars."
        )

    def test_run_has_valid_structure(
        self, backend_url: str, lineage_http_client: httpx.Client
    ):
        """Each run object should contain expected fields."""
        try:
            runs = wait_for_lineage_runs(lineage_http_client, backend_url, min_count=1)
        except (httpx.ConnectError, TimeoutError) as exc:
            pytest.skip(str(exc))

        run = runs[0]
        assert "run_id" in run, f"Run missing 'run_id' field: {run}"
        assert "principal_id" in run or "caller_id" in run, (
            f"Run missing principal/caller identity fields: {run}"
        )

    def test_trajectory_has_hops(
        self, backend_url: str, lineage_http_client: httpx.Client
    ):
        """
        GET /api/v1/lineage/runs/{run_id}/trajectory should return hop data.

        Validates that the full trust chain (principal → agent → tool) was
        recorded, not just the top-level run entry.
        """
        try:
            runs = wait_for_lineage_runs(lineage_http_client, backend_url, min_count=1)
        except (httpx.ConnectError, TimeoutError) as exc:
            pytest.skip(str(exc))

        run_id = runs[0].get("run_id")
        assert run_id, f"First run is missing 'run_id': {runs[0]}"

        resp = lineage_http_client.get(
            f"{backend_url}/api/v1/lineage/runs/{run_id}/trajectory",
            timeout=15.0,
        )
        assert resp.status_code == 200, (
            f"Trajectory endpoint returned {resp.status_code} for run {run_id}. "
            f"Response: {resp.text[:500]}"
        )

        hops = resp.json()
        assert isinstance(hops, list) and len(hops) >= 1, (
            f"Expected at least one hop in trajectory for run {run_id}, got: {hops}"
        )

    def test_trajectory_hop_kinds(
        self, backend_url: str, lineage_http_client: httpx.Client
    ):
        """
        At least one hop should have a recognized hop_kind value.

        The lineage-telemetry plugin emits hop_kind values of:
          - 'principal_to_agent'  (end-user or service → agent)
          - 'agent_to_agent'      (agent delegation chain)
          - 'agent_to_tool'       (agent → MCP/tool call)
        """
        try:
            runs = wait_for_lineage_runs(lineage_http_client, backend_url, min_count=1)
        except (httpx.ConnectError, TimeoutError) as exc:
            pytest.skip(str(exc))

        # Collect all hops across the first few runs
        all_hop_kinds: set = set()
        for run in runs[:5]:
            run_id = run.get("run_id")
            if not run_id:
                continue
            resp = lineage_http_client.get(
                f"{backend_url}/api/v1/lineage/runs/{run_id}/trajectory",
                timeout=15.0,
            )
            if resp.status_code != 200:
                continue
            for hop in resp.json():
                kind = hop.get("hop_kind")
                if kind:
                    all_hop_kinds.add(kind)

        assert all_hop_kinds, (
            "No hop_kind values found in any trajectory. "
            "Ensure the OTel transform/lineage_to_trust processor is active and "
            "the lineage-service span transformer maps trust.hop_kind correctly."
        )

        unknown_kinds = all_hop_kinds - EXPECTED_HOP_KINDS
        assert not unknown_kinds, (
            f"Unexpected hop_kind values observed: {unknown_kinds}. "
            f"Valid kinds are: {EXPECTED_HOP_KINDS}"
        )

        logger.info("Observed hop kinds: %s", all_hop_kinds)


# =============================================================================
# Helper: wait for a hop with a specific outcome value
# =============================================================================


def _wait_for_hop_with_outcome(
    client: httpx.Client,
    backend_url: str,
    expected_outcome: str,
    timeout_seconds: int = LINEAGE_WAIT_TIMEOUT_SECONDS,
) -> dict:
    """
    Poll lineage runs until a hop with `outcome == expected_outcome` is found.

    Returns the matching hop dict or raises TimeoutError.
    """
    start = time.time()
    interval = 5.0

    while time.time() - start < timeout_seconds:
        try:
            resp = client.get(f"{backend_url}/api/v1/lineage/runs", timeout=15.0)
            if resp.status_code == 200:
                for run in resp.json():
                    run_id = run.get("run_id")
                    if not run_id:
                        continue
                    traj = client.get(
                        f"{backend_url}/api/v1/lineage/runs/{run_id}/trajectory",
                        timeout=15.0,
                    )
                    if traj.status_code != 200:
                        continue
                    for hop in traj.json():
                        if hop.get("outcome") == expected_outcome:
                            return hop
        except (httpx.RequestError, ValueError):
            pass

        time.sleep(interval)
        interval = min(interval * 1.5, 15.0)

    elapsed = time.time() - start
    raise TimeoutError(
        f"No hop with outcome='{expected_outcome}' found after {elapsed:.1f}s. "
        "Ensure the lineage-telemetry plugin records deny outcomes in OnFinish."
    )


# =============================================================================
# Test: denial recorded (Phase 8 item 3)
# =============================================================================


@pytest.mark.observability
@pytest.mark.requires_features(["lineageService", "keycloak"])
class TestLineageDenialRecorded:
    """
    Verify that authbridge deny outcomes are captured in the lineage-service.

    The lineage-telemetry plugin's OnFinish fires on BOTH allow and deny
    outcomes. A denied request (e.g. missing or invalid JWT) must produce a
    hop with outcome='deny' so that the trust chain is complete even when
    access is blocked.

    Requires Keycloak to be present (auth is enabled) — the test makes a
    request with a deliberately invalid token to trigger a denial.
    """

    def test_denied_request_produces_deny_hop(
        self, backend_url: str, lineage_http_client: httpx.Client
    ):
        """
        Send a request with an invalid token; assert a deny hop appears.

        Approach:
        1. Port-forward to weather-service (localhost:8000, set up by 85-start-port-forward.sh)
        2. Send GET /.well-known/agent-card.json with Authorization: Bearer <bad-token>
        3. Expect HTTP 401 or 403 from authbridge
        4. Poll lineage-service for a hop with outcome='deny'
        """
        agent_url = os.environ.get("AGENT_URL", "http://localhost:8000")

        # Verify agent is reachable before proceeding
        try:
            probe = lineage_http_client.get(
                f"{agent_url}/.well-known/agent-card.json", timeout=5.0
            )
        except httpx.ConnectError as exc:
            pytest.skip(
                f"Weather-service not reachable at {agent_url}. "
                f"Port-forward may not be running. Error: {exc}"
            )

        # If the agent returns 200 without a token then auth is disabled — skip
        if probe.status_code == 200:
            pytest.skip(
                "Weather-service responded 200 without a token — auth is disabled. "
                "This test requires Keycloak auth to be active."
            )

        # Send a request with a syntactically valid but semantically invalid JWT
        # (wrong signature / unknown issuer). Authbridge should deny it.
        fake_token = (
            "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9"
            ".eyJzdWIiOiJ0ZXN0LWRlbnkiLCJpc3MiOiJodHRwczovL2ZhaWwuZXhhbXBsZS5jb20iLCJleHAiOjE5OTk5OTk5OTl9"
            ".invalidsignature"
        )
        resp = lineage_http_client.get(
            f"{agent_url}/.well-known/agent-card.json",
            headers={"Authorization": f"Bearer {fake_token}"},
            timeout=10.0,
        )
        assert resp.status_code in (401, 403), (
            f"Expected 401/403 for invalid token, got {resp.status_code}. "
            "The test assumption is that authbridge enforces JWT validation."
        )
        logger.info("Denial confirmed: HTTP %d from agent", resp.status_code)

        # Now wait for the deny hop to appear in lineage
        try:
            hop = _wait_for_hop_with_outcome(
                lineage_http_client,
                backend_url,
                expected_outcome="deny",
                timeout_seconds=LINEAGE_WAIT_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            pytest.fail(str(exc))

        # Validate expected fields on the deny hop
        assert hop.get("hop_kind") == "principal_to_agent", (
            f"Expected deny hop to be principal_to_agent, got: {hop.get('hop_kind')}"
        )
        assert hop.get("outcome") == "deny", (
            f"Hop outcome should be 'deny', got: {hop.get('outcome')}"
        )

        # denying_plugin is optional but should be set when authbridge knows the cause
        denying_plugin = hop.get("denying_plugin")
        if denying_plugin:
            logger.info("Deny hop recorded with denying_plugin=%s", denying_plugin)
        else:
            logger.info(
                "Deny hop recorded (denying_plugin not set — "
                "plugin may not populate this field for all denial reasons)"
            )


# =============================================================================
# Test: outbound-capture-ports annotation (Phase 8 item 4)
# =============================================================================


def _get_keycloak_url() -> str:
    """Resolve Keycloak internal service URL from env or cluster discovery."""
    url = os.environ.get("KEYCLOAK_URL")
    if url:
        return url.rstrip("/")

    # Try port-forward default (set by 85-start-port-forward.sh)
    return "http://localhost:8081"


def _kubectl(*args: str, check: bool = False) -> subprocess.CompletedProcess:
    """Run a kubectl command and return the CompletedProcess result."""
    return subprocess.run(
        ["kubectl", *args],
        capture_output=True,
        text=True,
        timeout=60,
        check=check,
    )


@pytest.mark.observability
@pytest.mark.requires_features(["lineageService"])
class TestLineageAnnotationPortCapture:
    """
    Verify that the kagenti.io/outbound-capture-ports annotation enables
    capturing outbound traffic on port 8080 (Keycloak) as lineage hops.

    Without this annotation, Envoy excludes port 8080 from outbound interception
    so token-exchange calls to Keycloak are invisible to the authbridge sidecar.
    With the annotation, those calls are intercepted and produce agent_to_agent
    or agent_to_tool hops in the lineage graph.

    This test:
    1. Deploys a minimal test pod in team1 with the annotation set
    2. Uses kubectl exec to make an HTTP call from inside the pod to Keycloak
       on port 8080 (simulating a token exchange)
    3. Waits for a hop from that pod to appear in lineage
    4. Cleans up the test pod

    Requires the kagenti-operator lineage_plugin branch to be deployed, which
    implements outbound-capture-ports annotation support in the admission webhook.
    """

    _TEST_POD_NAME = "lineage-annotation-test"
    _TEST_NAMESPACE = "team1"

    def _cleanup_test_pod(self):
        """Remove the test pod if it exists."""
        _kubectl(
            "delete", "pod", self._TEST_POD_NAME,
            "-n", self._TEST_NAMESPACE,
            "--ignore-not-found",
        )

    def test_outbound_port_capture_annotation(
        self, backend_url: str, lineage_http_client: httpx.Client
    ):
        """
        A pod annotated with outbound-capture-ports: "8080" should produce
        lineage hops for Keycloak (port 8080) traffic.
        """
        # ── Skip if operator does not support the annotation ─────────────────
        # The annotation is only active when the kagenti-operator lineage_plugin
        # webhook is deployed. We detect this by checking if the MutatingWebhook
        # exists (it's always present) and then checking if a test pod gets the
        # correct iptables rule injected.
        #
        # We use a lighter-weight heuristic: if kagenti-operator is not running,
        # skip gracefully.
        op_result = _kubectl(
            "get", "deployment", "kagenti-operator",
            "-n", "kagenti-system",
            "--ignore-not-found",
            "-o", "name",
        )
        if not op_result.stdout.strip():
            pytest.skip(
                "kagenti-operator not found — outbound-capture-ports annotation "
                "requires the operator admission webhook to be running."
            )

        keycloak_url = _get_keycloak_url()

        # A unique label value lets us correlate this pod's traffic in lineage
        test_run_id = str(uuid.uuid4())[:8]
        pod_manifest = f"""
apiVersion: v1
kind: Pod
metadata:
  name: {self._TEST_POD_NAME}
  namespace: {self._TEST_NAMESPACE}
  labels:
    app: {self._TEST_POD_NAME}
    kagenti.io/type: agent
    lineage-test-run: "{test_run_id}"
  annotations:
    kagenti.io/outbound-capture-ports: "8080"
spec:
  restartPolicy: Never
  containers:
    - name: test
      image: curlimages/curl:8.7.1
      command: ["sleep", "300"]
"""

        # Clean up any leftover pod from a previous run
        self._cleanup_test_pod()

        # Create the test pod
        apply = subprocess.run(
            ["kubectl", "apply", "-f", "-"],
            input=pod_manifest,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if apply.returncode != 0:
            pytest.skip(
                f"Could not create test pod: {apply.stderr}. "
                "The namespace or RBAC may not permit pod creation."
            )

        try:
            # Wait for the pod to be running
            _kubectl(
                "wait", "pod", self._TEST_POD_NAME,
                "-n", self._TEST_NAMESPACE,
                "--for=condition=Ready",
                "--timeout=60s",
                check=True,
            )

            # Make an HTTP request from inside the pod to Keycloak on port 8080.
            # We curl the Keycloak health endpoint — this simulates an outbound
            # call that would normally be excluded from Envoy capture.
            exec_result = _kubectl(
                "exec", self._TEST_POD_NAME,
                "-n", self._TEST_NAMESPACE,
                "--",
                "curl", "-sf", "--max-time", "5",
                f"{keycloak_url}/health",
            )
            if exec_result.returncode != 0:
                pytest.skip(
                    f"kubectl exec curl to Keycloak failed: {exec_result.stderr}. "
                    f"Keycloak may not be reachable at {keycloak_url}."
                )
            logger.info("Keycloak probe from test pod returned: %s", exec_result.stdout[:200])

            # Poll lineage-service for a hop from our test pod.
            # The authbridge sidecar should intercept the outbound port-8080 call
            # and emit a lineage span with caller_id matching the pod's SPIFFE/workload ID.
            start = time.time()
            test_pod_hop_found = False
            while time.time() - start < LINEAGE_WAIT_TIMEOUT_SECONDS:
                try:
                    resp = lineage_http_client.get(
                        f"{backend_url}/api/v1/lineage/runs", timeout=15.0
                    )
                    if resp.status_code == 200:
                        for run in resp.json():
                            run_id = run.get("run_id")
                            if not run_id:
                                continue
                            traj = lineage_http_client.get(
                                f"{backend_url}/api/v1/lineage/runs/{run_id}/trajectory",
                                timeout=15.0,
                            )
                            if traj.status_code != 200:
                                continue
                            for hop in traj.json():
                                caller = hop.get("caller_id", "") or ""
                                # Look for a hop whose caller is our test pod
                                if self._TEST_POD_NAME in caller:
                                    test_pod_hop_found = True
                                    logger.info(
                                        "Found outbound-capture hop from %s: hop_kind=%s",
                                        caller,
                                        hop.get("hop_kind"),
                                    )
                                    break
                            if test_pod_hop_found:
                                break
                except (httpx.RequestError, ValueError):
                    pass
                if test_pod_hop_found:
                    break
                time.sleep(5)

            assert test_pod_hop_found, (
                f"No lineage hop found for test pod '{self._TEST_POD_NAME}' after "
                f"{LINEAGE_WAIT_TIMEOUT_SECONDS}s. "
                "Verify that the kagenti-operator lineage_plugin branch is deployed and "
                "that the outbound-capture-ports annotation is respected by the "
                "admission webhook (check Envoy iptables rules in the pod)."
            )

        finally:
            self._cleanup_test_pod()
