import { index, route, type RouteConfig } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('models', 'routes/models.tsx'),
  route('transcription', 'routes/transcription.tsx'),
  route('voiceover/:id?', 'routes/voiceover.tsx'),
  route('telegram', 'routes/telegram.tsx'),
] satisfies RouteConfig;
