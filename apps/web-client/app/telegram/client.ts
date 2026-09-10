import { isAccepted, isSafeError, isSnapshot } from '@daevox/telegram-contract';
import type { Action, Snapshot } from '@daevox/telegram-contract';

export interface TelegramView {
  snapshot: Snapshot | null;
  status: 'loading' | 'online' | 'offline' | 'paused';
  sending: boolean;
  commandError: string | null;
}
const paths: Record<Action, string> = {
  connect: 'connect',
  submit_password: 'password',
  disconnect: 'disconnect',
  restart: 'restart',
};

/** Polls serially and invalidates readings across commands and visibility changes. */
export class TelegramApi {
  private view: TelegramView = {
    snapshot: null,
    status: 'loading',
    sending: false,
    commandError: null,
  };
  private readonly notify: (view: TelegramView) => void;
  private active = false;
  private disposed = false;
  private sequence = 0;
  private failures = 0;
  private queued = false;
  private reading = false;
  private timer?: ReturnType<typeof setTimeout>;
  private getAbort?: AbortController;
  private postAbort?: AbortController;

  constructor(notify: (view: TelegramView) => void) {
    this.notify = notify;
  }
  private update(patch: Partial<TelegramView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    this.notify(this.view);
  }
  setVisible(visible: boolean) {
    if (this.disposed) return;
    this.active = visible;
    if (visible) this.refresh();
    else {
      this.sequence++;
      this.queued = false;
      clearTimeout(this.timer);
      this.getAbort?.abort();
      this.update({ status: 'paused' });
    }
  }
  refresh() {
    if (!this.active || this.disposed) return;
    this.sequence++;
    this.queued = true;
    clearTimeout(this.timer);
    this.getAbort?.abort();
    this.update({ status: 'loading' });
    void this.read();
  }
  private async read() {
    if (!this.active || this.disposed || this.reading || this.view.sending) return;
    this.queued = false;
    this.reading = true;
    const sequence = ++this.sequence;
    const controller = new AbortController();
    this.getAbort = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    let delay = 1000;
    try {
      const response = await fetch('/api/telegram/state', {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
      const body: unknown = await response.json();
      if (sequence !== this.sequence || !this.active || this.disposed) return;
      if (!response.ok || !isSnapshot(body)) throw new Error('Invalid snapshot');
      const old = this.view.snapshot;
      if (old?.instanceId === body.instanceId && old.revision > body.revision)
        throw new Error('Stale snapshot');
      this.failures = 0;
      this.update({
        snapshot: body,
        status: 'online',
        commandError:
          old?.instanceId !== body.instanceId || old.authorization.kind !== body.authorization.kind
            ? null
            : this.view.commandError,
      });
    } catch {
      if (sequence !== this.sequence || !this.active || this.disposed) return;
      delay = Math.min(1000 * 2 ** Math.min(this.failures++, 3), 5000);
      this.update({ status: 'offline' });
    } finally {
      clearTimeout(timeout);
      this.reading = false;
      this.getAbort = undefined;
      if (this.active && !this.disposed) {
        if (this.queued) void this.read();
        else
          this.timer = setTimeout(() => {
            void this.read();
          }, delay);
      }
    }
  }
  async command(action: Action, password?: string) {
    const snapshot = this.view.snapshot;
    if (
      this.disposed ||
      !this.active ||
      this.view.status !== 'online' ||
      this.view.sending ||
      !snapshot?.allowedActions.includes(action)
    )
      return;
    this.sequence++;
    clearTimeout(this.timer);
    this.getAbort?.abort();
    this.update({ sending: true, commandError: null, status: 'loading' });
    const controller = new AbortController();
    this.postAbort = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`/api/telegram/${paths[action]}`, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expected: { instanceId: snapshot.instanceId, controlVersion: snapshot.controlVersion },
          ...(action === 'submit_password' ? { password } : {}),
        }),
      });
      password = undefined;
      const body: unknown = await response.json();
      if (response.status === 202 && isAccepted(body)) return;
      const error =
        typeof body === 'object' && body !== null && 'error' in body ? body.error : null;
      this.update({
        commandError: isSafeError(error)
          ? error.message
          : 'Не удалось принять команду. Состояние будет обновлено.',
      });
    } catch {
      this.update({ commandError: 'Ответ backend не получен. Проверяем состояние команды.' });
    } finally {
      clearTimeout(timeout);
      this.postAbort = undefined;
      this.update({ sending: false });
      this.refresh();
    }
  }
  dispose() {
    this.disposed = true;
    this.active = false;
    this.sequence++;
    clearTimeout(this.timer);
    this.getAbort?.abort();
    this.postAbort?.abort();
  }
}
