# `@daevox/tdlib`

Typed TDLib JSON client for Node.js 26. The public request and result types are generated from the pinned `vendor/td` submodule. The runtime has no npm dependencies and uses Node's experimental `node:ffi` API from one shared `worker_threads` worker. Processes using the native client must start Node with `--experimental-ffi`.

Prepare the native artifact explicitly:

```sh
npm run build -w @daevox/tdlib
```

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
