/**
 * 05-harness-confirm：F-7 红线实测化——AgentHarness 在 0.84.2 是「类型契约 + 全部抛
 * HarnessNotImplemented 的骨架」。
 *
 * 无网络、无 key 依赖。复跑：bun run 05-harness-confirm.ts
 */
import { AgentHarness, HarnessNotImplemented, InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { makeLogger } from "./lib.ts";

const log = makeLogger("05");
log.script("start", { pkg: "@earendil-works/pi-agent-core@0.84.2" });

// 1) 空会话（无 LaneRecord）上 create() —— 观察是否可创建
const repo = new InMemorySessionRepo();
const session = await repo.create({});
const models = builtinModels();
const model = models.getModel("zai-coding-cn", "glm-5.3")!;

let harness: AgentHarness | undefined;
try {
  const created = await AgentHarness.create({ session, models, model });
  harness = created.harness;
  log.script("create(空会话)", { ok: true, suspended: created.suspended.length });
} catch (err) {
  log.script("create(空会话) 抛错", { name: (err as Error).constructor.name, message: (err as Error).message });
}

// 2) 已有记录的会话上 create() —— 观察恢复路径
const session2 = await repo.create({});
await session2.appendMessage({ role: "user", content: "seed", timestamp: Date.now() } as never);
await session2.appendRecord({ type: "operation_started", id: "op-1", lane: "main", sourceLeafId: null, intent: { kind: "run", originalPrompt: [], initialMessages: [] } });
try {
  await AgentHarness.create({ session: session2, models, model });
  log.script("create(有记录会话)", { ok: true });
} catch (err) {
  log.script("create(有记录会话) 抛错", {
    name: (err as Error).constructor.name,
    isHarnessNotImplemented: err instanceof HarnessNotImplemented,
    message: (err as Error).message,
  });
}

// 3) 逐方法调用空会话 harness，观察全部 reject with HarnessNotImplemented
if (harness) {
  const probes: [string, () => Promise<unknown>][] = [
    ["prompt", () => harness!.prompt("hi")],
    ["steer", () => harness!.steer("hi")],
    ["followUp", () => harness!.followUp("hi")],
    ["compact", () => harness!.compact()],
    ["abort", () => harness!.abort()],
    ["resume", () => harness!.resume()],
    ["runToCompletion", () => harness!.runToCompletion()],
    ["watch", () => harness!.watch()],
  ];
  for (const [name, fn] of probes) {
    try {
      await fn();
      log.script(`harness.${name}()`, { resolved: true });
    } catch (err) {
      log.script(`harness.${name}() 拒绝`, {
        name: (err as Error).constructor.name,
        isHarnessNotImplemented: err instanceof HarnessNotImplemented,
        message: (err as Error).message,
      });
    }
  }
}

log.script("done", {
  conclusion:
    "AgentHarness.create 在空会话上可返回实例，但 prompt/steer/followUp/compact/abort/resume/runToCompletion/watch 等运行时方法全部 reject HarnessNotImplemented；带记录会话 create() 即抛 create.restore —— F-7「空骨架不可用」结论的运行时证据。",
});
