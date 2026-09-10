import { ConfigurationNotices } from './configuration-notices.ts';
import { randomUUID, randomInt } from 'node:crypto';
import { AutoReplyStore, type ArchiveDatabase, type ReplyIntent } from '@daevox/db';
import { TdlibError, type TdMessage } from '@daevox/tdlib';
import type { TelegramUpdate } from '../telegram/connection.ts';
import { ModelScheduler } from '../secretary/model-scheduler.ts';
import { abortable } from '../secretary/account-run.ts';
import {
  authorName,
  checkChat,
  checkMessage,
  ReplyBlocked,
  type ReplyTelegram,
} from './telegram.ts';
import {
  eligible,
  errorPhrase,
  generateReply,
  messageText,
  phrases,
  signed,
  type ReplyModelInput,
} from './content.ts';

const unsent = new Set(['queued', 'generating', 'retry']);
const open = new Set([...unsent, 'sending', 'pending']);
const versionOf = (m: TdMessage) =>
  JSON.stringify([m.content, m.topic_id, m.edit_date, m.sender_id]);
export type AutoReplyOptions = {
  now?: () => number;
  generate?: (input: ReplyModelInput, signal: AbortSignal) => Promise<string>;
  automaticTick?: boolean;
};
export class AutoReplyService {
  readonly store: AutoReplyStore;
  private readonly db: ArchiveDatabase;
  private readonly notices: ConfigurationNotices;
  private readonly telegram: ReplyTelegram;
  private readonly scheduler: ModelScheduler;
  private readonly now: () => number;
  private readonly generate: NonNullable<AutoReplyOptions['generate']>;
  private account: string | null = null;
  private epoch = '';
  private boundary: number | null = null;
  private nativeBoundary: number | null = null;
  private abort = new AbortController();
  private running?: Promise<void>;
  private lastChat: number | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private listeners: Array<() => void> = [];
  private closed = false;
  constructor(
    db: ArchiveDatabase,
    telegram: ReplyTelegram,
    scheduler: ModelScheduler,
    options: AutoReplyOptions = {},
  ) {
    this.db = db;
    this.telegram = telegram;
    this.scheduler = scheduler;
    this.now = options.now ?? Date.now;
    this.generate = options.generate ?? generateReply;
    this.store = new AutoReplyStore(db);
    this.store.recover();
    this.notices = new ConfigurationNotices(telegram, (notice, reason) =>
      this.guard(() => {
        if (this.closed || this.account !== notice.account) return;
        const setting = this.store.setting(notice.account, notice.chat);
        if (setting.version === notice.version)
          this.store.status(notice.account, notice.chat, setting.state, reason);
      }),
    );
    this.listeners = [
      telegram.onState(() => this.guard(() => this.sync())),
      telegram.onSecretaryUpdate((update) => this.guard(() => this.update(update))),
    ];
    this.sync();
    if (options.automaticTick !== false) {
      this.timer = setInterval(() => {
        void this.tick().catch(() => this.stop('Ошибка хранилища'));
      }, 1000);
      this.timer.unref();
    }
  }
  private guard(action: () => void) {
    try {
      action();
    } catch {
      // Fail closed without throwing out of TDLib's ordered update subscription.
      this.abort.abort();
      this.boundary = null;
      this.epoch = randomUUID();
      this.nativeBoundary = null;
    }
  }
  private stop(reason: string) {
    this.abort.abort();
    this.notices.reset();
    this.abort = new AbortController();
    if (this.account) {
      this.store.cancel(this.account, reason);
      this.store.disconnect(this.account);
    }
    this.epoch = randomUUID();
    this.boundary = null;
  }
  private sync() {
    if (this.closed) return;
    const state = this.telegram.snapshot();
    const next =
      state.authorization.kind === 'connected' ? (state.authorization.account?.id ?? null) : null;
    const boundary = this.telegram.replyLiveSince;
    if (
      this.account &&
      (state.authorization.kind === 'logging_out' ||
        (state.operation?.kind === 'disconnect' && state.operation.status === 'pending'))
    )
      this.store.logout(this.account);
    if (next !== this.account || boundary !== this.nativeBoundary) {
      this.stop('Период обработки завершён: связь или аккаунт изменились');
      this.account = next;
      this.nativeBoundary = boundary;
      if (next && boundary !== null) this.boundary = this.now();
    }
  }
  configure(account: string, chat: string, enabled: boolean, version: number) {
    const setting = this.store.configure(account, chat, enabled, version, this.now(), (tx) => {
      const observation = this.db.getObservation(account, chat);
      if (enabled && observation && !observation.enabled)
        this.db.setObservation(
          account,
          chat,
          true,
          observation.observationVersion,
          new Date(this.now()),
          tx,
        );
    });
    if (setting.version !== version)
      this.notices.enqueue(account, chat, enabled, setting.version, this.abort.signal);
  }
  async noticesSettled() {
    await this.notices.settled();
  }
  status(account: string, chat: string) {
    const value = this.store.setting(account, chat);
    let state = !value.enabled
      ? 'disabled'
      : this.boundary === null
        ? 'waiting_telegram'
        : value.state;
    let reason = value.reason;
    if (state === 'preparing') {
      const source = this.summary(account, chat);
      state = source.state;
      if (state === 'error') reason = 'Не удалось подготовить дневную сводку';
    }
    const last = this.store.latest(account, chat);
    return {
      enabled: !!value.enabled,
      version: value.version,
      state,
      reason,
      lastResult: last ? { state: last.state, reason: last.reason } : null,
    };
  }
  private finish(row: ReplyIntent, state: string, reason: string | null = null) {
    this.store.update(row, { state, reason, incoming: '', reply_text: null });
    if (reason)
      this.store.status(
        String(row.account_id),
        String(row.chat_id),
        state === 'unknown'
          ? 'error'
          : this.store.setting(String(row.account_id), String(row.chat_id)).state,
        reason,
      );
  }
  private valid(row: ReplyIntent) {
    const current = this.store.get(String(row.account_id), String(row.chat_id), row.message_id);
    return (
      !this.closed &&
      this.account === String(row.account_id) &&
      this.boundary !== null &&
      row.epoch === this.epoch &&
      this.now() < row.deadline &&
      current?.version === row.version &&
      unsent.has(current.state) &&
      !!this.store.setting(this.account, String(row.chat_id)).enabled &&
      this.store.setting(this.account, String(row.chat_id)).version === row.setting_version
    );
  }
  private update(update: TelegramUpdate) {
    this.sync();
    const account = this.account;
    if (!account) return;
    this.notices.update(account, update);
    if (
      update['@type'] === 'updateMessageSendSucceeded' ||
      update['@type'] === 'updateMessageSendFailed'
    ) {
      const message = update.message;
      if (!message) return;
      const row = this.store.delivery(account, message.chat_id, update.old_message_id);
      if (row) this.result(row, message);
      return;
    }
    if (update['@type'] === 'updateDeleteMessages' && update.is_permanent) {
      for (const id of update.message_ids) {
        this.db.invalidateDailySummary(account, String(update.chat_id), id);
        const row = this.store.get(account, String(update.chat_id), id);
        if (row && unsent.has(row.state))
          this.finish(row, 'cancelled', 'Исходное сообщение удалено');
        const delivery = this.store.delivery(account, update.chat_id, id);
        if (delivery && ['sending', 'pending'].includes(delivery.state))
          this.finish(delivery, 'unknown', 'Результат отправки неизвестен');
      }
      return;
    }
    if (update['@type'] === 'updateMessageContent') {
      const content = update.new_content;
      this.db.recordMessageContent(account, String(update.chat_id), update.message_id, {
        text: content?.['@type'] === 'messageText' ? (content.text?.text ?? null) : null,
        caption: content && 'caption' in content ? (content.caption?.text ?? null) : null,
        mediaType: content?.['@type'] === 'messageText' ? null : (content?.['@type'] ?? null),
      });
      const row = this.store.get(account, String(update.chat_id), update.message_id);
      if (row && unsent.has(row.state)) {
        const message: TdMessage = JSON.parse(row.incoming);
        message.content = update.new_content;
        this.store.update(row, {
          incoming: JSON.stringify(message),
          version: row.version + 1,
          state: 'queued',
          reply_text: null,
          temporary_id: null,
        });
      }
      return;
    }
    if (update['@type'] !== 'updateNewMessage' || !update.message) return;
    const message = update.message;
    if (message.sending_state?.['@type'] === 'messageSendingStatePending') {
      const row = this.store.delivery(
        account,
        message.chat_id,
        message.id,
        message.sending_state.sending_id,
      );
      if (row) this.store.update(row, { temporary_id: message.id });
    }
    const setting = this.store.setting(account, String(message.chat_id));
    if (!setting.enabled || !eligible(message, account)) return;
    if (
      this.boundary === null ||
      message.date * 1000 <= Math.max(this.boundary, setting.enabled_at)
    )
      return;
    if (this.store.get(account, String(message.chat_id), message.id)) return;
    const received = this.now();
    const row = this.store.admit({
      account_id: Number(account),
      chat_id: message.chat_id,
      message_id: message.id,
      epoch: this.epoch,
      setting_version: setting.version,
      received_at: received,
      deadline: received + 300000,
      incoming: JSON.stringify(message),
    });
    if (row && this.store.all(account).filter((item) => open.has(item.state)).length > 1000)
      this.finish(row, 'skipped', 'Очередь автоответов заполнена');
    void this.tick().catch(() => this.stop('Ошибка хранилища'));
  }
  get hasWaitingReplies() {
    return (
      !this.closed &&
      this.account !== null &&
      this.boundary !== null &&
      this.store.all(this.account).some((row) => unsent.has(row.state) && row.deadline > this.now())
    );
  }
  tick(): Promise<void> {
    this.sync();
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = undefined;
      this.scheduler.resume();
    });
    return this.running;
  }
  private async drain() {
    if (!this.account || this.boundary === null || this.closed) return;
    while (!this.closed && this.account && this.boundary !== null) {
      const rows = this.store.all(this.account);
      for (const row of rows)
        if (open.has(row.state) && row.deadline <= this.now())
          this.finish(
            row,
            ['sending', 'pending'].includes(row.state) ? 'unknown' : 'skipped',
            ['sending', 'pending'].includes(row.state)
              ? 'Результат отправки неизвестен'
              : 'Истёк срок пяти минут',
          );
      const heads = new Map<number, ReplyIntent>();
      for (const row of this.store.all(this.account))
        if (open.has(row.state) && !heads.has(row.chat_id)) heads.set(row.chat_id, row);
      const candidates = [...heads.values()].filter(
        (row) => unsent.has(row.state) && (row.retry_at ?? 0) <= this.now(),
      );
      candidates.sort((a, b) => a.chat_id - b.chat_id);
      const row =
        candidates.find(
          (candidate) => this.lastChat === null || candidate.chat_id > this.lastChat,
        ) ?? candidates[0];
      if (!row) break;
      this.lastChat = row.chat_id;
      await this.process(row);
    }
    // Recheck paused chats without admitting messages received while blocked.
    if (this.account && this.boundary !== null)
      for (const chat of this.db.listChats(this.account)) {
        const account = this.account,
          epoch = this.epoch,
          id = String(chat.chat_id);
        const setting = this.store.setting(account, id);
        if (setting.enabled && ['paused', 'waiting_telegram'].includes(setting.state)) {
          try {
            await abortable(checkChat(this.telegram, account, chat.chat_id), this.abort.signal);
            if (epoch !== this.epoch) return;
            this.store.cancel(
              account,
              'Восстановлена возможность отправки: только новые сообщения',
              id,
            );
            this.store.ready(account, id, this.now());
          } catch (error) {
            if (epoch === this.epoch && error instanceof ReplyBlocked)
              this.store.status(account, id, 'paused', error.message);
          }
        }
      }
  }
  private summary(account: string, chat: string) {
    let rows = this.db.dailySummaries(account, chat);
    const selected = rows.find((row) => row.status === 'ready' || row.source_hash !== null);
    if (selected?.status === 'ready' && selected.text && selected.message_count > 0)
      return { summary: selected.text, state: 'working' };
    if (selected?.status === 'error') return { phrase: phrases.error, state: 'error' };
    if (selected && ['queued', 'running'].includes(selected.status))
      return this.db.dailySummaryMessages(account, chat, selected.day, selected.utc_offset_minutes)
        .length
        ? { phrase: phrases.preparing, state: 'preparing' }
        : { phrase: phrases.empty, state: 'insufficient_data' };
    this.db.enqueueDailySummaries(account, chat, 0, 300, true);
    rows = this.db.dailySummaries(account, chat);
    const latest = rows[0];
    if (!latest || (latest.status === 'ready' && !latest.message_count))
      return { phrase: phrases.empty, state: 'insufficient_data' };
    return {
      phrase: latest.status === 'error' ? phrases.error : phrases.preparing,
      state: latest.status === 'error' ? 'error' : 'preparing',
    };
  }
  private async process(row: ReplyIntent) {
    if (!this.valid(row)) {
      if (unsent.has(row.state)) this.finish(row, 'cancelled', 'Период обработки завершён');
      return;
    }
    const account = String(row.account_id),
      chat = String(row.chat_id);
    if (this.store.setting(account, chat).state === 'paused') {
      this.finish(row, 'skipped', 'Отправка приостановлена');
      return;
    }
    const signal = AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(Math.max(1, row.deadline - this.now())),
    ]);
    const read = <T>(request: Parameters<ReplyTelegram['invokeRead']>[0]) =>
      abortable(this.telegram.invokeRead<T>(request), signal);
    try {
      this.store.update(row, { state: 'generating' });
      await abortable(checkChat(this.telegram, account, row.chat_id), signal);
      const incoming = await read<TdMessage>({
        '@type': 'getMessage',
        chat_id: row.chat_id,
        message_id: row.message_id,
      });
      if (!eligible(incoming, account))
        throw new ReplyBlocked('Сообщение больше не подходит для автоответа');
      const stored: TdMessage = JSON.parse(row.incoming);
      if (versionOf(incoming) !== versionOf(stored)) {
        if (this.valid(row))
          this.store.update(row, {
            state: 'queued',
            incoming: JSON.stringify(incoming),
            version: row.version + 1,
            reply_text: null,
            temporary_id: null,
          });
        return;
      }
      await abortable(checkMessage(this.telegram, incoming), signal);
      const name = await abortable(authorName(this.telegram, incoming), signal);
      const option = await read<{ value: string }>({
        '@type': 'getOption',
        name: 'message_text_length_max',
      });
      const limit = Math.min(3000, Number(option.value));
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new ReplyBlocked('Не удалось определить лимит длины Telegram');
      const text = messageText(incoming);
      const source = text.trim()
        ? this.summary(account, chat)
        : { phrase: phrases.text, state: 'working' };
      this.store.status(
        account,
        chat,
        source.state,
        source.state === 'error' ? 'Не удалось подготовить сводку' : null,
      );
      let body: string;
      if (row.reply_text) {
        if (row.reply_text.length > limit) throw new ReplyBlocked('Лимит Telegram уменьшился');
        body = row.reply_text;
      } else {
        try {
          // Empty/ambiguous input uses Russian; Russian service phrases need no model call.
          const phrase = source.phrase;
          body =
            phrase &&
            (!text.trim() ||
              (/[а-яё]/i.test(text) && !/[іїєґәғқңөұүһ]/iu.test(text)) ||
              !/\p{L}/u.test(text))
              ? phrase
              : await this.scheduler.run('reply', signal, () =>
                  this.generate({ incoming: text, ...source }, signal),
                );
        } catch (error) {
          if (signal.aborted) throw error;
          body = errorPhrase(text);
          this.store.status(account, chat, 'error', 'Не удалось сгенерировать ответ');
        }
        body = signed(body, name, limit);
      }
      // Reread the source and all send conditions after generation. No async gap after final admission.
      await abortable(checkChat(this.telegram, account, row.chat_id), signal);
      await abortable(checkMessage(this.telegram, incoming), signal);
      const fresh = await read<TdMessage>({
        '@type': 'getMessage',
        chat_id: row.chat_id,
        message_id: row.message_id,
      });
      if (!this.valid(row)) return;
      if (versionOf(fresh) !== versionOf(incoming)) {
        this.store.update(row, {
          state: 'queued',
          incoming: JSON.stringify(fresh),
          version: row.version + 1,
          reply_text: null,
          temporary_id: null,
        });
        return;
      }
      if (source.summary && this.summary(account, chat).summary !== source.summary) {
        this.store.update(row, { state: 'queued', reply_text: null });
        return;
      }
      const sendingId = randomInt(1, 2147483647);
      this.store.update(row, { state: 'sending', sending_id: sendingId, reply_text: body });
      let result: TdMessage;
      const send = <T>(
        request: Parameters<ReplyTelegram['invokeRead']>[0],
        extract: (value: T) => TdMessage | null,
      ) => {
        const requestResult = this.telegram.invokeRead<T>(request);
        void requestResult
          .then((value) => {
            if (!this.closed) {
              const message = extract(value);
              if (message) this.result(row, message);
            }
          })
          .catch(() => {});
        return abortable(requestResult, signal);
      };
      try {
        if (row.temporary_id) {
          const resent = await send<{ messages: Array<TdMessage | null> }>(
            {
              '@type': 'resendMessages',
              chat_id: row.chat_id,
              message_ids: [row.temporary_id],
              quote: null,
              paid_message_star_count: 0,
            },
            (value) => value.messages[0],
          );
          if (!resent.messages[0]) throw new Error('UNKNOWN');
          result = resent.messages[0];
        } else
          result = await send<TdMessage>(
            {
              '@type': 'sendMessage',
              chat_id: row.chat_id,
              topic_id: incoming.topic_id ?? null,
              reply_to: {
                '@type': 'inputMessageReplyToMessage',
                message_id: row.message_id,
                quote: null,
                checklist_task_id: 0,
                poll_option_id: '',
              },
              options: {
                '@type': 'messageSendOptions',
                suggested_post_info: null,
                disable_notification: false,
                from_background: true,
                protect_content: false,
                allow_paid_broadcast: false,
                paid_message_star_count: 0,
                update_order_of_installed_sticker_sets: false,
                scheduling_state: null,
                effect_id: 0,
                sending_id: sendingId,
                only_preview: false,
              },
              reply_markup: null,
              input_message_content: {
                '@type': 'inputMessageText',
                text: { '@type': 'formattedText', text: body, entities: [] },
                link_preview_options: {
                  '@type': 'linkPreviewOptions',
                  is_disabled: true,
                  url: '',
                  force_small_media: false,
                  force_large_media: false,
                  show_above_text: false,
                },
                clear_draft: false,
              },
            },
            (value) => value,
          );
      } catch (error) {
        const seconds =
          error instanceof TdlibError && error.code === 429
            ? /(?:retry after |FLOOD_WAIT_)(\d+)/.exec(error.message)?.[1]
            : null;
        if (
          seconds &&
          this.epoch === row.epoch &&
          this.store.setting(account, chat).version === row.setting_version &&
          this.store.setting(account, chat).enabled &&
          this.now() + Number(seconds) * 1000 < row.deadline
        )
          this.store.update(row, { state: 'retry', retry_at: this.now() + Number(seconds) * 1000 });
        else
          this.finish(
            row,
            error instanceof TdlibError && error.code < 500 ? 'failed' : 'unknown',
            error instanceof TdlibError && error.code < 500
              ? 'Telegram отклонил отправку'
              : 'Результат отправки неизвестен',
          );
        if (
          error instanceof TdlibError &&
          (error.code === 403 || /PAYMENT|PAID_MESSAGE|SEND_AS/.test(error.message))
        ) {
          this.store.cancel(
            account,
            'Telegram запретил отправку от личного аккаунта без оплаты',
            chat,
          );
          this.store.status(
            account,
            chat,
            'paused',
            'Telegram запретил отправку от личного аккаунта без оплаты',
          );
        }
        return;
      }
      this.result(row, result);
    } catch (error) {
      if (!this.valid(row)) {
        const latest = this.store.get(account, chat, row.message_id);
        if (latest && unsent.has(latest.state) && latest.version === row.version)
          this.finish(
            row,
            'skipped',
            this.now() >= row.deadline ? 'Истёк срок пяти минут' : 'Обработка отменена',
          );
        return;
      }
      this.finish(
        row,
        'skipped',
        error instanceof ReplyBlocked ? error.message : 'Не удалось проверить возможность Reply',
      );
      if (error instanceof ReplyBlocked && error.pause) {
        this.store.cancel(account, error.message, chat);
        this.store.status(account, chat, 'paused', error.message);
      }
    }
  }
  private result(row: ReplyIntent, message: TdMessage) {
    const current = this.store.get(String(row.account_id), String(row.chat_id), row.message_id);
    if (!current || ['succeeded', 'failed'].includes(current.state)) return;
    const state = message.sending_state;
    if (!state) {
      this.store.update(row, { final_id: message.id });
      this.finish(row, 'succeeded');
    } else if (state['@type'] === 'messageSendingStatePending') {
      this.store.update(row, {
        temporary_id: message.id,
        state: current.state === 'unknown' ? 'unknown' : 'pending',
      });
    } else {
      this.store.update(row, { temporary_id: message.id });
      const retryAt = this.now() + Math.max(1, state.retry_after) * 1000;
      if (
        state.can_retry &&
        !state.need_another_sender &&
        !state.need_another_reply_quote &&
        !state.need_drop_reply &&
        !state.required_paid_message_star_count &&
        this.epoch === row.epoch &&
        retryAt < row.deadline &&
        this.store.setting(String(row.account_id), String(row.chat_id)).enabled &&
        this.store.setting(String(row.account_id), String(row.chat_id)).version ===
          row.setting_version &&
        current.state !== 'unknown'
      )
        this.store.update(row, { state: 'retry', retry_at: retryAt });
      else this.finish(row, 'failed', 'Telegram отклонил отправку; безопасный повтор недоступен');
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.listeners) unsubscribe();
    if (this.timer) clearInterval(this.timer);
    this.stop('Приложение остановлено');
    await Promise.all([this.running, this.notices.settled()]);
  }
}
