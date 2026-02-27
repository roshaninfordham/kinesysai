/**
 * KINESYS — WebcamFeed Component
 *
 * Displays the camera preview with a canvas overlay drawing:
 *   - Hand skeleton (21 landmarks connected by lines)
 *   - Palm center as a circle
 *   - Thumb-to-index distance line (pinch detection)
 *   - Detected gesture label (PINCH / OPEN)
 */

import { useEffect, useRef, useState, useCallback } from "react";
import mediapipeService, {
  type HandUpdate,
  type NormalizedLandmark,
} from "../services/mediapipeService";
import teachMode from "../modes/teachMode";

// ---------------------------------------------------------------------------
// Hand skeleton connections (MediaPipe hand landmark topology)
// ---------------------------------------------------------------------------

const HAND_CONNECTIONS: [number, number][] = [
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle
  [0, 9], [9, 10], [10, 11], [11, 12],
  // Ring
  [0, 13], [13, 14], [14, 15], [15, 16],
  // Pinky
  [0, 17], [17, 18], [18, 19], [19, 20],
  // Palm base
  [5, 9], [9, 13], [13, 17],
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WebcamFeedProps {
  active: boolean;
  onStreamReady?: (video: HTMLVideoElement) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WebcamFeed({ active, onStreamReady }: WebcamFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [gesture, setGesture] = useState<string>("NO_HAND");
  const latestUpdate = useRef<HandUpdate | null>(null);

  // -----------------------------------------------------------------------
  // Start / stop camera
  // -----------------------------------------------------------------------

  const startCamera = useCallback(async () => {
    try {
      setCameraError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        // Wire up MediaPipe tracking
        mediapipeService.setVideoElement(videoRef.current);
        await mediapipeService.startTracking(videoRef.current);

        // Wire up teach mode video source
        teachMode.setVideoSource(videoRef.current);

        onStreamReady?.(videoRef.current);
      }
    } catch (err) {
      const msg =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Camera access denied. Please allow camera permissions."
          : "Could not access camera.";
      setCameraError(msg);
      console.error("[WebcamFeed] Camera error:", err);
    }
  }, [onStreamReady]);

  const stopCamera = useCallback(() => {
    mediapipeService.stopTracking();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (active) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [active, startCamera, stopCamera]);

  // -----------------------------------------------------------------------
  // Hand update listener → overlay rendering
  // -----------------------------------------------------------------------

  useEffect(() => {
    const unsub = mediapipeService.onHandUpdate((update: HandUpdate) => {
      latestUpdate.current = update;
      const primary = update.hands[0];
      setGesture(primary ? primary.gesture : "NO_HAND");

      // Forward to teach mode
      teachMode.onHandUpdate(update);

      // Draw overlay
      drawOverlay(update);
    });

    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -----------------------------------------------------------------------
  // Canvas overlay drawing
  // -----------------------------------------------------------------------

  const drawOverlay = (update: HandUpdate) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Match canvas to video dimensions
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    for (const hand of update.hands) {
      const lm = hand.landmarks;
      if (lm.length < 21) continue;

      // Draw connections (skeleton lines)
      ctx.strokeStyle =
        hand.gesture === "PINCH" ? "#f59e0b" : "#22d3ee";
      ctx.lineWidth = 2;

      for (const [a, b] of HAND_CONNECTIONS) {
        const pa = lm[a]!;
        const pb = lm[b]!;
        ctx.beginPath();
        ctx.moveTo(pa.x * w, pa.y * h);
        ctx.lineTo(pb.x * w, pb.y * h);
        ctx.stroke();
      }

      // Draw landmarks as dots
      ctx.fillStyle = "#ffffff";
      for (const pt of lm) {
        ctx.beginPath();
        ctx.arc(pt.x * w, pt.y * h, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw palm center (larger circle)
      const pc = hand.palmCenter;
      ctx.beginPath();
      ctx.arc(pc.x * w, pc.y * h, 8, 0, Math.PI * 2);
      ctx.fillStyle =
        hand.gesture === "PINCH"
          ? "rgba(245, 158, 11, 0.5)"
          : "rgba(34, 211, 238, 0.4)";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Draw thumb-to-index pinch line
      const thumb = lm[4] as NormalizedLandmark;
      const index = lm[8] as NormalizedLandmark;
      ctx.beginPath();
      ctx.moveTo(thumb.x * w, thumb.y * h);
      ctx.lineTo(index.x * w, index.y * h);
      ctx.strokeStyle =
        hand.gesture === "PINCH" ? "#f59e0b" : "rgba(255,255,255,0.4)";
      ctx.lineWidth = hand.gesture === "PINCH" ? 3 : 1;
      ctx.setLineDash(hand.gesture === "PINCH" ? [] : [4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Gesture label near palm
      ctx.font = "bold 14px monospace";
      ctx.fillStyle =
        hand.gesture === "PINCH" ? "#f59e0b" : "#22d3ee";
      ctx.fillText(
        hand.gesture,
        pc.x * w + 12,
        pc.y * h - 12,
      );

      // Handedness label
      ctx.font = "11px monospace";
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillText(
        hand.handedness,
        pc.x * w + 12,
        pc.y * h + 4,
      );
    }
  };

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="relative overflow-hidden rounded-lg bg-black">
      {/* Video feed */}
      <video
        ref={videoRef}
        className="h-full w-full object-cover"
        style={{ transform: "scaleX(-1)", minHeight: 240 }}
        playsInline
        muted
      />

      {/* Canvas overlay */}
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ transform: "scaleX(-1)" }}
      />

      {/* Gesture badge */}
      {gesture !== "NO_HAND" && (
        <div
          className={`absolute left-3 top-3 rounded-full px-3 py-1 text-xs font-bold ${
            gesture === "PINCH"
              ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
              : "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
          }`}
        >
          {gesture === "PINCH" ? "✊ PINCH" : "🖐 OPEN"}
        </div>
      )}

      {/* Camera error */}
      {cameraError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <div className="text-center">
            <p className="text-sm text-red-400">{cameraError}</p>
            <button
              className="mt-2 rounded bg-kinesys-primary/20 px-4 py-1.5 text-xs text-kinesys-primary hover:bg-kinesys-primary/30"
              onClick={startCamera}
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Camera off state */}
      {!active && !cameraError && (
        <div className="absolute inset-0 flex items-center justify-center bg-kinesys-surface">
          <p className="text-sm text-white/30">Camera off</p>
        </div>
      )}
    </div>
  );
}
