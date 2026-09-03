import { MIMEType } from 'node:util';
import { HttpRequestBodyError } from './errors.ts';

/**
 * Lazily selected representation of one buffered HTTP request body.
 * Лениво выбранное представление одного буферизованного тела HTTP-запроса.
 * @public
 */
export interface HttpRequestBodyReader<JsonBody = unknown> {
  /** Whether a representation read has started. / Началось ли чтение представления. @public */
  readonly used: boolean;

  /**
   * Reads the body as JSON. / Читает тело как JSON.
   * @returns Parsed JSON value. / Разобранное JSON-значение.
   * @public
   */
  json(): Promise<JsonBody>;

  /**
   * Reads the body as UTF-8 text. / Читает тело как UTF-8 текст.
   * @returns Decoded text. / Декодированный текст.
   * @public
   */
  text(): Promise<string>;

  /**
   * Reads the body as an independent Node.js buffer.
   * Читает тело как независимый буфер Node.js.
   * @returns Mutable copy of the wire bytes. / Изменяемая копия wire bytes.
   * @public
   */
  bytes(): Promise<Buffer>;

  /**
   * Reads URL-encoded or multipart fields and files.
   * Читает URL-encoded или multipart поля и файлы.
   * @returns Native form data. / Нативные данные формы.
   * @public
   */
  formData(): Promise<FormData>;
}

/**
 * Strict UTF-8 decoder used by JSON representation reads.
 * Строгий UTF-8 decoder для чтения JSON-представления.
 * @private
 */
const JSON_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/** Parsed request media type used by representation selection. / Разобранный media type запроса. @private */
interface ParsedContentType {
  readonly mediaType: string;
  readonly charset: string | undefined;
  readonly boundary: string | undefined;
}

/** RFC token accepted in Content-Type parameters. / RFC token параметров Content-Type. @private */
const CONTENT_TYPE_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Internal snapshot-release operations keyed by their readers. / Внутренние операции освобождения snapshot по reader. @private */
const RELEASE_READER = new WeakMap<object, () => void>();

/**
 * Splits a Content-Type field at semicolons outside quoted strings.
 * Делит поле Content-Type по точкам с запятой вне quoted strings.
 * @param value Header value. / Значение заголовка.
 * @returns Header parts. / Части заголовка.
 * @throws {TypeError} When quoting is malformed. / При malformed quoting.
 * @private
 */
function splitContentType(value: string): string[] {
  const parts: string[] = [];
  let part = '';
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      part += character;
      escaped = false;
    } else if (quoted && character === '\\') {
      part += character;
      escaped = true;
    } else if (character === '"') {
      part += character;
      quoted = !quoted;
    } else if (character === ';' && !quoted) {
      parts.push(part.trim());
      part = '';
    } else {
      part += character;
    }
  }
  if (quoted || escaped) throw new TypeError('Content-Type quoting is malformed');
  parts.push(part.trim());
  return parts;
}

/**
 * Parses one Content-Type value without exposing parser errors.
 * Разбирает одно значение Content-Type без раскрытия ошибок parser.
 * @param value Header value. / Значение заголовка.
 * @returns Parsed value or absence. / Разобранное значение или отсутствие.
 * @throws {HttpRequestBodyError} When the field is malformed. / Если поле malformed.
 * @private
 */
function parseContentType(value: string | undefined): ParsedContentType | undefined {
  if (value === undefined) return undefined;
  try {
    const parts = splitContentType(value);
    const parameters = new Map<string, string>();
    for (const part of parts.slice(1)) {
      const separator = part.indexOf('=');
      if (separator <= 0) throw new TypeError('Content-Type parameter is malformed');
      const name = part.slice(0, separator).trim().toLowerCase();
      const encodedValue = part.slice(separator + 1).trim();
      if (!CONTENT_TYPE_TOKEN.test(name) || encodedValue === '') {
        throw new TypeError('Content-Type parameter is malformed');
      }
      let parameterValue: string;
      if (encodedValue.startsWith('"')) {
        if (!encodedValue.endsWith('"') || encodedValue.length < 2) {
          throw new TypeError('Content-Type parameter is malformed');
        }
        parameterValue = encodedValue.slice(1, -1).replace(/\\(.)/g, '$1');
      } else {
        if (!CONTENT_TYPE_TOKEN.test(encodedValue)) {
          throw new TypeError('Content-Type parameter is malformed');
        }
        parameterValue = encodedValue;
      }
      if (name !== 'charset' && name !== 'boundary') continue;
      const comparable = name === 'charset' ? parameterValue.toLowerCase() : parameterValue;
      const previous = parameters.get(name);
      if (previous !== undefined && previous !== comparable) {
        throw new TypeError('Content-Type parameters conflict');
      }
      parameters.set(name, comparable);
    }
    const parsed = new MIMEType(value);
    return {
      mediaType: parsed.essence.toLowerCase(),
      charset: parameters.get('charset'),
      boundary: parameters.get('boundary'),
    };
  } catch (error) {
    throw new HttpRequestBodyError('MALFORMED_BODY', { cause: error });
  }
}

/**
 * Buffered implementation hidden behind the public request-body reader.
 * Буферизованная реализация, скрытая за публичным читателем тела запроса.
 * @private
 */
class BufferedHttpRequestBodyReader<JsonBody> implements HttpRequestBodyReader<JsonBody> {
  /** Buffered wire bytes. / Буферизованные wire bytes. @private */
  #bytes: Buffer | undefined;

  /** Declared media type. / Объявленный media type. @private */
  readonly #contentType: string | undefined;

  /** Request cancellation signal. / Сигнал отмены запроса. @private */
  readonly #signal: AbortSignal;

  /** Optional transformation of parsed JSON. / Необязательное преобразование разобранного JSON. @private */
  readonly #transformJson: ((input: unknown) => JsonBody) | undefined;

  /** Shared contract-aware JSON operation. / Общая contract-aware JSON-операция. @private */
  #jsonPromise: Promise<JsonBody> | undefined;

  /** Snapshot-release listener. / Listener освобождения snapshot. @private */
  readonly #onAbort: () => void;

  /** Mutable consumption state. / Изменяемое состояние потребления. @private */
  #used = false;

  /** Whether a representation read has started. / Началось ли чтение представления. @public */
  get used(): boolean {
    return this.#used;
  }

  /**
   * Creates a reader over one immutable snapshot.
   * Создаёт reader над одним неизменяемым snapshot.
   * @param bytes Buffered wire bytes. / Буферизованные wire bytes.
   * @param contentType Declared media type. / Объявленный media type.
   * @param signal Request cancellation signal. / Сигнал отмены запроса.
   * @private
   */
  constructor(
    bytes: Buffer,
    contentType: string | undefined,
    signal: AbortSignal,
    transformJson: ((input: unknown) => JsonBody) | undefined,
  ) {
    this.#bytes = bytes;
    this.#contentType = contentType;
    this.#signal = signal;
    this.#transformJson = transformJson;
    this.#onAbort = () => {
      this.#bytes = undefined;
    };
    RELEASE_READER.set(this, () => this.#release());
    if (signal.aborted) this.#onAbort();
    else signal.addEventListener('abort', this.#onAbort, { once: true });
  }

  /**
   * Reads the snapshot as strict UTF-8 JSON.
   * Читает snapshot как строгий UTF-8 JSON.
   * @returns Parsed JSON value. / Разобранное JSON-значение.
   * @public
   */
  async json(): Promise<JsonBody> {
    if (this.#transformJson !== undefined) {
      if (this.#jsonPromise === undefined) this.#jsonPromise = this.#readJson();
      return this.#jsonPromise;
    }
    return this.#readJson();
  }

  /**
   * Performs the single JSON representation read.
   * Выполняет единственное чтение JSON-представления.
   * @returns Parsed or transformed JSON. / Разобранный или преобразованный JSON.
   * @private
   */
  async #readJson(): Promise<JsonBody> {
    const bytes = this.#takeBytes();
    try {
      const contentType = parseContentType(this.#contentType);
      const mediaType = contentType?.mediaType;
      if (
        mediaType !== 'application/json' &&
        (mediaType === undefined || !mediaType.endsWith('+json'))
      ) {
        throw new HttpRequestBodyError('UNSUPPORTED_MEDIA_TYPE');
      }
      if (contentType?.charset !== undefined && contentType.charset !== 'utf-8') {
        throw new HttpRequestBodyError('UNSUPPORTED_MEDIA_TYPE');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(JSON_UTF8_DECODER.decode(bytes));
      } catch (error) {
        throw new HttpRequestBodyError('MALFORMED_BODY', { cause: error });
      }
      return this.#transformJson ? this.#transformJson(parsed) : (parsed as JsonBody);
    } finally {
      this.#release();
    }
  }

  /**
   * Reads the snapshot as replacement-decoded UTF-8 text.
   * Читает snapshot как UTF-8 текст с replacement decoding.
   * @returns Decoded text. / Декодированный текст.
   * @public
   */
  async text(): Promise<string> {
    const bytes = this.#takeBytes();
    try {
      const contentType = parseContentType(this.#contentType);
      if (contentType?.charset !== undefined && contentType.charset !== 'utf-8') {
        throw new HttpRequestBodyError('UNSUPPORTED_MEDIA_TYPE');
      }
      return new TextDecoder().decode(bytes);
    } finally {
      this.#release();
    }
  }

  /**
   * Copies the snapshot into a caller-owned Node.js buffer.
   * Копирует snapshot в принадлежащий вызывающему коду буфер Node.js.
   * @returns Mutable copy of the wire bytes. / Изменяемая копия wire bytes.
   * @public
   */
  async bytes(): Promise<Buffer> {
    const bytes = this.#takeBytes();
    try {
      return Buffer.from(bytes);
    } finally {
      this.#release();
    }
  }

  /**
   * Delegates form parsing to the native Fetch implementation.
   * Делегирует разбор формы нативной Fetch-реализации.
   * @returns Native form data. / Нативные данные формы.
   * @public
   */
  async formData(): Promise<FormData> {
    const bytes = this.#takeBytes();
    try {
      const contentType = parseContentType(this.#contentType);
      const mediaType = contentType?.mediaType;
      if (
        mediaType !== 'application/x-www-form-urlencoded' &&
        mediaType !== 'multipart/form-data'
      ) {
        throw new HttpRequestBodyError('UNSUPPORTED_MEDIA_TYPE');
      }
      if (contentType?.charset !== undefined && contentType.charset !== 'utf-8') {
        throw new HttpRequestBodyError('UNSUPPORTED_MEDIA_TYPE');
      }
      if (mediaType === 'multipart/form-data' && !contentType?.boundary) {
        throw new HttpRequestBodyError('MALFORMED_BODY');
      }
      try {
        const body = new Uint8Array(bytes.byteLength);
        body.set(bytes);
        const result = await new Response(body, {
          headers: { 'content-type': this.#contentType! },
        }).formData();
        if (this.#signal.aborted) throw this.#abortError();
        return result;
      } catch (error) {
        if (error instanceof HttpRequestBodyError || error === this.#signal.reason) throw error;
        throw new HttpRequestBodyError('MALFORMED_BODY', { cause: error });
      }
    } finally {
      this.#release();
    }
  }

  /**
   * Claims the one-shot snapshot for a representation operation.
   * Забирает однократный snapshot для операции представления.
   * @returns Buffered wire bytes. / Буферизованные wire bytes.
   * @throws {TypeError} When another operation already claimed the reader. / Если reader уже
   * занят другой операцией.
   * @private
   */
  #takeBytes(): Buffer {
    if (this.#used) throw new TypeError('HTTP request body has already been used');
    this.#used = true;
    if (this.#signal.aborted) {
      this.#release();
      throw this.#abortError();
    }
    return this.#bytes!;
  }

  /**
   * Returns the standard cancellation reason for this request.
   * Возвращает стандартную причину отмены этого запроса.
   * @returns Abort error. / Ошибка отмены.
   * @private
   */
  #abortError(): DOMException {
    return this.#signal.reason instanceof DOMException
      ? this.#signal.reason
      : new DOMException('The operation was aborted', 'AbortError');
  }

  /** Releases the internal snapshot and abort listener. / Освобождает внутренний snapshot и abort listener. @private */
  #release(): void {
    this.#bytes = undefined;
    this.#signal.removeEventListener('abort', this.#onAbort);
    RELEASE_READER.delete(this);
  }
}

/**
 * Creates the request-body reader owned by one HTTP request context.
 * Создаёт читатель тела запроса для одного контекста HTTP-запроса.
 * @param bytes Buffered wire bytes. / Буферизованные wire bytes.
 * @param contentType Declared media type. / Объявленный media type.
 * @param signal Request cancellation signal. / Сигнал отмены запроса.
 * @returns Request-body reader. / Читатель тела запроса.
 * @private
 */
export function createHttpRequestBodyReader<JsonBody = unknown>(
  bytes: Buffer,
  contentType: string | undefined,
  signal: AbortSignal,
  transformJson?: (input: unknown) => JsonBody,
): HttpRequestBodyReader<JsonBody> {
  return Object.freeze(
    new BufferedHttpRequestBodyReader<JsonBody>(bytes, contentType, signal, transformJson),
  );
}

/**
 * Releases a request-owned snapshot after HTTP execution completes.
 * Освобождает принадлежащий запросу snapshot после завершения HTTP execution.
 * @param reader Request-body reader. / Читатель тела запроса.
 * @private
 */
export function releaseHttpRequestBodyReader(reader: HttpRequestBodyReader): void {
  RELEASE_READER.get(reader)?.();
}
