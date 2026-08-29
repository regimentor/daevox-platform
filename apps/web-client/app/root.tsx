import '@mantine/core/styles.css';

import { AppShell, ColorSchemeScript, MantineProvider, Text } from '@mantine/core';
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from 'react-router';

import { AppHeader } from './components/AppHeader';
import classes from './root.module.css';

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta content="width=device-width, initial-scale=1" name="viewport" />
        <ColorSchemeScript defaultColorScheme="auto" />
        <Meta />
        <Links />
      </head>
      <body>
        <MantineProvider defaultColorScheme="auto">
          <AppShell header={{ height: 60 }} padding="md">
            <AppShell.Header>
              <AppHeader />
            </AppShell.Header>
            <AppShell.Main className={classes.main}>{children}</AppShell.Main>
          </AppShell>
        </MantineProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: { error: unknown }) {
  const message = isRouteErrorResponse(error) ? error.statusText : 'Unexpected application error';

  return <Text role="alert">{message}</Text>;
}
