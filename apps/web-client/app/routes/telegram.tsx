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
  Title,
} from '@mantine/core';
import { QRCodeSVG } from 'qrcode.react';
import type { Action } from '@daevox/telegram-contract';
import { TelegramApi, type TelegramView } from '../telegram/client';
import classes from './telegram.module.css';

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
    setPassword('');
    setConfirm(false);
  }, [auth?.kind, snapshot?.instanceId]);

  return (
    <Container size={680} py="xl">
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
