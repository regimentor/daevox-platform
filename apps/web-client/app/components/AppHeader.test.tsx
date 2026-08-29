import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { AppHeader } from './AppHeader';

describe('AppHeader', () => {
  it('lets the user switch from the light theme to the dark theme', async () => {
    const user = userEvent.setup();

    render(
      <MantineProvider defaultColorScheme="light">
        <AppHeader />
      </MantineProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }));

    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
  });
});
