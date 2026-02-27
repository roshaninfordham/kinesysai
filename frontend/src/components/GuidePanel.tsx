/**
 * KINESYS — GuidePanel Component
 *
 * Guide Mode UI: hand teleoperation with trajectory recording and replay.
 *
 * Layout:
 *   - Webcam feed with hand skeleton overlay (left)
 *   - Controls: Start/Stop teleoperation, Record/Stop, Replay, speed selector
 *   - Live stats: hand position, gripper state, trajectory point count
 *   - Replay progress bar
 */

import { useState, useEffect, useCallback } from "react";
import WebcamFeed from "./WebcamFeed";
import guideMode, { type GuideModeState } from "../modes/guideMode";
import ttsService from "../services/ttsService";
import mediapipeService from "../services/mediapipeService";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatRow({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-white/40">{label}</span>
      <span className={`font-mono text-xs ${accent ? "text-kinesys-primary" : "text-white/70"}`}>
        {value}
      </span>
    </div>
  );
}

function ReplayBar({ progress, total }: { progress: number; total: number }) {
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] text-white/40">
        <span>Replay</span>
        <span>{progress}/{total} pts ({pct}%)</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-kinesys-primary transition-all duration-100"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function GuidePanel() {
  const [guideState, setGuideState] = useState<GuideModeState>(guideMode.getState());
  const [speedMultiplier, setSpeedMultiplier] = useState(1.0);
  const [webcamActive, setWebcamActive] = useState(false);

  // -----------------------------------------------------------------------
  // State subscription
  // -----------------------------------------------------------------------

  useEffect(() => {
    const unsub = guideMode.onStateChange(setGuideState);
    return unsub;
  }, []);

  // -----------------------------------------------------------------------
  // Controls
  // -----------------------------------------------------------------------

  const handleStartTeleoperation = useCallback(async () => {
    setWebcamActive(true);
    // Give the webcam a moment to initialise before starting tracking
    await new Promise((r) => setTimeout(r, 600));
    guideMode.start();
    ttsService.speak("Guide mode active. Move your hand to control the arm.");
  }, []);

  const handleStopTeleoperation = useCallback(() => {
    guideMode.stop();
    setWebcamActive(false);
    ttsService.speak("Teleoperation stopped.");
  }, []);

  const handleStartRecording = useCallback(() => {
    guideMode.startRecording();
    ttsService.speak("Recording trajectory. Move your hand to demonstrate the task.");
  }, []);

  const handleStopRecording = useCallback(() => {
    guideMode.stopRecording();
    ttsService.speak("Recording stopped. Trajectory saved.");
  }, []);

  const handleReplay = useCallback(() => {
    if (!guideState.savedTrajectoryId) {
      ttsService.speak("No trajectory saved yet. Record one first.");
      return;
    }
    guideMode.startReplay(speedMultiplier);
    ttsService.speak(`Replaying trajectory at ${speedMultiplier}x speed.`);
  }, [guideState.savedTrajectoryId, speedMultiplier]);

  const handleCancelReplay = useCallback(() => {
    guideMode.cancelReplay();
  }, []);

  const handleStreamReady = useCallback((video: HTMLVideoElement) => {
    mediapipeService.setVideoElement(video);
  }, []);

  // -----------------------------------------------------------------------
  // Derived display values
  // -----------------------------------------------------------------------

  const armState = guideState;

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-4">
      {/* Top row */}
      <div className="flex gap-4">
        {/* Webcam feed */}
        <div className="w-80 flex-shrink-0">
          <WebcamFeed active={webcamActive} onStreamReady={handleStreamReady} />
        </div>

        {/* Controls + Stats */}
        <div className="flex flex-1 flex-col gap-3 rounded-lg border border-white/10 bg-kinesys-surface p-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Guide Mode</h3>
            <div className="flex items-center gap-2">
              {/* Hand detection indicator */}
              <span
                className={`h-2 w-2 rounded-full transition-colors ${
                  armState.handDetected ? "bg-emerald-400 animate-pulse" : "bg-white/20"
                }`}
                title={armState.handDetected ? "Hand detected" : "No hand detected"}
              />
              {/* Mode badge */}
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  armState.recording
                    ? "bg-red-500/20 text-red-400 animate-pulse"
                    : armState.replaying
                    ? "bg-kinesys-primary/20 text-kinesys-primary animate-pulse"
                    : armState.active
                    ? "bg-emerald-500/20 text-emerald-400"
                    : "bg-white/10 text-white/40"
                }`}
              >
                {armState.recording
                  ? "RECORDING"
                  : armState.replaying
                  ? "REPLAYING"
                  : armState.active
                  ? "LIVE"
                  : "IDLE"}
              </span>
            </div>
          </div>

          {/* Status message */}
          <p className="text-xs text-white/40">{armState.statusMessage}</p>

          {/* Live stats */}
          <div className="rounded-md bg-white/5 px-3 py-2 divide-y divide-white/5">
            <StatRow label="Hand detected" value={armState.handDetected ? "Yes" : "No"} />
            <StatRow
              label="Gripper"
              value={armState.gripperOpen ? "Open 🖐" : "Closed ✊"}
              accent={!armState.gripperOpen}
            />
            <StatRow
              label="Trajectory pts"
              value={armState.recording ? `${armState.pointCount} (recording)` : String(armState.pointCount)}
              accent={armState.recording}
            />
            {armState.savedTrajectoryId && (
              <StatRow label="Saved ID" value={armState.savedTrajectoryId.slice(-12)} />
            )}
          </div>

          {/* Replay progress */}
          {armState.replaying && (
            <ReplayBar progress={armState.replayProgress} total={armState.replayTotal} />
          )}

          {/* Control buttons */}
          <div className="mt-auto flex flex-wrap gap-2">
            {/* Start / Stop teleoperation */}
            {!armState.active ? (
              <button
                onClick={handleStartTeleoperation}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-500/20 px-4 py-2 text-sm font-medium text-emerald-400 transition hover:bg-emerald-500/30"
              >
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                Start Guide
              </button>
            ) : (
              <button
                onClick={handleStopTeleoperation}
                disabled={armState.recording}
                className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white/70 transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ⏹ Stop Guide
              </button>
            )}

            {/* Record / Stop record */}
            {armState.active && !armState.recording && !armState.replaying && (
              <button
                onClick={handleStartRecording}
                className="flex items-center gap-1.5 rounded-lg bg-red-500/20 px-4 py-2 text-sm font-medium text-red-400 transition hover:bg-red-500/30"
              >
                <span className="h-2 w-2 rounded-full bg-red-500" />
                Record
              </button>
            )}

            {armState.recording && (
              <button
                onClick={handleStopRecording}
                className="flex items-center gap-1.5 rounded-lg bg-red-500/30 px-4 py-2 text-sm font-medium text-red-300 transition hover:bg-red-500/40"
              >
                <span className="h-2 w-2 rounded-full bg-red-400 animate-pulse" />
                Stop Recording
              </button>
            )}

            {/* Replay controls */}
            {armState.savedTrajectoryId && !armState.recording && !armState.replaying && (
              <button
                onClick={handleReplay}
                className="rounded-lg bg-kinesys-primary/20 px-4 py-2 text-sm font-medium text-kinesys-primary transition hover:bg-kinesys-primary/30"
              >
                ▶ Replay
              </button>
            )}

            {armState.replaying && (
              <button
                onClick={handleCancelReplay}
                className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white/60 transition hover:bg-white/20"
              >
                ✕ Cancel Replay
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Speed + tips row */}
      <div className="flex gap-4">
        {/* Replay speed selector */}
        {armState.savedTrajectoryId && (
          <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-kinesys-surface px-4 py-3">
            <span className="text-xs text-white/40">Replay speed</span>
            <div className="flex gap-1.5">
              {[0.5, 1.0, 1.5, 2.0].map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeedMultiplier(s)}
                  className={`rounded px-2.5 py-1 text-xs font-mono transition ${
                    speedMultiplier === s
                      ? "bg-kinesys-primary/20 text-kinesys-primary"
                      : "bg-white/5 text-white/40 hover:bg-white/10"
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Usage tips */}
        <div className="flex-1 rounded-lg border border-white/5 bg-kinesys-surface px-4 py-3">
          <p className="text-[11px] text-white/30 leading-relaxed">
            <span className="text-white/50 font-medium">Tips: </span>
            Move palm to control arm position · Pinch thumb+index to close gripper · Keep hand in frame · Click Record to capture a trajectory · Replay to run it autonomously
          </p>
        </div>
      </div>
    </div>
  );
}
