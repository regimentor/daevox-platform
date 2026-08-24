import { Job } from '../../../lib/framework/Job.js';

async function waitFor(view, index) {
  while (Atomics.load(view, index) === 0) {
    const waiting = Atomics.waitAsync(view, index, 0).value;
    await waiting;
  }
}

export default class RaceJob extends Job {
  static metaUrl = import.meta.url;

  async run({ outcome = 'result', state, value }) {
    const view = new Int32Array(state);
    Atomics.store(view, 0, 1);
    Atomics.notify(view, 0);

    await waitFor(view, 1);
    Atomics.store(view, 2, 1);
    Atomics.notify(view, 2);

    await waitFor(view, 3);
    if (outcome === 'crash') process.exit(17);
    return { value };
  }
}
