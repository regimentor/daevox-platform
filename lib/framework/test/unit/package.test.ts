import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function json(url: URL) {
  return JSON.parse(await readFile(url, 'utf8'));
}

test('framework принадлежит npm workspace и не имеет runtime-зависимостей', async () => {
  const [repositoryPackage, frameworkPackage] = await Promise.all([
    json(new URL('../../../../package.json', import.meta.url)),
    json(new URL('../../package.json', import.meta.url)),
  ]);

  assert.deepEqual(repositoryPackage.workspaces, ['lib/*']);
  assert.equal(frameworkPackage.name, '@daevox/framework');
  assert.equal(Object.hasOwn(frameworkPackage, 'dependencies'), false);
  assert.equal(Object.hasOwn(frameworkPackage, 'optionalDependencies'), false);
  assert.equal(Object.hasOwn(frameworkPackage, 'peerDependencies'), false);
});
