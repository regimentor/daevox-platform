import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';
import { databaseUrl } from './src/config.ts';

const url = databaseUrl();
mkdirSync(dirname(fileURLToPath(url)), { recursive: true });
export default defineConfig({
  dialect: 'sqlite',
  schema: fileURLToPath(new URL('./src/schema.ts', import.meta.url)),
  // node:sqlite expects a filesystem path; DATABASE_URL remains a file:// URL.
  dbCredentials: { url: fileURLToPath(url) },
});
