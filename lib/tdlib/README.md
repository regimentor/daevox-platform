# `@daevox/tdlib`

Daevox uses this library in [the Telegram backend](../../apps/backend/README.md) for session
management, the secretary and automatic replies. Application policies belong to that backend.

Typed TDLib JSON client for Node.js 26. The public request and result types are generated from the pinned `vendor/td` submodule. The runtime has no npm dependencies and uses Node's experimental `node:ffi` API from one shared `worker_threads` worker. Processes using the native client must start Node with `--experimental-ffi`.

## Build prerequisites

The current build targets Linux and produces `libtdjson.so`. It needs Git, CMake (3.10+),
a C++ compiler and build tool, gperf, and development headers/libraries for OpenSSL and zlib.
Initialize the pinned source submodule from the monorepo root:

```sh
git submodule update --init --recursive lib/tdlib/vendor/td
```

Prepare the native artifact explicitly:

```sh
npm run build -w @daevox/tdlib
```

The build regenerates TypeScript types and writes binary/schema checksums to
`build/tdlib-artifact.json` inside the workspace. `DAEVOX_TDLIB_BUILD_JOBS` controls parallel
compilation (default: `1`). Rebuild after an explicit update of the pinned TDLib revision.

## Client lifecycle

Applications provide TDLib parameters through `invoke`, subscribe to `updateAuthorizationState` (including QR links), and wait for an authorized account separately:

```ts
import { TdlibClient } from '@daevox/tdlib';

const client = new TdlibClient();
const stop = client.onUpdate((update) => console.log(update['@type']));
await client.start();
// Build a TdSetTdlibParameters request with the generated type and invoke it here.
await client.waitUntilReady({ timeout: 60_000 });
stop();
await client.close();
```

`start()` does not authorize an account. `close()` preserves the TDLib session. Its timeout or abort signal only cancels the caller's wait; graceful shutdown continues.

## Verification

```sh
npm run verify --workspace @daevox/tdlib
```

This checks types and generated artifacts, runs unit tests, and invokes the native smoke test
through `mise exec` with `--experimental-ffi`. The native test requires the built artifact but no
Telegram account. Real authorization is checked separately through the backend workflow.
