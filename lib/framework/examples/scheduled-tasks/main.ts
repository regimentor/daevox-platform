import { Application, ScheduledTaskBase, type ScheduledTaskContext } from '@daevox/framework';
import CountJob from './CountJob.ts';

class AppState {
  values = [2, 3, 5];
  total = 0;
  refreshes = 0;
  async refresh(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.refreshes++;
    console.log(`refresh ${this.refreshes}, total ${this.total}`);
  }
}

class Recount extends ScheduledTaskBase {
  static cron = '*/5 * * * * *';
  async run(state: AppState, { signal }: ScheduledTaskContext): Promise<void> {
    state.total = await this.jobRunner.run(CountJob, { values: state.values }, { signal });
  }
}

class Refresh extends ScheduledTaskBase {
  static cron = '*/2 * * * * *';
  async run(state: AppState, { signal }: ScheduledTaskContext): Promise<void> {
    await state.refresh(signal);
  }
}

const app = new Application({ appState: AppState })
  .registerScheduledTask(Recount)
  .registerScheduledTask(Refresh);
const address = await app.listen({ port: 3000 });
console.log(`Listening on http://${address.address}:${address.port}`);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void app.close();
  });
