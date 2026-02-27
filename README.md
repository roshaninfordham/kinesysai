<div align="center">

# KINESYS

### Teach robots like you teach humans — tell it, show it, or guide it.

[![Python](https://img.shields.io/badge/Python-3.11+-3776ab?logo=python&logoColor=white)](https://www.python.org/)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)](https://react.dev/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.104+-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-156%20passing-brightgreen)](#testing)

**Built at Open Build Manhattan Hackathon**

</div>

---

## The Problem

Programming industrial robots today requires:
- Expensive proprietary software (ROS, vendor IDEs)
- Expert knowledge of kinematics and trajectory planning
- Hours of manual waypoint configuration per task
- Zero tolerance for error — a wrong command can damage hardware

**Result:** robots sit idle, expensive tasks go unautomated, and non-engineers cannot participate in robot programming.

## The Solution

KINESYS is an open-source human-robot interaction platform that lets **anyone** teach a robot new tasks in three natural ways — no robotics expertise needed:

| Mode | How you teach | What happens |
|------|--------------|--------------|
| 🎙️ **Command** | Speak a natural sentence | LLM decomposes it into validated waypoints → executes in simulation |
| 📷 **Teach** | Demonstrate with your hands on camera | VLM watches your AR demonstration → extracts procedure → robot replays it |
| 🖐️ **Guide** | Move your hand in front of webcam | MediaPipe maps your hand to the robot gripper in real-time → record & replay |

Every trajectory goes through a **safety validation engine** before any motion executes. A **LangGraph state machine** guarantees the pipeline never skips validation.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        BROWSER (Frontend)                       │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ SimCanvas    │  │  VoicePanel  │  │    TeachPanel (AR)   │  │
│  │ Three.js     │  │  Web Speech  │  │  Webcam + MediaPipe  │  │
│  │ + Physics    │  │  STT / TTS   │  │  Hand landmarks      │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                      │              │
│         └─────────────────┴──────────────────────┘             │
│                           │ WebSocket (ws://localhost:8000/ws)  │
└───────────────────────────┼─────────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────────┐
│                    BACKEND (FastAPI)                            │
│                           │                                     │
│  ┌────────────────────────▼──────────────────────────────────┐  │
│  │                   LangGraph Pipeline                      │  │
│  │                                                           │  │
│  │  IDLE → LISTENING → DECOMPOSING → SCENE_ANALYZING         │  │
│  │       → PLANNING → VALIDATING ──► HITL? ──► EXECUTING     │  │
│  │                         │                                 │  │
│  │                      ERROR ──► IDLE (auto-recover)        │  │
│  └──────┬─────────────────────────────────────────┬──────────┘  │
│         │                                         │             │
│  ┌──────▼──────────┐                    ┌─────────▼──────────┐  │
│  │   AI Layer      │                    │   Core Engine      │  │
│  │                 │                    │                    │  │
│  │ LLMClient       │                    │ ActionPrimitives   │  │
│  │  Groq (primary) │                    │ TrajectoryPlanner  │  │
│  │  Gemini (backup)│                    │ SafetyValidator    │  │
│  │  Ollama (local) │                    │ StateMachine       │  │
│  │                 │                    │                    │  │
│  │ VLMClient       │                    │ TrajectoryRecorder │  │
│  │  Ollama vision  │                    │                    │  │
│  │                 │                    │                    │  │
│  │ SceneAnalyzer   │                    │                    │  │
│  │ TaskDecomposer  │                    │                    │  │
│  │ ProcExtractor   │                    │                    │  │
│  └─────────────────┘                    └────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Voice Command Pipeline (Command Mode)

```
User speaks
    │
    ▼
Web Speech API (browser STT)
    │  transcript: "put the red cube on top of the blue cylinder"
    ▼
WebSocket → backend /ws
    │
    ▼
LangGraph: LISTENING → DECOMPOSING
    │
    ▼
LLMClient.chat()  [Groq → Gemini → Ollama fallback chain]
    │  Returns JSON action plan:
    │  [ {action: "APPROACH", params: {target: "red_cube"}},
    │    {action: "GRASP",    params: {target: "red_cube"}},
    │    {action: "STACK",    params: {target: "blue_cylinder"}},
    │    {action: "RELEASE",  params: {}} ]
    ▼
TrajectoryPlanner → generates Waypoints per primitive
    │
    ▼
SafetyValidator  (workspace bounds, velocity, collision, table)
    │   PASS ──► EXECUTING
    │   FAIL ──► ERROR with human-readable explanation
    ▼
Waypoints sent back over WebSocket
    │
    ▼
Frontend: RobotArm animates IK-solved joints
          SceneObjects update positions
          TTS narrates each step
```

---

## AR Teach Mode Pipeline

```
User opens Teach tab
    │
    ▼
WebcamFeed activates (getUserMedia)
    │
    ▼
MediaPipe HandLandmarker runs in browser (GPU-accelerated)
    │  21 landmarks per hand @ 30fps
    ▼
Canvas overlay draws:
    ├── Table surface grid (perspective-projected)
    ├── Virtual scene objects (boxes, cylinders, spheres)
    │   └── PINCH gesture near object → "GRABBED" highlight
    └── Hand skeleton (bones + joints)
    │
    ▼
User presses Record → teachMode.startRecording()
    │  Captures keyframe (video frame + palm position + gesture)
    │  every 500ms if hand moved > 0.02 normalized units
    ▼
User presses Stop → keyframes sent to backend
    │
    ▼
VLMClient.analyze_images()  [Ollama: pixtral:12b / llava:13b]
    │  System prompt: teach_extract.txt
    │  Returns: { actions: [...], summary: "...", confidence: [...] }
    ▼
ProcedureExtractor validates each action against PRIMITIVE_REGISTRY
    │  confidence < 0.7 → flagged for human confirmation
    ▼
Frontend: Review panel shows extracted steps
    │  User confirms / rejects individual steps
    ▼
Confirmed actions → teach_execute → same pipeline as Command Mode
```

---

## Guide Mode Pipeline

```
User opens Guide tab
    │
    ▼
WebcamFeed + MediaPipe (same as Teach)
    │
    ▼
guideMode.ts maps palm position → robot end-effector coords
    │  Normalized [0,1] hand → world [-1.5, 1.5] space
    │  Pinch gesture → gripper close/open
    ▼
Real-time waypoints sent over WebSocket every ~100ms
    │
    ▼
Backend: TrajectoryRecorder buffers waypoints
    │
    ▼
User presses Stop → recorded trajectory replayed
    │  Same safety validation as Command Mode
    ▼
Robot arm animates the replayed trajectory
```

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend framework** | React 18 + TypeScript + Vite | UI, state management, build |
| **3D rendering** | Three.js r170 | Robot arm, scene objects, lighting |
| **Physics** | Cannon-es | Rigid body simulation, collision |
| **Styling** | Tailwind CSS | Utility-first responsive design |
| **Hand tracking** | MediaPipe Tasks Vision | 21-point hand landmark detection |
| **Speech-to-text** | Web Speech API (browser) | Continuous voice recognition |
| **Text-to-speech** | Web Speech Synthesis API | Step narration |
| **Backend framework** | FastAPI + Uvicorn | REST API + WebSocket server |
| **LLM (primary)** | Groq API — Llama 4 Scout | Task decomposition, fast inference |
| **LLM (fallback 1)** | Google Gemini API | Automatic fallback if Groq unavailable |
| **LLM (fallback 2)** | Ollama (local) — Llama 3.2 | Fully offline operation |
| **VLM** | Ollama — Pixtral 12B / LLaVA | Keyframe visual analysis |
| **Orchestration** | LangGraph | Stateful AI pipeline with safety gates |
| **IK solver** | Custom FABRIK implementation | Joint angle computation from end-effector pos |

---

## Repository Structure

```
kinesysai/
│
├── 📄 README.md                    ← You are here
├── 📄 Makefile                     ← make dev / make install / make clean
├── 📄 .env.example                 ← Environment variable template (no secrets)
├── 📄 .gitignore
│
├── 📁 frontend/                    ← React + TypeScript UI
│   ├── 📄 README.md                ← Frontend architecture & component guide
│   ├── 📄 index.html
│   ├── 📄 package.json
│   ├── 📄 vite.config.ts
│   └── 📁 src/
│       ├── 📄 README.md            ← Source code guide
│       ├── 📄 App.tsx              ← Root component, layout, keyboard shortcuts
│       ├── 📁 components/          ← All UI components (18 files)
│       ├── 📁 engine/              ← IK solver, arm controller, physics
│       ├── 📁 modes/               ← commandMode, teachMode, guideMode
│       ├── 📁 services/            ← WebSocket, speech, TTS, MediaPipe
│       ├── 📁 hooks/               ← useWebSocket
│       └── 📁 game/                ← Puzzle engine, scoring, leaderboard
│
├── 📁 backend/                     ← Python FastAPI server
│   ├── 📄 README.md                ← Backend architecture & API reference
│   ├── 📄 requirements.txt
│   ├── 📁 app/
│   │   └── 📄 main.py              ← FastAPI app, WebSocket handler, REST endpoints
│   ├── 📁 ai/                      ← AI/ML layer
│   │   ├── 📄 README.md            ← LLM/VLM client docs
│   │   ├── 📄 llm_client.py        ← Groq + Gemini + Ollama with fallback chain
│   │   ├── 📄 vlm_client.py        ← Ollama vision model client
│   │   ├── 📄 task_decomposer.py   ← NL command → action plan
│   │   ├── 📄 scene_analyzer.py    ← Scene graph + spatial relations
│   │   ├── 📄 procedure_extractor.py ← VLM keyframe → action sequence
│   │   └── 📁 prompts/             ← System prompt templates
│   ├── 📁 core/                    ← Robot execution engine
│   │   ├── 📄 README.md            ← Primitives & safety docs
│   │   ├── 📄 action_primitives.py ← 12 parameterized robot actions
│   │   ├── 📄 trajectory_planner.py ← Actions → waypoint sequences
│   │   ├── 📄 safety_validator.py  ← Hard constraint checking
│   │   └── 📄 state_machine.py     ← LangGraph pipeline
│   ├── 📁 services/
│   │   └── 📄 trajectory_recorder.py ← Guide mode recording
│   ├── 📁 demo/
│   │   └── 📄 cached_responses.json ← Pre-cached demo responses
│   └── 📁 tests/                   ← 156 unit tests
│       ├── 📄 test_primitives.py
│       ├── 📄 test_safety.py
│       ├── 📄 test_decomposer.py
│       └── 📄 test_state_machine.py
│
└── 📁 shared/
    ├── 📄 README.md                ← Shared schema docs
    └── 📄 action_types.json        ← Canonical primitive definitions + schemas
```

---

## Quick Start

### Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Python | 3.11+ | Backend runtime |
| Node.js | 18+ | Frontend build |
| npm | 9+ | Package manager |
| Ollama | latest | Optional — for local VLM / offline LLM |

### 1. Clone

```bash
git clone https://github.com/roshaninfordham/kinesysai.git
cd kinesysai
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and add your API keys:

```env
# Get free at https://console.groq.com
GROQ_API_KEY=your_groq_api_key_here

# Get free at https://aistudio.google.com
GEMINI_API_KEY=your_gemini_api_key_here

# Optional — local Ollama for offline use
OLLAMA_HOST=http://localhost:11434
```

> ⚠️ **Never commit `.env`** — it is gitignored. Only `.env.example` is committed.

### 3. Install dependencies

```bash
make install
```

### 4. Start development servers

```bash
make dev
```

| Service | URL | Notes |
|---------|-----|-------|
| Frontend | http://localhost:5173 | React dev server with HMR |
| Backend | http://localhost:8000 | FastAPI + WebSocket |
| API Docs | http://localhost:8000/docs | Auto-generated Swagger UI |
| Health | http://localhost:8000/api/health | System status endpoint |

### Optional: Offline / Local LLM

```bash
# Install Ollama
brew install ollama   # macOS
# or: https://ollama.com/download

# Start Ollama service
ollama serve

# Pull models (text LLM + vision model)
ollama pull llama3.2:3b       # Lightweight text LLM (~2GB)
ollama pull llava:13b          # Vision model for Teach mode (~8GB)
```

With Ollama running and models pulled, KINESYS works **100% offline** — no API keys needed.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Push-to-talk (hold while speaking) |
| `R` | Reset scene |
| `1` | Switch to Command mode |
| `2` | Switch to Teach mode |
| `3` | Switch to Guide mode |
| `Esc` | Emergency stop |

---

## Action Primitives

12 parameterized robot actions, each with waypoint generation, safety validation, and TTS narration:

```
APPROACH   Move end-effector near a target
GRASP      Close gripper on a target object
RELEASE    Open gripper to release held object
TRANSLATE  Move to absolute or relative position
ROTATE     Rotate around X/Y/Z axis by N degrees
PLACE      Place held object at position or on target
PUSH       Push an object in a direction
POUR       Tilt a container to pour contents
STACK      Place held object on top of another
SORT       Arrange multiple objects by criterion
INSPECT    Move to observe a target (VLM capture)
WAIT       Pause for duration or condition
```

Full parameter schemas are in [`shared/action_types.json`](shared/action_types.json).

---

## Testing

```bash
cd backend
python3 -m pytest tests/ -v
```

**156 tests** across 4 test suites:

| Suite | Tests | Coverage |
|-------|-------|---------|
| `test_primitives.py` | 40 | All 12 action primitives, waypoint generation, per-primitive validation |
| `test_safety.py` | 36 | Workspace bounds, velocity limits, table collision, obstacle clearance |
| `test_decomposer.py` | 40 | LLM prompt construction, JSON parsing, retry logic |
| `test_state_machine.py` | 40 | LangGraph nodes, HITL gate, ERROR recovery, full pipeline |

---

## LLM Fallback Chain

KINESYS works even when API services are unavailable:

```
Voice command received
        │
        ▼
   GROQ_API_KEY set?  ──YES──► Try Groq (Llama 4 Scout)
        │                           │ rate limit / error?
        │                           ▼
        │                      Try Groq fallback model
        │                           │ still failing?
        │                           ▼
        NO                     ─────┘
        │
        ▼
  GEMINI_API_KEY set?  ─YES──► Try Gemini (gemini-2.5-flash-lite)
        │                           │ error?
        NO                          ▼
        │                      falling back...
        │                           │
        └───────────────────────────┘
                    │
                    ▼
           Ollama running?  ─YES──► Try Ollama (llama3.2:3b)
                    │
                    NO
                    │
                    ▼
           RuntimeError with diagnostic message
           (lists which keys are missing / services down)
```

---

## Gamification

KINESYS includes a built-in puzzle challenge system:

- **Puzzle Library** — pre-defined robotic manipulation challenges (stack by color, sort by size, mirror arrangement, etc.)
- **Live Timer** — countdown per puzzle
- **Scoring** — time bonus + efficiency score based on action count
- **Leaderboard** — persistent high-score board per puzzle

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Run tests: `cd backend && python3 -m pytest tests/ -v`
4. Commit with a descriptive message
5. Open a pull request

---

## License

MIT — built for the Open Build Manhattan hackathon. Free to use, modify, and distribute.
