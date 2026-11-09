/** Fixed-capacity ring buffer of mono float samples. Keeps the most recent N. */
export class FloatRingBuffer {
  private readonly data: Float32Array;
  private writeIndex = 0;
  private filled = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('capacity must be a positive integer');
    this.data = new Float32Array(capacity);
  }

  push(samples: Float32Array): void {
    let src = samples;
    if (src.length >= this.capacity) src = src.subarray(src.length - this.capacity);
    const first = Math.min(src.length, this.capacity - this.writeIndex);
    this.data.set(src.subarray(0, first), this.writeIndex);
    if (first < src.length) this.data.set(src.subarray(first), 0);
    this.writeIndex = (this.writeIndex + src.length) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + src.length);
  }

  get length(): number {
    return this.filled;
  }

  get isFull(): boolean {
    return this.filled === this.capacity;
  }

  /** Samples in chronological order (oldest first). */
  snapshot(): Float32Array {
    const out = new Float32Array(this.filled);
    const start = (this.writeIndex - this.filled + this.capacity) % this.capacity;
    const first = Math.min(this.filled, this.capacity - start);
    out.set(this.data.subarray(start, start + first), 0);
    if (first < this.filled) out.set(this.data.subarray(0, this.filled - first), first);
    return out;
  }

  /** The most recent n samples in chronological order (fewer if less is buffered). */
  snapshotLast(n: number): Float32Array {
    const all = this.snapshot();
    const count = Math.max(0, Math.min(Math.floor(n), all.length));
    return all.subarray(all.length - count);
  }

  clear(): void {
    this.writeIndex = 0;
    this.filled = 0;
  }
}
