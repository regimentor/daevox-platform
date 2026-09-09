import { isAbsolute, relative } from 'node:path';
import type { TdSetTdlibParameters } from '@daevox/tdlib';

export function telegramParameters(env: NodeJS.ProcessEnv): TdSetTdlibParameters | null {
  const id = env.TELEGRAM_API_ID ?? '';
  const hash = env.TELEGRAM_API_HASH ?? '';
  const key = env.TELEGRAM_DATABASE_KEY ?? '';
  const database = env.TELEGRAM_DATABASE_DIRECTORY ?? '';
  const files = env.TELEGRAM_FILES_DIRECTORY ?? '';
  const repo = new URL('../../../../', import.meta.url).pathname;
  const outsideRepo = (path: string) => isAbsolute(path) && relative(repo, path).startsWith('../');
  if (
    !/^\d+$/.test(id) ||
    !Number.isSafeInteger(Number(id)) ||
    Number(id) < 1 ||
    Number(id) > 2147483647 ||
    !/^[a-f0-9]{32}$/i.test(hash) ||
    !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
    !outsideRepo(database) ||
    !outsideRepo(files) ||
    database === files
  )
    return null;
  return {
    '@type': 'setTdlibParameters',
    api_id: Number(id),
    api_hash: hash,
    database_directory: database,
    files_directory: files,
    database_encryption_key: key,
    use_test_dc: false,
    use_file_database: true,
    use_chat_info_database: true,
    use_message_database: true,
    use_secret_chats: false,
    system_language_code: 'ru',
    device_model: 'Daevox',
    system_version: process.platform,
    application_version: '0.0.0',
  };
}
