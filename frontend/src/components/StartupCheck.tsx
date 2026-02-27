/**
 * KINESYS — StartupCheck Component
 *
 * Pre-demo checklist verifying:
 *   - Ollama is running (local LLM server)
 *   - Groq API key is valid (cloud LLM)
 *   - WebSocket connection is alive
 *   - Webcam is accessible
 *
 * Shows green/red status for each check. User can dismiss or auto-dismiss
 * when all checks pass.
 */

import { useState, useEffect, useCallback } from "react";
import wsService from "../services/websocketService";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CheckStatus = "pending" | "checking" | "pass" | "fail" | "warn";

interface CheckItem {
  id: string;
  label: string;
  description: string;
  status: CheckStatus;
  detail: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function StartupCheck({ onDismiss }: { onDismiss: () => void }) {
  const [checks, setChecks] = useState<CheckItem[]>([
    { id: "ws", label: "WebSocket", description: "Backend connection", status: "pending", detail: "" },
    { id: "ollama", label: "Ollama", description: "Local LLM server", status: "pending", detail: "" },
    { id: "groq", label: "Groq API", description: "Cloud LLM key", status: "pending", detail: "" },
    { id: "webcam", label: "Webcam", description: "Camera access", status: "pending", detail: "" },
  ]);
  const [running, setRunning] = useState(false);
  const [allDone, setAllDone] = useState(false);

  const updateCheck = useCallback((id: string, status: CheckStatus, detail: string) => {
    setChecks((prev) =>
      prev.map((c) => (c.id === id ? { ...c, status, detail } : c)),
    );
  }, []);

  // Run all checks
  const runChecks = useCallback(async () => {
    setRunning(true);

    // 1. WebSocket
    updateCheck("ws", "checking", "Connecting...");
    try {
      const wsStatus = wsService.getStatus();
      if (wsStatus === "connected") {
        updateCheck("ws", "pass", "Connected");
      } else {
        // Try to connect and wait a bit
        wsService.connect();
        await new Promise((r) => setTimeout(r, 2000));
        const s = wsService.getStatus();
        if (s === "connected") {
          updateCheck("ws", "pass", "Connected");
        } else {
          updateCheck("ws", "fail", `Status: ${s}`);
        }
      }
    } catch {
      updateCheck("ws", "fail", "Connection failed");
    }

    // 2. Ollama
    updateCheck("ollama", "checking", "Checking...");
    try {
      const res = await fetch("http://localhost:11434/api/tags", {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json();
        const models = data.models?.length ?? 0;
        updateCheck("ollama", "pass", `${models} model(s) loaded`);
      } else {
        updateCheck("ollama", "fail", `HTTP ${res.status}`);
      }
    } catch {
      updateCheck("ollama", "warn", "Not running (optional for Groq fallback)");
    }

    // 3. Groq API key
    updateCheck("groq", "checking", "Validating...");
    try {
      const res = await fetch("http://localhost:8000/api/health", {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        updateCheck("groq", "pass", "Backend healthy");
      } else {
        updateCheck("groq", "warn", `Backend returned ${res.status}`);
      }
    } catch {
      updateCheck("groq", "fail", "Backend unreachable");
    }

    // 4. Webcam
    updateCheck("webcam", "checking", "Requesting access...");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
      });
      // Got access — stop tracks immediately
      stream.getTracks().forEach((t) => t.stop());
      updateCheck("webcam", "pass", "Camera accessible");
    } catch (err: any) {
      if (err.name === "NotAllowedError") {
        updateCheck("webcam", "warn", "Permission denied — grant in browser settings");
      } else if (err.name === "NotFoundError") {
        updateCheck("webcam", "fail", "No camera found");
      } else {
        updateCheck("webcam", "warn", err.message || "Unknown error");
      }
    }

    setRunning(false);
    setAllDone(true);
  }, [updateCheck]);

  // Auto-run on mount
  useEffect(() => {
    runChecks();
  }, [runChecks]);

  // Auto-dismiss if all pass
  useEffect(() => {
    if (allDone && checks.every((c) => c.status === "pass")) {
      const timer = setTimeout(onDismiss, 1500);
      return () => clearTimeout(timer);
    }
  }, [allDone, checks, onDismiss]);

  const allPassed = checks.every((c) => c.status === "pass");
  const hasFails = checks.some((c) => c.status === "fail");

  const statusIcon = (s: CheckStatus) => {
    switch (s) {
      case "pass": return "✓";
      case "fail": return "✗";
      case "warn": return "⚠";
      case "checking": return "…";
      default: return "○";
    }
  };

  const statusColor = (s: CheckStatus) => {
    switch (s) {
      case "pass": return "text-emerald-400";
      case "fail": return "text-red-400";
      case "warn": return "text-amber-400";
      case "checking": return "text-white/40 animate-pulse";
      default: return "text-white/20";
    }
  };

  const dotColor = (s: CheckStatus) => {
    switch (s) {
      case "pass": return "bg-emerald-400";
      case "fail": return "bg-red-400";
      case "warn": return "bg-amber-400";
      case "checking": return "bg-white/30 animate-pulse";
      default: return "bg-white/10";
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-kinesys-dark/95 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-white/[0.08] bg-kinesys-surface p-6 shadow-2xl">
        {/* Header */}
        <div className="text-center mb-5">
          <h2 className="text-lg font-bold text-white">
            <span className="text-kinesys-fire">KIN</span>
            <span className="text-white/80">ESYS</span>
            <span className="text-white/30"> — </span>
            <span className="text-white/50 text-sm font-normal">Startup Check</span>
          </h2>
          <p className="text-[11px] text-white/25 mt-1">
            Verifying system readiness for demo
          </p>
        </div>

        {/* Checklist */}
        <div className="space-y-2 mb-5">
          {checks.map((check) => (
            <div
              key={check.id}
              className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                check.status === "pass"
                  ? "border-emerald-500/15 bg-emerald-500/[0.03]"
                  : check.status === "fail"
                  ? "border-red-500/15 bg-red-500/[0.03]"
                  : check.status === "warn"
                  ? "border-amber-500/15 bg-amber-500/[0.03]"
                  : "border-white/[0.04] bg-white/[0.01]"
              }`}
            >
              {/* Status dot */}
              <span className={`flex h-6 w-6 items-center justify-center rounded-full ${dotColor(check.status)}/20`}>
                <span className={`text-xs font-bold ${statusColor(check.status)}`}>
                  {statusIcon(check.status)}
                </span>
              </span>

              {/* Label */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white/70">{check.label}</span>
                  <span className="text-[10px] text-white/20">{check.description}</span>
                </div>
                {check.detail && (
                  <p className={`text-[10px] font-mono mt-0.5 ${statusColor(check.status)}`}>
                    {check.detail}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Summary + actions */}
        <div className="flex items-center justify-between">
          <div>
            {allPassed && (
              <span className="text-xs text-emerald-400 font-medium">
                ✓ All systems ready
              </span>
            )}
            {hasFails && (
              <span className="text-xs text-red-400/70">
                Some checks failed — demo may be limited
              </span>
            )}
            {!allDone && !allPassed && !hasFails && (
              <span className="text-xs text-white/25">Checking...</span>
            )}
          </div>

          <div className="flex gap-2">
            {allDone && !allPassed && (
              <button
                onClick={runChecks}
                disabled={running}
                className="rounded-lg border border-white/[0.06] px-4 py-2 text-xs font-medium text-white/40 hover:text-white/60 hover:bg-white/5 transition-colors disabled:opacity-40"
              >
                ↻ Retry
              </button>
            )}
            <button
              onClick={onDismiss}
              className="rounded-lg bg-kinesys-fire/20 px-4 py-2 text-xs font-bold text-kinesys-fire hover:bg-kinesys-fire/30 transition-colors"
            >
              {allPassed ? "Start Demo →" : "Continue Anyway →"}
            </button>
          </div>
        </div>

        {/* Keyboard shortcut hint */}
        <p className="text-center text-[9px] text-white/15 mt-4 font-mono">
          Space = Push-to-talk · R = Reset scene · 1/2/3 = Switch mode · Esc = Emergency stop
        </p>
      </div>
    </div>
  );
}
