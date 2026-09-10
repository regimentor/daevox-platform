import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Container,
  Group,
  Modal,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
  Switch,
} from '@mantine/core';
import { QRCodeSVG } from 'qrcode.react';
import type { Action } from '@daevox/telegram-contract';
import type { SecretaryChat, SecretaryChatsPage } from '@daevox/telegram-contract/secretary';
import { TelegramApi, type TelegramView } from '../telegram/client';
import classes from './telegram.module.css';
import { ChatHistory, UpdateStatus } from '../telegram/ChatHistory';
import { TelegramWorkspace } from '../telegram/TelegramWorkspace';

export const meta = () => [{ title: 'Telegram · Daevox' }];

export default function Telegram() {
  const [view, setView] = useState<TelegramView>({
    snapshot: null,
    status: 'loading',
    sending: false,
    commandError: null,
  });
  const api = useRef<TelegramApi | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [chatPage, setChatPage] = useState<SecretaryChatsPage | null>(null);
  const [chatQuery, setChatQuery] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [historyChat, setHistoryChat] = useState<SecretaryChat | null>(null);
  const snapshot = view.snapshot;
  const auth = snapshot?.authorization;
  const available = view.status === 'online' && !view.sending;
  const allowed = (action: Action) => available && !!snapshot?.allowedActions.includes(action);

  useEffect(() => {
    const client = new TelegramApi(setView);
    api.current = client;
    const visibility = () => {
      client.setVisible(document.visibilityState === 'visible');
      if (document.visibilityState !== 'visible') setPassword('');
    };
    document.addEventListener('visibilitychange', visibility);
    visibility();
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      client.dispose();
      api.current = null;
    };
  }, []);
  useEffect(() => {
    const account = auth?.kind === 'connected' ? auth.account : null;
    if (!account) {
      setChatPage(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch(`/api/secretary/chats?q=${encodeURIComponent(chatQuery)}`, {
          cache: 'no-store',
        });
        const body: unknown = await response.json();
        if (
          !cancelled &&
          response.ok &&
          typeof body === 'object' &&
          body !== null &&
          'chats' in body
        ) {
          const page = body as SecretaryChatsPage;
          if (page.context.accountId !== account.id) return;
          setSecretaryOffline(false);
          setChatPage((current) =>
            current?.context.instanceId === page.context.instanceId &&
            current.context.accountId === page.context.accountId &&
            (current.context.accountEpoch > page.context.accountEpoch ||
              (current.context.accountEpoch === page.context.accountEpoch &&
                current.context.revision > page.context.revision))
              ? current
              : page,
          );
          setChatError(null);
        } else if (!cancelled) {
          setSecretaryOffline(true);
          setChatError('Не удалось загрузить список Telegram-чатов.');
        }
      } catch {
        if (!cancelled) {
          setSecretaryOffline(true);
          setChatError('Хранилище секретаря или backend недоступны.');
        }
      }
      if (!cancelled) timer = setTimeout(() => void load(), 1000);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [auth?.kind === 'connected' ? auth.account?.id : null, chatQuery]);
  const [pendingChat, setPendingChat] = useState<string | null>(null);
  const [secretaryOffline, setSecretaryOffline] = useState(false);
  const changeObservation = async (chat: SecretaryChat, enabled: boolean, autoReply = false) => {
    const account = auth?.kind === 'connected' ? auth.account : null;
    if (!chatPage || !account || pendingChat || secretaryOffline || view.status === 'offline')
      return;
    setPendingChat(chat.id);
    try {
      const response = await fetch(
        autoReply ? '/api/secretary/auto-reply' : '/api/secretary/observation',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: account.id,
            chatId: chat.id,
            enabled,
            expected: {
              instanceId: chatPage.context.instanceId,
              accountEpoch: chatPage.context.accountEpoch,
              ...(autoReply
                ? { autoReplyVersion: chat.autoReply.version }
                : { observationVersion: chat.observationVersion }),
            },
          }),
        },
      );
      if (!response.ok) throw new Error('failed');
      const body = (await response.json()) as {
        chat?: SecretaryChat;
        context: SecretaryChatsPage['context'];
      };
      if (body.chat)
        setChatPage((current) =>
          current?.context.accountId === account.id &&
          current.context.instanceId === chatPage.context.instanceId
            ? {
                ...current,
                context: body.context,
                chats: current.chats.map((item) => (item.id === chat.id ? body.chat! : item)),
                observedChats: [
                  ...current.observedChats.filter((item) => item.id !== chat.id),
                  ...(body.chat!.enabled ? [body.chat!] : []),
                ],
              }
            : current,
        );
    } catch {
      setChatError('Выбор не сохранён. Обновите состояние и повторите действие.');
    } finally {
      setPendingChat(null);
    }
  };
  useEffect(() => {
    setPassword('');
    setConfirm(false);
    setHistoryChat(null);
  }, [auth?.kind, auth?.kind === 'connected' ? auth.account?.id : null, snapshot?.instanceId]);

  if (auth?.kind === 'connected' && auth.account)
    return (
      <TelegramWorkspace
        key={`${snapshot?.instanceId}:${auth.account.id}`}
        accountId={auth.account.id}
        name={auth.account.displayName}
        page={chatPage}
        query={chatQuery}
        onQuery={setChatQuery}
        error={chatError ?? view.commandError}
        offline={view.status === 'offline' || secretaryOffline}
        pendingChat={pendingChat}
        onAutoReply={(chat, enabled) => void changeObservation(chat, enabled, true)}
        canDisconnect={allowed('disconnect')}
        onDisconnect={() => void api.current?.command('disconnect')}
        onObserve={(chat, enabled) => void changeObservation(chat, enabled)}
      />
    );

  return (
    <Container size={680} py="xl">
      {historyChat && auth?.kind === 'connected' && auth.account && (
        <ChatHistory
          key={`${auth.account.id}:${historyChat.id}`}
          accountId={auth.account.id}
          chat={historyChat}
          onClose={() => setHistoryChat(null)}
        />
      )}
      <Stack gap="lg">
        <div>
          <Title order={1}>Telegram</Title>
          <Text c="dimmed" mt={4}>
            Подключение личного аккаунта
          </Text>
        </div>
        {view.status === 'offline' && (
          <Alert color="yellow" title="Нет связи с backend">
            Показано последнее известное состояние. Действия станут доступны после восстановления
            связи.
          </Alert>
        )}
        {view.status === 'loading' && (
          <Text role="status" c="dimmed">
            Обновляем состояние…
          </Text>
        )}
        {snapshot && snapshot.connection !== 'ready' && (
          <Text role="status" c="dimmed">
            {snapshot.connection === 'offline'
              ? 'Нет сети Telegram. Подключение аккаунта сохраняется.'
              : 'Устанавливаем связь с Telegram…'}
          </Text>
        )}
        {(snapshot?.error || view.commandError) && (
          <Alert color="red" role="alert">
            {snapshot?.error?.message ?? view.commandError}
            {snapshot?.error?.retryAt && (
              <Text size="sm">
                Повторить после {new Date(snapshot.error.retryAt).toLocaleTimeString('ru-RU')}
              </Text>
            )}
          </Alert>
        )}
        <Paper withBorder radius="md" p="xl" className={classes.panel}>
          <Stack gap="lg">
            {snapshot?.client === 'configuration_required' ? (
              <>
                <Title order={2} size="h3">
                  Требуется настройка Telegram
                </Title>
                <Text>
                  Укажите реквизиты API, ключ и каталоги сессии в серверной конфигурации, затем
                  перезапустите backend.
                </Text>
              </>
            ) : snapshot?.client === 'failed' ? (
              <>
                <Title order={2} size="h3">
                  Подключение остановлено
                </Title>
                <Text>Перезапуск попробует восстановить сохранённую сессию.</Text>
                <Button
                  disabled={!allowed('restart')}
                  onClick={() => void api.current?.command('restart')}
                >
                  Перезапустить подключение
                </Button>
              </>
            ) : (
              <>
                {(!auth || auth.kind === 'initializing') && (
                  <Text role="status">Запускаем подключение…</Text>
                )}
                {auth?.kind === 'not_connected' && (
                  <>
                    <Title order={2} size="h3">
                      Аккаунт не подключён
                    </Title>
                    <Text>
                      Войдите через QR-код, чтобы предоставить Daevox доступ к вашему
                      Telegram-аккаунту.
                    </Text>
                    <Button
                      disabled={!allowed('connect')}
                      onClick={() => void api.current?.command('connect')}
                    >
                      Подключить Telegram
                    </Button>
                  </>
                )}
                {auth?.kind === 'requesting_qr' && (
                  <Text role="status">Получаем QR-код от Telegram…</Text>
                )}
                {auth?.kind === 'qr' && (
                  <div className={classes.qrRow}>
                    {available && snapshot?.connection === 'ready' && auth.link ? (
                      <QRCodeSVG
                        value={auth.link}
                        size={180}
                        marginSize={4}
                        bgColor="#ffffff"
                        fgColor="#111111"
                        role="img"
                        aria-label="QR-код для входа в Telegram"
                      />
                    ) : (
                      <div className={classes.qrWaiting} role="status">
                        Ожидаем актуальный QR-код…
                      </div>
                    )}
                    <div>
                      <Title order={2} size="h3">
                        Войдите через Telegram
                      </Title>
                      <ol className={classes.instructions}>
                        <li>Откройте Telegram на телефоне.</li>
                        <li>Настройки → Устройства → Подключить устройство.</li>
                        <li>Отсканируйте QR-код и подтвердите вход.</li>
                      </ol>
                      <Text size="sm" c="dimmed">
                        Код обновляется автоматически.
                      </Text>
                    </div>
                  </div>
                )}
                {auth?.kind === 'password' && (
                  <>
                    <Title order={2} size="h3">
                      Двухэтапная аутентификация
                    </Title>
                    <Text>Введите пароль вашего Telegram-аккаунта.</Text>
                    <form
                      autoComplete="off"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!allowed('submit_password') || !password) return;
                        void api.current?.command('submit_password', password);
                        setPassword('');
                      }}
                    >
                      <Stack>
                        <PasswordInput
                          label="Пароль Telegram"
                          autoComplete="off"
                          value={password}
                          onChange={(event) => setPassword(event.currentTarget.value)}
                          disabled={!allowed('submit_password')}
                          maxLength={4096}
                        />
                        <Button type="submit" disabled={!allowed('submit_password') || !password}>
                          Продолжить
                        </Button>
                      </Stack>
                    </form>
                    <Text size="sm" c="dimmed">
                      Забыли пароль? Восстановите доступ в Telegram. Восстановление внутри Daevox
                      пока не поддерживается.
                    </Text>
                  </>
                )}
                {auth?.kind === 'connected' && (
                  <>
                    <Title order={2} size="h3">
                      Аккаунт подключён
                    </Title>
                    <div>
                      <Text fw={600}>{auth.account?.displayName || 'Telegram-аккаунт'}</Text>
                      {auth.account?.username && <Text c="dimmed">@{auth.account.username}</Text>}
                      {!auth.account && (
                        <Text c="dimmed">Сведения об аккаунте пока недоступны.</Text>
                      )}
                    </div>
                    <Button
                      color="red"
                      variant="light"
                      disabled={!allowed('disconnect')}
                      onClick={() => setConfirm(true)}
                    >
                      Отключить аккаунт
                    </Button>
                    <Stack gap="sm" mt="md">
                      <Title order={3}>Наблюдение за Telegram-чатами</Title>
                      <Text size="sm" c="dimmed">
                        Выберите переписки, которые нужно сохранять в локальный архив. Закрытие
                        страницы сбор не останавливает.
                      </Text>
                      <Paper withBorder p="sm" className={classes.watchingPanel}>
                        <Text fw={600}>Сейчас просматриваются секретарём</Text>
                        {chatPage?.observedChats.length ? (
                          <Stack gap="sm" mt={4}>
                            {chatPage.observedChats.map((chat) => (
                              <div key={chat.id}>
                                <Text size="sm">{`${chat.title} (${chat.collection})`}</Text>
                                <UpdateStatus update={chat.lastUpdate} />
                                <Button
                                  size="xs"
                                  variant="subtle"
                                  onClick={() => setHistoryChat(chat)}
                                >
                                  История · {chat.title || chat.id}
                                </Button>
                              </div>
                            ))}
                          </Stack>
                        ) : (
                          <Text size="sm" c="dimmed" mt={4}>
                            Пока ни один чат не выбран.
                          </Text>
                        )}
                      </Paper>
                      <TextInput
                        label="Поиск по названию или ID"
                        value={chatQuery}
                        onChange={(event) => setChatQuery(event.currentTarget.value)}
                      />
                      {chatPage?.catalog.status !== 'ready' && (
                        <Text size="sm" role="status">
                          Загружаем известную часть каталога…
                        </Text>
                      )}
                      {chatError && (
                        <Alert color="red" role="alert">
                          {chatError}
                        </Alert>
                      )}
                      {chatPage?.chats.map((chat) => (
                        <Paper key={chat.id} withBorder p="sm">
                          <Group justify="space-between" wrap="nowrap">
                            <div>
                              <Text fw={600}>{chat.title}</Text>
                              <UpdateStatus update={chat.lastUpdate} />
                              <Button
                                size="xs"
                                variant="subtle"
                                onClick={() => setHistoryChat(chat)}
                              >
                                История · {chat.title || chat.id}
                              </Button>
                              <Text size="xs" c="dimmed">
                                {chat.type} · {chat.id} · {chat.collection}
                              </Text>
                              {chat.completeness.hasGaps && (
                                <Text size="xs" c="orange">
                                  Архив имеет известный пробел
                                </Text>
                              )}
                            </div>
                            <Switch
                              checked={chat.enabled}
                              onChange={(event) =>
                                void changeObservation(chat, event.currentTarget.checked)
                              }
                              aria-label={`Наблюдать за ${chat.title}`}
                            />
                          </Group>
                        </Paper>
                      ))}
                      {chatPage && chatPage.chats.length === 0 && (
                        <Text c="dimmed">В известной части каталога чаты не найдены.</Text>
                      )}
                    </Stack>
                  </>
                )}
                {auth?.kind === 'logging_out' && (
                  <>
                    <Title order={2} size="h3">
                      Отключаем аккаунт…
                    </Title>
                    <Text role="status">
                      Ожидаем подтверждения Telegram. Для выхода нужна сеть. Закрытие страницы не
                      отменяет отключение.
                    </Text>
                  </>
                )}
                {auth?.kind === 'unsupported' && (
                  <>
                    <Title order={2} size="h3">
                      Этот шаг входа не поддерживается
                    </Title>
                    <Text>
                      Продолжить этот способ авторизации в Daevox пока нельзя. Данные сессии
                      сохранены.
                    </Text>
                    <Button
                      variant="default"
                      disabled={!available}
                      onClick={() => api.current?.refresh()}
                    >
                      Проверить состояние
                    </Button>
                  </>
                )}
              </>
            )}
            {snapshot?.operation?.status === 'pending' && (
              <Text size="sm" role="status">
                Команда выполняется…
              </Text>
            )}
          </Stack>
        </Paper>
      </Stack>
      <Modal
        opened={confirm}
        onClose={() => setConfirm(false)}
        title="Отключить Telegram?"
        centered
      >
        <Stack>
          <Text>
            Сессия Daevox будет завершена в Telegram. Для повторного подключения потребуется новый
            вход.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirm(false)}>
              Оставить подключённым
            </Button>
            <Button
              color="red"
              disabled={!allowed('disconnect')}
              onClick={() => {
                setConfirm(false);
                void api.current?.command('disconnect');
              }}
            >
              Отключить
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Container>
  );
}
