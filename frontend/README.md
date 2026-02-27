# Frontend

The KINESYS frontend is a **React 18 + TypeScript** single-page application that renders a physics-accurate 3D robot simulation, handles three distinct teaching modes, and communicates with the backend over a persistent WebSocket connection.

---

## Architecture Overview

```
App.tsx  (root, layout, keyboard shortcuts, mode routing)
  │
  ├── Left Panel (65% width)
  │     ├── ModeSelector          ← tab bar: Command / Teach / Guide
  │     ├── VoicePanel            ← Command mode: STT + send to backend
  │     ├── TeachPanel            ← Teach mode: AR webcam + keyframe recording
  │     └── GuidePanel            ← Guide mode: real-time hand teleoperation
  │
  ├── Right Panel (35% width)
  │     ├── SimulationCanvas      ← Three.js 3D viewport
  │     │     ├── RobotArm        ← 6-DOF arm mesh + IK animation
  │     │     └── SceneObjects    ← Boxes, cylinders, spheres with physics
  │     ├── StatusBar             ← WebSocket status + pipeline state
  │     ├── TrajectoryViz         ← Live waypoint visualization
  │     ├── SafetyPanel           ← Safety validation results
  │     └── ScoreBoard            ← Puzzle timer + score (game mode)
  │
  ├── Overlays
  │     ├── StartupCheck          ← Pre-flight system check on load
  │     ├── ErrorBoundary         ← React error boundary (auto-resets)
  │     └── DemoMode (DemoBadge + DemoToggle)
  │
  └── Game Mode (right panel swap)
        ├── PuzzleSelect          ← Puzzle library browser
        ├── ResultScreen          ← Post-puzzle score + leaderboard entry
        └── Leaderboard           ← High scores per puzzle
```

---

## Directory Structure

```
src/
├── App.tsx                    ← Root component, layout, keyboard shortcuts, mode state
├── index.css                  ← Tailwind directives + custom CSS variables
├── main.tsx                   ← React entry point (StrictMode)
│
├── components/                ← UI components (18 files)
│   ├── SimulationCanvas.tsx   ← Three.js scene setup, camera, lights, render loop
│   ├── RobotArm.tsx           ← 6-DOF arm mesh, IK animation, waypoint playback
│   ├── SceneObjects.tsx       ← Physics-enabled manipulable objects
│   ├── WebcamFeed.tsx         ← Camera stream + AR overlay canvas + hand skeleton
│   ├── VoicePanel.tsx         ← Push-to-talk UI, transcript display, command history
│   ├── TeachPanel.tsx         ← Record/review/execute AR demonstration workflow
│   ├── GuidePanel.tsx         ← Real-time hand teleoperation + trajectory recording
│   ├── ModeSelector.tsx       ← Animated tab bar for mode switching
│   ├── SafetyPanel.tsx        ← Validation results, waypoint list, violation display
│   ├── TrajectoryViz.tsx      ← 2D trajectory path visualization
│   ├── StatusBar.tsx          ← WebSocket + pipeline status indicator
│   ├── ScoreBoard.tsx         ← Puzzle timer, action count, efficiency score
│   ├── PuzzleSelect.tsx       ← Puzzle library grid with difficulty badges
│   ├── ResultScreen.tsx       ← Post-puzzle results + leaderboard submission
│   ├── Leaderboard.tsx        ← High score table per puzzle
│   ├── DemoMode.tsx           ← Demo toggle + cached response service + badge
│   ├── StartupCheck.tsx       ← Pre-flight checks (WebSocket, Ollama, Groq, webcam)
│   └── ErrorBoundary.tsx      ← React error boundary with auto-reset
│
├── engine/                    ← 3D simulation engine
│   ├── armController.ts       ← Arm pose management + waypoint interpolation
│   ├── ikSolver.ts            ← FABRIK inverse kinematics solver
│   └── physics.ts             ← Cannon-es world setup + scene object definitions
│
├── modes/                     ← Teaching mode state machines
│   ├── commandMode.ts         ← Voice command → WebSocket send
│   ├── teachMode.ts           ← Keyframe capture, recording state machine
│   └── guideMode.ts           ← Real-time hand→robot mapping + trajectory recording
│
├── services/                  ← External integrations (singletons)
│   ├── websocketService.ts    ← WebSocket client + reconnection + message queue
│   ├── speechService.ts       ← Web Speech API STT (continuous recognition)
│   ├── ttsService.ts          ← Web Speech Synthesis API TTS
│   └── mediapipeService.ts    ← MediaPipe HandLandmarker (GPU-accelerated)
│
├── hooks/
│   └── useWebSocket.ts        ← React hook wrapping websocketService
│
└── game/
    ├── puzzleConfig.ts        ← Puzzle definitions, initial states, goal conditions
    ├── puzzleEngine.ts        ← Timer, state machine (idle/ready/playing/complete)
    └── scoreCalculator.ts     ← Score formula: time bonus + efficiency
```

---

## Key Components

### `SimulationCanvas.tsx`
Sets up the Three.js scene:
- **Perspective camera** at (0, 2.5, 4), looking at origin
- **Hemisphere light** + **directional light** (shadows enabled)
- **Render loop** via `requestAnimationFrame`
- **Physics world** (`cannon-es`) ticked at 60Hz, synchronized with Three.js
- Renders `RobotArm` and `SceneObjects` as children

### `RobotArm.tsx`
Renders a 6-joint robot arm and animates it through waypoints:
- **Geometry:** 6 `CylinderGeometry` segments + gripper fingers
- **IK:** calls `ikSolver.solve(targetPos)` → joint angles
- **Animation:** interpolates between waypoints at 60fps using `armController`
- **Gripper:** opens/closes based on `Waypoint.gripper_open`
- **Narration:** calls `ttsService.speak()` at each waypoint step

### `WebcamFeed.tsx`
The AR teach mode camera view. Renders:
1. **Video element** — live webcam stream (640×480)
2. **Canvas overlay** (same size, absolute positioned on top):
   - **Table surface grid** — perspective-projected wireframe at `worldY = 0.5`
   - **Virtual scene objects** — Red Cube, Blue Cylinder, Green Sphere, Yellow Box drawn as 3D-looking shapes
   - **Pinch-to-grab** — when hand pinches near a virtual object, it glows + shows `✓ GRABBED`
   - **Hand skeleton** — 21 landmarks + bone connections
   - **AR banner** — `AR TEACH MODE · PINCH objects to grab`

### `TeachPanel.tsx`
Orchestrates the full Teach Mode workflow through 6 phases:

```
IDLE ──► RECORDING ──► SENDING ──► ANALYZING ──► REVIEWING ──► EXECUTING
 │                                                   │
 └───────────── Reset ◄──── ERROR ◄──────────────────┘
```

- **IDLE:** Shows start recording button
- **RECORDING:** Captures keyframes via `teachMode.startRecording()`
- **SENDING:** Sends `{type: "teach_extract", keyframes: [...]}` over WebSocket
- **ANALYZING:** Shows spinner while VLM processes
- **REVIEWING:** Lists extracted actions with confidence bars; user confirms/rejects each
- **EXECUTING:** Sends confirmed actions via `{type: "teach_execute"}`

### `GuidePanel.tsx`
Real-time hand teleoperation:
- Subscribes to `mediapipeService.onHandUpdate()`
- Maps palm center `[0,1]` normalized → robot workspace `[-1.5, 1.5]`
- Pinch gesture → `gripper_open = false`
- Sends `{type: "guide_waypoint"}` over WebSocket at ~10fps when recording
- Record / Stop / Replay controls with session management

---

## Engine Layer

### `ikSolver.ts` — FABRIK IK Solver
Forward-And-Backward Reaching Inverse Kinematics:

```
solve(targetPos: Vector3, jointPositions: Vector3[], linkLengths: number[])
    │
    ▼
Forward pass: reach each joint toward target
    │
    ▼
Backward pass: pull root back to base position
    │
    ▼
Repeat until end-effector within tolerance (0.001m) or max iterations (20)
    │
    ▼
Convert joint positions → Euler angles for Three.js mesh rotation
```

### `armController.ts` — Arm Pose Manager
- Stores current and target joint angles
- `setTarget(waypoint)`: calls IK solver to compute joint angles for waypoint
- `tick(dt)`: interpolates current → target at configurable speed
- `playSequence(waypoints)`: queues waypoints and advances on each completion
- Emits `onStepComplete` callback for TTS narration timing

### `physics.ts` — Physics World
- Creates `cannon-es` World with gravity `(0, -9.82, 0)`
- Defines 4 default scene objects with mass, shape, and initial position
- `SCENE_OBJECTS` array is shared with `SceneObjects.tsx` and `WebcamFeed.tsx` (AR overlay)

---

## Services

### `websocketService.ts` — WebSocket Client

```
WebSocketService singleton
    │
    ├── connect()           Opens ws://localhost:8000/ws
    ├── send(message)       Queues message (sent immediately if connected)
    ├── onMessage(cb)       Subscribe to incoming messages
    ├── onStatusChange(cb)  Subscribe to connection status changes
    └── Reconnection:
          - Exponential backoff: 1s → 2s → 4s → 8s → 10s (max)
          - Infinite retries
          - Message queue drained on reconnect
```

**Connection states:** `connecting` → `connected` → `disconnected` → `reconnecting`

### `speechService.ts` — Speech Recognition

```
SpeechService singleton (Web Speech API)
    │
    ├── start()       Begin continuous recognition
    ├── stop()        End recognition session
    ├── toggle()      Start or stop
    └── onTranscript(cb)    Called with final transcript strings
        onStatus(cb)        Called with status changes
        onError(cb)         Called on recognition errors

Auto-restart: if recognition ends unexpectedly and isListening=true,
              restarts after 500ms
```

### `ttsService.ts` — Text-to-Speech

```
TTSService singleton (Web Speech Synthesis API)
    │
    ├── speak(text)         Queue utterance (cancels current if busy)
    ├── cancel()            Stop all speech
    └── setVoice(name)      Select speech synthesis voice
```

### `mediapipeService.ts` — Hand Tracking

```
MediaPipeService singleton
    │
    ├── startTracking(video?)    Initialize HandLandmarker + start RAF loop
    ├── stopTracking()           Stop RAF loop
    ├── onHandUpdate(cb)         Subscribe to per-frame hand data
    └── HandUpdate {
          timestamp: number,
          hands: [{
            handedness: "Left"|"Right"|"Unknown",
            landmarks: NormalizedLandmark[21],
            palmCenter: {x, y, z},
            pinchDistance: number,      (thumb_tip ↔ index_tip)
            gesture: "PINCH"|"OPEN"     (pinchDistance < 0.06)
          }]
        }

Model: hand_landmarker.task (float16, from mediapipe CDN)
Mode:  VIDEO (per-frame detection, GPU delegate)
```

---

## Modes

### `commandMode.ts`
Thin wrapper connecting `speechService` to `websocketService`:
- Starts/stops speech recognition
- Captures the scene state snapshot from `SimulationCanvas`
- Sends `{type: "voice_command", transcript, scene}` when speech ends

### `teachMode.ts`
State machine for keyframe capture:

```
TeachModeState: { recording, keyframeCount, lastGesture, statusMessage }

startRecording()
    └─► Sets captureTimer (every 500ms)
            └─► captureFrameIfMoved():
                    - draws video frame to offscreen canvas
                    - converts to base64 JPEG (quality 0.7)
                    - only keeps frame if palm moved > MIN_PALM_DELTA (0.02)
                    - stores Keyframe { image: base64, timestamp, palmCenter, gesture }

stopRecording()
    └─► Returns Keyframe[] to TeachPanel for WebSocket submission
```

### `guideMode.ts`
Maps hand position to robot end-effector in real-time:

```
Hand palm center (normalized 0-1)
    │
    ▼
Map to world coordinates:
    x = (palm.x - 0.5) * WORKSPACE_SCALE   (default scale: 2.0)
    y = TABLE_HEIGHT + palm.y * LIFT_SCALE  (lifts up as hand raises)
    z = (palm.z - 0.3) * DEPTH_SCALE

Pinch gesture → gripper_open = false
    │
    ▼
Send {type: "guide_waypoint", x, y, z, gripper_open} over WebSocket
    (throttled to ~10fps via 100ms interval)
```

---

## Game System

### `puzzleConfig.ts`
Defines each puzzle challenge:
```typescript
interface PuzzleConfig {
  id: string
  name: string
  description: string
  difficulty: "easy" | "medium" | "hard"
  timeLimitSec: number
  initialState: SceneObjectState[]   // where objects start
  goalCondition: GoalCondition       // what counts as "solved"
  hints: string[]
}
```

Examples: "Stack by Color", "Sort by Size", "Mirror Arrangement", "Precision Place"

### `puzzleEngine.ts`
Manages puzzle lifecycle:
```
idle → selecting → ready → playing → complete / failed
```
- Tracks elapsed time (countdown)
- Counts user actions
- Evaluates `goalCondition` after each arm step
- Emits `onStateChange` for `ScoreBoard` and `ResultScreen`

### `scoreCalculator.ts`
```
score = timeBonus + efficiencyBonus

timeBonus     = max(0, (timeLimitSec - elapsedSec) / timeLimitSec) * 500
efficiencyBonus = max(0, (optimalActions / actualActions)) * 500

Total max score: 1000
```

---

## Keyboard Shortcuts

Defined in `App.tsx` via a global `keydown` listener:

| Key | Action |
|-----|--------|
| `Space` | Push-to-talk toggle (Command mode) |
| `R` | Reset scene (reloads page) |
| `1` | Switch to Command mode |
| `2` | Switch to Teach mode |
| `3` | Switch to Guide mode |
| `Esc` | Emergency stop (sends `{type: "emergency_stop"}`) |

---

## WebSocket Message Flow

```
Frontend                                Backend
   │                                       │
   │──── {type: "voice_command", ...} ────►│
   │                                       │ LangGraph runs...
   │◄─── {type: "status_update", state: "DECOMPOSING"} ──│
   │◄─── {type: "status_update", state: "PLANNING"} ─────│
   │◄─── {type: "status_update", state: "VALIDATING"} ───│
   │                                       │
   │◄─── {type: "trajectory_ready", waypoints: [...]} ───│
   │                                       │
   │  RobotArm starts animating            │
   │                                       │
   │──── {type: "hitl_confirm", confirmed: true} ────────►│  (if HITL required)
   │                                       │
   │◄─── {type: "execution_step", step: 1, ...} ─────────│
   │◄─── {type: "execution_step", step: 2, ...} ─────────│
   │◄─── {type: "execution_complete"} ───────────────────│
```

---

## Running the Frontend

```bash
# From repo root
make dev-frontend

# Or directly
cd frontend
npm install
npm run dev
```

Frontend runs at **http://localhost:5173** with Vite HMR (hot module replacement).

```bash
# Build for production
npm run build

# Preview production build
npm run preview
```

---

## Environment / Config

No `.env` file needed for the frontend. The backend URL is hardcoded in `websocketService.ts`:

```typescript
const WS_URL = "ws://localhost:8000/ws";
```

To change for production, update this constant or add a `VITE_WS_URL` env variable.
