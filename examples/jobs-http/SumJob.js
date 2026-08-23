import { Job } from '../../lib/framework/Job.js';

export default class SumJob extends Job {
  static metaUrl = import.meta.url;

  run({ values }) {
    return { sum: values.reduce((sum, value) => sum + value, 0) };
  }
}
