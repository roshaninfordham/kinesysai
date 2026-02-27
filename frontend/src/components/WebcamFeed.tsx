/**
 * KINESYS — WebcamFeed Component
 *
 * Displays the camera preview with a canvas overlay drawing:
 *   - AR virtual scene objects projected into camera 2D space
 *   - Table surface grid
 *   - Hand skeleton (21 landmarks connected by lines)
 *   - Palm center as a circle
 *   - Thumb-to-index distance line (pinch detection)
 *   - Detected gesture label (PINCH / OPEN)
 *   - Object highlight when hand is pinching near it
 */

import { useEffect, useRef, useState, useCallback } from "react";
import mediapipeService, {
  type HandUpdate,
  type NormalizedLandmark,
} from "../services/mediapipeService";
import teachMode from "../modes/teachMode";

// ---------------------------------------------------------------------------
// AR Scene projection helpers
// ---------------------------------------------------------------------------

interface ARObject {
  id: string;
  label: string;
  color: string;
  shape: "box" | "cylinder" | "sphere";
  // 3D world coords (same space as physics engine)
  worldX: number;
  worldY: number; // height above ground
  worldZ: number;
  sizeX: number;
  sizeY: number;
}

// Default scene objects matching the physics engine layout
const AR_SCENE_OBJECTS: ARObject[] = [
  { id: "red_cube",       label: "Red Cube",      color: "#ef4444", shape: "box",      worldX:  0.8,  worldY: 0.65, worldZ:  0.3,  sizeX: 0.20, sizeY: 0.20 },
  { id: "blue_cylinder",  label: "Blue Cylinder",  color: "#3b82f6", shape: "cylinder", worldX: -0.5,  worldY: 0.70, worldZ:  0.6,  sizeX: 0.10, sizeY: 0.30 },
  { id: "green_sphere",   label: "Green Sphere",   color: "#22c55e", shape: "sphere",   worldX:  0.3,  worldY: 0.67, worldZ: -0.5,  sizeX: 0.12, sizeY: 0.12 },
  { id: "yellow_box",     label: "Yellow Box",     color: "#eab308", shape: "box",      worldX: -0.6,  worldY: 0.65, worldZ: -0.3,  sizeX: 0.25, sizeY: 0.20 },
];

/**
 * Project a 3D world point to 2D canvas coordinates.
 * Uses a simple isometric-style perspective for readability.
 *
 * World space:  X = left/right, Y = up, Z = front/back
 * Canvas space: (0,0) = top-left
 */
function project(
  worldX: number,
  worldY: number,
  worldZ: number,
  canvasW: number,
  canvasH: number,
): { x: number; y: number; scale: number } {
  // Camera is slightly above and in front, looking down at the table
  // Table sits at worldY ≈ 0.5–0.75 in world units
  const camZ = 2.8;   // camera distance forward
  const fov  = 0.55;  // field-of-view factor

  // Perspective divide
  const relZ = camZ - worldZ;
  const scale = fov * camH / relZ;

  // Project to screen
  const sx = canvasW / 2 + worldX * scale;
  const sy = canvasH * 0.72 - (worldY - 0.5) * scale * 1.1;

  return { x: sx, y: sy, scale };
}

// Declare camH at module level so project() can use canvasH via closure
let camH = 480;

/** Returns 2D distance between a hand palm center (normalised 0-1) and a projected AR object */
function palmToObjectDist(
  palm: NormalizedLandmark,
  obj: ARObject,
  canvasW: number,
  canvasH: number,
): number {
  const { x: ox, y: oy } = project(obj.worldX, obj.worldY, obj.worldZ, canvasW, canvasH);
  const px = palm.x * canvasW;
  const py = palm.y * canvasH;
  return Math.sqrt((px - ox) ** 2 + (py - oy) ** 2);
}

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
    camH = h; // update module-level camH for project()

    ctx.clearRect(0, 0, w, h);

    // -------------------------------------------------------------------
    // 1. Draw AR table surface grid
    // -------------------------------------------------------------------
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 1;
    // Draw a grid of lines at table height (worldY = 0.5)
    const gridSteps = 6;
    for (let xi = -gridSteps / 2; xi <= gridSteps / 2; xi++) {
      const wx = xi * 0.3;
      const p1 = project(wx, 0.5, -0.8, w, h);
      const p2 = project(wx, 0.5,  0.8, w, h);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
    for (let zi = -gridSteps / 2; zi <= gridSteps / 2; zi++) {
      const wz = zi * 0.3;
      const p1 = project(-0.9, 0.5, wz, w, h);
      const p2 = project( 0.9, 0.5, wz, w, h);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
    ctx.restore();

    // -------------------------------------------------------------------
    // 2. Determine which object (if any) a pinching hand is grabbing
    // -------------------------------------------------------------------
    const GRAB_RADIUS_PX = 55; // pixel distance to count as "grabbing"
    const grabbedIds = new Set<string>();

    for (const hand of update.hands) {
      if (hand.gesture !== "PINCH") continue;
      const pc = hand.palmCenter;
      let closestDist = Infinity;
      let closestId = "";
      for (const obj of AR_SCENE_OBJECTS) {
        const d = palmToObjectDist(pc, obj, w, h);
        if (d < closestDist) { closestDist = d; closestId = obj.id; }
      }
      if (closestDist < GRAB_RADIUS_PX) grabbedIds.add(closestId);
    }

    // -------------------------------------------------------------------
    // 3. Draw AR virtual objects
    // -------------------------------------------------------------------
    for (const obj of AR_SCENE_OBJECTS) {
      const { x: cx, y: cy, scale } = project(obj.worldX, obj.worldY, obj.worldZ, w, h);
      const isGrabbed = grabbedIds.has(obj.id);
      const pw = obj.sizeX * scale * 5;   // pixel width
      const ph = obj.sizeY * scale * 5;   // pixel height

      ctx.save();

      if (isGrabbed) {
        // Pulsing glow effect for grabbed object
        ctx.shadowColor = obj.color;
        ctx.shadowBlur = 20;
      }

      if (obj.shape === "box") {
        // Draw box as a filled rect with 3D top face
        ctx.globalAlpha = isGrabbed ? 0.92 : 0.72;
        ctx.fillStyle = obj.color;
        ctx.strokeStyle = isGrabbed ? "#ffffff" : obj.color;
        ctx.lineWidth = isGrabbed ? 2.5 : 1.5;
        ctx.fillRect(cx - pw / 2, cy - ph / 2, pw, ph);
        ctx.strokeRect(cx - pw / 2, cy - ph / 2, pw, ph);

        // Top face highlight
        const topOff = ph * 0.25;
        ctx.globalAlpha = isGrabbed ? 0.5 : 0.3;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.moveTo(cx - pw / 2, cy - ph / 2);
        ctx.lineTo(cx - pw / 2 + topOff, cy - ph / 2 - topOff);
        ctx.lineTo(cx + pw / 2 + topOff, cy - ph / 2 - topOff);
        ctx.lineTo(cx + pw / 2, cy - ph / 2);
        ctx.closePath();
        ctx.fill();

      } else if (obj.shape === "cylinder") {
        // Draw cylinder as rect + ellipse top
        ctx.globalAlpha = isGrabbed ? 0.92 : 0.72;
        ctx.fillStyle = obj.color;
        ctx.strokeStyle = isGrabbed ? "#ffffff" : obj.color;
        ctx.lineWidth = isGrabbed ? 2.5 : 1.5;
        ctx.fillRect(cx - pw / 2, cy - ph / 2, pw, ph);
        ctx.strokeRect(cx - pw / 2, cy - ph / 2, pw, ph);

        // Top ellipse
        ctx.beginPath();
        ctx.ellipse(cx, cy - ph / 2, pw / 2, pw / 4, 0, 0, Math.PI * 2);
        ctx.fillStyle = isGrabbed ? "#ffffff" : obj.color;
        ctx.globalAlpha = isGrabbed ? 0.5 : 0.45;
        ctx.fill();
        ctx.stroke();

      } else {
        // sphere → circle with radial gradient
        ctx.globalAlpha = isGrabbed ? 0.92 : 0.72;
        const grad = ctx.createRadialGradient(
          cx - pw * 0.15, cy - ph * 0.15, pw * 0.05,
          cx, cy, pw / 2,
        );
        grad.addColorStop(0, "#ffffff");
        grad.addColorStop(0.4, obj.color);
        grad.addColorStop(1, "rgba(0,0,0,0.5)");
        ctx.fillStyle = grad;
        ctx.strokeStyle = isGrabbed ? "#ffffff" : obj.color;
        ctx.lineWidth = isGrabbed ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, pw / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      // Object label
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.font = `bold ${Math.max(9, Math.round(scale * 2))}px monospace`;
      ctx.fillStyle = isGrabbed ? "#ffffff" : "rgba(255,255,255,0.75)";
      ctx.textAlign = "center";
      ctx.fillText(obj.label, cx, cy + ph / 2 + 13);
      ctx.textAlign = "left";

      // Grab indicator
      if (isGrabbed) {
        ctx.globalAlpha = 0.9;
        ctx.font = "bold 11px monospace";
        ctx.fillStyle = "#f59e0b";
        ctx.textAlign = "center";
        ctx.fillText("✓ GRABBED", cx, cy - ph / 2 - 16);
        ctx.textAlign = "left";
      }

      ctx.restore();
    }

    // -------------------------------------------------------------------
    // 4. Draw hand skeleton
    // -------------------------------------------------------------------
    for (const hand of update.hands) {
      const lm = hand.landmarks;
      if (lm.length < 21) continue;

      // Draw connections
      ctx.strokeStyle = hand.gesture === "PINCH" ? "#f59e0b" : "#22d3ee";
      ctx.lineWidth = 2;
      for (const [a, b] of HAND_CONNECTIONS) {
        const pa = lm[a]!;
        const pb = lm[b]!;
        ctx.beginPath();
        ctx.moveTo(pa.x * w, pa.y * h);
        ctx.lineTo(pb.x * w, pb.y * h);
        ctx.stroke();
      }

      // Draw landmark dots
      ctx.fillStyle = "#ffffff";
      for (const pt of lm) {
        ctx.beginPath();
        ctx.arc(pt.x * w, pt.y * h, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Palm center
      const pc = hand.palmCenter;
      ctx.beginPath();
      ctx.arc(pc.x * w, pc.y * h, 8, 0, Math.PI * 2);
      ctx.fillStyle = hand.gesture === "PINCH"
        ? "rgba(245,158,11,0.5)"
        : "rgba(34,211,238,0.4)";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Pinch line (thumb tip → index tip)
      const thumb = lm[4] as NormalizedLandmark;
      const index = lm[8] as NormalizedLandmark;
      ctx.beginPath();
      ctx.moveTo(thumb.x * w, thumb.y * h);
      ctx.lineTo(index.x * w, index.y * h);
      ctx.strokeStyle = hand.gesture === "PINCH" ? "#f59e0b" : "rgba(255,255,255,0.4)";
      ctx.lineWidth = hand.gesture === "PINCH" ? 3 : 1;
      ctx.setLineDash(hand.gesture === "PINCH" ? [] : [4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Gesture label
      ctx.font = "bold 14px monospace";
      ctx.fillStyle = hand.gesture === "PINCH" ? "#f59e0b" : "#22d3ee";
      ctx.fillText(hand.gesture, pc.x * w + 12, pc.y * h - 12);

      // Handedness label
      ctx.font = "11px monospace";
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillText(hand.handedness, pc.x * w + 12, pc.y * h + 4);
    }

    // -------------------------------------------------------------------
    // 5. AR mode banner at top
    // -------------------------------------------------------------------
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, w, 22);
    ctx.font = "bold 11px monospace";
    ctx.fillStyle = "#f59e0b";
    ctx.fillText("AR TEACH MODE", 8, 15);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillText("PINCH objects to grab · demonstrate the task", 120, 15);
    ctx.restore();
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
