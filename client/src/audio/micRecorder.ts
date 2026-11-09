import { FloatRingBuffer } from './ringBuffer.js';
import { RhythmWatch, type BeatFrame, type ChangeSnapshot } from './rhythm.js';
import { SoundSignature, type SignatureSnapshot } from './signature.js';
import { SilenceGapDetector } from './silence.js';
import { downsample, encodeWav } from './wav.js';

export interface MicClip {
  blob: Blob;
  mime: string;
  durationMs: number;
  /** performance.now() at the moment the last sample was captured. */
  capturedAtMs: number;
}

export interface MicRecorderOptions {
  /** Length of the rolling buffer in seconds. Default 10. */
  bufferSeconds?: number;
  /** Sample rate of the uploaded WAV. Default 16000. */
  targetSampleRate?: number;
  /** Called when sound returns after a gap in the audio (a track ended or was cut). */
  onGapEnd?: () => void;
}

// AudioWorklet that forwards mono input frames to the main thread.
const WORKLET_SRC = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('livelyrics-tap', Tap);
`;

/**
 * Captures mic audio into a rolling buffer (default 10s) and exports the most
 * recent audio as a 16 kHz mono WAV clip for upload.
 */
export class MicRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private ring: FloatRingBuffer | null = null;
  private lastSampleAt = 0;
  private readonly bufferSeconds: number;
  private readonly targetSampleRate: number;
  private readonly gap = new SilenceGapDetector();
  /** Set or replace the gap callback at any time. */
  onGapEnd: (() => void) | undefined;
  /** Called when the local rhythm tracker decides the song changed (no network). */
  onSongChange: (() => void) | undefined;
  /** Called with the estimated change point when the sound signature shifts (no network). */
  onSignatureChange: ((changeAtMs: number) => void) | undefined;
  private rhythm: RhythmWatch | null = null;
  private signature: SoundSignature | null = null;
  private armedKey: string | null = null;

  constructor(opts: MicRecorderOptions = {}) {
    this.bufferSeconds = opts.bufferSeconds ?? 10;
    this.targetSampleRate = opts.targetSampleRate ?? 16_000;
    this.onGapEnd = opts.onGapEnd;
  }

  get running(): boolean {
    return this.ctx !== null;
  }

  async start(): Promise<void> {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const ctx = new AudioContext();
    this.ctx = ctx;
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.ring = new FloatRingBuffer(Math.round(ctx.sampleRate * this.bufferSeconds));
    this.gap.reset();
    this.rhythm = new RhythmWatch(ctx.sampleRate);
    this.rhythm.change.onChange = () => this.onSongChange?.();
    this.signature = new SoundSignature(ctx.sampleRate);
    this.signature.onChange = (at) => this.onSignatureChange?.(at);
    if (this.armedKey) {
      this.rhythm.change.arm(this.armedKey);
      this.signature.arm(this.armedKey);
    }
    const src = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'livelyrics-tap');
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      this.ring?.push(e.data);
      this.lastSampleAt = performance.now();
      this.rhythm?.push(e.data, this.lastSampleAt);
      this.signature?.push(e.data, this.lastSampleAt);
      if (this.gap.push(e.data, this.lastSampleAt)) this.onGapEnd?.();
    };
    src.connect(this.node);
    // Keep the graph pulling without making sound.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(ctx.destination);
  }

  /** Learn the beat grid of this song and watch for a change. Same key again is a no-op unless a change already fired. */
  armRhythm(key: string): void {
    this.armedKey = key;
    this.rhythm?.change.arm(key);
    this.signature?.arm(key);
  }

  disarmRhythm(): void {
    this.armedKey = null;
    this.rhythm?.change.disarm();
    this.signature?.disarm();
  }

  signatureSnapshot(): SignatureSnapshot | null {
    return this.signature ? this.signature.snapshot : null;
  }

  /** Beat readout for the visuals, or null when the mic is off. */
  beatFrame(nowMs: number): BeatFrame | null {
    return this.rhythm ? this.rhythm.frame(nowMs) : null;
  }

  rhythmSnapshot(): ChangeSnapshot | null {
    return this.rhythm ? this.rhythm.change.snapshot : null;
  }

  /** Seconds of audio currently buffered. */
  bufferedSeconds(): number {
    if (!this.ctx || !this.ring) return 0;
    return this.ring.length / this.ctx.sampleRate;
  }

  /**
   * Export the most recent `seconds` of audio, or null if less than that is
   * buffered yet. Only the last `seconds` are sent, so a shorter clip really is
   * a shorter upload.
   */
  getClip(seconds = 8): MicClip | null {
    if (!this.ctx || !this.ring || this.bufferedSeconds() < seconds) return null;
    const raw = this.ring.snapshotLast(Math.round(seconds * this.ctx.sampleRate));
    const pcm = downsample(raw, this.ctx.sampleRate, this.targetSampleRate);
    const rate = Math.min(this.targetSampleRate, this.ctx.sampleRate);
    return {
      blob: new Blob([encodeWav(pcm, rate)], { type: 'audio/wav' }),
      mime: 'audio/wav',
      durationMs: (raw.length / this.ctx.sampleRate) * 1000,
      capturedAtMs: this.lastSampleAt,
    };
  }

  async stop(): Promise<void> {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.ring = null;
    this.rhythm = null;
    this.signature = null;
    this.armedKey = null;
  }
}
