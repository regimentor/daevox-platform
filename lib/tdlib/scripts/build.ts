import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = join(packageDirectory, 'vendor', 'td');
const schemaPath = join(repositoryDirectory, 'td', 'generate', 'scheme', 'td_api.tl');
const buildDirectory = join(packageDirectory, 'build', 'native');
const metadataPath = join(packageDirectory, 'build', 'tdlib-artifact.json');
const generatedPath = join(packageDirectory, 'src', 'generated', 'td-api.ts');
const configuredJobs = Number.parseInt(process.env.DAEVOX_TDLIB_BUILD_JOBS ?? '1', 10);
if (!Number.isInteger(configuredJobs) || configuredJobs < 1)
  throw new RangeError('DAEVOX_TDLIB_BUILD_JOBS must be a positive integer');

const run = async (command: string, args: string[]): Promise<void> => {
  const { execFile } = await import('node:child_process');
  await new Promise<void>((finish, reject) => {
    const child = execFile(command, args, { cwd: packageDirectory }, (error) =>
      error ? reject(error) : finish(),
    );
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  });
};

await run('git', ['--version']);
await run('cmake', ['--version']);
await run('gperf', ['--version']);
await access(schemaPath);
await mkdir(buildDirectory, { recursive: true });
await run('cmake', ['-S', repositoryDirectory, '-B', buildDirectory, '-DCMAKE_BUILD_TYPE=Release']);
await run('cmake', [
  '--build',
  buildDirectory,
  '--target',
  'tdjson',
  '--parallel',
  String(configuredJobs),
]);
await run(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'generate-types.ts')]);
await run('npx', ['oxfmt', generatedPath]);

const gitDirectoryFile = await readFile(join(repositoryDirectory, '.git'), 'utf8');
const gitDirectory = resolve(
  repositoryDirectory,
  gitDirectoryFile.replace(/^gitdir:\s*/, '').trim(),
);
const head = (await readFile(join(gitDirectory, 'HEAD'), 'utf8')).trim();
const commit = head.startsWith('ref: ')
  ? (await readFile(join(gitDirectory, head.slice(5)), 'utf8')).trim()
  : head;
const schema = await readFile(schemaPath);
const binaryPath = join(buildDirectory, 'libtdjson.so');
await access(binaryPath);
const binary = await readFile(binaryPath);
await writeFile(
  metadataPath,
  JSON.stringify(
    {
      tdlibCommit: commit,
      schemaSha256: createHash('sha256').update(schema).digest('hex'),
      binarySha256: createHash('sha256').update(binary).digest('hex'),
      binaryPath: relative(join(packageDirectory, 'build'), binaryPath),
    },
    null,
    2,
  ) + '\n',
);
