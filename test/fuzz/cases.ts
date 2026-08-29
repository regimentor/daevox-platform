const VALID_ENVELOPE = JSON.stringify({
  controller: 'fuzz',
  event: 'echo',
  body: { value: 'ok' },
});

export function createRandom(seed: any) {
  let state = Number(seed) >>> 0;
  return {
    integer(maximum: any) {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) % maximum;
    },
    bytes(length: any) {
      return Buffer.from(Array.from({ length }, () => this.integer(256)));
    },
  };
}

function randomJsonObject(random: any, depthLimit: any) {
  const remainingNodes = { value: 8 };
  const createValue = (depth: any) => {
    remainingNodes.value -= 1;
    if (depth >= depthLimit || remainingNodes.value <= 0) {
      const values = [
        null,
        random.integer(2) === 0,
        random.integer(10_000),
        random.bytes(4).toString('hex'),
      ];
      return values[random.integer(values.length)];
    }
    const value: Record<string, any> = {};
    const fields = 1 + random.integer(3);
    for (let index = 0; index < fields && remainingNodes.value > 0; index += 1) {
      value[`field${index}`] = createValue(depth + 1);
    }
    return value;
  };
  return { value: createValue(0) };
}

export function clientFrame({
  final = true,
  opcode = 1,
  payload = Buffer.alloc(0),
  masked = true,
  rsv = 0,
  lengthKind,
  declaredLength,
  mask = Buffer.from([0x12, 0x34, 0x56, 0x78]),
}: any) {
  const bytes = Buffer.from(payload);
  const length = declaredLength ?? bytes.byteLength;
  const kind = lengthKind ?? (length < 126 ? 7 : length <= 65_535 ? 16 : 64);
  const extended = kind === 7 ? 0 : kind === 16 ? 2 : 8;
  const header = Buffer.alloc(2 + extended + (masked ? 4 : 0));
  header[0] = (final ? 0x80 : 0) | ((rsv & 0x07) << 4) | opcode;
  header[1] = (masked ? 0x80 : 0) | (kind === 7 ? length : kind === 16 ? 126 : 127);
  if (kind === 16) header.writeUInt16BE(length, 2);
  if (kind === 64) header.writeBigUInt64BE(BigInt(length), 2);
  const maskOffset = 2 + extended;
  if (masked) mask.copy(header, maskOffset);
  const encoded = Buffer.from(bytes);
  if (masked) {
    for (let index = 0; index < encoded.byteLength; index += 1) {
      encoded[index] ^= mask[index % 4];
    }
  }
  return Buffer.concat([header, encoded]);
}

function ws(name: any, frames: any, expectation: any, options: any = {}) {
  return { name, protocol: 'websocket', chunks: frames, expectation, ...options };
}

function http(name: any, rawRequest: any, expectation: any, options: any = {}) {
  return {
    name,
    protocol: 'http',
    chunks: [Buffer.isBuffer(rawRequest) ? rawRequest : Buffer.from(rawRequest)],
    expectation,
    ...options,
  };
}

function request(body: any, headers: any = '') {
  return Buffer.concat([
    Buffer.from(
      `POST /fuzz/echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${body.byteLength}\r\n${headers}\r\n`,
    ),
    body,
  ]);
}

function jsonBody(length: any) {
  const prefix = Buffer.from('{"value":"');
  const suffix = Buffer.from('"}');
  return Buffer.concat([
    prefix,
    Buffer.alloc(length - prefix.byteLength - suffix.byteLength, 0x61),
    suffix,
  ]);
}

export function fixedCorpus(bodyLimit: any = 256) {
  const valid = Buffer.from(VALID_ENVELOPE);
  const midpoint = Math.floor(valid.byteLength / 2);
  const fragmented = [
    clientFrame({ final: false, payload: valid.subarray(0, midpoint) }),
    clientFrame({ opcode: 9, payload: Buffer.from('between') }),
    clientFrame({ opcode: 0, payload: valid.subarray(midpoint) }),
  ];
  const validFrame = clientFrame({ payload: valid });
  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  const closeWith = (payload: any) => clientFrame({ opcode: 8, payload });
  const exactBody = jsonBody(bodyLimit);
  const overBody = jsonBody(bodyLimit + 1);
  const invalidHttpUtf8 = Buffer.from('{"value":"\xff"}', 'latin1');

  return [
    ws('ws-fragmented-with-control', fragmented, { textMessages: 1, pongPayloads: ['between'] }),
    ws('ws-two-frames-one-chunk', [Buffer.concat([validFrame, validFrame])], { textMessages: 2 }),
    ws(
      'ws-one-frame-many-chunks',
      [...validFrame].map((byte: any) => Buffer.from([byte])),
      {
        textMessages: 1,
      },
    ),
    ws('ws-unmasked', [clientFrame({ payload: valid, masked: false })], { closeCode: 1002 }),
    ws('ws-invalid-opcode', [clientFrame({ opcode: 3, payload: valid })], { closeCode: 1002 }),
    ws('ws-rsv', [clientFrame({ payload: valid, rsv: 1 })], { closeCode: 1002 }),
    ws('ws-unexpected-continuation', [clientFrame({ opcode: 0, payload: valid })], {
      closeCode: 1002,
    }),
    ws(
      'ws-new-data-during-fragment',
      [clientFrame({ final: false, payload: valid.subarray(0, midpoint) }), validFrame],
      { closeCode: 1002 },
    ),
    ws('ws-fragmented-control', [clientFrame({ final: false, opcode: 9 })], {
      closeCode: 1002,
    }),
    ws('ws-noncanonical-16-bit-length', [clientFrame({ payload: valid, lengthKind: 16 })], {
      closeCode: 1002,
    }),
    ws('ws-noncanonical-64-bit-length', [clientFrame({ payload: valid, lengthKind: 64 })], {
      closeCode: 1002,
    }),
    ws(
      'ws-64-bit-oversized',
      [clientFrame({ payload: Buffer.alloc(0), lengthKind: 64, declaredLength: 65_536 })],
      { closeCode: 1009 },
    ),
    ws(
      'ws-incomplete-frame',
      [validFrame.subarray(0, validFrame.byteLength - 2)],
      { reset: true },
      { endInput: true },
    ),
    ws('ws-invalid-utf8', [clientFrame({ payload: invalidUtf8 })], { closeCode: 1007 }),
    ws('ws-close-one-byte', [closeWith(Buffer.from([1]))], { closeCode: 1002 }),
    ws('ws-close-forbidden-code', [closeWith(Buffer.from([0x03, 0xed]))], { closeCode: 1002 }),
    ws('ws-close-invalid-utf8', [closeWith(Buffer.from([0x03, 0xe8, 0xc3, 0x28]))], {
      closeCode: 1007,
    }),
    ws('ws-oversized-control', [clientFrame({ opcode: 9, payload: Buffer.alloc(126) })], {
      closeCode: 1002,
    }),
    ws('ws-oversized-data', [clientFrame({ payload: Buffer.alloc(bodyLimit + 1) })], {
      closeCode: 1009,
    }),
    ws(
      'ws-ping-flood',
      [
        Buffer.concat(
          Array.from({ length: 16 }, (_: any, index: any) =>
            clientFrame({ opcode: 9, payload: Buffer.from([index]) }),
          ),
        ),
      ],
      { pongCount: 16 },
    ),
    ws(
      'ws-recoverable-envelope',
      [
        clientFrame({
          payload: Buffer.from(
            JSON.stringify({ controller: 'fuzz', event: 'unknown', body: { random: true } }),
          ),
        }),
        validFrame,
      ],
      { errorCode: 'UNKNOWN_EVENT', textMessages: 2 },
    ),
    http('http-invalid-target', 'GET /bad target HTTP/1.1\r\nHost: localhost\r\n\r\n', {
      statuses: [400],
    }),
    http('http-invalid-percent-encoding', 'GET /fuzz/%zz HTTP/1.1\r\nHost: localhost\r\n\r\n', {
      statuses: [400],
    }),
    http(
      'http-conflicting-framing',
      'POST /fuzz/echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}',
      { statuses: [400] },
    ),
    http('http-invalid-json', request(Buffer.from('{]')), { statuses: [400] }),
    http('http-invalid-utf8', request(invalidHttpUtf8), { statuses: [400] }),
    http(
      'http-invalid-content-length',
      'POST /fuzz/echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: nope\r\n\r\n{}',
      { statuses: [400] },
    ),
    http(
      'http-conflicting-content-length',
      'POST /fuzz/echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}',
      { statuses: [400] },
    ),
    http(
      'http-truncated-body',
      'POST /fuzz/echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{}',
      { statuses: [400] },
      { endInput: true },
    ),
    http(
      'http-long-header',
      `GET /fuzz/health HTTP/1.1\r\nHost: localhost\r\nX-Long: ${'a'.repeat(20_000)}\r\n\r\n`,
      { statuses: [431] },
    ),
    http('http-body-limit-exact-slow', request(exactBody), { statuses: [200] }, { chunkSize: 17 }),
    http('http-body-limit-over-slow', request(overBody), { statuses: [413] }, { chunkSize: 17 }),
  ];
}

export function generatedCases(seed: any, count: any, bodyLimit: any = 256, depthLimit: any = 4) {
  const random = createRandom(seed);
  const cases: any[] = [];
  for (let index = 0; index < count; index += 1) {
    const choice = random.integer(12);
    if (choice === 0) {
      cases.push(
        ws(
          `generated-${index}-opcode`,
          [
            clientFrame({
              opcode: 3 + random.integer(5),
              payload: random.bytes(random.integer(32)),
            }),
          ],
          { closeCode: 1002 },
        ),
      );
    } else if (choice === 1) {
      cases.push(
        ws(
          `generated-${index}-rsv`,
          [clientFrame({ rsv: 1 + random.integer(7), payload: random.bytes(random.integer(32)) })],
          { closeCode: 1002 },
        ),
      );
    } else if (choice === 2) {
      cases.push(
        ws(
          `generated-${index}-control`,
          [clientFrame({ opcode: 9, payload: random.bytes(126 + random.integer(64)) })],
          { closeCode: 1002 },
        ),
      );
    } else if (choice === 3) {
      const payload = random.bytes(bodyLimit + 1 + random.integer(bodyLimit));
      cases.push(
        ws(`generated-${index}-oversized`, [clientFrame({ payload })], { closeCode: 1009 }),
      );
    } else if (choice === 4) {
      const bytes = clientFrame({ payload: Buffer.from(VALID_ENVELOPE) });
      const chunkSize = 1 + random.integer(8);
      const chunks: any[] = [];
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize)
        chunks.push(bytes.subarray(offset, offset + chunkSize));
      cases.push(ws(`generated-${index}-chunks`, chunks, { textMessages: 1 }));
    } else if (choice === 5) {
      const body = jsonBody(bodyLimit + 1 + random.integer(bodyLimit));
      cases.push(
        http(
          `generated-${index}-body-limit`,
          request(body),
          { statuses: [413] },
          { chunkSize: 1 + random.integer(32) },
        ),
      );
    } else if (choice === 6) {
      const bad = random.bytes(1 + random.integer(48)).toString('hex');
      cases.push(
        http(
          `generated-${index}-target`,
          `GET /fuzz/%${bad.slice(0, 1)} HTTP/1.1\r\nHost: localhost\r\n\r\n`,
          { statuses: [400] },
        ),
      );
    } else if (choice === 7) {
      const body = Buffer.concat([
        Buffer.from('{"value":"'),
        random.bytes(1 + random.integer(16)),
        Buffer.from('"}'),
      ]);
      cases.push(http(`generated-${index}-json`, request(body), { statuses: [400, 200] }));
    } else if (choice === 8) {
      const midpoint = 1 + random.integer(VALID_ENVELOPE.length - 1);
      cases.push(
        ws(
          `generated-${index}-fragmented`,
          [
            clientFrame({
              final: false,
              payload: Buffer.from(VALID_ENVELOPE).subarray(0, midpoint),
            }),
            clientFrame({ opcode: 9, payload: random.bytes(random.integer(16)) }),
            clientFrame({ opcode: 0, payload: Buffer.from(VALID_ENVELOPE).subarray(midpoint) }),
          ],
          { textMessages: 1, pongCount: 1 },
        ),
      );
    } else if (choice === 9) {
      cases.push(
        ws(
          `generated-${index}-unexpected-continuation`,
          [clientFrame({ opcode: 0, payload: random.bytes(random.integer(32)) })],
          { closeCode: 1002 },
        ),
      );
    } else if (choice === 10) {
      const envelope = JSON.stringify({
        controller: 'fuzz',
        event: 'echo',
        body: randomJsonObject(random, depthLimit),
      });
      cases.push(
        ws(`generated-${index}-envelope`, [clientFrame({ payload: Buffer.from(envelope) })], {
          textMessages: 1,
        }),
      );
    } else {
      const malformedEnvelope = JSON.stringify({
        controller: 'fuzz',
        event: 'echo',
        body: randomJsonObject(random, depthLimit),
        extra: random.integer(256),
      });
      cases.push(
        ws(
          `generated-${index}-malformed-envelope`,
          [
            clientFrame({ payload: Buffer.from(malformedEnvelope) }),
            clientFrame({ payload: Buffer.from(VALID_ENVELOPE) }),
          ],
          { errorCode: 'INVALID_MESSAGE', textMessages: 2 },
        ),
      );
    }
  }
  return cases;
}

export function serializeCase(testCase: any) {
  return {
    ...testCase,
    chunks: testCase.chunks.map((chunk: any) => chunk.toString('base64')),
  };
}

export function deserializeCase(value: any) {
  return { ...value, chunks: value.chunks.map((chunk: any) => Buffer.from(chunk, 'base64')) };
}
