import assert from 'node:assert/strict';
import test from 'node:test';

import { modules } from './catalog.js';
import { applyMutant, score, selectChangedModules } from './harness.js';

test('mutation catalog has unique reproducible targets', async () => {
  const ids = new Set();
  for (const module of modules) {
    const source = await import('node:fs/promises').then(({ readFile }) =>
      readFile(module.source, 'utf8'),
    );
    for (const mutant of module.mutants) {
      assert.equal(ids.has(`${module.id}/${mutant.id}`), false);
      ids.add(`${module.id}/${mutant.id}`);
      const applied = applyMutant(source, mutant);
      assert.notEqual(applied.source, source);
      assert.ok(applied.line > 0);
    }
  }
});

test('mutation score and changed-module mapping are deterministic', () => {
  assert.equal(
    score([
      { status: 'killed' },
      { status: 'timeout' },
      { status: 'survived' },
      { status: 'no-coverage' },
    ]),
    50,
  );
  assert.deepEqual(
    selectChangedModules(modules, ['test/unit/http-router.test.js']).map(({ id }) => id),
    ['http-routing'],
  );
  assert.deepEqual(selectChangedModules(modules, ['README.md']), []);
});
