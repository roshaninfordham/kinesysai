import { useState } from "react";
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
        </div>

        {/* ─── RIGHT: Controls panel (35%) ─── */}
        <div
          className={`flex flex-[35] flex-col overflow-hidden border-l ${MODE_BORDER[activeMode]} bg-kinesys-dark transition-colors duration-300`}
          style={{ maxWidth: "480px", minWidth: "340px" }}
        >
          {/* Scrollable content area */}
          <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-3">
            {/* Mode-specific panel */}
            {activeMode === "Command" && <VoicePanel />}
            {activeMode === "Teach" && <TeachPanel />}
            {activeMode === "Guide" && <GuidePanel />}

            {/* Safety panel — always visible */}
            <SafetyPanel />
          </div>

          {/* Bottom bar — mode hint */}
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
