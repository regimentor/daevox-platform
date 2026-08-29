export const modules = [
  {
    id: 'http-response',
    label: 'HTTP response normalization',
    source: 'lib/framework/Application.js',
    related: ['test/unit/http-transport.test.js'],
    tests: ['test/unit/http-transport.test.js'],
    mutants: [
      {
        id: 'minimum-status-boundary',
        description: 'accept status 199',
        find: 'result.status < 200',
        replace: 'result.status < 199',
      },
      {
        id: 'maximum-status-boundary',
        description: 'accept status 600',
        find: 'result.status > 599',
        replace: 'result.status > 600',
      },
      {
        id: 'head-body-suppression',
        description: 'send a body for HEAD',
        find: "requestedMethod === 'HEAD' || result.status === 204 || result.status === 304",
        replace: "requestedMethod === 'GET' || result.status === 204 || result.status === 304",
      },
      {
        id: 'unexpected-error-code',
        description: 'return 501 for an unexpected handler error',
        find: "this.#reportUnexpected(error, ctx);\n      this.#writeJson(response, 500, { error: 'Internal Server Error' });",
        replace:
          "this.#reportUnexpected(error, ctx);\n      this.#writeJson(response, 501, { error: 'Internal Server Error' });",
      },
    ],
  },
  {
    id: 'http-routing',
    label: 'HTTP routing',
    source: 'lib/framework/HttpRouter.js',
    related: ['test/unit/http-router.test.js'],
    tests: ['test/unit/http-router.test.js'],
    mutants: [
      {
        id: 'empty-route-batch',
        description: 'accept an empty route registration batch',
        find: 'routes.length === 0',
        replace: 'routes.length < 0',
      },
      {
        id: 'duplicate-route-conflict',
        description: 'allow a structurally duplicate route',
        find: 'if (keys.has(candidate.structuralKey)) {',
        replace: 'if (!keys.has(candidate.structuralKey)) {',
      },
      {
        id: 'method-comparison',
        description: 'ignore the HTTP method while matching',
        find: 'candidate.method !== normalizedMethod || candidate.pattern.length !== segments.length',
        replace:
          'candidate.method === normalizedMethod || candidate.pattern.length !== segments.length',
      },
      {
        id: 'segment-count-comparison',
        description: 'match routes with a different segment count',
        find: 'candidate.method !== normalizedMethod || candidate.pattern.length !== segments.length',
        replace:
          'candidate.method !== normalizedMethod || candidate.pattern.length === segments.length',
      },
      {
        id: 'static-route-priority',
        description: 'prefer a dynamic route over a static route',
        find: 'return left.pattern[index].dynamic ? 1 : -1;',
        replace: 'return left.pattern[index].dynamic ? -1 : 1;',
      },
    ],
  },
  {
    id: 'websocket-protocol',
    label: 'WebSocket protocol',
    source: 'lib/framework/webSocketProtocol.js',
    related: ['test/unit/websocket-protocol.test.js'],
    tests: ['test/unit/websocket-protocol.test.js'],
    mutants: [
      {
        id: 'fatal-error-code',
        description: 'use INVALID_RESPONSE for malformed unaddressable input',
        find: "} catch {\n    throw new WebSocketProtocolError('INVALID_MESSAGE', { fatal: true });\n  }",
        replace:
          "} catch {\n    throw new WebSocketProtocolError('INVALID_RESPONSE', { fatal: true });\n  }",
      },
      {
        id: 'envelope-field-count',
        description: 'accept an envelope with a missing field',
        find: 'Reflect.ownKeys(value).length !== 3',
        replace: 'Reflect.ownKeys(value).length !== 2',
      },
      {
        id: 'reserved-error-body',
        description: 'allow handlers to return the reserved error body',
        find: "Object.hasOwn(body, 'error')",
        replace: "Object.hasOwn(body, 'errors')",
      },
      {
        id: 'message-size-boundary',
        description: 'reject an outgoing message exactly at maxPayload',
        find: "const text = JSON.stringify({ controller, event, body });\n  if (Buffer.byteLength(text) > maxPayload) {\n    throw new WebSocketProtocolError('INVALID_RESPONSE', { controller, event });\n  }",
        replace:
          "const text = JSON.stringify({ controller, event, body });\n  if (Buffer.byteLength(text) >= maxPayload) {\n    throw new WebSocketProtocolError('INVALID_RESPONSE', { controller, event });\n  }",
      },
      {
        id: 'response-error-code',
        description: 'use INVALID_MESSAGE for an invalid handler response',
        find: "    !isPlainObject(body) ||\n    Object.hasOwn(body, 'error') ||\n    !isCompatible(body)\n  ) {\n    throw new WebSocketProtocolError('INVALID_RESPONSE', { controller, event });\n  }",
        replace:
          "    !isPlainObject(body) ||\n    Object.hasOwn(body, 'error') ||\n    !isCompatible(body)\n  ) {\n    throw new WebSocketProtocolError('INVALID_MESSAGE', { controller, event });\n  }",
      },
    ],
  },
  {
    id: 'worker-pool',
    label: 'Worker Pool terminal states',
    source: 'lib/framework/WorkerPool.js',
    related: ['test/unit/job-runner.test.js', 'test/e2e/races.test.js'],
    tests: ['test/unit/job-runner.test.js'],
    mutants: [
      {
        id: 'queue-capacity-boundary',
        description: 'allow one task beyond queueSize',
        find: 'this.#queue.length >= this.#config.queueSize',
        replace: 'this.#queue.length > this.#config.queueSize',
      },
      {
        id: 'success-terminal-status',
        description: 'treat a successful Worker result as an error',
        find: "message.status === 'success'",
        replace: "message.status === 'error'",
      },
      {
        id: 'queued-cancellation-state',
        description: 'skip cleanup for cancellation of a queued task',
        find: "if (task.state === 'queued') {",
        replace: "if (task.state === 'new') {",
      },
      {
        id: 'fifo-cleanup-order',
        description: 'release queued tasks in LIFO rather than FIFO order',
        find: 'const next = this.#queue.shift();',
        replace: 'const next = this.#queue.pop();',
      },
      {
        id: 'worker-exit-cleanup',
        description: 'retain an exited Worker in the pool before replacement',
        find: 'this.#workers.delete(entry);',
        replace: 'void entry;',
      },
    ],
  },
];
