import { path } from "./platform.ts";

export interface BrokerEndpoint {
  kind: "unix";
  path: string;
}

export function createBrokerEndpoint(sessionDir: string): string {
  return `unix:${path.join(sessionDir, "broker.sock")}`;
}

export function parseBrokerEndpoint(endpoint: string | null | undefined): BrokerEndpoint {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error("Missing broker endpoint.");
  }

  if (endpoint.startsWith("unix:")) {
    const socketPath = endpoint.slice("unix:".length);
    if (!socketPath) {
      throw new Error("Broker Unix socket endpoint is missing its path.");
    }
    return { kind: "unix", path: socketPath };
  }

  throw new Error(`Unsupported broker endpoint: ${endpoint}`);
}
