/**
 * KINESYS — Cyclic Coordinate Descent (CCD) Inverse Kinematics Solver
 *
 * Solves for joint angles of a 3-segment robotic arm given a target
 * end-effector position in 3D space.
 *
 * Arm structure:
 *   Joint 0 (base): Y-axis rotation (yaw)
 *   Joint 1 (shoulder): Z-axis rotation (pitch) — in the arm's local frame
 *   Joint 2 (elbow): Z-axis rotation (pitch) — in the arm's local frame
 */

import * as THREE from "three";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArmConfig {
  /** Length of the first arm segment (shoulder → elbow) in world units */
  segment1Length: number;
  /** Length of the second arm segment (elbow → wrist/end-effector) in world units */
  segment2Length: number;
  /** Height of the base/shoulder pivot above the ground */
  baseHeight: number;
  /** Joint angle limits in radians [min, max] */
  jointLimits: {
    base: [number, number];
    shoulder: [number, number];
    elbow: [number, number];
  };
}

export interface IKResult {
  /** Whether the solver converged to a valid solution */
  success: boolean;
  /** Joint angles in radians: [baseYaw, shoulderPitch, elbowPitch] */
  angles: [number, number, number];
  /** Distance from end-effector to target at solution */
  error: number;
  /** Number of iterations used */
  iterations: number;
}

// ---------------------------------------------------------------------------
// Default arm configuration
// ---------------------------------------------------------------------------

export const DEFAULT_ARM_CONFIG: ArmConfig = {
  segment1Length: 1.2,
  segment2Length: 1.0,
  baseHeight: 0.5,
  jointLimits: {
    base: [-Math.PI, Math.PI],
    shoulder: [-Math.PI * 0.1, Math.PI * 0.85],
    elbow: [-Math.PI * 0.9, Math.PI * 0.1],
  },
};

// ---------------------------------------------------------------------------
// CCD IK Solver
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 50;
const TOLERANCE = 0.01; // convergence tolerance in world units

/**
 * Compute forward kinematics — returns the end-effector position given
 * the current joint angles.
 */
export function forwardKinematics(
  angles: [number, number, number],
  config: ArmConfig = DEFAULT_ARM_CONFIG,
): THREE.Vector3 {
  const [baseYaw, shoulderPitch, elbowPitch] = angles;
  const { segment1Length, segment2Length, baseHeight } = config;

  // Shoulder pitch is measured from vertical (Y-up)
  const totalPitch1 = shoulderPitch;
  const totalPitch2 = totalPitch1 + elbowPitch;

  // Compute positions in the arm plane (radial, vertical)
  const r1 = segment1Length * Math.sin(totalPitch1);
  const y1 = segment1Length * Math.cos(totalPitch1);

  const r2 = r1 + segment2Length * Math.sin(totalPitch2);
  const y2 = y1 + segment2Length * Math.cos(totalPitch2);

  // Convert to 3D using base yaw
  const x = r2 * Math.cos(baseYaw);
  const z = r2 * Math.sin(baseYaw);
  const y = baseHeight + y2;

  return new THREE.Vector3(x, y, z);
}

/**
 * Analytical IK solver for a 2-segment arm with a rotating base.
 * Falls back to CCD if the analytical solution doesn't converge.
 */
export function solveIK(
  target: THREE.Vector3,
  currentAngles: [number, number, number] = [0, 0, 0],
  config: ArmConfig = DEFAULT_ARM_CONFIG,
): IKResult {
  const { segment1Length, segment2Length, baseHeight } = config;

  // Step 1: Compute base yaw from target x,z
  let baseYaw = Math.atan2(target.z, target.x);
  baseYaw = clampAngle(baseYaw, config.jointLimits.base);

  // Step 2: Project into the arm plane
  const radialDist = Math.sqrt(target.x * target.x + target.z * target.z);
  const verticalDist = target.y - baseHeight;

  const distSq = radialDist * radialDist + verticalDist * verticalDist;
  const dist = Math.sqrt(distSq);

  const L1 = segment1Length;
  const L2 = segment2Length;
  const maxReach = L1 + L2;
  const minReach = Math.abs(L1 - L2);

  // Check reachability
  if (dist > maxReach * 0.999) {
    // Target is at or beyond max reach — extend arm straight
    const shoulderPitch = Math.atan2(radialDist, verticalDist);
    const elbowPitch = 0;

    const angles: [number, number, number] = [
      baseYaw,
      clampAngle(shoulderPitch, config.jointLimits.shoulder),
      clampAngle(elbowPitch, config.jointLimits.elbow),
    ];

    const endPos = forwardKinematics(angles, config);
    return {
      success: false,
      angles,
      error: endPos.distanceTo(target),
      iterations: 0,
    };
  }

  if (dist < minReach * 1.001) {
    // Target is too close — fold the arm
    return solveCCD(target, currentAngles, config);
  }

  // Step 3: Analytical 2-link IK using law of cosines
  // Angle at the elbow (between segments)
  const cosElbow = (L1 * L1 + L2 * L2 - distSq) / (2 * L1 * L2);
  const clampedCosElbow = Math.max(-1, Math.min(1, cosElbow));
  const elbowAngle = Math.PI - Math.acos(clampedCosElbow);

  // Angle at the shoulder
  const cosAlpha = (L1 * L1 + distSq - L2 * L2) / (2 * L1 * dist);
  const clampedCosAlpha = Math.max(-1, Math.min(1, cosAlpha));
  const alpha = Math.acos(clampedCosAlpha);

  const phi = Math.atan2(radialDist, verticalDist);

  // Elbow-down solution (preferred)
  const shoulderPitch = phi - alpha;
  const elbowPitch = -elbowAngle;

  let angles: [number, number, number] = [
    baseYaw,
    clampAngle(shoulderPitch, config.jointLimits.shoulder),
    clampAngle(elbowPitch, config.jointLimits.elbow),
  ];

  const endPos = forwardKinematics(angles, config);
  const error = endPos.distanceTo(target);

  if (error < TOLERANCE) {
    return { success: true, angles, error, iterations: 0 };
  }

  // Elbow-up solution
  const shoulderPitch2 = phi + alpha;
  const elbowPitch2 = elbowAngle;

  const angles2: [number, number, number] = [
    baseYaw,
    clampAngle(shoulderPitch2, config.jointLimits.shoulder),
    clampAngle(elbowPitch2, config.jointLimits.elbow),
  ];

  const endPos2 = forwardKinematics(angles2, config);
  const error2 = endPos2.distanceTo(target);

  if (error2 < error) {
    angles = angles2;
    if (error2 < TOLERANCE) {
      return { success: true, angles, error: error2, iterations: 0 };
    }
  }

  // Fall back to CCD refinement if analytical solution has high error
  return solveCCD(target, angles, config);
}

/**
 * CCD iterative solver — used as fallback / refinement.
 */
export function solveCCD(
  target: THREE.Vector3,
  initialAngles: [number, number, number] = [0, 0, 0],
  config: ArmConfig = DEFAULT_ARM_CONFIG,
): IKResult {
  const angles: [number, number, number] = [...initialAngles];
  const limits = [config.jointLimits.base, config.jointLimits.shoulder, config.jointLimits.elbow];

  let bestError = Infinity;
  let bestAngles: [number, number, number] = [...angles];

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    // Iterate joints from end-effector back to base
    for (let joint = 2; joint >= 0; joint--) {
      const step = 0.02;

      // Compute gradient numerically
      const currentError = forwardKinematics(angles, config).distanceTo(target);

      if (currentError < TOLERANCE) {
        return { success: true, angles: [...angles], error: currentError, iterations: iter };
      }

      if (currentError < bestError) {
        bestError = currentError;
        bestAngles = [...angles];
      }

      const saved = angles[joint]!;

      angles[joint] = saved + step;
      const errorPlus = forwardKinematics(angles, config).distanceTo(target);

      angles[joint] = saved - step;
      const errorMinus = forwardKinematics(angles, config).distanceTo(target);

      // Choose the direction that reduces error
      if (errorPlus < errorMinus && errorPlus < currentError) {
        angles[joint] = clampAngle(saved + step, limits[joint]!);
      } else if (errorMinus < currentError) {
        angles[joint] = clampAngle(saved - step, limits[joint]!);
      } else {
        angles[joint] = saved;
      }
    }

    const finalError = forwardKinematics(angles, config).distanceTo(target);
    if (finalError < TOLERANCE) {
      return { success: true, angles: [...angles], error: finalError, iterations: iter + 1 };
    }
  }

  return {
    success: bestError < TOLERANCE * 5,
    angles: bestAngles,
    error: bestError,
    iterations: MAX_ITERATIONS,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampAngle(angle: number, limits: [number, number]): number {
  return Math.max(limits[0], Math.min(limits[1], angle));
}

/**
 * Linearly interpolate between two angle sets.
 */
export function lerpAngles(
  from: [number, number, number],
  to: [number, number, number],
  t: number,
): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  return [
    from[0] + (to[0] - from[0]) * clamped,
    from[1] + (to[1] - from[1]) * clamped,
    from[2] + (to[2] - from[2]) * clamped,
  ];
}
