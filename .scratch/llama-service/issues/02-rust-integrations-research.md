# Интеграции Rust с Hugging Face, метриками и веб-клиентом

Status: resolved
Assignee: integrations_research
Type: research
Labels: wayfinder:research
Parent: [Локальный сервис llama.cpp на Rust](../map.md)

## Question

Какие библиотеки и границы интеграции подходят для Rust-сервиса на этой машине: Hub search, выбор GGUF/shards/mmproj, скачивание в директорию сервиса, revision, проверка целостности, прогресс, отмена и возобновление; нативный Rust-клиент против hf worker? Как получать CPU/RAM и метрики всех фактически установленных GPU? Какие ограничения есть у INI-парсеров, HTTP/SSE и хранения истории? Как существующий веб-клиент подключает отдельные backend и как секретарь/медиа обращаются к LLM? Сравнить минимальные варианты на первичных источниках и локальном коде, не выбирать продуктовую политику. Зафиксировать риски и проверки для следующего этапа; не писать код приложения.

## Answer

Исследование завершено: [Rust: Hub, метрики и существующие клиенты](../research/integrations.md). Нативный hf-hub 1.0.0 существенно шире прежнего клиента: доступны async API, Xet и типизированный прогресс; обнаружено расхождение README/docs по env-конфигурации, требуется pin версии. Отмена/resume и целостность нативного пути требуют испытания. Для NVIDIA доступны NVML bindings, CPU/RAM — sysinfo; фактические capabilities карт ещё не подтверждены. Обычный INI parser не гарантирует сохранение оформления. Веб-клиент уже использует отдельные proxy и SSE; секретарь/медиа ожидают OpenAI-compatible chat completions. Продуктовые политики не выбраны.

Контекст: ветка `research/llama-service-integrations`, commit `5ec5adda6f4fbcfd1b3ec9cecc532a0523302734`, файл `.scratch/llama-service/research/integrations.md`. Изолированный worktree `/tmp/llama-service-integrations`; отчёт скопирован в основной checkout, текущая ветка не переключалась.
