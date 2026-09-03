Status: resolved
Type: grilling
Blocked by: 03, 04, 05, 06, 07, 08

# Определить доказательства готовности реализации

## Question

Какие public seam-, compile-time, malformed-input, inheritance, recursion, constructor, validator, middleware, cancellation,
runtime-registration и security cases обязаны доказать готовность реализации? Определить необходимые изменения
README, двуязычного JSDoc, generated API, HTTP capability docs, glossary и ADR, а также профили fuzz, stress,
benchmark, soak и mutation, которые нужно расширить и выполнить помимо `npm run verify`.

## Answer

Implementation acceptance требует public-seam matrix со следующими обязательными группами:

- positive minimal usage с nested classes, arrays, nullable/optional/required fields и field/root
  validators;
- negative TypeScript cases для schema keys/types/nullability, route body против handler/middleware,
  widened declarations и доступных статической системе inheritance/schema нарушений;
- startup/runtime registration: malformed metadata, getters/proxies, cycles/lazy references,
  snapshot mutation, fixed limits, plan reuse и atomic rollback;
- ingress: все descriptors, extra/missing/null fields, depth/value/violation limits, constructor и
  property failures, validator phases/order/throws/results, JSON Pointer и response ordering;
- lifecycle: lazy short-circuit, repeated/parallel `json()`, representation conflicts, cached
  success/failure identity, все middleware levels, cancellation и runtime registration;
- security и public surface: pollution keys, hostile returns, safe detail suppression, entrypoint
  exports и generated API.

Основной новый seam-test — `test/unit/http-route-json-body-contract.test.ts`. Дополнительно
расширяются `controller-static-types.test.ts`, `application.test.ts`, `http-transport.test.ts` и
существующие fuzz/stress/soak/mutation/benchmark harnesses. Production behavior проверяется через
public `@daevox/framework` entrypoint; узкие internal tests допустимы только для compiled-plan
machinery без наблюдаемого public seam.

Обязательные документы реализации:

- цельный usage и ограничения в `README.md`;
- bilingual JSDoc всего нового/изменённого `src/*.ts` и regenerated `docs/API.md`, `docs/api/*`;
- `docs/interface/http.md`, `middleware.md`, `errors.md` и `docs/system-testing.md`;
- сохранение канонического термина в `CONTEXT.md`;
- новый ADR для class/schema/validation/materialization/cache contract;
- обновление ADR 0009 для middleware-before-representation-parsing lifecycle;
- runnable `examples/http-json-body-contract/` с black-box test.

После расширения harnesses implementation обязана пройти из корня:

```sh
npm run docs:build --workspace @daevox/framework
npm run verify
npm run fuzz:full --workspace @daevox/framework -- --seed <recorded-seed>
npm run stress --workspace @daevox/framework
npm run benchmark:full --workspace @daevox/framework
npm run soak:scheduled --workspace @daevox/framework
npm run mutation:changed --workspace @daevox/framework
```

Benchmark получает отдельный `http-json-contract` profile, baseline и существующие regression
thresholds. Fuzz/stress/soak/mutation получают contract-specific cases. Full benchmark/soak нельзя
молча заменить smoke-профилями; недоступный или непройденный gate означает незавершённую acceptance
и явно передаётся следующему исполнителю.
