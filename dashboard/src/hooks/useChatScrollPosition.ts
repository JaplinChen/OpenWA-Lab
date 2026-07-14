import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { decideScroll, type ScrollDirection } from '../utils/scrollDecision.ts';

/** Data attribute each message row carries in Chats.tsx — the anchor we remember per chat. */
const MSG_ID_ATTR = 'data-wa-message-id';

/** Minimal shape of a message row needed to decide visibility (real DOM elements satisfy it). */
interface MsgNode {
  offsetTop: number;
  getAttribute: (name: string) => string | null;
}
interface ScrollBox {
  scrollTop: number;
  clientHeight: number;
  querySelectorAll: (selector: string) => ArrayLike<MsgNode>;
}

/**
 * Id of the newest message the user has actually seen: the bottom-most row whose top sits within the
 * current viewport. Returns null when there are no message rows. Pure (DOM-shape only) so it can be
 * unit-tested with stubs.
 */
export function bottomVisibleMessageId(box: ScrollBox): string | null {
  const viewportBottom = box.scrollTop + box.clientHeight;
  const nodes = box.querySelectorAll(`[${MSG_ID_ATTR}]`);
  let seen: string | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.offsetTop <= viewportBottom) {
      seen = node.getAttribute(MSG_ID_ATTR) ?? seen; // rows are in DOM order → keep the newest seen
    } else {
      break; // first row below the fold — everything after is also below
    }
  }
  return seen;
}

/**
 * Per-chat scroll memory, anchored to a MESSAGE (not a pixel offset, which breaks when content above
 * changes height).
 *
 * - On leaving a rendered chat, remember the newest message the user had in view.
 * - On entering a chat (once its content renders), align that remembered message to the bottom of the
 *   viewport — so new messages that arrived while away sit just below it. First visit (or if the
 *   anchor message is gone) jumps to the bottom. A rAF re-pin covers late height growth
 *   (media/fonts/wrapping).
 * - On message append, `onMessageAppended` keeps the view pinned to bottom only when the user was
 *   already near it (see decideScroll), so reading history isn't yanked away.
 *
 * Mount the returned `containerRef` on the scroll container (`.room-messages` in Chats.tsx).
 */
export function useChatScrollPosition(
  activeChatId: string | null,
  isLoaded: boolean,
): {
  containerRef: RefObject<HTMLDivElement | null>;
  onMessageAppended: (direction: ScrollDirection) => void;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const anchorMap = useRef<Map<string, string>>(new Map());
  const prevChatIdRef = useRef<string | null>(null);
  const prevLoadedRef = useRef<boolean>(false);

  useLayoutEffect(() => {
    const el = containerRef.current;
    const prev = prevChatIdRef.current;
    const next = activeChatId;
    const prevLoaded = prevLoadedRef.current;

    if (el) {
      // Save the leaving chat's last-seen newest message when actually switching away from a
      // rendered chat (not a spinner snapshot).
      if (prev !== null && next !== prev && prevLoaded) {
        const id = bottomVisibleMessageId(el);
        if (id) anchorMap.current.set(prev, id);
      }
      // Restore the entering chat once its content is rendered.
      if (next !== null && isLoaded) {
        pinToAnchorOrBottom(el, anchorMap.current.get(next));
        // Height can grow after this layout pass (media/fonts/wrapping); re-pin next frame.
        requestAnimationFrame(() => {
          if (containerRef.current) pinToAnchorOrBottom(containerRef.current, anchorMap.current.get(next));
        });
      }
    }

    prevChatIdRef.current = next;
    prevLoadedRef.current = isLoaded;
  }, [activeChatId, isLoaded]);

  const onMessageAppended = useCallback((direction: ScrollDirection) => {
    const el = containerRef.current;
    if (!el) return;
    const action = decideScroll(direction, {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    if (action === 'preserve') return;
    requestAnimationFrame(() => {
      const cur = containerRef.current;
      if (cur) cur.scrollTop = cur.scrollHeight;
    });
  }, []);

  return { containerRef, onMessageAppended };
}

/** Align the remembered message to the viewport bottom; fall back to the very bottom when absent. */
function pinToAnchorOrBottom(el: HTMLElement, anchorId: string | undefined): void {
  if (anchorId) {
    const anchor = el.querySelector(`[${MSG_ID_ATTR}="${CSS.escape(anchorId)}"]`);
    if (anchor instanceof HTMLElement) {
      anchor.scrollIntoView({ block: 'end' });
      return;
    }
  }
  el.scrollTop = el.scrollHeight;
}
