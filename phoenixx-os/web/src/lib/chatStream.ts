import { request } from './api';

/**
 * Live chat delivery.
 *
 * `EventSource` cannot set an Authorization header, and putting an access token
 * in the query string would put it in every request log, so the SSE stream is
 * read with `fetch` instead and parsed here. That also means it goes through the
 * same client as everything else, including the 401-refresh retry.
 *
 * The stream is an optimisation, never the source of truth: callers refetch on
 * each event, so a dropped connection only delays a message rather than losing
 * it. Reconnection backs off to 30s so a server that is down does not get
 * hammered by every open tab.
 */

export type ChatEvent =
  | { type: 'message'; channel_id: string; message: any }
  | { type: 'read'; channel_id: string; user_id: string; at: string };

type Handler = (event: ChatEvent) => void;

export function openChatStream(onEvent: Handler): () => void {
  const controller = new AbortController();
  let stopped = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const connect = async () => {
    if (stopped) return;
    try {
      const res = await request<Response>('/chat/stream', { raw: true, signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);

      attempt = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // SSE frames are separated by a blank line; a frame may arrive split
      // across chunks, so anything after the last separator stays buffered.
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          let type = 'message';
          const dataLines: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue;              // keep-alive comment
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length || type === 'ready') continue;
          try {
            onEvent({ type, ...JSON.parse(dataLines.join('\n')) } as ChatEvent);
          } catch { /* a frame we do not understand is not worth a crash */ }
        }
      }
    } catch {
      // Aborted on unmount, or the connection dropped — both retry below.
    }

    if (stopped) return;
    attempt += 1;
    retryTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
  };

  connect();

  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    controller.abort();
  };
}
