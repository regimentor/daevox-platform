import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const documentationCli = path.join(
  root,
  'node_modules',
  'documentation',
  'bin',
  'documentation.js',
);
const formatterCli = path.join(root, 'node_modules', '.bin', 'oxfmt');
const accessArguments = [
  '--access',
  'public',
  '--access',
  'private',
  '--access',
  'protected',
  '--access',
  'undefined',
];

async function sourceFiles() {
  return (await readdir(path.join(root, 'lib', 'framework')))
    .filter((file) => file.endsWith('.js'))
    .toSorted()
    .map((file) => path.join(root, 'lib', 'framework', file));
}

function documentation(args) {
  const result = spawnSync(process.execPath, [documentationCli, ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function formatMarkdown(file) {
  const result = spawnSync(formatterCli, [file], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function generate(outputRoot) {
  const inputs = await sourceFiles();
  await mkdir(outputRoot, { recursive: true });
  documentation([
    'build',
    ...inputs,
    '--shallow',
    ...accessArguments,
    '--format',
    'md',
    '--output',
    path.join(outputRoot, 'API.md'),
  ]);
  formatMarkdown(path.join(outputRoot, 'API.md'));
  documentation([
    'build',
    ...inputs,
    '--shallow',
    ...accessArguments,
    '--format',
    'html',
    '--output',
    path.join(outputRoot, 'api'),
  ]);
}

async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory())
      files.push(...(await listFiles(path.join(directory, entry.name), relative)));
    else files.push(relative);
  }
  return files;
}

async function generatedFiles(directory) {
  return ['API.md', ...(await listFiles(path.join(directory, 'api'), 'api'))];
}

async function checkGenerated(expectedRoot, actualRoot) {
  const expectedFiles = await generatedFiles(expectedRoot);
  const actualFiles = await generatedFiles(actualRoot);
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);
  const missing = actualFiles.filter((file) => !expectedSet.has(file));
  const extra = expectedFiles.filter((file) => !actualSet.has(file));
  const changed = [];

  for (const file of actualFiles.filter((candidate) => expectedSet.has(candidate))) {
    const [expected, actual] = await Promise.all([
      readFile(path.join(expectedRoot, file)),
      readFile(path.join(actualRoot, file)),
    ]);
    if (!expected.equals(actual)) changed.push(file);
  }

  if (missing.length === 0 && extra.length === 0 && changed.length === 0) return;
  if (missing.length > 0) console.error(`Missing generated files: ${missing.join(', ')}`);
  if (extra.length > 0) console.error(`Extra generated files: ${extra.join(', ')}`);
  if (changed.length > 0) console.error(`Outdated generated files: ${changed.join(', ')}`);
  console.error('Run npm run docs:build and commit the generated documentation.');
  process.exitCode = 1;
}

const command = process.argv[2];
const docsRoot = path.join(root, 'docs');

if (command === 'build') {
  await rm(path.join(docsRoot, 'API.md'), { force: true });
  await rm(path.join(docsRoot, 'api'), { force: true, recursive: true });
  await generate(docsRoot);
} else if (command === 'check') {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'daevox-docs-'));
  try {
    await generate(temporaryRoot);
    await checkGenerated(docsRoot, temporaryRoot);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
} else {
  console.error('Usage: node scripts/docs.js <build|check>');
  process.exitCode = 2;
}
