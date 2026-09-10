import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ArchiveDatabase } from './src/index.ts';

export function pushTestDatabase(url: string) {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./bin.cjs', import.meta.resolve('drizzle-kit'))),
      'push',
      '--config',
      fileURLToPath(new URL('./drizzle.config.ts', import.meta.url)),
    ],
    { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 30000 },
  );
  if (result.error || result.status !== 0)
    throw new Error(result.stderr || result.stdout, { cause: result.error });
}

export function testDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'daevox-drizzle-'));
  const url = pathToFileURL(join(directory, 'archive.sqlite')).href;
  pushTestDatabase(url);
  return {
    url,
    open: () => new ArchiveDatabase(url),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
