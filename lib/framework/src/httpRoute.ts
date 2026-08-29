/**
 * RFC-compatible HTTP token syntax. / Синтаксис HTTP-токена, совместимый с RFC.
 * @private
 */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**

 * Tests that an object has exactly the expected own string keys. / Проверяет точное множество собственных строковых ключей объекта.

 *
 * @param object Candidate object. / Проверяемый объект.

 * @param expectedKeys Expected keys. / Ожидаемые ключи.

 * @returns Match result. / Результат проверки.

 * @private

 */
export function hasExactlyOwnKeys(object: any, expectedKeys: any) {
  const keys = Reflect.ownKeys(object);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key: any) => typeof key === 'string' && expectedKeys.includes(key))
  );
}

/**

 * Tests a value against HTTP token syntax. / Проверяет значение по синтаксису HTTP-токена.

 *
 * @param value Candidate value. / Проверяемое значение.

 * @returns Validation result. / Результат проверки.

 * @private

 */
export function isHttpToken(value: any) {
  return typeof value === 'string' && value !== '' && HTTP_TOKEN.test(value);
}

/**

 * Decodes safe non-empty segments from an absolute path. / Декодирует безопасные непустые сегменты абсолютного пути.

 *
 * @param path Path to decode. / Декодируемый путь.

 * @returns Decoded segments. / Декодированные сегменты.

 * @throws {URIError|TypeError} For invalid encoding or forbidden segments. / При некорректном кодировании или запрещённых сегментах.

 * @private

 */
export function decodePathSegments(path: any) {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment: any) => {
      const decoded = decodeURIComponent(segment);
      if (
        decoded === '.' ||
        decoded === '..' ||
        decoded.includes('?') ||
        decoded.includes('#') ||
        decoded.includes('\\') ||
        [...decoded].some((character: any) => {
          const codePoint = character.codePointAt(0);
          return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
        })
      ) {
        throw new TypeError('path contains a forbidden character or segment');
      }
      return decoded;
    });
}
