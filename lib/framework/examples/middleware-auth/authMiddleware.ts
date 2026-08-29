import { HttpError } from '@daevox/framework';

const IDENTITIES_BY_TOKEN = new Map<
  string,
  Readonly<{ subjectId: string; roles: readonly string[] }>
>([
  ['user-token', Object.freeze({ subjectId: 'user-42', roles: Object.freeze(['user']) })],
  ['admin-token', Object.freeze({ subjectId: 'admin-7', roles: Object.freeze(['user', 'admin']) })],
]);

function unauthenticated() {
  return new HttpError(401, {
    headers: new Headers({ 'www-authenticate': 'Bearer realm="middleware-auth-example"' }),
    body: { error: 'UNAUTHENTICATED' },
  });
}

export function authenticateBearer(ctx: any, next: any) {
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
}

export function requireAuthentication(ctx: any, next: any) {
  if (!ctx.state.auth) throw unauthenticated();
  return next();
}

export function requireRole(role: any) {
  return function authorizeRole(ctx: any, next: any) {
    if (!ctx.state.auth.roles.includes(role)) {
      throw new HttpError(403, { body: { error: 'FORBIDDEN', requiredRole: role } });
    }
    return next();
  };
}
