/**
 * KINESYS — Speech Recognition Service
 *
 * Wraps the Web Speech API's SpeechRecognition for continuous listening
 * with interim results. Falls back gracefully if the browser doesn't
 * support the API.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpeechStatus = "idle" | "listening" | "processing" | "error" | "unsupported";

export interface SpeechResult {
  transcript: string;
  isFinal: boolean;
  confidence: number;
}

export type TranscriptHandler = (result: SpeechResult) => void;
export type StatusHandler = (status: SpeechStatus) => void;

// ---------------------------------------------------------------------------
// Browser compatibility
// ---------------------------------------------------------------------------

const SpeechRecognitionClass =
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

const isSupported = !!SpeechRecognitionClass;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class SpeechService {
  private recognition: any | null = null;
  private status: SpeechStatus = isSupported ? "idle" : "unsupported";
  private transcriptHandlers: Set<TranscriptHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private restartOnEnd = false;

  constructor() {
    if (!isSupported) {
      console.warn("[Speech] Web Speech API not supported in this browser");
      return;
    }

    this.recognition = new SpeechRecognitionClass();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = "en-US";
    this.recognition.maxAlternatives = 1;

    this.recognition.onresult = this.handleResult;
    this.recognition.onerror = this.handleError;
    this.recognition.onend = this.handleEnd;
    this.recognition.onstart = () => this.setStatus("listening");
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Start listening for speech. */
  start(): void {
    if (!isSupported || !this.recognition) {
      console.warn("[Speech] Cannot start — not supported");
      return;
    }

    if (this.status === "listening") return;

    try {
      this.restartOnEnd = true;
      this.recognition.start();
    } catch (err) {
      // Already started — ignore
      console.warn("[Speech] Start error (may already be running):", err);
    }
  }

  /** Stop listening. */
  stop(): void {
    this.restartOnEnd = false;
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // Ignore
      }
    }
    this.setStatus("idle");
  }

  /** Toggle listening on/off. */
  toggle(): void {
    if (this.status === "listening") {
      this.stop();
    } else {
      this.start();
    }
  }

  /** Current status. */
  getStatus(): SpeechStatus {
    return this.status;
  }

  /** Whether the browser supports speech recognition. */
  isSupported(): boolean {
    return isSupported;
  }

  /** Subscribe to transcript events. Returns unsubscribe function. */
  onTranscript(handler: TranscriptHandler): () => void {
    this.transcriptHandlers.add(handler);
    return () => {
      this.transcriptHandlers.delete(handler);
    };
  }

  /** Subscribe to status changes. Returns unsubscribe function. */
  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  // -----------------------------------------------------------------------
  // Internal handlers
  // -----------------------------------------------------------------------

  private handleResult = (event: any): void => {
    const results = event.results;
    const latest = results[results.length - 1];

    if (!latest) return;

    const transcript: string = latest[0].transcript.trim();
    const isFinal: boolean = latest.isFinal;
    const confidence: number = latest[0].confidence ?? 0;

    if (!transcript) return;

    const result: SpeechResult = { transcript, isFinal, confidence };

    this.transcriptHandlers.forEach((handler) => {
      try {
        handler(result);
      } catch (err) {
        console.error("[Speech] Handler error:", err);
      }
    });

    if (isFinal) {
      this.setStatus("processing");
    }
  };

  private handleError = (event: any): void => {
    const error = event.error;
    console.warn("[Speech] Recognition error:", error);

    if (error === "no-speech" || error === "aborted") {
      // Non-critical — will restart
      return;
    }

    this.setStatus("error");
  };

  private handleEnd = (): void => {
    if (this.restartOnEnd) {
      // Auto-restart for continuous listening
      try {
        setTimeout(() => {
          if (this.restartOnEnd && this.recognition) {
            this.recognition.start();
          }
        }, 100);
      } catch {
        this.setStatus("error");
      }
    } else {
      this.setStatus("idle");
    }
  };

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private setStatus(status: SpeechStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusHandlers.forEach((handler) => handler(status));
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const speechService = new SpeechService();
export default speechService;
