/**
 * KINESYS — DemoMode Component & Service
 *
 * Demo Mode toggle that:
 *   - Pre-loads cached model responses for common commands (avoids API calls)
 *   - Uses a slightly slower but 100% reliable execution path
 *   - Shows a subtle 'DEMO' badge in the header
 *
 * Also exports a demoService singleton for other components to query.
 */

import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Cached responses for common demo commands
// ---------------------------------------------------------------------------

interface CachedWaypoint {
  x: number;
  y: number;
  z: number;
  roll: number;
  pitch: number;
  yaw: number;
  gripper_open: boolean;
}

interface CachedResponse {
  command: string;
  keywords: string[];
  confirmation: string;
  waypoints: CachedWaypoint[];
}

const CACHED_RESPONSES: CachedResponse[] = [
  {
    command: "pick up the red cube",
    keywords: ["pick", "red", "cube"],
    confirmation: "Moving to approach the red cube, then grasping it.",
    waypoints: [
      { x: 0.8, y: 1.2, z: 0.3, roll: 0, pitch: 0, yaw: 0, gripper_open: true },
      { x: 0.8, y: 0.75, z: 0.3, roll: 0, pitch: 0, yaw: 0, gripper_open: true },
      { x: 0.8, y: 0.65, z: 0.3, roll: 0, pitch: 0, yaw: 0, gripper_open: false },
      { x: 0.8, y: 1.2, z: 0.3, roll: 0, pitch: 0, yaw: 0, gripper_open: false },
    ],
  },
  {
    command: "place it in the center",
    keywords: ["place", "center"],
    confirmation: "Placing the object at the center of the table.",
    waypoints: [
      { x: 0, y: 1.2, z: 0, roll: 0, pitch: 0, yaw: 0, gripper_open: false },
      { x: 0, y: 0.75, z: 0, roll: 0, pitch: 0, yaw: 0, gripper_open: false },
      { x: 0, y: 0.65, z: 0, roll: 0, pitch: 0, yaw: 0, gripper_open: true },
      { x: 0, y: 1.2, z: 0, roll: 0, pitch: 0, yaw: 0, gripper_open: true },
    ],
  },
  {
    command: "move the blue cylinder to the right",
    keywords: ["blue", "cylinder", "right"],
    confirmation: "Moving the blue cylinder to the right side of the table.",
    waypoints: [
      { x: -0.5, y: 1.2, z: 0.6, roll: 0, pitch: 0, yaw: 0, gripper_open: true },
      { x: -0.5, y: 0.78, z: 0.6, roll: 0, pitch: 0, yaw: 0, gripper_open: true },
      { x: -0.5, y: 0.7, z: 0.6, roll: 0, pitch: 0, yaw: 0, gripper_open: false },
      { x: -0.5, y: 1.2, z: 0.6, roll: 0, pitch: 0, yaw: 0, gripper_open: false },
      { x: 0.6, y: 1.2, z: 0.6, roll: 0, pitch: 0, yaw: 0, gripper_open: false },
      { x: 0.6, y: 0.7, z: 0.6, roll: 0, pitch: 0, yaw: 0, gripper_open: true },
      { x: 0.6, y: 1.2, z: 0.6, roll: 0, pitch: 0, yaw: 0, gripper_open: true },
    ],
  },
  {
    command: "stack the red cube on the yellow box",
    keywords: ["stack", "red", "yellow"],
    confirmation: "Picking up the red cube and stacking it on the yellow box.",
    waypoints: [
      { x: 0.8, y: 1.2, z: 0.3, roll: 0, pitch: 0, yaw: 0, gripper_open: true },
      { x: 0.8, y: 0.65, z: 0.3, roll: 0, pitch: 0, yaw: 0, gripper_open: false },
      { x: 0.8, y: 1.2, z: 0.3, roll: 0, pitch: 0, yaw: 0, gripper_open: false },
      { x: -0.6, y: 1.2, z: -0.3, roll: 0, pitch: 0, yaw: 0, gripper_open: false },
      { x: -0.6, y: 0.85, z: -0.3, roll: 0, pitch: 0, yaw: 0, gripper_open: true },
      { x: -0.6, y: 1.2, z: -0.3, roll: 0, pitch: 0, yaw: 0, gripper_open: true },
    ],
  },
  {
    command: "push the green sphere forward",
    keywords: ["push", "green", "sphere"],
    confirmation: "Pushing the green sphere forward along the table.",
    waypoints: [
      { x: 0.3, y: 0.75, z: -0.7, roll: 0, pitch: 0, yaw: 0, gripper_open: true },
      { x: 0.3, y: 0.67, z: -0.5, roll: 0, pitch: 0, yaw: 0, gripper_open: true },
      { x: 0.3, y: 0.67, z: 0.0, roll: 0, pitch: 0, yaw: 0, gripper_open: true },
      { x: 0.3, y: 1.2, z: 0.0, roll: 0, pitch: 0, yaw: 0, gripper_open: true },
    ],
  },
];

// ---------------------------------------------------------------------------
// Demo Service (singleton)
// ---------------------------------------------------------------------------

class DemoService {
  private _enabled = false;
  private handlers = new Set<(enabled: boolean) => void>();

  get enabled(): boolean {
    return this._enabled;
  }

  toggle(): void {
    this._enabled = !this._enabled;
    this.handlers.forEach((h) => h(this._enabled));
  }

  setEnabled(enabled: boolean): void {
    if (this._enabled === enabled) return;
    this._enabled = enabled;
    this.handlers.forEach((h) => h(this._enabled));
  }

  onChange(handler: (enabled: boolean) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  /**
   * Try to match a voice command against cached responses.
   * Returns null if no match found.
   */
  matchCommand(transcript: string): CachedResponse | null {
    if (!this._enabled) return null;
    const lower = transcript.toLowerCase();
    // Score each cached response by keyword matches
    let best: CachedResponse | null = null;
    let bestScore = 0;
    for (const resp of CACHED_RESPONSES) {
      const score = resp.keywords.filter((kw) => lower.includes(kw)).length;
      if (score > bestScore && score >= 2) {
        bestScore = score;
        best = resp;
      }
    }
    return best;
  }
}

export const demoService = new DemoService();

// ---------------------------------------------------------------------------
// DemoBadge — subtle indicator shown in header when demo mode is active
// ---------------------------------------------------------------------------

export function DemoBadge() {
  const [enabled, setEnabled] = useState(demoService.enabled);

  useEffect(() => {
    return demoService.onChange(setEnabled);
  }, []);

  if (!enabled) return null;

  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[9px] font-mono font-bold text-amber-400 animate-glow-pulse">
      DEMO
    </span>
  );
}

// ---------------------------------------------------------------------------
// DemoToggle — settings toggle for demo mode
// ---------------------------------------------------------------------------

export function DemoToggle() {
  const [enabled, setEnabled] = useState(demoService.enabled);

  useEffect(() => {
    return demoService.onChange(setEnabled);
  }, []);

  const handleToggle = useCallback(() => {
    demoService.toggle();
  }, []);

  return (
    <button
      onClick={handleToggle}
      className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[10px] font-mono transition-colors ${
        enabled
          ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
          : "border-white/[0.06] bg-kinesys-surface text-white/30 hover:text-white/50"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full transition-colors ${enabled ? "bg-amber-400" : "bg-white/15"}`} />
      Demo
    </button>
  );
}
