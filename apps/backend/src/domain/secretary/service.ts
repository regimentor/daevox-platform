import { randomUUID } from 'node:crypto';
import { ArchiveDatabase, databaseUrl, type ArchiveMessage } from '@daevox/db';
import type {
  SecretaryChat,
  SecretaryChatsPage,
  SecretaryContext,
  SecretarySnapshot,
  SecretaryChatUpdate,
  SecretaryHistoryPage,
} from '@daevox/telegram-contract/secretary';
import { TelegramConnection, type TelegramUpdate } from '../telegram/connection.ts';
import { ChatSummarizer } from './summarizer.ts';
import { retryBusy } from './retry-busy.ts';
import { archiveMessage, deletedMessage } from './archive-message.ts';
import { abortable, type AccountRun } from './account-run.ts';
import { ChatCatalog, type StoredChat } from './chat-catalog.ts';
import { HistoryImporter } from './history-importer.ts';
import { AutoReplyService } from '../auto-reply/service.ts';
import { ModelScheduler } from './model-scheduler.ts';
import { AuthorResolver } from './author-resolver.ts';

export class SecretaryService {
  readonly instanceId = randomUUID();
  private readonly db: ArchiveDatabase;
  private readonly catalog: ChatCatalog;
  private readonly importer: HistoryImporter;
  private readonly authors: AuthorResolver;
  private accountAbort = new AbortController();
  private run: AccountRun | null = null;
  private closing?: Promise<void>;
  private readonly pending = new Set<Promise<void>>();
  private readonly updateErrors = new Map<string, SecretaryChatUpdate>();
  private revision = 0;
  private accountEpoch = 0;
  private accountId: string | null = null;
  private storage: SecretarySnapshot['storage'] = 'initializing';
  private error: SecretarySnapshot['error'] = null;
  private unlisten?: () => void;
  private unlistenState?: () => void;
  private readonly telegram: TelegramConnection;
  private summarizer?: ChatSummarizer;
  readonly modelScheduler = new ModelScheduler(() => !this.autoReply?.hasWaitingReplies);
  private autoReply?: AutoReplyService;
  private readonly archiveUrl: string;
  private closed = false;
  private active(run: AccountRun) {
    return !this.closed && this.run === run && !run.signal.aborted;
  }
  private changed = (run: AccountRun) => {
    if (this.active(run)) this.revision++;
  };
  private background(run: AccountRun, action: () => void | Promise<void>) {
    const done = abortable(
      retryBusy(action, () => this.active(run)),
      run.signal,
    )
      .catch(() => {
        if (this.active(run)) {
          this.error = {
            code: 'storage_error',
            message: 'Не удалось обновить архив. Повторим при следующем обновлении.',
          };
          this.revision++;
        }
      })
      .finally(() => this.pending.delete(done));
    this.pending.add(done);
  }
  private syncAccount() {
    if (this.closed) return;
    const snapshot = this.telegram.snapshot();
    const next =
      snapshot.authorization.kind === 'connected'
        ? (snapshot.authorization.account?.id ?? null)
        : null;
    if (next === this.accountId) return;
    this.accountAbort.abort();
    this.accountAbort = new AbortController();
    this.accountId = next;
    this.accountEpoch++;
    this.run = next
      ? { accountId: next, accountEpoch: this.accountEpoch, signal: this.accountAbort.signal }
      : null;
    this.catalog.reset();
    this.updateErrors.clear();
    this.revision++;
  }
  constructor(telegram: TelegramConnection, path = databaseUrl()) {
    this.telegram = telegram;
    this.archiveUrl = path;
    let opened: ArchiveDatabase | undefined;
    try {
      this.db = opened = new ArchiveDatabase(path);
      this.autoReply = new AutoReplyService(this.db, telegram, this.modelScheduler);
      this.storage = 'ready';
    } catch {
      opened?.close();
      this.db = undefined as never;
      this.storage = 'error';
      this.error = { code: 'storage_error', message: 'Локальный архив недоступен.' };
    }
    this.catalog = new ChatCatalog(telegram, this.db, this.changed);
    this.authors = new AuthorResolver(telegram, this.db, this.changed);
    this.importer = new HistoryImporter(telegram, this.db, this.changed, (run, chatId, since) => {
      if (this.active(run)) this.queueDailySummaries(run, chatId, since);
    });
  }
  start() {
    if (this.closed || this.unlisten) return;
    this.unlisten = this.telegram.onSecretaryUpdate((update) => {
      const run = this.run;
      if (run) this.background(run, () => this.update(run, update));
    });
    this.unlistenState = this.telegram.onState(() => {
      this.syncAccount();
      this.scheduleRefresh();
    });
    this.syncAccount();
    this.scheduleRefresh();
  }
  private scheduleRefresh() {
    const run = this.run;
    if (run) this.background(run, () => this.refresh());
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.unlisten?.();
    this.unlistenState?.();
    this.accountAbort.abort();
    this.closing = (async () => {
      await Promise.all([
        this.importer.close(),
        this.catalog.close(),
        this.authors.close(),
        this.summarizer?.close(),
        this.autoReply?.close(),
        ...this.pending,
      ]);
      if (this.storage === 'ready') this.db.close();
    })();
    return this.closing;
  }
  private context(): SecretaryContext {
    return {
      instanceId: this.instanceId,
      accountId: this.accountId,
      accountEpoch: this.accountEpoch,
      revision: this.revision,
    };
  }
  snapshot(): SecretarySnapshot {
    const values =
      this.accountId && this.storage === 'ready' ? this.db.listChats(this.accountId) : [];
    return {
      context: this.context(),
      storage: this.storage,
      catalog: {
        status: this.catalog.values().length ? 'ready' : 'loading',
        revision: this.revision,
        knownCount: this.catalog.values().length,
      },
      observed:
        this.accountId && this.storage === 'ready'
          ? {
              enabled: values.filter((v) => Boolean(v.enabled)).length,
              collecting: values.filter(
                (v) => v.state === 'catching_up' || v.state === 'collecting',
              ).length,
              gaps: values.filter((v) => Boolean(v.has_gaps)).length,
            }
          : null,
      error: this.error,
    };
  }
  private row(value: StoredChat): SecretaryChat {
    const id = String(value.chat.id);
    const observation = this.db.getObservation(this.accountId!, id)!;
    const lastUpdate = this.updateErrors.get(id) ?? this.db.lastUpdate(this.accountId!, id);
    const history = this.db.historyImport(this.accountId!, id);
    return {
      id,
      title: value.chat.title,
      type: value.type,
      username: null,
      archived: value.archived,
      available: true,
      enabled: observation.enabled,
      autoReply: this.autoReply!.status(this.accountId!, id),
      observationVersion: observation.observationVersion,
      collection: observation.state as SecretaryChat['collection'],
      completeness: {
        hasGaps: observation.hasGaps,
        protectedContentSkipped: observation.protectedContentSkipped,
        approximateBoundary: true,
      },
      reason: observation.reason,
      lastAttemptAt: lastUpdate?.processedAt ?? null,
      lastSuccessAt: this.db.lastUpdate(this.accountId!, id)?.processedAt ?? null,
      nextAttemptAt: null,
      lastUpdate,
      historyImport: history
        ? {
            status: history.status as 'loading' | 'ready' | 'error',
            since: history.since,
            processed: history.processed,
            error: history.error,
          }
        : null,
    };
  }
  history(
    accountId: string,
    chatId: string,
    latest: boolean,
    before: string | null,
    limit = 50,
  ): SecretaryHistoryPage {
    if (this.storage !== 'ready') throw Object.assign(new Error('STORAGE'), { code: 'storage' });
    if (accountId !== this.accountId) throw Object.assign(new Error('STALE'), { code: 'stale' });
    if (!this.db.getObservation(accountId, chatId))
      throw Object.assign(new Error('NOT_FOUND'), { code: 'not_found' });
    const lastUpdate = this.updateErrors.get(chatId) ?? this.db.lastUpdate(accountId, chatId);
    return {
      context: this.context(),
      lastUpdate,
      ...(latest && (!lastUpdate || lastUpdate.status === 'error')
        ? { messages: [], nextCursor: null }
        : this.db.history(accountId, chatId, latest ? lastUpdate!.id : null, before, limit)),
    };
  }
  summary(accountId: string, chatId: string, scope: 'latest' | 'all', start = false) {
    if (this.storage !== 'ready') throw Object.assign(new Error('STORAGE'), { code: 'storage' });
    if (accountId !== this.accountId) throw Object.assign(new Error('STALE'), { code: 'stale' });
    if (!this.db.getObservation(accountId, chatId))
      throw Object.assign(new Error('NOT_FOUND'), { code: 'not_found' });
    this.summarizer ??= new ChatSummarizer(this.db, {}, this.modelScheduler);
    return {
      context: this.context(),
      summary: start
        ? this.summarizer.start(accountId, chatId, scope)
        : this.summarizer.get(accountId, chatId, scope),
    };
  }
  dailySummary(
    accountId: string,
    chatId: string,
    retryDay?: string,
    pagination?: { before: string | null; limit: number },
  ) {
    if (this.storage !== 'ready') throw Object.assign(new Error('STORAGE'), { code: 'storage' });
    if (accountId !== this.accountId) throw Object.assign(new Error('STALE'), { code: 'stale' });
    if (!this.db.getObservation(accountId, chatId))
      throw Object.assign(new Error('NOT_FOUND'), { code: 'not_found' });
    if (retryDay) {
      const job = this.db.dailySummaries(accountId, chatId).find((row) => row.day === retryDay);
      if (!job) throw Object.assign(new Error('NOT_FOUND'), { code: 'not_found' });
      if (job.status !== 'running')
        this.db.updateDailySummary(accountId, chatId, retryDay, {
          status: 'queued',
          error: null,
          text: null,
        });
    }
    return {
      context: this.context(),
      ...(pagination
        ? this.db.dailySummariesPage(accountId, chatId, pagination.before, pagination.limit)
        : { summaries: this.db.dailySummaries(accountId, chatId) }),
    };
  }
  private queueDailySummaries(run: AccountRun, chatId: string, since: number) {
    this.db.enqueueDailySummaries(run.accountId, chatId, since);
    this.background(run, () => this.authors.resolve(run));
  }
  private saveUpdate(chatId: string, messages: ArchiveMessage[]) {
    try {
      this.db.saveMessages(messages);
      this.updateErrors.delete(chatId);
    } catch {
      this.updateErrors.set(chatId, {
        id: randomUUID(),
        processedAt: new Date().toISOString(),
        status: 'error',
        saved: 0,
        skipped: 0,
        deleted: 0,
      });
    }
    this.revision++;
  }
  chatsPage(
    q = '',
    filter: 'all' | 'observed' | 'archived' = 'all',
    limit = 50,
  ): SecretaryChatsPage {
    const normalized = q.trim().toLocaleLowerCase();
    let rows: StoredChat[] = [...this.catalog.values()].filter((v: StoredChat) => {
      const item = this.row(v);
      return (
        (!normalized || item.title.toLocaleLowerCase().includes(normalized) || item.id === q) &&
        (filter === 'all' || (filter === 'observed' ? item.enabled : item.archived))
      );
    });
    rows.sort(
      (a: StoredChat, b: StoredChat) =>
        a.chat.title.localeCompare(b.chat.title) || a.chat.id - b.chat.id,
    );
    rows = rows.slice(0, Math.min(100, Math.max(1, limit)));
    return {
      context: this.context(),
      catalog: this.snapshot().catalog,
      chats: rows.map((v: StoredChat) => this.row(v)),
      observedChats: [...this.catalog.values()]
        .map((v) => this.row(v))
        .filter((chat) => chat.enabled),
      totalKnown: rows.length,
      nextCursor: null,
    };
  }
  setAutoReply(
    accountId: string,
    chatId: string,
    enabled: boolean,
    expected: { instanceId: string; accountEpoch: number; autoReplyVersion: number },
  ) {
    this.assertContext(accountId, { ...expected, observationVersion: 0 });
    const value = this.catalog.get(chatId);
    const observation = this.db.getObservation(accountId, chatId);
    if (!value || !observation) throw Object.assign(new Error('NOT_FOUND'), { code: 'not_found' });
    this.autoReply!.configure(accountId, chatId, enabled, expected.autoReplyVersion);
    const current = this.db.getObservation(accountId, chatId)!;
    if (current.enabled) this.importer.ensure(this.run!, chatId, current.observationVersion);
    this.revision++;
    return this.row(value);
  }
  setObservation(
    accountId: string,
    chatId: string,
    enabled: boolean,
    expected: { instanceId: string; accountEpoch: number; observationVersion: number },
  ) {
    this.assertContext(accountId, expected);
    const result = this.db.setObservation(accountId, chatId, enabled, expected.observationVersion);
    if (!result) throw Object.assign(new Error('NOT_FOUND'), { code: 'not_found' });
    this.revision++;
    if (enabled) this.importer.ensure(this.run!, chatId, result.observationVersion);
    else this.importer.cancel(chatId);
    return this.row(this.catalog.get(chatId)!);
  }
  resume(
    accountId: string,
    chatId: string,
    expected: { instanceId: string; accountEpoch: number; observationVersion: number },
  ) {
    this.assertContext(accountId, expected);
    const current = this.db.getObservation(accountId, chatId);
    if (!current) throw Object.assign(new Error('NOT_FOUND'), { code: 'not_found' });
    this.db.setObservation(accountId, chatId, true, expected.observationVersion);
    this.revision++;
    this.importer.retry(
      this.run!,
      chatId,
      this.db.getObservation(accountId, chatId)!.observationVersion,
    );
    return this.row(this.catalog.get(chatId)!);
  }
  private assertContext(
    accountId: string,
    expected: { instanceId: string; accountEpoch: number; observationVersion: number },
  ) {
    if (this.storage !== 'ready') throw Object.assign(new Error('STORAGE'), { code: 'storage' });
    if (
      this.accountId !== accountId ||
      expected.instanceId !== this.instanceId ||
      expected.accountEpoch !== this.accountEpoch
    )
      throw Object.assign(new Error('STALE'), { code: 'stale' });
  }
  get summaryDatabaseUrl(): string | null {
    return !this.closed && this.storage === 'ready' ? this.archiveUrl : null;
  }
  async refresh(signal?: AbortSignal) {
    if (this.closed || signal?.aborted) return;
    this.syncAccount();
    const run = this.run;
    if (!run || this.storage !== 'ready') return;
    const refreshSignal = signal ? AbortSignal.any([run.signal, signal]) : run.signal;
    try {
      await abortable(
        retryBusy(
          () => {
            if (!this.active(run)) return;
            this.background(run, () => this.authors.resolve(run));
            for (const row of this.db.listChats(run.accountId))
              if (row.enabled)
                this.importer.ensure(run, String(row.chat_id), row.observation_version);
            return this.catalog.refresh(run, signal);
          },
          () => this.active(run) && !refreshSignal.aborted,
        ),
        refreshSignal,
      );
    } catch (error) {
      if (!refreshSignal.aborted) throw error;
    }
  }
  private update(run: AccountRun, update: TelegramUpdate) {
    if (!this.active(run) || this.storage !== 'ready') return;
    if (update['@type'] === 'updateNewChat' && update.chat) {
      this.catalog.accept(run, update.chat);
    }
    if (update['@type'] === 'updateNewMessage' && update.message) {
      const message = update.message;
      const observation = this.db.getObservation(run.accountId, String(message.chat_id));
      if (!observation?.enabled) return;
      this.saveUpdate(String(message.chat_id), [archiveMessage(run.accountId, message)]);
      this.background(run, () => this.authors.resolve(run));
    }
    if (update['@type'] === 'updateMessageContent') {
      const chatId = String(update.chat_id);
      const known = this.db.client
        .prepare('SELECT 1 FROM messages WHERE account_id = ? AND chat_id = ? AND message_id = ?')
        .get(Number(run.accountId), update.chat_id, update.message_id);
      if (known)
        this.background(run, async () => {
          const message = await abortable(
            this.telegram.invokeRead<import('@daevox/tdlib').TdMessage>({
              '@type': 'getMessage',
              chat_id: update.chat_id,
              message_id: update.message_id,
            }),
            run.signal,
          );
          if (this.active(run)) this.saveUpdate(chatId, [archiveMessage(run.accountId, message)]);
        });
    }
    if (update['@type'] === 'updateDeleteMessages' && update.is_permanent) {
      if (!this.db.getObservation(run.accountId, String(update.chat_id))) return;
      this.saveUpdate(
        String(update.chat_id),
        update.message_ids.map((messageId) =>
          deletedMessage(run.accountId, String(update.chat_id), messageId),
        ),
      );
    }
  }
}
