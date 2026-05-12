# Copyright 2025 IBM Corp.
# Licensed under the Apache License, Version 2.0
#
# Drop-in file for: kagenti/kagenti/backend/app/routers/lineage.py
#
# Proxy router that forwards lineage queries to the standalone lineage service.
# All endpoints are gated behind the kagenti_feature_flag_lineage feature flag
# (see config_snippet.py / main_snippet.py).

import logging
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import ROLE_OPERATOR, ROLE_VIEWER, require_roles
from app.core.config import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/lineage", tags=["lineage"])

_viewer = Depends(require_roles(ROLE_VIEWER))
_operator = Depends(require_roles(ROLE_OPERATOR))


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


async def _proxy_delete(path: str, params: dict | None = None) -> Any:
    url = f"{_lineage_url()}{path}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.delete(url, params=params)
        if resp.status_code == 404:
            raise HTTPException(status_code=404, detail="Not found")
        if resp.status_code == 400:
            raise HTTPException(status_code=400, detail=resp.json().get("detail", "Bad request"))
        resp.raise_for_status()
        if resp.status_code == 204:
            return None
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
    params = {"limit": limit}
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


@router.delete("/runs/{run_id}", dependencies=[_operator], status_code=204)
async def delete_run(run_id: str):
    await _proxy_delete(f"/runs/{run_id}")


@router.delete("/runs", dependencies=[_operator])
async def clear_runs(confirm: Optional[str] = Query(None)):
    return await _proxy_delete("/runs", {"confirm": confirm or ""})


@router.get("/autocomplete/agents", dependencies=[_viewer])
async def autocomplete_agents(prefix: str = Query(""), limit: int = Query(20)):
    return await _proxy_get("/autocomplete/agents", {"prefix": prefix, "limit": limit})


@router.get("/autocomplete/tools", dependencies=[_viewer])
async def autocomplete_tools(prefix: str = Query(""), limit: int = Query(20)):
    return await _proxy_get("/autocomplete/tools", {"prefix": prefix, "limit": limit})
