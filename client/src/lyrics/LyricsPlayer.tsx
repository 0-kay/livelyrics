import { useEffect, useRef, useState } from 'react';
import { findLineIndex, type LyricLine } from '@livelyrics/shared';

export interface LyricsPlayerProps {
  lines: LyricLine[];
  /** Returns the current song position in ms. Called every animation frame. */
  getPositionMs: () => number;
}

/** Renders lyrics and highlights the active line using a binary search each frame. */
export function LyricsPlayer({ lines, getPositionMs }: LyricsPlayerProps) {
  const [active, setActive] = useState(-1);
  const [positionMs, setPositionMs] = useState(0);
  const lineRefs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const pos = getPositionMs();
      setPositionMs(pos);
      setActive(findLineIndex(lines, pos));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lines, getPositionMs]);

  useEffect(() => {
    lineRefs.current[active]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [active]);

  return (
    <div className="player">
      <div className="position" aria-label="Song position">{formatMs(positionMs)}</div>
      <ol className="lyrics">
        {lines.map((l, i) => (
          <li
            key={`${l.startMs}-${i}`}
            ref={(el) => {
              lineRefs.current[i] = el;
            }}
            className={i === active ? 'line active' : i < active ? 'line past' : 'line'}
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
