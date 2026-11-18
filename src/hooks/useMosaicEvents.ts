import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { ChatMessage, ChatTokenEvent, PullProgressEvent } from '../types/ipc';
import { isTauriRuntime } from '../utils/tauriClient';

interface UseMosaicEventsArgs {
  isMountedRef: MutableRefObject<boolean>;
  activeSessionIdRef: MutableRefObject<string>;
  onPullProgress: (ev: PullProgressEvent) => void;
  onPullDone: () => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setStreaming: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
}

export function useMosaicEvents({
  isMountedRef,
  activeSessionIdRef,
  onPullProgress,
  onPullDone,
  setMessages,
  setStreaming,
  setNotice,
}: UseMosaicEventsArgs) {
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlistenPull: (() => void) | undefined;
    let unlistenChat: (() => void) | undefined;

    const safeUnlisten = (fn?: () => void) => {
      if (!fn) return;
      try {
        void Promise.resolve(fn()).catch(() => {});
      } catch {
        // Ignore teardown when Tauri internals are already disposed.
      }
    };

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const pullFn = await listen<PullProgressEvent>('mosaic://pull-progress', (ev) => {
          if (!isMountedRef.current) return;
          onPullProgress(ev.payload);
          if (ev.payload.done) {
            if (ev.payload.error) setNotice(ev.payload.error);
            onPullDone();
          }
        });
        if (disposed) {
          safeUnlisten(pullFn);
          return;
        }
        unlistenPull = pullFn;

        const chatFn = await listen<ChatTokenEvent>('mosaic://chat-token', (ev) => {
          if (!isMountedRef.current || ev.payload.session_id !== activeSessionIdRef.current) return;
          if (ev.payload.error) {
            setNotice(ev.payload.error);
            setStreaming(false);
            return;
          }
          if (ev.payload.token) {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant') {
                return [...prev.slice(0, -1), { ...last, content: last.content + ev.payload.token }];
              }
              return [...prev, { role: 'assistant', content: ev.payload.token }];
            });
          }
          if (ev.payload.done) setStreaming(false);
        });
        if (disposed) {
          safeUnlisten(chatFn);
          return;
        }
        unlistenChat = chatFn;
      } catch {
        // Non-Tauri browser preview.
      }
    })();

    return () => {
      disposed = true;
      safeUnlisten(unlistenPull);
      safeUnlisten(unlistenChat);
    };
  }, [isMountedRef, activeSessionIdRef, onPullProgress, onPullDone, setMessages, setStreaming, setNotice]);
}
