/**
 * PROTOTYPE ONLY: proposed compile-time surface for an HTTP-route JSON-body contract.
 *
 * Run from the repository root:
 *   ./node_modules/.bin/tsc --strict --noEmit --target esnext --module nodenext \
 *     --erasableSyntaxOnly --verbatimModuleSyntax \
 *     lib/framework/.scratch/http-route-json-body-contract/prototypes/public-contract.ts
 *
 * This file deliberately declares, rather than imports, the prospective framework API. It does
 * not implement runtime behavior and is excluded from the framework's normal tsconfig.
 */

type HttpResponse = { readonly status: number; readonly body?: unknown };

interface HttpRequestBodyReader<JsonBody = unknown> {
  readonly used: boolean;
  json(): Promise<JsonBody>;
}

interface HttpRequestContext<JsonBody = unknown, State extends object = Record<string, unknown>> {
  readonly requestBody: HttpRequestBodyReader<JsonBody>;
  readonly state: State;
}

interface HttpRouteJsonBodyViolation {
  readonly code: string;
  readonly message: string;
}

interface HttpRouteJsonBodyValidationContext {
  readonly path: string;
}

type HttpRouteJsonBodyValidator<Value = unknown> = (
  value: Value,
  context: HttpRouteJsonBodyValidationContext,
) => HttpRouteJsonBodyViolation | undefined;

declare function required(): HttpRouteJsonBodyValidator<unknown>;
declare function minLength(length: number): HttpRouteJsonBodyValidator<string | readonly unknown[]>;
declare function min(value: number): HttpRouteJsonBodyValidator<number>;

type HttpRouteJsonBodyClass<Instance extends object = object> = {
  new (): Instance;
  readonly schema: HttpRouteJsonBodySchema<Instance>;
  readonly validators?: readonly HttpRouteJsonBodyValidator<Instance>[];
};

type Present<Value> = Exclude<Value, null | undefined>;

type HttpRouteJsonBodyDescriptor<Value> = [Value] extends [null]
  ? null
  : Present<Value> extends string
    ? StringConstructor
    : Present<Value> extends number
      ? NumberConstructor
      : Present<Value> extends boolean
        ? BooleanConstructor
        : Present<Value> extends readonly (infer Element)[]
          ? readonly [HttpRouteJsonBodyDescriptor<Element>]
          : Present<Value> extends object
            ? HttpRouteJsonBodyClass<Present<Value>>
            : never;

type Nullability<Value> = [Value] extends [null]
  ? { readonly nullable?: false }
  : null extends Value
    ? { readonly nullable: true }
    : { readonly nullable?: false };

type HttpRouteJsonBodyField<Value> = {
  readonly type: HttpRouteJsonBodyDescriptor<Value>;
  readonly validators?: readonly HttpRouteJsonBodyValidator<Present<Value>>[];
} & Nullability<Value>;

type HttpRouteJsonBodyDataKey<Instance extends object> = {
  [Key in keyof Instance]-?: Instance[Key] extends (...args: any[]) => unknown ? never : Key;
}[keyof Instance];

type HttpRouteJsonBodySchema<Instance extends object> = {
  readonly [Key in HttpRouteJsonBodyDataKey<Instance>]-?: HttpRouteJsonBodyField<Instance[Key]>;
};

type AssertHttpRouteJsonBodySchema<
  Instance extends object,
  Schema extends HttpRouteJsonBodySchema<Instance>,
> = Schema;

type HttpMiddleware<
  AppState extends object = object,
  JsonBody = unknown,
  State extends object = Record<string, unknown>,
> = (
  appState: AppState,
  context: HttpRequestContext<JsonBody, State>,
  next: () => Promise<HttpResponse>,
) => HttpResponse | Promise<HttpResponse>;

type HttpHandler<AppState extends object = object, JsonBody = unknown> = (
  appState: AppState,
  context: HttpRequestContext<JsonBody>,
) => HttpResponse | Promise<HttpResponse>;

interface HttpRouteDeclaration<
  AppState extends object = object,
  BodyClass extends HttpRouteJsonBodyClass = HttpRouteJsonBodyClass,
> {
  readonly method: string;
  readonly path: string;
  readonly handler: string;
  readonly body?: BodyClass;
  readonly middleware?: readonly HttpMiddleware<AppState, InstanceType<BodyClass>>[];
}

declare class HttpControllerBase {
  protected readonly __controllerBrand: true;
}

type HttpControllerClass<AppState extends object> = {
  new (): HttpControllerBase;
  readonly prefix: string;
  readonly routes: readonly HttpRouteDeclaration<AppState, any>[];
};

type RouteBody<Route> = Route extends { readonly body: new () => infer Body } ? Body : unknown;

type InvalidHttpHandlerDeclaration<
  AppState extends object,
  Controller extends HttpControllerClass<AppState>,
> = Controller['routes'][number] extends infer Route
  ? Route extends { readonly handler: infer Handler extends string }
    ? string extends Handler
      ? Route
      : Handler extends keyof InstanceType<Controller>
        ? InstanceType<Controller>[Handler] extends HttpHandler<AppState, RouteBody<Route>>
          ? never
          : Route
        : Route
    : Route
  : never;

type InvalidHttpRouteMiddlewareDeclaration<
  AppState extends object,
  Controller extends HttpControllerClass<AppState>,
> = Controller['routes'][number] extends infer Route
  ? Route extends { readonly middleware: readonly (infer Middleware)[] }
    ? Middleware extends HttpMiddleware<AppState, RouteBody<Route>>
      ? never
      : Route
    : never
  : never;

type CheckedHttpController<
  AppState extends object,
  Controller extends HttpControllerClass<AppState>,
> = [
  | InvalidHttpHandlerDeclaration<AppState, Controller>
  | InvalidHttpRouteMiddlewareDeclaration<AppState, Controller>,
] extends [never]
  ? unknown
  : { readonly __invalidHttpHandlerDeclaration: never };

declare class Application<AppState extends object> {
  registerHttpController<const Controller extends HttpControllerClass<AppState>>(
    controller: Controller & CheckedHttpController<AppState, Controller>,
  ): this;
}

class AddressDto {
  street!: string;
  apartment!: number | null;

  static schema = {
    street: { type: String, validators: [required(), minLength(1)] },
    apartment: { type: Number, nullable: true, validators: [min(1)] },
  } as const satisfies HttpRouteJsonBodySchema<AddressDto>;
}

const validEmail: HttpRouteJsonBodyValidator<string> = (value) =>
  value.includes('@') ? undefined : { code: 'INVALID_EMAIL', message: 'Must contain @' };

class UserDto {
  email!: string;
  active!: boolean;
  address!: AddressDto;
  aliases!: string[];
  displayName?: string | null;
  retiredAt!: null;

  static schema = {
    email: { type: String, validators: [required(), minLength(3), validEmail] },
    active: { type: Boolean, validators: [required()] },
    address: { type: AddressDto, validators: [required()] },
    aliases: { type: [String], validators: [required(), minLength(1)] },
    displayName: { type: String, nullable: true, validators: [minLength(1)] },
    retiredAt: { type: null },
  } as const satisfies HttpRouteJsonBodySchema<UserDto>;

  static validators = [
    (user: UserDto) =>
      user.active || user.aliases.length === 0
        ? undefined
        : { code: 'INACTIVE_ALIASES', message: 'Inactive user cannot have aliases' },
  ] as const satisfies readonly HttpRouteJsonBodyValidator<UserDto>[];
}

class AppState {
  audit(_email: string) {}
}

const auditBody: HttpMiddleware<AppState, UserDto> = async (appState, context, next) => {
  const body = await context.requestBody.json();
  appState.audit(body.email);
  body.address.street.toUpperCase();
  return next();
};

class UsersController extends HttpControllerBase {
  static prefix = '/users';
  static routes = [
    {
      method: 'POST',
      path: '/',
      handler: 'create',
      body: UserDto,
      middleware: [auditBody],
    },
  ] as const;

  async create(appState: AppState, context: HttpRequestContext<UserDto>): Promise<HttpResponse> {
    const body = await context.requestBody.json();
    appState.audit(body.email);
    return { status: 201, body: { street: body.address.street } };
  }
}

declare const application: Application<AppState>;
type UsersHandlerMatches =
  InstanceType<typeof UsersController>['create'] extends HttpHandler<AppState, UserDto>
    ? true
    : false;
const usersHandlerMatches: UsersHandlerMatches = true;
void usersHandlerMatches;
application.registerHttpController(UsersController);

// Application- and controller-wide middleware cannot assume one route's body contract.
const applicationMiddleware: HttpMiddleware<AppState> = async (_appState, context, next) => {
  const body: unknown = await context.requestBody.json();
  void body;
  return next();
};
void applicationMiddleware;

class WrongDescriptorDto {
  age!: number;

  static schema = {
    // @ts-expect-error a number property requires the Number descriptor
    age: { type: String },
  } as const satisfies HttpRouteJsonBodySchema<WrongDescriptorDto>;
}
void WrongDescriptorDto;

class MissingSchemaFieldDto {
  name!: string;
  active!: boolean;
}

type MissingSchemaField = AssertHttpRouteJsonBodySchema<
  MissingSchemaFieldDto,
  // @ts-expect-error every declared data field needs a schema entry
  { readonly name: { readonly type: StringConstructor } }
>;
void (undefined as unknown as MissingSchemaField);

class WrongNullabilityDto {
  nickname!: string | null;

  static schema = {
    // @ts-expect-error a nullable property must opt into nullable input
    nickname: { type: String },
  } as const satisfies HttpRouteJsonBodySchema<WrongNullabilityDto>;
}
void WrongNullabilityDto;

class WrongBodyController extends HttpControllerBase {
  static prefix = '/wrong';
  static routes = [{ method: 'POST', path: '/', handler: 'create', body: UserDto }] as const;

  create(_appState: AppState, context: HttpRequestContext<AddressDto>): HttpResponse {
    void context;
    return { status: 204 };
  }
}

function rejectWrongHandlerBody() {
  // @ts-expect-error body metadata must agree with the named HTTP-handler context
  application.registerHttpController(WrongBodyController);
}
void rejectWrongHandlerBody;

const wrongRouteMiddleware: HttpMiddleware<AppState, AddressDto> = (_state, _context, next) =>
  next();

class WrongMiddlewareController extends HttpControllerBase {
  static prefix = '/wrong-middleware';
  static routes = [
    {
      method: 'POST',
      path: '/',
      handler: 'create',
      body: UserDto,
      middleware: [wrongRouteMiddleware],
    },
  ] as const;

  create(_appState: AppState, _context: HttpRequestContext<UserDto>): HttpResponse {
    return { status: 204 };
  }
}

function rejectWrongRouteMiddleware() {
  // @ts-expect-error route middleware must use the body class declared by that route
  application.registerHttpController(WrongMiddlewareController);
}
void rejectWrongRouteMiddleware;
