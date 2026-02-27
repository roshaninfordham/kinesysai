/**
 * KINESYS — Leaderboard Component
 *
 * In-memory top-10 leaderboard showing scores across all sessions.
 * Displays rank, player name, puzzle, score, stars, time, and actions.
 */

import { useState, useEffect, useCallback } from "react";
import {
  getLeaderboard,
  clearLeaderboard,
  type LeaderboardEntry,
} from "../game/scoreCalculator";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Leaderboard() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);

  // Refresh leaderboard data
  const refresh = useCallback(() => {
    setEntries(getLeaderboard());
  }, []);

  useEffect(() => {
    refresh();
    // Refresh every 2s in case new entries are added
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleClear = useCallback(() => {
    clearLeaderboard();
    refresh();
  }, [refresh]);

  const formatTime = (ms: number) => {
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    const s = sec % 60;
    return `${min}:${s.toString().padStart(2, "0")}`;
  };

  const starsStr = (stars: number) => {
    return "★".repeat(stars) + "☆".repeat(3 - stars);
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm">🏆</span>
          <h3 className="text-sm font-bold text-white">Leaderboard</h3>
          <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-mono text-white/25">
            Top 10
          </span>
        </div>
        {entries.length > 0 && (
          <button
            onClick={handleClear}
            className="text-[9px] font-mono text-white/20 hover:text-white/40 transition-colors"
          >
            clear
          </button>
        )}
      </div>

      {/* Table */}
      {entries.length === 0 ? (
        <div className="rounded-lg border border-white/[0.06] bg-kinesys-surface p-6 text-center">
          <p className="text-[11px] text-white/20">
            No scores yet — complete a puzzle to appear here!
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-white/[0.06] bg-kinesys-surface overflow-hidden">
          {/* Column headers */}
          <div className="grid grid-cols-[2rem_1fr_5rem_4rem_3.5rem_3rem] gap-1 px-3 py-1.5 border-b border-white/[0.04] text-[9px] font-semibold uppercase tracking-wider text-white/20">
            <span>#</span>
            <span>Puzzle</span>
            <span className="text-right">Score</span>
            <span className="text-center">Stars</span>
            <span className="text-right">Time</span>
            <span className="text-right">Acts</span>
          </div>

          {/* Rows */}
          {entries.map((entry, i) => {
            const isTop3 = i < 3;
            const rankColors = ["text-amber-400", "text-white/60", "text-amber-700"];

            return (
              <div
                key={entry.id}
                className={`grid grid-cols-[2rem_1fr_5rem_4rem_3.5rem_3rem] gap-1 px-3 py-2 items-center ${
                  i < entries.length - 1 ? "border-b border-white/[0.03]" : ""
                } ${isTop3 ? "bg-white/[0.02]" : ""}`}
              >
                {/* Rank */}
                <span className={`font-mono text-xs font-bold ${rankColors[i] || "text-white/25"}`}>
                  {i + 1}
                </span>

                {/* Puzzle name */}
                <div className="min-w-0">
                  <span className="text-[11px] text-white/60 font-medium truncate block">
                    {entry.puzzleName}
                  </span>
                </div>

                {/* Score */}
                <span className={`text-right font-mono text-xs font-bold tabular-nums ${
                  entry.score >= 600 ? "text-amber-400" : entry.score >= 400 ? "text-kinesys-cyan" : "text-white/50"
                }`}>
                  {entry.score}
                </span>

                {/* Stars */}
                <span className="text-center text-[11px] text-amber-400/80">
                  {starsStr(entry.stars)}
                </span>

                {/* Time */}
                <span className="text-right font-mono text-[10px] text-white/30 tabular-nums">
                  {formatTime(entry.timeMs)}
                </span>

                {/* Actions */}
                <span className="text-right font-mono text-[10px] text-white/30 tabular-nums">
                  {entry.actions}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
