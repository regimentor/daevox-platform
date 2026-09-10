import { Job } from '@daevox/framework';

export default class CountJob extends Job {
  static metaUrl = import.meta.url;
  async run({ values }: { values: number[] }): Promise<number> {
    return values.reduce((sum, value) => sum + value, 0);
  }
}
