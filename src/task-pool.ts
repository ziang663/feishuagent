export class TaskPool {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxPending: number,
  ) {}

  submit<T>(task: () => Promise<T>): Promise<T> | null {
    if (this.active + this.queue.length >= this.concurrency + this.maxPending) return null;
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active += 1;
        void task()
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.queue.shift()?.();
          });
      };
      if (this.active < this.concurrency) start();
      else this.queue.push(start);
    });
  }

  snapshot(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }
}
