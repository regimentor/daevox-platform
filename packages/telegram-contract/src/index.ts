export const actions = ['connect', 'submit_password', 'disconnect', 'restart'] as const;
export type Action = (typeof actions)[number];
export const errorCodes = [
  'invalid_request',
  'stale_state',
  'busy',
  'invalid_state',
  'invalid_password',
  'rate_limited',
  'configuration_error',
  'client_unavailable',
  'telegram_error',
] as const;
export type ErrorCode = (typeof errorCodes)[number];
export interface SafeError {
  code: ErrorCode;
  message: string;
  retryAt?: string;
}
export interface Expected {
  instanceId: string;
  controlVersion: number;
}
export interface Command {
  expected: Expected;
  password?: string;
}
export interface Accepted {
  instanceId: string;
  operationId: string;
}
export type Authorization =
  | {
      kind:
        | 'initializing'
        | 'not_connected'
        | 'requesting_qr'
        | 'password'
        | 'logging_out'
        | 'unsupported';
    }
  | { kind: 'qr'; link: string | null }
  | {
      kind: 'connected';
      account: { id: string; displayName: string; username: string | null } | null;
    };
export interface Operation {
  id: string;
  kind: Action;
  status: 'pending' | 'completed' | 'failed';
  error?: SafeError;
}
export interface Snapshot extends Expected {
  revision: number;
  client: 'initializing' | 'running' | 'failed' | 'configuration_required';
  connection: 'unknown' | 'offline' | 'connecting' | 'ready';
  authorization: Authorization;
  allowedActions: Action[];
  operation: Operation | null;
  error: SafeError | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const version = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
function member<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === 'string' && choices.includes(value as T);
}
export function isExpected(value: unknown): value is Expected {
  return (
    record(value) &&
    keys(value, ['instanceId', 'controlVersion']) &&
    text(value.instanceId) &&
    version(value.controlVersion)
  );
}
export function isCommand(value: unknown, action: Action): value is Command {
  return (
    record(value) &&
    keys(value, action === 'submit_password' ? ['expected', 'password'] : ['expected']) &&
    isExpected(value.expected) &&
    (action !== 'submit_password' || (text(value.password) && value.password.length <= 4096))
  );
}
export function isAccepted(value: unknown): value is Accepted {
  return (
    record(value) &&
    keys(value, ['instanceId', 'operationId']) &&
    text(value.instanceId) &&
    text(value.operationId)
  );
}
export function isSafeError(value: unknown): value is SafeError {
  return (
    record(value) &&
    keys(value, ['code', 'message'], ['retryAt']) &&
    member(value.code, errorCodes) &&
    text(value.message) &&
    (value.retryAt === undefined ||
      (text(value.retryAt) && Number.isFinite(Date.parse(value.retryAt))))
  );
}
function isAuthorization(value: unknown): value is Authorization {
  if (!record(value)) return false;
  if (value.kind === 'qr')
    return (
      keys(value, ['kind', 'link']) &&
      (value.link === null ||
        (text(value.link) && /^tg:\/\/login\?token=[A-Za-z0-9_=-]+$/.test(value.link)))
    );
  if (value.kind === 'connected') {
    if (!keys(value, ['kind', 'account'])) return false;
    const account = value.account;
    return (
      account === null ||
      (record(account) &&
        keys(account, ['id', 'displayName', 'username']) &&
        text(account.id) &&
        /^\d+$/.test(account.id) &&
        typeof account.displayName === 'string' &&
        (account.username === null || text(account.username)))
    );
  }
  return (
    keys(value, ['kind']) &&
    member(value.kind, [
      'initializing',
      'not_connected',
      'requesting_qr',
      'password',
      'logging_out',
      'unsupported',
    ])
  );
}
function isOperation(value: unknown): value is Operation {
  return (
    record(value) &&
    keys(value, ['id', 'kind', 'status'], ['error']) &&
    text(value.id) &&
    member(value.kind, actions) &&
    member(value.status, ['pending', 'completed', 'failed']) &&
    (value.error === undefined || isSafeError(value.error))
  );
}
export function isSnapshot(value: unknown): value is Snapshot {
  return (
    record(value) &&
    keys(value, [
      'instanceId',
      'controlVersion',
      'revision',
      'client',
      'connection',
      'authorization',
      'allowedActions',
      'operation',
      'error',
    ]) &&
    text(value.instanceId) &&
    version(value.controlVersion) &&
    version(value.revision) &&
    member(value.client, ['initializing', 'running', 'failed', 'configuration_required']) &&
    member(value.connection, ['unknown', 'offline', 'connecting', 'ready']) &&
    isAuthorization(value.authorization) &&
    Array.isArray(value.allowedActions) &&
    value.allowedActions.every((action) => member(action, actions)) &&
    new Set(value.allowedActions).size === value.allowedActions.length &&
    (value.operation === null || isOperation(value.operation)) &&
    (value.error === null || isSafeError(value.error))
  );
}
