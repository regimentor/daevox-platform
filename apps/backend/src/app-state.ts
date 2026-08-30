import { DbClient } from '@daevox/db';

export class AppState {
  static instance: AppState;

  #db: DbClient;

  #config = {
    DB_URL: process.env.DB_FILE_NAME ?? '',
  };

  constructor() {
    this.#db = new DbClient(this.#config.DB_URL);

    AppState.instance = this;
  }

  getDb() {
    return this.#db.getDb();
  }

  getConfig() {
    return this.#config;
  }
}
