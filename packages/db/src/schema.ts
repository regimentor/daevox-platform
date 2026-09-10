import { foreignKey, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable('accounts', {
  account_id: integer().primaryKey(),
  created_at: text().notNull(),
});
export const chats = sqliteTable(
  'chats',
  {
    account_id: integer()
      .notNull()
      .references(() => accounts.account_id),
    chat_id: integer().notNull(),
    title: text().notNull(),
    type: text().notNull(),
    username: text(),
    archived: integer().notNull().default(0),
    available: integer().notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.account_id, t.chat_id] })],
);
export const observations = sqliteTable(
  'observations',
  {
    account_id: integer().notNull(),
    chat_id: integer().notNull(),
    enabled: integer().notNull().default(0),
    observation_version: integer().notNull().default(0),
    state: text().notNull().default('disabled'),
    has_gaps: integer().notNull().default(0),
    protected_skipped: integer().notNull().default(0),
    reason: text(),
  },
  (t) => [
    primaryKey({ columns: [t.account_id, t.chat_id] }),
    foreignKey({
      columns: [t.account_id, t.chat_id],
      foreignColumns: [chats.account_id, chats.chat_id],
    }),
  ],
);
export const observationPeriods = sqliteTable(
  'observation_periods',
  {
    period_id: integer().primaryKey(),
    account_id: integer().notNull(),
    chat_id: integer().notNull(),
    started_at: text().notNull(),
    ended_at: text(),
    start_seconds: integer().notNull(),
    end_seconds: integer(),
    approximate: integer().notNull().default(1),
  },
  (t) => [
    foreignKey({
      columns: [t.account_id, t.chat_id],
      foreignColumns: [chats.account_id, chats.chat_id],
    }),
  ],
);
export const messages = sqliteTable(
  'messages',
  {
    account_id: integer().notNull(),
    chat_id: integer().notNull(),
    message_id: integer().notNull(),
    date: integer().notNull(),
    edit_date: integer(),
    is_outgoing: integer().notNull(),
    author_kind: text(),
    author_id: integer(),
    author_name: text(),
    author_username: text(),
    text: text(),
    caption: text(),
    media_type: text(),
    media_id: text(),
    reply_chat_id: integer(),
    reply_message_id: integer(),
    can_be_saved: integer().notNull(),
    deleted: integer().notNull().default(0),
    skipped_reason: text(),
    revision: integer().notNull().default(1),
    update_id: text(),
  },
  (t) => [primaryKey({ columns: [t.account_id, t.chat_id, t.message_id] })],
);
export const syncProgress = sqliteTable(
  'sync_progress',
  {
    account_id: integer().notNull(),
    chat_id: integer().notNull(),
    period_id: integer().notNull(),
    cursor: integer().notNull().default(0),
    last_attempt_at: text(),
    last_success_at: text(),
    next_attempt_at: text(),
    reason: text(),
  },
  (t) => [primaryKey({ columns: [t.account_id, t.chat_id, t.period_id] })],
);
export const chatUpdates = sqliteTable(
  'chat_updates',
  {
    account_id: integer().notNull(),
    chat_id: integer().notNull(),
    id: text().notNull(),
    processed_at: text().notNull(),
    saved: integer().notNull(),
    skipped: integer().notNull(),
    deleted: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.account_id, t.chat_id] })],
);
// Retained so push does not drop the existing archive's migration bookkeeping.
export const legacyMigrations = sqliteTable('schema_migrations', {
  version: integer().primaryKey(),
});

export const chatSummaries = sqliteTable(
  'chat_summaries',
  {
    account_id: integer().notNull(),
    chat_id: integer().notNull(),
    scope: text().notNull(),
    status: text().notNull(),
    text: text(),
    error: text(),
    model: text(),
    started_at: text().notNull(),
    completed_at: text(),
    message_count: integer().notNull(),
    truncated: integer().notNull(),
    source_hash: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.account_id, t.chat_id, t.scope] })],
);

export const historyImports = sqliteTable(
  'history_imports',
  {
    account_id: integer().notNull(),
    chat_id: integer().notNull(),
    observation_version: integer().notNull(),
    since: integer().notNull(),
    cursor: integer().notNull().default(0),
    processed: integer().notNull().default(0),
    status: text().notNull(),
    error: text(),
    completed_at: text(),
  },
  (t) => [primaryKey({ columns: [t.account_id, t.chat_id] })],
);

export const dailySummaries = sqliteTable(
  'daily_summaries',
  {
    account_id: integer().notNull(),
    chat_id: integer().notNull(),
    day: text().notNull(),
    utc_offset_minutes: integer().notNull(),
    status: text().notNull().default('queued'),
    text: text(),
    error: text(),
    model: text(),
    source_hash: text(),
    message_count: integer().notNull().default(0),
    completed_chunks: integer().notNull().default(0),
    total_chunks: integer().notNull().default(0),
    completed_at: text(),
  },
  (t) => [primaryKey({ columns: [t.account_id, t.chat_id, t.day] })],
);

export const autoReplySettings = sqliteTable(
  'auto_reply_settings',
  {
    account_id: integer().notNull(),
    chat_id: integer().notNull(),
    enabled: integer().notNull().default(0),
    version: integer().notNull().default(0),
    enabled_at: integer().notNull().default(0),
    state: text().notNull().default('disabled'),
    reason: text(),
  },
  (t) => [primaryKey({ columns: [t.account_id, t.chat_id] })],
);

export const autoReplyIntents = sqliteTable(
  'auto_reply_intents',
  {
    account_id: integer().notNull(),
    chat_id: integer().notNull(),
    message_id: integer().notNull(),
    epoch: text().notNull(),
    setting_version: integer().notNull().default(0),
    received_at: integer().notNull(),
    deadline: integer().notNull(),
    version: integer().notNull().default(1),
    incoming: text().notNull(),
    state: text().notNull().default('queued'),
    reason: text(),
    sending_id: integer(),
    temporary_id: integer(),
    final_id: integer(),
    retry_at: integer(),
    reply_text: text(),
  },
  (t) => [primaryKey({ columns: [t.account_id, t.chat_id, t.message_id] })],
);
