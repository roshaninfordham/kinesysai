/**
 * KINESYS — ScoreBoard Component
 *
 * When puzzle mode is active, displays:
 *   - Timer (elapsed since puzzle start)
 *   - Action count (total commands / waypoints executed)
 *   - Efficiency score (computed from action count vs. optimal path)
 *
 * Puzzle mode is toggled via the component itself — acts as a
 * gamification layer for hackathon demos.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import commandMode from "../modes/commandMode";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ScoreBoard() {
  const [active, setActive] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [actionCount, setActionCount] = useState(0);

  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Track pipeline state for action counting
  useEffect(() => {
    return commandMode.onStateChange((state) => {
      if (active && state === "EXECUTING") {
        setActionCount((c) => c + 1);
      }
    });
  }, [active]);

  // Timer
  useEffect(() => {
    if (active) {
      startTimeRef.current = Date.now() - elapsedMs;
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startTimeRef.current);
      }, 100);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [active]);

  const handleToggle = useCallback(() => {
    if (active) {
      setActive(false);
    } else {
      setActive(true);
      setElapsedMs(0);
      setActionCount(0);
    }
  }, [active]);

  const handleReset = useCallback(() => {
    setElapsedMs(0);
    setActionCount(0);
    startTimeRef.current = Date.now();
  }, []);

  // Format time
  const totalSec = Math.floor(elapsedMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const tenths = Math.floor((elapsedMs % 1000) / 100);
  const timeStr = `${min.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}.${tenths}`;

  // Efficiency score: lower action count + faster time = higher
  // Baseline: 100 points, -5 per action over 3, -1 per 10 seconds over 30s
  const baseScore = 100;
  const actionPenalty = Math.max(0, (actionCount - 3) * 5);
  const timePenalty = Math.max(0, Math.floor((totalSec - 30) / 10));
  const efficiency = Math.max(0, baseScore - actionPenalty - timePenalty);

  const efficiencyColor =
    efficiency >= 80 ? "text-emerald-400" : efficiency >= 50 ? "text-amber-400" : "text-red-400";

  if (!active) {
    return (
      <button
        onClick={handleToggle}
        className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-kinesys-surface px-3 py-2 text-[11px] text-white/30 hover:text-white/50 hover:border-white/10 transition-colors"
      >
        <span>🏆</span>
        <span className="font-mono">Puzzle Mode</span>
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-kinesys-fire/20 bg-kinesys-surface overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.04]">
        <div className="flex items-center gap-2">
          <span className="text-sm">🏆</span>
          <span className="text-[11px] font-semibold text-kinesys-fire">PUZZLE MODE</span>
          <span className="h-1.5 w-1.5 rounded-full bg-kinesys-fire animate-pulse" />
        </div>
        <div className="flex gap-1">
          <button
            onClick={handleReset}
            className="rounded px-1.5 py-0.5 text-[9px] font-mono text-white/30 hover:text-white/50 hover:bg-white/5"
          >
            reset
          </button>
          <button
            onClick={handleToggle}
            className="rounded px-1.5 py-0.5 text-[9px] font-mono text-white/30 hover:text-white/50 hover:bg-white/5"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Scores */}
      <div className="grid grid-cols-3 divide-x divide-white/[0.04]">
        {/* Timer */}
        <div className="flex flex-col items-center px-3 py-2.5">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-white/25 mb-1">
            Time
          </span>
          <span className="font-mono text-lg font-bold text-white/80 tabular-nums leading-none">
            {timeStr}
          </span>
        </div>

        {/* Actions */}
        <div className="flex flex-col items-center px-3 py-2.5">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-white/25 mb-1">
            Actions
          </span>
          <span className="font-mono text-lg font-bold text-white/80 tabular-nums leading-none">
            {actionCount}
          </span>
        </div>

        {/* Efficiency */}
        <div className="flex flex-col items-center px-3 py-2.5">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-white/25 mb-1">
            Score
          </span>
          <span className={`font-mono text-lg font-bold tabular-nums leading-none ${efficiencyColor}`}>
            {efficiency}
          </span>
        </div>
      </div>
    </div>
  );
}
