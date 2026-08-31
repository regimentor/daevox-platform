import { Job, type JobContext } from '@daevox/framework';

export interface SumJobPayload {
  values: number[];
}

export interface SumJobResult {
  sum: number;
}

export default class SumJob extends Job {
  static metaUrl = import.meta.url;

  run({ values }: SumJobPayload, _context: JobContext): SumJobResult {
    return { sum: values.reduce((sum, value) => sum + value, 0) };
  }
}
