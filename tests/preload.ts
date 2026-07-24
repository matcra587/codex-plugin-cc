import { fs, os, path } from "../plugins/codex/scripts/lib/platform.ts";

const testStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-test-state-"));

process.env.CLAUDE_PLUGIN_DATA = path.join(testStateRoot, "plugin-data");
process.env.XDG_STATE_HOME = path.join(testStateRoot, "xdg-state");
