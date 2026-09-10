import type { ArchiveDatabase } from '@daevox/db';
import type { TdChat, TdUser } from '@daevox/tdlib';
import type { TelegramConnection } from '../telegram/connection.ts';
import { abortable, type AccountRun } from './account-run.ts';

export class AuthorResolver {
  private readonly shutdown = new AbortController();
  private readonly jobs = new Map<AccountRun, Promise<void>>();
  private readonly telegram: TelegramConnection;
  private readonly db: ArchiveDatabase;
  private readonly changed: (run: AccountRun) => void;
  constructor(
    telegram: TelegramConnection,
    db: ArchiveDatabase,
    changed: (run: AccountRun) => void,
  ) {
    this.telegram = telegram;
    this.db = db;
    this.changed = changed;
  }
  resolve(run: AccountRun): Promise<void> {
    if (this.shutdown.signal.aborted || run.signal.aborted) return Promise.resolve();
    const existing = this.jobs.get(run);
    if (existing) return existing;
    const signal = AbortSignal.any([run.signal, this.shutdown.signal]);
    const job = this.resolveOnce(run, signal).finally(() => this.jobs.delete(run));
    this.jobs.set(run, job);
    return job;
  }
  async close() {
    this.shutdown.abort();
    await Promise.allSettled(this.jobs.values());
  }
  private async resolveOnce(run: AccountRun, signal: AbortSignal) {
    const { accountId } = run;
    for (const author of this.db.unresolvedAuthors(accountId)) {
      if (signal.aborted) return;
      try {
        let name: string,
          username: string | null = null;
        if (author.kind === 'user') {
          const user = await abortable(
            this.telegram.invokeRead<TdUser>({
              '@type': 'getUser',
              user_id: author.id!,
            } as never),
            signal,
          );
          username = user.usernames?.active_usernames[0] || null;
          name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Удалённый аккаунт';
        } else {
          const chat = await abortable(
            this.telegram.invokeRead<TdChat>({
              '@type': 'getChat',
              chat_id: author.id!,
            } as never),
            signal,
          );
          name = chat.title || 'Канал';
        }
        if (signal.aborted) return;
        this.db.saveAuthor(accountId, author.kind!, author.id!, name, username);
        this.changed(run);
      } catch {
        /* Retry unavailable Telegram profiles on the next refresh. */
      }
    }
  }
}
