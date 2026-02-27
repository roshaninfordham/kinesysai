import { useCallback, useEffect, useRef, useState } from "react";
import wsService, {
  type ConnectionStatus,
  type WSMessage,
} from "../services/websocketService";

/**
 * React hook for consuming the KINESYS WebSocket service.
 *
 * Returns connection status, message log, and a send function.
 */
export function useWebSocket() {
  const [status, setStatus] = useState<ConnectionStatus>(wsService.getStatus());
  const [messages, setMessages] = useState<WSMessage[]>([]);
  const connectedOnce = useRef(false);

  useEffect(() => {
    const unsubStatus = wsService.onStatusChange(setStatus);
    const unsubMsg = wsService.onMessage((msg) => {
      setMessages((prev) => [...prev.slice(-99), msg]); // keep last 100
    });

    if (!connectedOnce.current) {
      wsService.connect();
      connectedOnce.current = true;
    }

    return () => {
      unsubStatus();
      unsubMsg();
    };
  }, []);

  const send = useCallback((message: WSMessage) => {
    wsService.send(message);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return { status, messages, send, clearMessages } as const;
}
