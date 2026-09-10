import type { ArchiveMessage } from '@daevox/db';
import type { TdMessage, TdMessageContent } from '@daevox/tdlib';

const textOf = (value: { text?: string } | null) => value?.text ?? null;
function content(
  message: TdMessage,
): Pick<ArchiveMessage, 'text' | 'caption' | 'mediaType' | 'mediaId'> {
  const c = message.content;
  if (!c) return { text: null, caption: null, mediaType: null, mediaId: null };
  if (c['@type'] === 'messageText')
    return { text: textOf(c.text), caption: null, mediaType: null, mediaId: null };
  const candidate = c as TdMessageContent & { caption?: { text?: string } | null };
  return {
    text: null,
    caption: textOf(candidate.caption ?? null),
    mediaType: c['@type'],
    mediaId: null,
  };
}
export function archiveMessage(accountId: string, message: TdMessage): ArchiveMessage {
  const sender = message.sender_id;
  return {
    accountId,
    chatId: String(message.chat_id),
    messageId: String(message.id),
    date: message.date,
    editDate: message.edit_date || null,
    isOutgoing: message.is_outgoing,
    authorKind: sender?.['@type'] === 'messageSenderUser' ? 'user' : sender ? 'chat' : null,
    authorId: sender
      ? String(sender['@type'] === 'messageSenderUser' ? sender.user_id : sender.chat_id)
      : null,
    authorName: null,
    authorUsername: null,
    ...content(message),
    replyChatId: null,
    replyMessageId: null,
    canBeSaved: message.can_be_saved,
  };
}

export function deletedMessage(
  accountId: string,
  chatId: string,
  messageId: number,
): ArchiveMessage {
  return {
    accountId,
    chatId,
    messageId: String(messageId),
    date: 0,
    editDate: null,
    isOutgoing: false,
    authorKind: null,
    authorId: null,
    authorName: null,
    authorUsername: null,
    text: null,
    caption: null,
    mediaType: null,
    mediaId: null,
    replyChatId: null,
    replyMessageId: null,
    canBeSaved: false,
    deleted: true,
    skippedReason: 'deleted',
  };
}
