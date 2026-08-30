---
status: accepted
---

# Прикладное состояние и lifecycle Application

`Application` принимает класс прикладного состояния и создаёт ровно один его экземпляр. Этот
экземпляр передаётся первым аргументом всем HTTP- и WebSocket middleware/handlers и владеет
необязательными lifecycle hooks `beforeAppStart`, `onAppStart` и `onAppClose`, чтобы прикладной код
мог подготовить и корректно освободить долгоживущие ресурсы без глобального singleton.

Состояние не передаётся в Worker jobs: jobs выполняются в изолированных workers и требуют
сериализуемого входа. Локальные `HttpRequestState` и `WebSocketSessionState` сохраняют собственную
область жизни и не заменяются общим состоянием приложения.
