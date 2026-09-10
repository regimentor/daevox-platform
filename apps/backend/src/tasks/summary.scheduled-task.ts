import { JobAbortedError, ScheduledTaskBase, type ScheduledTaskContext } from '@daevox/framework';
import type { AppState } from '../app-state.ts';
import SummaryJob from '../jobs/summary.job.ts';

export class SummaryScheduledTask extends ScheduledTaskBase {
  static cron = '* * * * * *';

  async run(state: AppState, { signal }: ScheduledTaskContext): Promise<void> {
    const url = state.secretary.summaryDatabaseUrl;
    if (!url || signal.aborted) return;
    try {
      await state.secretary.modelScheduler.run('summary', signal, () =>
        this.jobRunner.run(SummaryJob, { url, limit: 1 }, { signal }),
      );
    } catch (error) {
      if (!signal.aborted || !(error instanceof JobAbortedError)) throw error;
    }
  }
}
