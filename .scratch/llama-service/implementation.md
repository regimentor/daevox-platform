# Реализация llama-service

Status: claimed

Пользователь разрешил реализацию всей spec.md через TDD и продолжение до завершения.
Согласованные seams: HTTP/SSE core; запуск процесса core; web-client через реальный API.
Работа ведётся вертикально: один failing behavior test → minimal implementation → green.

## Выполнено

- npm workspace apps/core; Rust Tokio/Axum; lockfiles; loopback binary.
- A16, empty: GET /v1/models пуст; POST inference → 503 no_active_model. Два HTTP red→green.
- A01, lock: второй процесс не получает data; после смерти владельца lock освобождается. Process red→green.
- Settings: SeaORM/SQLite migrations, persistence, positive values, revision conflict, persistent idempotency (HTTP/process tests).
- A02: WAL backup при failure миграции проверен.
- A27 частично: Origin/Host guard.
- A12/A14 частично: INI create/read/update, raw text, revisions/overwrite, diagnostics, duplicate option aliases, catalog.
- Runtime empty snapshot + new session per restart.
- llama.cpp submodule добавлен с pin из spec; git submodule add staged .gitmodules и gitlink, затем set-url изменил .gitmodules (нужно stage актуальный URL при будущем commit).

## Текущий срез

- Настоящий CUDA build через POST /builds прошёл (299.37 s): 8 jobs, native architectures, devices, empty router health, candidate not applied. Test ignored по умолчанию, запущен явно; tmp fixture уже удалён.
- Build concurrency, cancel process group, live logs read, restart interrupted, recovery barrier и pidfd stop проверены red→green.
- Build apply с external fake compiler/router прошёл: new empty router + current build.
- Следующий срез: runtime switch/load + INI compiler + inference proxy; затем drain/force/cancel.
- Build/operation tables и API реализованы, негативный build тест green.

## Остаётся

- Settings revision/idempotency/validation; migration backup/failure, recovery.
- INI raw editor, diagnostics, scoped compiler, revisions/overwrite.
- Build submodule pin, CUDA/CPU configure/build/logs/cancel/apply.
- Runtime router/process identity, switching/drain/cancel/force, inference streaming.
- Hub metadata, model sets/shared files, download-worker queue/resume/pause/cancel.
- Metrics/log rotation/SSE snapshot/reconnect; API schemas and generated TS client.
- Real UI based on approved prototype A; consumer configs and compatibility.
- Full A01–A29 acceptance on this machine. Не отмечать выполненным только по прототипам.

## Окружение проверок

Cargo cache: /tmp/daevox-rust-adapter-validation/cargo-home; CARGO_HOME используется только в командах.
Loopback sockets запрещены sandbox; cargo test запускается с auto-reviewed require_escalated.
При fetch пригодились CARGO_HTTP_MULTIPLEXING=false CARGO_HTTP_TIMEOUT=20.

## Известные незакрытые детали

- Логи пока прямые build.log/router.log, нет общей ротации/ограничений/SSE.
- Process recovery пока leader record; потомки после смерти leader ещё требуют покрытия. Probe build router не записывает ownership record.
- Runtime apply пока только empty; drain для ready предстоит. Current build restore, auto build, build delete ещё не реализованы.
- Preset catalog пока can_launch=false для всех, нет scoped compile/удаления.
- Preset file writes и request_keys пока не защищены crash journal между файловой записью и SQLite commit.
- INI option map получен из help pinned binary; нужно сохранить воспроизводимый генератор, проверить negative aliases.
- Последний общий быстрый прогон: 21 тест прошли; CUDA test отдельно green. Последующие apply/recovery изменения проверялись целевыми тестами.
- Test Core Drop теперь SIGINT + ожидание до секунды для cleanup router (раньше kill_on_drop оставлял fixture; известный PID 207719 удалён).

## Продолжение реализации

- Runtime switch load/unload, captured INI (scoped [*], relative file resolution), ready active, /v1/models и прозрачный inference.
- Streaming body guard/inflight, waiting admission closed, sequential router unload + child PID/start-time checks before new instance. Accepted stream→DONE before switch test green.
- Cancel waiting preserves old; force aborts stream without DONE; cancel loading stops new router then empty. Targeted red→green.
- HFClient 1.0.0 metadata search/files with pinned commit, roles weights/shard/projector. Main disables implicit token before starting Tokio. Anonymous metadata fixture green.
- Download queue + separate `core download-worker <manifest>` subprocess; selected file metadata, full download publication, model set dedup.
- Pause/progress/restart/resume with strict Range/If-Range/ETag/size checks passed against timed HTTP fixture (4 MiB).

Текущий green: `cargo test --test downloads a_paused` (2026-09-13). Все команды используют CARGO_HOME=/tmp/daevox-rust-adapter-validation/cargo-home. Полный быстрый набор после последних изменений ещё не запускался.

Дополнительные остатки:
- Runtime monitor for router crash, drain timeout acceptance, phase metadata consistency, final cancellation race, apply with active model/drain, persist current build/selected preset, auto build.
- Download cancel/restart-file, invalid Range negative tests, shared-file lifecycle, deletion/reference revisions, queue pause race, queue recovery barrier.
- Metadata search cursor пока null (first 20 only); full diagnostics/map negative flags и path whitelist.
- Logs still primitive direct files; rotation/SSE/metrics/schema/UI entirely pending.
- Public DTOs partly dynamic Value; full typed OpenAPI generation pending. Keep implementation claimed until full A01–A29 done.

## Следующий проход (2026-09-13)

- Metrics: sysinfo/NVML, anchored 1 Hz, per-sensor value/availability, 3600 RAM-only samples; hardware HTTP test green.
- SSE: snapshot/session/seq, bounded broadcast128, reconnect gap and snapshot, keepalive, runtime/settings/operation/preset polling100ms and metric.sample. External INI notification+metrics green. Atomic cached snapshot/subscription; NOT yet authoritative mutation journal; intermediate states can coalesce, model-set/build/log events still pending.
- Restore current build and last selected preset (migration m0005); no model autoload. Restart test green.
- Build apply ready+drain+empty, cancel waiting preserves instance; force handler accepts build_apply. Apply phase/final cancellation and atomic flag persistence still need finishing.
- Preset catalog can_launch, captured applied_revision, duplicate-name diagnostics; DELETE revision+idempotency preserves running inference. Catalog still hashes model path instead of DB model-set identity.
- Build DELETE unused artifact implemented; current/previous/busy protected.
- Bounded log capture pipes: queues128, line splits8192B/truncated, segments1MiB, total200MiB, dropped_before; build and router capture incl build probe. GET log segments/download and cursor/gap tests. Rotation stress not run; cursor file-order can miss later appends to older segments; core/model tags, live log SSE, efficient cursor index, final drain of logging tasks still pending.
- Router crash monitor closes ready state without reload; record expansion discovers owned descendants after leader death (marker+group+boot), pidfd stop test green. Multiple descendant records dedup and stop confirmation, probe ownership, shutdown full process tree still pending.
- Fast suite last full green 41 tests before latest slices; clippy fixes applied; full suite currently running again.
- Failed crash test orphan child PID289981 explicitly removed through pidfd after marker+exact fixture command verification. No other matching test orphans found.

README and earlier remaining list above are stale inventories; final documentation and complete A01-A29 proof are still required. No frontend/schema work yet. Do not stop at this checkpoint.

## HTTP/браузер и настоящий запуск

- `tools/export-options.cpp` + `export-options.sh` экспортируют actual args/env/negative aliases/type metadata pinned llama.cpp. Map regenerated from cached pinned build; negative boolean and invalid integer diagnostics tests green. Still need additional router-owned/output/path restrictions and scoped cross-section diagnostics.
- Startup automatic CUDA candidate (default8jobs), CORE_AUTO_BUILD=0 test harness only; health endpoint added. No model autoload.
- Model references preview/revision DELETE; source preserved, shared files protected. Catalog maps downloaded model-set ID and reports actual missing files. Still fallback modelpath hash for standalone local test files; absent/path security and active/shared/shards acceptance incomplete.
- OpenAPI at /openapi.json generated by tools/contract.py; TS DTO/client generated from it by tools/generate-client.py. npm script contract. Private @daevox/core/client export; web runtime dependency localworkspace. Full schema validation/runtime DTO parity still incomplete (EventEnvelope payload includes unknown; types remain dynamic backend).
- UI under /models library and /models?view=manage: approved A overview, INI raw editor/conflict overwrite, system settings+live sensors, builds (live logs/cancel/apply/delete), logs (filter/search/download), Hub search/files pinned download/create INI. Header explicit launch/unload/force/cancel; Header download status and pause/resume/cancel. No simulated product data.
- Browser tests config playwright.core.config.ts: real Cargo core at3188, Vite5188, external Pythoncompiler/router and NodeHTTP Hub3199 fixtures; data mkdtemp cleanup. Public seams only. 6 tests passed together; later header actual load/unload, downloadcontrols, globaldownload tests passed targeted. Full combined needs cancelled-selection redo fix.
- Web typecheck and existing AppHeader theme test green; formatting/lint/fullsuite still needed. Existing AppHeader kept Anchor href so standalone Storybook/test works without router provider.

### Running real service (DO NOT lose this handle)

`exec_command` session **66603** runs actual app core port **3290**, origin **http://127.0.0.1:5190**, CARGO_HOME cache path above. Uses actual apps/core/data ignored directory. Automatic **real CUDA build succeeded** (new artifact kept). POST downloaded SmolLM2-135M Q4_K_M from commit09816acd5d99df7be770d85ea30822623dab342c, **105454432 bytes succeeded**. Model set ID f2bb67aa7fcd3cd8b8a3469b212c36b4f17703cd119e84e597f05d83c99e42f9; operation379b6f4f-2bcc-4397-9bcc-edd1cf867e2c.

Now `/tmp/daevox-real-core-smoke.py` applies build, creates `apps/core/presets/smollm-validation.ini`, explicitly loads with GPU layers99/tensor-split1,1, requests strict JSON. Tool exec running/result to inspect. Capture evidence in validation, then eventually unload/shutdown own service or leave clear run instructions.

### Important remaining defects/tasks discovered

- Cancelled selection POST /downloads with new key currently returns cancelled op forever. Must allow a fresh download; full browser suite globaldownload after cancel will fail until fixed.
- Shared/sharded weights live per-file ID dirs, but llama.cpp expects shard siblings together. Need bundle symlinks/hardlinks (no duplicate weights) and complete shard/projector selection validation + real shard test.
- Pause/resume operation allowed_actions stale after claim; updated_at never advances in downloads. Final cancellation/publication race and file-system/DB crash journal still pending.
- SSE cached polling can coalesce phases; source/modelsets/build/log events not all authoritative; client sequence filtering currently accepts any changed session and concurrent refresh may reorder. Actual Vite reconnect/gap slowclient test pending.
- Header TPS always unavailable until inference telemetry implemented. CUDA UUID→index mapping (actual CUDA order4070Ti then5080; NVML inverse), per-sensor last_success/process metrics and60mingraphs pending.
- UI deletion preview/recovery and graph history pending; globaloperationerrors and full saved/applied actionbar pending; entire docs/config/consumer SDK compatibility still needed.
- Core shutdown SIGTERM/tree cleanup, migration/key expiry7days completion, process groupdescendant duplicate record/cancelrace, apply atomic persistence/rollback errors, strict routing/model/autoload/jsonerrors, total logrotation stress + cursor reorder amongstreams, crash-safe file actions unresolved.

Task remains claimed. User explicitly said continue until complete; DO NOT end with partial completion.

## Продолжение реализации: подтверждённые исправления

- Полный browser suite из 9 сценариев прошёл. Дополнены зелёные сценарии preview/delete model set, восстановление графиков после reload и delete INI (теперь 12 сценариев; общий прогон после новых изменений ещё нужен).
- Полный Rust suite: 63 быстрых теста зелёные на предыдущем checkpoint. Затем добавлены зелёные HTTP/process тесты shutdown SIGTERM, retention и path restrictions; полный повтор ещё нужен.
- Shards: validation полного одного квантования и максимум одного projector; новые файлы размещаются в общей repo+commit директории с сохранением Hub-relative path. Нет копирования весов. Старые записи per-file ID по-прежнему читаются, reuse старых путей после апгрейда требует проверки.
- Inference telemetry в RAM: request/instance/preset/applied revision/build id, success/failure/cancel counters, actual usage, streaming substantive TTFT, duration и TPS только из llama timings. Header показывает measured TPS только для текущего instance и до60сек. Требуется проверить неполный SSE EOF/error и timeout stale; process metrics ещё отсутствуют.
- CUDA driver libcuda.so.1 UUID discovery без context/alloc; сопоставление с NVML. Отдельный ignored workstation test вручную пройден: 4070Ti CUDA0,5080 CUDA1, обратные NVML indices.
- SessionCharts: GET history + текущие метрики, CPU/RAM/GPU, разрывы при missing/lag, счётчики. Нет per-core/VRAM графиков пока.
- Нормальный SIGINT/SIGTERM теперь controlled_app+Shutdown: stop admission/listener, force streams, cancel op flags, queue stopping flag, verified pidfd cleanup с descendants, interrupted/paused persistence. SIGTERM+restart test зелёный. Ещё проверить build probe ownership, late spawn и active SSE shutdown, неравномерные descendantrecords и exe replacement.
- Retention: request expiry для async команд вычисляется от terminal updated_at; paused/unfinished без expiry. Старые terminal ops7days удаляются; modelset pointer nullable. Startup fixture test зелёный. prune выполняется startup/command replay, periodic/list idle retention pending; concurrency of terminal completion/requestkeys still to audit.
- Убрана runtime→DB lock inversion в terminal save (snapshot dropped before save). Loading operation phase синхронизирован с runtime, test зелёный. Cancel finalization race/current flags atomicity остаются.
- Log cursor global append order теперь независим от возраста файла; тест позднего router stdout после нового build сегмента зелёный. Bounded last500 BTreeMap; scans всех сегментов остаются, stress200MiB/late gap/coredownloadsource/log SSE ещё нужны.
- INI path canonicalization ограничена data/models и presets; mmproj-url, external log/output/web paths, HF/RPC и lookup dynamic/static paths заблокированы; json-schema-file добавлен. Lora CSV/scaled options, полный scoped diagnostics/aliases и часть numeric validation ещё нужны.
- Добавлен tools/validate-consumers.mjs. Реально пройден OpenAI SDK на3290: models, media translations strictschema,57outputtokens/45prompt,18streamchunks,409preset_not_active preservesSDKfields. Маленькая модель дала формально валидный JSON с плохим переводом; не заявлять качество. Реальное приложение media worker ещё не прогнано.
- Consumer defaults/examples изменены с8080 на3188; .env.example содержит CORE_PORT/WEB_ORIGIN/PROXY_TARGET и concrete smollm-validation preset. Настоящие секретные env не читались/не менялись.
- management malformedJSON envelope test RED затем normalization access.rs реализована; последний процесс test session78092 нужно проверить.
- Последние активные реальные процессы по-прежнему core session66603(старыйbinary,3290,modelactive) и Vite28138(5190). CUA tab1 привязан coreTab, визуально подтверждена реальная модель/GPU/вариантA. Перед финальной проверкой нужен unload+restart actualcore на последнюю версию.

Остаток предыдущих списков требует сверки, а не повторной реализации уже закрытого. Задача НЕ завершена; не останавливать работу на checkpoint.

### Последний checkpoint

- Полный cargo test после SSE/unknown-size/path/log fixes: **71 passed, 2 ignored**. Потом добавлены зелёные process metrics, late cancel race и child-crash tests (общий прогон после них ещё нужен).
- logs live broadcast128 → SSE log.append, build.changed, catalog revisions model_sets/builds теперь есть; test зелёный. EventEnvelope TS пока payload unknown, snapshot polling/coalescing и slow-consumer stress остаются.
- Telemetry early EOF без DONE теперь failed; chunks с error не должны превращаться в success. Test зелёный.
- Неизвестный LFS size: Hub adapter использует lfs.size, прогресс unknown total=null, download bytes после успеха берутся с диска, speed считается по delta текущей попытки без старого partial. Test зелёный.
- Process metrics: verified root-owned PIDs + descendants из всех task threads, sysinfo CPU/RAM и NVML compute allocations. UI System details добавлены. last_success retention и per-sensor error distinction ещё не реализованы.
- Поздняя cancel/readiness гонка воспроизведена externalrouter ctx888 + public logs. Финализация runtime теперь получает DB tx до проверки cancel и state publication. Test зелёный. Build apply finalization ещё не перенесена на такую транзакцию.
- Реально отсутствующий завершённый файл теперь запускает новую download operation при новом key; старый success не маскирует потерю файла. Стабильные local_path из model_files сохраняются (legacy per-file dir reuse). Test зелёный.
- Model child crash при живом router: monitor проверяет /models вне state locks, перепроверяет instance/state, закрывает ready без autorestart; тест зелёный.
- README переписан под реально реализованный сервис. Clippy последним прогоном нашёл только collapsible_if в logs; исправлено, повтор нужен. .gitmodules staging URL ещё не исправлен.

Текущие серьёзные остатки: подтверждение остановки descendants+NVML allocations в RouterProcess.stop и на error branches; build probe ownership и finalcancel/atomiccurrent flags; recovery refresh после самопроизвольного выхода остаточного процесса/queue barrier; операции с FS/DB crash consistency; retention periodic; полные INI CSV/scaled path aliases/scoped errors; source/model/core log classification и rotationstress; event schema/session client recovery; настоящий latestcore restart + повтор SDK/вызов media worker + доказательства A01–A29; формат/lint/fullweb/core suites. Actualcore3290 всё ещё старыйbinary/modelactive, Vite5190 работает, CUA coreTab/tab1 показываетSystem. Нельзя завершать работу как выполненную на этом checkpoint.

## Проход 2026-09-13 17:50 UTC — НЕ финальный статус

- Все 93 быстрых Rust HTTP/startup теста прошли, 2 аппаратных ignore проверялись вручную ранее. Clippy all-targets -D warnings прошёл до последних небольших правок. Typecheck, 33 web unit tests, production web build прошли; сборка сообщает только старый большой chunk voiceover. Browser suite 14 сценариев: первый общий прогон 13/14 (неоднозначный RAM locator после добавления графиков); локатор уточнён, повтор запущен session61390.
- Streaming telemetry теперь получает prompt_n/predicted_n из реальных llama timings при отсутствии usage. TDD green.
- Runtime monitor обновляет recovery, если остаточные процессы сами завершились. Download queue ждёт recovery. Оба TDD green.
- NVML внешний C fixture tests/fixtures/nvml.c проверяет задержку GPU allocation после выхода PID. Runtime unload, build apply и failed model load ждут resources_released. Router.stop ждёт рекурсивных descendants и allocation; readiness timeout и HTTP load error явно stop(). Health probe сборки owned token+group+record и реагирует на cancel. Late apply cancellation + current/previous/op финализируются транзакционно. Все целевые RED→GREEN.
- Per-sensor last_success_at сохраняется при ошибках (сопоставление массивов по id/pid/name/gpu_id). Utilisation/error тест green. ВАЖНО: VRAM memory_info и process GPU error ещё используют value() и помечаются unsupported, следует довести до sensor().
- Новый source_change.rs: durable undo journal before/after/key для INI create/save/delete, startup reconcile до prune. Реальное SIGKILL между FS и SQLite commit воспроизведено на внешнем SQLite delay trigger; все три сценария green. При внешнем конфликте журнал останавливает startup, не перезаписывает внешний текст. Неуспешные request_keys inserts также откатываются. eprintln storage errors заменён fallible writeln(stderr), закрытый stderr больше не обрывает error response.
- Новый file_removal.rs: удаление model-set/build сначала rename в data/runtime/removals/UUID, commit ключа затем cleanup; на ошибке rollback, startup reconcile по ключу. Tests failed deletion сохраняют available model/candidate runnable. Crash тест removal пока отдельно не прогонялся.
- Download publication теперь hard_link подтверждённого partial в models (не заменяет существующий destination), metadata model_files/model_sets/operation success в одной tx, cancel/pause reread перед публикацией. Worker пишет completed.json после sync успешного файла; повтор после publication failure использует этот результат без сети. Guard удаляет только созданную текущей попыткой hard link при совпадении inode с сохранённым partial. После commit очищает только partial links с тем же inode. TDD publication failure/offline retry и cleanup staging green.
- **Auto-review один раз отклонил старый вариант guard, который мог удалить existing destination. Сообщено пользователю. Изменение НЕ выполнялось. Принят безопасный вариант выше; остающихся approval blocks нет.**
- **Остаток publication:** startup reconcile незакоммиченных hard links / cleanup после committed crash ещё не сделан. Late cancel после успешного worker сейчас возвращает cancelled без удаления его partial; обычный cancel tick удаляет каталог. Queue error finalization по-прежнему двумя writes, late pause/cancel после workerfail может теряться. Проверь при доведении.
- OpenAPI EventEnvelope теперь concrete discriminated oneOf для 9 видов событий, TS regenerated. UI uses generated EventEnvelope. Retired sessions Set: только snapshot может переключить session, старые события игнорируются; browser replay реальных метрик RED→GREEN.
- Header download показывает repo/file и процент внутри RingProgress; provider получает modelSets. Browser RED→GREEN.
- Форматирован frontend/coregenerated/resources. npm core contract теперь включает oxfmt generated/client.ts resources/openapi.json. Root oxfmt/oxlint ignore apps/core/vendor/, чтобы не проверять upstream submodule. Механические lint исправления no-shadow/null equality; targeted oxlint clean. Source chunks теперь читабельные после oxfmt.
- Log stress `/tmp/daevox-log-stress.py`: внешний compiler пишет230MiB за62.32s; total retained209472509bytes (<200MiB),202segments, cursor gap=true, старый segment404, healthok. Tempdir удалена, процесс завершён. Все логи bounded и реальная ротация подтверждены.

### Актуальный реальный core (важно для продолжения)

- Старый core PID452403/session65451 штатно выгружен op d4968fa0-7174-4e33-bd9f-fbc738a27244 и SIGTERM, session завершена0.
- **Новый core exec session91864** запущен apps/core `CORE_PORT=3290 CORE_WEB_ORIGIN=http://127.0.0.1:5190 ./target/debug/core`. Session UUID **9993e1aa-cd69-4045-906e-804d72aca2bd**. PID можно получить /metrics processes rolecore.
- Vite session28138 всё ещё работает5190→3290. CUA coreTab browser1 tab1 открыт на http://127.0.0.1:5190/models?view=manage, выбрана Система. Последняя screenshot визуально хороша,133samples,2GPU32threads62.1GiB,headeractualTPS1024.6.
- Current build95afbca1-6971-4fba-b9b7-32ff99b09410, preset smollm-validation, revisionddb022ad23f4bdfe174581dc2958f23800d5a2a19fc8563f8fa2f964ec5c8aec; latest instance **94280a1c-43ac-4405-8b90-6edd24bba633** после restore lifecycle.
- Real lifecycle script `/tmp/daevox-real-lifecycle.mjs` **passed**: client abort, drain keeps DONE+rejects new503model_switching, force closes withoutDONE, old owned NVIDIA allocations disappear, preset restored. Before unload modelPID532476 allocations423624704bytes5080 and322961408bytes4070Ti. Counters after: cancelled2,succeeded1,completiontokens1024. No foreign process touched.
- `validate-consumers.mjs` real updated core **passed**: strict translation schema,18SSEchunks,SDK409 code preserved,57completion/45prompt. SmolLM tiny output duplicates Hello instead proper Russian; transport/schema proof only, no quality claim.
- Actual media worker smoke `/tmp/daevox-media-core-smoke.py` earlier passed exit0 both modes. context returned finish_reason length1970tokens and context.invalid_response handled fallback; translation finishstop100tokens. Explain model limitation, do not claim quality.

### Остатки перед честным завершением

- Source/FS finish failures and crash publication reconciliation as above; Build compile finalization late cancel still old independent writes; router startup try_wait reap/drop descendants corner, resource-release timeout→recovery barrier should not allow overlap; process executable path '(deleted)' identity and duplicate recovery records still audit.
- GPU memory sensor errors classification, collector device-disappearance last_success semantics. Core/model log source and true instance_id correlation still missing (router logs token rather than instance UUID), core logs not in catalog. Need slow-SSE consumer stress explicitly; 60minute buffer source bounded3600 but no fullhour wait.
- Driver compatibility verification/deferred auto-build when runtime transitions empty not implemented beyond startup no-active condition. Config fingerprint stores actualtoolchain/cache/devices but driver change check pending.
- Full acceptance A01–A29 results doc still NOT written, README currently accurate overview but links implementation history. Need final artifact/docs, gitignored artifacts/statuscheck, submodule pin, final format/clippy/fullbrowser after remaining fixes. UI raw dirty tab state/VRAM graphs/missingfiles redownload/linkedpresetnavigation optional pending according spec scope.
- Do NOT end with partial status. User explicitly "делай пока не доделаешь".


## Завершение реализации — 2026-09-13

Актуальный результат находится в [матрице приёмки](validation/implementation-results.md).
Предыдущие checkpoint-записи описывают промежуточные состояния.

Закрыты восстановление незакоммиченной публикации файлов, ошибки/last_success
VRAM и GPU collector, core/model log sources и instance correlation, проверка
совместимости драйвера, отложенная автосборка, ручной retry после router crash,
барьер GPU allocation после таймаута, атомарная публикация build и поздняя отмена.
Browser восстанавливается после временного management GET failure без reload.
Сохранены воспроизводимые стрессовые и аппаратные сценарии в apps/core/tools.

Итог: 102 обычных Rust-теста + 2 аппаратных, 15 E2E, 33 web unit tests;
fmt/clippy/lint/typecheck/build прошли. Настоящая финальная CUDA-сборка заняла
302.17 s. SDK, media context/translation и abort/drain/force/unload проверены
повторно на финальном core. Ограничения tiny-модели и фактическая длительность
проверки метрик указаны в матрице, без утверждения часового soak или качества перевода.

Текущий проверочный core: exec session10887, порт3290; Vite session28138, порт5190.
Session UUID980b00cc-6079-4bf2-a1f8-c7a4dde2236e; текущий instance48c8e857-13b0-44cf-b21e-4bf633b90f96,
preset smollm-validation, build95afbca1-6971-4fba-b9b7-32ff99b09410.
Старый core531301/session91864 выгружен и завершён штатно.
