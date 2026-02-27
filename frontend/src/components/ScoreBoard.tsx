/**
 * KINESYS — ScoreBoard Component
 *
 * Header-bar widget that integrates with puzzleEngine.
 * When idle: shows a "Puzzle Mode" button.
 * When a puzzle is active: shows puzzle name, timer, actions, and live score.
 */

import { useState, useEffect, useCallback } from "react";
import puzzleEngine, { type PuzzleState } from "../game/puzzleEngine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const tenths = Math.floor((ms % 1000) / 100);
  return `${min.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}.${tenths}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ScoreBoard() {
  const [state, setState] = useState<PuzzleState>(puzzleEngine.getState());

  useEffect(() => {
    return puzzleEngine.onStateChange(setState);
  }, []);

  const handleOpen = useCallback(() => {
    puzzleEngine.openSelection();
  }, []);

  const handleClose = useCallback(() => {
    puzzleEngine.close();
  }, []);

  // Idle state: show toggle button
  if (state.phase === "IDLE") {
    return (
      <button
        onClick={handleOpen}
        className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-kinesys-surface px-3 py-2 text-[11px] text-white/30 hover:text-white/50 hover:border-white/10 transition-colors"
      >
        <span>🏆</span>
        <span className="font-mono">Puzzles</span>
      </button>
    );
  }

  // Selecting / ready / complete / failed: compact indicator
  if (state.phase === "SELECTING" || state.phase === "COMPLETE" || state.phase === "FAILED") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-kinesys-fire/20 bg-kinesys-surface px-3 py-2">
        <span className="text-sm">🏆</span>
        <span className="text-[11px] font-semibold text-kinesys-fire">PUZZLE</span>
        <button
          onClick={handleClose}
          className="rounded px-1.5 py-0.5 text-[9px] font-mono text-white/30 hover:text-white/50 hover:bg-white/5"
        >
          ✕
        </button>
      </div>
    );
  }

  // Ready or playing: full scoreboard
  const puzzle = state.activePuzzle;
  const isPlaying = state.phase === "PLAYING";

  return (
    <div className="rounded-lg border border-kinesys-fire/20 bg-kinesys-surface overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/[0.04]">
        <div className="flex items-center gap-2">
          <span className="text-xs">{puzzle?.icon || "🏆"}</span>
          <span className="text-[10px] font-semibold text-kinesys-fire truncate max-w-[100px]">
            {puzzle?.name || "PUZZLE"}
          </span>
          {isPlaying && (
            <span className="h-1.5 w-1.5 rounded-full bg-kinesys-fire animate-pulse" />
          )}
        </div>
        <button
          onClick={handleClose}
          className="rounded px-1 py-0.5 text-[9px] font-mono text-white/30 hover:text-white/50 hover:bg-white/5"
        >
          ✕
        </button>
      </div>

      {/* Scores */}
      <div className="grid grid-cols-3 divide-x divide-white/[0.04]">
        <div className="flex flex-col items-center px-2 py-1.5">
          <span className="text-[8px] font-semibold uppercase tracking-wider text-white/20 mb-0.5">Time</span>
          <span className="font-mono text-sm font-bold text-white/80 tabular-nums leading-none">
            {formatTime(state.elapsedMs)}
          </span>
        </div>
        <div className="flex flex-col items-center px-2 py-1.5">
          <span className="text-[8px] font-semibold uppercase tracking-wider text-white/20 mb-0.5">Actions</span>
          <span className="font-mono text-sm font-bold text-white/80 tabular-nums leading-none">
            {state.actionCount}
          </span>
        </div>
        <div className="flex flex-col items-center px-2 py-1.5">
          <span className="text-[8px] font-semibold uppercase tracking-wider text-white/20 mb-0.5">Par</span>
          <span className="font-mono text-sm font-bold text-white/40 tabular-nums leading-none">
            {puzzle?.parTime || 0}s
          </span>
        </div>
      </div>
    </div>
  );
}
