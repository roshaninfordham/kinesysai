import { useState, useEffect, useCallback } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import type { ConnectionStatus } from "./services/websocketService";
import SimulationCanvas from "./components/SimulationCanvas";
import VoicePanel from "./components/VoicePanel";
import StatusBar from "./components/StatusBar";
import TeachPanel from "./components/TeachPanel";
import GuidePanel from "./components/GuidePanel";
import ModeSelector, { type Mode } from "./components/ModeSelector";
import SafetyPanel from "./components/SafetyPanel";
import ScoreBoard from "./components/ScoreBoard";
import PuzzleSelect from "./components/PuzzleSelect";
import ResultScreen from "./components/ResultScreen";
import Leaderboard from "./components/Leaderboard";
import puzzleEngine, { type PuzzleState } from "./game/puzzleEngine";

// ---------------------------------------------------------------------------
// Connection badge
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<ConnectionStatus, string> = {
  connected: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  connecting: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  reconnecting: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  disconnected: "bg-red-500/20 text-red-400 border-red-500/30",
};

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
};

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-medium font-mono ${STATUS_STYLES[status]}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          status === "connected" ? "bg-emerald-400 animate-pulse" : "bg-current"
        }`}
      />
      {STATUS_LABELS[status]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Mode accent color (for dynamic border/glow on right panel)
// ---------------------------------------------------------------------------

const MODE_BORDER: Record<Mode, string> = {
  Command: "border-kinesys-fire/15",
  Teach: "border-kinesys-cyan/15",
  Guide: "border-kinesys-indigo/15",
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const { status } = useWebSocket();
  const [activeMode, setActiveMode] = useState<Mode>("Command");
  const [puzzleState, setPuzzleState] = useState<PuzzleState>(puzzleEngine.getState());

  useEffect(() => {
    return puzzleEngine.onStateChange(setPuzzleState);
  }, []);

  // Start puzzle when transitioning to READY
  const handleStartPuzzle = useCallback(() => {
    puzzleEngine.startPuzzle();
  }, []);

  const handleGiveUp = useCallback(() => {
    puzzleEngine.giveUp();
  }, []);

  const handleManualComplete = useCallback(() => {
    puzzleEngine.manualComplete();
  }, []);

  // Determine if puzzle UI should take over the right panel
  const puzzleActive = puzzleState.phase !== "IDLE";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-kinesys-dark">
      {/* ─── Header ─── */}
      <header className="flex-shrink-0 border-b border-white/[0.06] px-4 py-2.5">
        <div className="flex items-center justify-between">
          {/* Left: logo + mode selector */}
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight">
                <span className="text-kinesys-fire">KIN</span>
                <span className="text-white/80">ESYS</span>
              </h1>
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] text-white/25">
                v0.1.0
              </span>
            </div>
            <div className="h-5 w-px bg-white/[0.06]" />
            <ModeSelector active={activeMode} onChange={setActiveMode} />
          </div>

          {/* Right: status + connection */}
          <div className="flex items-center gap-3">
            <ScoreBoard />
            <ConnectionBadge status={status} />
          </div>
        </div>
      </header>

      {/* ─── Main content: 65/35 split ─── */}
      <main className="flex flex-1 gap-0 overflow-hidden">
        {/* ─── LEFT: 3D Viewport (65%) ─── */}
        <div className="relative flex-[65] overflow-hidden border-r border-white/[0.04]">
          <SimulationCanvas />

          {/* Overlay: Status bar at bottom of viewport */}
          <div className="absolute bottom-3 left-3 right-3 z-10">
            <StatusBar />
          </div>

          {/* Puzzle playing overlay — give up / complete buttons */}
          {puzzleState.phase === "PLAYING" && (
            <div className="absolute top-3 right-3 z-10 flex gap-2">
              {puzzleState.activePuzzle?.id === 5 && (
                <button
                  onClick={handleManualComplete}
                  className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-400 backdrop-blur-sm border border-emerald-500/20 hover:bg-emerald-500/30 transition-colors"
                >
                  ✓ Done
                </button>
              )}
              <button
                onClick={handleGiveUp}
                className="rounded-lg bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400/70 backdrop-blur-sm border border-red-500/15 hover:bg-red-500/20 transition-colors"
              >
                Give Up
              </button>
            </div>
          )}
        </div>

        {/* ─── RIGHT: Controls panel (35%) ─── */}
        <div
          className={`flex flex-[35] flex-col overflow-hidden border-l ${MODE_BORDER[activeMode]} bg-kinesys-dark transition-colors duration-300`}
          style={{ maxWidth: "480px", minWidth: "340px" }}
        >
          {/* Scrollable content area */}
          <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-3">
            {/* ─── Puzzle UI (when active) ─── */}
            {puzzleState.phase === "SELECTING" && <PuzzleSelect />}

            {puzzleState.phase === "READY" && puzzleState.activePuzzle && (
              <PuzzleReadyScreen
                puzzle={puzzleState.activePuzzle}
                onStart={handleStartPuzzle}
                onBack={() => puzzleEngine.backToSelection()}
              />
            )}

            {(puzzleState.phase === "COMPLETE" || puzzleState.phase === "FAILED") &&
              puzzleState.lastScore &&
              puzzleState.activePuzzle && (
                <ResultScreen
                  score={puzzleState.lastScore}
                  puzzle={puzzleState.activePuzzle}
                />
              )}

            {/* ─── Normal mode panels (when puzzle is playing or idle) ─── */}
            {(puzzleState.phase === "PLAYING" || !puzzleActive) && (
              <>
                {activeMode === "Command" && <VoicePanel />}
                {activeMode === "Teach" && <TeachPanel />}
                {activeMode === "Guide" && <GuidePanel />}
              </>
            )}

            {/* Safety panel — always visible */}
            <SafetyPanel />

            {/* Leaderboard — shown below safety when puzzle mode is active */}
            {puzzleActive && puzzleState.phase !== "SELECTING" && <Leaderboard />}
          </div>

          {/* Bottom bar */}
          <div className="flex-shrink-0 border-t border-white/[0.04] px-3 py-2">
            <p className="text-center font-mono text-[9px] text-white/15">
              KINESYS — Human-Robot Interaction Platform
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Puzzle Ready Screen (inline sub-component)
// ---------------------------------------------------------------------------

function PuzzleReadyScreen({
  puzzle,
  onStart,
  onBack,
}: {
  puzzle: { name: string; icon: string; description: string; parTime: number; parActions: number; hints: string[]; difficulty: number; recommendedMode: string };
  onStart: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-4">
      {/* Puzzle header */}
      <div className="text-center space-y-2">
        <div className="text-4xl">{puzzle.icon}</div>
        <h2 className="text-lg font-bold text-white">{puzzle.name}</h2>
        <p className="text-[11px] text-white/40 leading-relaxed px-2">
          {puzzle.description}
        </p>
      </div>

      {/* Par info */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-white/[0.06] bg-kinesys-surface p-3 text-center">
          <span className="block text-[9px] font-semibold uppercase tracking-wider text-white/25 mb-1">Par Time</span>
          <span className="font-mono text-lg font-bold text-white/70">{puzzle.parTime}s</span>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-kinesys-surface p-3 text-center">
          <span className="block text-[9px] font-semibold uppercase tracking-wider text-white/25 mb-1">Par Actions</span>
          <span className="font-mono text-lg font-bold text-white/70">{puzzle.parActions}</span>
        </div>
      </div>

      {/* Hints */}
      {puzzle.hints.length > 0 && (
        <div className="rounded-lg border border-white/[0.04] bg-kinesys-surface p-3 space-y-1.5">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-white/25">Hints</span>
          {puzzle.hints.map((hint, i) => (
            <p key={i} className="text-[11px] text-white/30 leading-relaxed">
              💡 {hint}
            </p>
          ))}
        </div>
      )}

      {/* Buttons */}
      <div className="flex gap-2">
        <button
          onClick={onBack}
          className="flex-1 rounded-lg border border-white/[0.06] py-3 text-xs font-medium text-white/40 hover:text-white/60 hover:bg-white/5 transition-colors"
        >
          ← Back
        </button>
        <button
          onClick={onStart}
          className="flex-[2] rounded-lg bg-kinesys-fire/20 py-3 text-sm font-bold text-kinesys-fire hover:bg-kinesys-fire/30 transition-colors"
        >
          ▶ Start Puzzle
        </button>
      </div>
    </div>
  );
}
