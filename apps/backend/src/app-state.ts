import { DbClient } from '@daevox/db';
import type { AppStateInstance } from '@daevox/framework';

export class AppState implements AppStateInstance {
  #db?: DbClient;

  #config = {
    DB_URL: process.env.DB_FILE_NAME ?? '',
    JWT_SECRET: process.env.JWT_SECRET ?? '',
  };

  async beforeAppStart() {
    this.#db = new DbClient(this.#config.DB_URL);
  }

  getDb() {
    if (!this.#db) {
      throw new Error('DbClient not initialized');
    }
    return this.#db.getDb();
  }

  getConfig() {
    return this.#config;
  }
}
