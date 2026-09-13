import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'daevox-core-browser-'));
await mkdir(join(root, 'vendor'));
await symlink(resolve('../core/vendor/llama.cpp'), join(root, 'vendor/llama.cpp'));
await mkdir(join(root, 'tools'));
await writeFile(
  join(root, 'tools/cmake'),
  `#!/usr/bin/python3
import os,pathlib,shutil,sys,time
print('fixture-compiler-started',flush=True)
time.sleep(0.8)
if '-B' in sys.argv:
    target=pathlib.Path(sys.argv[sys.argv.index('-B')+1]);target.mkdir(parents=True,exist_ok=True)
    (target/'CMakeCache.txt').write_text('external browser compiler fixture')
elif '--build' in sys.argv:
    target=pathlib.Path(sys.argv[sys.argv.index('--build')+1]);(target/'bin').mkdir(exist_ok=True)
    shutil.copyfile(os.environ['FIXTURE_ROUTER'],target/'bin/llama-server');(target/'bin/llama-server').chmod(0o755)
`,
  { mode: 0o755 },
);
const commit = '0123456789012345678901234567890123456789';
const hub = createServer((request, response) => {
  const path = new URL(request.url!, 'http://fixture').pathname;
  const json = (body: unknown) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body));
  };
  if (path.startsWith('/api/models/fixture/large/revision/'))
    return json({ id: 'fixture/large', sha: commit, private: false, gated: false });
  if (path === `/api/models/fixture/large/tree/${commit}`)
    return json([{ type: 'file', path: 'model.gguf', size: 4194304, oid: 'large' }]);
  if (path === `/fixture/large/resolve/${commit}/model.gguf`) {
    const offset = Number(request.headers.range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
    response.setHeader('ETag', '"large-v1"');
    response.setHeader('Content-Length', 4194304 - offset);
    if (offset) {
      response.statusCode = 206;
      response.setHeader('Content-Range', `bytes ${offset}-4194303/4194304`);
    }
    if (request.method === 'HEAD') return response.end();
    let sent = offset;
    const timer = setInterval(() => {
      const size = Math.min(65536, 4194304 - sent);
      response.write(Buffer.alloc(size, 'x'));
      sent += size;
      if (sent === 4194304) {
        clearInterval(timer);
        response.end();
      }
    }, 50);
    response.on('close', () => clearInterval(timer));
    return;
  }
  if (path === '/api/models') return json([{ id: 'fixture/small', private: false, gated: false }]);
  if (path.startsWith('/api/models/fixture/small/revision/'))
    return json({ id: 'fixture/small', sha: commit, private: false, gated: false });
  if (path === `/api/models/fixture/small/tree/${commit}`)
    return json([{ type: 'file', path: 'model.gguf', size: 16, oid: 'a' }]);
  if (path === `/fixture/small/resolve/${commit}/model.gguf`) {
    response.setHeader('ETag', '"fixture"');
    response.setHeader('Content-Length', '16');
    return response.end('fixture GGUF!!!!');
  }
  response.statusCode = 404;
  response.end();
});
await new Promise<void>((ready) => hub.listen(3199, '127.0.0.1', ready));
const builder = spawn(
  'cargo',
  ['build', '--offline', '--manifest-path', resolve('../core/Cargo.toml'), '--bin', 'core'],
  { stdio: 'inherit' },
);
const [buildCode] = await once(builder, 'exit');
if (buildCode !== 0) throw new Error(`Core build failed: ${buildCode}`);
const child = spawn(resolve('../core/target/debug/core'), [], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CORE_APP_DIR: root,
    CORE_HUB_ENDPOINT: 'http://127.0.0.1:3199',
    PATH: join(root, 'tools') + ':' + process.env.PATH,
    FIXTURE_ROUTER: resolve('../core/tests/fixtures/router.py'),
    CORE_PORT: '3188',
    CORE_ROUTER_PORT: process.env.CORE_ROUTER_PORT ?? '3190',
    CORE_AUTO_BUILD: '0',
    CORE_WEB_ORIGIN: 'http://127.0.0.1:5188',
  },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill('SIGINT'));
child.on('exit', async (code, signal) => {
  hub.close();
  if (code !== 0 || signal) {
    console.error(`Core did not exit cleanly; ownership records preserved in ${root}`);
    process.exit(code ?? 1);
  }
  await rm(root, { recursive: true, force: true });
  process.exit(code ?? 0);
});
