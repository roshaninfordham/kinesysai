/**
 * KINESYS — Puzzle Configuration
 *
 * Defines 5 puzzle levels with:
 *   - Initial object positions
 *   - Success condition (function checking scene state)
 *   - Par time (seconds) and par actions (minimum actions)
 *   - Metadata (name, description, difficulty, icon, recommended mode)
 */

import type { SceneObjectDef } from "../engine/physics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SceneSnapshot {
  objects: Array<{
    id: string;
    position: [number, number, number];
    color: string;
    shape: string;
    size: number[];
  }>;
  gripperOpen: boolean;
  heldObjectId: string | null;
}

export type SuccessCondition = (scene: SceneSnapshot) => boolean;

export interface PuzzleLevel {
  id: number;
  name: string;
  subtitle: string;
  description: string;
  icon: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  recommendedMode: "Command" | "Teach" | "Guide";
  parTime: number;       // seconds
  parActions: number;    // minimum actions to solve
  objects: SceneObjectDef[];
  successCondition: SuccessCondition;
  hints: string[];
  starThresholds: [number, number, number]; // [1-star, 2-star, 3-star] minimum scores
}

// ---------------------------------------------------------------------------
// Helper: bounding box center X for an object
// ---------------------------------------------------------------------------

function objX(scene: SceneSnapshot, id: string): number | null {
  const obj = scene.objects.find((o) => o.id === id);
  return obj ? obj.position[0] : null;
}

function objY(scene: SceneSnapshot, id: string): number | null {
  const obj = scene.objects.find((o) => o.id === id);
  return obj ? obj.position[1] : null;
}


// ---------------------------------------------------------------------------
// Puzzle Levels
// ---------------------------------------------------------------------------

export const PUZZLES: PuzzleLevel[] = [
  // ─── Level 1: First Contact ───
  {
    id: 1,
    name: "First Contact",
    subtitle: "Place any object in the target zone",
    description:
      "Move any single object to the center of the table. This teaches basic voice commands or hand teleoperation.",
    icon: "🎯",
    difficulty: 1,
    recommendedMode: "Command",
    parTime: 30,
    parActions: 2,
    objects: [
      { id: "red_cube", shape: "box", color: "#ef4444", size: [0.2, 0.2, 0.2], position: [0.8, 0.65, 0.3], mass: 0.5 },
      { id: "target_zone", shape: "box", color: "#22c55e", size: [0.4, 0.02, 0.4], position: [0, 0.51, 0], mass: 0 },
    ],
    successCondition: (scene) => {
      // Any movable object is near table center
      const movable = scene.objects.filter((o) => o.id !== "target_zone");
      return movable.some(
        (o) =>
          Math.abs(o.position[0]) < 0.3 &&
          Math.abs(o.position[2]) < 0.3 &&
          o.position[1] > 0.45,
      );
    },
    hints: [
      "Try saying: 'Pick up the red cube and place it in the center'",
      "Or use Guide Mode to physically move it with your hand",
    ],
    starThresholds: [200, 400, 600],
  },

  // ─── Level 2: Color Sort ───
  {
    id: 2,
    name: "Color Sort",
    subtitle: "Arrange objects left-to-right: Red, Green, Blue",
    description:
      "Sort the colored objects so red is on the left, green in the middle, and blue on the right.",
    icon: "🌈",
    difficulty: 2,
    recommendedMode: "Command",
    parTime: 60,
    parActions: 6,
    objects: [
      { id: "red_cube", shape: "box", color: "#ef4444", size: [0.18, 0.18, 0.18], position: [0.5, 0.64, 0], mass: 0.4 },
      { id: "green_cube", shape: "box", color: "#22c55e", size: [0.18, 0.18, 0.18], position: [-0.6, 0.64, 0.2], mass: 0.4 },
      { id: "blue_cube", shape: "box", color: "#3b82f6", size: [0.18, 0.18, 0.18], position: [0.1, 0.64, -0.4], mass: 0.4 },
    ],
    successCondition: (scene) => {
      const rx = objX(scene, "red_cube");
      const gx = objX(scene, "green_cube");
      const bx = objX(scene, "blue_cube");
      if (rx === null || gx === null || bx === null) return false;
      // Red leftmost, then green, then blue rightmost
      return rx < gx && gx < bx;
    },
    hints: [
      "Red should be leftmost (negative X), blue rightmost (positive X)",
      "Try: 'Move the red cube to the left side of the table'",
    ],
    starThresholds: [250, 450, 650],
  },

  // ─── Level 3: Size Matters ───
  {
    id: 3,
    name: "Size Matters",
    subtitle: "Stack objects by size — largest on bottom",
    description:
      "Stack the three cubes on top of each other with the largest on the bottom and smallest on top.",
    icon: "📐",
    difficulty: 3,
    recommendedMode: "Command",
    parTime: 90,
    parActions: 8,
    objects: [
      { id: "large_cube", shape: "box", color: "#f97316", size: [0.28, 0.28, 0.28], position: [-0.5, 0.64, 0.3], mass: 0.6 },
      { id: "medium_cube", shape: "box", color: "#a855f7", size: [0.2, 0.2, 0.2], position: [0.4, 0.60, -0.2], mass: 0.4 },
      { id: "small_cube", shape: "box", color: "#ef4444", size: [0.14, 0.14, 0.14], position: [0.1, 0.57, 0.5], mass: 0.25 },
    ],
    successCondition: (scene) => {
      const ly = objY(scene, "large_cube");
      const my = objY(scene, "medium_cube");
      const sy = objY(scene, "small_cube");
      if (ly === null || my === null || sy === null) return false;
      // Large is lowest, medium in middle, small on top
      // They must also be roughly co-located in X/Z (stacked)
      const lx = objX(scene, "large_cube")!;
      const mx = objX(scene, "medium_cube")!;
      const sx = objX(scene, "small_cube")!;
      const lObj = scene.objects.find((o) => o.id === "large_cube")!;
      const mObj = scene.objects.find((o) => o.id === "medium_cube")!;
      const sObj = scene.objects.find((o) => o.id === "small_cube")!;

      const xAligned =
        Math.abs(lx - mx) < 0.2 &&
        Math.abs(mx - sx) < 0.2;
      const zAligned =
        Math.abs(lObj.position[2] - mObj.position[2]) < 0.2 &&
        Math.abs(mObj.position[2] - sObj.position[2]) < 0.2;
      const yOrdered = ly < my && my < sy;

      return xAligned && zAligned && yOrdered;
    },
    hints: [
      "Place the large orange cube first, then stack medium purple, then small red on top",
      "Make sure they're aligned vertically — the AI checks X and Z alignment",
    ],
    starThresholds: [200, 400, 600],
  },

  // ─── Level 4: Mirror Match ───
  {
    id: 4,
    name: "Mirror Match",
    subtitle: "Replicate the shown arrangement using Teach Mode",
    description:
      "A target arrangement is shown. Use Teach Mode to demonstrate the pick-and-place sequence, then have the AI reproduce it.",
    icon: "🪞",
    difficulty: 4,
    recommendedMode: "Teach",
    parTime: 120,
    parActions: 10,
    objects: [
      { id: "red_cube", shape: "box", color: "#ef4444", size: [0.18, 0.18, 0.18], position: [0.6, 0.64, 0.5], mass: 0.4 },
      { id: "blue_cylinder", shape: "cylinder", color: "#3b82f6", size: [0.1, 0.25], position: [-0.4, 0.68, -0.3], mass: 0.3 },
      { id: "green_sphere", shape: "sphere", color: "#22c55e", size: [0.12], position: [0.2, 0.67, -0.5], mass: 0.2 },
    ],
    successCondition: (scene) => {
      // Target positions: red at (-0.5, _, 0), blue at (0, _, 0), green at (0.5, _, 0)
      // All in a row along X, centered at Z=0
      const r = scene.objects.find((o) => o.id === "red_cube");
      const b = scene.objects.find((o) => o.id === "blue_cylinder");
      const g = scene.objects.find((o) => o.id === "green_sphere");
      if (!r || !b || !g) return false;

      const tolerance = 0.25;
      const redOk =
        Math.abs(r.position[0] - -0.5) < tolerance && Math.abs(r.position[2]) < tolerance;
      const blueOk =
        Math.abs(b.position[0]) < tolerance && Math.abs(b.position[2]) < tolerance;
      const greenOk =
        Math.abs(g.position[0] - 0.5) < tolerance && Math.abs(g.position[2]) < tolerance;

      return redOk && blueOk && greenOk;
    },
    hints: [
      "Target: Red at left (-0.5, 0), Blue at center (0, 0), Green at right (0.5, 0)",
      "Use Teach Mode: demonstrate picking each object and placing it in position",
    ],
    starThresholds: [200, 350, 550],
  },

  // ─── Level 5: Freestyle ───
  {
    id: 5,
    name: "Freestyle",
    subtitle: "Build anything creative using Guide Mode",
    description:
      "No rules — use Guide Mode hand teleoperation to build the most creative arrangement you can. Score is based on how many objects you move and how efficiently you do it.",
    icon: "🎨",
    difficulty: 5,
    recommendedMode: "Guide",
    parTime: 180,
    parActions: 12,
    objects: [
      { id: "red_cube", shape: "box", color: "#ef4444", size: [0.18, 0.18, 0.18], position: [0.7, 0.64, 0.4], mass: 0.4 },
      { id: "blue_cylinder", shape: "cylinder", color: "#3b82f6", size: [0.1, 0.25], position: [-0.5, 0.68, 0.5], mass: 0.3 },
      { id: "green_sphere", shape: "sphere", color: "#22c55e", size: [0.12], position: [0.3, 0.67, -0.5], mass: 0.2 },
      { id: "yellow_box", shape: "box", color: "#eab308", size: [0.22, 0.15, 0.18], position: [-0.6, 0.63, -0.3], mass: 0.35 },
      { id: "purple_cube", shape: "box", color: "#a855f7", size: [0.15, 0.15, 0.15], position: [0.5, 0.63, 0.7], mass: 0.3 },
    ],
    successCondition: (scene) => {
      // Freestyle: success if at least 3 objects have been moved from their start positions
      const starts: Record<string, [number, number, number]> = {
        red_cube: [0.7, 0.64, 0.4],
        blue_cylinder: [-0.5, 0.68, 0.5],
        green_sphere: [0.3, 0.67, -0.5],
        yellow_box: [-0.6, 0.63, -0.3],
        purple_cube: [0.5, 0.63, 0.7],
      };

      let movedCount = 0;
      for (const obj of scene.objects) {
        const start = starts[obj.id];
        if (!start) continue;
        const dist = Math.sqrt(
          (obj.position[0] - start[0]) ** 2 +
          (obj.position[2] - start[2]) ** 2,
        );
        if (dist > 0.15) movedCount++;
      }
      return movedCount >= 3;
    },
    hints: [
      "Move at least 3 objects to new positions — be creative!",
      "Use Guide Mode for direct hand control — pinch to grab, release to place",
    ],
    starThresholds: [150, 350, 550],
  },
];

export function getPuzzle(id: number): PuzzleLevel | undefined {
  return PUZZLES.find((p) => p.id === id);
}
