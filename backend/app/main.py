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
from ai.vlm_client import VLMClient
from ai.procedure_extractor import extract_procedure
from core.trajectory_planner import plan_trajectory
from core.action_primitives import PRIMITIVE_REGISTRY
from services.trajectory_recorder import get_recorder, remove_recorder

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
# VLM Client (singleton, lazy-init)
# ---------------------------------------------------------------------------

_vlm_client: VLMClient | None = None


def get_vlm_client() -> VLMClient:
    global _vlm_client
    if _vlm_client is None:
        _vlm_client = VLMClient()
    return _vlm_client


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
# Teach Mode — VLM Procedural Extraction
# ---------------------------------------------------------------------------


async def handle_teach_extract(
    websocket: WebSocket,
    data: dict[str, Any],
) -> None:
    """
    Teach extraction pipeline:
      keyframe images → VLM analysis → validated action sequence
    """
    keyframes = data.get("keyframes", [])

    if not keyframes:
        await manager.send_json(websocket, {
            "type": "teach_extract_error",
            "error": "No keyframes received",
        })
        return

    # Extract base64 images from keyframe objects
    images_b64: list[str] = []
    for kf in keyframes:
        img = kf.get("imageBase64", "") if isinstance(kf, dict) else str(kf)
        if img:
            images_b64.append(img)

    if len(images_b64) < 2:
        await manager.send_json(websocket, {
            "type": "teach_extract_error",
            "error": f"Need at least 2 keyframe images, got {len(images_b64)}",
        })
        return

    logger.info("Teach extract: processing %d keyframes", len(images_b64))

    # Send processing status
    await manager.send_json(websocket, {
        "type": "status_update",
        "state": "ANALYZING",
    })

    vlm = get_vlm_client()
    confidence_threshold = float(data.get("confidence_threshold", 0.7))
    result = await extract_procedure(
        images_base64=images_b64,
        vlm_client=vlm,
        confidence_threshold=confidence_threshold,
    )

    if not result.success:
        logger.warning("Teach extraction failed: %s", result.error)
        await manager.send_json(websocket, {
            "type": "teach_extract_error",
            "error": result.error or "Extraction failed",
        })
        return

    logger.info(
        "Teach extraction: %d actions, %d need confirmation",
        len(result.actions),
        sum(1 for a in result.actions if a.needs_confirmation),
    )

    await manager.send_json(websocket, {
        "type": "teach_extract_result",
        "actions": [a.to_dict() for a in result.actions],
        "summary": result.summary,
        "objects_detected": result.objects_detected,
        "frame_count": result.frame_count,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


async def handle_teach_execute(
    websocket: WebSocket,
    data: dict[str, Any],
) -> None:
    """
    Execute confirmed teach actions through the trajectory planner.
    Receives user-confirmed actions and sends them to plan_trajectory.
    """
    confirmed_actions = data.get("actions", [])
    scene_data = data.get("scene", {})

    if not confirmed_actions:
        await manager.send_json(websocket, {
            "type": "teach_execute_error",
            "error": "No confirmed actions to execute",
        })
        return

    logger.info("Teach execute: %d confirmed actions", len(confirmed_actions))

    # Parse scene
    try:
        scene = scene_state_from_frontend(scene_data)
    except Exception as exc:
        logger.error("Scene parse error: %s", exc)
        await manager.send_json(websocket, {
            "type": "teach_execute_error",
            "error": f"Failed to parse scene state: {exc}",
        })
        return

    await manager.send_json(websocket, {
        "type": "status_update",
        "state": "PLANNING",
    })

    # Convert confirmed actions to trajectory planner format
    planner_actions = []
    for action in confirmed_actions:
        planner_actions.append({
            "action": action.get("action", ""),
            "params": action.get("params", {}),
        })

    plan = plan_trajectory(planner_actions, scene)

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

    if plan.narration_sequence:
        confirmation = "Executing taught procedure. " + ". ".join(plan.narration_sequence) + "."
    else:
        confirmation = "Executing taught procedure."

    await manager.send_json(websocket, {
        "type": "plan_result",
        "plan": plan.to_dict(),
        "waypoints": waypoints_list,
        "confirmation": confirmation,
        "source": "teach_mode",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


# ---------------------------------------------------------------------------
# Guide Mode — Trajectory Record & Replay
# ---------------------------------------------------------------------------


async def handle_guide_record(
    websocket: WebSocket,
    data: dict[str, Any],
    connection_id: str,
) -> None:
    """
    Store a hand-teleoperation trajectory received from the frontend.
    Expects: { type, trajectory_id, points: [{timestamp_ms, x, y, z, gripper_open}], metadata }
    """
    trajectory_id: str = data.get("trajectory_id", f"traj_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}")
    points_raw: list[dict[str, Any]] = data.get("points", [])
    metadata: dict[str, Any] = data.get("metadata", {})

    if not points_raw:
        await manager.send_json(websocket, {
            "type": "guide_record_error",
            "error": "No trajectory points received",
        })
        return

    recorder = get_recorder(connection_id)
    traj = recorder.record(trajectory_id, points_raw, metadata)

    logger.info(
        "Guide trajectory recorded: id=%s, points=%d, duration=%.1fs",
        traj.id, traj.point_count, traj.duration_ms / 1000,
    )

    await manager.send_json(websocket, {
        "type": "guide_record_saved",
        "trajectory_id": traj.id,
        "point_count": traj.point_count,
        "duration_ms": traj.duration_ms,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


async def handle_guide_replay(
    websocket: WebSocket,
    data: dict[str, Any],
    connection_id: str,
) -> None:
    """
    Replay the stored trajectory, streaming waypoints back to the frontend
    at the original recorded timestamps.
    Expects: { type, trajectory_id?, speed_multiplier? }
    """
    trajectory_id: str | None = data.get("trajectory_id")
    speed_multiplier: float = float(data.get("speed_multiplier", 1.0))
    speed_multiplier = max(0.1, min(10.0, speed_multiplier))  # clamp to sane range

    recorder = get_recorder(connection_id)

    async def send_fn(msg: dict[str, Any]) -> None:
        await manager.send_json(websocket, msg)

    await recorder.start_replay_task(send_fn, trajectory_id, speed_multiplier)


async def handle_guide_replay_cancel(
    websocket: WebSocket,
    connection_id: str,
) -> None:
    """Cancel any active replay for this connection."""
    recorder = get_recorder(connection_id)
    recorder.cancel_replay()
    await manager.send_json(websocket, {
        "type": "guide_replay_cancelled",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


# ---------------------------------------------------------------------------
# WebSocket Endpoint
# ---------------------------------------------------------------------------


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)

    # Use the websocket object id as connection key
    connection_id = str(id(websocket))

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
            elif msg_type == "teach_extract":
                await handle_teach_extract(websocket, data)
            elif msg_type == "teach_execute":
                await handle_teach_execute(websocket, data)
            elif msg_type == "guide_record":
                await handle_guide_record(websocket, data, connection_id)
            elif msg_type == "guide_replay":
                await handle_guide_replay(websocket, data, connection_id)
            elif msg_type == "guide_replay_cancel":
                await handle_guide_replay_cancel(websocket, connection_id)
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
        remove_recorder(connection_id)
        manager.disconnect(websocket)
        logger.info("WebSocket cleanly disconnected")
    except Exception:
        remove_recorder(connection_id)
        manager.disconnect(websocket)
        logger.exception("WebSocket error")
