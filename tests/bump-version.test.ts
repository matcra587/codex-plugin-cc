import { fs, path } from "../plugins/codex/scripts/lib/platform.ts";
import { test } from "bun:test";
import { assert } from "./assertions.ts";

import { makeTempDir, run } from "./helpers.ts";

const ROOT = path.resolve(path.dirname(Bun.fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "bump-version.ts");

function writeJson(filePath: string, json: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

interface VersionDocument {
  version: string;
  metadata: { version: string };
  plugins: Array<{ version: string }>;
}

function readJson(filePath: string): VersionDocument {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as VersionDocument;
}

function makeVersionFixture() {
  const root = makeTempDir();

  writeJson(path.join(root, "package.json"), {
    name: "@openai/codex-plugin-cc",
    version: "1.0.2"
  });
  writeJson(path.join(root, "plugins", "codex", ".claude-plugin", "plugin.json"), {
    name: "codex",
    version: "1.0.2"
  });
  writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
    metadata: {
      version: "1.0.2"
    },
    plugins: [
      {
        name: "codex",
        version: "1.0.2"
      }
    ]
  });

  return root;
}

test("bump-version updates every release manifest", () => {
  const root = makeVersionFixture();

  const result = run("bun", [SCRIPT, "--root", root, "1.2.3"], {
    cwd: ROOT
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(path.join(root, "package.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "plugins", "codex", ".claude-plugin", "plugin.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).metadata.version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).plugins[0]?.version, "1.2.3");
});

test("bump-version check mode reports stale metadata", () => {
  const root = makeVersionFixture();
  writeJson(path.join(root, "package.json"), {
    name: "@openai/codex-plugin-cc",
    version: "1.0.3"
  });

  const result = run("bun", [SCRIPT, "--root", root, "--check"], {
    cwd: ROOT
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugins\/codex\/\.claude-plugin\/plugin\.json version/);
  assert.match(result.stderr, /\.claude-plugin\/marketplace\.json metadata\.version/);
});
