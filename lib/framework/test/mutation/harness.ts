import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function applyMutant(source: any, mutant: any) {
  const first = source.indexOf(mutant.find);
  if (first === -1) throw new Error(`${mutant.id}: mutation target was not found`);
  if (source.indexOf(mutant.find, first + mutant.find.length) !== -1) {
    throw new Error(`${mutant.id}: mutation target is ambiguous`);
  }
  return {
    source: `${source.slice(0, first)}${mutant.replace}${source.slice(first + mutant.find.length)}`,
    offset: first,
    line: source.slice(0, first).split('\n').length,
  };
}

export function score(results: any) {
  if (results.length === 0) return 100;
  const detected = results.filter((result: any) =>
    ['killed', 'timeout'].includes(result.status),
  ).length;
  return Number(((detected / results.length) * 100).toFixed(2));
}

export function selectChangedModules(modules: any, changedPaths: any) {
  const changed = new Set(changedPaths);
  return modules.filter(
    (module: any) =>
      changed.has(module.source) || module.related.some((path: any) => changed.has(path)),
  );
}

function runProcess(cwd: any, args: any, { coverageDirectory, timeoutMs }: any) {
  return new Promise<any>((resolveProcess: any) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: coverageDirectory
        ? { ...process.env, NODE_V8_COVERAGE: coverageDirectory }
        : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: any[] = [];
    const stderr: any[] = [];
    child.stdout.on('data', (chunk: any) => stdout.push(chunk));
    child.stderr.on('data', (chunk: any) => stderr.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error: any) => {
      clearTimeout(timer);
      resolveProcess({
        code: null,
        error,
        stderr: Buffer.concat(stderr).toString(),
        stdout: Buffer.concat(stdout).toString(),
        timedOut,
      });
    });
    child.once('close', (code: any) => {
      clearTimeout(timer);
      resolveProcess({
        code,
        stderr: Buffer.concat(stderr).toString(),
        stdout: Buffer.concat(stdout).toString(),
        timedOut,
      });
    });
  });
}

async function copyProject(root: any, destination: any) {
  for (const path of ['examples', 'src', 'test', 'package.json']) {
    await cp(join(root, path), join(destination, path), { recursive: true });
  }
}

async function coveredOffsets(coverageDirectory: any, sourcePath: any) {
  const files = await readdir(coverageDirectory);
  const sourceSuffix = sourcePath.split('/').join(sep);
  const ranges: any[] = [];
  for (const file of files) {
    const coverage = JSON.parse(await readFile(join(coverageDirectory, file), 'utf8'));
    for (const script of coverage.result) {
      if (!script.url.endsWith(sourceSuffix)) continue;
      for (const functionCoverage of script.functions) ranges.push(...functionCoverage.ranges);
    }
  }
  return (offset: any) => {
    const containing = ranges
      .filter((range: any) => range.startOffset <= offset && offset < range.endOffset)
      .toSorted(
        (left: any, right: any) =>
          left.endOffset - left.startOffset - (right.endOffset - right.startOffset),
      );
    return containing.length > 0 && containing[0].count > 0;
  };
}

function diagnostic(result: any) {
  return `${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-12).join('\n');
}

export async function runModule(root: any, module: any, timeoutMs: any) {
  const workspace = await mkdtemp(join(tmpdir(), 'daevox-mutation-'));
  try {
    await copyProject(root, workspace);
    const coverageDirectory = join(workspace, '.coverage');
    await mkdir(coverageDirectory);
    const baseline = await runProcess(workspace, ['--test', ...module.tests], {
      coverageDirectory,
      timeoutMs,
    });
    if (baseline.code !== 0 || baseline.timedOut) {
      throw new Error(`Baseline tests failed for ${module.id}\n${diagnostic(baseline)}`);
    }

    const sourcePath = join(workspace, module.source);
    const original = await readFile(sourcePath, 'utf8');
    const isCovered = await coveredOffsets(coverageDirectory, module.source);
    const results: any[] = [];
    for (const mutant of module.mutants) {
      const applied = applyMutant(original, mutant);
      const base = {
        id: mutant.id,
        description: mutant.description,
        line: applied.line,
        source: module.source,
      };
      if (!isCovered(applied.offset)) {
        results.push({ ...base, status: 'no-coverage' });
        continue;
      }
      await writeFile(sourcePath, applied.source);
      const run = await runProcess(workspace, ['--test', ...module.tests], { timeoutMs });
      await writeFile(sourcePath, original);
      if (run.timedOut) results.push({ ...base, status: 'timeout', diagnostic: diagnostic(run) });
      else if (run.code === 0) results.push({ ...base, status: 'survived' });
      else results.push({ ...base, status: 'killed', diagnostic: diagnostic(run) });
    }
    return { id: module.id, label: module.label, results, score: score(results) };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function writeReports(root: any, mode: any, report: any) {
  const resultsDirectory = join(root, 'test/mutation/results');
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(join(resultsDirectory, `${mode}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    `# Mutation report: ${mode}`,
    '',
    `Score: ${report.score}% (gate: ${report.gate}%)`,
    '',
  ];
  for (const module of report.modules) {
    lines.push(`## ${module.label}`, '', `Score: ${module.score}%`, '');
    for (const status of ['killed', 'survived', 'timeout', 'no-coverage']) {
      const results = module.results.filter((result: any) => result.status === status);
      lines.push(`### ${status} (${results.length})`, '');
      for (const result of results) {
        lines.push(
          `- [${result.source}:${result.line}](${relative(resultsDirectory, resolve(root, result.source))}#L${result.line}) — ${result.id}: ${result.description}`,
        );
      }
      if (results.length === 0) lines.push('- None');
      lines.push('');
    }
  }
  await writeFile(join(resultsDirectory, `${mode}.md`), `${lines.join('\n')}\n`);
}

export function isMain(metaUrl: any) {
  return process.argv[1] !== undefined && metaUrl === pathToFileURL(resolve(process.argv[1])).href;
}
