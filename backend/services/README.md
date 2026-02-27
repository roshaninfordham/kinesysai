# backend/services — Service Layer

The services layer contains stateful runtime services that sit outside the core execution engine and AI layer.

---

## trajectory_recorder.py — Guide Mode Recording

Records real-time hand-guided waypoints during Guide Mode teleoperation and plays them back as a validated trajectory.

### Responsibility

```
GuidePanel (frontend)
    │  {type: "guide_waypoint", x, y, z, gripper_open}
    ▼
app/main.py WebSocket handler
    │
    ▼
TrajectoryRecorder.add_waypoint(x, y, z, gripper_open)
    │  Buffers waypoint in active session
    ▼
{type: "guide_replay", session_id}
    │
    ▼
TrajectoryRecorder.get_trajectory(session_id)
    │  Returns list[Waypoint]
    ▼
Same safety validation + execution pipeline as Command Mode
```

### Session Management

Each recording is assigned a UUID `session_id`. Multiple sessions can coexist in memory, allowing the user to record several trajectories and replay any of them.

```python
recorder = TrajectoryRecorder()

# Start a new recording session
session_id = recorder.start_session()  # returns UUID string

# Add waypoints as they arrive from the frontend
recorder.add_waypoint(session_id, x=0.3, y=0.9, z=0.1, gripper_open=True)
recorder.add_waypoint(session_id, x=0.3, y=0.65, z=0.1, gripper_open=False)

# Stop recording
recorder.stop_session(session_id)

# Retrieve for replay
waypoints: list[Waypoint] = recorder.get_trajectory(session_id)

# Clean up old sessions
recorder.clear_session(session_id)
recorder.clear_all()
```

### `TrajectoryRecorder` Class

```python
class TrajectoryRecorder:
    def start_session(self) -> str              # returns session_id (UUID)
    def stop_session(self, session_id: str) -> None
    def add_waypoint(
        self,
        session_id: str,
        x: float, y: float, z: float,
        roll: float = 0.0, pitch: float = 0.0, yaw: float = 0.0,
        gripper_open: bool = True,
    ) -> None
    def get_trajectory(self, session_id: str) -> list[Waypoint]
    def list_sessions(self) -> list[str]        # all active session IDs
    def clear_session(self, session_id: str) -> None
    def clear_all(self) -> None

    @property
    def active_session_id(self) -> str | None   # currently recording session
```

### Waypoint Deduplication

To avoid flooding the safety validator with redundant waypoints from small hand tremors, `add_waypoint` applies a **dead-band filter**:

- Only saves a new waypoint if the end-effector moved more than **0.005m** (5mm) from the last saved waypoint
- Gripper state changes are always saved regardless of distance

### Session Limits

| Limit | Value |
|-------|-------|
| Max waypoints per session | 500 |
| Max concurrent sessions | 10 |
| Waypoint dead-band | 0.005m |

If the session reaches 500 waypoints, recording continues but older waypoints are dropped (FIFO), keeping the most recent 500.
