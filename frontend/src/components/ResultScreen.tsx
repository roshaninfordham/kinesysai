/**
 * KINESYS — ResultScreen Component
 *
 * Shown after puzzle completion with:
 *   - Star rating (1-3 stars, animated)
 *   - Score breakdown (time, efficiency, accuracy)
 *   - Comparison to par
 *   - Retry / Next / Leaderboard buttons
 */

import { useState, useCallback } from "react";
import puzzleEngine from "../game/puzzleEngine";
import type { ScoreBreakdown } from "../game/scoreCalculator";
import type { PuzzleLevel } from "../game/puzzleConfig";
import Leaderboard from "./Leaderboard";

// ---------------------------------------------------------------------------
// Star display
// ---------------------------------------------------------------------------

function StarRating({ stars, max = 3 }: { stars: number; max?: number }) {
  return (
    <div className="flex gap-2">
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          className={`text-2xl transition-all duration-500 ${
            i < stars
              ? "text-amber-400 scale-110 drop-shadow-[0_0_8px_rgba(251,191,36,0.5)]"
              : "text-white/10 scale-90"
          }`}
          style={{ transitionDelay: `${i * 200}ms` }}
        >
          ★
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Score row
// ---------------------------------------------------------------------------

function ScoreRow({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max?: number;
  color: string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[11px] text-white/40">{label}</span>
      <div className="flex items-center gap-2">
        <span className={`font-mono text-sm font-bold ${color}`}>
          {value}
        </span>
        {max !== undefined && (
          <span className="text-[10px] font-mono text-white/20">/ {max}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ResultScreen({
  score,
  puzzle,
}: {
  score: ScoreBreakdown;
  puzzle: PuzzleLevel;
}) {
  const [showLeaderboard, setShowLeaderboard] = useState(false);

  const handleRetry = useCallback(() => {
    puzzleEngine.selectPuzzle(puzzle.id);
  }, [puzzle.id]);

  const handleNext = useCallback(() => {
    const nextId = puzzle.id + 1;
    const nextPuzzle = puzzleEngine.getPuzzles().find((p) => p.id === nextId);
    if (nextPuzzle) {
      puzzleEngine.selectPuzzle(nextId);
    } else {
      puzzleEngine.backToSelection();
    }
  }, [puzzle.id]);

  const handleBack = useCallback(() => {
    puzzleEngine.backToSelection();
  }, []);

  if (showLeaderboard) {
    return (
      <div className="space-y-3">
        <Leaderboard />
        <button
          onClick={() => setShowLeaderboard(false)}
          className="w-full rounded-lg border border-white/[0.06] py-2 text-[11px] font-mono text-white/30 hover:text-white/50 hover:bg-white/5 transition-colors"
        >
          ← Back to Results
        </button>
      </div>
    );
  }

  const isSuccess = score.success;
  const actualTimeSec = (score.actualTimeMs / 1000).toFixed(1);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="text-center space-y-2">
        <div className="text-3xl">
          {isSuccess ? puzzle.icon : "😔"}
        </div>
        <h2 className={`text-lg font-bold ${isSuccess ? "text-white" : "text-white/60"}`}>
          {isSuccess ? "Puzzle Complete!" : "Not Quite..."}
        </h2>
        <p className="text-[11px] text-white/30">{puzzle.name}</p>

        {/* Stars */}
        <div className="flex justify-center pt-1">
          <StarRating stars={score.stars} />
        </div>
      </div>

      {/* Total score */}
      <div className="flex items-center justify-center">
        <div className="rounded-xl border border-white/[0.08] bg-kinesys-surface px-6 py-3 text-center">
          <span className="block text-[9px] font-semibold uppercase tracking-wider text-white/25 mb-1">
            Total Score
          </span>
          <span className={`font-mono text-3xl font-bold tabular-nums ${
            score.stars >= 3 ? "text-amber-400" : score.stars >= 2 ? "text-kinesys-cyan" : score.stars >= 1 ? "text-white/70" : "text-white/40"
          }`}>
            {score.totalScore}
          </span>
        </div>
      </div>

      {/* Score breakdown */}
      <div className="rounded-lg border border-white/[0.06] bg-kinesys-surface p-3 divide-y divide-white/[0.04]">
        <ScoreRow
          label={`⏱ Time (${actualTimeSec}s / ${puzzle.parTime}s par)`}
          value={score.timeScore}
          color={score.timeScore > 0 ? "text-emerald-400" : "text-white/40"}
        />
        <ScoreRow
          label={`⚡ Efficiency (${score.actualActions} / ${puzzle.parActions} par)`}
          value={score.efficiencyScore}
          max={100}
          color={score.efficiencyScore >= 80 ? "text-emerald-400" : score.efficiencyScore >= 50 ? "text-amber-400" : "text-red-400"}
        />
        <ScoreRow
          label="🎯 Accuracy"
          value={score.accuracyScore}
          max={500}
          color={score.accuracyScore > 0 ? "text-emerald-400" : "text-red-400"}
        />
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={handleRetry}
          className="flex-1 rounded-lg border border-white/[0.06] py-2.5 text-xs font-medium text-white/50 hover:text-white/70 hover:bg-white/5 transition-colors"
        >
          ↻ Retry
        </button>
        <button
          onClick={() => setShowLeaderboard(true)}
          className="flex-1 rounded-lg border border-kinesys-fire/20 bg-kinesys-fire/5 py-2.5 text-xs font-medium text-kinesys-fire/80 hover:bg-kinesys-fire/10 transition-colors"
        >
          🏆 Leaderboard
        </button>
        {isSuccess && (
          <button
            onClick={handleNext}
            className="flex-1 rounded-lg bg-kinesys-fire/15 py-2.5 text-xs font-medium text-kinesys-fire hover:bg-kinesys-fire/25 transition-colors"
          >
            Next →
          </button>
        )}
      </div>

      {/* Back link */}
      <button
        onClick={handleBack}
        className="w-full text-center text-[10px] font-mono text-white/20 hover:text-white/40 transition-colors"
      >
        ← All Puzzles
      </button>
    </div>
  );
}
