# Возможности llama.cpp и окружения этой машины

Status: resolved
Assignee: runtime_research
Type: research
Labels: wayfinder:research
Parent: [Локальный сервис llama.cpp на Rust](../map.md)

## Question

Какие возможности управления одной активной моделью, INI-пресетов, reload, load/unload, readiness, логов и метрик реально доступны в конкретном исследованном commit llama.cpp? Как различаются router mode и самостоятельный процесс? Что происходит с выполняющимися запросами при unload/reload? Каковы фактические OS, CPU, все GPU, драйверы и toolchain этой машины, какие backend сборки доступны и какие зависимости отсутствуют? Разделить подтверждённые факты, чтение исходников и непроверенные гипотезы. Читать окружение без секретов, установок, сборок и изменения процессов. Зафиксировать commit источника и ссылки. Решение о runtime и политике не принимать.

## Answer

Фактическое исследование завершено: [Возможности llama.cpp и окружения машины](../research/runtime.md). Исследован upstream commit `82d6bb284d1ff1c6ef37f29a4c3b63d1a8b11806`; документированы router/INI/API, отличия LRU от ручного unload, асинхронное подтверждение остановки и доступное окружение. Гарантия graceful drain, runtime CUDA/toolchain и VRAM остаются явно непроверенными; решения об архитектуре не приняты.

Контекст: ветка `research/llama-service-runtime`, commit `109a117f9189119404e38ff7c6501d9192d31b86`, файл `.scratch/llama-service/research/runtime.md`; отдельный worktree `/tmp/llama-service-runtime-research`. Копия артефакта сохранена в основном checkout.
