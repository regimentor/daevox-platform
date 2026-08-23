const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function hasExactlyOwnKeys(object, expectedKeys) {
  const keys = Reflect.ownKeys(object);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => typeof key === 'string' && expectedKeys.includes(key))
  );
}

export function isHttpToken(value) {
  return typeof value === 'string' && value !== '' && HTTP_TOKEN.test(value);
}

export function decodePathSegments(path) {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const decoded = decodeURIComponent(segment);
      if (
        decoded === '.' ||
        decoded === '..' ||
        decoded.includes('?') ||
        decoded.includes('#') ||
        decoded.includes('\\') ||
        [...decoded].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
        })
      ) {
        throw new TypeError('path contains a forbidden character or segment');
      }
      return decoded;
    });
}
