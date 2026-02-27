/**
 * KINESYS — VoicePanel Component
 *
 * Shows microphone status, live transcript, AI narration log,
 * and a mic toggle button. Wires speech → commandMode → backend.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import speechService, { type SpeechStatus, type SpeechResult } from "../services/speechService";
import commandMode, { type PipelineState } from "../modes/commandMode";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function VoicePanel() {
  const [micStatus, setMicStatus] = useState<SpeechStatus>(speechService.getStatus());
  const [pipelineState, setPipelineState] = useState<PipelineState>("IDLE");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [log, setLog] = useState<Array<{ type: "user" | "ai"; text: string }>>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Scroll log to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  // Subscribe to speech status
  useEffect(() => {
    return speechService.onStatusChange(setMicStatus);
  }, []);

  // Subscribe to pipeline state
  useEffect(() => {
    return commandMode.onStateChange(setPipelineState);
  }, []);

  // Subscribe to narration (AI responses)
  useEffect(() => {
    return commandMode.onNarration((text) => {
      setLog((prev) => [...prev.slice(-49), { type: "ai", text }]);
    });
  }, []);

  // Handle speech transcripts
  useEffect(() => {
    return speechService.onTranscript((result: SpeechResult) => {
      if (result.isFinal) {
        setInterimTranscript("");
        setLog((prev) => [
          ...prev.slice(-49),
          { type: "user", text: result.transcript },
        ]);
        commandMode.sendCommand(result.transcript);
      } else {
        setInterimTranscript(result.transcript);
      }
    });
  }, []);

  const toggleMic = useCallback(() => {
    speechService.toggle();
    if (speechService.getStatus() !== "listening") {
      commandMode.setListening();
    }
  }, []);

  const handleTextSubmit = useCallback((text: string) => {
    if (!text.trim()) return;
    setLog((prev) => [...prev.slice(-49), { type: "user", text }]);
    commandMode.sendCommand(text);
  }, []);

  // Determine mic button style
  const micActive = micStatus === "listening";
  const micDisabled = micStatus === "unsupported" || pipelineState === "EXECUTING";

  return (
    <div className="flex flex-col gap-2">
      {/* Transcript / narration log */}
      <div className="h-36 overflow-y-auto rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-xs">
        {log.length === 0 && !interimTranscript ? (
          <p className="text-white/20">
            {micStatus === "unsupported"
              ? "Voice input not supported in this browser. Type a command below."
              : "Click the mic or type a command below to get started."}
          </p>
        ) : (
          <>
            {log.map((entry, i) => (
              <div key={i} className="mb-1.5">
                {entry.type === "user" ? (
                  <div className="text-white/80">
                    <span className="text-kinesys-accent font-semibold">You:</span>{" "}
                    {entry.text}
                  </div>
                ) : (
                  <div className="text-white/60">
                    <span className="text-kinesys-primary font-semibold">KINESYS:</span>{" "}
                    {entry.text}
                  </div>
                )}
              </div>
            ))}
            {interimTranscript && (
              <div className="mb-1 text-white/40 italic">
                <span className="text-kinesys-accent/50">You:</span>{" "}
                {interimTranscript}...
              </div>
            )}
          </>
        )}
        <div ref={logEndRef} />
      </div>

      {/* Input bar */}
      <div className="flex gap-2">
        {/* Mic button */}
        <button
          onClick={toggleMic}
          disabled={micDisabled}
          className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border transition ${
            micActive
              ? "border-kinesys-accent bg-kinesys-accent/20 text-kinesys-accent animate-pulse"
              : micDisabled
                ? "border-white/5 bg-white/5 text-white/20 cursor-not-allowed"
                : "border-white/10 bg-kinesys-surface text-white/50 hover:text-white hover:border-kinesys-accent/50"
          }`}
          title={
            micDisabled
              ? "Voice not available"
              : micActive
                ? "Stop listening"
                : "Start listening"
          }
        >
          <MicIcon active={micActive} />
        </button>

        {/* Text input */}
        <TextInput onSubmit={handleTextSubmit} disabled={pipelineState === "EXECUTING"} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
      {active && <circle cx="12" cy="5" r="1" fill="currentColor" className="animate-ping" />}
    </svg>
  );
}

function TextInput({
  onSubmit,
  disabled,
}: {
  onSubmit: (text: string) => void;
  disabled: boolean;
}) {
  const [value, setValue] = useState("");

  const handleSubmit = () => {
    if (value.trim() && !disabled) {
      onSubmit(value.trim());
      setValue("");
    }
  };

  return (
    <>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
          }
        }}
        placeholder="Type a command... (e.g. 'pick up the red cube')"
        disabled={disabled}
        className="flex-1 rounded-lg border border-white/10 bg-kinesys-surface px-4 py-2.5 text-sm text-white placeholder-white/30 outline-none transition focus:border-kinesys-primary/50 disabled:opacity-40"
      />
      <button
        onClick={handleSubmit}
        disabled={disabled || !value.trim()}
        className="rounded-lg bg-kinesys-primary px-4 py-2.5 text-sm font-medium text-white transition hover:bg-kinesys-secondary disabled:cursor-not-allowed disabled:opacity-40"
      >
        Send
      </button>
    </>
  );
}
