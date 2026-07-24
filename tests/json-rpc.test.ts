import { test } from "bun:test";

import { isJsonRpcMessage } from "../plugins/codex/scripts/lib/json-rpc.ts";
import { assert } from "./assertions.ts";

test("isJsonRpcMessage accepts request, response, and notification envelopes", () => {
  assert.equal(isJsonRpcMessage({ id: 1, method: "thread/start", params: {} }), true);
  assert.equal(isJsonRpcMessage({ id: "request-1", result: {} }), true);
  assert.equal(isJsonRpcMessage({ method: "turn/completed", params: {} }), true);
  assert.equal(isJsonRpcMessage({ id: 1, error: { code: -32601, message: "Unsupported method" } }), true);
});

test("isJsonRpcMessage rejects malformed envelope fields", () => {
  assert.equal(isJsonRpcMessage([]), false);
  assert.equal(isJsonRpcMessage({ id: {} }), false);
  assert.equal(isJsonRpcMessage({ method: 42 }), false);
  assert.equal(isJsonRpcMessage({ error: "failed" }), false);
  assert.equal(isJsonRpcMessage({ error: { code: "invalid" } }), false);
  assert.equal(isJsonRpcMessage({ error: { message: 42 } }), false);
});
