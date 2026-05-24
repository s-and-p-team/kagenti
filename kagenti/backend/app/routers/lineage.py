# Copyright 2025 IBM Corp.
# Licensed under the Apache License, Version 2.0

"""
Lineage proxy router.

Forwards lineage queries from the kagenti backend to the standalone
lineage-service. All endpoints require ROLE_VIEWER and are gated
behind the kagenti_feature_flag_lineage feature flag.
"""

import logging
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import ROLE_VIEWER, require_roles
from app.core.config import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/lineage", tags=["lineage"])

_viewer = Depends(require_roles([ROLE_VIEWER]))


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
    params: dict = {"limit": limit}
    if principal:
        params["principal"] = principal
    if username:
        params["username"] = username
    if agent:
        params["agent"] = agent
    if tool:
        params["tool"] = tool
    if since:
        params["since"] = since
    if until:
        params["until"] = until
    return await _proxy_get("/runs", params)


@router.get("/runs/{run_id}/trajectory", dependencies=[_viewer])
async def get_trajectory(run_id: str):
    return await _proxy_get(f"/runs/{run_id}/trajectory")


@router.get("/principals/{principal_id}/agents", dependencies=[_viewer])
async def get_principal_agents(principal_id: str):
    return await _proxy_get(f"/principals/{principal_id}/agents")


@router.get("/edges", dependencies=[_viewer])
async def list_edges(
    hop_kind: Optional[str] = Query(None),
    principal: Optional[str] = Query(None),
    min_count: int = Query(1, ge=1),
    limit: int = Query(100, ge=1, le=1000),
):
    params: dict = {"limit": limit, "min_count": min_count}
    if hop_kind:
        params["hop_kind"] = hop_kind
    if principal:
        params["principal"] = principal
    return await _proxy_get("/edges", params)


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


@router.get("/paths/common", dependencies=[_viewer])
async def get_common_paths(
    limit: int = Query(50, ge=1, le=500),
):
    return await _proxy_get("/paths/common", {"limit": limit})


@router.get("/autocomplete/agents", dependencies=[_viewer])
async def autocomplete_agents(
    prefix: str = Query(""),
    limit: int = Query(20, ge=1, le=100),
):
    return await _proxy_get("/autocomplete/agents", {"prefix": prefix, "limit": limit})


@router.get("/autocomplete/tools", dependencies=[_viewer])
async def autocomplete_tools(
    prefix: str = Query(""),
    limit: int = Query(20, ge=1, le=100),
):
    return await _proxy_get("/autocomplete/tools", {"prefix": prefix, "limit": limit})
