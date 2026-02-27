import { useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import type { ConnectionStatus } from "./services/websocketService";
import SimulationCanvas from "./components/SimulationCanvas";

// ---------------------------------------------------------------------------
// Status badge
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

function StatusBadge({ status }: { status: ConnectionStatus }) {
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
// App
// ---------------------------------------------------------------------------

export default function App() {
  const { status, messages, send, clearMessages } = useWebSocket();
  const [input, setInput] = useState("");

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed) return;

    send({ type: "test", payload: trimmed });
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

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
          <StatusBadge status={status} />
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6">
        {/* Mode selector placeholder */}
        <div className="flex gap-2">
          {(["Command", "Teach", "Guide"] as const).map((mode) => (
            <button
              key={mode}
              className="rounded-lg border border-white/10 bg-kinesys-surface px-4 py-2 text-sm font-medium text-white/60 transition hover:border-kinesys-primary/50 hover:text-white"
            >
              {mode}
            </button>
          ))}
        </div>

        {/* 3D viewport */}
        <div className="relative flex-1 overflow-hidden rounded-xl border border-white/10 bg-kinesys-surface" style={{ minHeight: 400 }}>
          <SimulationCanvas />
        </div>

        {/* Message log */}
        <div className="h-48 overflow-y-auto rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-xs">
          {messages.length === 0 ? (
            <p className="text-white/20">No messages yet. Send a test message below.</p>
          ) : (
            messages.map((msg, i) => (
              <div key={i} className="mb-1 text-white/70">
                <span className="text-kinesys-accent">[{msg.type}]</span>{" "}
                {JSON.stringify(msg, null, 0)}
              </div>
            ))
          )}
        </div>

        {/* Input bar */}
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a test message…"
            className="flex-1 rounded-lg border border-white/10 bg-kinesys-surface px-4 py-2.5 text-sm text-white placeholder-white/30 outline-none transition focus:border-kinesys-primary/50"
          />
          <button
            onClick={handleSend}
            disabled={status !== "connected" || !input.trim()}
            className="rounded-lg bg-kinesys-primary px-5 py-2.5 text-sm font-medium text-white transition hover:bg-kinesys-secondary disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
          <button
            onClick={clearMessages}
            className="rounded-lg border border-white/10 px-4 py-2.5 text-sm text-white/50 transition hover:text-white"
          >
            Clear
          </button>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/10 px-6 py-3 text-center text-xs text-white/30">
        KINESYS — Human-Robot Interaction Platform
      </footer>
    </div>
  );
}
