import { randomInt } from 'node:crypto';
import type { TdMessage, TdSendMessage } from '@daevox/tdlib';
import type { TelegramUpdate } from '../telegram/connection.ts';
import { abortable } from '../secretary/account-run.ts';
import { checkChat, type ReplyTelegram } from './telegram.ts';

export const configurationMessages = {
  connected: 'ИИ-секретарь: автоответчик подключён к этому чату.',
  disconnected: 'ИИ-секретарь: автоответчик отключён от этого чата.',
};

type Notice = {
  account: string;
  chat: string;
  version: number;
  sendingId: number;
  temporaryId?: number;
  completed?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

/** Explicit setting changes only. No replay or retry after an uncertain send. */
export class ConfigurationNotices {
  private readonly telegram: ReplyTelegram;
  private readonly report: (notice: Notice, reason: string) => void;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pending = new Map<number, Notice>();
  constructor(telegram: ReplyTelegram, report: (notice: Notice, reason: string) => void) {
    this.telegram = telegram;
    this.report = report;
  }
  enqueue(account: string, chat: string, enabled: boolean, version: number, signal: AbortSignal) {
    const key = `${account}:${chat}`;
    const notice: Notice = { account, chat, version, sendingId: randomInt(1, 2147483647) };
    const done = (this.queues.get(key) ?? Promise.resolve())
      .then(() => this.send(notice, enabled, signal))
      .catch(() => {
        if (!signal.aborted)
          this.report(notice, 'Не удалось отправить уведомление об изменении автоответчика');
      })
      .finally(() => {
        if (this.queues.get(key) === done) this.queues.delete(key);
      });
    this.queues.set(key, done);
  }
  private async send(notice: Notice, enabled: boolean, sessionSignal: AbortSignal) {
    sessionSignal.throwIfAborted();
    const signal = AbortSignal.any([sessionSignal, AbortSignal.timeout(30000)]);
    const available = () => {
      const state = this.telegram.snapshot();
      return (
        !signal.aborted &&
        this.telegram.replyLiveSince !== null &&
        state.authorization.kind === 'connected' &&
        state.authorization.account?.id === notice.account
      );
    };
    if (!available()) {
      this.report(notice, 'Уведомление не отправлено: нет готового подключения Telegram');
      return;
    }
    await abortable(checkChat(this.telegram, notice.account, Number(notice.chat)), signal);
    if (!available()) return;
    const request: TdSendMessage = {
      '@type': 'sendMessage',
      chat_id: Number(notice.chat),
      topic_id: null,
      reply_to: null,
      reply_markup: null,
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
        sending_id: notice.sendingId,
        only_preview: false,
      },
      input_message_content: {
        '@type': 'inputMessageText',
        text: {
          '@type': 'formattedText',
          text: enabled ? configurationMessages.connected : configurationMessages.disconnected,
          entities: [],
        },
        link_preview_options: null,
        clear_draft: false,
      },
    };
    this.pending.set(notice.sendingId, notice);
    notice.timer = setTimeout(() => {
      this.pending.delete(notice.sendingId);
      if (!sessionSignal.aborted && !notice.completed)
        this.report(
          notice,
          'Результат отправки уведомления неизвестен; автоматического повтора не будет',
        );
    }, 30000);
    notice.timer.unref();
    const sent = this.telegram.invokeRead<TdMessage>(request);
    // Keep late results correlated, without issuing another send.
    void sent
      .then((message) => {
        if (!sessionSignal.aborted) this.result(notice, message);
      })
      .catch(() => {});
    try {
      await abortable(sent, signal);
    } catch {
      clearTimeout(notice.timer);
      this.pending.delete(notice.sendingId);
      if (!sessionSignal.aborted && !notice.completed)
        this.report(
          notice,
          'Результат отправки уведомления неизвестен; автоматического повтора не будет',
        );
    }
  }
  private result(notice: Notice, message: TdMessage) {
    if (notice.completed) return;
    if (message.sending_state?.['@type'] === 'messageSendingStatePending') {
      notice.temporaryId = message.id;
      return;
    }
    notice.completed = true;
    clearTimeout(notice.timer);
    this.pending.delete(notice.sendingId);
    if (message.sending_state)
      this.report(notice, 'Telegram отклонил уведомление об изменении автоответчика');
  }
  update(account: string, update: TelegramUpdate) {
    if (
      update['@type'] === 'updateNewMessage' &&
      update.message?.sending_state?.['@type'] === 'messageSendingStatePending'
    ) {
      const notice = this.pending.get(update.message.sending_state.sending_id);
      if (notice?.account === account && Number(notice.chat) === update.message.chat_id)
        notice.temporaryId = update.message.id;
    }
    if (
      update['@type'] === 'updateMessageSendSucceeded' ||
      update['@type'] === 'updateMessageSendFailed'
    ) {
      const message = update.message;
      if (!message) return;
      const notice = [...this.pending.values()].find(
        (item) =>
          item.account === account &&
          Number(item.chat) === message.chat_id &&
          item.temporaryId === update.old_message_id,
      );
      if (notice) this.result(notice, message);
    }
  }
  reset() {
    for (const notice of this.pending.values()) clearTimeout(notice.timer);
    this.pending.clear();
  }
  async settled() {
    await Promise.allSettled(this.queues.values());
  }
}
