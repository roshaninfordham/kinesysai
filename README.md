# KINESYS — Human-Robot Interaction Platform

**Teach robots like you teach humans: tell it, show it, or guide it.**

KINESYS is an open-source platform that lets anyone teach a robotic system new tasks through natural voice commands, webcam demonstrations, or real-time hand gesture teleoperation. The AI watches, learns, and replays tasks autonomously in a physics-accurate 3D simulation — all at zero cost on a standard laptop.

## Three Teaching Modes

| Mode | Method | How It Works |
|------|--------|--------------|
| **Command** | Voice | Speak a natural language instruction → LLM decomposes into subtasks → executes in simulation |
| **Teach** | Webcam | Demonstrate a manipulation on camera → VLM extracts procedure → robot replays autonomously |
| **Guide** | Hand Gestures | MediaPipe maps your hand to the robot's gripper in real-time → record & replay trajectories |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18 + TypeScript + Tailwind CSS + Vite |
| 3D Engine | Three.js r170 + Cannon-es (physics) |
| Backend | Python 3.11 + FastAPI + WebSockets |
| STT | Whisper Large v3 (Groq free tier) |
| LLM | Llama 4 Scout 8B (Groq free tier) |
| VLM | Pixtral 12B / LLaVA (Ollama local) |
| Hand Tracking | MediaPipe Hands (browser) |
| TTS | Web Speech Synthesis API |
| Orchestration | LangGraph state machine |

## Project Structure

```
kinesysai/
├── frontend/                  # React + Three.js UI
│   ├── src/
│   │   ├── components/        # SimulationCanvas, RobotArm, SceneObjects
│   │   ├── engine/            # IK solver, arm controller, physics config
│   │   ├── hooks/             # useWebSocket
│   │   └── services/          # WebSocket client service
│   └── package.json
├── backend/                   # FastAPI server
│   ├── app/main.py            # WebSocket endpoint, REST API
│   ├── core/
│   │   ├── action_primitives.py   # 12 parameterized robot actions
│   │   ├── safety_validator.py    # Constraint engine (bounds, collision, velocity)
│   │   └── trajectory_planner.py  # LLM actions → validated waypoint sequences
│   ├── tests/                 # 80 unit tests
│   └── requirements.txt
├── shared/
│   └── action_types.json      # Shared primitive definitions with parameter schemas
├── Makefile                   # `make dev` starts both services
└── .env.example               # Environment configuration template
```

## Quick Start

```bash
# 1. Clone and enter the project
git clone <repo-url> && cd kinesysai

# 2. Copy environment config
cp .env.example .env

# 3. Install dependencies
make install

# 4. Start both frontend and backend
make dev
```

- **Frontend:** http://localhost:5173
- **Backend:** http://localhost:8000
- **API docs:** http://localhost:8000/docs

## Action Primitives

12 parameterized robot actions, each with waypoint generators, safety validators, and TTS narration:

`APPROACH` · `GRASP` · `RELEASE` · `TRANSLATE` · `ROTATE` · `PLACE` · `PUSH` · `POUR` · `STACK` · `SORT` · `INSPECT` · `WAIT`

## Running Tests

```bash
cd backend && python3 -m pytest tests/ -v
```

## License

Open source — built for the Open Build Manhattan hackathon.
