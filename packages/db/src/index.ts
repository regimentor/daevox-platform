import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  accounts,
  chats,
  observations,
  observationPeriods,
  messages,
  chatUpdates,
  chatSummaries,
  historyImports,
  dailySummaries,
} from './schema.ts';
import { databaseUrl, normalizeDatabaseUrl } from './config.ts';
export { databaseUrl, normalizeDatabaseUrl } from './config.ts';

export type ArchiveMessage = {
  accountId: string;
  chatId: string;
  messageId: string;
  date: number;
  editDate: number | null;
  isOutgoing: boolean;
  authorKind: 'user' | 'chat' | null;
  authorId: string | null;
  authorName: string | null;
  authorUsername: string | null;
  text: string | null;
  caption: string | null;
  mediaType: string | null;
  mediaId: string | null;
  replyChatId: string | null;
  replyMessageId: string | null;
  canBeSaved: boolean;
  deleted?: boolean;
  skippedReason?: string | null;
};
export type Observation = {
  accountId: string;
  chatId: string;
  enabled: boolean;
  observationVersion: number;
  state: string;
  hasGaps: boolean;
  protectedContentSkipped: boolean;
  reason: string | null;
};

function id(value: string): number {
  if (!/^-?\d+$/.test(value)) throw new RangeError('Invalid Telegram id');
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError('Telegram id exceeds int53');
  return result;
}
const chatKey = (
  table: { account_id: AnySQLiteColumn; chat_id: AnySQLiteColumn },
  accountId: string,
  chatId: string,
) => and(eq(table.account_id, id(accountId)), eq(table.chat_id, id(chatId)));

export class ArchiveDatabase {
  readonly db;
  readonly client: DatabaseSync;
  constructor(url = databaseUrl()) {
    const path = url === ':memory:' ? url : fileURLToPath(normalizeDatabaseUrl(url));
    this.client = new DatabaseSync(path);
    this.db = drizzle({ client: this.client });
    try {
      // Short contention is normal with the summary worker. Keep waits bounded on the UI server.
      this.client.exec(
        'PRAGMA busy_timeout = 100; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;',
      );
      this.db.select().from(messages).limit(0).all();
      this.db.select().from(chatUpdates).limit(0).all();
    } catch (cause) {
      this.client.close();
      throw new Error(
        'Archive schema is unavailable. Run npm run db:push before starting the backend.',
        { cause },
      );
    }
  }
  close() {
    this.client.close();
  }
  unresolvedAuthors(accountId: string) {
    return this.db
      .selectDistinct({ kind: messages.author_kind, id: messages.author_id })
      .from(messages)
      .where(
        and(
          eq(messages.account_id, id(accountId)),
          isNull(messages.author_name),
          sql`${messages.author_id} IS NOT NULL`,
          eq(messages.can_be_saved, 1),
          eq(messages.deleted, 0),
        ),
      )
      .all();
  }
  saveAuthor(
    accountId: string,
    kind: string,
    authorId: number,
    name: string,
    username: string | null,
  ) {
    this.db
      .update(messages)
      .set({ author_name: name, author_username: username })
      .where(
        and(
          eq(messages.account_id, id(accountId)),
          eq(messages.author_kind, kind),
          eq(messages.author_id, authorId),
          eq(messages.can_be_saved, 1),
          eq(messages.deleted, 0),
        ),
      )
      .run();
  }
  enqueueDailySummaries(
    accountId: string,
    chatId: string,
    since: number,
    offset = 300,
    latestOnly = false,
  ) {
    const dayExpression = sql<string>`strftime('%Y-%m-%d', ${messages.date}, 'unixepoch', ${`${offset} minutes`})`;
    const days = this.db
      .select({ day: dayExpression })
      .from(messages)
      .where(
        and(
          chatKey(messages, accountId, chatId),
          sql`${messages.date} >= ${since}`,
          eq(messages.deleted, 0),
          eq(messages.can_be_saved, 1),
          sql`length(coalesce(${messages.text}, ${messages.caption}, '')) > 0`,
        ),
      )
      .groupBy(dayExpression)
      .all();
    const existing = new Set(this.dailySummaries(accountId, chatId).map((row) => row.day));
    const selectedDays = latestOnly
      ? days.toSorted((a, b) => b.day.localeCompare(a.day)).slice(0, 1)
      : days;
    for (const { day } of selectedDays.filter((row) => !existing.has(row.day)))
      this.db
        .insert(dailySummaries)
        .values({
          account_id: id(accountId),
          chat_id: id(chatId),
          day,
          utc_offset_minutes: offset,
          status: 'queued',
        })
        .onConflictDoNothing()
        .run();
  }
  recordMessageContent(
    accountId: string,
    chatId: string,
    messageId: number,
    content: { text: string | null; caption: string | null; mediaType: string | null },
  ) {
    this.db.transaction((tx) => {
      this.invalidateDailySummary(accountId, chatId, messageId);
      tx.update(messages)
        .set({
          text: content.text,
          caption: content.caption,
          media_type: content.mediaType,
          revision: sql`${messages.revision} + 1`,
        })
        .where(
          and(
            chatKey(messages, accountId, chatId),
            eq(messages.message_id, messageId),
            eq(messages.can_be_saved, 1),
            eq(messages.deleted, 0),
          ),
        )
        .run();
    });
  }
  invalidateDailySummary(accountId: string, chatId: string, messageId: number) {
    this.db
      .update(dailySummaries)
      .set({ status: 'queued', text: null, error: null })
      .where(
        and(
          chatKey(dailySummaries, accountId, chatId),
          sql`EXISTS (
        SELECT 1 FROM messages m WHERE m.account_id = ${Number(accountId)} AND m.chat_id = ${Number(chatId)}
        AND m.message_id = ${messageId} AND ${dailySummaries.day} = strftime('%Y-%m-%d', m.date, 'unixepoch', ${dailySummaries.utc_offset_minutes} || ' minutes')
      )`,
        ),
      )
      .run();
  }
  dailySummaries(accountId: string, chatId: string) {
    return this.db
      .select()
      .from(dailySummaries)
      .where(chatKey(dailySummaries, accountId, chatId))
      .orderBy(desc(dailySummaries.day))
      .all();
  }
  dailySummariesPage(accountId: string, chatId: string, before: string | null, limit: number) {
    const rows = this.db
      .select()
      .from(dailySummaries)
      .where(
        and(
          chatKey(dailySummaries, accountId, chatId),
          before === null ? undefined : lt(dailySummaries.day, before),
        ),
      )
      .orderBy(desc(dailySummaries.day))
      .limit(limit + 1)
      .all();
    return {
      summaries: rows.slice(0, limit),
      nextCursor: rows.length > limit ? rows[limit - 1]!.day : null,
    };
  }
  nextDailySummary() {
    return (
      this.db
        .select()
        .from(dailySummaries)
        .where(
          and(
            eq(dailySummaries.status, 'queued'),
            sql`NOT EXISTS (
          SELECT 1 FROM messages m WHERE m.account_id = ${dailySummaries.account_id}
          AND m.chat_id = ${dailySummaries.chat_id} AND m.author_id IS NOT NULL
          AND m.author_name IS NULL AND m.can_be_saved = 1 AND m.deleted = 0
        )`,
          ),
        )
        .orderBy(dailySummaries.day)
        .limit(1)
        .get() ?? null
    );
  }
  recoverDailySummaries() {
    this.db
      .update(dailySummaries)
      .set({ status: 'queued', completed_chunks: 0 })
      .where(eq(dailySummaries.status, 'running'))
      .run();
  }
  updateDailySummary(
    accountId: string,
    chatId: string,
    day: string,
    values: Partial<typeof dailySummaries.$inferInsert>,
  ) {
    this.db
      .update(dailySummaries)
      .set(values)
      .where(and(chatKey(dailySummaries, accountId, chatId), eq(dailySummaries.day, day)))
      .run();
  }
  dailySummaryMessages(accountId: string, chatId: string, day: string, offset: number) {
    const start = Date.parse(`${day}T00:00:00Z`) / 1000 - offset * 60;
    return this.db
      .select({
        id: messages.message_id,
        revision: messages.revision,
        date: messages.date,
        author: sql<
          string | null
        >`coalesce('@' || nullif(${messages.author_username}, ''), ${messages.author_name})`,
        authorId: messages.author_id,
        outgoing: messages.is_outgoing,
        text: messages.text,
        caption: messages.caption,
      })
      .from(messages)
      .where(
        and(
          chatKey(messages, accountId, chatId),
          sql`${messages.date} >= ${start} AND ${messages.date} < ${start + 86400}`,
          eq(messages.deleted, 0),
          eq(messages.can_be_saved, 1),
          sql`length(coalesce(${messages.text}, ${messages.caption}, '')) > 0`,
        ),
      )
      .orderBy(messages.message_id)
      .all();
  }
  historyImport(accountId: string, chatId: string) {
    return (
      this.db
        .select()
        .from(historyImports)
        .where(chatKey(historyImports, accountId, chatId))
        .get() ?? null
    );
  }
  beginHistoryImport(accountId: string, chatId: string, version: number) {
    const current = this.historyImport(accountId, chatId);
    if (current?.observation_version === version) return current;
    const values = {
      account_id: id(accountId),
      chat_id: id(chatId),
      observation_version: version,
      since: Math.floor(Date.now() / 1000) - 30 * 86400,
      cursor: 0,
      processed: 0,
      status: 'loading',
      error: null,
      completed_at: null,
    };
    this.db
      .insert(historyImports)
      .values(values)
      .onConflictDoUpdate({
        target: [historyImports.account_id, historyImports.chat_id],
        set: values,
      })
      .run();
    return values;
  }
  saveHistoryPage(
    accountId: string,
    chatId: string,
    batch: ArchiveMessage[],
    cursor: number,
    complete: boolean,
  ) {
    this.db.transaction((tx) => {
      if (batch.length) this.saveMessages(batch, tx);
      tx.update(historyImports)
        .set({
          cursor,
          processed: sql`${historyImports.processed} + ${batch.length}`,
          status: complete ? 'ready' : 'loading',
          error: null,
          completed_at: complete ? new Date().toISOString() : null,
        })
        .where(chatKey(historyImports, accountId, chatId))
        .run();
      tx.update(observations)
        .set({ state: complete ? 'collecting' : 'catching_up', reason: null })
        .where(chatKey(observations, accountId, chatId))
        .run();
    });
  }
  failHistoryImport(accountId: string, chatId: string) {
    this.db
      .update(historyImports)
      .set({
        status: 'error',
        error: 'Не удалось загрузить историю. Загрузка продолжится при восстановлении связи.',
      })
      .where(chatKey(historyImports, accountId, chatId))
      .run();
    this.db
      .update(observations)
      .set({ state: 'waiting_telegram' })
      .where(chatKey(observations, accountId, chatId))
      .run();
  }
  summaryInput(accountId: string, chatId: string, scope: 'latest' | 'all') {
    const update = scope === 'latest' ? this.lastUpdate(accountId, chatId) : null;
    const rows = this.db
      .select()
      .from(messages)
      .where(
        and(
          chatKey(messages, accountId, chatId),
          eq(messages.deleted, 0),
          eq(messages.can_be_saved, 1),
          scope === 'latest' ? eq(messages.update_id, update?.id ?? '') : undefined,
        ),
      )
      .orderBy(desc(messages.message_id))
      .limit(201)
      .all();
    const selected: Array<{ id: string; date: string | null; author: string; text: string }> = [];
    let bytes = 0;
    let truncated = rows.length > 200;
    for (const row of rows.slice(0, 200)) {
      const text = row.text || row.caption;
      if (!text?.trim()) continue;
      const available = 24000 - bytes;
      if (available < 300) {
        truncated = true;
        break;
      }
      let content = text;
      if (Buffer.byteLength(content, 'utf8') > available - 250) {
        content = [...content].slice(0, Math.floor((available - 250) / 4)).join('');
        truncated = true;
      }
      const item = {
        id: String(row.message_id),
        date: row.date ? new Date(row.date * 1000).toISOString() : null,
        author: row.author_username
          ? `@${row.author_username}`
          : (row.author_name ?? (row.is_outgoing ? 'Владелец аккаунта' : 'Неизвестный участник')),
        text: content,
      };
      bytes += Buffer.byteLength(JSON.stringify(item), 'utf8');
      selected.push(item);
    }
    selected.reverse();
    const source = JSON.stringify(selected);
    return {
      source,
      messageCount: selected.length,
      truncated,
      hash: createHash('sha256')
        .update(JSON.stringify(rows.map((row) => [row.message_id, row.revision])))
        .update(source)
        .digest('hex'),
    };
  }
  getSummary(accountId: string, chatId: string, scope: 'latest' | 'all') {
    return (
      this.db
        .select()
        .from(chatSummaries)
        .where(and(chatKey(chatSummaries, accountId, chatId), eq(chatSummaries.scope, scope)))
        .get() ?? null
    );
  }
  saveSummary(
    accountId: string,
    chatId: string,
    scope: 'latest' | 'all',
    value: Omit<typeof chatSummaries.$inferInsert, 'account_id' | 'chat_id' | 'scope'>,
  ) {
    this.db
      .insert(chatSummaries)
      .values({ account_id: id(accountId), chat_id: id(chatId), scope, ...value })
      .onConflictDoUpdate({
        target: [chatSummaries.account_id, chatSummaries.chat_id, chatSummaries.scope],
        set: value,
      })
      .run();
  }
  ensureAccount(accountId: string) {
    this.db
      .insert(accounts)
      .values({ account_id: id(accountId), created_at: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }
  upsertChat(
    accountId: string,
    chat: {
      id: string;
      title: string;
      type: string;
      username?: string | null;
      archived?: boolean;
      available?: boolean;
    },
  ) {
    this.db.transaction((tx) => {
      tx.insert(accounts)
        .values({ account_id: id(accountId), created_at: new Date().toISOString() })
        .onConflictDoNothing()
        .run();
      const values = {
        title: chat.title,
        type: chat.type,
        username: chat.username ?? null,
        archived: Number(!!chat.archived),
        available: Number(chat.available !== false),
      };
      tx.insert(chats)
        .values({ account_id: id(accountId), chat_id: id(chat.id), ...values })
        .onConflictDoUpdate({ target: [chats.account_id, chats.chat_id], set: values })
        .run();
      tx.insert(observations)
        .values({ account_id: id(accountId), chat_id: id(chat.id) })
        .onConflictDoNothing()
        .run();
    });
  }
  listChats(accountId: string) {
    return this.db
      .select()
      .from(chats)
      .innerJoin(
        observations,
        and(eq(chats.account_id, observations.account_id), eq(chats.chat_id, observations.chat_id)),
      )
      .where(eq(chats.account_id, id(accountId)))
      .orderBy(sql`lower(${chats.title})`, chats.chat_id)
      .all()
      .map((row) => ({ ...row.chats, ...row.observations }));
  }
  getObservation(accountId: string, chatId: string): Observation | null {
    const row = this.db
      .select()
      .from(observations)
      .where(chatKey(observations, accountId, chatId))
      .get();
    return row
      ? {
          accountId: String(row.account_id),
          chatId: String(row.chat_id),
          enabled: Boolean(row.enabled),
          observationVersion: row.observation_version,
          state: row.state,
          hasGaps: Boolean(row.has_gaps),
          protectedContentSkipped: Boolean(row.protected_skipped),
          reason: row.reason,
        }
      : null;
  }
  setObservation(
    accountId: string,
    chatId: string,
    enabled: boolean,
    expectedVersion: number,
    now = new Date(),
    database: Pick<typeof this.db, 'transaction'> = this.db,
  ) {
    return database.transaction((tx) => {
      const current = this.getObservation(accountId, chatId);
      if (!current) return null;
      if (current.observationVersion !== expectedVersion) throw new Error('STALE_OBSERVATION');
      if (current.enabled === enabled) return current;
      tx.update(observations)
        .set({
          enabled: Number(enabled),
          observation_version: current.observationVersion + 1,
          state: enabled ? 'catching_up' : 'disabled',
        })
        .where(chatKey(observations, accountId, chatId))
        .run();
      if (enabled)
        tx.insert(observationPeriods)
          .values({
            account_id: id(accountId),
            chat_id: id(chatId),
            started_at: now.toISOString(),
            start_seconds: Math.floor(now.getTime() / 1000),
          })
          .run();
      else
        tx.update(observationPeriods)
          .set({ ended_at: now.toISOString(), end_seconds: Math.floor(now.getTime() / 1000) })
          .where(
            and(
              chatKey(observationPeriods, accountId, chatId),
              isNull(observationPeriods.ended_at),
            ),
          )
          .run();
      return this.getObservation(accountId, chatId);
    });
  }
  saveMessages(batch: ArchiveMessage[], database: Pick<typeof this.db, 'transaction'> = this.db) {
    database.transaction((tx) => {
      const groups = new Map<string, ArchiveMessage[]>();
      for (const message of batch) {
        const key = `${message.accountId}:${message.chatId}`;
        const group = groups.get(key) ?? [];
        group.push(message);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        const first = group[0]!;
        const updateId = randomUUID();
        for (const m of group) {
          const key = and(
            chatKey(messages, m.accountId, m.chatId),
            eq(messages.message_id, id(m.messageId)),
          );
          const previous = tx.select().from(messages).where(key).get();
          const deleted = !!m.deleted || !!previous?.deleted;
          const readable = m.canBeSaved && !deleted;
          const values = {
            account_id: id(m.accountId),
            chat_id: id(m.chatId),
            message_id: id(m.messageId),
            date: m.deleted && previous ? previous.date : m.date,
            edit_date: m.editDate,
            is_outgoing: Number(m.isOutgoing),
            author_kind: readable ? m.authorKind : null,
            author_id: readable && m.authorId ? id(m.authorId) : null,
            author_name: readable ? m.authorName : null,
            author_username: readable ? m.authorUsername : null,
            text: readable ? m.text : null,
            caption: readable ? m.caption : null,
            media_type: readable ? m.mediaType : null,
            media_id: readable ? m.mediaId : null,
            reply_chat_id: readable && m.replyChatId ? id(m.replyChatId) : null,
            reply_message_id: readable && m.replyMessageId ? id(m.replyMessageId) : null,
            can_be_saved: Number(m.canBeSaved),
            deleted: Number(deleted),
            skipped_reason: deleted
              ? 'deleted'
              : !m.canBeSaved
                ? (m.skippedReason ?? 'protected_content')
                : (m.skippedReason ?? null),
            revision: (previous?.revision ?? 0) + 1,
            update_id: updateId,
          };
          if (
            previous &&
            (deleted || previous.text !== values.text || previous.caption !== values.caption)
          ) {
            tx.update(dailySummaries)
              .set({ status: 'queued', text: null, error: null })
              .where(
                and(
                  chatKey(dailySummaries, m.accountId, m.chatId),
                  sql`${dailySummaries.day} = strftime('%Y-%m-%d', ${previous.date}, 'unixepoch', ${dailySummaries.utc_offset_minutes} || ' minutes')`,
                ),
              )
              .run();
          }
          tx.insert(messages)
            .values(values)
            .onConflictDoUpdate({
              target: [messages.account_id, messages.chat_id, messages.message_id],
              set: values,
            })
            .run();
        }
        const update = {
          account_id: id(first.accountId),
          chat_id: id(first.chatId),
          id: updateId,
          processed_at: new Date().toISOString(),
          saved: group.filter((m) => m.canBeSaved && !m.deleted).length,
          skipped: group.filter((m) => !m.canBeSaved && !m.deleted).length,
          deleted: group.filter((m) => m.deleted).length,
        };
        tx.insert(chatUpdates)
          .values(update)
          .onConflictDoUpdate({
            target: [chatUpdates.account_id, chatUpdates.chat_id],
            set: update,
          })
          .run();
      }
    });
  }
  lastUpdate(accountId: string, chatId: string) {
    const row = this.db
      .select()
      .from(chatUpdates)
      .where(chatKey(chatUpdates, accountId, chatId))
      .get();
    return row
      ? {
          id: row.id,
          processedAt: row.processed_at,
          status: 'processed' as const,
          saved: row.saved,
          skipped: row.skipped,
          deleted: row.deleted,
        }
      : null;
  }
  history(
    accountId: string,
    chatId: string,
    updateId: string | null,
    before: string | null,
    limit = 50,
  ) {
    const rows = this.db
      .select()
      .from(messages)
      .where(
        and(
          chatKey(messages, accountId, chatId),
          updateId === null ? undefined : eq(messages.update_id, updateId),
          before === null ? undefined : lt(messages.message_id, id(before)),
        ),
      )
      .orderBy(desc(messages.message_id))
      .limit(limit + 1)
      .all();
    const page = rows.slice(0, limit);
    return {
      messages: page.map((row) => ({
        id: String(row.message_id),
        date: row.date,
        outgoing: Boolean(row.is_outgoing),
        author: row.author_username
          ? `@${row.author_username}`
          : (row.author_name ?? 'Неизвестный участник'),
        text: row.text,
        caption: row.caption,
        mediaType: row.media_type,
        deleted: Boolean(row.deleted),
        skipped: !row.can_be_saved,
      })),
      nextCursor: rows.length > limit ? String(page.at(-1)!.message_id) : null,
    };
  }
}

export { AutoReplyStore, type ReplyIntent } from './auto-reply.ts';
