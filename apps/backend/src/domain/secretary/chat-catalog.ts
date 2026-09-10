import type { ArchiveDatabase } from '@daevox/db';
import type { TdChat } from '@daevox/tdlib';
import type { TelegramConnection } from '../telegram/connection.ts';
import { abortable, type AccountRun } from './account-run.ts';

export type StoredChat = {
  chat: TdChat;
  archived: boolean;
  type: 'private' | 'basic_group' | 'supergroup';
};
function chatType(chat: TdChat): 'private' | 'basic_group' | 'supergroup' | null {
  if (chat.type?.['@type'] === 'chatTypePrivate') return 'private';
  if (chat.type?.['@type'] === 'chatTypeBasicGroup') return 'basic_group';
  if (chat.type?.['@type'] === 'chatTypeSupergroup' && !chat.type.is_channel) return 'supergroup';
  return null;
}

export class ChatCatalog {
  private readonly chats = new Map<string, StoredChat>();
  private readonly shutdown = new AbortController();
  private readonly jobs = new Map<AccountRun, { signal: AbortSignal; done: Promise<void> }>();
  private readonly pending = new Set<Promise<void>>();
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
  get(chatId: string) {
    return this.chats.get(chatId);
  }
  values() {
    return [...this.chats.values()];
  }
  reset() {
    this.chats.clear();
  }
  accept(run: AccountRun, chat: TdChat) {
    if (run.signal.aborted || this.shutdown.signal.aborted) return;
    if (this.store(run, chat, false, false)) this.changed(run);
  }
  private store(run: AccountRun, chat: TdChat, archived: boolean, persistArchived = true) {
    const type = chatType(chat);
    if (!type) return false;
    this.db.upsertChat(run.accountId, {
      id: String(chat.id),
      title: chat.title,
      type,
      ...(persistArchived ? { archived } : {}),
    });
    this.chats.set(String(chat.id), { chat, archived, type });
    return true;
  }
  refresh(run: AccountRun, externalSignal?: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([
      run.signal,
      this.shutdown.signal,
      ...(externalSignal ? [externalSignal] : []),
    ]);
    if (signal.aborted) return Promise.resolve();
    const existing = this.jobs.get(run);
    if (existing && !existing.signal.aborted) return existing.done;
    const done = this.refreshOnce(run, signal).finally(() => {
      this.pending.delete(done);
      if (this.jobs.get(run)?.done === done) this.jobs.delete(run);
    });
    this.jobs.set(run, { signal, done });
    this.pending.add(done);
    return done;
  }
  async close() {
    this.shutdown.abort();
    await Promise.allSettled(this.pending);
  }
  private async refreshOnce(run: AccountRun, signal: AbortSignal) {
    try {
      // getChats only returns the part already present in TDLib's local catalog.
      // Ask TDLib to extend both lists first, so the normal page is useful without
      // requiring the user to search for each chat individually.
      for (const chatList of [{ '@type': 'chatListMain' }, { '@type': 'chatListArchive' }]) {
        for (let page = 0; page < 100 && !signal.aborted; page++) {
          if (signal.aborted) return;
          try {
            await abortable(
              this.telegram.invokeRead({
                '@type': 'loadChats',
                chat_list: chatList,
                limit: 100,
              } as never),
              signal,
            );
          } catch {
            break;
          }
        }
        if (signal.aborted) return;
        const lists = await abortable(
          this.telegram.invokeRead<{ chat_ids: number[] }>({
            '@type': 'getChats',
            chat_list: chatList,
            limit: 2147483647,
          } as never),
          signal,
        );
        if (signal.aborted) return;
        for (const chatId of lists.chat_ids) {
          if (signal.aborted) return;
          const chat = await abortable(
            this.telegram.invokeRead<TdChat>({
              '@type': 'getChat',
              chat_id: chatId,
            } as never),
            signal,
          );
          if (signal.aborted) return;
          this.store(
            run,
            chat,
            chat.positions.some((p) => p.list?.['@type'] === 'chatListArchive'),
          );
        }
      }
      this.changed(run);
    } catch {
      /* Telegram may be offline; the last catalog remains usable. */
    }
  }
}
