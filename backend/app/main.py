"""KINESYS Backend — FastAPI + WebSocket server for human-robot interaction."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("kinesys")

# ---------------------------------------------------------------------------
# Load shared action primitives
# ---------------------------------------------------------------------------
SHARED_DIR = Path(__file__).resolve().parent.parent.parent / "shared"
ACTION_TYPES_PATH = SHARED_DIR / "action_types.json"


def load_action_types() -> dict[str, Any]:
    """Load and validate the shared action_types.json."""
    try:
        with open(ACTION_TYPES_PATH, "r") as f:
            data: dict[str, Any] = json.load(f)
        logger.info("Loaded %d action primitives from %s", len(data.get("primitives", {})), ACTION_TYPES_PATH)
        return data
    except FileNotFoundError:
        logger.warning("action_types.json not found at %s — using empty primitives", ACTION_TYPES_PATH)
        return {"version": "0.0.0", "primitives": {}}
    except json.JSONDecodeError as exc:
        logger.error("Failed to parse action_types.json: %s", exc)
        return {"version": "0.0.0", "primitives": {}}


ACTION_TYPES = load_action_types()

# ---------------------------------------------------------------------------
# FastAPI Application
# ---------------------------------------------------------------------------
app = FastAPI(
    title="KINESYS",
    description="Human-Robot Interaction Platform — Backend API",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Connection Manager
# ---------------------------------------------------------------------------


class ConnectionManager:
    """Manages active WebSocket connections."""

    def __init__(self) -> None:
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info("Client connected. Total connections: %d", len(self.active_connections))

    def disconnect(self, websocket: WebSocket) -> None:
        self.active_connections.remove(websocket)
        logger.info("Client disconnected. Total connections: %d", len(self.active_connections))

    async def send_json(self, websocket: WebSocket, data: dict[str, Any]) -> None:
        await websocket.send_json(data)

    async def broadcast(self, data: dict[str, Any]) -> None:
        for connection in self.active_connections:
            try:
                await connection.send_json(data)
            except Exception:
                logger.exception("Failed to broadcast to a client")


manager = ConnectionManager()

# ---------------------------------------------------------------------------
# REST Endpoints
# ---------------------------------------------------------------------------


@app.get("/")
async def root() -> dict[str, str]:
    return {"service": "kinesys-backend", "status": "running", "version": "0.1.0"}


@app.get("/api/actions")
async def get_action_types() -> dict[str, Any]:
    """Return the shared action primitive definitions."""
    return ACTION_TYPES


@app.get("/api/health")
async def health_check() -> dict[str, Any]:
    return {
        "status": "healthy",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "connections": len(manager.active_connections),
    }


# ---------------------------------------------------------------------------
# WebSocket Endpoint
# ---------------------------------------------------------------------------


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)

    # Send welcome message with server info
    await manager.send_json(websocket, {
        "type": "connection",
        "status": "connected",
        "message": "Connected to KINESYS backend",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "available_actions": list(ACTION_TYPES.get("primitives", {}).keys()),
    })

    try:
        while True:
            raw = await websocket.receive_text()

            try:
                data: dict[str, Any] = json.loads(raw)
            except json.JSONDecodeError:
                await manager.send_json(websocket, {
                    "type": "error",
                    "message": "Invalid JSON payload",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
                continue

            msg_type = data.get("type", "unknown")
            logger.info("Received message type=%s", msg_type)

            # Echo with server metadata
            response: dict[str, Any] = {
                "type": "echo",
                "original": data,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "server": "kinesys-backend",
            }

            await manager.send_json(websocket, response)

    except WebSocketDisconnect:
        manager.disconnect(websocket)
        logger.info("WebSocket cleanly disconnected")
    except Exception:
        manager.disconnect(websocket)
        logger.exception("WebSocket error")
