/**
 * KINESYS — Robotic Arm Controller
 *
 * Provides a high-level imperative API for controlling the simulated
 * robotic arm. The controller manages:
 *   - Target position → IK solving → smooth joint interpolation
 *   - Gripper open/close state with physics constraint management
 *   - End-effector position tracking
 *   - Animation queue for sequential movements
 */

import * as THREE from "three";
import {
  solveIK,
  forwardKinematics,
  DEFAULT_ARM_CONFIG,
  type ArmConfig,
  type IKResult,
} from "./ikSolver";
import { isWithinWorkspace } from "./physics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GripperState = "open" | "closed" | "opening" | "closing";

export interface ArmState {
  /** Current joint angles [baseYaw, shoulderPitch, elbowPitch] */
  jointAngles: [number, number, number];
  /** Target joint angles being interpolated toward */
  targetAngles: [number, number, number];
  /** Current end-effector world position */
  endEffectorPosition: THREE.Vector3;
  /** Gripper state */
  gripperState: GripperState;
  /** Gripper openness 0 = closed, 1 = fully open */
  gripperOpenness: number;
  /** Whether the arm is currently moving */
  isMoving: boolean;
  /** ID of the currently held object, if any */
  heldObjectId: string | null;
}

export type ArmStateListener = (state: ArmState) => void;

interface MovementCommand {
  targetAngles: [number, number, number];
  speed: number;
  resolve: () => void;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

const INTERPOLATION_SPEED = 2.0; // radians per second base speed
const GRIPPER_SPEED = 4.0; // openness units per second

class ArmController {
  private config: ArmConfig;
  private state: ArmState;
  private listeners: Set<ArmStateListener> = new Set();
  private commandQueue: MovementCommand[] = [];
  private currentCommand: MovementCommand | null = null;

  constructor(config: ArmConfig = DEFAULT_ARM_CONFIG) {
    this.config = config;

    const initialAngles: [number, number, number] = [0, 0.3, -0.5];

    this.state = {
      jointAngles: [...initialAngles],
      targetAngles: [...initialAngles],
      endEffectorPosition: forwardKinematics(initialAngles, config),
      gripperState: "open",
      gripperOpenness: 1,
      isMoving: false,
      heldObjectId: null,
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Move the end-effector to a target world position.
   * Returns a promise that resolves when the movement completes.
   */
  moveToPosition(x: number, y: number, z: number, speed = 1.0): Promise<void> {
    const target = new THREE.Vector3(x, y, z);

    if (!isWithinWorkspace(target)) {
      console.warn("[ArmController] Target outside workspace bounds:", target);
      return Promise.reject(new Error("Target outside workspace bounds"));
    }

    const result: IKResult = solveIK(target, this.state.jointAngles, this.config);

    if (!result.success && result.error > 0.1) {
      console.warn("[ArmController] IK solver failed. Error:", result.error);
      return Promise.reject(new Error(`IK solver failed with error ${result.error.toFixed(3)}`));
    }

    return new Promise<void>((resolve) => {
      this.commandQueue.push({
        targetAngles: result.angles,
        speed,
        resolve,
      });
    });
  }

  /**
   * Set joint angles directly (bypasses IK).
   */
  setJointAngles(angles: [number, number, number], speed = 1.0): Promise<void> {
    return new Promise<void>((resolve) => {
      this.commandQueue.push({
        targetAngles: [...angles],
        speed,
        resolve,
      });
    });
  }

  /** Open the gripper. */
  openGripper(): void {
    this.state.gripperState = "opening";
    this.state.heldObjectId = null;
    this.emit();
  }

  /** Close the gripper. Optionally specify the ID of the object being grasped. */
  closeGripper(objectId?: string): void {
    this.state.gripperState = "closing";
    if (objectId) {
      this.state.heldObjectId = objectId;
    }
    this.emit();
  }

  /** Get the current end-effector position. */
  getEndEffectorPosition(): THREE.Vector3 {
    return this.state.endEffectorPosition.clone();
  }

  /** Get the full current state (read-only copy). */
  getState(): Readonly<ArmState> {
    return { ...this.state, endEffectorPosition: this.state.endEffectorPosition.clone() };
  }

  /** Subscribe to state changes. Returns unsubscribe function. */
  onStateChange(listener: ArmStateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Get arm configuration. */
  getConfig(): Readonly<ArmConfig> {
    return this.config;
  }

  // -----------------------------------------------------------------------
  // Update loop — called every frame from the React component
  // -----------------------------------------------------------------------

  /**
   * Advance the arm simulation by `dt` seconds.
   * Call this from `useFrame` at 60fps.
   */
  update(dt: number): void {
    let changed = false;

    // Process command queue
    if (!this.currentCommand && this.commandQueue.length > 0) {
      this.currentCommand = this.commandQueue.shift()!;
      this.state.targetAngles = this.currentCommand.targetAngles;
      this.state.isMoving = true;
      changed = true;
    }

    // Interpolate joint angles toward target
    if (this.currentCommand) {
      const speed = INTERPOLATION_SPEED * this.currentCommand.speed * dt;
      const prev = [...this.state.jointAngles] as [number, number, number];
      let allDone = true;

      for (let i = 0; i < 3; i++) {
        const diff = this.state.targetAngles[i]! - this.state.jointAngles[i]!;
        if (Math.abs(diff) > 0.001) {
          allDone = false;
          const step = Math.sign(diff) * Math.min(Math.abs(diff), speed);
          this.state.jointAngles[i] = this.state.jointAngles[i]! + step;
        }
      }

      if (
        prev[0] !== this.state.jointAngles[0] ||
        prev[1] !== this.state.jointAngles[1] ||
        prev[2] !== this.state.jointAngles[2]
      ) {
        changed = true;
      }

      if (allDone) {
        this.state.isMoving = this.commandQueue.length > 0;
        this.currentCommand.resolve();
        this.currentCommand = null;
        changed = true;
      }
    }

    // Update gripper
    const gripperChanged = this.updateGripper(dt);

    // Update end-effector position
    this.state.endEffectorPosition = forwardKinematics(this.state.jointAngles, this.config);

    if (changed || gripperChanged) {
      this.emit();
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private updateGripper(dt: number): boolean {
    const speed = GRIPPER_SPEED * dt;

    if (this.state.gripperState === "opening") {
      this.state.gripperOpenness = Math.min(1, this.state.gripperOpenness + speed);
      if (this.state.gripperOpenness >= 1) {
        this.state.gripperState = "open";
      }
      return true;
    }

    if (this.state.gripperState === "closing") {
      this.state.gripperOpenness = Math.max(0, this.state.gripperOpenness - speed);
      if (this.state.gripperOpenness <= 0) {
        this.state.gripperState = "closed";
      }
      return true;
    }

    return false;
  }

  private emit(): void {
    const snapshot = this.getState();
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (err) {
        console.error("[ArmController] Listener error:", err);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const armController = new ArmController();
export default armController;
