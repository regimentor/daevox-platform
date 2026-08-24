/**
 * RFC-compatible HTTP token syntax. / Синтаксис HTTP-токена, совместимый с RFC.
 *
 * @type {RegExp}
 * @private
 */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**

 * Tests that an object has exactly the expected own string keys. / Проверяет точное множество собственных строковых ключей объекта.

 *

 * @param {Object} object Candidate object. / Проверяемый объект.

 * @param {string[]} expectedKeys Expected keys. / Ожидаемые ключи.

 * @returns {boolean} Match result. / Результат проверки.

 * @private

 */
export function hasExactlyOwnKeys(object, expectedKeys) {
  const keys = Reflect.ownKeys(object);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => typeof key === 'string' && expectedKeys.includes(key))
  );
}

/**

 * Tests a value against HTTP token syntax. / Проверяет значение по синтаксису HTTP-токена.

 *

 * @param {*} value Candidate value. / Проверяемое значение.

 * @returns {boolean} Validation result. / Результат проверки.

 * @private

 */
export function isHttpToken(value) {
  return typeof value === 'string' && value !== '' && HTTP_TOKEN.test(value);
}

/**

 * Decodes safe non-empty segments from an absolute path. / Декодирует безопасные непустые сегменты абсолютного пути.

 *

 * @param {string} path Path to decode. / Декодируемый путь.

 * @returns {string[]} Decoded segments. / Декодированные сегменты.

 * @throws {URIError|TypeError} For invalid encoding or forbidden segments. / При некорректном кодировании или запрещённых сегментах.

 * @private

 */
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
