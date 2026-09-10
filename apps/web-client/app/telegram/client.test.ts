import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '@daevox/telegram-contract';
import { TelegramApi, type TelegramView } from './client';

const initial: Snapshot = {
  instanceId: 'test',
  controlVersion: 0,
  revision: 0,
  client: 'running',
  connection: 'ready',
  authorization: { kind: 'not_connected' },
  allowedActions: ['connect'],
  operation: null,
  error: null,
};
const response = (state: unknown = initial, status = 200) =>
  new Response(JSON.stringify(state), { status });
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
let client: TelegramApi;
let view: TelegramView;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.useFakeTimers();
  fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  client = new TelegramApi((value) => {
    view = value;
  });
});
afterEach(() => {
  client.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Telegram polling', () => {
  it('reads immediately, waits one second after completion and never overlaps reads', async () => {
    let resolve!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    client.setVisible(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(response());
    await flush();
    expect(view.status).toBe('online');
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(response());
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/telegram/state');
  });
  it('hides stale QR while paused and discards a delayed response when returning', async () => {
    const qr: Snapshot = {
      ...initial,
      authorization: { kind: 'qr', link: 'tg://login?token=dGVzdA' },
      allowedActions: [],
    };
    fetcher.mockResolvedValueOnce(response(qr));
    client.setVisible(true);
    await flush();
    let resolve!: (value: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    client.setVisible(false);
    expect(view.status).toBe('paused');
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.setVisible(true);
    expect(view.status).toBe('loading');
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(
      response({ ...qr, revision: 2, authorization: { kind: 'password' } }),
    );
    resolve(response(qr));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(view.snapshot?.authorization.kind).toBe('password');
  });
  it('retries only GET with 1, 2, 4, 5 second backoff and restores normal cadence', async () => {
    fetcher.mockRejectedValue(new Error('offline'));
    client.setVisible(true);
    await flush();
    expect(view.status).toBe('offline');
    for (const delay of [1000, 2000, 4000, 5000]) {
      const calls = fetcher.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetcher).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher).toHaveBeenCalledTimes(calls + 1);
    }
    fetcher.mockResolvedValue(response());
    await vi.advanceTimersByTimeAsync(5000);
    expect(view.status).toBe('online');
    const calls = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(calls + 1);
  });
  it('does not repeat a POST after losing its response and blocks a double click', async () => {
    fetcher.mockResolvedValueOnce(response());
    client.setVisible(true);
    await flush();
    let reject!: (reason: Error) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((_done, fail) => {
          reject = fail;
        }),
    );
    const pending = client.command('connect');
    void client.command('connect');
    expect(view.sending).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValue(
      response({ ...initial, authorization: { kind: 'requesting_qr' }, allowedActions: [] }),
    );
    reject(new Error('response lost'));
    await pending;
    await flush();
    expect(view.snapshot?.authorization.kind).toBe('requesting_qr');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(view.commandError).toBeNull();
  });
  it('invalidates an in-flight GET before a command and applies only the post-command read', async () => {
    fetcher.mockResolvedValueOnce(response());
    client.setVisible(true);
    await flush();
    let resolve!: (value: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    fetcher.mockResolvedValueOnce(response({ instanceId: 'test', operationId: 'one' }, 202));
    await client.command('connect');
    fetcher.mockResolvedValueOnce(
      response({
        ...initial,
        revision: 2,
        authorization: { kind: 'qr', link: null },
        allowedActions: [],
      }),
    );
    resolve(response());
    await flush();
    expect(view.snapshot?.authorization.kind).toBe('qr');
    expect(view.snapshot?.allowedActions).toEqual([]);
  });
  it('aborts GET and POST after five seconds and never stores the password in its view', async () => {
    const password: Snapshot = {
      ...initial,
      authorization: { kind: 'password' },
      allowedActions: ['submit_password'],
    };
    fetcher.mockResolvedValueOnce(response(password));
    client.setVisible(true);
    await flush();
    fetcher.mockImplementation(
      (_url, options) =>
        new Promise((_done, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('timeout')));
        }),
    );
    const pending = client.command('submit_password', 'private-password');
    expect(JSON.stringify(view)).not.toContain('private-password');
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(view.sending).toBe(false);
    expect(view.commandError).toContain('Ответ backend');
    await vi.advanceTimersByTimeAsync(5000);
    expect(view.status).toBe('offline');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('rejects malformed snapshots instead of enabling commands', async () => {
    fetcher.mockResolvedValueOnce(response({ ...initial, password: 'secret' }));
    client.setVisible(true);
    await flush();
    expect(view.status).toBe('offline');
    expect(view.snapshot).toBeNull();
    await client.command('connect');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
