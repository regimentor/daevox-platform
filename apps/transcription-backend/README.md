# Локальная транскрибация

FastAPI-сервис для вкладки `/transcription`: файл или публичная запись YouTube →
FFmpeg → параллельные ASR (GigaAM-v3 для русского, Whisper large-v3 для английского)
и pyannote Community-1 → TXT/JSON.
Одна операция, без очереди. Модели создаются исключительно в дочерних процессах
после команды пользователя; запуск API и health не загружают веса.

## Запуск

Из корня monorepo:

```bash
npm run dev --workspace @daevox/transcription-backend
npm run dev --workspace @daevox/web-client
```

Нужны uv, Python 3.12 (uv установит его), FFmpeg/ffprobe с shared libraries,
Node.js для yt-dlp и доступные NVIDIA GPU. `dev` устанавливает GPU extra из `uv.lock`.
API слушает `127.0.0.1:3001`, Vite — `127.0.0.1:5173`.
Сервис запускается ровно с одним API worker. Несколько экземпляров сервиса
не обеспечивают общую блокировку операции; не направляйте proxy на несколько экземпляров.

Первичный доступ к Community-1:

1. Принять условия [модели](https://huggingface.co/pyannote/speaker-diarization-community-1).
2. После установки зависимостей выполнить `apps/transcription-backend/.venv/bin/hf auth login`.
   Альтернатива — серверная переменная окружения `HF_TOKEN`. Токен не передаётся в браузер.
3. Запустить транскрибацию из UI. Скачивание моделей происходит только здесь.

## Настройки окружения

| Переменная                           | По умолчанию                               | Назначение                                                  |
| ------------------------------------ | ------------------------------------------ | ----------------------------------------------------------- |
| `TRANSCRIPTION_HOST`                 | `127.0.0.1`                                | Адрес API                                                   |
| `TRANSCRIPTION_PORT`                 | `3001`                                     | Порт API                                                    |
| `TRANSCRIPTION_DATA_DIR`             | `data` относительно backend                | Результаты и временные файлы                                |
| `TRANSCRIPTION_ASR_GPU`              | `NVIDIA GeForce RTX 4070 Ti`               | Имя или UUID GPU; также допускается CUDA-номер с PCI_BUS_ID |
| `TRANSCRIPTION_DIARIZATION_GPU`      | `NVIDIA GeForce RTX 4070 Ti`               | Независимый выбор GPU                                       |
| `TRANSCRIPTION_ASR_REVISION`         | `edaa852ec7e145841d8ffdb056a99866b5f0a478` | Закреплённая revision large-v3                              |
| `TRANSCRIPTION_DIARIZATION_REVISION` | `3533c8cf8e369892e6b79ff1bf80f7b0286a54ee` | Закреплённая revision Community-1                           |
| `TRANSCRIPTION_UPLOAD_TIMEOUT`       | `60`                                       | Секунды ожидания начала upload, не лимит файла              |
| `TRANSCRIPTION_EVENT_HISTORY`        | `128`                                      | Число событий replay; дополнительно ограничен памятью 4 MiB |
| `TRANSCRIPTION_PROXY_TARGET`         | `http://127.0.0.1:3001`                    | Vite proxy; задаётся в корневом `.env` или окружении        |
| `HF_HUB_CACHE`                       | Стандартный кэш Hugging Face               | Постоянное хранение весов                                   |

Настройки Python передаются в окружении запуска, например
`TRANSCRIPTION_DATA_DIR=/path/to/transcriptions npm run dev --workspace @daevox/transcription-backend`.
Имена/UUID предпочтительнее номеров: порядок устройств CUDA и `nvidia-smi` может отличаться.
Никакого CPU fallback, уменьшения модели или INT8 нет. ASR и диаризация изолированы
в процессах. В режиме авто ASR-процесс сначала определяет язык через Whisper;
при русском освобождает Whisper и загружает GigaAM, иначе продолжает Whisper.
Выбор «Русский» пропускает загрузку Whisper и определение языка.

GigaAM использует веса [ai-sage/GigaAM-v3, e2e_rnnt](https://huggingface.co/ai-sage/GigaAM-v3/tree/e2e_rnnt),
закреплённые на `7655ad717f8122257385bb4b2f373db3697e8680` (настройка
`TRANSCRIPTION_GIGAAM_REVISION`). Официальная библиотека GigaAM закреплена в uv.lock
на `7447938d791c4f3e643386ee22c33777004293a5`; её декодер возвращает времена слов,
которых нет у HF-обёртки этой ревизии. Веса загружаются с `weights_only=True`,
архитектура проверяется строгой загрузкой state_dict; удалённый Python-код HF не выполняется.
Encoder работает в FP16 на ASR GPU, decoder — в FP32, как в официальном загрузчике.
Silero VAD из faster-whisper выделяет порции не длиннее 20 секунд; времена слов
сдвигаются к исходной записи, а соседние части одного спикера объединяются.
Времена RNN-T получены по кадрам выдачи токенов и не являются принудительным
выравниванием. Проверка качества текста и speaker-разметки требует эталона.

Результат хранится в `data/results/<безопасное-имя>-<uuid>/transcript.{txt,json}`.
JSON содержит слова, сгруппированные в последовательные реплики одного спикера, исходные интервалы спикеров,
фактические модели и признаки полноты. Отдельная alignment-модель не используется.
Границы порций ASR, паузы и изменение признака наложения не разрывают реплику:
новый блок начинается при смене спикера. Если в части реплики есть одновременная речь,
весь блок получает `overlap=true`; точные интервалы сохраняются в `speaker_turns`.
Текст без определённого спикера не объединяется между порциями ASR.
Отмена сохраняет принятый текст; ошибка диаризации сохраняет весь доступный ASR с
`status=failed`, `completeness.diarization=false`. Оригинальный файл не удаляется.
В UI доступна текущая/последняя операция до нового запуска или перезапуска API.

## Проверки

```bash
npm run verify --workspace @daevox/transcription-backend
npm run typecheck --workspace @daevox/web-client
npm test --workspace @daevox/web-client
npm run build --workspace @daevox/web-client
npm run test:e2e:transcription --workspace @daevox/web-client
```

Обычные проверки не требуют GPU и не скачивают модели. Backend-тесты подставляют
детерминированные внешние процессы на границе модельного runtime; HTTP, SSE,
файловая система и управление процессами настоящие. FFmpeg также проверяется
на сгенерированных источниках. Браузерные тесты поднимают настоящий FastAPI и Vite
на портах 3002/5175. Тестовый bootstrap не доступен из production-конфигурации.

Отчёт о выполненной приёмке: [acceptance.md](acceptance.md).
Функциональные тесты и CUDA smoke-test сами по себе не подтверждают качество моделей.

## Reverse proxy для собранного web-client

Vite proxy работает только в dev. Пример location для nginx (точное написание префикса):

```nginx
location /trancription-api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 1d;
    proxy_send_timeout 1d;
    client_max_body_size 0;
}
```

Доступ предназначен для доверенного локального окружения. При внешней публикации
добавьте аутентификацию и TLS на proxy. Префикс `/api` продолжает обслуживать основной backend.

GPU-регрессионная проверка после установки extra: `RUN_GPU_TESTS=1 apps/transcription-backend/.venv/bin/pytest apps/transcription-backend/tests/test_gpu_runtime.py`. Она выполняет CUDA/cuDNN-операции на обеих GPU без скачивания моделей. Не устанавливайте одновременно пакеты `nvidia-cudnn-cu12` и `nvidia-cudnn-cu13`: их файлы конфликтуют.

Опциональная проверка уже скачанных моделей (без сети):

```bash
cd apps/transcription-backend
RUN_MODEL_TESTS=1 HF_HUB_OFFLINE=1 .venv/bin/pytest tests/test_gpu_runtime.py
```

Если кэш расположен нестандартно, укажите тот же `HF_HUB_CACHE`, с которым запускали UI.
Проверка выполняет полный HTTP pipeline на десяти минутах синтетической тишины;
её не следует считать оценкой WER/DER.

Реальная проверка GigaAM через HTTP на первых 45 секундах русской записи, отдельно
с `language=ru` и `language=auto` (при первом запуске скачает веса):

```bash
GIGAAM_TEST_AUDIO=/absolute/path/to/russian-recording.webm .venv/bin/pytest tests/test_gpu_runtime.py -k russian
```

## Перевод видео с озвучкой

Вкладка `/voiceover` принимает английское видео с аудио или публичную завершённую
YouTube-запись. После распознавания и перевода пользователь подтверждает голоса;
затем готовятся видео и отдельная русская аудиодорожка. Библиотека сохраняется
в `data/voiceovers.sqlite3`, медиа — в `data/voiceovers/`. Активный слот общий
с транскрибацией. Отмена перевода удаляет его запись и файлы.

ASR и определение спикеров по умолчанию работают параллельно на RTX 4070 Ti.
TTS использует эту же карту после завершения распознавания. Изменение настроек
требует перезапуска API; уже завершившуюся ошибкой запись нужно запустить заново.

Для перевода задайте `TRANSCRIPTION_LLM_BASE_URL` (по умолчанию
`http://127.0.0.1:8080/v1`) и `TRANSCRIPTION_LLM_MODEL` — идентификатор уже
загруженной модели локального сервера. Сервис не запускает и не меняет модель LLM.
Настройка TTS: `TRANSCRIPTION_TTS_GPU` (по умолчанию `NVIDIA GeForce RTX 4070 Ti`).

Silero должен быть установлен до обработки:

```bash
cd apps/transcription-backend
mkdir -p data/models
curl --fail --location https://models.silero.ai/models/tts/ru/v5_5_ru.pt --output data/models/v5_5_ru.pt
printf '%s\n' '50081637b602126ee06cb3bc8a744d25651d2da149ee8864b9a379bfdd934437  data/models/v5_5_ru.pt' | sha256sum --check
```

`TRANSCRIPTION_SILERO_PATH` и `TRANSCRIPTION_SILERO_SHA256` позволяют явно задать
путь и контрольную сумму. Загрузка артефакта разрешена только при совпадении SHA-256.
Пять образцов голосов кешируются отдельно от переводов.

Браузерная проверка: `npm run test:e2e:voiceover --workspace @daevox/web-client`.
Она использует модельные doubles, настоящий API, FFmpeg и браузер; проверка
качества реальных моделей проводится отдельно.

При подгонке озвучки приоритет отдаётся сохранению речи: длинные фразы могут
немного отставать от оригинала, а в паузах дорожка догоняет исходный тайминг.
Фрагменты не накладываются друг на друга. Речь ускоряется не более чем в 1,15 раза;
видео сохраняет скорость 1×. Если речь заканчивается позже источника, последний
кадр удерживается до её завершения. Превышение временного окна не создаёт пропуск.
Перевод получает временной бюджет; повторное сокращение учитывает измеренную
длительность Silero. Запросы к llama-server используют `enable_thinking=false`.
