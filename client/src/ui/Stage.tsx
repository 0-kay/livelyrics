import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import type { SyncState } from '@livelyrics/shared';
import type { BeatFrame, ChangeSnapshot } from '../audio/rhythm.js';
import { beatFx, FlashLimiter } from './beatFx.js';
import type { DisplaySong } from './displaySong.js';
import { computeLayer, type Layer, type MeasuredLine } from './lyricsLayout.js';
import { listenCopy } from './listenCopy.js';
import {
  alpha, back, cl, DARK, ease, formatSeconds, lerp, LIGHT, mix, NIGHT, PALETTES, sizesFor, speedLabel, STATUS, type Sizes, type Theme,
} from './theme.js';

export interface StageProps {
  running: boolean;
  /** Mic could not start. denied: the browser blocked it. */
  startError: { denied: boolean; message: string } | null;
  /** performance.now() when Listen was tapped. */
  startedAt: number;
  clipSeconds: number;
  bufferedSeconds: () => number;
  /** Number of checks sent so far. */
  recognitions: number;
  /** performance.now() of the last empty check, or null. */
  lastMissAt: number | null;
  syncState: SyncState;
  rate: number;
  /** Server problem; the app keeps the clock running and retries. */
  offline: boolean;
  display: DisplaySong | null;
  getPositionMs: () => number | null;
  /** Beat readout from the mic (null when the mic is off). */
  getBeat?: (nowMs: number) => BeatFrame | null;
  /** Song-change tracker state, for the ?debug=1 readout. */
  getRhythm?: () => ChangeSnapshot | null;
  /** Written every frame with the shown position, so a song change can freeze the old lyrics where they were. */
  lastPosRef: { current: { key: string; posMs: number } | null };
  concert: { available: boolean; on: boolean; lastText: string | null };
  demoMode: boolean;
  onListen: () => void;
  onStop: () => void;
  onToggleConcert: () => void;
}

type Phase = 'idle' | 'denied' | 'listening' | 'song' | 'next';

const BTN_PRESS: CSSProperties = { transition: 'transform 150ms cubic-bezier(.2,0,0,1)' };
const MONO = "'Geist Mono', ui-monospace, monospace";

function useMedia(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [v, setV] = useState(get);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const on = () => setV(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return v;
}

/** ?debug=1 shows the rhythm tracker readout. */
function debugOn(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1';
}

/** ?theme=light or ?theme=dark from the URL. */
function themeOverride(): 'light' | 'dark' | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('theme');
  return v === 'light' || v === 'dark' ? v : null;
}

/** A pressable button that shrinks to 96% while held. */
function Press({ style, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { style: CSSProperties; children: ReactNode }) {
  const [down, setDown] = useState(false);
  return (
    <button
      {...rest}
      onPointerDown={() => setDown(true)}
      onPointerUp={() => setDown(false)}
      onPointerLeave={() => setDown(false)}
      style={{ ...BTN_PRESS, ...style, transform: down ? 'scale(0.96)' : 'none' }}
    >
      {children}
    </button>
  );
}

export function Stage(p: StageProps) {
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)');
  // Dark by default, as the brief asks. ?theme=light opts into the light theme.
  const th: Theme = useRef(themeOverride()).current === 'light' ? LIGHT : DARK;
  const debug = useRef(debugOn()).current;
  const limiter = useRef(new FlashLimiter()).current;
  const rm = reducedMotion;

  // Size of the safe area box all layout is relative to.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: typeof window === 'undefined' ? 390 : window.innerWidth, h: typeof window === 'undefined' ? 844 : window.innerHeight });
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const on = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    on();
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const S: Sizes = sizesFor(box.w, box.h);
  const W = box.w;
  const H = box.h;
  const anchor = (H - S.vpTop - S.vpBottom) * (S.tv ? 0.4 : 0.36);

  // Frame clock. Ambient motion runs at the playback rate.
  const rateRef = useRef(1);
  const ambient = useRef(4);
  const lastFrame = useRef(performance.now());
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const n = performance.now();
      ambient.current += Math.min(0.1, (n - lastFrame.current) / 1000) * rateRef.current;
      lastFrame.current = n;
      setNow(n);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const nowS = now / 1000;

  // Party mode: full screen, chrome hides after 3s without interaction.
  const [party, setParty] = useState(false);
  const [lastInteract, setLastInteract] = useState(0);
  const toggleParty = useCallback(() => {
    setParty((on) => {
      const next = !on;
      try {
        if (next && !document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
        if (!next && document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
      } catch {
        /* full screen is optional */
      }
      return next;
    });
    setLastInteract(performance.now());
  }, []);
  useEffect(() => {
    if (!p.running && party) {
      setParty(false);
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    }
  }, [p.running, party]);
  const onInteract = () => {
    if (party && performance.now() - lastInteract > 500) setLastInteract(performance.now());
  };

  // Hand scrolling pauses auto-scroll for 4s, then eases back.
  const [manual, setManual] = useState({ y: 0, at: -1e9 });
  const touchY = useRef<number | null>(null);
  const nudge = (dy: number) =>
    setManual((m) => ({ y: Math.max(-500, Math.min(500, (performance.now() - m.at < 4000 ? m.y : 0) + dy)), at: performance.now() }));

  // Measured line boxes per song, so the active line lands exactly on the anchor.
  const lineEls = useRef<Record<string, (HTMLElement | null)[]>>({});
  const [measured, setMeasured] = useState<Record<string, MeasuredLine[]>>({});
  useLayoutEffect(() => {
    const add: Record<string, MeasuredLine[]> = {};
    for (const key in lineEls.current) {
      if (measured[key]) continue;
      const arr = lineEls.current[key];
      if (!arr.length || arr.some((e) => !e || !e.isConnected)) continue;
      add[key] = arr.map((e) => ({ top: e!.offsetTop, h: e!.offsetHeight }));
    }
    if (Object.keys(add).length) setMeasured((m) => ({ ...m, ...add }));
  });
  useEffect(() => {
    setMeasured({});
  }, [W, S.tv]);
  useEffect(() => {
    document.fonts?.ready.then(() => setMeasured({})).catch(() => {});
  }, []);

  // Model for this frame.
  const disp = p.display;
  const rawPos = disp ? p.getPositionMs() : null;
  let posMs = 0;
  if (disp) {
    const last = p.lastPosRef.current;
    if (disp.lostAt === null && rawPos !== null) posMs = rawPos;
    else posMs = last && last.key === disp.key ? last.posMs : 0;
    if (disp.lostAt === null && rawPos !== null) p.lastPosRef.current = { key: disp.key, posMs };
  }
  const rate = p.rate > 0 ? p.rate : 1;
  const endReached = !!disp && disp.durationMs > 0 && posMs >= disp.durationMs;
  const shownPos = disp && disp.durationMs > 0 ? Math.min(posMs, disp.durationMs) : posMs;
  const phase: Phase = !p.running
    ? p.startError ? 'denied' : 'idle'
    : !disp ? 'listening' : disp.lostAt !== null || endReached ? 'next' : 'song';
  const nextT = disp && phase === 'next'
    ? disp.lostAt !== null ? (now - disp.lostAt) / 1000 : (posMs - disp.durationMs) / 1000 / rate
    : 0;
  rateRef.current = phase === 'song' ? rate : 1;
  const r = disp ? Math.max(0, (now - disp.matchedAt) / 1000) : 99;

  const pk = disp ? cl(r / 1.0) : 1;
  const toP = PALETTES[disp ? disp.pal : NIGHT];
  const fromP = PALETTES[disp ? disp.fromPal : NIGHT];
  const pal = { a: mix(fromP.a, toP.a, pk), b: mix(fromP.b, toP.b, pk), c: mix(fromP.c, toP.c, pk), glow: '' };
  pal.glow = alpha(pal.a, th.light ? 0.35 : 0.5);

  // Beat-reactive effects from the mic rhythm.
  const beat = p.running && p.getBeat ? p.getBeat(now) : null;
  const fx = beatFx(beat, pal, now, limiter, rm, nowS);

  const A = rm ? 4 : ambient.current;
  const blobs = (['a', 'b', 'c'] as const).map((k, i) => {
    const size = S.tv ? W * 0.85 : W * 1.55;
    const x = W * (0.5 + 0.34 * Math.sin(A * 0.2 + i * 2.1)) - size / 2;
    const y = H * (0.2 + i * 0.3 + 0.1 * Math.cos(A * 0.16 + i * 1.3)) - size / 2;
    return { size, bg: `radial-gradient(circle at center, ${pal[k]} 0%, transparent 62%)`, tf: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${fx.blobScale.toFixed(3)})` };
  });

  const halo = (off: number, period: number, amp: number, maxOp: number) => {
    const ph = ((nowS + off) % period) / period;
    return rm ? { op: maxOp / 2.2, s: 1 + amp / 4 } : { op: maxOp * (1 - ph), s: 1 + amp * ph };
  };
  const iA = halo(0, 2.4, 0.45, 0.55);
  const iB = halo(1.2, 2.4, 0.45, 0.55);
  const hA = halo(0, 1.2, 0.24, 0.5);
  const hB = halo(0.6, 1.2, 0.24, 0.5);
  const pulse = (period: number) => (rm ? 1 : 0.55 + 0.45 * Math.cos((nowS * Math.PI * 2) / period));
  const spin = rm ? 0 : (nowS * 360) % 360;

  // Listening.
  const listening = phase === 'listening';
  const lc = listening
    ? listenCopy({
        elapsedS: (now - p.startedAt) / 1000,
        bufferedS: p.bufferedSeconds(),
        clipS: p.clipSeconds,
        missAgoS: p.lastMissAt === null ? null : (now - p.lastMissAt) / 1000,
        checked: p.recognitions > 0,
      })
    : null;
  const sk = lc && lc.searching ? cl(lc.searchAgeS / 0.4) : 0;
  const ringDash = lc ? (289.03 * (1 - lc.fill)).toFixed(2) : '289.03';
  const sparks = lc && lc.searching && !rm
    ? [0, 1, 2, 3, 4, 5].map((i) => {
        const ang = ((i * 60 + nowS * 40) * Math.PI) / 180;
        const R = S.ring / 2 + (S.tv ? 26 : 16) + 6 * Math.sin(nowS * 2 + i);
        const size = S.tv ? 7 : 5;
        return { size, op: sk * cl(0.5 + 0.5 * Math.sin(nowS * 5 + i * 1.7)), tf: `translate(${(S.ring / 2 + Math.cos(ang) * R - size / 2).toFixed(1)}px, ${(S.ring / 2 + Math.sin(ang) * R - size / 2).toFixed(1)}px)` };
      })
    : [];
  // Real mic loudness and beats drive the equalizer when available.
  const eqBars = [0, 1, 2, 3, 4].map((i) =>
    rm ? 0.55 : beat ? fx.eq[i]! : (0.3 + 0.7 * Math.abs(Math.sin((nowS * Math.PI) / 0.6 + i * 0.95))) * (lc?.searching ? 0.75 : 1),
  );
  const copyOp = lc ? Math.min(1, lc.slotS / 0.3) : 0;
  const copyY = lc && !rm ? 10 * (1 - ease(lc.slotS / 0.3)) : 0;

  // Lyrics layers.
  const isSongish = phase === 'song' || phase === 'next';
  const layers: (Layer & { key: string; op: number; ty: number })[] = [];
  let cur: Layer | null = null;
  if (isSongish && disp?.lines) {
    const base = { sizes: S, anchor, reducedMotion: rm, light: th.light, accent: pal.a, dotIdle: th.dotIdle, nowS };
    if (disp.prev && r < 0.7) {
      const k = rm ? cl(r / 0.3) : ease(r / 0.7);
      const L0 = computeLayer({ ...base, lines: disp.prev.lines, durationMs: disp.prev.durationMs, positionMs: disp.prev.posMs, rate: 1, measured: measured[`${disp.prev.key}#${disp.prev.lines.length}`] ?? null });
      layers.push({ ...L0, key: `${disp.prev.key}#${disp.prev.lines.length}`, op: 0.28 * (1 - k), ty: rm ? 0 : -70 * k });
    }
    cur = computeLayer({ ...base, lines: disp.lines, durationMs: disp.durationMs, positionMs: posMs, rate, measured: measured[`${disp.key}#${disp.lines.length}`] ?? null });
    let op: number;
    let ty: number;
    if (phase === 'next') {
      op = lerp(1, 0.22, ease(nextT / 0.5));
      ty = 0;
    } else {
      const k = ease((r - 0.1) / 0.5);
      op = rm ? cl((r - 0.1) / 0.3) : k;
      ty = rm ? 0 : 48 * (1 - k);
    }
    const mAge = now - manual.at;
    const man = mAge < 4000 ? manual.y : manual.y * (1 - ease((mAge - 4000) / 450));
    layers.push({ ...cur, key: `${disp.key}#${disp.lines.length}`, y: cur.y + man, op, ty });
  }

  const g = th.light ? 0 : 1 - cl(r / 0.6);
  const hdr = isSongish && disp
    ? {
        op: phase === 'next' ? lerp(1, 0.45, ease(nextT / 0.5)) : rm ? cl(r / 0.3) : cl(r / 0.15),
        s: rm || phase === 'next' ? 1 : 0.86 + 0.14 * back(cl(r / 0.4)),
        glow: g > 0.01 ? `0 0 22px ${alpha(pal.a, g * 0.9)}` : 'none',
      }
    : null;

  const confetti = phase === 'song' && !rm && r < 0.6
    ? Array.from({ length: 24 }, (_, i) => {
        const ox = S.pad + (S.tv ? 160 : 80);
        const oy = S.titleTop + 14;
        const ang = -Math.PI / 2 + (i / 23 - 0.5) * Math.PI * 1.7 + (((i * 37) % 10) - 5) * 0.02;
        const v = S.conf * (0.55 + ((i * 53) % 45) / 100);
        const x = ox + Math.cos(ang) * v * r;
        const y = oy + Math.sin(ang) * v * r + S.grav * r * r;
        const cols = [pal.a, pal.b, pal.c, '#ffffff'];
        return { c: cols[i % 4], op: 1 - cl((r - 0.32) / 0.28), tf: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(i * 47 + r * 600) % 360}deg)` };
      })
    : [];

  let pill: { label: string; color: string; dotOp: number } = { label: 'Listening', color: STATUS.listen, dotOp: pulse(1.2) };
  if (phase === 'next') pill = { label: 'Next song…', color: STATUS.listen, dotOp: pulse(1.2) };
  else if (phase === 'song') {
    if (r < 1.4) pill = { label: 'Got it!', color: STATUS.lock, dotOp: 1 };
    else if (p.syncState === 'confirming') pill = { label: 'Getting in sync', color: STATUS.sync, dotOp: pulse(1.2) };
    else if (p.syncState === 'locked') pill = { label: 'In sync', color: STATUS.lock, dotOp: 1 };
    else pill = { label: 'Re-syncing', color: STATUS.drift, dotOp: pulse(0.8) };
  }

  const speed = phase === 'song' && r > 3 ? speedLabel(rate) : null;
  const badgeS = rm ? 1 : 0.7 + 0.3 * back(cl((r - 3) / 0.25));
  const chromeHidden = party && now - lastInteract > 3000;
  const chromeOp = chromeHidden ? 0 : 1;

  const nextOv = phase === 'next'
    ? { op: rm ? cl(nextT / 0.3) : ease(nextT / 0.35), y: rm ? 0 : 16 * (1 - ease(nextT / 0.35)) }
    : null;
  const instK = rm ? cl((r - 0.1) / 0.3) : ease((r - 0.1) / 0.5);
  const instBars = Array.from({ length: 9 }, (_, i) => {
    if (rm) return 0.5;
    const shape = Math.abs(Math.sin((nowS * Math.PI) / 0.7 + i * 0.7) * Math.cos(nowS * 0.9 + i * 0.4));
    return beat ? Math.min(1, 0.2 + 0.5 * beat.level * (0.5 + shape) + 0.3 * fx.pulse * (1 - Math.abs(i - 4) / 5)) : 0.25 + 0.75 * shape;
  });
  const glowColor = pal[fx.glowSlot];

  let capText = '';
  if (p.concert.on && p.concert.lastText) capText = `Heard: “…${p.concert.lastText.trim().split(/\s+/).slice(-4).join(' ').toLowerCase()}”`;
  else if (p.concert.on && phase === 'song') capText = 'Listening for sung words…';

  const liveText = phase === 'denied'
    ? 'Microphone blocked. Follow the steps, then tap Try again.'
    : phase === 'idle' ? '' : listening && lc ? lc.copy : phase === 'next' ? 'Next song. Listening.' : disp ? `${disp.title} by ${disp.artist}. ${pill.label}.` : '';

  const pad = S.pad;
  const running = phase !== 'idle' && phase !== 'denied';

  return (
    <div
      aria-label="LiveLyrics"
      onPointerDown={onInteract}
      onPointerMove={onInteract}
      onWheel={(e) => {
        onInteract();
        if (cur) nudge(-e.deltaY);
      }}
      onTouchStart={(e) => {
        touchY.current = e.touches[0]?.clientY ?? null;
      }}
      onTouchMove={(e) => {
        const y = e.touches[0]?.clientY;
        if (cur && y !== undefined && touchY.current !== null) nudge(y - touchY.current);
        touchY.current = y ?? null;
      }}
      style={{
        position: 'fixed', inset: 0, overflow: 'hidden', isolation: 'isolate', background: th.bg, color: th.ink,
        fontFamily: 'Geist, system-ui, sans-serif', WebkitFontSmoothing: 'antialiased', touchAction: cur ? 'none' : 'manipulation',
        cursor: chromeHidden ? 'none' : undefined,
      }}
    >
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        {blobs.map((b, i) => (
          <div key={i} style={{ position: 'absolute', left: 0, top: 0, borderRadius: '50%', width: b.size, height: b.size, background: b.bg, opacity: th.blobOp + fx.blobOpacity, transform: b.tf, willChange: 'transform' }} />
        ))}
        <div style={{ position: 'absolute', inset: 0, background: th.vignette }} />
        {fx.lights.map((l, i) => (
          <div
            key={i}
            style={{
              position: 'absolute', left: 0, top: 0, width: W * 0.9, height: W * 0.9, borderRadius: '50%',
              background: `radial-gradient(circle at center, ${l.color} 0%, transparent 60%)`, opacity: l.opacity,
              transform: `translate(${(l.x * W - W * 0.45).toFixed(1)}px, ${(l.y * H - W * 0.45).toFixed(1)}px)`,
            }}
          />
        ))}
      </div>

      <div
        ref={boxRef}
        style={{
          position: 'absolute', left: 'env(safe-area-inset-left)', right: 'env(safe-area-inset-right)',
          top: 'env(safe-area-inset-top)', bottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {phase === 'idle' && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', boxSizing: 'border-box', padding: S.tv ? '200px 200px 0' : '110px 32px 0' }}>
            <h1 style={{ margin: 0, fontSize: S.idleHead, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.035em', textWrap: 'balance', maxWidth: S.copyMax }}>Got a song playing?</h1>
            <p style={{ margin: '18px 0 0', fontSize: S.idleSub, lineHeight: 1.4, opacity: 0.78, maxWidth: S.copyMax, textWrap: 'pretty' }}>
              Hold me near the music and tap Listen. I'll bring the lyrics, you bring the voice!
            </p>
            <div style={{ flex: 1 }} />
            <div style={{ position: 'relative', width: S.listenBtn, height: S.listenBtn }}>
              <div aria-hidden="true" style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${pal.a}`, opacity: iA.op, transform: `scale(${iA.s})` }} />
              <div aria-hidden="true" style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${pal.b}`, opacity: iB.op, transform: `scale(${iB.s})` }} />
              <Press
                onClick={p.onListen}
                style={{
                  position: 'absolute', inset: 0, border: 0, borderRadius: '50%', cursor: 'pointer',
                  background: `linear-gradient(140deg, ${pal.a}, ${pal.b})`, color: '#0b0a10', fontSize: S.listenFont, fontWeight: 800,
                  letterSpacing: '-0.01em', boxShadow: `0 0 60px ${pal.glow}`,
                }}
              >
                Listen
              </Press>
            </div>
            <div style={{ height: S.tv ? 160 : 110, display: 'flex', alignItems: 'center' }}>
              {p.demoMode && <span style={{ fontFamily: MONO, fontSize: S.smallFont, opacity: 0.55 }}>Demo mode · sample songs</span>}
            </div>
          </div>
        )}

        {phase === 'denied' && p.startError && (
          <>
            <div style={{ position: 'absolute', inset: 0, zIndex: 2, boxSizing: 'border-box', padding: S.tv ? '120px 30% 160px' : '72px 28px 140px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
              <div aria-hidden="true" style={{ position: 'relative', flex: 'none', width: 76, height: 76, borderRadius: '50%', background: th.chip, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: 22, height: 34, borderRadius: 12, border: `3px solid ${th.ink}`, boxSizing: 'border-box' }} />
                <div style={{ position: 'absolute', width: 52, height: 3, borderRadius: 2, background: STATUS.drift, transform: 'rotate(-45deg)' }} />
              </div>
              {p.startError.denied ? (
                <>
                  <h1 style={{ margin: 0, fontSize: 38, fontWeight: 800, lineHeight: 1.02, letterSpacing: '-0.03em' }}>I can't hear you yet!</h1>
                  <p style={{ margin: 0, fontSize: 17, lineHeight: 1.45, opacity: 0.8, textWrap: 'pretty' }}>Your browser blocked the mic, so I can't catch the song. Quick fix:</p>
                  <ol style={{ listStyle: 'none', padding: 0, margin: '6px 0 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {[<>Tap the icon next to the web address</>, <>Set <b>Microphone</b> to <b>Allow</b></>, <>Come back and tap Try again</>].map((t, i) => (
                      <li key={i} style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '14px 16px', borderRadius: 18, background: th.chip }}>
                        <div style={{ flex: 'none', width: 30, height: 30, borderRadius: '50%', background: pal.a, color: '#0b0a10', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>{i + 1}</div>
                        <div style={{ fontSize: 16, lineHeight: 1.35 }}>{t}</div>
                      </li>
                    ))}
                  </ol>
                </>
              ) : (
                <>
                  <h1 style={{ margin: 0, fontSize: 38, fontWeight: 800, lineHeight: 1.02, letterSpacing: '-0.03em' }}>The mic didn't start</h1>
                  <p style={{ margin: 0, fontSize: 17, lineHeight: 1.45, opacity: 0.8, textWrap: 'pretty' }}>Something got in the way: {p.startError.message}. Check that no other app is using the mic, then try again.</p>
                </>
              )}
            </div>
            <div style={{ position: 'absolute', left: 24, right: 24, bottom: 34, zIndex: 4, display: 'flex', justifyContent: 'center' }}>
              <Press
                onClick={p.onListen}
                style={{ height: 64, width: '100%', maxWidth: 520, border: 0, borderRadius: 99, cursor: 'pointer', background: `linear-gradient(140deg, ${pal.a}, ${pal.b})`, color: '#0b0a10', fontSize: 19, fontWeight: 800 }}
              >
                Try again
              </Press>
            </div>
          </>
        )}

        {running && (
          <div style={{ position: 'absolute', zIndex: 4, top: S.headerTop, left: pad, right: pad, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, opacity: chromeOp, transition: 'opacity 300ms ease' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: S.pillH, padding: '0 14px 0 12px', borderRadius: 99, background: th.chip, fontSize: S.pillFont, fontWeight: 600, whiteSpace: 'nowrap' }}>
                <div aria-hidden="true" style={{ width: S.pillDot, height: S.pillDot, borderRadius: '50%', background: pill.color, boxShadow: `0 0 10px ${pill.color}`, opacity: pill.dotOp, transition: 'background-color 300ms ease' }} />
                <span>{pill.label}</span>
              </div>
              {p.offline && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, height: S.pillH, padding: '0 12px', borderRadius: 99, border: `1px dashed ${th.track}`, fontSize: S.smallFont, fontWeight: 500, whiteSpace: 'nowrap' }}>
                  <div aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: STATUS.drift, opacity: pulse(0.8) }} />
                  Reconnecting…
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {speed && (
                <div style={{ display: 'flex', alignItems: 'center', height: S.pillH, padding: '0 14px', borderRadius: 99, background: pal.a, color: '#0b0a10', fontSize: S.pillFont, fontWeight: 700, whiteSpace: 'nowrap', transform: `scale(${badgeS})`, opacity: cl((r - 3) / 0.15) }}>{speed}</div>
              )}
              {isSongish && disp && (
                <div style={{ fontFamily: MONO, fontSize: S.smallFont, opacity: 0.62, fontVariantNumeric: 'tabular-nums' }}>
                  {formatSeconds(shownPos / 1000)}{disp.durationMs > 0 ? ` / ${formatSeconds(disp.durationMs / 1000)}` : ''}
                </div>
              )}
            </div>
          </div>
        )}

        {listening && lc && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: S.gap, boxSizing: 'border-box', padding: `0 ${pad}px ${S.listenPadB}px` }}>
            <div aria-hidden="true" style={{ position: 'relative', flex: 'none', width: S.ring, height: S.ring }}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: `radial-gradient(circle, ${pal.glow} 0%, transparent 70%)`, opacity: 0.7 }} />
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${pal.a}`, opacity: hA.op, transform: `scale(${hA.s})` }} />
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${pal.b}`, opacity: hB.op, transform: `scale(${hB.s})` }} />
              <svg viewBox="0 0 100 100" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', transform: 'rotate(-90deg)', overflow: 'visible' }}>
                <circle cx="50" cy="50" r="46" fill="none" stroke={th.track} strokeWidth="3" />
                <circle cx="50" cy="50" r="46" fill="none" stroke={pal.a} strokeWidth="3.4" strokeLinecap="round" strokeDasharray="289.03" strokeDashoffset={ringDash} opacity={1 - sk * 0.65} />
              </svg>
              <div
                style={{
                  position: 'absolute', inset: 0, borderRadius: '50%',
                  background: `conic-gradient(from 0deg, transparent 0deg, transparent 250deg, ${pal.a} 350deg, #fff 360deg)`,
                  WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px))',
                  mask: 'radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px))',
                  opacity: sk, transform: `rotate(${rm ? 0 : (nowS * 240) % 360}deg)`,
                }}
              />
              {sparks.map((sp, i) => (
                <div key={i} style={{ position: 'absolute', left: 0, top: 0, width: sp.size, height: sp.size, borderRadius: '50%', background: '#fff', boxShadow: `0 0 8px ${pal.a}`, opacity: sp.op, transform: sp.tf }} />
              ))}
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: S.eqGap }}>
                {eqBars.map((s, i) => (
                  <div key={i} style={{ width: S.eqW, height: S.eqH, borderRadius: 99, background: `linear-gradient(180deg, ${pal.a}, ${pal.b})`, transform: `scaleY(${s})` }} />
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, minHeight: S.copyBlock }}>
              <div style={{ fontSize: S.listenCopy, fontWeight: 800, letterSpacing: '-0.03em', textAlign: 'center', lineHeight: 1.08, maxWidth: S.copyMax, textWrap: 'balance', opacity: copyOp, transform: `translateY(${copyY}px)` }}>{lc.copy}</div>
              <div style={{ fontFamily: MONO, fontSize: S.smallFont, opacity: 0.66, fontVariantNumeric: 'tabular-nums', textAlign: 'center' }}>{lc.caption}</div>
            </div>
          </div>
        )}

        {hdr && disp && (
          <div style={{ position: 'absolute', zIndex: 3, top: S.titleTop, left: pad, right: pad, transformOrigin: 'left center', opacity: hdr.op, transform: `scale(${hdr.s})` }}>
            <div style={{ fontSize: S.titleFont, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textShadow: hdr.glow }}>{disp.title}</div>
            <div style={{ fontSize: S.artistFont, fontWeight: 500, opacity: 0.68, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{disp.artist}</div>
          </div>
        )}

        {layers.length > 0 && (
          <div
            style={{
              position: 'absolute', zIndex: 2, left: 0, right: 0, overflow: 'hidden', top: S.vpTop, bottom: S.vpBottom,
              WebkitMaskImage: 'linear-gradient(transparent, #000 13%, #000 80%, transparent)',
              maskImage: 'linear-gradient(transparent, #000 13%, #000 80%, transparent)',
            }}
          >
            {layers.map((layer) => (
              <div key={layer.key} style={{ position: 'absolute', inset: 0, opacity: layer.op, transform: `translateY(${layer.ty}px)` }}>
                <ol style={{ listStyle: 'none', margin: 0, padding: 0, position: 'relative', transform: `translateY(${layer.y}px)`, willChange: 'transform' }}>
                  {layer.lines.map((ln, i) => (
                    <li
                      key={ln.key}
                      ref={(el) => {
                        (lineEls.current[layer.key] = lineEls.current[layer.key] || [])[i] = el;
                      }}
                      aria-current={ln.active ? 'true' : undefined}
                      aria-hidden={ln.blank ? 'true' : undefined}
                      style={{ boxSizing: 'border-box', textAlign: 'center', transformOrigin: 'center center', padding: `${S.linePad}px ${pad}px`, opacity: ln.opacity, transform: ln.active ? `translateY(${fx.lineLift.toFixed(1)}px) scale(${(ln.scale * fx.lineScale).toFixed(4)})` : `scale(${ln.scale})` }}
                    >
                      {!ln.blank ? (
                        <>
                          <div style={{ fontSize: S.lineFont, fontWeight: 700, lineHeight: 1.16, letterSpacing: '-0.022em', textWrap: 'balance', textShadow: ln.active && !th.light ? `0 0 ${fx.glowPx.toFixed(0)}px ${alpha(glowColor, fx.glowAlpha)}` : ln.glow, overflowWrap: 'anywhere' }}>{ln.text}</div>
                          <div aria-hidden="true" style={{ margin: `${S.barGap}px auto 0`, width: S.barW, maxWidth: '70%', height: S.barH, borderRadius: 99, background: th.track, overflow: 'hidden', opacity: ln.barOpacity }}>
                            <div style={{ height: '100%', width: '100%', borderRadius: 99, background: `linear-gradient(90deg, ${pal.a}, ${pal.b})`, transformOrigin: 'left center', transform: `scaleX(${ln.progress})` }} />
                          </div>
                        </>
                      ) : (
                        <>
                          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: S.dotGap, height: S.dotRow }}>
                            {ln.dots.map((d, k) => (
                              <div key={k} style={{ width: S.dot, height: S.dot, borderRadius: '50%', background: d.bg, boxShadow: d.shadow, opacity: d.opacity, transform: `scale(${d.scale})` }} />
                            ))}
                          </div>
                          <div style={{ fontSize: S.smallFont, fontWeight: 600, letterSpacing: '.02em', marginTop: S.barGap, height: S.capH, opacity: ln.captionOpacity }}>{ln.caption}</div>
                        </>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}

        {nextOv && (
          <div style={{ position: 'absolute', zIndex: 4, left: 0, right: 0, display: 'flex', justifyContent: 'center', top: S.vpTop + anchor - (S.tv ? 40 : 26), opacity: nextOv.op, transform: `translateY(${nextOv.y}px)` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 22px 14px 16px', borderRadius: 99, background: th.solid, boxShadow: `0 10px 40px ${pal.glow}`, fontSize: S.nextFont, fontWeight: 800, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
              <div aria-hidden="true" style={{ flex: 'none', width: S.mini, height: S.mini, borderRadius: '50%', boxSizing: 'border-box', border: `3px solid ${th.track}`, borderTopColor: pal.a, borderRightColor: pal.b, transform: `rotate(${spin}deg)` }} />
              Ooh, next song? I'm on it!
            </div>
          </div>
        )}

        {phase === 'song' && disp?.instrumental && (
          <div style={{ position: 'absolute', zIndex: 2, left: pad, right: pad, top: S.vpTop, bottom: S.vpBottom, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 28, textAlign: 'center', opacity: instK }}>
            <div aria-hidden="true" style={{ display: 'flex', alignItems: 'center', gap: S.eqGap, height: S.tv ? 200 : 110 }}>
              {instBars.map((s, i) => (
                <div key={i} style={{ width: S.eqW, height: S.tv ? 200 : 110, borderRadius: 99, background: `linear-gradient(180deg, ${pal.a}, ${pal.b})`, transform: `scaleY(${s})` }} />
              ))}
            </div>
            <div style={{ fontSize: S.msgFont, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.05, textWrap: 'balance' }}>No words, just vibes!</div>
            <div style={{ fontSize: S.idleSub, lineHeight: 1.4, opacity: 0.75, maxWidth: S.copyMax, textWrap: 'pretty' }}>This one's instrumental. Dance it out, I'll catch the next song with lyrics.</div>
          </div>
        )}

        {phase === 'song' && disp?.noLyrics && (
          <div style={{ position: 'absolute', zIndex: 2, left: pad, right: pad, top: S.vpTop, bottom: S.vpBottom, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22, textAlign: 'center', opacity: instK }}>
            <div style={{ fontSize: S.msgFont, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.05, textWrap: 'balance' }}>I know this one… but not the words!</div>
            <div style={{ fontSize: S.idleSub, lineHeight: 1.4, opacity: 0.75, maxWidth: S.copyMax, textWrap: 'pretty' }}>No synced lyrics for this track. Hum along, I'm listening for the next song.</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, padding: '10px 16px', borderRadius: 99, background: th.chip, fontSize: S.smallFont, fontWeight: 600 }}>
              <div aria-hidden="true" style={{ width: 16, height: 16, borderRadius: '50%', boxSizing: 'border-box', border: `2.5px solid ${th.track}`, borderTopColor: pal.a, transform: `rotate(${spin}deg)` }} />
              Still listening
            </div>
          </div>
        )}

        {confetti.map((c, i) => (
          <div key={i} aria-hidden="true" style={{ position: 'absolute', zIndex: 6, left: 0, top: 0, width: 7, height: 12, borderRadius: 2, pointerEvents: 'none', background: c.c, opacity: c.op, transform: c.tf }} />
        ))}

        {p.concert.on && phase === 'song' && capText && (
          <div style={{ position: 'absolute', zIndex: 4, left: pad, right: pad, textAlign: 'center', bottom: S.tv ? 150 : 112, fontSize: S.smallFont, lineHeight: 1.35, opacity: 0.6, fontStyle: 'italic' }}>{capText}</div>
        )}

        {running && (
          <div
            style={{
              position: 'absolute', zIndex: 5, bottom: S.tv ? 40 : 34, left: '50%', width: S.tv ? 480 : 'calc(100% - 48px)', transform: 'translateX(-50%)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, opacity: chromeOp, transition: 'opacity 300ms ease',
              pointerEvents: chromeHidden ? 'none' : undefined,
            }}
          >
            <Press
              aria-label="Party mode"
              aria-pressed={party}
              onClick={toggleParty}
              style={{ flex: 'none', width: 56, height: 56, borderRadius: '50%', border: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', background: party ? pal.a : th.chip, color: party ? '#0b0a10' : th.ink }}
            >
              <div style={{ width: 22, height: 15, border: '2px solid currentColor', borderRadius: 3, boxSizing: 'border-box' }} />
            </Press>
            <Press
              onClick={p.onStop}
              style={{ flex: 1, maxWidth: 190, height: 64, borderRadius: 99, border: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, background: th.chipStrong, color: th.ink, fontSize: 19, fontWeight: 700 }}
            >
              <div style={{ width: 13, height: 13, borderRadius: 3, background: 'currentColor' }} />
              Stop
            </Press>
            {p.concert.available ? (
              <Press
                aria-label="Concert mode, experimental"
                aria-pressed={p.concert.on}
                onClick={p.onToggleConcert}
                style={{ flex: 'none', width: 56, height: 56, borderRadius: '50%', border: 0, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, background: th.chip, color: th.ink, fontSize: 10, fontWeight: 700, letterSpacing: '.04em', opacity: p.concert.on ? 1 : 0.6 }}
              >
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.concert.on ? pal.a : th.track }} />
                LIVE
              </Press>
            ) : (
              <div style={{ flex: 'none', width: 56, height: 56 }} />
            )}
          </div>
        )}

        {S.tv && running && party && !chromeHidden && (
          <div style={{ position: 'absolute', zIndex: 4, right: pad, bottom: 56, fontFamily: MONO, fontSize: 16, opacity: 0.45 }}>Party mode · controls hide after 3s</div>
        )}
      </div>

      {debug && running && (
        <RhythmDebug beat={beat} rhythm={p.getRhythm ? p.getRhythm() : null} />
      )}

      <div aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>{liveText}</div>
    </div>
  );
}

function RhythmDebug({ beat, rhythm }: { beat: BeatFrame | null; rhythm: ChangeSnapshot | null }) {
  const f = (n: number | null | undefined, d = 0) => (n == null ? '-' : n.toFixed(d));
  return (
    <div style={{ position: 'absolute', zIndex: 9, left: 12, bottom: 110, padding: '8px 10px', borderRadius: 10, background: 'rgba(0,0,0,.6)', color: '#fff', fontFamily: MONO, fontSize: 11, lineHeight: 1.5, pointerEvents: 'none' }}>
      <div>beat {f(beat?.bpm, 1)} BPM · {beat?.energy ?? '-'} · lvl {f(beat?.level, 2)} · {beat?.onGrid ? 'grid' : 'onsets'}</div>
      <div>song {rhythm?.state ?? '-'} · ref {f(rhythm?.refBpm, 1)} · now {f(rhythm?.bpm, 1)} · conf {f(rhythm?.confidence, 2)}</div>
      <div>{rhythm?.verdict ?? '-'} · on grid {f(rhythm ? rhythm.onGridShare * 100 : null)}% · off for {f(rhythm ? rhythm.mismatchMs / 1000 : null, 1)}s</div>
    </div>
  );
}
