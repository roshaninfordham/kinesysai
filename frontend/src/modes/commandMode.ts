/**
 * KINESYS — Command Mode Orchestrator
 *
 * Manages the full voice-to-action pipeline on the frontend:
 *   1. Receives voice transcript → sends to backend via WebSocket
 *   2. Receives action plan + waypoints from backend
 *   3. Animates the arm through waypoints using IK solver
 *   4. Speaks confirmation via TTS on completion
 *
 * Pipeline states: IDLE → LISTENING → THINKING → PLANNING → EXECUTING → DONE
 */

import armController from "../engine/armController";
import wsService, { type WSMessage } from "../services/websocketService";
import ttsService from "../services/ttsService";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PipelineState =
  | "IDLE"
  | "LISTENING"
  | "THINKING"
  | "PLANNING"
  | "VALIDATING"
  | "EXECUTING"
  | "DONE"
  | "ERROR";

export type PipelineStateHandler = (state: PipelineState) => void;
export type NarrationHandler = (text: string) => void;

export interface ActionStep {
  action: string;
  params: Record<string, unknown>;
  narration: string;
  waypoint_count: number;
}

export interface Waypoint {
  x: number;
  y: number;
  z: number;
  roll: number;
  pitch: number;
  yaw: number;
  gripper_open: boolean;
}

export interface PlanResponse {
  type: string;
  plan: {
    is_valid: boolean;
    error: string | null;
    step_count: number;
    total_waypoints: number;
    narration: string[];
    steps: ActionStep[];
  };
  waypoints: Waypoint[];
  confirmation: string;
}

// ---------------------------------------------------------------------------
// Command Mode Controller
// ---------------------------------------------------------------------------

const WAYPOINT_DURATION_MS = 500; // Time per waypoint interpolation

class CommandMode {
  private state: PipelineState = "IDLE";
  private stateHandlers: Set<PipelineStateHandler> = new Set();
  private narrationHandlers: Set<NarrationHandler> = new Set();
  private executing = false;

  constructor() {
    this.setupWebSocketListener();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Send a voice command to the backend for processing. */
  sendCommand(transcript: string): void {
    if (this.executing) {
      ttsService.speak("I'm still executing the previous command. Please wait.");
      return;
    }

    this.setState("THINKING");
    this.emitNarration(`Processing: "${transcript}"`);

    // Send scene state along with the command
    const sceneState = this.captureSceneState();

    wsService.send({
      type: "voice_command",
      command: transcript,
      scene: sceneState,
    });
  }

  /** Get current pipeline state. */
  getState(): PipelineState {
    return this.state;
  }

  /** Subscribe to pipeline state changes. */
  onStateChange(handler: PipelineStateHandler): () => void {
    this.stateHandlers.add(handler);
    handler(this.state);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  /** Subscribe to narration events (for UI display). */
  onNarration(handler: NarrationHandler): () => void {
    this.narrationHandlers.add(handler);
    return () => {
      this.narrationHandlers.delete(handler);
    };
  }

  /** Reset to idle state. */
  reset(): void {
    this.executing = false;
    this.setState("IDLE");
  }

  /** Set the pipeline to LISTENING state (called when mic starts). */
  setListening(): void {
    if (!this.executing) {
      this.setState("LISTENING");
    }
  }

  // -----------------------------------------------------------------------
  // WebSocket message handling
  // -----------------------------------------------------------------------

  private setupWebSocketListener(): void {
    wsService.onMessage((msg: WSMessage) => {
      switch (msg.type) {
        case "plan_result":
          this.handlePlanResult(msg as unknown as PlanResponse);
          break;
        case "plan_error":
          this.handlePlanError(msg as WSMessage & { error: string });
          break;
        case "status_update":
          if (typeof msg.state === "string") {
            this.setState(msg.state as PipelineState);
          }
          break;
      }
    });
  }

  private async handlePlanResult(response: PlanResponse): Promise<void> {
    const plan = response.plan;

    if (!plan.is_valid) {
      this.setState("ERROR");
      const errorMsg = plan.error ?? "Plan validation failed";
      this.emitNarration(`Error: ${errorMsg}`);
      ttsService.speak(`Sorry, I couldn't do that. ${errorMsg}`);
      setTimeout(() => this.setState("IDLE"), 3000);
      return;
    }

    // Narrate what we're about to do
    if (plan.narration.length > 0) {
      const summary = plan.narration.join(", then ");
      this.emitNarration(`Plan: ${summary}`);
      ttsService.speak(`OK. ${summary}.`);
    }

    // Execute waypoints
    this.setState("EXECUTING");
    this.executing = true;

    try {
      await this.executeWaypoints(response.waypoints, plan.steps);

      this.setState("DONE");
      const confirmation = response.confirmation ?? "Done.";
      this.emitNarration(confirmation);
      ttsService.speak(confirmation);
    } catch (err) {
      this.setState("ERROR");
      const msg = err instanceof Error ? err.message : "Execution failed";
      this.emitNarration(`Execution error: ${msg}`);
      ttsService.speak(`Sorry, execution failed. ${msg}`);
    } finally {
      this.executing = false;
      setTimeout(() => this.setState("IDLE"), 2000);
    }
  }

  private handlePlanError(msg: WSMessage & { error: string }): void {
    this.setState("ERROR");
    this.emitNarration(`Error: ${msg.error}`);
    ttsService.speak(`Sorry, something went wrong. ${msg.error}`);
    setTimeout(() => this.setState("IDLE"), 3000);
  }

  // -----------------------------------------------------------------------
  // Waypoint execution
  // -----------------------------------------------------------------------

  private async executeWaypoints(
    waypoints: Waypoint[],
    steps: ActionStep[],
  ): Promise<void> {
    if (!waypoints || waypoints.length === 0) {
      return;
    }

    // Track which step we're on for narration
    let waypointIndex = 0;
    let currentStepIdx = 0;
    let waypointsInCurrentStep = 0;

    for (const wp of waypoints) {
      // Determine if we've moved to a new action step
      if (steps.length > 0 && currentStepIdx < steps.length) {
        const step = steps[currentStepIdx]!;
        waypointsInCurrentStep++;
        if (waypointsInCurrentStep > step.waypoint_count) {
          currentStepIdx++;
          waypointsInCurrentStep = 1;
          if (currentStepIdx < steps.length) {
            const newStep = steps[currentStepIdx]!;
            this.emitNarration(`Executing: ${newStep.narration}`);
          }
        }
      }

      // Handle gripper state changes
      if (wp.gripper_open) {
        armController.openGripper();
      } else {
        armController.closeGripper();
      }

      // Move arm to waypoint position via IK
      try {
        await armController.moveToPosition(wp.x, wp.y, wp.z, 1.0);
      } catch {
        // IK may fail for some waypoints — continue to next
        console.warn(`[CommandMode] IK failed for waypoint ${waypointIndex}, skipping`);
      }

      // Wait for interpolation
      await sleep(WAYPOINT_DURATION_MS);
      waypointIndex++;
    }
  }

  // -----------------------------------------------------------------------
  // Scene state capture (sent to backend with commands)
  // -----------------------------------------------------------------------

  private captureSceneState(): Record<string, unknown> {
    const armState = armController.getState();

    // Default scene objects — in a full implementation this would come
    // from the Three.js scene via a scene manager
    return {
      objects: [
        {
          id: "red_cube",
          shape: "box",
          color: "red",
          position: [0.8, 0.65, 0.3],
          size: [0.2, 0.2, 0.2],
          mass: 0.5,
        },
        {
          id: "blue_cylinder",
          shape: "cylinder",
          color: "blue",
          position: [-0.5, 0.7, 0.6],
          size: [0.1, 0.3],
          mass: 0.3,
        },
        {
          id: "green_sphere",
          shape: "sphere",
          color: "green",
          position: [0.3, 0.67, -0.5],
          size: [0.12],
          mass: 0.2,
        },
        {
          id: "yellow_box",
          shape: "box",
          color: "yellow",
          position: [-0.6, 0.625, -0.3],
          size: [0.25, 0.15, 0.18],
          mass: 0.4,
        },
        {
          id: "purple_cube",
          shape: "box",
          color: "purple",
          position: [0.5, 0.625, 0.7],
          size: [0.15, 0.15, 0.15],
          mass: 0.35,
        },
        {
          id: "orange_cylinder",
          shape: "cylinder",
          color: "orange",
          position: [-0.2, 0.675, 0.4],
          size: [0.08, 0.25],
          mass: 0.25,
        },
      ],
      end_effector: [
        armState.endEffectorPosition.x,
        armState.endEffectorPosition.y,
        armState.endEffectorPosition.z,
      ],
      gripper_open: armState.gripperState === "open",
      held_object_id: armState.heldObjectId,
      table_height: 0.5,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private setState(state: PipelineState): void {
    if (this.state === state) return;
    this.state = state;
    this.stateHandlers.forEach((h) => h(state));
  }

  private emitNarration(text: string): void {
    this.narrationHandlers.forEach((h) => h(text));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const commandMode = new CommandMode();
export default commandMode;
