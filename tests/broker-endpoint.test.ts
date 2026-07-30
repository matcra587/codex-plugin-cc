import { test } from "bun:test";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.ts";
import { assert } from "./assertions.ts";

test("createBrokerEndpoint uses a Unix socket", () => {
  const endpoint = createBrokerEndpoint("/tmp/cxc-12345");
  assert.equal(endpoint, "unix:/tmp/cxc-12345/broker.sock");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "unix",
    path: "/tmp/cxc-12345/broker.sock"
  });
});
