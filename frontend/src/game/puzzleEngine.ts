/**
 * KINESYS — Puzzle Engine
 *
 * State machine managing puzzle lifecycle:
 *   IDLE → SELECTING → READY → PLAYING → CHECKING → COMPLETE / FAILED
 *
 * Responsibilities:
 *   - Set up scene objects for the selected puzzle
 *   - Run a timer and count actions during play
 *   - Periodically check success condition against current scene state
 *   - Calculate score on completion
 *   - Manage transitions and expose reactive state for UI
 */

import {
  PUZZLES,
  getPuzzle,
  type PuzzleLevel,
  type SceneSnapshot,
} from "./puzzleConfig";
import {
  calculateScore,
  addToLeaderboard,
  type ScoreBreakdown,
} from "./scoreCalculator";
import commandMode from "../modes/commandMode";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PuzzlePhase =
  | "IDLE"
  | "SELECTING"
  | "READY"
  | "PLAYING"
  | "CHECKING"
  | "COMPLETE"
  | "FAILED";

export interface PuzzleState {
  phase: PuzzlePhase;
  activePuzzle: PuzzleLevel | null;
  elapsedMs: number;
  actionCount: number;
  lastScore: ScoreBreakdown | null;
  completedPuzzles: Set<number>;
}

export type PuzzleStateHandler = (state: PuzzleState) => void;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const CHECK_INTERVAL_MS = 1000; // Check success condition every 1s

class PuzzleEngine {
  private phase: PuzzlePhase = "IDLE";
  private activePuzzle: PuzzleLevel | null = null;
  private elapsedMs = 0;
  private actionCount = 0;
  private lastScore: ScoreBreakdown | null = null;
  private completedPuzzles = new Set<number>();

  private timerHandle: ReturnType<typeof setInterval> | null = null;
  private checkHandle: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  private handlers = new Set<PuzzleStateHandler>();
  private unsubCommandMode: (() => void) | null = null;

  // Scene snapshot provider — set by the component that owns the 3D scene
  private sceneProvider: (() => SceneSnapshot) | null = null;

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Register a function that provides the current scene state. */
  setSceneProvider(provider: () => SceneSnapshot): void {
    this.sceneProvider = provider;
  }

  /** Open puzzle selection screen. */
  openSelection(): void {
    this.setPhase("SELECTING");
  }

  /** Select and prepare a puzzle. */
  selectPuzzle(id: number): void {
    const puzzle = getPuzzle(id);
    if (!puzzle) return;
    this.activePuzzle = puzzle;
    this.elapsedMs = 0;
    this.actionCount = 0;
    this.lastScore = null;
    this.setPhase("READY");
  }

  /** Start the active puzzle. */
  startPuzzle(): void {
    if (!this.activePuzzle || this.phase !== "READY") return;
    this.elapsedMs = 0;
    this.actionCount = 0;
    this.startTime = Date.now();

    // Start timer
    this.timerHandle = setInterval(() => {
      this.elapsedMs = Date.now() - this.startTime;
      this.emit();
    }, 100);

    // Start success condition checking
    this.checkHandle = setInterval(() => {
      this.checkSuccess();
    }, CHECK_INTERVAL_MS);

    // Count actions from command mode
    this.unsubCommandMode = commandMode.onStateChange((state) => {
      if (this.phase === "PLAYING" && state === "EXECUTING") {
        this.actionCount++;
        this.emit();
      }
    });

    this.setPhase("PLAYING");
  }

  /** Manually complete (for freestyle / manual check). */
  manualComplete(): void {
    if (this.phase !== "PLAYING") return;
    this.finishPuzzle(true);
  }

  /** Give up on the current puzzle. */
  giveUp(): void {
    if (this.phase !== "PLAYING" && this.phase !== "READY") return;
    this.stopTimers();
    this.finishPuzzle(false);
  }

  /** Return to puzzle selection. */
  backToSelection(): void {
    this.stopTimers();
    this.activePuzzle = null;
    this.lastScore = null;
    this.setPhase("SELECTING");
  }

  /** Close puzzle mode entirely. */
  close(): void {
    this.stopTimers();
    this.activePuzzle = null;
    this.lastScore = null;
    this.setPhase("IDLE");
  }

  /** Get current state. */
  getState(): PuzzleState {
    return {
      phase: this.phase,
      activePuzzle: this.activePuzzle,
      elapsedMs: this.elapsedMs,
      actionCount: this.actionCount,
      lastScore: this.lastScore,
      completedPuzzles: new Set(this.completedPuzzles),
    };
  }

  /** Subscribe to state changes. */
  onStateChange(handler: PuzzleStateHandler): () => void {
    this.handlers.add(handler);
    handler(this.getState());
    return () => { this.handlers.delete(handler); };
  }

  /** Get all puzzle definitions. */
  getPuzzles(): PuzzleLevel[] {
    return PUZZLES;
  }

  /** Increment action count (called by guide mode / teach mode). */
  incrementActions(): void {
    if (this.phase === "PLAYING") {
      this.actionCount++;
      this.emit();
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private checkSuccess(): void {
    if (this.phase !== "PLAYING" || !this.activePuzzle || !this.sceneProvider) return;

    const scene = this.sceneProvider();
    const success = this.activePuzzle.successCondition(scene);
    if (success) {
      this.finishPuzzle(true);
    }
  }

  private finishPuzzle(success: boolean): void {
    this.stopTimers();

    if (!this.activePuzzle) return;

    const score = calculateScore({
      success,
      actualTimeMs: this.elapsedMs,
      actualActions: Math.max(1, this.actionCount),
      parTime: this.activePuzzle.parTime,
      parActions: this.activePuzzle.parActions,
      starThresholds: this.activePuzzle.starThresholds,
    });

    this.lastScore = score;

    if (success) {
      this.completedPuzzles.add(this.activePuzzle.id);

      // Add to leaderboard
      addToLeaderboard({
        playerName: "Player",
        puzzleId: this.activePuzzle.id,
        puzzleName: this.activePuzzle.name,
        score: score.totalScore,
        stars: score.stars,
        timeMs: this.elapsedMs,
        actions: this.actionCount,
      });
    }

    this.setPhase(success ? "COMPLETE" : "FAILED");
  }

  private stopTimers(): void {
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.checkHandle) {
      clearInterval(this.checkHandle);
      this.checkHandle = null;
    }
    if (this.unsubCommandMode) {
      this.unsubCommandMode();
      this.unsubCommandMode = null;
    }
  }

  private setPhase(phase: PuzzlePhase): void {
    this.phase = phase;
    this.emit();
  }

  private emit(): void {
    const state = this.getState();
    this.handlers.forEach((h) => h(state));
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const puzzleEngine = new PuzzleEngine();
export default puzzleEngine;
