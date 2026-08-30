import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './db/schema.ts';

function getDbClient(url: string) {
  console.log('url:', url);
  const client = createClient({ url });
  const db = drizzle({ client });

  return db;
}

class DbClient {
  private db: ReturnType<typeof getDbClient>;

  constructor(url: string) {
    const fileUrl = new URL(`file://${url}`);
    this.db = getDbClient(fileUrl.toString());
  }

  getDb() {
    return this.db;
  }
}

export { schema, DbClient };
