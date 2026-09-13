# Приёмка реализации llama-service

Дата: 2026-09-13. Реализация: `apps/core`, интерфейс: `apps/web-client`.
Основание — утверждённая [спецификация](../spec.md). Прототипы в соседних документах
сохраняются отдельно: приведённые ниже API/browser-проверки запускают новый core.

## Воспроизведение

```sh
cargo test --locked --manifest-path apps/core/Cargo.toml
cargo clippy --locked --manifest-path apps/core/Cargo.toml --all-targets -- -D warnings
cargo fmt --check --manifest-path apps/core/Cargo.toml
npm run contract -w @daevox/core
npm run typecheck -w @daevox/web-client
npm test -w @daevox/web-client
npm run build -w @daevox/web-client
npm run test:e2e:core -w @daevox/web-client
```

В этой сессии Rust работал offline с уже подготовленным Cargo cache. HTTP/SSE-тесты
требуют loopback; компилятор, router, Hub и NVML в обычном наборе заменяются внешними
процессами/HTTP/ABI-фикстурами. Внутренние модули core не подменяются. SQLite triggers
используются только для инъекции отказов хранилища; результат читается через API
или проверяется на согласованной границе перезапуска приложения.

Аппаратные тесты запускаются отдельно:

```sh
cargo test --locked --manifest-path apps/core/Cargo.toml --test builds \
  a_cuda_build_produces_a_checked_candidate_without_applying_it -- --ignored
cargo test --locked --manifest-path apps/core/Cargo.toml --test observability \
  cuda_indices_are_matched_by_uuid_instead_of_nvml_enumeration_order -- --ignored
```

Для ручного прогона против явно выбранного работающего core:

```sh
CORE_VALIDATION_URL=http://127.0.0.1:3188/v1 \
CORE_VALIDATION_MODEL=smollm-validation node apps/core/tools/validate-consumers.mjs
CORE_VALIDATION_BASE=http://127.0.0.1:3188 node apps/core/tools/validate-lifecycle.mjs
CORE_VALIDATION_URL=http://127.0.0.1:3188/v1 CORE_VALIDATION_MODEL=smollm-validation \
  python apps/core/tools/validate-media.py
python3 apps/core/tools/stress-logs.py
python3 apps/core/tools/stress-sse.py
```

Lifecycle-прогон требует готовой модели, выполняет её restart/force/unload и в конце
снова загружает исходный preset. Media-прогон запускается из корня monorepo в Python
окружении transcription-backend. Нагрузочные сценарии создают собственные временные
каталоги и тестовый compiler, завершают свой core и удаляют свой каталог.

## Матрица A01–A29

| ID  | Результат и доказательство                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Startup API-тесты: data-пути, lock и повторный процесс. Lock берётся до открытия SQLite; пути не зависят от CWD.                                                                                                                                                                                                                                          |
| A02 | `migration_failure_preserves_a_consistent_backup_including_wal`: отказ миграции сохраняет исходные данные и согласованную backup, запуск прекращается.                                                                                                                                                                                                    |
| A03 | Startup создаёт CUDA candidate с 8 jobs и не применяет его. Автосборка ждёт empty/recovery; ручная сборка принимается при активной модели. Отложенный запуск после recovery проверен отдельным тестом. Настоящий CUDA toolchain проверен аппаратным тестом.                                                                                               |
| A04 | Недоступный toolchain даёт failed operation без CPU fallback. После изменения версии драйвера существующий CUDA artifact проходит отдельную bounded проверку devices; несовместимый кандидат нельзя применить, автоматического rebuild нет.                                                                                                               |
| A05 | Build API и browser: live stdout/stderr, cancel во время compiler и health probe, ручной повтор/clean, сохранение current. Публикация кандидата и результата операции атомарна; отказ SQLite не превращается в ложный succeeded.                                                                                                                          |
| A06 | Apply/rollback — отдельная операция: drain, остановка старого router, empty. Проверены отмена в drain и во время readiness, сохранение current/previous и GPU allocation barrier.                                                                                                                                                                         |
| A07 | Hub API проверяет public policy, pinned commit, shards/projector и pagination. Отдельные негативные проверки private/gated. Скачан настоящий SmolLM GGUF; другой quant не запрашивался.                                                                                                                                                                   |
| A08 | Повтор selection дедуплицируется; shared file повторно не скачивается. Delete проверяет active instance и свежий preview references, сохраняет INI; SQLite fault не удаляет готовые веса.                                                                                                                                                                 |
| A09 | Core API: после pause/restart новый worker использует Range/If-Range с прежнего offset. Штатный SIGTERM также сохраняет partial. Реальный HTTP 206 и итоговый SHA256 дополнительно подтверждены [Range-экспериментом](resume-results.md).                                                                                                                 |
| A10 | Core API: HTTP 200 вместо 206, неверный Content-Range, изменённый response ETag и 416 сохраняют partial. Только restart-file очищает его; после явного restart комплект успешно публикуется.                                                                                                                                                              |
| A11 | Очередь одного worker, pause/resume/cancel и progress проверены API/browser. После crash нет autoresume. Отказ/падение при публикации сохраняет завершённый staging inode: ручной resume работает даже с выключенным Hub.                                                                                                                                 |
| A12 | Raw INI roundtrip сохраняет comments/CRLF; stale revision конфликтует, overwrite явный. Failed transaction и crash до commit восстанавливают прежний исходник.                                                                                                                                                                                            |
| A13 | Compiler API-тесты: локальная `[*]`, относительные пути каждого source, aliases, CSV/scaled file options. Семантика привязана к option export pinned upstream.                                                                                                                                                                                            |
| A14 | Duplicate section, unknown/router-owned option и неподдерживаемые значения блокируют запуск. Duplicate aliases дают warning и effective last value. Invalid draft сохраняется и виден в UI.                                                                                                                                                               |
| A15 | Внешняя правка/удаление исходника не останавливает active instance; applied revision сохраняется. Принятая операция использует захваченную saved revision; поздняя правка не меняет target.                                                                                                                                                               |
| A16 | Empty core не запускает модель через inference. `/v1/models` содержит только ready instance; неизвестный конкретный preset отклоняется, autoload/router controls недоступны.                                                                                                                                                                              |
| A17 | API streaming и настоящий CUDA router: принятый stream заканчивается с DONE, новые requests получают 503 model_switching, затем создаётся новый instance.                                                                                                                                                                                                 |
| A18 | API: cancel waiting сохраняет старую модель, cancel loading завершает новую и оставляет empty; force прерывает stream без выдуманного DONE. Настоящий CUDA lifecycle подтвердил abort/drain/force.                                                                                                                                                        |
| A19 | Конкурирующие команды конфликтуют; одинаковый key возвращает исходный результат после restart, другое тело конфликтует. Retention сохраняет unfinished keys и удаляет только старые завершённые записи.                                                                                                                                                   |
| A20 | API/NVML fixture: HTTP unload недостаточно, ждём PID и allocation. Проверен allocation, живущий дольше таймаута остановки: повтор запуска блокируется до освобождения. Настоящий unload убрал allocations старых собственных PID на обеих GPU.                                                                                                            |
| A21 | Router/model-child crash снимает ready без auto restart. Core crash обнаруживает собственных потомков даже после смерти leader; остановка через проверенную identity/pidfd, чужие процессы не затрагиваются. Ручной повтор после разрешения ошибки разрешён.                                                                                              |
| A22 | UUID связывает разные NVML/CUDA индексы на двух настоящих GPU. Отказ отдельного датчика и всего GPU collector оставляет null/error и last_success; не подставляет 0.                                                                                                                                                                                      |
| A23 | API подтверждает независимый 1 Hz collector, накопление без браузера и новую сессию после restart. Buffer ограничен 3600 samples в RAM; счётчики живут всю сессию. Browser восстанавливает историю при повторном открытии страницы. Длительность фактического наблюдения и граница проверки указаны ниже.                                                 |
| A24 | Нагрузка 230 MiB: retained 209472509 bytes, 202 segments, gap=true, старый segment HTTP 404, health OK. Длинные строки ограничены и marked truncated. Core/router/model/build входят в общий persistent catalog.                                                                                                                                          |
| A25 | Реальный browser EventSource через Vite: snapshot, reconnect и смена session. Задержанный HTTP response/события retired session не перезаписывают новое состояние. Временный отказ management GET восстанавливается без reload страницы. Медленный socket с SO_RCVBUF=1024 получил gap, затем snapshot; health latency 1.09 ms, producer закончил работу. |
| A26 | Установленный OpenAI JS SDK: discovery, strict media json_schema, chat_template_kwargs, SSE, сохранение 409 preset_not_active. Настоящий voice_worker: context и translation exit 0, ответы chat.completion. Это проверка транспорта/контракта, не качества tiny-модели.                                                                                  |
| A27 | Loopback bind, Host/Origin restrictions, согласованный management error envelope. Чужой web-origin не меняет настройки; management/router autoload не проксируются через `/v1`.                                                                                                                                                                           |
| A28 | Утверждённый вариант A реализован в существующем web-client. 15 browser-сценариев проверяют action bars, запуск только из header, raw editor, downloads, build live logs, deletion preview, system/history. Дополнительно интерфейс просмотрен на настоящих GPU/модели.                                                                                   |
| A29 | Gitlink закреплён на 82d6bb284d1ff1c6ef37f29a4c3b63d1a8b11806. `data/` и `target/` ignored; Git status не содержит весов/SQLite/кэшей/build artifacts. Второй копии SmolLM в глобальном HF cache нет.                                                                                                                                                     |

## Настоящая модель и границы проверки

- `bartowski/SmolLM2-135M-Instruct-GGUF`, commit
  `09816acd5d99df7be770d85ea30822623dab342c`.
- `SmolLM2-135M-Instruct-Q4_K_M.gguf`, 105454432 bytes,
  SHA256 `2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d`.
- RTX 4070 Ti: CUDA index 0 / NVML index 1,
  UUID `GPU-4285af60-14a3-e67a-ca06-cb7c9afad6ce`.
- RTX 5080: CUDA index 1 / NVML index 0,
  UUID `GPU-b4cb0aff-7e56-1711-f4a9-6b2379de4c1f`.
- Перед unload настоящий model PID удерживал 423624704 bytes на 5080 и
  322961408 bytes на 4070 Ti. После unload его PID отсутствовал в compute allocations.
- SDK получил 18 настоящих SSE chunks; отдельный drain завершил 1024-token request.
  Отмена клиента учитывается отдельно от успеха и upstream error.

SmolLM 135M выбран для дешёвого технического прогона. Он выдавал дублирующийся текст
в strict translation schema; context worker достигал лимита 2048 и использовал
предусмотренную обработку invalid response. Рабочее качество перевода/секретаря этим
не подтверждается: потребителям нужна подходящая модель и контекст.

Upstream router объединяет stdout/stderr дочерней модели до передачи core. Core
сохраняет доступный stream, классифицирует forwarded `[port]` как model и связывает
его с instance/build; восстановить исходное разделение двух child streams невозможно.
Порядок независимых потоков не обещается.

Непрерывный часовой soak не проводился. Настоящая сессия накопила 2444 samples
с 17:47:49 до 18:28:32 UTC (40 минут 43 секунды), независимо от переходов/перезагрузок
браузера. Ограничение 3600 samples подтверждено реализацией collector; накопление
и восстановление истории — API/browser-проверками. После штатного restart буфер и
счётчики начали новую сессию.

## Итоговый прогон

- Обычный Rust-набор: **102 passed, 0 failed**, 2 аппаратных теста исключены
  из стандартного запуска и выполнены отдельно.
- Настоящая CUDA-сборка pinned upstream: **passed, 302.17 s**.
- Настоящее UUID-сопоставление двух NVIDIA GPU: **passed, 1.40 s**.
- Browser через Vite + core: **15 passed, 19.5 s**.
- Существующие web unit tests: **33 passed**.
- Cargo fmt, clippy all-targets `-D warnings`, targeted oxlint/oxfmt,
  web typecheck и production build: **passed**. Повторная генерация OpenAPI/TS
  даёт побайтово идентичные файлы.
- Финальные OpenAI SDK, media worker и lifecycle smoke: **passed**.
  Новый core начал empty; пресет загружен отдельной командой.
- Финальный session id: `980b00cc-6079-4bf2-a1f8-c7a4dde2236e`;
  instance id: `48c8e857-13b0-44cf-b21e-4bf633b90f96`.
  Runtime ready, in-flight 0, 25 model log entries сопоставлены этому instance.
  Driver `615.71.09`: compatibility passed, VRAM sensors available на обеих GPU.
- Проверочный интерфейс оставлен на `http://127.0.0.1:5190/models?view=manage`,
  core — `http://127.0.0.1:3290`. Обычные команды запуска и порты 3188/5173
  описаны в [README](../../../apps/core/README.md).

Веса, SQLite, compiler artifacts и логи находятся только в ignored data/target.
Системные службы и настройки ОС не создавались.
