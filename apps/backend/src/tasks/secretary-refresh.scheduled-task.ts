import { ScheduledTaskBase, type ScheduledTaskContext } from '@daevox/framework';
import type { AppState } from '../app-state.ts';

export class SecretaryRefreshTask extends ScheduledTaskBase {
  static cron = '0 * * * * *';

  async run(state: AppState, { signal }: ScheduledTaskContext): Promise<void> {
    await state.secretary.refresh(signal);
  }
}
