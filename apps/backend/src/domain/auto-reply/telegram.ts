import type { TdChat, TdMessage, TdUser, TdSupergroup } from '@daevox/tdlib';
import type { TelegramConnection } from '../telegram/connection.ts';
export type ReplyTelegram = Pick<
  TelegramConnection,
  'snapshot' | 'onState' | 'onSecretaryUpdate' | 'replyLiveSince' | 'invokeRead'
>;
export class ReplyBlocked extends Error {
  readonly pause: boolean;
  constructor(message: string, pause = false) {
    super(message);
    this.pause = pause;
  }
}
export async function checkChat(telegram: ReplyTelegram, account: string, chatId: number) {
  const chat = await telegram.invokeRead<TdChat>({ '@type': 'getChat', chat_id: chatId });
  const type = chat.type;
  if (
    !type ||
    type['@type'] === 'chatTypeSecret' ||
    (type['@type'] === 'chatTypeSupergroup' && type.is_channel)
  )
    throw new ReplyBlocked('Этот тип чата не поддерживается', true);
  const sender = chat.message_sender_id;
  if (sender && (sender['@type'] !== 'messageSenderUser' || String(sender.user_id) !== account))
    throw new ReplyBlocked(
      'Выбрано авторство от имени чата; выберите личный аккаунт в Telegram',
      true,
    );
  if (type['@type'] === 'chatTypePrivate') {
    const result = await telegram.invokeRead<{ '@type': string }>({
      '@type': 'canSendMessageToUser',
      user_id: type.user_id,
      only_local: false,
    });
    if (result['@type'] !== 'canSendMessageToUserResultOk')
      throw new ReplyBlocked('Отправка недоступна или требует оплаты', true);
  } else {
    const member = await telegram.invokeRead<{
      status?: {
        '@type': string;
        is_member?: boolean;
        is_anonymous?: boolean;
        permissions?: { can_send_basic_messages: boolean };
      };
    }>({
      '@type': 'getChatMember',
      chat_id: chatId,
      member_id: { '@type': 'messageSenderUser', user_id: Number(account) },
    });
    const status = member.status;
    if (
      !status ||
      status.is_anonymous ||
      ['chatMemberStatusLeft', 'chatMemberStatusBanned'].includes(status['@type']) ||
      status.is_member === false ||
      (status['@type'] === 'chatMemberStatusRestricted' &&
        !status.permissions?.can_send_basic_messages) ||
      (!['chatMemberStatusCreator', 'chatMemberStatusAdministrator'].includes(status['@type']) &&
        !chat.permissions?.can_send_basic_messages)
    )
      throw new ReplyBlocked('Нет права писать от личного аккаунта', true);
    if (type['@type'] === 'chatTypeSupergroup') {
      const info = await telegram.invokeRead<{ outgoing_paid_message_star_count: number }>({
        '@type': 'getSupergroupFullInfo',
        supergroup_id: type.supergroup_id,
      });
      if (info.outgoing_paid_message_star_count > 0)
        throw new ReplyBlocked('Отправка требует оплаты', true);
    }
  }
  return chat;
}
export async function checkMessage(telegram: ReplyTelegram, message: TdMessage) {
  const props = await telegram.invokeRead<{ can_be_replied: boolean }>({
    '@type': 'getMessageProperties',
    chat_id: message.chat_id,
    message_id: message.id,
  });
  if (!props.can_be_replied) throw new ReplyBlocked('Reply к исходному сообщению недоступен');
  if (message.topic_id?.['@type'] === 'messageTopicForum') {
    const topic = await telegram.invokeRead<{ info?: { is_closed: boolean; is_hidden: boolean } }>({
      '@type': 'getForumTopic',
      chat_id: message.chat_id,
      forum_topic_id: message.topic_id.forum_topic_id,
    });
    if (!topic.info || topic.info.is_closed || topic.info.is_hidden)
      throw new ReplyBlocked('Исходная тема недоступна или закрыта');
  } else if (message.topic_id?.['@type'] === 'messageTopicThread') {
    await telegram.invokeRead({
      '@type': 'getMessageThread',
      chat_id: message.chat_id,
      message_id: message.id,
    });
  } else if (message.topic_id) throw new ReplyBlocked('Этот тип темы не поддерживается');
}
export async function authorName(telegram: ReplyTelegram, message: TdMessage) {
  const sender = message.sender_id;
  if (!sender) throw new ReplyBlocked('Не удалось определить отправителя');
  if (sender['@type'] === 'messageSenderUser') {
    const user = await telegram.invokeRead<TdUser>({ '@type': 'getUser', user_id: sender.user_id });
    return user.usernames?.active_usernames[0]
      ? `@${user.usernames.active_usernames[0]}`
      : [user.first_name, user.last_name].filter(Boolean).join(' ') || 'участника';
  }
  const chat = await telegram.invokeRead<TdChat>({ '@type': 'getChat', chat_id: sender.chat_id });
  if (chat.type?.['@type'] === 'chatTypeSupergroup') {
    const group = await telegram.invokeRead<TdSupergroup>({
      '@type': 'getSupergroup',
      supergroup_id: chat.type.supergroup_id,
    });
    if (group.usernames?.active_usernames[0]) return `@${group.usernames.active_usernames[0]}`;
  }
  return chat.title || 'участника';
}
