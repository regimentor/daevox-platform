import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { Snapshot } from '@daevox/telegram-contract';
import Telegram from './telegram';

const initial: Snapshot = {
  instanceId: 'test',
  revision: 1,
  controlVersion: 1,
  client: 'running',
  connection: 'ready',
  authorization: { kind: 'password' },
  allowedActions: ['submit_password'],
  operation: null,
  error: null,
};
afterEach(() => vi.unstubAllGlobals());

it('clears and disables the password immediately on submission, then renders the confirmed account', async () => {
  let accept!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>();
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(initial)));
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  fetcher.mockResolvedValue(
    new Response(
      JSON.stringify({
        ...initial,
        revision: 2,
        controlVersion: 2,
        authorization: { kind: 'connected', account: null },
        allowedActions: ['disconnect'],
      }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  render(
    <MantineProvider>
      <Telegram />
    </MantineProvider>,
  );
  const password = await screen.findByLabelText('Пароль Telegram');
  await waitFor(() => expect(password).toBeEnabled());
  await user.type(password, 'temporary-password');
  await user.click(screen.getByRole('button', { name: 'Продолжить' }));
  expect(password).toHaveValue('');
  expect(password).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Продолжить' })).toBeDisabled();
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  accept(
    new Response(JSON.stringify({ instanceId: 'test', operationId: 'command' }), { status: 202 }),
  );
  expect(await screen.findByRole('heading', { name: 'Аккаунт подключён' })).toBeVisible();
  expect(screen.getByText('Сведения об аккаунте пока недоступны.')).toBeVisible();
});
