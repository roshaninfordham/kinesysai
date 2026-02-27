/**
 * KINESYS — Physics Engine Configuration & Utilities
 *
 * Provides shared physics constants, material definitions, and helper
 * functions for the Cannon-es physics simulation.
 */

// ---------------------------------------------------------------------------
// Physics Constants
// ---------------------------------------------------------------------------

export const GRAVITY: [number, number, number] = [0, -9.81, 0];
export const PHYSICS_STEP = 1 / 60;
export const PHYSICS_ITERATIONS = 10;

// ---------------------------------------------------------------------------
// Material Properties
// ---------------------------------------------------------------------------

export interface PhysicsMaterialDef {
  friction: number;
  restitution: number;
}

export const MATERIALS: Record<string, PhysicsMaterialDef> = {
  table: { friction: 0.6, restitution: 0.1 },
  object: { friction: 0.4, restitution: 0.3 },
  gripper: { friction: 0.8, restitution: 0.0 },
  ground: { friction: 0.5, restitution: 0.1 },
};

// ---------------------------------------------------------------------------
// Scene Object Definitions
// ---------------------------------------------------------------------------

export type ObjectShape = "box" | "sphere" | "cylinder";

export interface SceneObjectDef {
  id: string;
  shape: ObjectShape;
  color: string;
  /** [width, height, depth] for box; [radius, height] for sphere/cylinder */
  size: number[];
  position: [number, number, number];
  mass: number;
}

export const DEFAULT_SCENE_OBJECTS: SceneObjectDef[] = [
  {
    id: "red_cube",
    shape: "box",
    color: "#ef4444",
    size: [0.2, 0.2, 0.2],
    position: [0.8, 0.65, 0.3],
    mass: 0.5,
  },
  {
    id: "blue_cylinder",
    shape: "cylinder",
    color: "#3b82f6",
    size: [0.1, 0.3],
    position: [-0.5, 0.7, 0.6],
    mass: 0.3,
  },
  {
    id: "green_sphere",
    shape: "sphere",
    color: "#22c55e",
    size: [0.12],
    position: [0.3, 0.67, -0.5],
    mass: 0.2,
  },
  {
    id: "yellow_box",
    shape: "box",
    color: "#eab308",
    size: [0.25, 0.15, 0.18],
    position: [-0.6, 0.625, -0.3],
    mass: 0.4,
  },
  {
    id: "purple_cube",
    shape: "box",
    color: "#a855f7",
    size: [0.15, 0.15, 0.15],
    position: [0.5, 0.625, 0.7],
    mass: 0.35,
  },
  {
    id: "orange_cylinder",
    shape: "cylinder",
    color: "#f97316",
    size: [0.08, 0.25],
    position: [-0.2, 0.675, 0.4],
    mass: 0.25,
  },
];

// ---------------------------------------------------------------------------
// Table Definition
// ---------------------------------------------------------------------------

export const TABLE = {
  position: [0, 0.25, 0] as [number, number, number],
  size: [2.5, 0.5, 2.0] as [number, number, number],
  color: "#475569",
  legColor: "#334155",
};

// ---------------------------------------------------------------------------
// Workspace Bounds (safety constraint)
// ---------------------------------------------------------------------------

export const WORKSPACE_BOUNDS = {
  x: [-1.5, 1.5] as [number, number],
  y: [0.0, 3.0] as [number, number],
  z: [-1.5, 1.5] as [number, number],
};

/**
 * Check if a position is within the robot's workspace bounds.
 */
export function isWithinWorkspace(pos: { x: number; y: number; z: number }): boolean {
  return (
    pos.x >= WORKSPACE_BOUNDS.x[0] &&
    pos.x <= WORKSPACE_BOUNDS.x[1] &&
    pos.y >= WORKSPACE_BOUNDS.y[0] &&
    pos.y <= WORKSPACE_BOUNDS.y[1] &&
    pos.z >= WORKSPACE_BOUNDS.z[0] &&
    pos.z <= WORKSPACE_BOUNDS.z[1]
  );
}
