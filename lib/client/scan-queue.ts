/**
 * Ordered scan queue.
 *
 * - Every scan gets its idempotency key when it enters the queue.
 * - Jobs are processed strictly one at a time, in arrival order.
 * - A retryable failure (network/5xx) keeps the job at the head of the queue and
 *   retries it with the SAME key, so later scans can never overtake it and a
 *   retry can never be counted twice by the server.
 * - The queue never decides acceptance: it only reports the server's answer.
 */
export type ScanJobStatus = "queued" | "sending" | "unconfirmed" | "done";

export interface ScanJob<R> {
  key: string;
  raw: string;
  seq: number;
  status: ScanJobStatus;
  attempts: number;
  result?: R;
  error?: string;
}

export interface ScanQueueOptions<R> {
  process: (job: ScanJob<R>) => Promise<R>;
  isRetryable: (error: unknown) => boolean;
  onChange?: () => void;
  onResult?: (job: ScanJob<R>, result: R) => void;
  onFatal?: (job: ScanJob<R>, error: unknown) => void;
  retryDelayMs?: (attempt: number) => number;
  makeKey?: () => string;
}

const defaultDelay = (attempt: number) => Math.min(10_000, 500 * 2 ** Math.min(attempt - 1, 5));

export class ScanQueue<R> {
  private jobs: ScanJob<R>[] = [];
  private seq = 0;
  private running = false;
  private paused = false;
  private disposed = false;
  private idleWaiters: (() => void)[] = [];
  private wake: (() => void) | null = null;

  constructor(private readonly opts: ScanQueueOptions<R>) {}

  enqueue(raw: string): ScanJob<R> {
    const job: ScanJob<R> = {
      key: (this.opts.makeKey ?? (() => crypto.randomUUID()))(),
      raw,
      seq: ++this.seq,
      status: "queued",
      attempts: 0,
    };
    this.jobs.push(job);
    this.notify();
    void this.pump();
    return job;
  }

  /** Pending (not yet answered) jobs, oldest first. */
  get pending(): readonly ScanJob<R>[] {
    return this.jobs.map((j) => ({ ...j }));
  }

  get size(): number {
    return this.jobs.length;
  }

  get hasUnconfirmed(): boolean {
    return this.jobs.some((j) => j.status === "unconfirmed");
  }

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    this.paused = true;
    this.notify();
  }

  resume(): void {
    if (this.disposed) return;
    this.paused = false;
    this.notify();
    this.wake?.();
    void this.pump();
  }

  /** Resolves once every queued scan has an answer. */
  idle(): Promise<void> {
    if (this.jobs.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Retry the head job now instead of waiting for the backoff. */
  retryNow(): void {
    this.wake?.();
  }

  dispose(): void {
    this.disposed = true;
    this.paused = true;
    this.wake?.();
  }

  private notify() {
    this.opts.onChange?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
    });
  }

  private async pump(): Promise<void> {
    if (this.running || this.paused || this.disposed) return;
    this.running = true;
    try {
      while (!this.paused && !this.disposed && this.jobs.length > 0) {
        const job = this.jobs[0];
        job.status = "sending";
        job.attempts += 1;
        this.notify();
        try {
          const result = await this.opts.process(job);
          job.result = result;
          job.status = "done";
          this.jobs.shift();
          this.notify();
          this.opts.onResult?.(job, result);
        } catch (error) {
          if (this.opts.isRetryable(error)) {
            job.status = "unconfirmed";
            job.error = error instanceof Error ? error.message : String(error);
            this.notify();
            await this.sleep((this.opts.retryDelayMs ?? defaultDelay)(job.attempts));
            continue;
          }
          job.status = "done";
          this.jobs.shift();
          this.notify();
          this.opts.onFatal?.(job, error);
        }
      }
    } finally {
      this.running = false;
      if (this.jobs.length === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        waiters.forEach((w) => w());
      }
    }
  }
}
