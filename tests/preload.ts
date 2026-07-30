import { afterEach } from "bun:test";
import { sendBrokerShutdown, teardownBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.ts";
import { fs, os, path } from "../plugins/codex/scripts/lib/platform.ts";
import { isRecord } from "../plugins/codex/scripts/lib/validation.ts";

const testStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-test-state-"));
const pluginDataDir = path.join(testStateRoot, "plugin-data");

process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
process.env.XDG_STATE_HOME = path.join(testStateRoot, "xdg-state");

afterEach(async () => {
  const stateRoot = path.join(pluginDataDir, "state");
  if (!fs.existsSync(stateRoot)) {
    return;
  }

  for (const workspaceDir of fs.readdirSync(stateRoot)) {
    const brokerFile = path.join(stateRoot, workspaceDir, "broker.json");
    if (!fs.existsSync(brokerFile)) {
      continue;
    }

    let broker: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(brokerFile, "utf8"));
      broker = isRecord(parsed) ? parsed : {};
    } catch {
      // Malformed test state still needs its index removed.
    }

    if (typeof broker.endpoint === "string") {
      await sendBrokerShutdown(broker.endpoint);
    }
    teardownBrokerSession({
      endpoint: typeof broker.endpoint === "string" ? broker.endpoint : null,
      pidFile: typeof broker.pidFile === "string" ? broker.pidFile : null,
      logFile: typeof broker.logFile === "string" ? broker.logFile : null,
      sessionDir: typeof broker.sessionDir === "string" ? broker.sessionDir : null,
      pid: typeof broker.pid === "number" ? broker.pid : null
    });
    if (fs.existsSync(brokerFile)) {
      fs.unlinkSync(brokerFile);
    }
  }
});
