# Фреймворк как module npm workspace

Репозиторий Daevox является монорепозиторием на npm workspaces, а фреймворк принадлежит
самостоятельному module `@daevox/framework` в `lib/framework`. Production-код и public entrypoint
лежат в `lib/framework/src`; тесты, примеры, benchmark, документация и исторические спецификации
co-located внутри module. Общая dev-toolchain остаётся в корне, а framework module сохраняет
нулевые runtime-зависимости.

Raw TypeScript по-прежнему запускается только из checkout: workspace self-reference внутри
`@daevox/framework` поддержан, импорт package через `node_modules` из другого workspace потребует
отдельного решения о distributable artifact согласно ADR-0012.
