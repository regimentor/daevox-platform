# Rust: Hub, метрики и существующие клиенты

Дата: 2026-09-13. Исследование для решения, без выбора продуктовой политики и без установки зависимостей. Аппаратные данные переданы исследованием хоста: Arch Linux, Ryzen 9950X, около 62.1 GiB RAM, RTX 5080 и RTX 4070 Ti; фактическая доступность GPU API в sandbox не подтверждена.

## Hugging Face

**Предыдущее сравнение требует поправки:** `hf-hub` latest показывает 1.0.0, `HFClient`, асинхронные запросы, список содержимого, локальную директорию/кеш и Xet. Это существенно шире старого «минимального подмножества». [Документация crate](https://docs.rs/hf-hub/latest/hf_hub/).

| Область | Нативный Rust | Внешний hf worker |
|---|---|---|
| Поиск | `list_models`, фильтры, потоковая пагинация; точные фильтры проверить на pinned API | `hf models list` с поиском, фильтрами и JSON |
| Файлы | Обход дерева и download/snapshot APIs | `hf download` с файлами, include/exclude |
| Revision и каталог | API downloads и явный cache/local_dir | revision, local_dir/cache-dir; Python download API принимает commit/tag/branch |
| Прогресс | Типизированный callback с per-file и aggregate событиями | CLI прогресс есть; стабильность машинного incremental-протокола не подтверждена |
| Отмена/возобновление | Семантика прерывания Future, Xet и частичных файлов не проверена | Завершение worker даёт границу отмены, но сохранность partial и resume надо проверить |
| Целостность | Наличие отдельного verification API не установлено | Документирован `hf cache verify` для кеша и local_dir |

Источники: [Rust README](https://github.com/huggingface/hf-hub), [CLI](https://huggingface.co/docs/huggingface_hub/guides/cli), [download guide](https://huggingface.co/docs/huggingface_hub/guides/download).

`ProgressHandler` требует Send+Sync; callback нельзя блокировать, события завершения файла могут повторяться. Результат операции определяется возвращаемым Result, а не только Complete. Следствие для адаптера: короткий callback, ограниченная очередь и идемпотентный учёт по имени файла. [Progress API](https://docs.rs/hf-hub/latest/hf_hub/progress/index.html).

Состояние сопровождения: на странице официального репозитория доступен актуальный код, docs.rs публикует 1.0.0; сроки поддержки этим не гарантируются. Найдено расхождение: README main утверждает отсутствие чтения env, docs.rs — чтение HF_TOKEN/HF_HOME. Поэтому нельзя проектировать конфигурацию по смешанным версиям: pin crate/commit и явно задаваемые каталог и токен. Интеграционных испытаний библиотеки не было.

GGUF, shards и mmproj — прикладная семантика поверх файлов Hub. Ни просмотренный общий клиент, ни CLI не доказывают совместимость выбранного projector с моделью. В спецификации нужны manifest файлов с repository/revision, проверка полноты shards и явное сопоставление projector; автоматическую политику ещё выбрать. Скачивание всего `*.gguf` может захватить несколько квантований. Частичные файлы не следует объявлять готовой моделью. Это инженерные выводы, не гарантии Hub.

## Метрики

[`nvml-wrapper` 0.13.0](https://docs.rs/nvml-wrapper/latest/nvml_wrapper/) динамически загружает NVML при init; отсутствие библиотеки и отдельных функций возвращается ошибками. Поддерживает память, вентиляторы, мощность и другие NVIDIA показатели. На обеих NVIDIA картах нужен отдельный capability probe: успешный init не гарантирует каждую метрику. Хранить экземпляр NVML, не пересоздавать на каждом опросе. Неизвестные показатели обозначать unavailable; GPU идентифицировать стабильным идентификатором, а индекс сохранять отдельно.

[`sysinfo`](https://docs.rs/sysinfo/latest/sysinfo/) покрывает CPU, RAM/swap, процессы, диски и доступные температурные компоненты. CPU usage требует предыдущего измерения и интервала обновления; переиспользовать System, обновлять только нужные поля. Набор сенсоров Ryzen и полная инвентаризация GPU требуют проверки на хосте: NVML видит NVIDIA, возможное встроенное GPU требует отдельного источника. Чтение документации не доказывает работоспособность драйверов этой машины.

## INI, события, история

[`configparser`](https://docs.rs/configparser/latest/configparser/) по умолчанию нечувствителен к регистру, убирает пробелы, повторный ключ заменяет предыдущий, комментарии игнорирует. Это не lossless roundtrip. [`rust-ini`](https://docs.rs/rust-ini/latest/ini/) предоставляет чтение/запись INI, но просмотренная документация не гарантирует сохранение исходного текста. Для внешне редактируемых presets нужно отдельно решить сохранение комментариев, duplicate sections/keys и точную совместимость с parser llama.cpp. Возможны сырой текст + валидация либо каноническая перезапись с согласованными потерями оформления.

[Axum SSE](https://docs.rs/axum/latest/axum/response/sse/) поддерживает поток событий и keepalive. Доставка истории, Last-Event-ID, ограничения медленных клиентов и ротация логов остаются ответственностью приложения. [SQLite WAL](https://sqlite.org/wal.html) допускает параллельных читателей с писателем, но одновременно только одного писателя; checkpoint и retention нужны для ограниченного роста. Ни SSE, ни SQLite сами не задают частоту измерений и глубину истории. Альтернатива истории метрик — отдельная time-series система, однако дополнительный процесс не обусловлен текущими фактами.

## Локальная интеграция

- `apps/web-client/vite.config.ts`: dev-клиент слушает 127.0.0.1:5173, проксирует `/api` в основной backend и `/trancription-api/` в отдельный Python backend. Опечатка в существующем префиксе — фактический контракт. Production proxy описан отдельно в README; Vite proxy туда не переносится автоматически.
- `apps/web-client/app/transcription/client.ts`: уже есть fetch и EventSource, snapshot/revision и terminal events. Новый UI может использовать тот же стиль интеграции без нового приложения.
- `apps/backend/src/domain/secretary/summarizer.ts`: OpenAI SDK, `/v1`, `models.list()` при отсутствии заданной модели, chat completions, AbortSignal, timeout 180 s, maxRetries 0. При смене модели важно определить смысл стабильного ID и список доступных моделей.
- `apps/backend/src/domain/auto-reply/content.ts` и `secretary/summary-queue.ts`: используют LLAMA_BASE_URL, по умолчанию localhost:8080/v1.
- `apps/transcription-backend/src/transcription/voice_worker.py`: обращается к `/chat/completions`, timeout 300 s; использует json_schema. Одна активная модель не означает одного API-потребителя: переключение во время запроса требует отдельной политики.

Исходники прочитаны без `.env` и секретов; приложение не менялось.

## Проверки перед окончательной спецификацией

Pin hf-hub/hf и проверить поиск + gated errors; загрузку одного GGUF и shards/projector в service-local storage; interruption/restart/resume и повреждённый файл; callbacks/очередь; NVML capabilities обеих карт и остальные устройства; fixture INI с комментариями/дубликатами; SSE reconnect через production proxy. Это оставшиеся валидации реализации/прототипа, а не незаметно принятые продуктовые решения.
