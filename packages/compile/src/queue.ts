/** A FIFO semaphore: at most `limit` holders; waiters give up after `waitMs`. */
export class Semaphore {
  private active = 0;
  private maxSeen = 0;
  private readonly waiters: Array<{ grant: () => void; timer: NodeJS.Timeout }> = [];

  constructor(
    private readonly limit: number,
    private readonly waitMs: number
  ) {}

  /** Resolves true once a slot is held, false if the wait timed out. */
  acquire(): Promise<boolean> {
    if (this.active < this.limit) {
      this.take();
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const entry = {
        grant: () => {
          clearTimeout(entry.timer);
          this.take();
          resolve(true);
        },
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(entry);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(false);
        }, this.waitMs),
      };
      this.waiters.push(entry);
    });
  }

  release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next.grant();
  }

  stats(): { active: number; queued: number; maxActive: number } {
    return { active: this.active, queued: this.waiters.length, maxActive: this.maxSeen };
  }

  private take(): void {
    this.active++;
    this.maxSeen = Math.max(this.maxSeen, this.active);
  }
}
