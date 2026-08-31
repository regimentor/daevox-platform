import { HttpError, type HttpMiddleware, type HttpRequestContext } from '@daevox/framework';
import type { ExampleAppState } from '../ExampleAppState.ts';

export interface Authentication {
  subjectId: string;
  roles: readonly string[];
}

const IDENTITIES_BY_TOKEN = new Map<string, Readonly<Authentication>>([
  ['user-token', Object.freeze({ subjectId: 'user-42', roles: Object.freeze(['user']) })],
  ['admin-token', Object.freeze({ subjectId: 'admin-7', roles: Object.freeze(['user', 'admin']) })],
]);

function unauthenticated() {
  return new HttpError(401, {
    headers: new Headers({ 'www-authenticate': 'Bearer realm="middleware-auth-example"' }),
    body: { error: 'UNAUTHENTICATED' },
  });
}

function isAuthentication(value: unknown): value is Authentication {
  return (
    value !== null &&
    typeof value === 'object' &&
    'subjectId' in value &&
    typeof value.subjectId === 'string' &&
    'roles' in value &&
    Array.isArray(value.roles) &&
    value.roles.every((role: unknown) => typeof role === 'string')
  );
}

export function getAuthentication(ctx: HttpRequestContext<unknown>): Authentication {
  const authentication = ctx.state.auth;
  if (!isAuthentication(authentication)) throw unauthenticated();
  return authentication;
}

export const authenticateBearer: HttpMiddleware<ExampleAppState> = (_appState, ctx, next) => {
  const authorization = ctx.headers.get('authorization');
  if (authorization === null) return next();

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  const identity = match ? IDENTITIES_BY_TOKEN.get(match[1]) : undefined;
  if (!identity) throw unauthenticated();

  ctx.state.auth = {
    subjectId: identity.subjectId,
    roles: [...identity.roles],
  };
  return next();
};

export const requireAuthentication: HttpMiddleware<ExampleAppState> = (_appState, ctx, next) => {
  getAuthentication(ctx);
  return next();
};

export function requireRole(role: string): HttpMiddleware<ExampleAppState> {
  return function authorizeRole(_appState, ctx, next) {
    if (!getAuthentication(ctx).roles.includes(role)) {
      throw new HttpError(403, { body: { error: 'FORBIDDEN', requiredRole: role } });
    }
    return next();
  };
}
