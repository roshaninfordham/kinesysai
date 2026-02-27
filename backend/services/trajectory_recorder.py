"""
KINESYS — Trajectory Recorder Service

Stores hand-teleoperation trajectories captured in Guide Mode and can
replay them by streaming waypoints back to the frontend at the recorded
timestamps (preserving the original timing).

Each trajectory is a list of TrajectoryPoint objects:
  { timestamp_ms, x, y, z, gripper_open }

The recorder keeps the most recent trajectory in memory (one per
WebSocket connection) and supports replay over the same connection.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("kinesys.trajectory_recorder")

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class TrajectoryPoint:
    """A single recorded pose in the teleoperation trajectory."""

    timestamp_ms: int
    """Wall-clock timestamp at capture, in milliseconds."""

    x: float
    y: float
    z: float
    gripper_open: bool

    def to_dict(self) -> Dict[str, Any]:
        return {
            "timestamp_ms": self.timestamp_ms,
            "x": self.x,
            "y": self.y,
            "z": self.z,
            "gripper_open": self.gripper_open,
        }


@dataclass
class Trajectory:
    """A complete recorded trajectory from one Guide Mode session."""

    id: str
    points: List[TrajectoryPoint] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def duration_ms(self) -> int:
        """Total duration in milliseconds."""
        if len(self.points) < 2:
            return 0
        return self.points[-1].timestamp_ms - self.points[0].timestamp_ms

    @property
    def point_count(self) -> int:
        return len(self.points)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "duration_ms": self.duration_ms,
            "point_count": self.point_count,
            "metadata": self.metadata,
        }


# ---------------------------------------------------------------------------
# Recorder
# ---------------------------------------------------------------------------

SendFn = Callable[[Dict[str, Any]], asyncio.Future]


class TrajectoryRecorder:
    """
    Per-connection trajectory recorder and replayer.

    One instance should be created per active WebSocket connection.
    """

    def __init__(self, connection_id: str) -> None:
        self.connection_id = connection_id
        self._trajectories: Dict[str, Trajectory] = {}
        self._latest_id: Optional[str] = None
        self._replay_task: Optional[asyncio.Task] = None

    # -----------------------------------------------------------------------
    # Ingest
    # -----------------------------------------------------------------------

    def record(
        self,
        trajectory_id: str,
        points_raw: List[Dict[str, Any]],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Trajectory:
        """
        Store a trajectory received from the frontend.

        Args:
            trajectory_id: Unique identifier for this trajectory.
            points_raw: List of dicts with keys: timestamp_ms, x, y, z, gripper_open.
            metadata: Optional metadata (fps, filter config, etc.)

        Returns:
            The stored Trajectory object.
        """
        points: List[TrajectoryPoint] = []
        for raw in points_raw:
            try:
                points.append(
                    TrajectoryPoint(
                        timestamp_ms=int(raw["timestamp_ms"]),
                        x=float(raw["x"]),
                        y=float(raw["y"]),
                        z=float(raw["z"]),
                        gripper_open=bool(raw.get("gripper_open", True)),
                    )
                )
            except (KeyError, TypeError, ValueError) as exc:
                logger.warning("Skipping malformed trajectory point: %s — %s", raw, exc)

        traj = Trajectory(
            id=trajectory_id,
            points=points,
            metadata=metadata or {},
        )
        self._trajectories[trajectory_id] = traj
        self._latest_id = trajectory_id

        logger.info(
            "Recorded trajectory '%s': %d points, %.1fs duration",
            trajectory_id,
            traj.point_count,
            traj.duration_ms / 1000,
        )
        return traj

    def get_trajectory(self, trajectory_id: Optional[str] = None) -> Optional[Trajectory]:
        """Retrieve a trajectory by ID, or the latest if ID is None."""
        tid = trajectory_id or self._latest_id
        return self._trajectories.get(tid) if tid else None

    def list_trajectories(self) -> List[Dict[str, Any]]:
        return [t.to_dict() for t in self._trajectories.values()]

    # -----------------------------------------------------------------------
    # Replay
    # -----------------------------------------------------------------------

    async def replay(
        self,
        send_fn: SendFn,
        trajectory_id: Optional[str] = None,
        speed_multiplier: float = 1.0,
    ) -> None:
        """
        Replay a recorded trajectory by streaming waypoints to the frontend
        at the original recorded timestamps.

        Args:
            send_fn: Async callable that sends a JSON dict over WebSocket.
            trajectory_id: Which trajectory to replay (defaults to latest).
            speed_multiplier: 1.0 = real-time, 2.0 = double speed, 0.5 = half speed.
        """
        traj = self.get_trajectory(trajectory_id)
        if traj is None:
            await send_fn({
                "type": "guide_replay_error",
                "error": "No trajectory available to replay",
            })
            return

        if traj.point_count < 2:
            await send_fn({
                "type": "guide_replay_error",
                "error": "Trajectory too short to replay",
            })
            return

        logger.info(
            "Replaying trajectory '%s': %d points at %.1fx speed",
            traj.id, traj.point_count, speed_multiplier,
        )

        await send_fn({
            "type": "guide_replay_start",
            "trajectory_id": traj.id,
            "point_count": traj.point_count,
            "duration_ms": traj.duration_ms,
            "speed_multiplier": speed_multiplier,
        })

        start_real = asyncio.get_event_loop().time()
        origin_ms = traj.points[0].timestamp_ms

        for i, point in enumerate(traj.points):
            # Compute when this point should be emitted relative to start
            relative_ms = point.timestamp_ms - origin_ms
            scheduled_real = start_real + (relative_ms / 1000) / speed_multiplier

            # Wait until scheduled time
            now = asyncio.get_event_loop().time()
            wait = scheduled_real - now
            if wait > 0:
                await asyncio.sleep(wait)

            await send_fn({
                "type": "guide_replay_waypoint",
                "index": i,
                "total": traj.point_count,
                "x": point.x,
                "y": point.y,
                "z": point.z,
                "gripper_open": point.gripper_open,
                "timestamp_ms": point.timestamp_ms,
            })

        await send_fn({
            "type": "guide_replay_done",
            "trajectory_id": traj.id,
            "points_sent": traj.point_count,
        })
        logger.info("Replay complete for trajectory '%s'", traj.id)

    def cancel_replay(self) -> None:
        """Cancel any active replay task."""
        if self._replay_task and not self._replay_task.done():
            self._replay_task.cancel()
            self._replay_task = None
            logger.info("Replay cancelled for connection '%s'", self.connection_id)

    async def start_replay_task(
        self,
        send_fn: SendFn,
        trajectory_id: Optional[str] = None,
        speed_multiplier: float = 1.0,
    ) -> None:
        """Launch replay as a background asyncio task."""
        self.cancel_replay()

        async def _run() -> None:
            try:
                await self.replay(send_fn, trajectory_id, speed_multiplier)
            except asyncio.CancelledError:
                await send_fn({
                    "type": "guide_replay_cancelled",
                })
            except Exception as exc:
                logger.exception("Replay task error")
                try:
                    await send_fn({
                        "type": "guide_replay_error",
                        "error": str(exc),
                    })
                except Exception:
                    pass

        self._replay_task = asyncio.create_task(_run())


# ---------------------------------------------------------------------------
# Global registry — one recorder per connection ID
# ---------------------------------------------------------------------------

_recorders: Dict[str, TrajectoryRecorder] = {}


def get_recorder(connection_id: str) -> TrajectoryRecorder:
    """Get or create the TrajectoryRecorder for a given connection ID."""
    if connection_id not in _recorders:
        _recorders[connection_id] = TrajectoryRecorder(connection_id)
    return _recorders[connection_id]


def remove_recorder(connection_id: str) -> None:
    """Clean up the recorder when a connection closes."""
    if connection_id in _recorders:
        _recorders[connection_id].cancel_replay()
        del _recorders[connection_id]
