Status: resolved
Type: grilling
Blocked by: 01, 02

# Определить материализацию и владение значениями

## Question

Как framework создаёт корневой и вложенные экземпляры через public zero-argument constructors, присваивает поля,
обрабатывает setters, readonly/non-writable properties, constructor side effects и constructor failures? Определить, когда создаётся
частичный граф объектов, может ли он утечь при ошибке, и какие guarantees копирования, mutability и identity
получает прикладной код.

## Answer

Обработка разделяется на validation и materialization. Сначала framework полностью проверяет
конечное JSON-дерево и выполняет validators, не зависящие от экземпляров. Ни один application
constructor не вызывается, пока существуют клиентские violations.

Успешно проверенный граф материализуется bottom-up в порядке полей `static schema`: сначала
элементы массивов и nested classes, затем их родитель; корневой экземпляр создаётся последним.
Каждый JSON object контрактного типа создаёт новый экземпляр точного сохранённого constructor,
каждый JSON array — новый обычный mutable `Array`. Разные узлы не объединяются по значению.

Constructor вызывается синхронно, без аргументов и ровно один раз для соответствующего JSON object.
Результат должен быть объектом с `Object.getPrototypeOf(result) === BodyClass.prototype`. Framework
не обещает обнаружить экзотический constructor, вернувший иной объект с вручную подделанным тем же
prototype.

Проверенные поля записываются как own data properties без вызова prototype или instance setters:

- существующее own writable configurable data property получает новое значение;
- при отсутствии own property создаётся enumerable writable configurable data property;
- own accessor, non-writable/non-configurable descriptor или невозможность добавить поле являются
  ошибкой контрактного класса;
- TypeScript `readonly` остаётся только ограничением прикладного кода и не препятствует hydration.

Framework записывает каждый schema key. Присутствующее поле получает проверенное/материализованное
значение, а отсутствующее optional-поле — `undefined`; constructor default тем самым не становится
скрытым input default. Constructor-created свойства вне schema сохраняются.

Успешные экземпляры и массивы не замораживаются и не инвалидируются после HTTP-запроса; приложение
может сохранять их ссылки. Повторные чтения success cache одного route contract возвращают тот же
root instance.

Constructor exception, посторонний prototype результата и ошибка записи поля являются
contract/application bug: они дают безопасный `500`, не превращаются в client violation и не
публикуют неуспешный граф через body cache, middleware или handler. Framework не сохраняет и не
раскрывает частичный граф сам, но не может предотвратить публикацию `this` или иные side effects,
выполненные application constructor; constructors поэтому должны делать только дешёвую локальную
инициализацию.
