import assert from 'node:assert/strict';
import { Application } from 'daevox-node-framework/lib/framework/Application.js';
import { HttpControllerBase } from 'daevox-node-framework/lib/framework/HttpControllerBase.js';
import { Job } from 'daevox-node-framework/lib/framework/Job.js';
import { WebSocketControllerBase } from 'daevox-node-framework/lib/framework/WebSocketControllerBase.js';
import { HttpError, WebSocketProtocolError } from 'daevox-node-framework/lib/framework/errors.js';

for (const publicClass of [
  Application,
  HttpControllerBase,
  Job,
  WebSocketControllerBase,
  HttpError,
  WebSocketProtocolError,
]) {
  assert.equal(typeof publicClass, 'function');
}
