import { useEffect, useRef, useState } from "react";

export type LiveStatus = "connecting" | "live" | "offline";

/**
 * Subscribe to the server's `/api/events` SSE stream and call `onChange` whenever
 * the watched config dirs change (the server already coalesces bursts). The return
 * value is the connection status for a UI indicator.
 *
 * `EventSource` reconnects automatically on a dropped connection; we surface that
 * as "connecting" (readyState CONNECTING) vs "offline" (CLOSED). `onChange` is held
 * in a ref so a changing callback identity never tears down the stream — the effect
 * runs once for the lifetime of the component.
 */
export function useLiveReload(onChange: () => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    const es = new EventSource("/api/events");
    const markLive = () => setStatus("live");
    es.onopen = markLive;
    es.addEventListener("hello", markLive);
    es.addEventListener("change", () => cb.current());
    es.onerror = () => {
      // CONNECTING (0) → the browser is retrying; CLOSED (2) → given up.
      setStatus(es.readyState === EventSource.CONNECTING ? "connecting" : "offline");
    };
    return () => es.close();
  }, []);

  return status;
}
