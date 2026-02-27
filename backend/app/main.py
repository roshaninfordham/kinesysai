"""KINESYS Backend — FastAPI + WebSocket server for human-robot interaction."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from ai.llm_client import LLMClient
from ai.task_decomposer import decompose_command
from ai.scene_analyzer import scene_state_from_frontend
from core.trajectory_planner import plan_trajectory

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
# LLM Client (singleton, lazy-init)
# ---------------------------------------------------------------------------

_llm_client: LLMClient | None = None


def get_llm_client() -> LLMClient:
    global _llm_client
    if _llm_client is None:
        _llm_client = LLMClient()
    return _llm_client


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
# Voice Command Pipeline
# ---------------------------------------------------------------------------


async def handle_voice_command(
    websocket: WebSocket,
    data: dict[str, Any],
) -> None:
    """
    Full voice command pipeline:
      transcript → LLM decomposition → trajectory planning → safety validation → response
    """
    command: str = data.get("command", "").strip()
    scene_data: dict[str, Any] = data.get("scene", {})

    if not command:
        await manager.send_json(websocket, {
            "type": "plan_error",
            "error": "Empty command received",
        })
        return

    logger.info("Voice command: '%s'", command)

    # 1. Send THINKING status
    await manager.send_json(websocket, {
        "type": "status_update",
        "state": "THINKING",
    })

    # 2. Parse scene state from frontend
    try:
        scene = scene_state_from_frontend(scene_data)
    except Exception as exc:
        logger.error("Scene parse error: %s", exc)
        await manager.send_json(websocket, {
            "type": "plan_error",
            "error": f"Failed to parse scene state: {exc}",
        })
        return

    # 3. LLM task decomposition
    await manager.send_json(websocket, {
        "type": "status_update",
        "state": "PLANNING",
    })

    llm = get_llm_client()
    decomposition = await decompose_command(command, scene, llm_client=llm)

    if not decomposition.success:
        logger.warning("Decomposition failed: %s", decomposition.error)
        await manager.send_json(websocket, {
            "type": "plan_error",
            "error": decomposition.error or "Failed to decompose command",
        })
        return

    logger.info("Decomposed into %d actions", len(decomposition.actions))

    # 4. Trajectory planning + safety validation
    await manager.send_json(websocket, {
        "type": "status_update",
        "state": "VALIDATING",
    })

    plan = plan_trajectory(decomposition.actions, scene)

    # 5. Build response with waypoints
    waypoints_list = [
        {
            "x": wp.x,
            "y": wp.y,
            "z": wp.z,
            "roll": wp.roll,
            "pitch": wp.pitch,
            "yaw": wp.yaw,
            "gripper_open": wp.gripper_open,
        }
        for wp in plan.all_waypoints
    ]

    # Build confirmation message from narrations
    if plan.narration_sequence:
        confirmation = "Done. " + ". ".join(plan.narration_sequence) + "."
    else:
        confirmation = "Done."

    await manager.send_json(websocket, {
        "type": "plan_result",
        "plan": plan.to_dict(),
        "waypoints": waypoints_list,
        "confirmation": confirmation,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


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

            if msg_type == "voice_command":
                await handle_voice_command(websocket, data)
            elif msg_type == "ping":
                await manager.send_json(websocket, {"type": "pong"})
            else:
                # Echo for other message types
                await manager.send_json(websocket, {
                    "type": "echo",
                    "original": data,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "server": "kinesys-backend",
                })

    except WebSocketDisconnect:
        manager.disconnect(websocket)
        logger.info("WebSocket cleanly disconnected")
    except Exception:
        manager.disconnect(websocket)
        logger.exception("WebSocket error")
