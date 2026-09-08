import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = join(packageDirectory, 'vendor', 'td', 'td', 'generate', 'scheme', 'td_api.tl');
const generatedPath = join(packageDirectory, 'src', 'generated', 'td-api.ts');
const source = await readFile(schemaPath, 'utf8');
const generated = await readFile(generatedPath, 'utf8');
const expected = createHash('sha256').update(source).digest('hex');
const actual = /^\/\/ TDLib schema sha256: (\w+)$/m.exec(generated)?.[1];
if (actual !== expected) {
  throw new Error(
    `Generated TDLib types are stale. Run npm run generate -w @daevox/tdlib (expected ${expected}, got ${actual ?? 'missing'})`,
  );
}
