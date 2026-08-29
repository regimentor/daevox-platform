import { expect, test } from '@playwright/test';

test('user can switch the application to the dark theme', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Daevox web client' })).toBeVisible();
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();

  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
  await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
});
