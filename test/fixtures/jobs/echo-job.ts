import { Job } from '../../../lib/framework/Job.ts';

export default class EchoJob extends Job {
  static metaUrl = import.meta.url;

  async run(payload: any) {
    return payload;
  }
}
