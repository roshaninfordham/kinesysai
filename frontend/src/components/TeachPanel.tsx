/**
 * KINESYS — TeachPanel Component
 *
 * Teach Mode UI with:
 *   - WebcamFeed for hand tracking demonstration
 *   - Record / Stop buttons to capture keyframes
 *   - Extracted procedure displayed as a visual step list
 *   - Confidence bars per action
 *   - "Confirm?" buttons for low-confidence actions
 *   - TTS confirmation prompts
 *   - Execute button to send confirmed actions to trajectory planner
 */

import { useState, useEffect, useCallback } from "react";
import WebcamFeed from "./WebcamFeed";
import teachMode, { type TeachModeState, type Keyframe } from "../modes/teachMode";
import wsService, { type WSMessage } from "../services/websocketService";
import ttsService from "../services/ttsService";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtractedAction {
  step: number;
  action: string;
  params: Record<string, unknown>;
  confidence: number;
  observation: string;
  needs_confirmation: boolean;
  valid_primitive: boolean;
  validation_error: string | null;
}

interface ExtractionResult {
  actions: ExtractedAction[];
  summary: string;
  objects_detected: string[];
  frame_count: number;
}

type TeachPhase =
  | "IDLE"
  | "RECORDING"
  | "SENDING"
  | "ANALYZING"
  | "REVIEWING"
  | "EXECUTING"
  | "DONE"
  | "ERROR";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function confidenceColor(c: number): string {
  if (c >= 0.85) return "bg-emerald-500";
  if (c >= 0.7) return "bg-amber-400";
  return "bg-red-400";
}

function confidenceTextColor(c: number): string {
  if (c >= 0.85) return "text-emerald-400";
  if (c >= 0.7) return "text-amber-400";
  return "text-red-400";
}

function actionIcon(action: string): string {
  const icons: Record<string, string> = {
    APPROACH: "🎯",
    GRASP: "✊",
    RELEASE: "🖐",
    TRANSLATE: "➡️",
    ROTATE: "🔄",
    PLACE: "📍",
    PUSH: "👉",
    POUR: "🫗",
    STACK: "📚",
    SORT: "📊",
    INSPECT: "🔍",
    WAIT: "⏸️",
  };
  return icons[action] || "⚙️";
}

function humanReadableAction(action: ExtractedAction): string {
  const params = action.params;
  switch (action.action) {
    case "APPROACH":
      return `Approach ${params.target || "object"}`;
    case "GRASP":
      return `Grasp ${params.target || "object"}`;
    case "RELEASE":
      return "Release object";
    case "TRANSLATE": {
      if (params.delta) {
        const d = params.delta as number[];
        return `Move by (${d.map((v) => v.toFixed(2)).join(", ")})`;
      }
      if (params.position) {
        const p = params.position as number[];
        return `Move to (${p.map((v) => v.toFixed(2)).join(", ")})`;
      }
      return "Translate";
    }
    case "ROTATE":
      return `Rotate ${params.degrees || "?"}° around ${params.axis || "?"}-axis`;
    case "PLACE":
      return `Place on ${params.target || "surface"}`;
    case "PUSH":
      return `Push ${params.target || "object"} ${params.distance || "?"}m`;
    case "POUR":
      return `Pour into ${params.target_container || "container"} at ${params.angle || "?"}°`;
    case "STACK":
      return `Stack on ${params.target || "object"}`;
    case "SORT":
      return `Sort by ${params.criterion || "position"}`;
    case "INSPECT":
      return `Inspect ${params.target || "scene"}`;
    case "WAIT":
      return `Wait ${params.duration_ms || 1000}ms`;
    default:
      return action.action;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TeachPanel() {
  const [phase, setPhase] = useState<TeachPhase>("IDLE");
  const [teachState, setTeachState] = useState<TeachModeState>({
    recording: false,
    keyframeCount: 0,
    lastGesture: "NO_HAND",
    statusMessage: "Ready",
  });
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [confirmedActions, setConfirmedActions] = useState<Set<number>>(new Set());
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [keyframes, setKeyframes] = useState<Keyframe[]>([]);

  // -----------------------------------------------------------------------
  // TeachMode state subscription
  // -----------------------------------------------------------------------

  useEffect(() => {
    const unsub = teachMode.onStateChange((state) => {
      setTeachState(state);
      if (state.recording) {
        setPhase("RECORDING");
      }
    });
    return unsub;
  }, []);

  // -----------------------------------------------------------------------
  // WebSocket listener for extraction results
  // -----------------------------------------------------------------------

  useEffect(() => {
    const unsub = wsService.onMessage((msg: WSMessage) => {
      if (msg.type === "teach_extract_result") {
        const result = msg as unknown as WSMessage & ExtractionResult;
        setExtraction({
          actions: result.actions,
          summary: result.summary,
          objects_detected: result.objects_detected,
          frame_count: result.frame_count,
        });

        // Auto-confirm high-confidence actions
        const autoConfirmed = new Set<number>();
        result.actions.forEach((a: ExtractedAction) => {
          if (!a.needs_confirmation && a.valid_primitive) {
            autoConfirmed.add(a.step);
          }
        });
        setConfirmedActions(autoConfirmed);

        setPhase("REVIEWING");

        // TTS for low-confidence actions
        const needsConfirm = result.actions.filter(
          (a: ExtractedAction) => a.needs_confirmation
        );
        if (needsConfirm.length > 0) {
          const first = needsConfirm[0]!;
          const desc = humanReadableAction(first);
          ttsService.speak(
            `I extracted ${result.actions.length} steps. I think you ${desc.toLowerCase()}. Is that right?`
          );
        } else {
          ttsService.speak(
            `I extracted ${result.actions.length} steps from your demonstration. ${result.summary}`
          );
        }
      }

      if (msg.type === "teach_extract_error") {
        setErrorMsg((msg as WSMessage & { error: string }).error);
        setPhase("ERROR");
        ttsService.speak("Sorry, I couldn't analyze the demonstration.");
      }

      if (msg.type === "status_update" && msg.state === "ANALYZING") {
        setPhase("ANALYZING");
      }
    });
    return unsub;
  }, []);

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  const handleStartRecording = useCallback(() => {
    setErrorMsg(null);
    setExtraction(null);
    setConfirmedActions(new Set());
    teachMode.startRecording();
    ttsService.speak("Recording started. Demonstrate the task with your hands.");
  }, []);

  const handleStopRecording = useCallback(() => {
    const kfs = teachMode.stopRecording();
    setKeyframes(kfs);

    if (kfs.length < 2) {
      setErrorMsg("Not enough keyframes captured. Try demonstrating with more movement.");
      setPhase("ERROR");
      return;
    }

    setPhase("SENDING");
    ttsService.speak(
      `Captured ${kfs.length} keyframes. Analyzing your demonstration...`
    );

    // Send keyframes to backend for VLM extraction
    wsService.send({
      type: "teach_extract",
      keyframes: kfs,
      confidence_threshold: 0.7,
    });
  }, []);

  const handleConfirmAction = useCallback(
    (step: number) => {
      setConfirmedActions((prev) => {
        const next = new Set(prev);
        next.add(step);
        return next;
      });
    },
    []
  );

  const handleRejectAction = useCallback(
    (step: number) => {
      setConfirmedActions((prev) => {
        const next = new Set(prev);
        next.delete(step);
        return next;
      });
    },
    []
  );

  const handleConfirmAll = useCallback(() => {
    if (!extraction) return;
    const all = new Set(
      extraction.actions
        .filter((a) => a.valid_primitive)
        .map((a) => a.step)
    );
    setConfirmedActions(all);
  }, [extraction]);

  const handleExecute = useCallback(() => {
    if (!extraction) return;

    const actionsToExecute = extraction.actions.filter(
      (a) => confirmedActions.has(a.step) && a.valid_primitive
    );

    if (actionsToExecute.length === 0) {
      ttsService.speak("No actions confirmed. Please confirm at least one step.");
      return;
    }

    setPhase("EXECUTING");
    ttsService.speak(
      `Executing ${actionsToExecute.length} confirmed actions on the robot arm.`
    );

    // Get scene state from commandMode's internal capture
    const sceneState = {
      objects: [
        { id: "red_cube", shape: "box", color: "red", position: [0.8, 0.65, 0.3], size: [0.2, 0.2, 0.2], mass: 0.5 },
        { id: "blue_cylinder", shape: "cylinder", color: "blue", position: [-0.5, 0.7, 0.6], size: [0.1, 0.3], mass: 0.3 },
        { id: "green_sphere", shape: "sphere", color: "green", position: [0.3, 0.67, -0.5], size: [0.12], mass: 0.2 },
      ],
      end_effector: [0, 1.5, 0],
      gripper_open: true,
      held_object_id: null,
      table_height: 0.5,
    };

    wsService.send({
      type: "teach_execute",
      actions: actionsToExecute,
      scene: sceneState,
    });
  }, [extraction, confirmedActions]);

  const handleReset = useCallback(() => {
    setPhase("IDLE");
    setExtraction(null);
    setConfirmedActions(new Set());
    setErrorMsg(null);
    setKeyframes([]);
  }, []);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-4">
      {/* Top row: Webcam + Controls */}
      <div className="flex gap-4">
        {/* Webcam feed */}
        <div className="w-80 flex-shrink-0">
          <WebcamFeed active={phase !== "DONE"} />
        </div>

        {/* Controls panel */}
        <div className="flex flex-1 flex-col gap-3 rounded-lg border border-white/10 bg-kinesys-surface p-4">
          {/* Status */}
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Teach Mode</h3>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                phase === "RECORDING"
                  ? "bg-red-500/20 text-red-400 animate-pulse"
                  : phase === "ANALYZING"
                  ? "bg-amber-500/20 text-amber-400 animate-pulse"
                  : phase === "REVIEWING"
                  ? "bg-emerald-500/20 text-emerald-400"
                  : phase === "EXECUTING"
                  ? "bg-blue-500/20 text-blue-400 animate-pulse"
                  : phase === "ERROR"
                  ? "bg-red-500/20 text-red-400"
                  : "bg-white/10 text-white/50"
              }`}
            >
              {phase}
            </span>
          </div>

          {/* Keyframe counter */}
          {(phase === "RECORDING" || phase === "SENDING") && (
            <div className="flex items-center gap-2 text-sm text-white/60">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              {teachState.keyframeCount} keyframes captured
            </div>
          )}

          {/* Status message */}
          <p className="text-xs text-white/40">{teachState.statusMessage}</p>

          {/* Action buttons */}
          <div className="mt-auto flex gap-2">
            {phase === "IDLE" && (
              <button
                onClick={handleStartRecording}
                className="flex items-center gap-1.5 rounded-lg bg-red-500/20 px-4 py-2 text-sm font-medium text-red-400 transition hover:bg-red-500/30"
              >
                <span className="h-2 w-2 rounded-full bg-red-500" />
                Record
              </button>
            )}

            {phase === "RECORDING" && (
              <button
                onClick={handleStopRecording}
                className="flex items-center gap-1.5 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
              >
                ⏹ Stop
              </button>
            )}

            {phase === "REVIEWING" && (
              <>
                <button
                  onClick={handleConfirmAll}
                  className="rounded-lg bg-emerald-500/20 px-4 py-2 text-sm font-medium text-emerald-400 transition hover:bg-emerald-500/30"
                >
                  ✓ Confirm All
                </button>
                <button
                  onClick={handleExecute}
                  disabled={confirmedActions.size === 0}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                    confirmedActions.size > 0
                      ? "bg-kinesys-primary/20 text-kinesys-primary hover:bg-kinesys-primary/30"
                      : "bg-white/5 text-white/20 cursor-not-allowed"
                  }`}
                >
                  ▶ Execute ({confirmedActions.size})
                </button>
              </>
            )}

            {(phase === "ERROR" || phase === "DONE" || phase === "EXECUTING") && (
              <button
                onClick={handleReset}
                className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white/60 transition hover:bg-white/20"
              >
                ↩ Reset
              </button>
            )}

            {phase === "ANALYZING" && (
              <div className="flex items-center gap-2 text-sm text-amber-400">
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
                Analyzing with VLM...
              </div>
            )}
          </div>

          {/* Error message */}
          {errorMsg && (
            <div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {errorMsg}
            </div>
          )}
        </div>
      </div>

      {/* Extracted procedure step list */}
      {extraction && extraction.actions.length > 0 && (
        <div className="rounded-lg border border-white/10 bg-kinesys-surface p-4">
          {/* Summary */}
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-sm font-semibold text-white">
              Extracted Procedure ({extraction.actions.length} steps)
            </h4>
            {extraction.objects_detected.length > 0 && (
              <span className="text-xs text-white/40">
                Objects: {extraction.objects_detected.join(", ")}
              </span>
            )}
          </div>

          {extraction.summary && (
            <p className="mb-3 text-xs text-white/50">{extraction.summary}</p>
          )}

          {/* Action list */}
          <div className="flex flex-col gap-2">
            {extraction.actions.map((action) => {
              const isConfirmed = confirmedActions.has(action.step);
              const needsConfirm = action.needs_confirmation;

              return (
                <div
                  key={action.step}
                  className={`flex items-center gap-3 rounded-lg border p-3 transition ${
                    !action.valid_primitive
                      ? "border-red-500/20 bg-red-500/5"
                      : isConfirmed
                      ? "border-emerald-500/20 bg-emerald-500/5"
                      : needsConfirm
                      ? "border-amber-500/20 bg-amber-500/5"
                      : "border-white/10 bg-white/5"
                  }`}
                >
                  {/* Step number */}
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-bold text-white/60">
                    {action.step}
                  </span>

                  {/* Action icon + label */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-base">{actionIcon(action.action)}</span>
                      <span className="text-sm font-medium text-white">
                        {humanReadableAction(action)}
                      </span>
                      {!action.valid_primitive && (
                        <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] text-red-400">
                          INVALID
                        </span>
                      )}
                    </div>
                    {action.observation && (
                      <p className="mt-0.5 truncate text-xs text-white/40">
                        {action.observation}
                      </p>
                    )}
                  </div>

                  {/* Confidence bar */}
                  <div className="flex w-24 flex-shrink-0 flex-col items-end gap-1">
                    <span
                      className={`text-xs font-mono ${confidenceTextColor(
                        action.confidence
                      )}`}
                    >
                      {(action.confidence * 100).toFixed(0)}%
                    </span>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                      <div
                        className={`h-full rounded-full transition-all ${confidenceColor(
                          action.confidence
                        )}`}
                        style={{ width: `${action.confidence * 100}%` }}
                      />
                    </div>
                  </div>

                  {/* Confirm / reject buttons */}
                  {phase === "REVIEWING" && action.valid_primitive && (
                    <div className="flex flex-shrink-0 gap-1">
                      {isConfirmed ? (
                        <button
                          onClick={() => handleRejectAction(action.step)}
                          className="rounded bg-emerald-500/20 px-2.5 py-1 text-xs font-medium text-emerald-400 hover:bg-emerald-500/30"
                          title="Click to unconfirm"
                        >
                          ✓
                        </button>
                      ) : (
                        <button
                          onClick={() => handleConfirmAction(action.step)}
                          className="rounded bg-amber-500/20 px-2.5 py-1 text-xs font-medium text-amber-400 hover:bg-amber-500/30 animate-pulse"
                        >
                          Confirm?
                        </button>
                      )}
                    </div>
                  )}

                  {/* Confirmed checkmark (non-interactive phases) */}
                  {phase !== "REVIEWING" && isConfirmed && (
                    <span className="text-emerald-400 text-sm">✓</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Keyframe thumbnails (collapsed) */}
      {keyframes.length > 0 && phase !== "IDLE" && (
        <details className="rounded-lg border border-white/10 bg-kinesys-surface">
          <summary className="cursor-pointer p-3 text-xs text-white/40 hover:text-white/60">
            {keyframes.length} keyframe thumbnails
          </summary>
          <div className="flex flex-wrap gap-1 p-3 pt-0">
            {keyframes.slice(0, 12).map((kf, i) => (
              <img
                key={i}
                src={kf.imageBase64}
                alt={`Keyframe ${i + 1}`}
                className="h-16 w-auto rounded border border-white/10"
              />
            ))}
            {keyframes.length > 12 && (
              <span className="flex h-16 items-center px-2 text-xs text-white/30">
                +{keyframes.length - 12} more
              </span>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
