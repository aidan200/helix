import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
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
 */

/** ChildMain 入口路径（与 Launcher 同目录树；bun 直跑 .ts）。 */
const CHILD_MAIN_PATH = join(import.meta.dir, "child", "ChildMain.ts");

export interface SubagentLauncherDeps {
  /** SubAgent profile 声明（装配进子进程；kind 不分支——声明同构，TR-AD-4）。 */
  readonly profile: AgentProfile;
  /**
   * 已解析的完整模型对象（F-14：解析单点产物，经 env JSON 透传子进程）。
   * T2.3（AD-2）：注入源改默认模型存储——接受 getter（每次 launch 读现值，
   * set_default 后新子进程跟随）或静态对象。
   */
  readonly model: Model<any> | (() => Model<any>);
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

  constructor(private readonly deps: SubagentLauncherDeps) {}

  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }

  /** 启动实例执行（秒回：spawn + 接线，不 await 收口）。同一实例不重复 launch。 */
  launch(instance: AgentInstance, task: string): void {
    const id = instance.instanceId;
    if (this.children.has(id)) return;
    // T2.3：model/apiKeys 读现值（getter 注入源 = 默认模型存储 + auth.json）
    const model = typeof this.deps.model === "function" ? this.deps.model() : this.deps.model;
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
