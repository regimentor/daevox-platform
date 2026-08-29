import { Job } from '../../../src/Job.ts';

export default class ShutdownJob extends Job {
  static metaUrl = import.meta.url;

  async run({ mode, state }: any) {
    const view = new Int32Array(state);
    Atomics.store(view, 0, 1);
    Atomics.notify(view, 0);

    if (mode === 'complete') return { completed: true };
    await new Promise<any>(() => {});
  }
}
