import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SESSION_TTL = 60 * 60 * 1000;
const TICKET_TTL = 30 * 1000;
const KEY_LENGTH = 64;
const dummySalt = Buffer.alloc(16);
const dummyHash = await scrypt('not-a-real-password', dummySalt, KEY_LENGTH);

function opaqueCredential() {
  return randomBytes(32).toString('base64url');
}

function publicPrincipal(user) {
  return { id: user.id, email: user.email };
}

export class AuthenticationStore {
  #users = new Map();
  #browserSessions = new Map();
  #browserCredentials = new Map();
  #apiSessions = new Map();
  #apiCredentials = new Map();
  #tickets = new Map();

  async register(email, password) {
    const normalizedEmail = email.trim().toLowerCase();
    if (this.#users.has(normalizedEmail)) return null;

    const salt = randomBytes(16);
    const passwordHash = await scrypt(password, salt, KEY_LENGTH);
    if (this.#users.has(normalizedEmail)) return null;

    const user = {
      id: opaqueCredential(),
      email: normalizedEmail,
      salt,
      passwordHash,
    };
    this.#users.set(normalizedEmail, user);
    return publicPrincipal(user);
  }

  async verifyPassword(email, password) {
    const normalizedEmail = email.trim().toLowerCase();
    const user = this.#users.get(normalizedEmail);
    const candidate = await scrypt(password, user?.salt ?? dummySalt, KEY_LENGTH);
    const matches = timingSafeEqual(candidate, user?.passwordHash ?? dummyHash);
    return matches && user ? publicPrincipal(user) : null;
  }

  createBrowserSession(principal) {
    const credential = opaqueCredential();
    const authSession = {
      authSessionId: `browser:${opaqueCredential()}`,
      principal,
      expiresAt: Date.now() + SESSION_TTL,
    };
    this.#browserCredentials.set(credential, authSession.authSessionId);
    this.#browserSessions.set(authSession.authSessionId, { credential, authSession });
    return { credential, authSession };
  }

  resolveBrowserSession(credential) {
    const authSessionId = this.#browserCredentials.get(credential);
    const record = authSessionId && this.#browserSessions.get(authSessionId);
    if (!record || record.authSession.expiresAt <= Date.now()) {
      if (authSessionId) this.revokeBrowserSession(authSessionId);
      return null;
    }
    return record.authSession;
  }

  revokeBrowserSession(authSessionId) {
    const record = this.#browserSessions.get(authSessionId);
    if (!record) return false;
    this.#browserSessions.delete(authSessionId);
    this.#browserCredentials.delete(record.credential);
    return true;
  }

  issueApiToken(principal) {
    const credential = opaqueCredential();
    const authSession = {
      authSessionId: `api:${opaqueCredential()}`,
      principal,
      expiresAt: Date.now() + SESSION_TTL,
    };
    this.#apiCredentials.set(credential, authSession.authSessionId);
    this.#apiSessions.set(authSession.authSessionId, { credential, authSession });
    return { credential, authSession };
  }

  resolveApiToken(credential) {
    const authSessionId = this.#apiCredentials.get(credential);
    const record = authSessionId && this.#apiSessions.get(authSessionId);
    if (!record || record.authSession.expiresAt <= Date.now()) {
      if (authSessionId) this.revokeApiToken(authSessionId);
      return null;
    }
    return record.authSession;
  }

  revokeApiToken(authSessionId) {
    const record = this.#apiSessions.get(authSessionId);
    if (!record) return false;
    this.#apiSessions.delete(authSessionId);
    this.#apiCredentials.delete(record.credential);
    return true;
  }

  issueTicket(authSession) {
    const now = Date.now();
    for (const [ticket, record] of this.#tickets) {
      if (record.expiresAt <= now) this.#tickets.delete(ticket);
    }
    const credential = opaqueCredential();
    this.#tickets.set(credential, {
      authSessionId: authSession.authSessionId,
      expiresAt: now + TICKET_TTL,
    });
    return credential;
  }

  consumeTicket(credential) {
    const record = this.#tickets.get(credential);
    this.#tickets.delete(credential);
    if (!record || record.expiresAt <= Date.now()) return null;
    const apiSession = this.#apiSessions.get(record.authSessionId);
    if (!apiSession || apiSession.authSession.expiresAt <= Date.now()) return null;
    return apiSession.authSession;
  }
}

export const authenticationStore = new AuthenticationStore();
