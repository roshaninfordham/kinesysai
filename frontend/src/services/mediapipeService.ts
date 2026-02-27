/**
 * KINESYS — MediaPipe Hand Tracking Service
 *
 * Initializes MediaPipe Tasks Vision HandLandmarker and processes webcam
 * frames to extract 21 landmarks per detected hand.
 *
 * Public API:
 *   - startTracking(video?)
 *   - stopTracking()
 *   - onHandUpdate(callback)
 */

import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
} from "@mediapipe/tasks-vision";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
}

export type GestureLabel = "PINCH" | "OPEN" | "NO_HAND";

export interface HandUpdate {
  timestamp: number;
  hands: Array<{
    handedness: "Left" | "Right" | "Unknown";
    landmarks: NormalizedLandmark[];
    palmCenter: NormalizedLandmark;
    pinchDistance: number;
    gesture: GestureLabel;
  }>;
}

export type HandUpdateHandler = (update: HandUpdate) => void;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MODEL_ASSET_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const PINCH_THRESHOLD = 0.06;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class MediaPipeService {
  private handLandmarker: HandLandmarker | null = null;
  private running = false;
  private videoEl: HTMLVideoElement | null = null;
  private rafId: number | null = null;
  private handlers: Set<HandUpdateHandler> = new Set();

  async startTracking(video?: HTMLVideoElement): Promise<void> {
    if (video) this.videoEl = video;
    if (!this.videoEl) {
      throw new Error("No video element provided to MediaPipe service");
    }

    if (!this.handLandmarker) {
      await this.init();
    }

    if (this.running) return;
    this.running = true;
    this.loop();
  }

  stopTracking(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  setVideoElement(video: HTMLVideoElement): void {
    this.videoEl = video;
  }

  onHandUpdate(handler: HandUpdateHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async init(): Promise<void> {
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm",
    );

    this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_ASSET_URL,
        delegate: "GPU",
      },
      numHands: 2,
      runningMode: "VIDEO",
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  private loop = (): void => {
    if (!this.running || !this.handLandmarker || !this.videoEl) return;

    if (this.videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const now = performance.now();
      const result = this.handLandmarker.detectForVideo(this.videoEl, now);
      this.emit(result, now);
    }

    this.rafId = requestAnimationFrame(this.loop);
  };

  private emit(result: HandLandmarkerResult, timestamp: number): void {
    const landmarksList = result.landmarks ?? [];
    const handednesses = result.handednesses ?? [];

    const hands = landmarksList.map((landmarks, idx) => {
      const lm = landmarks.map((p) => ({ x: p.x, y: p.y, z: p.z }));
      const handedLabel = handednesses[idx]?.[0]?.categoryName ?? "Unknown";

      const palmCenter = computePalmCenter(lm);
      const pinchDistance = distance(lm[4], lm[8]); // thumb_tip ↔ index_tip
      const gesture: GestureLabel = pinchDistance < PINCH_THRESHOLD ? "PINCH" : "OPEN";

      return {
        handedness: (handedLabel === "Left" || handedLabel === "Right"
          ? handedLabel
          : "Unknown") as "Left" | "Right" | "Unknown",
        landmarks: lm,
        palmCenter,
        pinchDistance,
        gesture,
      };
    });

    const update: HandUpdate = {
      timestamp,
      hands,
    };

    this.handlers.forEach((handler) => {
      try {
        handler(update);
      } catch (err) {
        console.error("[MediaPipe] hand update handler error:", err);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computePalmCenter(landmarks: NormalizedLandmark[]): NormalizedLandmark {
  const palmIndices = [0, 5, 9, 13, 17];
  let sx = 0;
  let sy = 0;
  let sz = 0;

  for (const i of palmIndices) {
    const p = landmarks[i] ?? { x: 0, y: 0, z: 0 };
    sx += p.x;
    sy += p.y;
    sz += p.z;
  }

  const n = palmIndices.length;
  return { x: sx / n, y: sy / n, z: sz / n };
}

function distance(a?: NormalizedLandmark, b?: NormalizedLandmark): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const mediapipeService = new MediaPipeService();
export default mediapipeService;
