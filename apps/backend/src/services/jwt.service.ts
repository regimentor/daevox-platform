import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

interface AccessTokenClaims extends JWTPayload {
  login: string;
  id: number;
}

async function createToken(claims: AccessTokenClaims, secret: string) {
  const $secret = new TextEncoder().encode(secret);
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: 'HS256',
    })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign($secret);
}

async function verifyToken<PayloadType = AccessTokenClaims>(token: string, secret: string) {
  const $secret = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify<PayloadType>(token, $secret, {
    algorithms: ['HS256'],
  });

  return payload;
}

export { createToken, verifyToken };
