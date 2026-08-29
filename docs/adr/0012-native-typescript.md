---
status: accepted
---

# Нативный TypeScript в Node.js 26

Весь рукописный production-код, тесты, fixtures, scripts, examples и benchmark-код проекта пишется
в `.ts` и запускается напрямую встроенным type stripping Node.js 26. Разрешены только стираемые
конструкции TypeScript; loader, transpiler, emit, сгенерированные JavaScript-файлы, declaration-файлы
и source maps не входят в toolchain.

TypeScript 7 и типы Node.js являются dev-зависимостями только для `tsc --noEmit` и поддержки
редактора. Конфигурация использует `module: "nodenext"`, сохраняет явные `.ts`-расширения импортов и
проверяет весь рукописный код. Сгенерированные JavaScript-assets API-документации и исторические
спецификации `.scratch` остаются вне TypeScript-проверки.

Node.js намеренно не выполняет type stripping для TypeScript-файлов внутри `node_modules`.
Следовательно, рабочий контракт этой версии ограничен запуском из checkout: публикация и запуск
npm-пакета, содержащего исходные `.ts`, временно не поддерживаются. Возврат npm-дистрибуции потребует
отдельного решения о формате артефакта и не должен неявно добавлять сборку в текущий runtime.
