import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  Application,
  HttpControllerBase,
  HttpRouteJsonBodyValidationError,
  InvalidHttpRouteJsonBodyContractError,
  bodyClass,
  integer,
  max,
  maxLength,
  min,
  minLength,
  required,
} from '../../src/index.ts';
import type { HttpRouteJsonBodyRootValidator, HttpRouteJsonBodySchema } from '../../src/index.ts';

class TestAppState {
  readonly marker = true;
}

function request(address: { address: string; port: number }, body: string, path = '/users') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const clientRequest = http.request(
      {
        host: address.address,
        port: address.port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    clientRequest.on('error', reject);
    clientRequest.end(body);
  });
}

test('HTTP-маршрут материализует JSON-тело в экземпляр объявленного класса', async () => {
  class UserBody {
    name!: string;

    static schema = {
      name: { type: String },
    } as const;
  }

  class UsersController extends HttpControllerBase {
    static prefix = '/users';
    static routes = [{ method: 'POST', path: '/', handler: 'create', body: UserBody }] as const;

    async create(_appState: TestAppState, context: any) {
      const body = await context.requestBody.json();
      return {
        status: 200,
        body: { isUserBody: body instanceof UserBody, name: body.name },
      };
    }
  }

  const application = new Application({ appState: TestAppState });
  application.registerHttpController(UsersController);
  const address = await application.listen({ port: 0 });

  try {
    const response = await request(address, '{"name":"Ada"}');

    assert.equal(response.status, 200);
    assert.equal(response.body, '{"isUserBody":true,"name":"Ada"}');
  } finally {
    await application.close();
  }
});

test('HTTP-маршрут рекурсивно материализует все JSON descriptors', async () => {
  class AddressBody {
    street!: string;
    apartment!: number | null;

    static schema = {
      street: { type: String },
      apartment: { type: Number, nullable: true },
    } as const;
  }

  class ProfileBody {
    active!: boolean;
    address!: AddressBody;
    aliases!: string[];
    absent?: null;

    static schema = {
      active: { type: Boolean },
      address: { type: AddressBody },
      aliases: { type: [String] },
      absent: { type: null },
    } as const;
  }

  class ProfilesController extends HttpControllerBase {
    static prefix = '/profiles';
    static routes = [{ method: 'POST', path: '/', handler: 'create', body: ProfileBody }] as const;

    async create(_appState: TestAppState, context: any) {
      const body = await context.requestBody.json();
      return {
        status: 200,
        body: {
          root: body instanceof ProfileBody,
          nested: body.address instanceof AddressBody,
          aliases: body.aliases,
          apartment: body.address.apartment,
          absent: Object.hasOwn(body, 'absent') && body.absent === undefined,
        },
      };
    }
  }

  const application = new Application({ appState: TestAppState });
  application.registerHttpController(ProfilesController);
  const address = await application.listen({ port: 0 });

  try {
    const response = await request(
      address,
      '{"active":true,"address":{"street":"Main","apartment":null},"aliases":["ada"]}',
      '/profiles',
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.body,
      '{"root":true,"nested":true,"aliases":["ada"],"apartment":null,"absent":true}',
    );
  } finally {
    await application.close();
  }
});

test('невалидная структура JSON-тела возвращает ordered violations и не вызывает HTTP-обработчик', async () => {
  let handlerCalled = false;

  class ScoreBody {
    score!: number;
    title!: string;
    ceiling!: number;

    static schema = {
      score: { type: Number },
    } as const;
  }

  class ScoresController extends HttpControllerBase {
    static prefix = '/scores';
    static routes = [
      {
        method: 'POST',
        path: '/',
        handler: 'create',
        body: ScoreBody,
        middleware: [
          async (_state: TestAppState, context: any, next: () => Promise<any>) => {
            await context.requestBody.json();
            return next();
          },
        ],
      },
    ] as const;

    async create() {
      handlerCalled = true;
      return { status: 204 };
    }
  }

  const application = new Application({ appState: TestAppState });
  application.registerHttpController(ScoresController);
  const address = await application.listen({ port: 0 });

  try {
    const response = await request(address, '{"score":"high","extra":true}', '/scores');

    assert.equal(response.status, 400);
    assert.equal(
      response.body,
      '{"error":"Bad Request","code":"INVALID_JSON_BODY","violations":[{"path":"/score","code":"INVALID_TYPE","message":"Expected finite number"},{"path":"/extra","code":"UNKNOWN_FIELD","message":"Unknown field"}]}',
    );
    assert.equal(handlerCalled, false);
  } finally {
    await application.close();
  }
});

test('неверный body contract отклоняется специализированной ошибкой без публикации маршрута', () => {
  class InvalidBody {
    value!: string;
  }
  class ValidBody {
    value!: string;
    static schema = { value: { type: String } } as const;
  }
  class InvalidController extends HttpControllerBase {
    static prefix = '/atomic-contract';
    static routes = [{ method: 'POST', path: '/', handler: 'create', body: InvalidBody }] as const;
    create() {
      return { status: 204 };
    }
  }
  class ValidController extends HttpControllerBase {
    static prefix = '/atomic-contract';
    static routes = [{ method: 'POST', path: '/', handler: 'create', body: ValidBody }] as const;
    create() {
      return { status: 204 };
    }
  }

  const application = new Application({ appState: TestAppState });

  assert.throws(
    () => application.registerHttpController(InvalidController as any),
    InvalidHttpRouteJsonBodyContractError,
  );
  assert.equal(application.registerHttpController(ValidController), application);
});

test('встроенные field validators агрегируют нарушения в declaration order', async () => {
  class MetricsBody {
    name!: string;
    tags!: string[];
    score!: number;

    static schema = {
      name: { type: String, validators: [required(), minLength(3)] },
      tags: { type: [String], validators: [required(), minLength(1)] },
      score: { type: Number, validators: [required(), min(10), integer()] },
      title: { type: String, validators: [maxLength(2)] },
      ceiling: { type: Number, validators: [max(1)] },
    } as const;
  }

  class MetricsController extends HttpControllerBase {
    static prefix = '/metrics';
    static routes = [
      {
        method: 'POST',
        path: '/',
        handler: 'create',
        body: MetricsBody,
        middleware: [
          async (_state: TestAppState, context: any, next: () => Promise<any>) => {
            await context.requestBody.json();
            return next();
          },
        ],
      },
    ] as const;
    create() {
      return { status: 204 };
    }
  }

  const application = new Application({ appState: TestAppState });
  application.registerHttpController(MetricsController);
  const address = await application.listen({ port: 0 });

  try {
    const response = await request(
      address,
      '{"tags":[],"score":1.5,"title":"😀😀😀","ceiling":2}',
      '/metrics',
    );

    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body).violations, [
      { path: '/name', code: 'REQUIRED', message: 'Required' },
      { path: '/tags', code: 'MIN_LENGTH', message: 'Must have length at least 1' },
      { path: '/score', code: 'MIN', message: 'Must be greater than or equal to 10' },
      { path: '/score', code: 'INTEGER', message: 'Must be an integer' },
      { path: '/title', code: 'MAX_LENGTH', message: 'Must have length at most 2' },
      { path: '/ceiling', code: 'MAX', message: 'Must be less than or equal to 1' },
    ]);
  } finally {
    await application.close();
  }
});

test('route middleware и HTTP-обработчик разделяют success cache body contract', async () => {
  class CachedBody {
    value!: string;
    static schema = { value: { type: String } } as const;
  }
  class CachedController extends HttpControllerBase {
    static prefix = '/cached-contract';
    static routes = [
      {
        method: 'POST',
        path: '/',
        handler: 'create',
        body: CachedBody,
        middleware: [
          async (_state: TestAppState, context: any, next: () => Promise<any>) => {
            context.state.fromMiddleware = await context.requestBody.json();
            return next();
          },
        ],
      },
    ] as const;
    async create(_state: TestAppState, context: any) {
      const [first, second] = await Promise.all([
        context.requestBody.json(),
        context.requestBody.json(),
      ]);
      return {
        status: 200,
        body: {
          same:
            first === second &&
            first === context.state.fromMiddleware &&
            first instanceof CachedBody,
        },
      };
    }
  }

  const application = new Application({ appState: TestAppState });
  application.registerHttpController(CachedController);
  const address = await application.listen({ port: 0 });

  try {
    const response = await request(address, '{"value":"shared"}', '/cached-contract');
    assert.equal(response.status, 200);
    assert.equal(response.body, '{"same":true}');
  } finally {
    await application.close();
  }
});

test('bodyClass поддерживает self-recursive schema и рекурсивную materialization', async () => {
  class TreeBody {
    value!: string;
    children!: TreeBody[];
    static schema: HttpRouteJsonBodySchema<TreeBody> = {
      value: { type: String },
      children: { type: [bodyClass(() => TreeBody)] },
    } as const;
  }
  class TreeController extends HttpControllerBase {
    static prefix = '/tree-contract';
    static routes = [{ method: 'POST', path: '/', handler: 'create', body: TreeBody }] as const;
    async create(_state: TestAppState, context: any) {
      const body = await context.requestBody.json();
      return {
        status: 200,
        body: {
          root: body instanceof TreeBody,
          child: body.children[0] instanceof TreeBody,
          value: body.children[0].value,
        },
      };
    }
  }

  const application = new Application({ appState: TestAppState });
  application.registerHttpController(TreeController);
  const address = await application.listen({ port: 0 });
  try {
    const response = await request(
      address,
      '{"value":"root","children":[{"value":"leaf","children":[]}]}',
      '/tree-contract',
    );
    assert.equal(response.status, 200);
    assert.equal(response.body, '{"root":true,"child":true,"value":"leaf"}');
  } finally {
    await application.close();
  }
});

test('root validator получает frozen input и возвращает violation с относительным path', async () => {
  let sawFrozenInput = false;

  class PasswordBody {
    password!: string;
    confirmation!: string;

    static schema = {
      password: { type: String },
      confirmation: { type: String },
    } as const;

    static validators = [
      ((body) => {
        sawFrozenInput = Object.isFrozen(body);
        return body.password === body.confirmation
          ? undefined
          : {
              path: ['confirmation'],
              code: 'PASSWORD_MISMATCH',
              message: 'Must match password',
            };
      }) satisfies HttpRouteJsonBodyRootValidator<PasswordBody>,
    ] as const;
  }

  class PasswordController extends HttpControllerBase {
    static prefix = '/password-contract';
    static routes = [
      {
        method: 'POST',
        path: '/',
        handler: 'create',
        body: PasswordBody,
        middleware: [
          async (_state: TestAppState, context: any, next: () => Promise<any>) => {
            await context.requestBody.json();
            return next();
          },
        ],
      },
    ] as const;
    create() {
      return { status: 204 };
    }
  }

  const application = new Application({ appState: TestAppState });
  application.registerHttpController(PasswordController);
  const address = await application.listen({ port: 0 });
  try {
    const response = await request(
      address,
      '{"password":"secret","confirmation":"wrong"}',
      '/password-contract',
    );
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body).violations, [
      {
        path: '/confirmation',
        code: 'PASSWORD_MISMATCH',
        message: 'Must match password',
      },
    ]);
    assert.equal(sawFrozenInput, true);
  } finally {
    await application.close();
  }
});

test('неверный результат body constructor наблюдается как application bug 500', async () => {
  const observed: unknown[] = [];
  class BrokenBody {
    value!: string;
    static schema = { value: { type: String } } as const;
    constructor() {
      return { value: 'wrong prototype' } as any;
    }
  }
  class BrokenController extends HttpControllerBase {
    static prefix = '/broken-contract';
    static routes = [{ method: 'POST', path: '/', handler: 'create', body: BrokenBody }] as const;
    async create(_state: TestAppState, context: any) {
      await context.requestBody.json();
      return { status: 204 };
    }
  }
  const application = new Application({
    appState: TestAppState,
    http: { onError: (_state, error) => observed.push(error) },
  });
  application.registerHttpController(BrokenController);
  const address = await application.listen({ port: 0 });
  try {
    const response = await request(address, '{"value":"input"}', '/broken-contract');
    assert.equal(response.status, 500);
    assert.equal(response.body, '{"error":"Internal Server Error"}');
    assert.equal(observed.length, 1);
    assert.ok(observed[0] instanceof TypeError);
  } finally {
    await application.close();
  }
});

test('body errors из validator и constructor классифицируются как application bugs', async () => {
  const observed: unknown[] = [];
  const thrown = new HttpRouteJsonBodyValidationError([
    { path: '', code: 'APPLICATION_FAILURE', message: 'Must remain private' },
  ]);
  class ValidatorBody {
    value!: string;
    static schema = {
      value: {
        type: String,
        validators: [
          () => {
            throw thrown;
          },
        ],
      },
    } as const;
  }
  class ConstructorBody {
    value!: string;
    static schema = { value: { type: String } } as const;
    constructor() {
      throw thrown;
    }
  }
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- local factory keeps this registration case self-contained
  const controller = (prefix: string, Body: any) =>
    class extends HttpControllerBase {
      static prefix = prefix;
      static routes = [{ method: 'POST', path: '/', handler: 'create', body: Body }] as const;
      async create(_state: TestAppState, context: any) {
        await context.requestBody.json();
        return { status: 204 };
      }
    };
  const application = new Application({
    appState: TestAppState,
    http: { onError: (_state, error) => observed.push(error) },
  });
  application.registerHttpController(controller('/throwing-validator', ValidatorBody) as any);
  application.registerHttpController(controller('/throwing-constructor', ConstructorBody) as any);
  const address = await application.listen({ port: 0 });
  try {
    for (const path of ['/throwing-validator', '/throwing-constructor']) {
      const response = await request(address, '{"value":"input"}', path);
      assert.equal(response.status, 500);
      assert.equal(response.body, '{"error":"Internal Server Error"}');
    }
    assert.equal(observed.length, 2);
    assert.ok(observed.every((error) => error instanceof TypeError && error.cause === thrown));
  } finally {
    await application.close();
  }
});

test('registration отклоняет inheritance и неподдерживаемые descriptors', () => {
  class BaseBody {
    value!: string;
    static schema = { value: { type: String } } as const;
  }
  class InheritedBody extends BaseBody {
    static schema = { value: { type: String } } as const;
  }
  class UnsupportedBody {
    createdAt!: Date;
    static schema = { createdAt: { type: Date } } as const;
  }
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- local factory keeps this registration case self-contained
  const controller = (prefix: string, Body: any) =>
    class extends HttpControllerBase {
      static prefix = prefix;
      static routes = [{ method: 'POST', path: '/', handler: 'create', body: Body }] as const;
      create() {
        return { status: 204 };
      }
    };

  assert.throws(
    () =>
      new Application({ appState: TestAppState }).registerHttpController(
        controller('/inherited-contract', InheritedBody) as any,
      ),
    InvalidHttpRouteJsonBodyContractError,
  );
  assert.throws(
    () =>
      new Application({ appState: TestAppState }).registerHttpController(
        controller('/unsupported-contract', UnsupportedBody) as any,
      ),
    InvalidHttpRouteJsonBodyContractError,
  );
});

test('registration проверяет built-in validator target и явно undefined metadata', () => {
  class WrongValidatorBody {
    value!: string;
    static schema = { value: { type: String, validators: [min(5)] } } as any;
  }
  class UndefinedValidatorsBody {
    value!: string;
    static schema = { value: { type: String, validators: undefined } } as any;
  }
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- local factory keeps this registration case self-contained
  const controller = (prefix: string, Body: any) =>
    class extends HttpControllerBase {
      static prefix = prefix;
      static routes = [{ method: 'POST', path: '/', handler: 'create', body: Body }] as const;
      create() {
        return { status: 204 };
      }
    };

  for (const [prefix, Body] of [
    ['/wrong-validator-target', WrongValidatorBody],
    ['/undefined-field-validators', UndefinedValidatorsBody],
  ] as const) {
    assert.throws(
      () =>
        new Application({ appState: TestAppState }).registerHttpController(
          controller(prefix, Body) as any,
        ),
      InvalidHttpRouteJsonBodyContractError,
    );
  }
});

test('bodyClass resolver выполняется один раз на compilation для общего descriptor', () => {
  let resolverCalls = 0;
  class ChildBody {
    static schema = {} as const;
    marker() {}
  }
  const child = bodyClass(() => {
    resolverCalls += 1;
    return ChildBody;
  });
  class ParentBody {
    first!: ChildBody;
    second!: ChildBody;
    static schema = {
      first: { type: child },
      second: { type: child },
    } as const;
  }
  class ParentController extends HttpControllerBase {
    static prefix = '/shared-resolver';
    static routes = [{ method: 'POST', path: '/', handler: 'create', body: ParentBody }] as const;
    create() {
      return { status: 204 };
    }
  }

  new Application({ appState: TestAppState }).registerHttpController(ParentController);
  assert.equal(resolverCalls, 1);
});

test('registration не вызывает schema accessors и отклоняет их как contract metadata', () => {
  let getterCalls = 0;
  const schema = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { type: String };
    },
  });
  class AccessorBody {
    value!: string;
    static schema = schema as any;
  }
  class AccessorController extends HttpControllerBase {
    static prefix = '/accessor-contract';
    static routes = [{ method: 'POST', path: '/', handler: 'create', body: AccessorBody }] as const;
    create() {
      return { status: 204 };
    }
  }

  assert.throws(
    () =>
      new Application({ appState: TestAppState }).registerHttpController(AccessorController as any),
    InvalidHttpRouteJsonBodyContractError,
  );
  assert.equal(getterCalls, 0);
});

test('registration не вызывает accessors в array descriptors и validator arrays', () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- local factory keeps accessor cases self-contained
  const controller = (prefix: string, Body: any) =>
    class extends HttpControllerBase {
      static prefix = prefix;
      static routes = [{ method: 'POST', path: '/', handler: 'create', body: Body }] as const;
      create() {
        return { status: 204 };
      }
    };
  let getterCalls = 0;
  const accessorArray = (value: unknown) =>
    Object.defineProperty([value], 0, {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return value;
      },
    });
  class ArrayDescriptorBody {
    values!: string[];
    static schema = { values: { type: accessorArray(String) } } as any;
  }
  class RootValidatorsBody {
    value!: string;
    static schema = { value: { type: String } } as const;
    static validators = accessorArray(() => undefined) as any;
  }
  class FieldValidatorsBody {
    value!: string;
    static schema = {
      value: { type: String, validators: accessorArray(() => undefined) },
    } as any;
  }

  for (const [prefix, Body] of [
    ['/accessor-array-descriptor', ArrayDescriptorBody],
    ['/accessor-root-validators', RootValidatorsBody],
    ['/accessor-field-validators', FieldValidatorsBody],
  ] as const) {
    assert.throws(
      () =>
        new Application({ appState: TestAppState }).registerHttpController(
          controller(prefix, Body) as any,
        ),
      InvalidHttpRouteJsonBodyContractError,
    );
  }
  assert.equal(getterCalls, 0);
});

test('HttpRouteJsonBodyValidationError проверяет и defensively snapshots violations', () => {
  const violations = [{ path: '/name', code: 'INVALID_NAME', message: 'Invalid name' }];
  const error = new HttpRouteJsonBodyValidationError(violations);
  violations[0].message = 'mutated';

  assert.equal(error.code, 'INVALID_JSON_BODY');
  assert.equal(error.status, 400);
  assert.equal(error.violations[0].message, 'Invalid name');
  assert.ok(Object.isFrozen(error.violations));
  assert.ok(Object.isFrozen(error.violations[0]));
  assert.throws(
    () =>
      new HttpRouteJsonBodyValidationError([{ path: '/bad~path', code: 'lowercase', message: '' }]),
    TypeError,
  );
});

test('первый опубликованный plan body class закрепляется в одном Application', async () => {
  class PinnedBody {
    value!: string;
    static schema: any = { value: { type: String } };
  }
  const controller = (prefix: string) =>
    class extends HttpControllerBase {
      static prefix = prefix;
      static routes = [{ method: 'POST', path: '/', handler: 'create', body: PinnedBody }] as const;
      async create(_state: TestAppState, context: any) {
        const body = await context.requestBody.json();
        return { status: 200, body: { value: body.value } };
      }
    };

  const application = new Application({ appState: TestAppState });
  application.registerHttpController(controller('/pinned-first'));
  PinnedBody.schema.value.type = Number;
  application.registerHttpController(controller('/pinned-second'));
  const address = await application.listen({ port: 0 });
  try {
    const response = await request(address, '{"value":"original"}', '/pinned-second');
    assert.equal(response.status, 200);
    assert.equal(response.body, '{"value":"original"}');
  } finally {
    await application.close();
  }
});

test('structural failure во всём дереве предотвращает запуск вложенных root validators', async () => {
  let nestedRootCalls = 0;
  class NestedBody {
    value!: string;
    static schema = { value: { type: String } } as const;
    static validators = [
      () => {
        nestedRootCalls += 1;
        return undefined;
      },
    ] as const;
  }
  class PhasedBody {
    nested!: NestedBody;
    count!: number;
    static schema = {
      nested: { type: NestedBody },
      count: { type: Number },
    } as const;
  }
  class PhasedController extends HttpControllerBase {
    static prefix = '/phased-contract';
    static routes = [
      {
        method: 'POST',
        path: '/',
        handler: 'create',
        body: PhasedBody,
        middleware: [
          async (_state: TestAppState, context: any, next: () => Promise<any>) => {
            await context.requestBody.json();
            return next();
          },
        ],
      },
    ] as const;
    create() {
      return { status: 204 };
    }
  }
  const application = new Application({ appState: TestAppState });
  application.registerHttpController(PhasedController);
  const address = await application.listen({ port: 0 });
  try {
    const response = await request(
      address,
      '{"nested":{"value":"valid"},"count":"invalid"}',
      '/phased-contract',
    );
    assert.equal(response.status, 400);
    assert.equal(nestedRootCalls, 0);
  } finally {
    await application.close();
  }
});

test('root validator с путём вне schema завершается наблюдаемым application bug', async () => {
  const observed: unknown[] = [];
  class InvalidPathBody {
    value!: string;
    static schema = { value: { type: String } } as const;
    static validators = [
      () => ({ path: ['missing'], code: 'INVALID_VALUE', message: 'Invalid value' }),
    ] as const;
  }
  class InvalidPathController extends HttpControllerBase {
    static prefix = '/invalid-validator-path';
    static routes = [
      { method: 'POST', path: '/', handler: 'create', body: InvalidPathBody },
    ] as const;
    async create(_state: TestAppState, context: any) {
      await context.requestBody.json();
      return { status: 204 };
    }
  }
  const application = new Application({
    appState: TestAppState,
    http: { onError: (_state, error) => observed.push(error) },
  });
  application.registerHttpController(InvalidPathController);
  const address = await application.listen({ port: 0 });
  try {
    const response = await request(address, '{"value":"input"}', '/invalid-validator-path');
    assert.equal(response.status, 500);
    assert.equal(observed.length, 1);
    assert.ok(observed[0] instanceof TypeError);
  } finally {
    await application.close();
  }
});

test('root validator с вложенным путём вне schema завершается application bug', async () => {
  const observed: unknown[] = [];
  class ChildBody {
    value!: string;
    static schema = { value: { type: String } } as const;
  }
  class InvalidNestedPathBody {
    child!: ChildBody;
    static schema = { child: { type: ChildBody } } as const;
    static validators = [
      () => ({ path: ['child', 'missing'], code: 'INVALID_VALUE', message: 'Invalid value' }),
    ] as const;
  }
  class InvalidNestedPathController extends HttpControllerBase {
    static prefix = '/invalid-nested-validator-path';
    static routes = [
      { method: 'POST', path: '/', handler: 'create', body: InvalidNestedPathBody },
    ] as const;
    async create(_state: TestAppState, context: any) {
      await context.requestBody.json();
      return { status: 204 };
    }
  }
  const application = new Application({
    appState: TestAppState,
    http: { onError: (_state, error) => observed.push(error) },
  });
  application.registerHttpController(InvalidNestedPathController);
  const address = await application.listen({ port: 0 });
  try {
    const response = await request(
      address,
      '{"child":{"value":"input"}}',
      '/invalid-nested-validator-path',
    );
    assert.equal(response.status, 500);
    assert.equal(observed.length, 1);
    assert.ok(observed[0] instanceof TypeError);
  } finally {
    await application.close();
  }
});

test('validation ограничивает response первыми 99 violations и sentinel', async () => {
  class EmptyBody {
    static schema = {} as const;
    marker() {}
  }
  class CappedController extends HttpControllerBase {
    static prefix = '/capped-contract';
    static routes = [{ method: 'POST', path: '/', handler: 'create', body: EmptyBody }] as const;
    async create(_state: TestAppState, context: any) {
      await context.requestBody.json();
      return { status: 204 };
    }
  }
  const input = Object.fromEntries(
    Array.from({ length: 101 }, (_, index) => [`field${index}`, index]),
  );
  const application = new Application({ appState: TestAppState });
  application.registerHttpController(CappedController);
  const address = await application.listen({ port: 0 });
  try {
    const response = await request(address, JSON.stringify(input), '/capped-contract');
    const violations = JSON.parse(response.body).violations;
    assert.equal(response.status, 400);
    assert.equal(violations.length, 100);
    assert.deepEqual(violations.at(-1), {
      path: '',
      code: 'TOO_MANY_VIOLATIONS',
      message: 'Additional violations omitted',
    });
  } finally {
    await application.close();
  }
});

test('validation отклоняет JSON глубже fixed request limit кодом MAX_DEPTH', async () => {
  let constructorCalls = 0;
  class DeepBody {
    children!: DeepBody[];
    label!: string;
    static schema: HttpRouteJsonBodySchema<DeepBody> = {
      children: { type: [bodyClass(() => DeepBody)] },
      label: { type: String },
    } as const;
    constructor() {
      constructorCalls += 1;
    }
  }
  class DeepController extends HttpControllerBase {
    static prefix = '/deep-contract';
    static routes = [{ method: 'POST', path: '/', handler: 'create', body: DeepBody }] as const;
    async create(_state: TestAppState, context: any) {
      await context.requestBody.json();
      return { status: 204 };
    }
  }
  const root: any = { children: [], label: 42 };
  let cursor = root;
  for (let index = 0; index < 66; index += 1) {
    const child = { children: [], label: 'valid' };
    cursor.children.push(child);
    cursor = child;
  }
  const application = new Application({ appState: TestAppState });
  application.registerHttpController(DeepController);
  const address = await application.listen({ port: 0 });
  try {
    const response = await request(address, JSON.stringify(root), '/deep-contract');
    assert.equal(response.status, 400);
    const violations = JSON.parse(response.body).violations;
    assert.ok(violations.some((violation: any) => violation.code === 'MAX_DEPTH'));
    assert.ok(
      violations.some(
        (violation: any) => violation.path === '/label' && violation.code === 'INVALID_TYPE',
      ),
    );
    assert.equal(constructorCalls, 0);
  } finally {
    await application.close();
  }
});

test('validation сохраняет structural violations перед MAX_VALUES', async () => {
  class LargeBody {
    known!: string;
    values!: number[];
    static schema = {
      known: { type: String },
      values: { type: [Number] },
    } as const;
  }
  class LargeController extends HttpControllerBase {
    static prefix = '/large-contract';
    static routes = [{ method: 'POST', path: '/', handler: 'create', body: LargeBody }] as const;
    async create(_state: TestAppState, context: any) {
      await context.requestBody.json();
      return { status: 204 };
    }
  }
  const application = new Application({ appState: TestAppState });
  application.registerHttpController(LargeController);
  const address = await application.listen({ port: 0 });
  try {
    const response = await request(
      address,
      JSON.stringify({ known: 42, values: Array.from({ length: 100_000 }, () => 0) }),
      '/large-contract',
    );
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body).violations, [
      { path: '/known', code: 'INVALID_TYPE', message: 'Expected string' },
      { path: '', code: 'MAX_VALUES', message: 'Maximum JSON value count exceeded' },
    ]);
  } finally {
    await application.close();
  }
});

test('registration отклоняет descriptor depth больше 32', () => {
  let descriptor: any = String;
  for (let depth = 0; depth < 33; depth += 1) descriptor = [descriptor];
  class ExcessiveDescriptorBody {
    value!: unknown;
    static schema = { value: { type: descriptor } } as any;
  }
  class ExcessiveDescriptorController extends HttpControllerBase {
    static prefix = '/excessive-descriptor';
    static routes = [
      {
        method: 'POST',
        path: '/',
        handler: 'create',
        body: ExcessiveDescriptorBody,
      },
    ] as const;
    create() {
      return { status: 204 };
    }
  }
  assert.throws(
    () =>
      new Application({ appState: TestAppState }).registerHttpController(
        ExcessiveDescriptorController as any,
      ),
    InvalidHttpRouteJsonBodyContractError,
  );
});

test('registration отклоняет root contract больше 1024 schema fields', () => {
  const schema = Object.create(null);
  for (let index = 0; index < 1025; index += 1) schema[`field${index}`] = { type: String };
  class ExcessiveFieldsBody {
    static schema = schema as any;
    marker() {}
  }
  class ExcessiveFieldsController extends HttpControllerBase {
    static prefix = '/excessive-fields';
    static routes = [
      { method: 'POST', path: '/', handler: 'create', body: ExcessiveFieldsBody },
    ] as const;
    create() {
      return { status: 204 };
    }
  }
  assert.throws(
    () =>
      new Application({ appState: TestAppState }).registerHttpController(
        ExcessiveFieldsController as any,
      ),
    InvalidHttpRouteJsonBodyContractError,
  );
});

test('registration применяет class, field и validator limits ко всему root graph', () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- local factory keeps graph-limit cases self-contained
  const controller = (prefix: string, Body: any) =>
    class extends HttpControllerBase {
      static prefix = prefix;
      static routes = [{ method: 'POST', path: '/', handler: 'create', body: Body }] as const;
      create() {
        return { status: 204 };
      }
    };

  const wideChildren = Array.from({ length: 2 }, () => {
    const schema = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [`field${index}`, { type: String }]),
    );
    return class {
      static schema = schema as any;
      marker() {}
    };
  });
  class WideRoot {
    static schema = {
      first: { type: wideChildren[0] },
      second: { type: wideChildren[1] },
    } as any;
    marker() {}
  }

  const emptyChildren = Array.from(
    { length: 128 },
    () =>
      class {
        static schema: Record<string, never> = {};
        marker() {}
      },
  );
  class ManyClassesRoot {
    static schema = Object.fromEntries(
      emptyChildren.map((Body, index) => [`child${index}`, { type: Body }]),
    ) as any;
    marker() {}
  }

  const validators = Array.from({ length: 32 }, () => () => undefined);
  const validatedChildren = Array.from(
    { length: 127 },
    () =>
      class {
        static schema: Record<string, never> = {};
        static validators = validators;
        marker() {}
      },
  );
  class ManyValidatorsRoot {
    static validators = validators;
    static schema = Object.fromEntries(
      validatedChildren.map((Body, index) => [
        `child${index}`,
        { type: Body, ...(index === 0 ? { validators: [required()] } : {}) },
      ]),
    ) as any;
    marker() {}
  }

  for (const [prefix, Body] of [
    ['/graph-fields', WideRoot],
    ['/graph-classes', ManyClassesRoot],
    ['/graph-validators', ManyValidatorsRoot],
  ] as const) {
    assert.throws(
      () =>
        new Application({ appState: TestAppState }).registerHttpController(
          controller(prefix, Body) as any,
        ),
      InvalidHttpRouteJsonBodyContractError,
    );
  }
});

test('materialization вызывает constructors bottom-up и не использует setters', async () => {
  const order: string[] = [];
  let setterCalls = 0;
  class ChildBody {
    value!: string;
    static schema = { value: { type: String } } as const;
    constructor() {
      order.push('child');
    }
  }
  class ParentBody {
    child!: ChildBody;
    name!: string;
    static schema = {
      child: { type: ChildBody },
      name: { type: String },
    } as const;
    constructor() {
      order.push('parent');
      Object.defineProperty(this, 'name', {
        enumerable: false,
        configurable: true,
        get: () => 'constructor',
        set: () => {
          setterCalls += 1;
        },
      });
    }
  }
  class MaterializationController extends HttpControllerBase {
    static prefix = '/materialization-order';
    static routes = [{ method: 'POST', path: '/', handler: 'create', body: ParentBody }] as const;
    async create(_state: TestAppState, context: any) {
      await context.requestBody.json();
      return { status: 204 };
    }
  }
  const observed: unknown[] = [];
  const application = new Application({
    appState: TestAppState,
    http: { onError: (_state, error) => observed.push(error) },
  });
  application.registerHttpController(MaterializationController);
  const address = await application.listen({ port: 0 });
  try {
    const response = await request(
      address,
      '{"child":{"value":"nested"},"name":"input"}',
      '/materialization-order',
    );
    assert.equal(response.status, 500);
    assert.deepEqual(order, ['child', 'parent']);
    assert.equal(setterCalls, 0);
    assert.ok(observed[0] instanceof TypeError);
  } finally {
    await application.close();
  }
});
