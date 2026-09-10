import type { ArchiveDatabase } from '@daevox/db';
import type { TdMessage } from '@daevox/tdlib';
import type { TelegramConnection } from '../telegram/connection.ts';
import { abortable, type AccountRun } from './account-run.ts';
import { archiveMessage } from './archive-message.ts';

export class HistoryImporter {
  private readonly shutdown = new AbortController();
  private readonly jobs = new Map<
    string,
    { run: AccountRun; version: number; abort: AbortController; done: Promise<void> }
  >();
  private readonly pending = new Set<Promise<void>>();
  private readonly retryAt = new Map<string, number>();
  private readonly telegram: TelegramConnection;
  private readonly db: ArchiveDatabase;
  private readonly changed: (run: AccountRun) => void;
  private readonly completed: (run: AccountRun, chatId: string, since: number) => void;
  constructor(
    telegram: TelegramConnection,
    db: ArchiveDatabase,
    changed: (run: AccountRun) => void,
    completed: (run: AccountRun, chatId: string, since: number) => void,
  ) {
    this.telegram = telegram;
    this.db = db;
    this.changed = changed;
    this.completed = completed;
  }
  ensure(run: AccountRun, chatId: string, version: number) {
    if (this.shutdown.signal.aborted || run.signal.aborted) return;
    const previous = this.jobs.get(chatId);
    if (
      previous &&
      previous.run === run &&
      previous.version === version &&
      !previous.abort.signal.aborted
    )
      return;
    this.cancel(chatId);
    const { accountId } = run;
    const retryKey = `${accountId}:${chatId}`;
    if ((this.retryAt.get(retryKey) ?? 0) > Date.now()) return;
    const abort = new AbortController();
    const signal = AbortSignal.any([run.signal, abort.signal, this.shutdown.signal]);
    const valid = () => {
      if (signal.aborted) return false;
      const observation = this.db.getObservation(accountId, chatId);
      return observation?.enabled && observation.observationVersion === version;
    };
    if (!valid()) return;
    const progress = this.db.beginHistoryImport(accountId, chatId, version);
    if (progress.status === 'ready') {
      this.completed(run, chatId, progress.since);
      return;
    }
    const done = (async () => {
      let cursor = progress.cursor;
      try {
        while (valid()) {
          const page = await abortable(
            this.telegram.invokeRead<{ messages: TdMessage[] }>({
              '@type': 'getChatHistory',
              chat_id: Number(chatId),
              from_message_id: cursor,
              offset: 0,
              limit: 100,
              only_local: false,
            } as never),
            signal,
          );
          if (!valid()) return;
          if (!Array.isArray(page.messages)) throw new Error('Invalid history page');
          const older = page.messages.filter(
            (message) => message.chat_id === Number(chatId) && (!cursor || message.id < cursor),
          );
          const complete =
            !page.messages.length || older.some((message) => message.date < progress.since);
          if (page.messages.length && !older.length)
            throw new Error('History cursor did not advance');
          const batch = older
            .filter((message) => message.date >= progress.since)
            .map((message) => archiveMessage(accountId, message));
          const nextCursor = older.length
            ? Math.min(...older.map((message) => message.id))
            : cursor;
          this.db.saveHistoryPage(accountId, chatId, batch, nextCursor, complete);
          this.changed(run);
          if (complete) {
            this.completed(run, chatId, progress.since);
            return;
          }
          cursor = nextCursor;
        }
      } catch {
        if (valid()) {
          this.db.failHistoryImport(accountId, chatId);
          this.retryAt.set(retryKey, Date.now() + 60000);
          this.changed(run);
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        this.pending.delete(done);
        if (this.jobs.get(chatId)?.done === done) this.jobs.delete(chatId);
      });
    this.jobs.set(chatId, { run, version, abort, done });
    this.pending.add(done);
  }
  retry(run: AccountRun, chatId: string, version: number) {
    this.retryAt.delete(`${run.accountId}:${chatId}`);
    this.ensure(run, chatId, version);
  }
  cancel(chatId: string) {
    this.jobs.get(chatId)?.abort.abort();
  }
  async close() {
    this.shutdown.abort();
    await Promise.allSettled(this.pending);
  }
}
