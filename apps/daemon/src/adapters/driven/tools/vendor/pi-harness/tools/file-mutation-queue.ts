import type { Context } from "../context.ts";
import type { ExecutionEnv } from "../types.ts";
import { getOrThrow } from "../types.ts";

type MutationQueueState = {
	queues: Map<string, Promise<void>>;
	registration: Promise<void>;
};

const states = new WeakMap<ExecutionEnv, MutationQueueState>();

function getState(env: ExecutionEnv): MutationQueueState {
	let state = states.get(env);
	if (!state) {
		state = { queues: new Map(), registration: Promise.resolve() };
		states.set(env, state);
	}
	return state;
}

/* LOCAL PATCH (helix, code-review B13): queue key must be stable across the
 * file creation boundary. Upstream keyed the queue by canonical path when the
 * target exists and by absolute path when it does not — the same file flips
 * queue keys on create/delete, so a mutation registered while the file was
 * missing (key = abs) races a later mutation registered after creation
 * (key = canonical) in two non-serializing queues, silently dropping updates
 * (read-modify-write edit vs. write). Fix: occupy BOTH keys — the absolute
 * path plus the canonical path when resolvable — so any view of the same
 * file serializes on a shared key. Upstream fix pending; drop this patch when
 * vendoring a release that keys stably. */
async function getMutationQueueKeys(env: ExecutionEnv, path: string, context: Context): Promise<string[]> {
	const absolutePath = getOrThrow(await env.absolutePath(path, context));
	const canonicalPath = await env.canonicalPath(absolutePath, context);
	if (canonicalPath.ok) {
		// 双键去重：canonical 与 abs 同值（无 symlink/归一化差异）时只占一键
		return canonicalPath.value === absolutePath ? [absolutePath] : [absolutePath, canonicalPath.value];
	}
	if (canonicalPath.error.code === "not_found" || canonicalPath.error.code === "not_supported") return [absolutePath];
	throw canonicalPath.error;
}

/** Serialize file mutations targeting the same environment and canonical path. */
export async function withFileMutationQueue<T>(
	env: ExecutionEnv,
	path: string,
	fn: () => Promise<T>,
	context: Context,
): Promise<T> {
	const state = getState(env);
	const registration = state.registration.then(async () => {
		// LOCAL PATCH (helix, B13)：abs+canonical 双键原子占位（注册链内串行，
		// 无死锁：键链 FIFO 且占位按注册全序进行）；同文件任意视角共享至少一键。
		const keys = await getMutationQueueKeys(env, path, context);
		const entries = keys.map((key) => {
			const currentQueue = state.queues.get(key) ?? Promise.resolve();

			let releaseNext = () => {};
			const nextQueue = new Promise<void>((resolve) => {
				releaseNext = resolve;
			});
			const chainedQueue = currentQueue.then(() => nextQueue);
			state.queues.set(key, chainedQueue);
			return { key, currentQueue, chainedQueue, releaseNext };
		});
		return entries;
	});
	state.registration = registration.then(
		() => undefined,
		() => undefined,
	);

	const entries = await registration;
	await Promise.all(entries.map((entry) => entry.currentQueue));
	try {
		return await fn();
	} finally {
		for (const entry of entries) {
			entry.releaseNext();
			if (state.queues.get(entry.key) === entry.chainedQueue) state.queues.delete(entry.key);
		}
	}
}
