import { describe, expect, it } from 'vitest';
import { easeInOut, scrollTargetFor, smoothScroller } from '../src/lyrics/scroll.js';

describe('scrollTargetFor', () => {
  const box = { scrollTop: 0, clientHeight: 500, scrollHeight: 3000 };
  it('places the line slightly above center', () => {
    expect(scrollTargetFor(box, { offsetTop: 1000, offsetHeight: 40 })).toBe(1020 - 200);
  });
  it('clamps to the scroll range', () => {
    expect(scrollTargetFor(box, { offsetTop: 10, offsetHeight: 40 })).toBe(0);
    expect(scrollTargetFor(box, { offsetTop: 2990, offsetHeight: 40 })).toBe(2500);
  });
});

describe('easeInOut', () => {
  it('starts at 0, ends at 1, is monotonic', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
    let prev = 0;
    for (let t = 0; t <= 1; t += 0.05) {
      expect(easeInOut(t)).toBeGreaterThanOrEqual(prev);
      prev = easeInOut(t);
    }
    expect(easeInOut(2)).toBe(1);
  });
});

describe('smoothScroller', () => {
  function setup(durationMs = 400) {
    let now = 0;
    const frames: (() => void)[] = [];
    const el = { scrollTop: 0, clientHeight: 500, scrollHeight: 5000 };
    const s = smoothScroller(el, {
      durationMs,
      now: () => now,
      raf: (fn) => frames.push(fn),
      cancelRaf: () => frames.splice(0),
    });
    const advance = (ms: number) => {
      now += ms;
      const f = frames.splice(0);
      f.forEach((fn) => fn());
    };
    return { el, s, advance, frames };
  }

  it('animates to the target without overshoot', () => {
    const h = setup();
    h.s.to(1000);
    const seen: number[] = [];
    for (let i = 0; i < 30; i++) {
      h.advance(20);
      seen.push(h.el.scrollTop);
    }
    expect(h.el.scrollTop).toBe(1000);
    expect(Math.max(...seen)).toBeLessThanOrEqual(1000);
    expect(seen[1]).toBeGreaterThan(0);
    expect(seen[1]).toBeLessThan(1000);
  });

  it('retargets from the current position (a snap animates instead of jumping)', () => {
    const h = setup();
    h.s.to(1000);
    for (let i = 0; i < 10; i++) h.advance(20);
    const mid = h.el.scrollTop;
    h.s.to(3000);
    h.advance(20);
    expect(h.el.scrollTop).toBeGreaterThanOrEqual(mid);
    expect(h.el.scrollTop).toBeLessThan(3000);
    for (let i = 0; i < 30; i++) h.advance(20);
    expect(h.el.scrollTop).toBe(3000);
  });

  it('jumps directly with zero duration (reduced motion)', () => {
    const h = setup(0);
    h.s.to(700);
    expect(h.el.scrollTop).toBe(700);
    expect(h.frames).toHaveLength(0);
  });

  it('cancel stops the animation', () => {
    const h = setup();
    h.s.to(1000);
    h.advance(20);
    const at = h.el.scrollTop;
    h.s.cancel();
    h.advance(20);
    expect(h.el.scrollTop).toBe(at);
  });
});
