/**
 * KINESYS — StatusBar Component
 *
 * Displays the current pipeline state with animated transitions:
 * IDLE → LISTENING → THINKING → PLANNING → VALIDATING → EXECUTING → DONE
 */

import { useEffect, useState } from "react";
import commandMode, { type PipelineState } from "../modes/commandMode";

// ---------------------------------------------------------------------------
// State configuration
// ---------------------------------------------------------------------------

interface StateConfig {
  label: string;
  color: string;
  bgColor: string;
  icon: string;
  pulse: boolean;
}

const STATE_MAP: Record<PipelineState, StateConfig> = {
  IDLE: {
    label: "Ready",
    color: "text-white/50",
    bgColor: "bg-white/5",
    icon: "○",
    pulse: false,
  },
  LISTENING: {
    label: "Listening...",
    color: "text-kinesys-accent",
    bgColor: "bg-kinesys-accent/10",
    icon: "🎤",
    pulse: true,
  },
  THINKING: {
    label: "Thinking...",
    color: "text-amber-400",
    bgColor: "bg-amber-400/10",
    icon: "🧠",
    pulse: true,
  },
  PLANNING: {
    label: "Planning...",
    color: "text-kinesys-primary",
    bgColor: "bg-kinesys-primary/10",
    icon: "📋",
    pulse: true,
  },
  VALIDATING: {
    label: "Validating...",
    color: "text-yellow-400",
    bgColor: "bg-yellow-400/10",
    icon: "🛡",
    pulse: true,
  },
  EXECUTING: {
    label: "Executing...",
    color: "text-emerald-400",
    bgColor: "bg-emerald-400/10",
    icon: "⚡",
    pulse: true,
  },
  DONE: {
    label: "Done",
    color: "text-emerald-400",
    bgColor: "bg-emerald-400/10",
    icon: "✓",
    pulse: false,
  },
  ERROR: {
    label: "Error",
    color: "text-red-400",
    bgColor: "bg-red-400/10",
    icon: "✗",
    pulse: false,
  },
};

const PIPELINE_STEPS: PipelineState[] = [
  "LISTENING",
  "THINKING",
  "PLANNING",
  "VALIDATING",
  "EXECUTING",
  "DONE",
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function StatusBar() {
  const [state, setState] = useState<PipelineState>("IDLE");

  useEffect(() => {
    return commandMode.onStateChange(setState);
  }, []);

  const config = STATE_MAP[state];
  const activeIdx = PIPELINE_STEPS.indexOf(state);

  return (
    <div className={`flex items-center gap-3 rounded-lg border border-white/10 px-4 py-2 ${config.bgColor}`}>
      {/* Current state indicator */}
      <div className={`flex items-center gap-2 ${config.color}`}>
        <span className={`text-sm ${config.pulse ? "animate-pulse" : ""}`}>
          {config.icon}
        </span>
        <span className="text-xs font-medium">{config.label}</span>
      </div>

      {/* Pipeline progress dots */}
      <div className="ml-auto flex items-center gap-1.5">
        {PIPELINE_STEPS.map((step, i) => {
          const isActive = i === activeIdx;
          const isCompleted = activeIdx > i;
          const stepConfig = STATE_MAP[step];

          return (
            <div key={step} className="flex items-center gap-1.5">
              <div
                className={`h-1.5 w-1.5 rounded-full transition-all duration-300 ${
                  isActive
                    ? `${stepConfig.color.replace("text-", "bg-")} scale-150 ${config.pulse ? "animate-pulse" : ""}`
                    : isCompleted
                      ? "bg-emerald-400/60"
                      : "bg-white/10"
                }`}
                title={STATE_MAP[step].label}
              />
              {i < PIPELINE_STEPS.length - 1 && (
                <div
                  className={`h-px w-3 transition-all duration-300 ${
                    isCompleted ? "bg-emerald-400/40" : "bg-white/5"
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
