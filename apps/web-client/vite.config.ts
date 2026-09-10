import { fileURLToPath } from 'node:url';
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig, loadEnv } from 'vite';

const envDir = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, ['API_PROXY_TARGET', 'TRANSCRIPTION_PROXY_TARGET']);

  return {
    envDir,
    plugins: [reactRouter()],
    resolve: {
      tsconfigPaths: true,
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/trancription-api/': {
          target: env.TRANSCRIPTION_PROXY_TARGET || 'http://127.0.0.1:3001',
          changeOrigin: true,
        },
        '/api': {
          target: env.API_PROXY_TARGET || 'http://127.0.0.1:3000',
          changeOrigin: true,
        },
      },
    },
  };
});
