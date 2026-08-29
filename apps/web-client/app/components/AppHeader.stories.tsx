import type { Meta, StoryObj } from '@storybook/react-vite';

import { AppHeader } from './AppHeader';

const meta = {
  component: AppHeader,
  title: 'Layout/AppHeader',
} satisfies Meta<typeof AppHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
