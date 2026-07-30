import { expectTypeOf, test } from "bun:test";
import type { AppServerRequestParams } from "../plugins/codex/scripts/lib/app-server-protocol";
import { parseArgs } from "../plugins/codex/scripts/lib/args.ts";
import type { ReasoningEffort, TaskRequest } from "../plugins/codex/scripts/lib/domain.ts";
import type { ResolvedReviewTarget } from "../plugins/codex/scripts/lib/git.ts";

test("public runtime boundaries retain their narrow types", () => {
  const parsed = parseArgs([], {
    valueOptions: ["cwd", "model"],
    booleanOptions: ["json"]
  });

  expectTypeOf(parsed.options.cwd).toEqualTypeOf<string | undefined>();
  expectTypeOf(parsed.options.model).toEqualTypeOf<string | undefined>();
  expectTypeOf(parsed.options.json).toEqualTypeOf<boolean | undefined>();
  expectTypeOf<AppServerRequestParams<"turn/interrupt">>().toEqualTypeOf<{
    threadId: string;
    turnId: string;
  }>();
  expectTypeOf<TaskRequest["effort"]>().toEqualTypeOf<ReasoningEffort | null>();
  expectTypeOf<ResolvedReviewTarget>().toBeObject();
});
