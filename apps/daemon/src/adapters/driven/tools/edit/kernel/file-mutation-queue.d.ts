// VENDORED from @earendil-works/pi-agent-core@0.87.0 dist/harness/tools/file-mutation-queue.d.ts
// Upstream unexported (package exports whitelist) — AF-1, iter-20260825-11fo.
// Do NOT hand-edit. Re-sync = re-copy from pinned version + parity tests must pass.
import type { Context } from "../context.ts";
import type { ExecutionEnv } from "../types.ts";
/** Serialize file mutations targeting the same environment and canonical path. */
export declare function withFileMutationQueue<T>(env: ExecutionEnv, path: string, fn: () => Promise<T>, context: Context): Promise<T>;
//# sourceMappingURL=file-mutation-queue.d.ts.map