/** Minimal element shape so the math can be tested without a DOM. */
export interface ScrollBox {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export interface LineBox {
  offsetTop: number;
  offsetHeight: number;
}

/** scrollTop that centers the line in the container, clamped to the scroll range. */
export function scrollTargetFor(container: ScrollBox, line: LineBox, anchor = 0.4): number {
  const target = line.offsetTop + line.offsetHeight / 2 - container.clientHeight * anchor;
  const max = Math.max(0, container.scrollHeight - container.clientHeight);
  return Math.round(Math.min(max, Math.max(0, target)));
}

/** Ease in-out cubic, t in 0..1. */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export interface SmoothScrollerOptions {
  durationMs?: number;
  now?: () => number;
  raf?: (fn: () => void) => number;
  cancelRaf?: (id: number) => void;
}

/**
 * Eased scrolling of one element. A new target retargets from the current
 * position, so a snap (large jump) animates instead of teleporting and quick
 * successive lines never stutter.
 */
export function smoothScroller(el: ScrollBox, opts: SmoothScrollerOptions = {}) {
  const duration = opts.durationMs ?? 450;
  const now = opts.now ?? (() => performance.now());
  const raf = opts.raf ?? ((fn) => requestAnimationFrame(fn));
  const cancelRaf = opts.cancelRaf ?? ((id) => cancelAnimationFrame(id));
  let frame: number | null = null;

  const cancel = () => {
    if (frame !== null) cancelRaf(frame);
    frame = null;
  };

  const to = (target: number) => {
    cancel();
    const from = el.scrollTop;
    if (duration <= 0 || Math.abs(target - from) < 1) {
      el.scrollTop = target;
      return;
    }
    const start = now();
    const step = () => {
      const t = (now() - start) / duration;
      el.scrollTop = from + (target - from) * easeInOut(t);
      frame = t < 1 ? raf(step) : null;
    };
    frame = raf(step);
  };

  return { to, cancel };
}
