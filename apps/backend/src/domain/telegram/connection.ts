import { randomUUID } from 'node:crypto';
import { TdlibClient, TdlibError } from '@daevox/tdlib';
import type { TdAuthorizationState, TdSetTdlibParameters } from '@daevox/tdlib';
import type { Action, Command, ErrorCode, SafeError, Snapshot } from '@daevox/telegram-contract';

export type TelegramClient = Pick<
  TdlibClient,
  'start' | 'close' | 'invoke' | 'onUpdate' | 'onError'
>;
export type TelegramReadRequest = Parameters<TelegramClient['invoke']>[0];
export type TelegramUpdate = Parameters<Parameters<TelegramClient['onUpdate']>[0]>[0];
export interface ConnectionOptions {
  parameters: TdSetTdlibParameters | null;
  createClient?: () => TelegramClient;
}
const messages: Record<ErrorCode, string> = {
  invalid_request: 'Неверный формат запроса.',
  stale_state: 'Состояние изменилось. Обновите экран.',
  busy: 'Предыдущая команда ещё выполняется.',
  invalid_state: 'Действие недоступно на этом шаге.',
  invalid_password: 'Неверный пароль. Попробуйте ещё раз.',
  rate_limited: 'Telegram ограничил попытки. Подождите перед повтором.',
  configuration_error: 'Проверьте серверные настройки Telegram и постоянных каталогов.',
  client_unavailable:
    'Клиент Telegram недоступен. Проверьте native runtime и перезапустите подключение.',
  telegram_error: 'Telegram не смог выполнить действие. Попробуйте ещё раз.',
};
export const safeError = (code: ErrorCode): SafeError => ({ code, message: messages[code] });
export class CommandError extends Error {
  readonly status: number;
  readonly detail: SafeError;
  constructor(status: number, code: ErrorCode) {
    super(messages[code]);
    this.status = status;
    this.detail = safeError(code);
  }
}
function commandFailure(error: unknown): SafeError {
  if (error instanceof TdlibError) {
    if (error.message === 'PASSWORD_HASH_INVALID') return safeError('invalid_password');
    if (error.code === 429) {
      const result = safeError('rate_limited');
      const seconds = /^(?:Too Many Requests: retry after |FLOOD_WAIT_)(\d+)$/.exec(
        error.message,
      )?.[1];
      if (seconds && Number(seconds) <= 86400 * 365)
        result.retryAt = new Date(Date.now() + Number(seconds) * 1000).toISOString();
      return result;
    }
  }
  return safeError('telegram_error');
}

/** Owns one session. All command admission and update publication are synchronous. */
export class TelegramConnection {
  private readonly options: ConnectionOptions;
  private state: Snapshot = {
    instanceId: randomUUID(),
    revision: 0,
    controlVersion: 0,
    client: 'initializing',
    connection: 'unknown',
    authorization: { kind: 'initializing' },
    allowedActions: [],
    operation: null,
    error: null,
  };
  private client?: TelegramClient;
  private generation = 0;
  private liveSince: number | null = null;
  get replyLiveSince() {
    return this.state.client === 'running' &&
      this.state.authorization.kind === 'connected' &&
      !(this.state.operation?.kind === 'disconnect' && this.state.operation.status === 'pending') &&
      !this.releasing &&
      !this.stopping
      ? this.liveSince
      : null;
  }
  private stopping = false;
  private releasing = false;
  private startup?: Promise<void>;
  private opening?: Promise<void>;
  private release?: Promise<void>;
  private unsubscribe: Array<() => void> = [];
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readonly stateListeners = new Set<() => void>();
  private readonly updateListeners = new Set<(update: TelegramUpdate) => void>();

  constructor(options: ConnectionOptions) {
    this.options = options;
  }
  snapshot(): Snapshot {
    return structuredClone(this.state);
  }
  onState(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  onSecretaryUpdate(listener: (update: TelegramUpdate) => void): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }
  async invokeRead<T>(request: TelegramReadRequest): Promise<T> {
    if (
      !this.client ||
      this.state.client !== 'running' ||
      this.state.authorization.kind !== 'connected'
    )
      throw new Error('TELEGRAM_UNAVAILABLE');
    return (await this.client.invoke(request)) as T;
  }
  start(): Promise<void> {
    if (!this.startup) this.startup = this.boot();
    return this.startup;
  }
  private publish(control = false): void {
    const previous = this.state.allowedActions.join();
    const actions: Action[] = [];
    const pending = this.state.operation?.status === 'pending';
    const cooling = this.state.error?.retryAt && Date.parse(this.state.error.retryAt) > Date.now();
    if (!pending && !this.stopping && !this.releasing) {
      if (this.state.client === 'failed') actions.push('restart');
      if (this.state.client === 'running' && !cooling) {
        if (this.state.authorization.kind === 'not_connected' && this.state.connection === 'ready')
          actions.push('connect');
        if (this.state.authorization.kind === 'password' && this.state.connection === 'ready')
          actions.push('submit_password');
        if (this.state.authorization.kind === 'connected') actions.push('disconnect');
      }
    }
    this.state.allowedActions = actions;
    this.state.revision++;
    if (control || previous !== actions.join()) this.state.controlVersion++;
    for (const listener of this.stateListeners) listener();
  }
  private setAuthorization(authorization: Snapshot['authorization']): void {
    const changed = authorization.kind !== this.state.authorization.kind;
    this.state.authorization = authorization;
    if (changed) {
      this.state.error = null;
      if (this.state.operation?.status === 'failed') this.state.operation = null;
    }
    this.publish(changed);
  }
  private current(generation: number): boolean {
    return generation === this.generation && !this.stopping;
  }
  private complete(): void {
    if (this.state.operation?.status === 'pending') {
      this.state.operation = { ...this.state.operation, status: 'completed' };
      this.state.error = null;
      this.publish(true);
    }
  }
  private async boot(): Promise<void> {
    if (this.stopping) return;
    if (!this.options.parameters) {
      this.state.client = 'configuration_required';
      this.state.error = safeError('configuration_error');
      this.publish(true);
      return;
    }
    this.liveSince = null;
    const generation = ++this.generation;
    this.state.client = 'initializing';
    this.state.connection = 'unknown';
    this.setAuthorization({ kind: 'initializing' });
    let started = false;
    let latest: TdAuthorizationState | undefined;
    let authSequence = 0;
    let parametersSent = false;
    try {
      const client = (this.options.createClient ?? (() => new TdlibClient()))();
      this.client = client;
      const authorization = (auth: TdAuthorizationState) => {
        if (!this.current(generation) || this.releasing) return;
        if (auth['@type'] === 'authorizationStateWaitTdlibParameters') {
          if (!parametersSent) {
            parametersSent = true;
            void client.invoke(this.options.parameters!).catch(() => {
              if (this.current(generation)) this.fail(generation, 'configuration_error');
            });
          }
          return;
        }
        this.onAuthorization(auth, generation, client);
      };
      this.unsubscribe = [
        client.onUpdate((update) => {
          if (!this.current(generation) || this.releasing) return;
          if (update['@type'] === 'updateAuthorizationState' && update.authorization_state) {
            authSequence++;
            latest = update.authorization_state;
            if (started) authorization(latest);
          }
          if (update['@type'] === 'updateConnectionState')
            this.liveSince = update.state?.['@type'] === 'connectionStateReady' ? Date.now() : null;
          for (const listener of this.updateListeners) listener(update);
          if (update['@type'] === 'updateConnectionState' && update.state) {
            const type = update.state['@type'];
            this.state.connection =
              type === 'connectionStateWaitingForNetwork'
                ? 'offline'
                : type === 'connectionStateReady' || type === 'connectionStateUpdating'
                  ? 'ready'
                  : 'connecting';
            if (this.state.connection !== 'ready' && this.state.authorization.kind === 'qr')
              this.state.authorization = { kind: 'qr', link: null };
            this.publish();
          }
        }),
        client.onError(() => this.fail(generation, 'client_unavailable')),
      ];
      this.opening = client.start();
      await this.opening;
      if (!this.current(generation) || this.releasing) return;
      // Disable native logging before providing any credentials or authentication input.
      await client.invoke({ '@type': 'setLogStream', log_stream: { '@type': 'logStreamEmpty' } });
      if (!this.current(generation) || this.releasing) return;
      this.state.client = 'running';
      started = true;
      this.publish(true);
      if (latest) authorization(latest);
      const sequence = authSequence;
      const auth = await client.invoke({ '@type': 'getAuthorizationState' });
      if (sequence === authSequence) authorization(auth);
      if (this.current(generation) && this.state.operation?.kind === 'restart') this.complete();
    } catch {
      this.fail(generation, 'client_unavailable');
    }
  }
  private onAuthorization(
    auth: TdAuthorizationState,
    generation: number,
    client: TelegramClient,
  ): void {
    switch (auth['@type']) {
      case 'authorizationStateWaitPhoneNumber': {
        const revoked = this.state.authorization.kind === 'connected';
        this.setAuthorization({ kind: 'not_connected' });
        if (revoked) this.sessionEnded();
        break;
      }
      case 'authorizationStateWaitOtherDeviceConfirmation':
        this.setAuthorization({
          kind: 'qr',
          link: this.state.connection === 'ready' ? auth.link : null,
        });
        if (this.state.operation?.kind === 'connect') this.complete();
        break;
      case 'authorizationStateWaitPassword':
        this.setAuthorization({ kind: 'password' });
        if (this.state.operation?.kind === 'connect') this.complete();
        break;
      case 'authorizationStateReady': {
        const alreadyConnected = this.state.authorization.kind === 'connected';
        if (!alreadyConnected) this.setAuthorization({ kind: 'connected', account: null });
        if (
          this.state.operation?.kind === 'connect' ||
          this.state.operation?.kind === 'submit_password'
        )
          this.complete();
        if (!alreadyConnected)
          void client
            .invoke({ '@type': 'getMe' })
            .then((user) => {
              if (!this.current(generation) || this.state.authorization.kind !== 'connected')
                return;
              this.state.authorization = {
                kind: 'connected',
                account: {
                  id: String(user.id),
                  displayName: [user.first_name, user.last_name].filter(Boolean).join(' '),
                  username: user.usernames?.active_usernames[0] ?? null,
                },
              };
              this.publish();
            })
            .catch(() => undefined);
        break;
      }
      case 'authorizationStateLoggingOut':
        this.setAuthorization({ kind: 'logging_out' });
        break;
      case 'authorizationStateClosing':
        if (this.state.authorization.kind !== 'logging_out')
          this.setAuthorization({ kind: 'initializing' });
        break;
      case 'authorizationStateClosed': {
        const loggedOut = this.state.authorization.kind === 'logging_out';
        if (!loggedOut) {
          this.fail(generation, 'client_unavailable');
          break;
        }
        const requested =
          this.state.operation?.kind === 'disconnect' && this.state.operation.status === 'pending';
        void this.releaseClient()
          .then(async () => {
            if (!this.current(generation)) return;
            this.complete();
            await this.boot();
            if (!requested && !this.stopping && this.state.authorization.kind === 'not_connected')
              this.sessionEnded();
          })
          .catch(() => this.fail(generation, 'client_unavailable'));
        break;
      }
      default:
        this.setAuthorization({ kind: 'unsupported' });
        this.complete();
    }
  }
  private sessionEnded(): void {
    this.state.error = {
      code: 'telegram_error',
      message: 'Сессия Telegram завершена. Подключите аккаунт снова.',
    };
    this.publish();
  }
  private releaseClient(): Promise<void> {
    if (this.releasing) return this.release!;
    this.releasing = true;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.publish(true);
    this.release = Promise.resolve()
      .then(() => this.client?.close())
      .then(() => {
        this.client = undefined;
        this.releasing = false;
        this.publish(true);
      });
    return this.release;
  }
  private fail(generation: number, code: ErrorCode): void {
    if (!this.current(generation) || this.state.client === 'failed') return;
    this.generation++;
    this.state.client = code === 'configuration_error' ? 'configuration_required' : 'failed';
    this.state.connection = 'unknown';
    this.state.authorization = { kind: 'initializing' };
    this.state.error = safeError(code);
    if (this.state.operation?.status === 'pending')
      this.state.operation = { ...this.state.operation, status: 'failed', error: this.state.error };
    this.publish(true);
    void this.releaseClient().catch(() => {
      /* Keep restart unavailable until release is confirmed. */
    });
  }
  accept(action: Action, command: Command) {
    const expected = command.expected;
    if (
      expected.instanceId !== this.state.instanceId ||
      expected.controlVersion !== this.state.controlVersion
    )
      throw new CommandError(409, 'stale_state');
    if (this.state.operation?.status === 'pending') throw new CommandError(409, 'busy');
    if (action !== 'restart' && this.state.client !== 'running')
      throw new CommandError(503, 'client_unavailable');
    if (!this.state.allowedActions.includes(action)) throw new CommandError(409, 'invalid_state');
    const id = randomUUID();
    this.state.operation = { id, kind: action, status: 'pending' };
    this.state.error = null;
    if (action === 'connect') this.setAuthorization({ kind: 'requesting_qr' });
    this.publish(true);
    const generation = this.generation;
    // A macrotask lets HTTP finish admission; execution does not use its abort signal.
    setImmediate(() => {
      void this.execute(action, command.password, id, generation);
    });
    return { instanceId: this.state.instanceId, operationId: id };
  }
  private async execute(
    action: Action,
    password: string | undefined,
    id: string,
    generation: number,
  ): Promise<void> {
    if (
      !this.current(generation) ||
      this.state.operation?.id !== id ||
      this.state.operation.status !== 'pending'
    )
      return;
    try {
      if (action === 'restart') {
        await this.boot();
        return;
      }
      const client = this.client!;
      if (action === 'connect')
        await client.invoke({ '@type': 'requestQrCodeAuthentication', other_user_ids: [] });
      if (action === 'submit_password')
        await client.invoke({ '@type': 'checkAuthenticationPassword', password: password! });
      if (action === 'disconnect') await client.invoke({ '@type': 'logOut' });
    } catch (error) {
      if (
        !this.current(generation) ||
        this.state.operation?.id !== id ||
        this.state.operation.status !== 'pending' ||
        this.releasing
      )
        return;
      // LoggingOut is authoritative even if an earlier invoke's result arrives late.
      if (this.state.authorization.kind === 'logging_out') return;
      const detail = commandFailure(error);
      if (action === 'connect') this.setAuthorization({ kind: 'not_connected' });
      this.state.operation = { id, kind: action, status: 'failed', error: detail };
      this.state.error = detail;
      this.publish(true);
      if (this.retryTimer) clearTimeout(this.retryTimer);
      if (detail.retryAt)
        this.retryTimer = setTimeout(
          () => this.publish(),
          Math.min(2147483647, Date.parse(detail.retryAt) - Date.now() + 1),
        );
    }
  }
  async close(): Promise<void> {
    this.stopping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.opening?.catch(() => undefined);
    await this.releaseClient();
  }
}
