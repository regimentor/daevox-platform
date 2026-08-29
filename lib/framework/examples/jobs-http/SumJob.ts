import { Job } from '@daevox/framework';

export default class SumJob extends Job {
  static metaUrl = import.meta.url;

  run({ values }: any) {
    return { sum: values.reduce((sum: any, value: any) => sum + value, 0) };
  }
}
