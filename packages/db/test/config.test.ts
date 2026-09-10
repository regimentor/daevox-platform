import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ArchiveDatabase, normalizeDatabaseUrl } from '../src/index.ts';

test('database URLs support absolute file URLs and resolve relative paths from the repository root', () => {
  const expected = new URL('../../../db/daevox.sqlite', import.meta.url).href;
  assert.equal(normalizeDatabaseUrl('file:./db/daevox.sqlite'), expected);
  assert.equal(
    fileURLToPath(normalizeDatabaseUrl('file:///tmp/archive%20test.sqlite')),
    '/tmp/archive test.sqlite',
  );
  assert.throws(() => normalizeDatabaseUrl('https://example.com/archive.sqlite'));
  assert.throws(() => normalizeDatabaseUrl('file://remote/archive.sqlite'));
  assert.throws(() => normalizeDatabaseUrl('file:///tmp/archive.sqlite?mode=ro'));
});

test('opening an uninitialized archive requires push rather than migrating at runtime', () => {
  assert.throws(() => new ArchiveDatabase(':memory:'), /db:push/);
});
