import { Job } from '../../../lib/framework/Job.ts';

export default class ControlJob extends Job {
  static metaUrl = import.meta.url;

  async run(payload: any, { signal }: any) {
    if (payload.type === 'throw') {
      throw new RangeError('job failed', { cause: new Error('root cause') });
    }
    if (payload.type === 'throw-value') throw 'plain failure';
    if (payload.type === 'throw-circular-cause') {
      const error = new Error('circular failure');
      error.cause = error;
      throw error;
    }
    if (payload.type === 'uncloneable') return () => {};
    if (payload.type === 'crash') process.exit(17);
    if (payload.type === 'hang') await new Promise<any>(() => {});
    if (payload.type === 'wait') {
      await new Promise<any>((resolve: any) => {
        const timer = setTimeout(resolve, payload.ms);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      return { aborted: signal.aborted, value: payload.value };
    }
    return payload;
  }
}
