import { useEffect, useRef, useState } from 'react';
import { findLineIndex, type LyricLine } from '@livelyrics/shared';
import { scrollTargetFor, smoothScroller } from './scroll.js';

export interface LyricsPlayerProps {
  lines: LyricLine[];
  /** Returns the current song position in ms. Called every animation frame. */
  getPositionMs: () => number;
}

/**
 * Renders lyrics, highlights the active line (binary search each frame) and
 * keeps it centered with an eased scroll of the lyrics panel only, so the page
 * itself never jumps. Re-renders only when the active line changes.
 */
export function LyricsPlayer({ lines, getPositionMs }: LyricsPlayerProps) {
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLOListElement | null>(null);
  const positionRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<(HTMLLIElement | null)[]>([]);
  const userScrollUntil = useRef(0);

  useEffect(() => {
    let raf = 0;
    let lastSecond = -1;
    const tick = () => {
      const pos = getPositionMs();
      const second = Math.floor(pos / 1000);
      if (second !== lastSecond && positionRef.current) {
        lastSecond = second;
        positionRef.current.textContent = formatMs(pos);
      }
      setActive(findLineIndex(lines, pos));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lines, getPositionMs]);

  // One scroller per list element; it eases toward the latest target.
  const scroller = useRef<ReturnType<typeof smoothScroller> | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const s = smoothScroller(list, { durationMs: reduced ? 0 : 450 });
    scroller.current = s;
    // Pause auto scroll for a few seconds after the user scrolls by hand.
    const pause = () => {
      userScrollUntil.current = performance.now() + 4_000;
      s.cancel();
    };
    list.addEventListener('wheel', pause, { passive: true });
    list.addEventListener('touchstart', pause, { passive: true });
    return () => {
      s.cancel();
      list.removeEventListener('wheel', pause);
      list.removeEventListener('touchstart', pause);
    };
  }, []);

  useEffect(() => {
    const list = listRef.current;
    const el = lineRefs.current[Math.max(0, active)];
    if (!list || !el || performance.now() < userScrollUntil.current) return;
    scroller.current?.to(scrollTargetFor(list, el));
  }, [active]);

  return (
    <div className="player">
      <div className="position" aria-label="Song position" ref={positionRef}>
        0:00
      </div>
      <ol className="lyrics" ref={listRef}>
        {lines.map((l, i) => (
          <li
            key={`${l.startMs}-${i}`}
            ref={(el) => {
              lineRefs.current[i] = el;
            }}
            className={`line${i === active ? ' active' : i < active ? ' past' : ''}${l.text ? '' : ' blank'}`}
            aria-current={i === active ? 'true' : undefined}
          >
            {l.text || ' '}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function formatMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
