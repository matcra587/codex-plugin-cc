// Modified from openai/codex-plugin-cc by Matt Craven in 2026.
// See NOTICE for attribution and plugins/codex/CHANGELOG.md for changes.

import { test } from "bun:test";
import { SocketWriter } from "../plugins/codex/scripts/lib/socket-writer.ts";
import { assert } from "./assertions.ts";

// A socket that accepts a scripted number of bytes per call, so short writes
// are deterministic rather than dependent on a real send buffer filling up.
function scriptedSocket(accepts: number[]) {
  const sizes: number[] = [];
  let index = 0;
  return {
    sizes,
    write(payload: Uint8Array): number {
      const limit = accepts[index] ?? payload.length;
      index += 1;
      const written = Math.min(limit, payload.length);
      sizes.push(written);
      return written;
    }
  };
}

const encode = (text: string) => new TextEncoder().encode(text);

test("a short write leaves the remainder queued rather than dropping it", () => {
  const writer = new SocketWriter();
  const socket = scriptedSocket([2]);
  writer.write(socket, encode("hello\n"));
  assert.equal(writer.pendingBytes, 4, "the unaccepted tail must survive");
  assert.equal(writer.isIdle, false);
});

test("messages queued behind a stall keep their order and drain fully", () => {
  const writer = new SocketWriter();
  const socket = scriptedSocket([2]);
  writer.write(socket, encode("hello\n"));
  writer.write(socket, encode("second\n"));
  // Only the first write reaches the socket: writing again before drain would
  // disarm the writable poll that the short write armed.
  assert.equal(socket.sizes.length, 1, "a blocked writer must not keep writing");
  assert.equal(writer.pendingBytes, 11, "both tails stay queued");

  writer.flush(socket);
  assert.deepEqual(socket.sizes, [2, 4, 7], "the head finishes before the next message starts");
  assert.equal(writer.pendingBytes, 0);
  assert.equal(writer.isIdle, true);
});

// Bun returns -1 from write() on a closed socket rather than throwing.
test("a socket that accepts nothing parks the payload instead of losing it", () => {
  const writer = new SocketWriter();
  const closed = { write: () => -1 };
  writer.write(closed, encode("hello\n"));
  assert.equal(writer.pendingBytes, 6, "a rejected write must not consume the payload");

  writer.flush(scriptedSocket([]));
  assert.equal(writer.pendingBytes, 0, "a later working socket drains the same queue");
});

test("an empty payload is not queued", () => {
  const writer = new SocketWriter();
  const socket = scriptedSocket([]);
  writer.write(socket, new Uint8Array(0));
  assert.equal(writer.isIdle, true);
  assert.equal(socket.sizes.length, 0);
});
