import { loadEnvFile } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export function databaseUrl() {
  try {
    loadEnvFile(resolve(root, '.env'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return normalizeDatabaseUrl(process.env.DATABASE_URL ?? 'file:./db/daevox.sqlite');
}
export function normalizeDatabaseUrl(value: string): string {
  if (!value.startsWith('file:')) throw new Error('DATABASE_URL must be a local file: URL');
  const url = value.startsWith('file://')
    ? new URL(value)
    : pathToFileURL(resolve(root, value.slice(5)));
  if (url.search || url.hash)
    throw new Error('DATABASE_URL cannot contain query parameters or a fragment');
  fileURLToPath(url); // Reject non-local hosts and invalid file URLs.
  return url.href;
}
