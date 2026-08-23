import { availableParallelism } from 'node:os';
import { Job } from './Job.js';
import { InvalidJobError, InvalidJobOptionsError, JobRunnerClosedError } from './errors.js';
import { WorkerPool } from './WorkerPool.js';

const OPTION_KEYS = new Set(['signal', 'timeout']);
const CONFIG_KEYS = new Set([
  'poolSize',
  'queueSize',
  'defaultTimeout',
  'terminationGracePeriod',
  'shutdownTimeout',
]);
function ownDataValue(object, property) {
  const descriptor = Object.getOwnPropertyDescriptor(object, property);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function invalid(message) {
  throw new InvalidJobOptionsError(message);
}
function isTimeout(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizeConfig(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config))
    invalid('jobs configuration must be an object');
  if (Reflect.ownKeys(config).some((key) => typeof key !== 'string' || !CONFIG_KEYS.has(key)))
    invalid('jobs configuration contains an unknown field');
  const result = {
    poolSize: config.poolSize ?? availableParallelism(),
    queueSize: config.queueSize ?? 1000,
    defaultTimeout: config.defaultTimeout,
    terminationGracePeriod: config.terminationGracePeriod ?? 1000,
    shutdownTimeout: config.shutdownTimeout ?? 30000,
  };
  if (!Number.isInteger(result.poolSize) || result.poolSize <= 0) invalid('poolSize is invalid');
  if (!Number.isInteger(result.queueSize) || result.queueSize < 0) invalid('queueSize is invalid');
  if (result.defaultTimeout !== undefined && !isTimeout(result.defaultTimeout))
    invalid('defaultTimeout is invalid');
  if (!isTimeout(result.terminationGracePeriod)) invalid('terminationGracePeriod is invalid');
  if (!isTimeout(result.shutdownTimeout)) invalid('shutdownTimeout is invalid');
  return result;
}

function validateJobClass(JobClass) {
  if (
    typeof JobClass !== 'function' ||
    !JobClass.prototype ||
    Object.getPrototypeOf(JobClass.prototype) !== Job.prototype
  )
    throw new InvalidJobError('Job class must directly extend Job');
  const metaUrl = ownDataValue(JobClass, 'metaUrl');
  let parsed;
  try {
    parsed = new URL(metaUrl);
  } catch {
    throw new InvalidJobError('Job class must have its own absolute file metaUrl');
  }
  if (parsed.protocol !== 'file:')
    throw new InvalidJobError('Job class must have its own absolute file metaUrl');
  if (typeof ownDataValue(JobClass.prototype, 'run') !== 'function')
    throw new InvalidJobError('Job class must have its own instance run method');
  return parsed.href;
}

function validateOptions(options, defaultTimeout) {
  if (options === undefined) return { signal: undefined, timeout: defaultTimeout };
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    invalid('Job options must be an object');
  if (Reflect.ownKeys(options).some((key) => typeof key !== 'string' || !OPTION_KEYS.has(key)))
    invalid('Job options contain an unknown field');
  const { signal, timeout = defaultTimeout } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal))
    invalid('signal must be an AbortSignal');
  if (timeout !== undefined && !isTimeout(timeout)) invalid('timeout is invalid');
  return { signal, timeout };
}

export class JobRunner {
  #closed = false;
  #closePromise;
  #config;
  #workerPool;
  constructor(config) {
    this.#config = normalizeConfig(config);
    this.#workerPool = new WorkerPool(this.#config);
  }
  run(JobClass, payload, options) {
    const metaUrl = validateJobClass(JobClass);
    const normalized = validateOptions(options, this.#config.defaultTimeout);
    if (this.#closed) throw new JobRunnerClosedError('JobRunner is closed');
    return this.#workerPool.run(metaUrl, payload, normalized);
  }
  close() {
    if (!this.#closePromise) {
      this.#closed = true;
      this.#closePromise = this.#workerPool.close();
    }
    return this.#closePromise;
  }
}
