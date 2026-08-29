import http from 'node:http';
import type { AddressInfo } from 'node:net';
import process from 'node:process';

const framework = process.argv[2];
const port = Number(process.argv[3] ?? 0);
const body = { ok: true, value: 'benchmark' };

function listeningPort(server: { address(): string | AddressInfo | null }) {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  return address.port;
}

function nodeServer() {
  return http.createServer(async (request: any, response: any) => {
    if (request.method !== 'POST' || request.url !== '/benchmark') {
      response.writeHead(404).end();
      return;
    }
    for await (const chunk of request) void chunk;
    const payload = JSON.stringify(body);
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    response.end(payload);
  });
}

async function createServer() {
  if (framework === 'daevox') {
    const { Application } = await import('../../lib/framework/Application.ts');
    const { HttpControllerBase } = await import('../../lib/framework/HttpControllerBase.ts');
    class BenchmarkController extends HttpControllerBase {
      static prefix = '/benchmark';
      static routes = [{ method: 'POST', path: '/', handler: 'run' }];
      run() {
        return { status: 200, body };
      }
    }
    const application = new Application({ http: { bodyLimit: 1024 } });
    application.registerHttpController(BenchmarkController);
    const address = await application.listen({ port, host: '127.0.0.1' });
    return { port: address.port, close: () => application.close() };
  }
  if (framework === 'node')
    return new Promise<any>((resolve: any) => {
      const server = nodeServer();
      server.listen(port, '127.0.0.1', () =>
        resolve({ port: listeningPort(server), close: () => server.close() }),
      );
    });
  if (framework === 'express') {
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.post('/benchmark', (_request: any, response: any) => response.json(body));
    return new Promise<any>((resolve: any) => {
      const server = app.listen(port, '127.0.0.1', () =>
        resolve({ port: listeningPort(server), close: () => server.close() }),
      );
    });
  }
  if (framework === 'fastify') {
    const fastify = (await import('fastify')).default();
    fastify.post('/benchmark', async () => body);
    await fastify.listen({ port, host: '127.0.0.1' });
    return { port: listeningPort(fastify.server), close: () => fastify.close() };
  }
  if (framework === 'koa') {
    const Koa = (await import('koa')).default;
    const app = new Koa();
    app.use(async (ctx: any) => {
      if (ctx.method !== 'POST' || ctx.path !== '/benchmark') {
        ctx.status = 404;
        return;
      }
      for await (const chunk of ctx.req) void chunk;
      ctx.type = 'application/json';
      ctx.body = body;
    });
    return new Promise<any>((resolve: any) => {
      const server = app.listen(port, '127.0.0.1', () =>
        resolve({ port: listeningPort(server), close: () => server.close() }),
      );
    });
  }
  if (framework === 'hono') {
    const { serve } = await import('@hono/node-server');
    const { Hono } = await import('hono');
    const app = new Hono();
    app.post('/benchmark', (context: any) => context.json(body));
    const server = await new Promise<any>((resolve: any) => {
      const created = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info: any) =>
        resolve({ server: created, port: info.port }),
      );
    });
    return { port: server.port, close: () => server.server.close() };
  }
  if (framework === 'nestjs') {
    await import('reflect-metadata');
    const { Controller, HttpCode, Module, Post } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    class BenchmarkController {
      run() {
        return body;
      }
    }
    Post('/benchmark')(
      BenchmarkController.prototype,
      'run',
      Object.getOwnPropertyDescriptor(BenchmarkController.prototype, 'run')!,
    );
    HttpCode(200)(
      BenchmarkController.prototype,
      'run',
      Object.getOwnPropertyDescriptor(BenchmarkController.prototype, 'run')!,
    );
    Controller()(BenchmarkController);
    class BenchmarkModule {
      benchmark = true;
    }
    Module({ controllers: [BenchmarkController] })(BenchmarkModule);
    const application = await NestFactory.create(BenchmarkModule, { logger: false });
    await application.listen(port, '127.0.0.1');
    return { port: application.getHttpServer().address().port, close: () => application.close() };
  }
  throw new Error(`Unknown framework: ${framework}`);
}

const running = await createServer();
process.stdout.write(`${JSON.stringify({ port: running.port })}\n`);
process.on('SIGTERM', async () => {
  await running.close();
  process.exit(0);
});
