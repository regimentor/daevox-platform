/** One local model, reply priority, FIFO within each priority. Running work is never preempted. */
export class ModelScheduler {
  private queue: Array<{ priority: number; run: () => Promise<void> }> = [];
  private running = false;
  private readonly allowSummary: () => boolean;
  constructor(allowSummary: () => boolean = () => true) {
    this.allowSummary = allowSummary;
  }
  resume() {
    void this.drain();
  }
  run<T>(kind: 'reply' | 'summary', signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry = {
        priority: kind === 'reply' ? 0 : 1,
        run: async () => {
          signal.removeEventListener('abort', cancel);
          try {
            signal.throwIfAborted();
            resolve(await action());
          } catch (error) {
            reject(error);
          }
        },
      };
      const cancel = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason);
      };
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', cancel, { once: true });
      this.queue.push(entry);
      this.queue.sort((a, b) => a.priority - b.priority);
      void this.drain();
    });
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        if (this.queue[0].priority === 1 && !this.allowSummary()) return;
        await this.queue.shift()!.run();
      }
    } finally {
      this.running = false;
    }
  }
}
