/**
 * KINESYS — Guide Mode Controller
 *
 * Maps real-time hand movements from mediapipeService directly to the
 * simulated robot arm, enabling hand teleoperation.
 *
 * Features:
 *   - Palm center (normalized 0–1) → arm workspace (configurable bounds)
 *   - Exponential Moving Average filter (alpha=0.3) for smoothing
 *   - Pinch distance → gripper: <0.05 → CLOSE, >0.08 → OPEN
 *   - Calls armController.moveToPosition() on every MediaPipe frame (~30fps)
 *   - Trajectory recording at 10Hz: (timestamp_ms, x, y, z, gripper_open)
 *   - On Stop: sends recorded trajectory to backend via WebSocket (guide_record)
 *   - Replay: streams backend waypoints back to arm in real-time
 */

import armController from "../engine/armController";
import mediapipeService, {
  type HandUpdate,
  type NormalizedLandmark,
} from "../services/mediapipeService";
import wsService, { type WSMessage } from "../services/websocketService";
import { WORKSPACE_BOUNDS } from "../engine/physics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceMapping {
  x: [number, number];
  y: [number, number];
  z: [number, number];
}

export interface TrajectoryPoint {
  timestamp_ms: number;
  x: number;
  y: number;
  z: number;
  gripper_open: boolean;
}

export interface GuideModeState {
  active: boolean;
  recording: boolean;
  replaying: boolean;
  handDetected: boolean;
  gripperOpen: boolean;
  pointCount: number;
  replayProgress: number;
  replayTotal: number;
  statusMessage: string;
  savedTrajectoryId: string | null;
}

export type GuideModeStateHandler = (state: GuideModeState) => void;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** EMA smoothing factor — higher = more responsive, lower = smoother */
const EMA_ALPHA = 0.3;

/** Pinch thresholds (normalized distance between thumb tip and index tip) */
const PINCH_CLOSE_THRESHOLD = 0.05;
const PINCH_OPEN_THRESHOLD = 0.08;

/** Trajectory recording rate */
const RECORD_HZ = 10;
const RECORD_INTERVAL_MS = 1000 / RECORD_HZ;

/** Maximum trajectory points stored (60s @ 10Hz) */
const MAX_TRAJECTORY_POINTS = 600;

/**
 * Default workspace mapping:
 * Hand X (0=left, 1=right) → arm X (flipped: right hand = negative arm X)
 * Hand Y (0=top, 1=bottom) → arm Y (inverted: hand up = arm up)
 * Hand Z (depth, negative = closer) → arm Z (mapped to front/back range)
 */
const DEFAULT_WORKSPACE_MAPPING: WorkspaceMapping = {
  x: [WORKSPACE_BOUNDS.x[0] * 0.7, WORKSPACE_BOUNDS.x[1] * 0.7],
  y: [WORKSPACE_BOUNDS.y[0] + 0.3, WORKSPACE_BOUNDS.y[1] * 0.7],
  z: [WORKSPACE_BOUNDS.z[0] * 0.5, WORKSPACE_BOUNDS.z[1] * 0.5],
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

class GuideModeController {
  private state: GuideModeState = {
    active: false,
    recording: false,
    replaying: false,
    handDetected: false,
    gripperOpen: true,
    pointCount: 0,
    replayProgress: 0,
    replayTotal: 0,
    statusMessage: "Ready",
    savedTrajectoryId: null,
  };

  private handlers: Set<GuideModeStateHandler> = new Set();

  /** EMA-filtered position */
  private smoothX = 0;
  private smoothY = 1.2;
  private smoothZ = 0;
  private smoothInitialized = false;

  /** Current gripper state (hysteresis) */
  private gripperOpen = true;

  /** Workspace mapping config */
  private mapping: WorkspaceMapping = { ...DEFAULT_WORKSPACE_MAPPING };

  /** Unsubscribe from mediapipeService */
  private unsubHand: (() => void) | null = null;

  /** Unsubscribe from wsService */
  private unsubWs: (() => void) | null = null;

  /** Trajectory recording */
  private trajectory: TrajectoryPoint[] = [];
  private recordTimer: ReturnType<typeof setInterval> | null = null;
  private latestMappedPos: { x: number; y: number; z: number } | null = null;

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Start teleoperation — subscribes to hand updates and begins driving arm. */
  start(mapping?: Partial<WorkspaceMapping>): void {
    if (this.state.active) return;
    if (mapping) {
      this.mapping = { ...this.mapping, ...mapping };
    }
    this.smoothInitialized = false;

    this.unsubHand = mediapipeService.onHandUpdate(this.onHandUpdate);
    this.unsubWs = wsService.onMessage(this.onWsMessage);

    this.setState({
      active: true,
      statusMessage: "Teleoperation active — move your hand",
    });
  }

  /** Stop teleoperation and recording. */
  stop(): void {
    if (!this.state.active) return;

    if (this.state.recording) {
      this.stopRecording();
    }

    this.unsubHand?.();
    this.unsubHand = null;
    this.unsubWs?.();
    this.unsubWs = null;

    this.setState({
      active: false,
      handDetected: false,
      statusMessage: "Teleoperation stopped",
    });
  }

  /** Start recording trajectory at 10Hz. */
  startRecording(): void {
    if (!this.state.active || this.state.recording) return;

    this.trajectory = [];
    this.recordTimer = setInterval(this.capturePoint, RECORD_INTERVAL_MS);

    this.setState({
      recording: true,
      pointCount: 0,
      statusMessage: "Recording trajectory...",
    });
  }

  /**
   * Stop recording and send trajectory to backend.
   * Returns the recorded points array.
   */
  stopRecording(): TrajectoryPoint[] {
    if (!this.state.recording) return this.trajectory;

    if (this.recordTimer) {
      clearInterval(this.recordTimer);
      this.recordTimer = null;
    }

    const points = [...this.trajectory];
    const trajectoryId = `guide_${Date.now()}`;

    this.setState({
      recording: false,
      statusMessage: `Recorded ${points.length} points — saving...`,
    });

    if (points.length > 1) {
      wsService.send({
        type: "guide_record",
        trajectory_id: trajectoryId,
        points: points,
        metadata: {
          recording_hz: RECORD_HZ,
          ema_alpha: EMA_ALPHA,
          workspace_mapping: this.mapping,
          point_count: points.length,
        },
      });
    } else {
      this.setState({ statusMessage: "Recording too short" });
    }

    return points;
  }

  /** Trigger replay of the last saved trajectory. */
  startReplay(speedMultiplier = 1.0): void {
    if (!this.state.savedTrajectoryId) return;

    wsService.send({
      type: "guide_replay",
      trajectory_id: this.state.savedTrajectoryId,
      speed_multiplier: speedMultiplier,
    });

    this.setState({
      replaying: true,
      replayProgress: 0,
      statusMessage: "Replaying trajectory...",
    });
  }

  /** Cancel any active replay. */
  cancelReplay(): void {
    wsService.send({ type: "guide_replay_cancel" });
    this.setState({ replaying: false, statusMessage: "Replay cancelled" });
  }

  /** Update workspace mapping. */
  setMapping(mapping: Partial<WorkspaceMapping>): void {
    this.mapping = { ...this.mapping, ...mapping };
  }

  getState(): GuideModeState {
    return { ...this.state };
  }

  onStateChange(handler: GuideModeStateHandler): () => void {
    this.handlers.add(handler);
    handler(this.getState());
    return () => {
      this.handlers.delete(handler);
    };
  }

  getTrajectory(): TrajectoryPoint[] {
    return [...this.trajectory];
  }

  // -----------------------------------------------------------------------
  // Hand update handler — core teleoperation loop
  // -----------------------------------------------------------------------

  private onHandUpdate = (update: HandUpdate): void => {
    const hand = update.hands[0];

    if (!hand) {
      this.setState({ handDetected: false });
      return;
    }

    this.setState({ handDetected: true });

    // Map palm center normalized → arm workspace
    const mapped = this.mapToWorkspace(hand.palmCenter);

    // Apply EMA smoothing
    if (!this.smoothInitialized) {
      this.smoothX = mapped.x;
      this.smoothY = mapped.y;
      this.smoothZ = mapped.z;
      this.smoothInitialized = true;
    } else {
      this.smoothX = EMA_ALPHA * mapped.x + (1 - EMA_ALPHA) * this.smoothX;
      this.smoothY = EMA_ALPHA * mapped.y + (1 - EMA_ALPHA) * this.smoothY;
      this.smoothZ = EMA_ALPHA * mapped.z + (1 - EMA_ALPHA) * this.smoothZ;
    }

    this.latestMappedPos = {
      x: this.smoothX,
      y: this.smoothY,
      z: this.smoothZ,
    };

    // Drive arm — fire and forget (IK failures are expected at workspace limits)
    armController.moveToPosition(this.smoothX, this.smoothY, this.smoothZ, 8.0).catch(() => {
      // IK failure at workspace boundary is expected — silently ignore
    });

    // Gripper control with hysteresis
    this.updateGripper(hand.pinchDistance);
  };

  // -----------------------------------------------------------------------
  // Workspace mapping
  // -----------------------------------------------------------------------

  /**
   * Maps normalized hand landmark coordinates (0–1) to arm workspace coords.
   *
   * MediaPipe coordinate frame (webcam view):
   *   x: 0 = left edge, 1 = right edge  (mirrored in webcam)
   *   y: 0 = top edge,  1 = bottom edge
   *   z: negative = closer to camera (depth estimate)
   *
   * Arm workspace: x = left/right, y = up/down, z = front/back
   */
  private mapToWorkspace(
    palmCenter: NormalizedLandmark,
  ): { x: number; y: number; z: number } {
    // X: mirror horizontally (webcam is mirrored display, so raw 0→1 = right→left)
    // Map 0→1 to workspace x max→min (inverted)
    const x = lerp(
      1 - palmCenter.x,        // flip: hand right (low x) → arm positive x
      0, 1,
      this.mapping.x[0], this.mapping.x[1],
    );

    // Y: invert (hand up = low y → arm high y)
    const y = lerp(
      1 - palmCenter.y,
      0, 1,
      this.mapping.y[0], this.mapping.y[1],
    );

    // Z: use palm z depth (negative = closer). Normalize to 0–1 range.
    // Typical z range from MediaPipe: roughly -0.1 to 0.1
    const zNorm = Math.max(0, Math.min(1, (palmCenter.z + 0.1) / 0.2));
    const z = lerp(
      zNorm,
      0, 1,
      this.mapping.z[0], this.mapping.z[1],
    );

    // Clamp to workspace bounds
    return {
      x: Math.max(WORKSPACE_BOUNDS.x[0], Math.min(WORKSPACE_BOUNDS.x[1], x)),
      y: Math.max(WORKSPACE_BOUNDS.y[0], Math.min(WORKSPACE_BOUNDS.y[1], y)),
      z: Math.max(WORKSPACE_BOUNDS.z[0], Math.min(WORKSPACE_BOUNDS.z[1], z)),
    };
  }

  // -----------------------------------------------------------------------
  // Gripper control
  // -----------------------------------------------------------------------

  private updateGripper(pinchDistance: number): void {
    if (pinchDistance < PINCH_CLOSE_THRESHOLD && this.gripperOpen) {
      this.gripperOpen = false;
      armController.closeGripper();
      this.setState({ gripperOpen: false });
    } else if (pinchDistance > PINCH_OPEN_THRESHOLD && !this.gripperOpen) {
      this.gripperOpen = true;
      armController.openGripper();
      this.setState({ gripperOpen: true });
    }
  }

  // -----------------------------------------------------------------------
  // Trajectory recording
  // -----------------------------------------------------------------------

  private capturePoint = (): void => {
    if (!this.state.recording || !this.latestMappedPos) return;
    if (this.trajectory.length >= MAX_TRAJECTORY_POINTS) {
      this.stopRecording();
      this.setState({ statusMessage: `Reached ${MAX_TRAJECTORY_POINTS} point limit` });
      return;
    }

    this.trajectory.push({
      timestamp_ms: Date.now(),
      x: this.smoothX,
      y: this.smoothY,
      z: this.smoothZ,
      gripper_open: this.gripperOpen,
    });

    this.setState({ pointCount: this.trajectory.length });
  };

  // -----------------------------------------------------------------------
  // WebSocket message handler — replay and record acks
  // -----------------------------------------------------------------------

  private onWsMessage = (msg: WSMessage): void => {
    switch (msg.type) {
      case "guide_record_saved":
        this.setState({
          savedTrajectoryId: msg.trajectory_id as string,
          statusMessage: `Trajectory saved (${msg.point_count} pts, ${((msg.duration_ms as number) / 1000).toFixed(1)}s)`,
        });
        break;

      case "guide_record_error":
        this.setState({ statusMessage: `Record error: ${msg.error}` });
        break;

      case "guide_replay_start":
        this.setState({
          replaying: true,
          replayTotal: msg.point_count as number,
          replayProgress: 0,
          statusMessage: `Replaying ${msg.point_count} points...`,
        });
        break;

      case "guide_replay_waypoint": {
        const index = msg.index as number;
        const total = msg.total as number;

        // Drive the arm to the replayed position
        const x = msg.x as number;
        const y = msg.y as number;
        const z = msg.z as number;

        armController.moveToPosition(x, y, z, 6.0).catch(() => {});

        // Set gripper
        if (msg.gripper_open) {
          armController.openGripper();
        } else {
          armController.closeGripper();
        }

        this.setState({
          replayProgress: index + 1,
          replayTotal: total,
        });
        break;
      }

      case "guide_replay_done":
        this.setState({
          replaying: false,
          replayProgress: this.state.replayTotal,
          statusMessage: "Replay complete",
        });
        break;

      case "guide_replay_cancelled":
        this.setState({
          replaying: false,
          statusMessage: "Replay cancelled",
        });
        break;

      case "guide_replay_error":
        this.setState({
          replaying: false,
          statusMessage: `Replay error: ${msg.error}`,
        });
        break;
    }
  };

  // -----------------------------------------------------------------------
  // State management
  // -----------------------------------------------------------------------

  private setState(patch: Partial<GuideModeState>): void {
    this.state = { ...this.state, ...patch };
    this.handlers.forEach((h) => {
      try {
        h(this.getState());
      } catch (err) {
        console.error("[GuideMode] State handler error:", err);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Linear interpolation from [inMin, inMax] to [outMin, outMax]. */
function lerp(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  const t = (value - inMin) / (inMax - inMin);
  return outMin + t * (outMax - outMin);
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const guideMode = new GuideModeController();
export default guideMode;
