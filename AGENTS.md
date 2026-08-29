# AGENTS.md — Daevox monorepo

## Правила работы агентов

- Выполнять изменения кода, архитектуры и документации только по явному запросу пользователя.
- Использовать npm workspaces для управления modules репозитория.
- Перед изменением module прочитать ближайший к нему `AGENTS.md`; package-local правила имеют
  приоритет для файлов этого module.
- Общие dev-зависимости и orchestration scripts принадлежат корню, runtime-зависимости принадлежат
  конкретному workspace.

## Agent skills

### Issue tracker

Общие задачи monorepo хранятся в корневом `.scratch/`; для `lib/framework/` используется отдельный трекер внутри этого workspace. См. `docs/agents/issue-tracker.md`.

### Triage labels

Локальные задачи используют стандартный словарь меток триажа. См. `docs/agents/triage-labels.md`.

### Domain docs

Репозиторий использует многоконтекстную структуру документации. См. `docs/agents/domain.md`.
