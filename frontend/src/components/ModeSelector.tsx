/**
 * KINESYS — ModeSelector Component
 *
 * Prominent 3-way toggle for Command / Teach / Guide modes with
 * distinct color coding (fire / cyan / indigo), glowing active indicator,
 * and animated transitions between modes.
 */

import { useRef, useEffect } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Mode = "Command" | "Teach" | "Guide";

interface ModeSelectorProps {
  active: Mode;
  onChange: (mode: Mode) => void;
}

// ---------------------------------------------------------------------------
// Mode configuration
// ---------------------------------------------------------------------------

interface ModeConfig {
  label: string;
  icon: string;
  subtitle: string;
  color: string;
  textColor: string;
  bgActive: string;
  borderActive: string;
  glowClass: string;
  dotColor: string;
}

const MODE_CONFIG: Record<Mode, ModeConfig> = {
  Command: {
    label: "Command",
    icon: "⚡",
    subtitle: "Voice + AI",
    color: "kinesys-fire",
    textColor: "text-kinesys-fire",
    bgActive: "bg-kinesys-fire/12",
    borderActive: "border-kinesys-fire/40",
    glowClass: "shadow-glow-fire",
    dotColor: "bg-kinesys-fire",
  },
  Teach: {
    label: "Teach",
    icon: "👁",
    subtitle: "VLM Demo",
    color: "kinesys-cyan",
    textColor: "text-kinesys-cyan",
    bgActive: "bg-kinesys-cyan/12",
    borderActive: "border-kinesys-cyan/40",
    glowClass: "shadow-glow-cyan",
    dotColor: "bg-kinesys-cyan",
  },
  Guide: {
    label: "Guide",
    icon: "✋",
    subtitle: "Hand Teleop",
    color: "kinesys-indigo",
    textColor: "text-kinesys-indigo",
    bgActive: "bg-kinesys-indigo/12",
    borderActive: "border-kinesys-indigo/40",
    glowClass: "shadow-glow-indigo",
    dotColor: "bg-kinesys-indigo",
  },
};

const MODES: Mode[] = ["Command", "Teach", "Guide"];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ModeSelector({ active, onChange }: ModeSelectorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);

  // Animate the sliding indicator behind the active button
  useEffect(() => {
    if (!containerRef.current || !indicatorRef.current) return;
    const activeIdx = MODES.indexOf(active);
    const buttons = containerRef.current.querySelectorAll<HTMLButtonElement>("[data-mode-btn]");
    const btn = buttons[activeIdx];
    if (!btn) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();

    indicatorRef.current.style.transform = `translateX(${btnRect.left - containerRect.left}px)`;
    indicatorRef.current.style.width = `${btnRect.width}px`;
  }, [active]);

  const activeConfig = MODE_CONFIG[active];

  return (
    <div className="relative">
      {/* Outer container */}
      <div
        ref={containerRef}
        className="relative flex gap-1 rounded-xl border border-white/[0.06] bg-kinesys-surface p-1"
      >
        {/* Sliding glow indicator */}
        <div
          ref={indicatorRef}
          className={`absolute top-1 h-[calc(100%-8px)] rounded-lg transition-all duration-300 ease-out ${activeConfig.bgActive} ${activeConfig.glowClass}`}
          style={{ width: 0 }}
        />

        {/* Mode buttons */}
        {MODES.map((mode) => {
          const cfg = MODE_CONFIG[mode];
          const isActive = mode === active;

          return (
            <button
              key={mode}
              data-mode-btn
              onClick={() => onChange(mode)}
              className={`relative z-10 flex items-center gap-2.5 rounded-lg px-5 py-2.5 transition-all duration-200 ${
                isActive
                  ? `${cfg.textColor} ${cfg.borderActive} border`
                  : "border border-transparent text-white/40 hover:text-white/70"
              }`}
            >
              {/* Animated glow dot */}
              <span className="relative flex h-2.5 w-2.5 items-center justify-center">
                {isActive && (
                  <span
                    className={`absolute inline-flex h-full w-full animate-ping rounded-full ${cfg.dotColor} opacity-40`}
                  />
                )}
                <span
                  className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-200 ${
                    isActive ? cfg.dotColor : "bg-white/15"
                  }`}
                />
              </span>

              {/* Icon + label */}
              <span className="text-base leading-none">{cfg.icon}</span>
              <div className="flex flex-col items-start">
                <span className="text-sm font-semibold leading-tight">{cfg.label}</span>
                <span
                  className={`text-[10px] font-mono leading-tight transition-opacity duration-200 ${
                    isActive ? "opacity-60" : "opacity-0"
                  }`}
                >
                  {cfg.subtitle}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
