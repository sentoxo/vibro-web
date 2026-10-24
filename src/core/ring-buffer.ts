// Fixed-capacity Float32 ring buffer for live sample windows.
// Sample buffers live outside the reactive layer (plan §6.3): the UI reads
// them at the render rate, never per sample.

export class RingBuffer {
  capacity: number;
  private data: Float32Array;
  private head = 0; // index of the oldest retained sample
  private count = 0;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError("Ring buffer capacity must be >= 1");
    this.capacity = capacity;
    this.data = new Float32Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  get isFull(): boolean {
    return this.count === this.capacity;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  push(value: number): void {
    if (this.count < this.capacity) {
      this.data[(this.head + this.count) % this.capacity] = value;
      this.count += 1;
    } else {
      this.data[this.head] = value;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  pushAll(values: ArrayLike<number>, offset = 0, length = values.length - offset): void {
    for (let i = 0; i < length; i++) this.push(values[offset + i]);
  }

  /** Copy the most recent `n` samples into `out` in chronological order. */
  copyLast(n: number, out: Float32Array | Float64Array): number {
    const count = Math.min(n, this.count, out.length);
    const start = (this.head + this.count - count) % this.capacity;
    for (let i = 0; i < count; i++) out[i] = this.data[(start + i) % this.capacity];
    return count;
  }

  /** Resize while keeping the most recent samples (IMU Hz / zoom change). */
  resize(capacity: number): void {
    const kept = Math.min(capacity, this.count);
    const data = new Float32Array(capacity);
    const start = (this.head + this.count - kept) % this.capacity;
    for (let i = 0; i < kept; i++) data[i] = this.data[(start + i) % this.capacity];
    this.capacity = capacity;
    this.data = data;
    this.head = 0;
    this.count = kept;
  }
}
