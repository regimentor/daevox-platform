import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ArchiveDatabase } from './index.ts';
import { autoReplyIntents as intents, autoReplySettings as settings } from './schema.ts';
export type ReplyIntent = typeof intents.$inferSelect;
const key = (table: typeof intents | typeof settings, account: string, chat: string) =>
  and(eq(table.account_id, Number(account)), eq(table.chat_id, Number(chat)));
const pending = ['queued', 'generating', 'retry'];

/** Persistent admission and delivery journal. Recovery never makes old work sendable. */
export class AutoReplyStore {
  private readonly archive: ArchiveDatabase;
  constructor(archive: ArchiveDatabase) {
    this.archive = archive;
    archive.db.select().from(settings).limit(0).all();
    archive.db.select().from(intents).limit(0).all();
  }
  setting(account: string, chat: string) {
    return (
      this.archive.db
        .select()
        .from(settings)
        .where(key(settings, account, chat))
        .get() ?? {
        account_id: Number(account),
        chat_id: Number(chat),
        enabled: 0,
        version: 0,
        enabled_at: 0,
        state: 'disabled',
        reason: null,
      }
    );
  }
  configure(
    account: string,
    chat: string,
    enabled: boolean,
    version: number,
    now: number,
    also?: (tx: Pick<ArchiveDatabase['db'], 'transaction'>) => void,
  ) {
    return this.archive.db.transaction((tx) => {
      const current = this.setting(account, chat);
      if (current.version !== version) throw Object.assign(new Error('STALE'), { code: 'stale' });
      if (!!current.enabled === enabled) return current;
      also?.(tx);
      const value = {
        ...current,
        enabled: Number(enabled),
        version: version + 1,
        enabled_at: now,
        state: enabled ? 'waiting_telegram' : 'disabled',
        reason: null,
      };
      this.archive.db
        .insert(settings)
        .values(value)
        .onConflictDoUpdate({
          target: [settings.account_id, settings.chat_id],
          set: value,
        })
        .run();
      this.cancel(account, 'Автоответчик переключён', chat);
      return value;
    });
  }
  status(account: string, chat: string, state: string, reason: string | null = null) {
    this.archive.db
      .update(settings)
      .set({ state, reason })
      .where(key(settings, account, chat))
      .run();
  }
  ready(account: string, chat: string, now: number) {
    this.archive.db
      .update(settings)
      .set({ state: 'working', reason: null, enabled_at: now })
      .where(key(settings, account, chat))
      .run();
  }
  logout(account: string) {
    this.archive.db
      .update(settings)
      .set({
        enabled: 0,
        state: 'disabled',
        version: sql`${settings.version} + 1`,
        reason: 'Требуется повторное включение после выхода',
      })
      .where(eq(settings.account_id, Number(account)))
      .run();
    this.cancel(account, 'Выход из аккаунта');
  }
  recover() {
    this.archive.db
      .update(intents)
      .set({ state: 'cancelled', reason: 'Перезапуск приложения', incoming: '', reply_text: null })
      .where(inArray(intents.state, pending))
      .run();
    this.archive.db
      .update(intents)
      .set({
        state: 'unknown',
        reason: 'Результат отправки неизвестен',
        incoming: '',
        reply_text: null,
      })
      .where(inArray(intents.state, ['sending', 'pending']))
      .run();
  }
  cancel(account: string, reason: string, chat?: string) {
    this.archive.db
      .update(intents)
      .set({ state: 'cancelled', reason, incoming: '', reply_text: null })
      .where(
        and(
          eq(intents.account_id, Number(account)),
          chat === undefined ? undefined : eq(intents.chat_id, Number(chat)),
          inArray(intents.state, pending),
        ),
      )
      .run();
  }
  disconnect(account: string) {
    this.cancel(account, 'Соединение прервано');
    this.archive.db
      .update(intents)
      .set({
        state: 'unknown',
        reason: 'Результат отправки неизвестен',
        incoming: '',
        reply_text: null,
      })
      .where(
        and(
          eq(intents.account_id, Number(account)),
          inArray(intents.state, ['sending', 'pending']),
        ),
      )
      .run();
  }
  admit(value: typeof intents.$inferInsert) {
    return this.archive.db.insert(intents).values(value).onConflictDoNothing().returning().get();
  }
  get(account: string, chat: string, message: number) {
    return this.archive.db
      .select()
      .from(intents)
      .where(and(key(intents, account, chat), eq(intents.message_id, message)))
      .get();
  }
  update(row: ReplyIntent, values: Partial<typeof intents.$inferInsert>) {
    this.archive.db
      .update(intents)
      .set(values)
      .where(
        and(
          key(intents, String(row.account_id), String(row.chat_id)),
          eq(intents.message_id, row.message_id),
        ),
      )
      .run();
  }
  latest(account: string, chat: string) {
    return this.archive.db
      .select()
      .from(intents)
      .where(key(intents, account, chat))
      .orderBy(desc(intents.received_at), desc(intents.message_id))
      .limit(1)
      .get();
  }
  all(account: string) {
    return this.archive.db
      .select()
      .from(intents)
      .where(eq(intents.account_id, Number(account)))
      .orderBy(intents.received_at, intents.message_id)
      .all();
  }
  delivery(account: string, chat: number, oldId: number, sendingId?: number) {
    return this.all(account).find(
      (row) =>
        row.chat_id === chat &&
        (row.temporary_id === oldId || (sendingId !== undefined && row.sending_id === sendingId)),
    );
  }
}
