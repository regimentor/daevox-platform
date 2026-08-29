import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { modules } from './catalog.ts';
import { isMain, runModule, score, selectChangedModules, writeReports } from './harness.ts';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function changedPaths() {
  const paths = new Set();
  const base = process.env.MUTATION_BASE;
  if (base) {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: root,
    });
    for (const path of stdout.trim().split('\n')) if (path) paths.add(path);
  }
  const { stdout } = await execFileAsync('git', ['diff', '--name-only', 'HEAD', '--'], {
    cwd: root,
  });
  for (const path of stdout.trim().split('\n')) if (path) paths.add(path);
  const { stdout: untracked } = await execFileAsync(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    { cwd: root },
  );
  for (const path of untracked.trim().split('\n')) if (path) paths.add(path);
  return [...paths];
}

async function main() {
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex === -1 ? 'changed' : process.argv[modeIndex + 1];
  if (!['changed', 'full'].includes(mode)) throw new Error(`Unknown mutation mode: ${mode}`);
  const baseline = JSON.parse(await readFile(resolve(root, 'test/mutation/baseline.json'), 'utf8'));
  const selected = mode === 'full' ? modules : selectChangedModules(modules, await changedPaths());
  const moduleReports: any[] = [];
  for (const module of selected) {
    process.stdout.write(`Mutating ${module.label} (${module.mutants.length} mutants)\n`);
    const report = await runModule(root, module, baseline.timeoutMs);
    moduleReports.push(report);
    process.stdout.write(`  score ${report.score}%\n`);
  }
  const results = moduleReports.flatMap((module: any) => module.results);
  const report = {
    schemaVersion: 1,
    mode,
    generatedAt: new Date().toISOString(),
    node: process.version,
    gate: baseline.gate,
    score: score(results),
    modules: moduleReports,
  };
  await writeReports(root, mode, report);
  if (selected.length === 0) process.stdout.write('No changed mutation target modules.\n');
  process.stdout.write(`Mutation score ${report.score}% (gate ${report.gate}%)\n`);
  const unresolved = results.filter((result: any) => result.status === 'survived');
  if (unresolved.length)
    process.stderr.write(
      `${unresolved.length} survived mutant(s) require tests or a documented equivalence.\n`,
    );
  if (report.score < report.gate || unresolved.length) process.exitCode = 1;
}

if (isMain(import.meta.url))
  main().catch((error: any) => {
    console.error(error);
    process.exitCode = 1;
  });
