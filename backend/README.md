# Backend

The KINESYS backend is a **Python FastAPI server** that receives commands over WebSocket, runs them through a LangGraph AI pipeline, validates the resulting trajectory against safety constraints, and streams execution steps back to the frontend.

---

## Architecture Overview

```
frontend (browser)
      │  WebSocket ws://localhost:8000/ws
      ▼
┌─────────────────────────────────────────────────────┐
│                   app/main.py                       │
│  FastAPI app + WebSocket handler + REST endpoints   │
│                                                     │
│  Incoming message types:                            │
│    voice_command  → Command Mode pipeline           │
│    teach_extract  → Teach Mode VLM extraction       │
│    teach_execute  → Teach Mode execution            │
│    guide_waypoint → Guide Mode real-time teleoperation│
│    guide_record   → Start/stop trajectory recording │
│    guide_replay   → Replay recorded trajectory      │
│    scene_update   → Update scene state from frontend│
│    hitl_confirm   → Human confirmation response     │
└────────────┬────────────────────────────────────────┘
             │
    ┌────────▼────────┐
    │  LangGraph SM   │   core/state_machine.py
    │  IDLE           │
    │  → LISTENING    │
    │  → DECOMPOSING  │──► ai/task_decomposer.py  → ai/llm_client.py
    │  → SCENE_ANALYZING──► ai/scene_analyzer.py
    │  → PLANNING     │──► core/trajectory_planner.py
    │  → VALIDATING   │──► core/safety_validator.py
    │  → HITL_GATE    │   (requires confirmation if >5 wps or high velocity)
    │  → EXECUTING    │
    │  → CONFIRMING   │
    │  → ERROR        │──► auto-recovers to IDLE
    └─────────────────┘
             │
    ┌────────▼────────┐
    │ Action Engine   │   core/action_primitives.py
    │  12 primitives  │
    │  Waypoint gen   │
    └─────────────────┘
```

---

## Directory Structure

```
backend/
├── app/
│   └── main.py               ← Entry point: FastAPI app, all WebSocket/REST handlers
├── ai/
│   ├── llm_client.py         ← LLM abstraction: Groq + Gemini + Ollama fallback chain
│   ├── vlm_client.py         ← Vision LLM: Ollama Pixtral/LLaVA for image analysis
│   ├── task_decomposer.py    ← NL command → JSON action plan via LLM
│   ├── scene_analyzer.py     ← Scene JSON → SceneGraph + spatial relations
│   ├── procedure_extractor.py ← Keyframe images → validated action sequence via VLM
│   └── prompts/              ← System prompt text files
│       ├── task_decompose.txt
│       └── teach_extract.txt
├── core/
│   ├── action_primitives.py  ← 12 ActionPrimitive classes + PRIMITIVE_REGISTRY
│   ├── trajectory_planner.py ← Actions → Waypoints → TrajectoryPlan
│   ├── safety_validator.py   ← Hard constraint engine (bounds, velocity, collision)
│   └── state_machine.py      ← LangGraph pipeline definition + node functions
├── services/
│   └── trajectory_recorder.py ← Guide mode: record + replay waypoint sequences
├── demo/
│   └── cached_responses.json  ← Pre-cached LLM responses for demo/offline use
├── tests/
│   ├── test_primitives.py     ← 40 tests for all 12 action primitives
│   ├── test_safety.py         ← 36 tests for safety constraint engine
│   ├── test_decomposer.py     ← 40 tests for LLM decomposition pipeline
│   └── test_state_machine.py  ← 40 tests for LangGraph state machine
└── requirements.txt
```

---

## app/main.py — Entry Point

The FastAPI application. All real-time communication happens over a single **WebSocket** connection per client.

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health check + version info |
| `GET` | `/api/health` | System status (LLM providers, Ollama connectivity) |
| `GET` | `/api/primitives` | List all 12 action primitives with schemas |
| `GET` | `/api/primitives/{id}` | Schema for a specific primitive |
| `GET` | `/api/scene` | Current scene state snapshot |
| `POST` | `/api/command` | Submit a voice command via REST (alternative to WebSocket) |
| `WebSocket` | `/ws` | Full-duplex real-time channel |

### WebSocket Message Protocol

All messages are JSON. Every message has a `type` field.

**Inbound (frontend → backend):**

```jsonc
// Voice command
{"type": "voice_command", "transcript": "put the red cube on the yellow box", "scene": {...}}

// Teach mode: send keyframes for VLM analysis
{"type": "teach_extract", "keyframes": [{"image": "base64...", "timestamp": 1234}], "confidence_threshold": 0.7}

// Teach mode: execute confirmed actions
{"type": "teach_execute", "actions": [...], "scene": {...}}

// Guide mode: real-time hand position
{"type": "guide_waypoint", "x": 0.3, "y": 0.8, "z": 0.1, "gripper_open": false}

// Guide mode: start/stop recording
{"type": "guide_record", "recording": true}

// Guide mode: replay recorded trajectory
{"type": "guide_replay", "session_id": "abc123"}

// Human confirmation for HITL gate
{"type": "hitl_confirm", "confirmed": true}
```

**Outbound (backend → frontend):**

```jsonc
// Pipeline status updates
{"type": "status_update", "state": "DECOMPOSING", "message": "Analyzing your command..."}

// Trajectory ready to execute
{"type": "trajectory_ready", "waypoints": [...], "narration": [...], "safety": {...}}

// Execution step
{"type": "execution_step", "step": 2, "action": "GRASP", "waypoint": {...}, "narration": "Grasping red cube"}

// HITL confirmation request
{"type": "hitl_required", "reason": "Trajectory has 8 waypoints", "waypoints": [...]}

// Teach extraction result
{"type": "teach_extract_result", "actions": [...], "summary": "...", "objects_detected": [...]}

// Error
{"type": "error", "message": "No LLM available. Set GROQ_API_KEY or run Ollama."}
```

---

## LangGraph State Machine

See [`core/README.md`](core/README.md) for detailed state machine documentation.

**Node sequence:**

```
IDLE
 └─► LISTENING        Validate transcript is non-empty
      └─► DECOMPOSING  LLM call: transcript → action_plan JSON
           └─► SCENE_ANALYZING  Build SceneGraph from frontend state
                └─► PLANNING    TrajectoryPlanner: actions → waypoints
                     └─► VALIDATING  SafetyValidator: hard constraint checks
                          ├─► (safe + no HITL) ──► EXECUTING
                          ├─► (safe + HITL required) ──► await confirmation
                          │        └─► (confirmed) ──► EXECUTING
                          └─► (unsafe) ──► ERROR ──► IDLE
```

**HITL (Human-in-the-Loop) triggers:**
- Trajectory has > 5 waypoints
- Any waypoint velocity exceeds 80% of `max_linear_velocity_mps`

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GROQ_API_KEY` | No* | — | Groq API key for Llama 4 Scout |
| `GEMINI_API_KEY` | No* | — | Google Gemini API key (fallback) |
| `OLLAMA_HOST` | No | `http://localhost:11434` | Ollama server URL (fallback) |
| `BACKEND_HOST` | No | `0.0.0.0` | Bind address |
| `BACKEND_PORT` | No | `8000` | Bind port |

\* At least one LLM source is required (Groq, Gemini, or Ollama running locally).

---

## Running the Backend

```bash
# From repo root
make dev-backend

# Or directly
cd backend
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Running Tests

```bash
cd backend
python3 -m pytest tests/ -v                    # all 156 tests
python3 -m pytest tests/test_safety.py -v      # safety only
python3 -m pytest tests/ -v --tb=short -q      # compact output
```

| Test file | Count | What it tests |
|-----------|-------|---------------|
| `test_primitives.py` | 40 | Waypoint generation for all 12 primitives, per-primitive validation, edge cases |
| `test_safety.py` | 36 | Workspace bounds (X/Y/Z), velocity limits, table collision, obstacle clearance, multi-violation scenarios |
| `test_decomposer.py` | 40 | Prompt building, JSON parsing, retry on malformed output, temperature escalation |
| `test_state_machine.py` | 40 | Each node, HITL gate conditions, ERROR → IDLE recovery, full end-to-end pipeline |

---

## Safety Constraints

All trajectories are rejected if they violate any hard constraint:

| Constraint | Default | Description |
|------------|---------|-------------|
| `workspace_bounds` | X/Y/Z: ±1.5m, Y: 0–3m | End-effector must stay in box |
| `table_collision` | y ≥ 0.49m | Must not go below table surface |
| `max_linear_velocity` | 2.5 m/s | Velocity between waypoints (dist / assumed_dt) |
| `max_angular_velocity` | 180 °/s | Angular change between waypoints |
| `max_waypoint_distance` | 3.0 m | Single move cannot exceed this distance |
| `min_obstacle_clearance` | 0.02 m | Warning (not error) if within 2cm of any object |

`assumed_dt = 2.0s` — each waypoint-to-waypoint move is assumed to take 2 seconds.

---

## Dependencies

```
fastapi          WebSocket + REST framework
uvicorn          ASGI server
httpx            Async HTTP for Groq, Gemini, Ollama APIs
groq             Official Groq Python SDK
python-dotenv    .env file loading
langgraph        Stateful AI pipeline orchestration
langchain-core   LangGraph dependency
pydantic         Data validation
pytest           Testing framework
```
