# Daevox core

Локальный Rust-сервис управления llama.cpp. Интерфейс находится в существующем
web-client: `/models` — библиотека, `/models?view=manage` — пресеты, система,
сборки и журналы. Выбор и запуск сохранённого пресета выполняются из шапки.

## Запуск

Из корня monorepo:

```sh
git submodule update --init apps/core/vendor/llama.cpp
npm install
CORE_PORT=3188 CORE_WEB_ORIGIN=http://localhost:5173 \
  cargo run --locked --manifest-path apps/core/Cargo.toml --bin core
```

В другом терминале:

```sh
CORE_PROXY_TARGET=http://127.0.0.1:3188 npm run dev --workspace @daevox/web-client
```

Откройте адрес Vite. `CORE_WEB_ORIGIN` должен в точности совпадать с origin
браузера, включая localhost/127.0.0.1 и порт. Приложения без Origin обращаются
к `http://127.0.0.1:3188/v1`. Cargo самостоятельно не загружает корневой `.env`.
Порт задаётся явно; `CORE_PORT=0` выбирает свободный порт и печатает его в stderr.
Занятый порт не освобождается принудительно. Core слушает только loopback.

Первый запуск создаёт `data/`, SQLite и миграции, берёт lock директории.
Без подходящего артефакта начинается CUDA-сборка pinned llama.cpp с 8 jobs.
CUDA/CMake/C++ toolchain должны быть установлены заранее: core не меняет ОС
и не переключается на CPU после ошибки. Изменение драйвера запускает проверку
совместимости существующего CUDA artifact; несовместимый build нельзя применить. CPU-профиль выбирается явно во вкладке
сборок. Готовый кандидат применяется отдельным действием и оставляет модель
выгруженной; после перезапуска core модель также не загружается автоматически.

## Модели и пресеты

Найдите публичный GGUF на Hugging Face, выберите один полный quant (одиночный файл
или все shards) и при необходимости подходящий projector. Core фиксирует commit,
скачивает один комплект за раз и сохраняет общие файлы без второй копии весов.
Пауза освобождает очередь, продолжение ставит комплект в её конец. После рестарта
незавершённые загрузки остаются на паузе. При несовместимом Range/ETag partial
сохраняется; повторная загрузка файла требует отдельного действия.

В библиотеке «Создать INI» открывает исходник для редактирования. Сохранение не
запускает модель. INI допускает несколько секций и локальную `[*]`; имена секций
уникальны во всём каталоге. Неизвестные/контролируемые core параметры и неверные
файловые пути блокируют запуск, но черновик сохраняется. Внешняя правка файла
требует перечитать его либо явно заменить своим текстом. У работающего экземпляра
сохраняется применённая revision даже после изменения или удаления исходника.

`presets/smollm-validation.ini` — источник технического smoke-прогона, а не
рекомендация модели для перевода. Его веса не входят в Git; отсутствующие файлы
отображаются в диагностике. Для рабочих потребителей задайте конкретное имя своей
секции в `LLAMA_MODEL` и `TRANSCRIPTION_LLM_MODEL`.

## API и наблюдение

- OpenAPI: `GET /openapi.json`. Источник контракта — `tools/contract.py`;
  `npm run contract -w @daevox/core` обновляет OpenAPI и TS-клиент.
- Management: `/runtime`, `/presets`, `/preset-files`, `/model-sets`, `/hub`,
  `/downloads`, `/builds`, `/operations`, `/settings`, `/metrics`, `/logs`, `/events`.
  Изменяющие команды требуют `Idempotency-Key`.
- Inference: `GET /v1/models`, `POST /v1/chat/completions`. Только готовый preset id,
  без alias active, autoload и доступа к router management. JSON/schema/SSE
  передаются без автоматического повторения генерации.
- Замена модели закрывает допуск и ждёт принятые запросы, включая streaming body.
  Cancel/force применяются только к текущей операции и проверяются backend.
- Метрики собираются каждую секунду независимо от вкладки, последние 60 минут —
  в RAM. TPS берётся из llama timings; неизвестные измерения не заменяются нулём.
- Журналы сохраняются сегментами до общего лимита 200 MiB. Медленный SSE consumer
  получает gap и snapshot; пропуски не останавливают процессы.
- SIGINT/SIGTERM останавливают собственные процессы. После аварии сведения об
  остаточных процессах доступны в runtime action bar; остановка разрешается лишь
  при подтверждённой принадлежности.

`vendor/llama.cpp` закреплён на `82d6bb284d1ff1c6ef37f29a4c3b63d1a8b11806`.
`presets/*.ini` — исходники для Git. Весь `data/` (SQLite, backup, веса, partial,
сборки, generated INI, logs и process records) и `target/` исключены из Git.
Все пути считаются от `apps/core`, а не от текущего shell CWD.

## Проверки

```sh
cargo test --locked --manifest-path apps/core/Cargo.toml
cargo clippy --locked --manifest-path apps/core/Cargo.toml --all-targets -- -D warnings
npm run typecheck -w @daevox/web-client
npm run test:e2e:core -w @daevox/web-client
```

HTTP/process тесты запускают настоящий core и локальные внешние fixtures для
compiler/router/Hub. Browser suite использует core3188, Vite5188 и Hub3199 с
изолированными временными данными; эти порты должны быть свободны. Игнорируемые
тесты требуют настоящего CUDA toolchain/GPU и запускаются отдельно.

Проверка установленного OpenAI SDK против уже загруженного пресета:

```sh
CORE_VALIDATION_URL=http://127.0.0.1:3188/v1 \
CORE_VALIDATION_MODEL=smollm-validation node apps/core/tools/validate-consumers.mjs
```

Скрипт проверяет discovery, media strict schema, SSE и ошибки model mismatch;
сам модель не загружает. Полный список приёмки и текущие результаты находятся
в [результатах приёмки](../../.scratch/llama-service/validation/implementation-results.md).
История TDD-циклов сохранена отдельно в `.scratch/llama-service/implementation.md`.
