import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
import type { Daemon } from "../../src/infrastructure/container";
import type {
  InstanceRunner,
  InstanceRunnerCallbacks,
  InstanceClosureOutcome,
} from "../../src/application/services/InstanceRunner";
import { SessionNotFoundError } from "../../src/application/services/SessionRegistry";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * T1.3 integration（TP-1.3a #1）：container.ts:387 冷会话 closure 补投
 * 吞错可观测（源 R-2.3——`.catch(() => undefined)` 吞掉 registry.get /
 * injectClosure 全部异常，恢复 IO 失败/补投异常对调用方不可见）。
 *
 * 触发链：SubAgent 收口 → ClosureRecorder.injectClosure → 组合根回调 →
 * 冷会话 `registry.get(sessionId)` 异步恢复。生产冷分支条件 = 会话已卸载
 * （unloadIdle 有 hasActiveInstances 守卫——活跃实例的会话不会卸载）；
 * 且 spawn 本身会经投影 write-through 落 session_state 行（会话可恢复）
 * ——公开 API 下「实例存活 + 会话不可恢复」组合理论不可达（与源注释
 * 「理论不可达」一致）。测试以注册表公开观测/恢复面注入该组合：
 * peek 返回未命中（冷分支条件）+ get 以真实 SessionNotFoundError
 * 形状拒绝（恢复失败），断言 warn 含定位（模块 + 场景）且含会话 id。
 *
 * spy = daemon.logger.warn 观察面覆写（组合根全图共享同一 logger 对象，
 * 属性访问时点生效——观察面非替身，TP-1.3c）；被测单元（组合根回调
 * wiring + catch→warn）不 mock。
 */

/** 挂起 SubAgent runner 替身（closure 由测试 forceClosure 驱动）。 */
class ScriptedRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  private readonly closed = new Set<string>();
  readonly kills: string[] = [];

  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }
  launch(): void {
    // 挂起语义：不自动收口
  }
  kill(instanceId: string): Promise<unknown> {
    this.kills.push(instanceId);
    return Promise.resolve("graceful");
  }
  forceClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    if (this.closed.has(instanceId)) return;
    this.closed.add(instanceId);
    this.callbacks?.onInstanceClosure(instanceId, outcome);
  }
}

const DONE = (summary: string) => ({
  status: "done" as const,
  summary,
  reportPath: null,
  findings: null,
  taskId: null,
});

const OUTCOME = (summary: string): InstanceClosureOutcome => ({ result: "done", closure: DONE(summary) });

interface Rig {
  home: string;
  sessionId: string;
  runner: ScriptedRunner;
  daemon: Daemon;
  warns: string[];
  dispose: () => Promise<void>;
}

async function makeRig(): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-t13-cold-"));
  const engine = new FakeAgentEngine({});
  const runner = new ScriptedRunner();
  const daemon = await createTestDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    subagentRunner: runner,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
  });
  // spy logger（观察面）：覆写共享 logger 对象的 warn——组合根内全部
  // `logger.warn(...)` 属性访问时点命中 spy。
  const warns: string[] = [];
  const logger = daemon.logger;
  const origWarn = logger.warn.bind(logger);
  logger.warn = (m: string) => {
    warns.push(m);
  };
  return {
    home,
    sessionId: daemon.system.getStatus().sessionId,
    runner,
    daemon,
    warns,
    dispose: async () => {
      logger.warn = origWarn;
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function until(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`until 超时：${label}（${timeoutMs}ms）`));
      }
    }, 5);
  });
}

let current: Rig | undefined;
afterEach(async () => {
  if (current) {
    await current.dispose();
    current = undefined;
  }
});

describe("TP-1.3a #1 container injectClosure 冷会话补投吞错 → logger.warn", () => {
  test("冷会话恢复失败（SessionNotFoundError 形状注入）→ warn 含 [container] 定位 + 场景 + 会话 id；daemon 不崩", async () => {
    const rig = (current = await makeRig());
    const sessionId = rig.sessionId; // 零条目草稿：热注册但无库行（首条消息才落库）
    const registry = rig.daemon.registry;

    // ① 当前会话上 spawn 挂起 SubAgent（orchestration 面绑定当前会话）
    const outcome = rig.daemon.orchestration.spawn("触发冷补投的任务");
    expect(outcome.status).toBe("run");
    if (outcome.status !== "run") throw new Error("unreachable");
    const agentId = outcome.agentId; // T10a：spawn id = agent-<唯一串>，捕获而非硬编码

    // ② 注入生产不可达组合（见文件头注释）：peek 未命中（冷分支条件）+
    //    get 以真实 SessionNotFoundError 形状拒绝（恢复失败）。peek/get
    //    均为注册表公开面。
    const origPeek = registry.peek.bind(registry);
    registry.peek = (id: string) => (id === sessionId ? undefined : origPeek(id));
    const origGet = registry.get.bind(registry);
    registry.get = (id: string) =>
      id === sessionId ? Promise.reject(new SessionNotFoundError(id)) : origGet(id);

    // ③ 收口到达 → injectClosure 走冷补投链 → catch（原静默）→ 期望 warn
    rig.runner.forceClosure(agentId, OUTCOME("任务结果"));
    await until(() => rig.warns.length > 0, 2_000, "冷补投失败 warn 到达");

    registry.peek = origPeek; // 还原观测面
    registry.get = origGet;
    const msg = rig.warns.find((m) => m.includes("[container]"));
    expect(msg).toBeDefined();
    expect(msg!.includes("补投失败")).toBe(true);
    expect(msg!.includes(sessionId)).toBe(true);
    // daemon 存活（吞错不崩语义保持）：orchestration 观测面仍可用
    expect(rig.daemon.orchestration.status(agentId)[0]?.state).toBeDefined();
  });
});
