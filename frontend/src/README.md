# frontend/src — Source Code Reference

Detailed documentation for every file in the React source tree. See [`frontend/README.md`](../README.md) for the higher-level architecture overview.

---

## Entry Points

### `main.tsx`
React entry point. Mounts `<App />` into `#root` wrapped in `StrictMode`.

### `App.tsx`
Root component. Responsibilities:
- **Layout** — two-panel grid: left (mode panels) + right (simulation + status)
- **Mode routing** — `activeMode` state (`"command"` | `"teach"` | `"guide"`)
- **Keyboard shortcuts** — global `keydown` listener (Space, R, 1/2/3, Esc)
- **Startup check** — renders `<StartupCheck>` on first load until pre-flight passes
- **Demo mode** — `<DemoToggle>` in header, `<DemoBadge>` when active
- **Error boundary** — wraps entire app in `<ErrorBoundary>`
- **Scene reset** — `Reset Scene` button reloads the page
- **WebSocket state** — passes `wsService` ref down to panels

---

## components/

### `SimulationCanvas.tsx`
Three.js scene host component.

| Item | Value |
|------|-------|
| Camera | PerspectiveCamera at (0, 2.5, 4), FOV 60° |
| Lighting | HemisphereLight (sky/ground) + DirectionalLight (shadows) |
| Ground plane | PlaneGeometry 10×10, receives shadows |
| Table | BoxGeometry at y=0.25 (visual only, physics from Cannon) |
| Physics | Cannon-es World, gravity (0, -9.82, 0), ticked at 60Hz |
| Render loop | `requestAnimationFrame` → `renderer.render()` + physics step |

Exposes `getSceneState()` for `commandMode.ts` to snapshot current object positions.

---

### `RobotArm.tsx`
6-DOF robot arm visual + kinematics.

**Joint segments:**
```
Base (cylinder, y=0–0.3)
  └─ Link 1 (cylinder, 0.4m)  ← J1: shoulder pitch
       └─ Link 2 (cylinder, 0.35m) ← J2: elbow pitch
            └─ Link 3 (cylinder, 0.25m) ← J3: wrist pitch
                 └─ Link 4 (cylinder, 0.15m) ← J4: wrist roll
                      └─ Gripper (2x box fingers) ← open/close
```

**Waypoint playback:**
1. `armController.playSequence(waypoints)` called by parent
2. Each tick: `armController.tick(dt)` → IK angles for current target
3. Joint meshes `.rotation` updated each frame
4. `onStepComplete(step, narration)` → `ttsService.speak(narration)`

**Gripper animation:** finger `position.x` interpolated ±0.04m over ~0.3s

---

### `SceneObjects.tsx`
Physics-enabled manipulable objects.

- Reads `SCENE_OBJECTS` from `engine/physics.ts`
- Creates Three.js mesh + Cannon-es body per object
- Syncs mesh position/quaternion to physics body each frame
- Handles `execution_step` WebSocket messages to teleport objects when arm grabs/releases
- Supports 3 shapes: `BoxGeometry`, `CylinderGeometry`, `SphereGeometry`

---

### `WebcamFeed.tsx`
Camera stream + AR overlay. See [AR Teach Mode Pipeline](../../README.md#ar-teach-mode-pipeline) for the full flow.

**Canvas drawing layers (back-to-front):**
1. Table surface grid — 7×7 perspective-projected wireframe
2. Virtual objects (4 objects from `AR_SCENE_OBJECTS` constant):
   - Red Cube (box) at world (0.8, 0.65, 0.3)
   - Blue Cylinder at world (-0.5, 0.70, 0.6)
   - Green Sphere at world (0.3, 0.67, -0.5)
   - Yellow Box at world (-0.6, 0.65, -0.3)
3. Grab highlights (glow + `✓ GRABBED` label) on pinched objects
4. Hand skeleton (21 landmarks + bone lines)
5. AR mode banner at top

**Projection function:**
```
project(worldX, worldY, worldZ, canvasW, canvasH)
    camZ = 2.8   // camera distance
    fov  = 0.55
    relZ = camZ - worldZ
    scale = fov * canvasH / relZ
    sx = canvasW/2 + worldX * scale
    sy = canvasH*0.72 - (worldY - 0.5) * scale * 1.1
```

**Grab detection:** For each pinching hand, find closest AR object within 55px → mark as grabbed.

---

### `VoicePanel.tsx`
Command mode UI.

- Push-to-talk button (also activated by Space key)
- Shows live transcript as it updates
- Command history (last 10 commands)
- Sends `{type: "voice_command", transcript, scene}` on speech end
- Handles `status_update` and `error` messages for inline feedback
- Uses `speechService.toggle()` for recognition start/stop

---

### `TeachPanel.tsx`
Orchestrates the full Teach Mode workflow.

**Phase state machine:**
```
IDLE
  └─► [Start Recording] ──► RECORDING
                               └─► [Stop Recording] ──► SENDING
                                                          └─► ANALYZING (spinner)
                                                               ├─► REVIEWING (if success)
                                                               └─► ERROR (if VLM failed)
                                          REVIEWING
                                            └─► [Execute] ──► EXECUTING
                                            └─► [Re-record] ──► IDLE
```

**Key functions:**
- `handleStartRecording()` — calls `teachMode.startRecording()`
- `handleStopRecording()` — calls `teachMode.stopRecording()` → sends `teach_extract` message
- `handleConfirmAction(step, confirmed)` — toggles confirmed/rejected for each action
- `handleExecute()` — sends `teach_execute` with only confirmed actions

**WebSocket messages handled:**
- `teach_extract_result` → transitions to REVIEWING with action list
- `status_update` → updates status text
- `error` → transitions to ERROR phase

---

### `GuidePanel.tsx`
Real-time hand teleoperation UI.

**Recording flow:**
1. Open camera → `WebcamFeed` activates
2. Press Record → `guideMode.startRecording()` → sends `guide_record: true`
3. Move hand → `guide_waypoint` messages sent at ~10fps
4. Press Stop → `guide_record: false` → trajectory saved server-side
5. Press Replay → `guide_replay` message → arm replays recording

**Session management:** Each recording gets a UUID session ID. Multiple sessions can be saved and replayed.

**Hand position mapping:**
```
palmCenter.x [0,1] → robot.x [-1.0, 1.0]   (flipped: camera mirror)
palmCenter.y [0,1] → robot.y [0.5, 2.0]    (table height to top of workspace)
pinchDistance < 0.06 → gripper_open = false
```

---

### `ModeSelector.tsx`
Animated tab bar with 3 tabs (Command / Teach / Guide).
- Active tab highlighted with Tailwind `bg-cyan-500`
- Keyboard shortcuts shown as badge on each tab

---

### `SafetyPanel.tsx`
Displays safety validation results from the backend.

- Shows `SafetyValidationResult` from the `trajectory_ready` message
- Lists each `ConstraintViolation` with severity (ERROR / WARNING)
- Displays velocity, distance, and bounds data per waypoint
- Color coded: red for violations, yellow for warnings, green for pass

---

### `TrajectoryViz.tsx`
2D top-down path visualization.

- SVG canvas showing X-Z plane (top view)
- Waypoints drawn as circles
- Lines connecting consecutive waypoints
- Color gradient: blue (start) → green (end)
- Highlights current executing waypoint in orange

---

### `StatusBar.tsx`
Bottom status strip.

| Section | Contents |
|---------|---------|
| Left | WebSocket status dot (green/red/orange) + connection URL |
| Center | Current pipeline state (IDLE / DECOMPOSING / EXECUTING / etc.) |
| Right | Last message timestamp |

---

### `ScoreBoard.tsx`
Live game score display (only shown in puzzle mode).

- Timer bar (counts down, changes color: green → yellow → red)
- Action counter vs optimal
- Live efficiency percentage
- Puzzle name + difficulty badge

---

### `PuzzleSelect.tsx`
Grid of puzzle cards from `puzzleConfig.ts`.
- Difficulty badges (Easy / Medium / Hard)
- Time limit display
- Hover preview of initial scene state
- `onSelect(puzzleId)` callback to `App.tsx`

---

### `ResultScreen.tsx`
Post-puzzle overlay.

- Final score (animated count-up)
- Time used vs time limit
- Action efficiency breakdown
- "Submit to Leaderboard" form (name entry)
- "Try Again" and "Next Puzzle" buttons

---

### `Leaderboard.tsx`
High score table per puzzle.

- Sorted by score descending
- Top 3 highlighted (gold / silver / bronze)
- Stored in `localStorage` keyed by puzzle ID
- Shows: rank, name, score, time, efficiency

---

### `DemoMode.tsx`
Offline demo system for presentations without a backend.

**`DemoToggle`:** header button to enable/disable demo mode
**`DemoBadge`:** red pulsing badge shown when demo mode is active

When demo mode is on:
- WebSocket sends are intercepted
- Responses come from `backend/demo/cached_responses.json`
- Simulates realistic response delays (500–1500ms)

---

### `StartupCheck.tsx`
Pre-flight system check shown on app load.

Checks (in parallel):
1. **WebSocket** — can connect to `ws://localhost:8000/ws`?
2. **Backend API** — does `GET /api/health` return 200?
3. **LLM** — does health response report an LLM available?
4. **Webcam** — does `getUserMedia` succeed?

- Green checkmarks for passed checks
- Red X with fix hint for failed checks
- "Continue anyway" button after 5s regardless
- Dismissed automatically if all checks pass

---

### `ErrorBoundary.tsx`
React error boundary wrapping the full app.

- Catches render errors in the component tree
- Shows a minimal error screen with the error message
- "Reset App" button calls `window.location.reload()`
- Auto-resets after 10s if no user interaction

---

## engine/

### `ikSolver.ts`
FABRIK (Forward And Backward Reaching Inverse Kinematics) implementation.

```typescript
interface IKResult {
  jointAngles: number[]   // radians per joint
  reachable: boolean      // whether target is within arm reach
  iterations: number      // how many FABRIK iterations ran
}

solve(
  targetPos: THREE.Vector3,
  linkLengths: number[],   // [0.4, 0.35, 0.25, 0.15] for 4 links
  basePos: THREE.Vector3,
  tolerance: number = 0.001,
  maxIterations: number = 20
): IKResult
```

If the target is unreachable (distance > sum of link lengths), the arm reaches as far as possible toward the target and sets `reachable = false`.

### `armController.ts`
Manages arm animation state.

```typescript
class ArmController {
  playSequence(waypoints: Waypoint[]): void
  tick(dt: number): void          // call every frame
  stop(): void
  reset(): void

  // Callbacks
  onStepComplete: (step: number, narration: string) => void
  onSequenceComplete: () => void
}
```

Interpolation: spherical linear interpolation (slerp) for rotations, linear for positions, at 0.5m/s approach speed.

### `physics.ts`
Cannon-es world configuration + default scene objects.

```typescript
const SCENE_OBJECTS = [
  { id: "red_cube",      shape: "box",      color: "#ef4444", position: [0.8, 0.65, 0.3],  size: [0.2, 0.2, 0.2], mass: 0.5 },
  { id: "blue_cylinder", shape: "cylinder", color: "#3b82f6", position: [-0.5, 0.70, 0.6], size: [0.1, 0.3],       mass: 0.3 },
  { id: "green_sphere",  shape: "sphere",   color: "#22c55e", position: [0.3, 0.67, -0.5], size: [0.12],           mass: 0.2 },
  { id: "yellow_box",    shape: "box",      color: "#eab308", position: [-0.6, 0.65, -0.3],size: [0.25, 0.2, 0.2], mass: 0.6 },
]
```

These definitions are shared across `SceneObjects.tsx`, `WebcamFeed.tsx` (AR overlay), and `GuidePanel.tsx` (object labeling).

---

## modes/

### `commandMode.ts`
```typescript
class CommandMode {
  activate(): void         // start speech recognition
  deactivate(): void       // stop speech recognition
  isActive(): boolean
}
```

On speech result: `wsService.send({ type: "voice_command", transcript, scene: canvas.getSceneState() })`

### `teachMode.ts`
```typescript
class TeachMode {
  setVideoSource(video: HTMLVideoElement): void
  startRecording(): void
  stopRecording(): Keyframe[]     // returns captured keyframes
  onHandUpdate(update: HandUpdate): void  // called by WebcamFeed

  getState(): TeachModeState
  onStateChange(cb: (state) => void): () => void
}

interface Keyframe {
  image: string          // base64 JPEG
  timestamp: number      // ms since recording start
  palmCenter: { x: number, y: number } | null
  gesture: string        // "PINCH" | "OPEN" | "NO_HAND"
}
```

Keyframe capture interval: 500ms. Minimum palm movement to capture: 0.02 normalized units.

### `guideMode.ts`
```typescript
class GuideMode {
  startRecording(sessionId: string): void
  stopRecording(): void
  isRecording(): boolean

  onHandUpdate(update: HandUpdate): void  // called every frame

  // World mapping constants
  WORKSPACE_X_SCALE = 2.0   // hand normalized → world meters
  WORKSPACE_Y_MIN   = 0.55  // table surface
  WORKSPACE_Y_MAX   = 2.0   // top of workspace
  LIFT_SCALE        = 1.45  // palm.y → vertical lift
}
```

---

## services/

### `websocketService.ts`
```typescript
class WebSocketService {
  connect(): void
  disconnect(): void
  send(message: object): void           // queued if not connected
  onMessage(cb: MessageHandler): Unsubscribe
  onStatusChange(cb: StatusHandler): Unsubscribe

  status: "connecting" | "connected" | "disconnected" | "reconnecting"
}

// Reconnection config
const INITIAL_RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_DELAY_MS     = 10000  // max 10s between retries
const BACKOFF_MULTIPLIER         = 2.0
```

### `speechService.ts`
```typescript
class SpeechService {
  start(): void
  stop(): void
  toggle(): void
  isListening(): boolean

  onTranscript(cb: (text: string) => void): Unsubscribe
  onStatus(cb: (status: SpeechStatus) => void): Unsubscribe
  onError(cb: (error: string) => void): Unsubscribe
}
```

Uses `window.SpeechRecognition || window.webkitSpeechRecognition`. Language: `en-US`. Mode: `continuous`, `interimResults: true`.

### `ttsService.ts`
```typescript
class TTSService {
  speak(text: string, interrupt?: boolean): void  // default: interrupt=true
  cancel(): void
  setRate(rate: number): void   // 0.5–2.0, default 1.0
  setPitch(pitch: number): void // 0.5–2.0, default 1.0
}
```

### `mediapipeService.ts`
```typescript
class MediaPipeService {
  setVideoElement(video: HTMLVideoElement): void
  startTracking(video?: HTMLVideoElement): Promise<void>
  stopTracking(): void
  onHandUpdate(cb: (update: HandUpdate) => void): Unsubscribe
}

// PINCH_THRESHOLD = 0.06  (normalized landmark distance)
// Landmarks 4 (thumb tip) ↔ 8 (index tip) distance
```

Model loaded from: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`

---

## hooks/

### `useWebSocket.ts`
```typescript
function useWebSocket(): {
  status: WebSocketStatus
  lastMessage: WebSocketMessage | null
  send: (message: object) => void
}
```

React hook wrapper around `websocketService`. Re-renders on status change and new message. Safe to call from any component.

---

## game/

### `puzzleConfig.ts`
Built-in puzzle library. Each puzzle specifies:
- `initialState` — where objects start (overrides physics defaults)
- `goalCondition` — evaluated after each arm action:
  - `type: "stacked"` — object A on top of object B (within tolerance)
  - `type: "sorted"` — objects in order along an axis
  - `type: "placed"` — object at target position (within 0.05m)
  - `type: "mirrored"` — scene matches a mirrored reference state

### `puzzleEngine.ts`
```typescript
class PuzzleEngine {
  startPuzzle(config: PuzzleConfig): void
  stopPuzzle(): void
  checkGoal(sceneState: SceneState): boolean

  onStateChange(cb: (state: PuzzleEngineState) => void): Unsubscribe
}

type PuzzlePhase = "idle" | "ready" | "playing" | "complete" | "failed"
```

Timer uses `performance.now()` for accuracy. Checks goal after every `execution_complete` WebSocket message.

### `scoreCalculator.ts`
```typescript
function calculateScore(result: PuzzleResult): ScoreBreakdown {
  // timeBonus:      500 * max(0, remainingTime / timeLimitSec)
  // efficiencyBonus:500 * max(0, optimalActions / actualActions)
  // total:          timeBonus + efficiencyBonus  (max 1000)
}
```
