import { Job } from '../../../lib/framework/Job.js';

export default class EchoJob extends Job {
  static metaUrl = import.meta.url;

  async run(payload) {
    return payload;
  }
}
