// Scroll position for the story view: collapsing header, bottom
// pinning while streaming, and resume-at-bottom with input focus.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

// The reader counts as "at the bottom" within this distance of it.
const NEAR_BOTTOM_PX = 200;
// A scroll within this window suppresses auto-scroll (the reader is
// actively reading, not parked at the latest line).
const SCROLL_QUIET_MS = 800;

export interface StoryScrollArgs {
  scrollRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  // The story's identity: the resume pin fires once per story.
  storyId: string;
  storyReady: boolean;
  actionsReady: boolean;
  streamText: string;
  visibleOverlayLength: number;
}

export function useStoryScroll({
  scrollRef,
  inputRef,
  storyId,
  storyReady,
  actionsReady,
  streamText,
  visibleOverlayLength,
}: StoryScrollArgs) {
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  // Raw scrollTop: the top fade renders only when this is > 0.
  const [scrollTop, setScrollTop] = useState(0);
  // Set when the reader scrolls away from the bottom mid-stream;
  // auto-scroll stays off until they return or jump to latest.
  const [userScrolledAway, setUserScrolledAway] = useState(false);
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const lastUserScrollAtRef = useRef(0);
  // Programmatic pins must not count as user scrolling (they would
  // otherwise suppress the very next auto-scroll via the debounce).
  const programmaticRef = useRef(false);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      // Instant assignment, never smooth: a new delta arrives before
      // any animation could finish, which caused the bounce.
      programmaticRef.current = true;
      el.scrollTop = el.scrollHeight;
    }
    // Jump-to-latest resumes auto-scroll unconditionally: the reader
    // explicitly parked at the bottom, so the quiet window resets too.
    lastUserScrollAtRef.current = 0;
    stickRef.current = true;
    setAtBottom(true);
    setUserScrolledAway(false);
  }, [scrollRef]);

  function pinToBottom() {
    lastUserScrollAtRef.current = 0;
    stickRef.current = true;
    setAtBottom(true);
    setUserScrolledAway(false);
  }

  // Auto-scroll: deltas pin the bottom only while the reader is parked
  // there, hasn't scrolled away, and hasn't scrolled recently.
  useEffect(() => {
    if (
      stickRef.current &&
      !userScrolledAway &&
      Date.now() - lastUserScrollAtRef.current > SCROLL_QUIET_MS
    ) {
      const el = scrollRef.current;
      if (el) {
        programmaticRef.current = true;
        el.scrollTop = el.scrollHeight;
      }
    }
    // The quiet-window read is intentionally per-delta (mount behavior).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamText, visibleOverlayLength, userScrolledAway, scrollToBottom]);

  // Resume to the exact position: when the story and its actions have
  // both resolved, the story opens scrolled to the bottom (instantly)
  // with the input focused. Once per story id — later turns manage
  // their own scroll. Both flags gate the pin because either query
  // can resolve first, and a warm actions cache (e.g. prefetched by
  // the Home card) must not skip the pin when the story arrives.
  const resumedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!storyReady || !actionsReady || resumedRef.current === storyId) {
      return;
    }
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    resumedRef.current = storyId;
    el.scrollTop = el.scrollHeight;
    inputRef.current?.focus();
  }, [storyReady, actionsReady, storyId, scrollRef, inputRef]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    // A programmatic pin fires a scroll event too; consume it without
    // treating it as the reader moving.
    if (programmaticRef.current) {
      programmaticRef.current = false;
    } else {
      lastUserScrollAtRef.current = Date.now();
    }
    const top = el.scrollTop;
    setScrollTop(top);
    const nearBottom = el.scrollHeight - top - el.clientHeight < NEAR_BOTTOM_PX;
    stickRef.current = nearBottom;
    setAtBottom(nearBottom);
    setUserScrolledAway(!nearBottom);
    if (top > 80 && top > lastTopRef.current + 4) {
      setHeaderCollapsed(true);
    } else if (top < lastTopRef.current - 4 || top <= 0) {
      setHeaderCollapsed(false);
    }
    lastTopRef.current = top;
  }

  return {
    atBottom,
    headerCollapsed,
    onScroll,
    pinToBottom,
    scrollToBottom,
    scrollTop,
    userScrolledAway,
  };
}
