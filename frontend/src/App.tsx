import { useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import type { ConnectionStatus } from "./services/websocketService";
import SimulationCanvas from "./components/SimulationCanvas";
import VoicePanel from "./components/VoicePanel";
import StatusBar from "./components/StatusBar";

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
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      <span
        className={`h-2 w-2 rounded-full ${
          status === "connected" ? "bg-emerald-400 animate-pulse" : "bg-current"
        }`}
      />
      {STATUS_LABELS[status]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Mode selector
// ---------------------------------------------------------------------------

type Mode = "Command" | "Teach" | "Guide";

function ModeSelector({
  active,
  onChange,
}: {
  active: Mode;
  onChange: (mode: Mode) => void;
}) {
  const modes: Mode[] = ["Command", "Teach", "Guide"];
  const icons: Record<Mode, string> = {
    Command: "🗣️",
    Teach: "📸",
    Guide: "🕹️",
  };

  return (
    <div className="flex gap-2">
      {modes.map((mode) => (
        <button
          key={mode}
          onClick={() => onChange(mode)}
          className={`flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-medium transition ${
            active === mode
              ? "border-kinesys-primary bg-kinesys-primary/15 text-white"
              : "border-white/10 bg-kinesys-surface text-white/50 hover:border-kinesys-primary/30 hover:text-white/80"
          }`}
        >
          <span>{icons[mode]}</span>
          {mode}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const { status } = useWebSocket();
  const [activeMode, setActiveMode] = useState<Mode>("Command");

  return (
    <div className="flex min-h-screen flex-col bg-kinesys-dark">
      {/* Header */}
      <header className="border-b border-white/10 px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight">
              <span className="text-kinesys-primary">KINESYS</span>
            </h1>
            <span className="text-xs text-white/40">v0.1.0</span>
          </div>
          <ConnectionBadge status={status} />
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6">
        {/* Mode selector + Status bar */}
        <div className="flex items-center justify-between gap-4">
          <ModeSelector active={activeMode} onChange={setActiveMode} />
          <div className="flex-1">
            <StatusBar />
          </div>
        </div>

        {/* 3D viewport */}
        <div
          className="relative flex-1 overflow-hidden rounded-xl border border-white/10 bg-kinesys-surface"
          style={{ minHeight: 400 }}
        >
          <SimulationCanvas />
        </div>

        {/* Voice panel (Command mode) */}
        {activeMode === "Command" && <VoicePanel />}

        {/* Placeholder for other modes */}
        {activeMode === "Teach" && (
          <div className="flex h-36 items-center justify-center rounded-lg border border-white/10 bg-kinesys-surface">
            <p className="text-sm text-white/30">
              Teach Mode — webcam demonstration capture (coming soon)
            </p>
          </div>
        )}
        {activeMode === "Guide" && (
          <div className="flex h-36 items-center justify-center rounded-lg border border-white/10 bg-kinesys-surface">
            <p className="text-sm text-white/30">
              Guide Mode — hand gesture teleoperation (coming soon)
            </p>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-white/10 px-6 py-3 text-center text-xs text-white/30">
        KINESYS — Human-Robot Interaction Platform
      </footer>
    </div>
  );
}
