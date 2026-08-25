import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ISSUER = 'daevox-jwt-example';
const AUDIENCE = 'daevox-api';
const TOKEN_TTL_SECONDS = 15 * 60;

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return null;
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function signature(secret, input) {
  return createHmac('sha256', secret).update(input).digest();
}

export class JwtAuthority {
  #secret;
  #revoked = new Map();

  constructor(secret = randomBytes(32)) {
    if (!Buffer.isBuffer(secret) || secret.length < 32) {
      throw new TypeError('JWT HS256 secret must be a Buffer of at least 32 bytes');
    }
    this.#secret = Buffer.from(secret);
  }

  issue(principal) {
    const now = Math.floor(Date.now() / 1000);
    this.#forgetExpiredRevocations(now * 1000);
    const jti = randomBytes(16).toString('base64url');
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const payload = encode({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: principal.id,
      email: principal.email,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
      jti,
    });
    const input = `${header}.${payload}`;
    const token = `${input}.${signature(this.#secret, input).toString('base64url')}`;
    return { token, expiresAt: (now + TOKEN_TTL_SECONDS) * 1000 };
  }

  verify(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = decode(encodedHeader);
    const payload = decode(encodedPayload);
    if (!header || header.alg !== 'HS256' || header.typ !== 'JWT' || !payload) return null;

    if (!/^[A-Za-z0-9_-]+$/.test(encodedSignature)) return null;
    const actualSignature = Buffer.from(encodedSignature, 'base64url');
    const expectedSignature = signature(this.#secret, `${encodedHeader}.${encodedPayload}`);
    if (
      actualSignature.length !== expectedSignature.length ||
      !timingSafeEqual(actualSignature, expectedSignature)
    ) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (
      payload.iss !== ISSUER ||
      payload.aud !== AUDIENCE ||
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      typeof payload.email !== 'string' ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.iat > now ||
      payload.exp <= now ||
      typeof payload.jti !== 'string' ||
      payload.jti.length === 0 ||
      this.#revoked.has(payload.jti)
    ) {
      return null;
    }

    return {
      authSessionId: `jwt:${payload.jti}`,
      principal: { id: payload.sub, email: payload.email },
      expiresAt: payload.exp * 1000,
    };
  }

  revoke(authSession) {
    if (
      authSession === null ||
      typeof authSession !== 'object' ||
      typeof authSession.authSessionId !== 'string' ||
      !authSession.authSessionId.startsWith('jwt:') ||
      !Number.isSafeInteger(authSession.expiresAt)
    ) {
      return false;
    }
    this.#forgetExpiredRevocations(Date.now());
    this.#revoked.set(authSession.authSessionId.slice(4), authSession.expiresAt);
    return true;
  }

  isActive(authSession) {
    return (
      authSession.expiresAt > Date.now() && !this.#revoked.has(authSession.authSessionId.slice(4))
    );
  }

  #forgetExpiredRevocations(now) {
    for (const [jti, expiresAt] of this.#revoked) {
      if (expiresAt <= now) this.#revoked.delete(jti);
    }
  }
}
