/**
 * KINESYS — PuzzleSelect Component
 *
 * Puzzle selection screen showing all 5 levels as cards with:
 *   - Level icon, name, subtitle
 *   - Difficulty stars
 *   - Recommended mode badge
 *   - Par time / par actions
 *   - Completion status (checkmark if completed)
 */

import { useEffect, useState } from "react";
import puzzleEngine, { type PuzzleState } from "../game/puzzleEngine";
import type { PuzzleLevel } from "../game/puzzleConfig";

// ---------------------------------------------------------------------------
// Difficulty dots
// ---------------------------------------------------------------------------

function DifficultyDots({ level }: { level: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((d) => (
        <span
          key={d}
          className={`h-1.5 w-1.5 rounded-full ${
            d <= level ? "bg-kinesys-fire" : "bg-white/10"
          }`}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode badge colors
// ---------------------------------------------------------------------------

const MODE_COLORS: Record<string, string> = {
  Command: "bg-kinesys-fire/15 text-kinesys-fire border-kinesys-fire/20",
  Teach: "bg-kinesys-cyan/15 text-kinesys-cyan border-kinesys-cyan/20",
  Guide: "bg-kinesys-indigo/15 text-kinesys-indigo border-kinesys-indigo/20",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PuzzleSelect() {
  const [state, setState] = useState<PuzzleState>(puzzleEngine.getState());
  const puzzles = puzzleEngine.getPuzzles();

  useEffect(() => {
    return puzzleEngine.onStateChange(setState);
  }, []);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-white">Puzzle Challenges</h2>
          <p className="text-[11px] text-white/30">
            Complete puzzles to test the AI system — compete for the top score!
          </p>
        </div>
        <button
          onClick={() => puzzleEngine.close()}
          className="rounded-lg border border-white/[0.06] px-3 py-1.5 text-[10px] font-mono text-white/30 hover:text-white/50 hover:bg-white/5 transition-colors"
        >
          ✕ Close
        </button>
      </div>

      {/* Puzzle cards grid */}
      <div className="grid grid-cols-1 gap-2">
        {puzzles.map((puzzle) => (
          <PuzzleCard
            key={puzzle.id}
            puzzle={puzzle}
            completed={state.completedPuzzles.has(puzzle.id)}
            onSelect={() => puzzleEngine.selectPuzzle(puzzle.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Puzzle Card
// ---------------------------------------------------------------------------

function PuzzleCard({
  puzzle,
  completed,
  onSelect,
}: {
  puzzle: PuzzleLevel;
  completed: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`group flex items-center gap-3 rounded-lg border p-3 text-left transition-all hover:bg-white/[0.03] ${
        completed
          ? "border-emerald-500/20 bg-emerald-500/[0.03]"
          : "border-white/[0.06] bg-kinesys-surface"
      }`}
    >
      {/* Icon */}
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-lg group-hover:bg-white/[0.07] transition-colors">
        {puzzle.icon}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">{puzzle.name}</span>
          {completed && (
            <span className="text-emerald-400 text-xs">✓</span>
          )}
        </div>
        <p className="text-[11px] text-white/35 truncate">{puzzle.subtitle}</p>
        <div className="mt-1 flex items-center gap-3">
          <DifficultyDots level={puzzle.difficulty} />
          <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-mono ${MODE_COLORS[puzzle.recommendedMode]}`}>
            {puzzle.recommendedMode}
          </span>
        </div>
      </div>

      {/* Par stats */}
      <div className="flex flex-shrink-0 flex-col items-end gap-0.5">
        <span className="text-[10px] font-mono text-white/25">
          {puzzle.parTime}s par
        </span>
        <span className="text-[10px] font-mono text-white/25">
          {puzzle.parActions} actions
        </span>
      </div>

      {/* Arrow */}
      <span className="text-white/15 group-hover:text-white/30 transition-colors text-sm">
        ›
      </span>
    </button>
  );
}
