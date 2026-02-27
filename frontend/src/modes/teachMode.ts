/**
 * KINESYS — Teach Mode Controller
 *
 * Records demonstration keyframes at 5fps with motion-delta filtering.
 * Keyframes are captured as base64 JPEG images and sent to backend over WS.
 */

import type { HandUpdate, NormalizedLandmark } from "../services/mediapipeService";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Keyframe {
  timestamp: number;
  imageBase64: string;
  palmCenter: { x: number; y: number; z: number } | null;
  gesture: "PINCH" | "OPEN" | "NO_HAND";
}

export interface TeachModeState {
  recording: boolean;
  keyframeCount: number;
  lastGesture: "PINCH" | "OPEN" | "NO_HAND";
  statusMessage: string;
}

export type TeachStateHandler = (state: TeachModeState) => void;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CAPTURE_FPS = 5;
const CAPTURE_INTERVAL_MS = 1000 / CAPTURE_FPS;
const PALM_MOTION_THRESHOLD = 0.03; // normalized coordinate units
const MAX_KEYFRAMES = 120;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

class TeachModeController {
  private state: TeachModeState = {
    recording: false,
    keyframeCount: 0,
    lastGesture: "NO_HAND",
    statusMessage: "Ready",
  };

  private handlers: Set<TeachStateHandler> = new Set();
  private keyframes: Keyframe[] = [];
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  private sourceVideo: HTMLVideoElement | null = null;
  private captureCanvas: HTMLCanvasElement | null = null;
  private latestPalmCenter: NormalizedLandmark | null = null;
  private latestGesture: "PINCH" | "OPEN" | "NO_HAND" = "NO_HAND";
  private lastKeptPalmCenter: NormalizedLandmark | null = null;

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  setVideoSource(video: HTMLVideoElement): void {
    this.sourceVideo = video;
    if (!this.captureCanvas) {
      this.captureCanvas = document.createElement("canvas");
    }
  }

  onHandUpdate(update: HandUpdate): void {
    const primary = update.hands[0];
    if (!primary) {
      this.latestPalmCenter = null;
      this.latestGesture = "NO_HAND";
      return;
    }
    this.latestPalmCenter = primary.palmCenter;
    this.latestGesture = primary.gesture;

    this.setState({ lastGesture: primary.gesture });
  }

  startRecording(): void {
    if (this.state.recording) return;
    if (!this.sourceVideo) {
      this.setState({
        statusMessage: "Attach webcam feed before recording",
      });
      return;
    }

    this.keyframes = [];
    this.lastKeptPalmCenter = null;

    this.setState({
      recording: true,
      keyframeCount: 0,
      statusMessage: "Recording demonstration...",
    });

    this.captureTimer = setInterval(() => {
      this.captureFrameIfMoved();
    }, CAPTURE_INTERVAL_MS);
  }

  stopRecording(): Keyframe[] {
    if (!this.state.recording) return this.keyframes;

    if (this.captureTimer) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }

    this.setState({
      recording: false,
      statusMessage: `Captured ${this.keyframes.length} keyframes`,
    });

    return this.keyframes;
  }

  getState(): TeachModeState {
    return { ...this.state };
  }

  getKeyframes(): Keyframe[] {
    return [...this.keyframes];
  }

  onStateChange(handler: TeachStateHandler): () => void {
    this.handlers.add(handler);
    handler(this.getState());
    return () => {
      this.handlers.delete(handler);
    };
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private captureFrameIfMoved(): void {
    if (!this.state.recording || !this.sourceVideo || !this.captureCanvas) return;
    if (this.keyframes.length >= MAX_KEYFRAMES) {
      this.stopRecording();
      this.setState({ statusMessage: `Reached ${MAX_KEYFRAMES} keyframe limit` });
      return;
    }

    const currentPalm = this.latestPalmCenter;
    const shouldKeep = this.shouldKeepFrame(currentPalm);

    if (!shouldKeep) {
      return;
    }

    const imageBase64 = this.captureVideoFrame(this.sourceVideo, this.captureCanvas);
    const keyframe: Keyframe = {
      timestamp: Date.now(),
      imageBase64,
      palmCenter: currentPalm
        ? { x: currentPalm.x, y: currentPalm.y, z: currentPalm.z }
        : null,
      gesture: this.latestGesture,
    };

    this.keyframes.push(keyframe);
    this.lastKeptPalmCenter = currentPalm ? { ...currentPalm } : null;

    this.setState({
      keyframeCount: this.keyframes.length,
      statusMessage: `Recording... ${this.keyframes.length} keyframes`,
    });
  }

  private shouldKeepFrame(currentPalm: NormalizedLandmark | null): boolean {
    // Always keep first frame
    if (this.keyframes.length === 0) return true;

    // If hand is lost/reacquired, keep the frame
    if (!currentPalm || !this.lastKeptPalmCenter) return true;

    const dx = currentPalm.x - this.lastKeptPalmCenter.x;
    const dy = currentPalm.y - this.lastKeptPalmCenter.y;
    const dz = currentPalm.z - this.lastKeptPalmCenter.z;
    const motion = Math.sqrt(dx * dx + dy * dy + dz * dz);

    return motion >= PALM_MOTION_THRESHOLD;
  }

  private captureVideoFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): string {
    const width = video.videoWidth || 640;
    const height = video.videoHeight || 480;

    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not get 2D context for keyframe capture");
    }

    ctx.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.75);
  }

  private setState(patch: Partial<TeachModeState>): void {
    this.state = { ...this.state, ...patch };
    this.handlers.forEach((handler) => {
      try {
        handler(this.getState());
      } catch (err) {
        console.error("[TeachMode] State handler error:", err);
      }
    });
  }
}

export const teachMode = new TeachModeController();
export default teachMode;
