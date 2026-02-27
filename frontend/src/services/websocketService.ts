/**
 * KINESYS WebSocket Client Service
 *
 * Manages a persistent WebSocket connection to the backend with:
 * - Automatic reconnection with exponential backoff
 * - Typed message handling
 * - Connection state tracking
 * - Message queuing while disconnected
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface WSMessage {
  type: string;
  [key: string]: unknown;
}

export type MessageHandler = (message: WSMessage) => void;
export type StatusHandler = (status: ConnectionStatus) => void;

interface QueuedMessage {
  data: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_WS_URL = "ws://localhost:8000/ws";
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;
const MAX_QUEUE_SIZE = 100;
const HEARTBEAT_INTERVAL_MS = 30000;

// ---------------------------------------------------------------------------
// WebSocket Service
// ---------------------------------------------------------------------------

class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private status: ConnectionStatus = "disconnected";
  private messageHandlers: Set<MessageHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private messageQueue: QueuedMessage[] = [];
  private reconnectDelay: number = INITIAL_RECONNECT_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private manualClose = false;

  constructor(url?: string) {
    this.url = url ?? import.meta.env.VITE_WS_URL ?? DEFAULT_WS_URL;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Open the WebSocket connection. */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.manualClose = false;
    this.setStatus("connecting");

    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = this.handleOpen;
      this.ws.onmessage = this.handleMessage;
      this.ws.onclose = this.handleClose;
      this.ws.onerror = this.handleError;
    } catch (err) {
      console.error("[WS] Failed to create WebSocket:", err);
      this.scheduleReconnect();
    }
  }

  /** Gracefully close the connection. */
  disconnect(): void {
    this.manualClose = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
    this.setStatus("disconnected");
  }

  /** Send a typed JSON message. Queues if not yet connected. */
  send(message: WSMessage): void {
    const data = JSON.stringify(message);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      if (this.messageQueue.length < MAX_QUEUE_SIZE) {
        this.messageQueue.push({ data, timestamp: Date.now() });
      } else {
        console.warn("[WS] Message queue full — dropping message");
      }
    }
  }

  /** Subscribe to incoming messages. Returns unsubscribe function. */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /** Subscribe to connection status changes. Returns unsubscribe function. */
  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status); // emit current status immediately
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  /** Current connection status. */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  // -----------------------------------------------------------------------
  // Internal handlers
  // -----------------------------------------------------------------------

  private handleOpen = (): void => {
    console.info("[WS] Connected to", this.url);
    this.setStatus("connected");
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    this.flushQueue();
    this.startHeartbeat();
  };

  private handleMessage = (event: MessageEvent): void => {
    try {
      const message: WSMessage = JSON.parse(event.data as string);
      this.messageHandlers.forEach((handler) => {
        try {
          handler(message);
        } catch (err) {
          console.error("[WS] Message handler error:", err);
        }
      });
    } catch {
      console.warn("[WS] Received non-JSON message:", event.data);
    }
  };

  private handleClose = (event: CloseEvent): void => {
    console.info("[WS] Connection closed:", event.code, event.reason);
    this.stopHeartbeat();
    this.ws = null;

    if (!this.manualClose) {
      this.scheduleReconnect();
    } else {
      this.setStatus("disconnected");
    }
  };

  private handleError = (_event: Event): void => {
    console.error("[WS] Connection error");
    // onclose will fire after onerror — reconnect logic lives there
  };

  // -----------------------------------------------------------------------
  // Reconnection
  // -----------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.manualClose) return;

    this.setStatus("reconnecting");
    console.info(`[WS] Reconnecting in ${this.reconnectDelay}ms...`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
      this.reconnectDelay = Math.min(
        this.reconnectDelay * RECONNECT_BACKOFF_MULTIPLIER,
        MAX_RECONNECT_DELAY_MS,
      );
    }, this.reconnectDelay);
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusHandlers.forEach((handler) => handler(status));
  }

  private flushQueue(): void {
    while (this.messageQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const queued = this.messageQueue.shift();
      if (queued) {
        this.ws.send(queued.data);
      }
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const wsService = new WebSocketService();
export default wsService;
