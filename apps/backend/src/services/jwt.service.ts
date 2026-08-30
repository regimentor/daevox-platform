import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { AppState } from '../app-state.ts';

const secret = new TextEncoder().encode(AppState.instance.getConfig().JWT_SECRET);

interface AccessTokenClaims extends JWTPayload {
  login: string;
}

async function createToken(login: string) {
  return new SignJWT({
    login,
  })
    .setProtectedHeader({
      alg: 'HS256',
    })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secret);
}

async function verifyToken<PayloadType = AccessTokenClaims>(token: string) {
  const { payload } = await jwtVerify<PayloadType>(token, secret, {
    algorithms: ['HS256'],
  });

  return payload;
}

export { createToken, verifyToken };
