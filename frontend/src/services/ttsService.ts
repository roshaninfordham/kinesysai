/**
 * KINESYS — Text-to-Speech Service
 *
 * Wraps the Web Speech Synthesis API for voice feedback.
 * Speaks action confirmations, error explanations, and narration.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TTSStatus = "idle" | "speaking" | "unsupported";
export type TTSStatusHandler = (status: TTSStatus) => void;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
const isSupported = !!synth;

class TTSService {
  private status: TTSStatus = isSupported ? "idle" : "unsupported";
  private statusHandlers: Set<TTSStatusHandler> = new Set();
  private queue: string[] = [];
  private speaking = false;

  /** Speak a message. Queues if already speaking. */
  speak(text: string, priority = false): void {
    if (!isSupported || !synth) {
      console.warn("[TTS] Not supported");
      return;
    }

    if (priority) {
      this.cancel();
      this.queue = [text];
    } else {
      this.queue.push(text);
    }

    if (!this.speaking) {
      this.processQueue();
    }
  }

  /** Cancel all speech. */
  cancel(): void {
    this.queue = [];
    if (synth) {
      synth.cancel();
    }
    this.speaking = false;
    this.setStatus("idle");
  }

  /** Current status. */
  getStatus(): TTSStatus {
    return this.status;
  }

  /** Subscribe to status changes. */
  onStatusChange(handler: TTSStatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  /** Whether the browser supports TTS. */
  isSupported(): boolean {
    return isSupported;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private processQueue(): void {
    if (this.queue.length === 0) {
      this.speaking = false;
      this.setStatus("idle");
      return;
    }

    const text = this.queue.shift()!;
    const utterance = new SpeechSynthesisUtterance(text);

    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    utterance.volume = 0.9;
    utterance.lang = "en-US";

    // Try to pick a good voice
    const voices = synth!.getVoices();
    const preferred = voices.find(
      (v) => v.lang.startsWith("en") && v.name.includes("Google")
    ) ?? voices.find(
      (v) => v.lang.startsWith("en") && !v.localService
    ) ?? voices.find(
      (v) => v.lang.startsWith("en")
    );

    if (preferred) {
      utterance.voice = preferred;
    }

    utterance.onstart = () => {
      this.speaking = true;
      this.setStatus("speaking");
    };

    utterance.onend = () => {
      this.processQueue();
    };

    utterance.onerror = (event) => {
      console.warn("[TTS] Error:", event.error);
      this.processQueue();
    };

    synth!.speak(utterance);
  }

  private setStatus(status: TTSStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusHandlers.forEach((h) => h(status));
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const ttsService = new TTSService();
export default ttsService;
