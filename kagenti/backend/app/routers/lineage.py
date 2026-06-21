# Copyright 2025 IBM Corp.
# Licensed under the Apache License, Version 2.0
#
# Proxy router that forwards lineage queries to the lineage REST contract.
# Originally targeted arielf's standalone lineage_service; repointed via
# settings.lineage_service_url to the data-governance pod, which serves the
# identical shapes under /lineage. Gated behind kagenti_feature_flag_lineage
# (conditionally imported in app/main.py).

import logging
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import ROLE_VIEWER, require_roles
from app.core.config import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/lineage", tags=["lineage"])

_viewer = Depends(require_roles(ROLE_VIEWER))


def _lineage_url() -> str:
    return get_settings().lineage_service_url.rstrip("/")


async def _proxy_get(path: str, params: dict | None = None) -> Any:
    url = f"{_lineage_url()}{path}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, params=params)
        if resp.status_code == 404:
            raise HTTPException(status_code=404, detail="Not found")
        resp.raise_for_status()
        return resp.json()
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Lineage service error: %s", exc)
        raise HTTPException(status_code=502, detail="Lineage service unavailable") from exc


@router.get("/runs", dependencies=[_viewer])
async def list_runs(
    principal: Optional[str] = Query(None),
    username: Optional[str] = Query(None),
    agent: Optional[str] = Query(None),
    tool: Optional[str] = Query(None),
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    params: dict[str, Any] = {"limit": limit}
    for key, val in (
        ("principal", principal),
        ("username", username),
        ("agent", agent),
        ("tool", tool),
        ("since", since),
        ("until", until),
    ):
        if val:
            params[key] = val
    return await _proxy_get("/runs", params)


@router.get("/runs/{run_id}/trajectory", dependencies=[_viewer])
async def get_trajectory(run_id: str):
    return await _proxy_get(f"/runs/{run_id}/trajectory")


@router.get("/runs/{run_id}/graph", dependencies=[_viewer])
async def get_run_graph(run_id: str):
    return await _proxy_get(f"/runs/{run_id}/graph")


@router.get("/runs/{run_id}/sequence", dependencies=[_viewer])
async def get_run_sequence(run_id: str):
    return await _proxy_get(f"/runs/{run_id}/sequence")


@router.get("/runs/{run_id}/tree", dependencies=[_viewer])
async def get_run_tree(run_id: str):
    return await _proxy_get(f"/runs/{run_id}/tree")


@router.get("/datagraph", dependencies=[_viewer])
async def get_data_graph():
    return await _proxy_get("/datagraph")


@router.get("/principals/{principal_id}/agents", dependencies=[_viewer])
async def get_principal_agents(principal_id: str):
    return await _proxy_get(f"/principals/{principal_id}/agents")


@router.get("/edges/common", dependencies=[_viewer])
async def get_common_edges(
    hop_kind: str = Query("agent_to_agent"),
    limit: int = Query(50, ge=1, le=500),
):
    return await _proxy_get("/edges/common", {"hop_kind": hop_kind, "limit": limit})


@router.get("/paths", dependencies=[_viewer])
async def get_paths(
    agent: str = Query(...),
    tool: str = Query(...),
):
    return await _proxy_get("/paths", {"agent": agent, "tool": tool})


@router.get("/autocomplete/agents", dependencies=[_viewer])
async def autocomplete_agents(prefix: str = Query(""), limit: int = Query(20, ge=1, le=500)):
    return await _proxy_get("/autocomplete/agents", {"prefix": prefix, "limit": limit})


@router.get("/autocomplete/tools", dependencies=[_viewer])
async def autocomplete_tools(prefix: str = Query(""), limit: int = Query(20, ge=1, le=500)):
    return await _proxy_get("/autocomplete/tools", {"prefix": prefix, "limit": limit})
