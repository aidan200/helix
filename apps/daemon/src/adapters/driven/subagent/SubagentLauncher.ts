import { join } from "node:path";
import type { Model, Models } from "@earendil-works/pi-ai";
import { resolveModel } from "../pi-engine/model-provider";
import type { AgentInstance } from "../../../domain/agent/AgentInstance";
import type { InstanceClosurePayload } from "../../../domain/events/DomainEvent";
import type {
  InstanceClosureOutcome,
  InstanceRunner,
  InstanceRunnerCallbacks,
} from "../../../application/services/InstanceRunner";
import type { AgentEngineEvent } from "../../../application/ports/outbound/AgentEnginePort";
import type { AgentProfile } from "../pi-engine/runtime/AgentProfile";
import { ChildProcessTransport } from "./transport/ChildProcessTransport";
import type { ChildOutboundLine } from "./transport/wire";

/**
 * SubagentLauncher —— InstanceRunner 真体（T2.2；O-7 候选 A 形态）。
 *
 * 每个 SubAgent 实例 = 一个独立子进程（bun run ChildMain.ts，detached
 * 独立进程组）：launch 秒回（spawn 不 await 收口——closure 经
 * InstanceRunnerCallbacks 异步上报，AD-8）；崩溃检测 = exit 非 0 且未回传
 * closure → failed 收口；kill = O-6 序列（transport 承载）。
 *
 * 与 T2.1 InstanceRunner 接口的对接说明（T2.3 已对齐）：接口成员 =
 * launch/setCallbacks/send?/kill?（send/kill 原为接口外扩展方法，T2.3
 * 收进接缝；FB-3 kill 通道经此由 SchedulerService.kill 触发）。
 *
 * AD-3（F1.3，TR-AD-24）：launch 段是模型三级解析链唯一消费点——
 * ①profile.model（声明即最高）→ ②spawn 会话快照（spawnModelFor 晚绑
 * 回调）→ ③全局兜底（deps.model getter，T2.3 注入源模式保留）。
 */

/** ChildMain 入口路径（与 Launcher 同目录树；bun 直跑 .ts）。 */
const CHILD_MAIN_PATH = join(import.meta.dir, "child", "ChildMain.ts");

export interface SubagentLauncherDeps {
  /** SubAgent profile 声明（装配进子进程；kind 不分支——声明同构，TR-AD-4）。 */
  readonly profile: AgentProfile;
  /**
   * 全局兜底模型完整对象（F-14：解析单点产物，经 env JSON 透传子进程）。
   * T2.3（AD-2）：注入源改全局兜底模型存储——接受 getter（每次 launch 读现值，
   * set_default 后新子进程跟随）或静态对象。
   * AD-3（F1.3）：三级解析链第三级（profile.model ?? spawn 快照 ?? 本项）。
   */
  readonly model: Model<any> | (() => Model<any>);
  /**
   * AD-3 三级链第二级：spawn 会话快照读取回调（per-instance 解析形态）。
   * 生产由 container 在 scheduler 构造后经 bindSpawnModelSource 晚绑
   * （装配序：launcher 先于 scheduler）；deps 直注为测试便捷口。
   */
  readonly spawnModelFor?: (instanceId: string) => Model<any> | undefined;
  /**
   * 模型目录（仅当 profile.model 声明时用于槽位解析——resolveModel 同源；
   * 未声明 profile.model 时不需要）。
   */
  readonly models?: Models;
  /**
   * provider → apiKey（子进程显式传入，AD-11/13）。T2.3：注入源改 auth.json
   * ——接受 getter（每次 launch 读现值快照）或静态表。
   */
  readonly apiKeys: Record<string, string> | (() => Record<string, string>);
  /** 工具沙箱 cwd（子进程 CoreToolExecutor 用）。 */
  readonly toolCwd: string;
  /** O-6 SIGKILL 升级阈值 ms（缺省 3000；测试注入小值）。 */
  readonly graceMs?: number;
  /** K3 剧本文件路径（测试注入；生产 undefined → 子进程用真实 streamFn）。 */
  readonly fakeEngineScript?: string;
  /** 线协议观测面（测试断言/诊断；T2.3 WS 事件映射接线点）。 */
  readonly onLine?: (instanceId: string, line: ChildOutboundLine) => void;
}

interface ChildEntry {
  readonly transport: ChildProcessTransport;
  /** 已上报收口（防重；late crash 行被吞）。 */
  closed: boolean;
}

export class SubagentLauncher implements InstanceRunner {
  private callbacks: InstanceRunnerCallbacks | undefined;
  private readonly children = new Map<string, ChildEntry>();
  /** AD-3 第二级读取回调（deps.spawnModelFor 初始化；bindSpawnModelSource 晚绑覆盖）。 */
  private spawnModelFor: ((instanceId: string) => Model<any> | undefined) | undefined;

  constructor(private readonly deps: SubagentLauncherDeps) {
    this.spawnModelFor = deps.spawnModelFor;
  }

  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * spawn 会话快照源晚绑（AD-3；container 手工装配：launcher 先于
   * scheduler 构造，scheduler 就绪后一行绑定——遵循组合根手工装配先例）。
   */
  bindSpawnModelSource(source: (instanceId: string) => Model<any> | undefined): void {
    this.spawnModelFor = source;
  }

  /**
   * AD-3 三级模型解析单点（F1.3，TR-AD-24）：
   * ①profile.model（真实槽位，声明即最高优先级，装配期 resolveModel 解析）
   * → ②spawnModelFor（spawn 时刻会话快照）→ ③deps.model（全局兜底 getter）。
   * 高档有值即短路（低档不调用）；返回完整 Model 对象（F-14 透传形态）。
   */
  resolveModelFor(instanceId: string): Model<any> {
    const slot = this.deps.profile.model;
    if (slot !== undefined) {
      if (this.deps.models === undefined) {
        throw new Error(
          `SubAgentProfile.model 声明了 "${slot}"，但 SubagentLauncher 未注入 models 目录` +
            `（profile 槽位解析面缺失，组合根装配遗漏）。`,
        );
      }
      return resolveModel(this.deps.models, slot); // 失败 fail-fast 含 id（resolveModel 契约）
    }
    const spawned = this.spawnModelFor?.(instanceId);
    if (spawned !== undefined) return spawned;
    return typeof this.deps.model === "function" ? this.deps.model() : this.deps.model;
  }

  /** 启动实例执行（秒回：spawn + 接线，不 await 收口）。同一实例不重复 launch。 */
  launch(instance: AgentInstance, task: string): void {
    const id = instance.instanceId;
    if (this.children.has(id)) return;
    // AD-3：三级解析单点（profile > spawn 会话快照 > 全局兜底 getter）；
    // apiKeys 读现值（getter 注入源 = auth.json，T2.3）
    const model = this.resolveModelFor(id);
    const apiKeys = typeof this.deps.apiKeys === "function" ? this.deps.apiKeys() : this.deps.apiKeys;
    const proc = Bun.spawn({
      cmd: [process.execPath, CHILD_MAIN_PATH, "--task", task],
      env: {
        ...process.env,
        HELIX_INSTANCE_ID: id,
        HELIX_MODEL_JSON: JSON.stringify(model), // F-14 完整对象透传
        HELIX_API_KEYS_JSON: JSON.stringify(apiKeys),
        HELIX_TOOL_CWD: this.deps.toolCwd,
        ...(this.deps.fakeEngineScript !== undefined
          ? { HELIX_FAKE_ENGINE_SCRIPT: this.deps.fakeEngineScript }
          : {}), // K3：剧本 env 注入
      } as Record<string, string | undefined>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      detached: true, // 独立进程组（O-6 负 pgid 组回收前提）
    });
    const transport = new ChildProcessTransport(proc, this.deps.graceMs ?? 3000);
    this.children.set(id, { transport, closed: false });
    transport.onLine((line) => this.onChildLine(id, line));
    // 崩溃检测：exit 后先等 stdout 排空（closure 行可能尚在管道缓冲），
    // 仍未收口才判 failed（cap 500ms 防孙进程长期占住管道）。
    void (async () => {
      const code = await transport.exited;
      await Promise.race([transport.drained, new Promise((r) => setTimeout(r, 500))]);
      this.onChildExit(id, code);
    })();
  }

  // ── 观测/控制面（send/kill 已收进 InstanceRunner 接缝，T2.3；其余为观测面） ──

  /** steer 注入经 stdin send 行（AD-7⑤）。未知/已收口实例静默忽略。 */
  send(instanceId: string, text: string): void {
    const entry = this.children.get(instanceId);
    if (!entry || entry.closed) return; // 已收口：子进程退出中，静默丢弃
    entry.transport.send(text);
  }

  /**
   * O-6 kill 序列（SIGTERM 进程组 → grace 超时 SIGKILL 进程组）。
   * 幂等：未知实例/已退出返回 undefined。子进程优雅路径自行回传
   * failed(terminated) closure；SIGKILL 升级后无 closure，由崩溃检测
   * 兜底 failed 上报。调度侧（SchedulerService.kill）对迟到收口幂等吞。
   */
  async kill(instanceId: string): Promise<"graceful" | "escalated" | undefined> {
    const entry = this.children.get(instanceId);
    if (!entry) return undefined;
    return entry.transport.kill();
  }

  /** 子进程 pid（测试/诊断；未 launch 返回 undefined）。 */
  childPid(instanceId: string): number | undefined {
    return this.children.get(instanceId)?.transport.pid;
  }

  /** 子进程退出码 promise（测试/诊断）。 */
  childExit(instanceId: string): Promise<number | null> | undefined {
    return this.children.get(instanceId)?.transport.exited;
  }

  /** 收尾回收：对全部存活子进程执行 O-6 kill（daemon shutdown / 测试防孤儿）。 */
  async dispose(): Promise<void> {
    await Promise.all(
      [...this.children.values()].map((entry) => entry.transport.kill().catch(() => undefined)),
    );
  }

  // ── 内部：线协议分发 + 崩溃检测 ───────────────────────────

  private onChildLine(id: string, line: ChildOutboundLine): void {
    this.deps.onLine?.(id, line);
    if (line.type === "event") {
      // T2.3：携事件本体上行（SubAgent 工具调用转 per-instance 领域事件）
      this.callbacks?.onInstanceEvent(id, line.event);
      return;
    }
    if (line.type === "closure") {
      this.reportClosure(id, {
        result: line.closure.status === "done" ? "done" : "failed",
        closure: line.closure,
      });
      return;
    }
    if (line.type === "crash") {
      this.reportClosure(id, {
        result: "failed",
        closure: failedClosure(`子进程崩溃：${line.error}`),
        error: line.error,
      });
      return;
    }
    // started/log：观测面已转发，无需编排动作
  }

  private onChildExit(id: string, code: number | null): void {
    const entry = this.children.get(id);
    if (!entry || entry.closed) return; // closure 已回传（正常/优雅/崩溃行先行）
    const detail = code === null ? "信号终止" : `exit code ${code}`;
    this.reportClosure(id, {
      result: "failed",
      closure: failedClosure(`子进程异常退出（${detail}），未回传 closure`),
      error: `child exited with ${detail}`,
    });
  }

  private reportClosure(id: string, outcome: InstanceClosureOutcome): void {
    const entry = this.children.get(id);
    if (!entry || entry.closed) return; // 幂等：首个收口生效（竞态后到者吞）
    entry.closed = true; // 保留 entry（exit 码观测/launch 去重）；后续回调不再触发
    this.callbacks?.onInstanceClosure(id, outcome);
  }
}

function failedClosure(summary: string): InstanceClosurePayload {
  return { status: "failed", summary, reportPath: null, findings: null, taskId: null };
}
