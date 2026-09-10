export const secretaryCollectionStates = [
  'disabled',
  'waiting_telegram',
  'catching_up',
  'collecting',
  'no_access',
  'migrated',
  'broken',
  'resume_required',
] as const;
export type SecretaryCollectionState = (typeof secretaryCollectionStates)[number];

export type SecretaryContext = {
  instanceId: string;
  accountId: string | null;
  accountEpoch: number;
  revision: number;
};
export type SecretaryCompleteness = {
  hasGaps: boolean;
  protectedContentSkipped: boolean;
  approximateBoundary: boolean;
};
export type SecretaryChat = {
  id: string;
  title: string;
  type: 'private' | 'basic_group' | 'supergroup';
  username: string | null;
  archived: boolean;
  available: boolean;
  enabled: boolean;
  observationVersion: number;
  autoReply: AutoReplyStatus;
  collection: SecretaryCollectionState;
  completeness: SecretaryCompleteness;
  reason: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  lastUpdate: SecretaryChatUpdate | null;
  historyImport: {
    status: 'loading' | 'ready' | 'error';
    since: number;
    processed: number;
    error: string | null;
  } | null;
};
export type SecretaryChatUpdate = {
  id: string;
  processedAt: string;
  status: 'processed' | 'error';
  saved: number;
  skipped: number;
  deleted: number;
};
export type SecretaryHistoryMessage = {
  id: string;
  date: number;
  outgoing: boolean;
  author: string | null;
  text: string | null;
  caption: string | null;
  mediaType: string | null;
  deleted: boolean;
  skipped: boolean;
};
export type SecretaryHistoryPage = {
  context: SecretaryContext;
  lastUpdate: SecretaryChatUpdate | null;
  messages: SecretaryHistoryMessage[];
  nextCursor: string | null;
};
export type ChatSummary = {
  status: 'running' | 'ready' | 'error';
  scope: 'latest' | 'all';
  text: string | null;
  error: string | null;
  model: string | null;
  startedAt: string;
  completedAt: string | null;
  messageCount: number;
  truncated: boolean;
  stale: boolean;
};
export type DailySummary = {
  day: string;
  utc_offset_minutes: number;
  status: 'queued' | 'running' | 'ready' | 'error';
  text: string | null;
  error: string | null;
  model: string | null;
  message_count: number;
  completed_chunks: number;
  total_chunks: number;
  completed_at: string | null;
};
export type SecretarySnapshot = {
  context: SecretaryContext;
  storage: 'initializing' | 'migrating' | 'ready' | 'error';
  catalog: { status: 'loading' | 'ready' | 'partial'; revision: number; knownCount: number };
  observed: { enabled: number; collecting: number; gaps: number } | null;
  error: { code: 'storage_error' | 'not_connected'; message: string } | null;
};
export type SecretaryChatsPage = {
  context: SecretaryContext;
  catalog: SecretarySnapshot['catalog'];
  chats: SecretaryChat[];
  observedChats: SecretaryChat[];
  totalKnown: number;
  nextCursor: string | null;
};
export type ObservationCommand = {
  accountId: string;
  chatId: string;
  enabled: boolean;
  expected: { instanceId: string; accountEpoch: number; observationVersion: number };
};
export type ResumeCommand = Omit<ObservationCommand, 'enabled'>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const safeInt = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((k) => k in v) &&
  Object.keys(v).every((k) => required.includes(k) || optional.includes(k));

export function isObservationCommand(value: unknown): value is ObservationCommand {
  if (!isRecord(value) || !keys(value, ['accountId', 'chatId', 'enabled', 'expected']))
    return false;
  const expected = value.expected;
  return (
    nonEmpty(value.accountId) &&
    nonEmpty(value.chatId) &&
    typeof value.enabled === 'boolean' &&
    isRecord(expected) &&
    keys(expected, ['instanceId', 'accountEpoch', 'observationVersion']) &&
    nonEmpty(expected.instanceId) &&
    safeInt(expected.accountEpoch) &&
    safeInt(expected.observationVersion)
  );
}
export function isResumeCommand(value: unknown): value is ResumeCommand {
  if (!isRecord(value) || !keys(value, ['accountId', 'chatId', 'expected'])) return false;
  const expected = value.expected;
  return (
    nonEmpty(value.accountId) &&
    nonEmpty(value.chatId) &&
    isRecord(expected) &&
    keys(expected, ['instanceId', 'accountEpoch', 'observationVersion']) &&
    nonEmpty(expected.instanceId) &&
    safeInt(expected.accountEpoch) &&
    safeInt(expected.observationVersion)
  );
}
export function isSecretaryContext(value: unknown): value is SecretaryContext {
  return (
    isRecord(value) &&
    keys(value, ['instanceId', 'accountId', 'accountEpoch', 'revision']) &&
    nonEmpty(value.instanceId) &&
    (value.accountId === null || nonEmpty(value.accountId)) &&
    safeInt(value.accountEpoch) &&
    safeInt(value.revision)
  );
}

export type AutoReplyStatus = {
  enabled: boolean;
  version: number;
  state: string;
  reason: string | null;
  lastResult: { state: string; reason: string | null } | null;
};
export type AutoReplyCommand = Omit<ObservationCommand, 'expected'> & {
  expected: { instanceId: string; accountEpoch: number; autoReplyVersion: number };
};
const telegramId = (v: unknown) =>
  typeof v === 'string' && /^-?\d+$/.test(v) && Number.isSafeInteger(Number(v));
export function isAutoReplyCommand(value: unknown): value is AutoReplyCommand {
  if (!isRecord(value) || !keys(value, ['accountId', 'chatId', 'enabled', 'expected']))
    return false;
  const expected = value.expected;
  return (
    telegramId(value.accountId) &&
    telegramId(value.chatId) &&
    typeof value.enabled === 'boolean' &&
    isRecord(expected) &&
    keys(expected, ['instanceId', 'accountEpoch', 'autoReplyVersion']) &&
    nonEmpty(expected.instanceId) &&
    safeInt(expected.accountEpoch) &&
    safeInt(expected.autoReplyVersion)
  );
}
