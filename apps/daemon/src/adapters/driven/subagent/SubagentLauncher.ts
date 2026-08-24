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
import { truncateToolResult } from "./transport/wire";
import type { ChildOutboundLine, ToolResponseLine } from "./transport/wire";
import { scopedBrowserCall } from "./ScopedBrowserProxy";
import type { BrowserPort } from "../../../application/ports/outbound/BrowserPort";

/**
 * SubagentLauncher —— InstanceRunner 真体（O-7 候选 A 形态）。
 *
 * 每个 SubAgent 实例 = 一个独立子进程（bun run ChildMain.ts，detached
 * 独立进程组）：launch 秒回（spawn 不 await 收口——closure 经
 * InstanceRunnerCallbacks 异步上报，AD-8）；崩溃检测 = exit 非 0 且未回传
 * closure → failed 收口；kill = O-6 序列（transport 承载）。
 *
 * 与 InstanceRunner 接口的对接说明：接口成员 =
 * launch/setCallbacks/send?/kill?（send/kill 原为接口外扩展方法，
 * 收进接缝；kill 通道经此由 SchedulerService.kill 触发）。
 *
 * AD-3（TR-AD-24，T12 砍 spawn 会话快照级）：launch 段是模型两级解析链
 * 唯一消费点——①profile.model（声明即最高）→ ②uiModelSlot（resource_state
 * kind 槽位 UI 化）→ ③全局兜底（deps.model getter，注入源模式保留）。
 * SubAgent 只认自身 profile 链，不继承 main session 选择（用户决策 T12）。
 */

/**
 * daemon 入口路径（main.ts，与子进程 spawn 命令配套的入口实参）：
 * dev 形态 = bun 直跑本仓 main.ts 源码；compile 形态该实参被产物惰性忽略
 * （$bunfs 虚拟路径，产物恒重入内嵌 main）——两形态同一 argv 组装
 * （`[execPath, 入口, "--child-main", ...]`，main.ts argv 分发进 ChildMain
 * 逻辑），无形态自检分叉。
 */
const DAEMON_ENTRY_PATH = join(import.meta.dir, "..", "..", "..", "main.ts");

export interface SubagentLauncherDeps {
  /**
   * SubAgent profile 声明（装配进子进程；kind 不分支——声明同构，TR-AD-4）。
   * 接受 getter（launch 时刻读现值——组合根经此把 resource_state kind 槽位
   * （thinking/model 配置面）合并进解析输入；model/apiKeys 注入源模式同构先例）
   * 或静态对象。
   */
  readonly profile: AgentProfile | (() => AgentProfile);
  /**
   * 全局兜底模型完整对象（解析单点产物，经 env JSON 透传子进程）。
   * 注入源为全局兜底模型存储（AD-2）——接受 getter（每次 launch 读现值，
   * set_default 后新子进程跟随）或静态对象。
   * AD-3：两级解析链末级（profile.model ?? uiModelSlot ?? 本项）。
   */
  readonly model: Model<any> | (() => Model<any>);
  /**
   * 模型目录（仅当 profile.model 声明时用于槽位解析——resolveModel 同源；
   * 未声明 profile.model 时不需要）。
   */
  readonly models?: Models;
  /**
   * provider → apiKey（子进程显式传入，AD-11/13）。注入源改 auth.json
   * ——接受 getter（每次 launch 读现值快照）或静态表。
   */
  readonly apiKeys: Record<string, string> | (() => Record<string, string>);
  /** 工具沙箱 cwd（子进程 CoreToolExecutor 用）。 */
  readonly toolCwd: string;
  /**
   * spawn 快照（代际生效，TR-AD-24 同构）：launch 时刻读一次的组装
   * 产物缓存（组合根在启动与 toggle applied 后刷新；systemPrompt = base +
   * 生效工具清单 + 生效技能段，tools = getEffectiveTools 生效集）。透传
   * env（HELIX_SYSTEM_PROMPT / HELIX_TOOLS_JSON），子进程定格消费；缺省
   * 不注入（既有测试形态回退 profile 声明面）。
   */
  readonly spawnSnapshot?: () => {
    readonly tools: readonly string[];
    readonly systemPrompt: string;
  };
  /**
   * 模型槽位（profile 槽位 UI 化）：resource_state kind 槽位读面
   * （组合根注入——槽位 id → 完整 Model 对象解析后返回；未设 = undefined
   * 走后续档）。launch 时刻读取定格（同 spawn 快照语义）。
   */
  readonly uiModelSlot?: () => Model<any> | undefined;
  /** O-6 SIGKILL 升级阈值 ms（缺省 3000；测试注入小值）。 */
  readonly graceMs?: number;
  /** 剧本文件路径（测试注入；生产 undefined → 子进程用真实 streamFn）。 */
  readonly fakeEngineScript?: string;
  /**
   * 全局唯一 CDP 单例（H-3：tool-req 转发目标——经 ScopedBrowserProxy 归属
   * 校验后调用；ownerId 强制 = 通道 instanceId）。缺省（测试 Fake 引擎形态）
   * → tool-req 回执 ok:false「未装配」。
   */
  readonly browser?: BrowserPort;
  /** tool-res 出口 result 截断上限字节（可注入；缺省 256KB，wire.ts 常量）。 */
  readonly toolResultMaxBytes?: number;
  /** 线协议观测面（测试断言/诊断；WS 事件映射接线点）。 */
  readonly onLine?: (instanceId: string, line: ChildOutboundLine) => void;
  /** 日志（容器接 file logger——dispose kill 失败可观测；缺省静默）。 */
  readonly logger?: { warn: (message: string) => void };
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

  /**
   * AD-3 两级模型解析单点（TR-AD-24，T12 砍 spawn 会话快照级）：
   * ①profile.model（真实槽位，声明即最高优先级，装配期 resolveModel 解析）
   * → ②uiModelSlot（resource_state kind 槽位 UI 化，launch
   * 时刻读取）→ ③deps.model（全局兜底 getter）。高档有值即短路（低档不
   * 调用）；返回完整 Model 对象（透传形态）。SubAgent 只认自身 profile
   * 链——不继承 main session 选择（spawn 透传值仅填充 AgentInstanceDto.model，
   * 不进本链）。
   */
  resolveModelFor(): Model<any> {
    const slot = this.profileNow().model;
    if (slot !== undefined) {
      if (this.deps.models === undefined) {
        throw new Error(
          `SubAgentProfile.model 声明了 "${slot}"，但 SubagentLauncher 未注入 models 目录` +
            `（profile 槽位解析面缺失，组合根装配遗漏）。`,
        );
      }
      return resolveModel(this.deps.models, slot); // 失败 fail-fast 含 id（resolveModel 契约）
    }
    const uiSlot = this.deps.uiModelSlot?.();
    if (uiSlot !== undefined) return uiSlot;
    return typeof this.deps.model === "function" ? this.deps.model() : this.deps.model;
  }

  /** profile 声明读面（getter 注入源模式：launch 时刻读现值定格）。 */
  private profileNow(): AgentProfile {
    return typeof this.deps.profile === "function" ? this.deps.profile() : this.deps.profile;
  }

  /**
   * thinking 解析单点（AD-1 落点二，thinking 批 T1.3）：单点短路链
   * ——仅自身 profile.thinkingLevel 槽位（含组合根合并的 subagent-worker
   * 槽位），无兜底（默认关 D 方案：未配置 → undefined → env 缺席 → 子
   * 进程不装注入器 = pi-ai 不传 reasoning 显式关）。有意短于模型两级链：
   * SubAgent 无 UI/快照级覆盖（红线：主会话覆盖永不进入本链——输入只有
   * profile 槽位，无会话覆盖读面）。launch 段唯一消费点（调用一次，结果
   * 经 env 定格透传子进程——代际生效，运行期不变）。
   */
  resolveThinkingFor(): string | undefined {
    return this.profileNow().thinkingLevel;
  }

  /** 启动实例执行（秒回：spawn + 接线，不 await 收口）。同一实例不重复 launch。 */
  launch(instance: AgentInstance, task: string): void {
    const id = instance.instanceId;
    if (this.children.has(id)) return;
    // AD-3：两级解析单点（profile 槽位 > 全局兜底 getter；T12 砍 spawn 会话快照级）；
    // apiKeys 读现值（getter 注入源 = auth.json）
    const model = this.resolveModelFor();
    const thinkingLevel = this.resolveThinkingFor(); // launch 时刻定格（AD-1：spawn 快照）
    const apiKeys = typeof this.deps.apiKeys === "function" ? this.deps.apiKeys() : this.deps.apiKeys;
    // spawn 快照：launch 时刻读一次（toggle 后新 spawn 跟随新值，已
    // spawn 实例 env 已定格不受影响——代际生效）
    const snapshot = this.deps.spawnSnapshot?.();
    const proc = Bun.spawn({
      cmd: [process.execPath, DAEMON_ENTRY_PATH, "--child-main", "--task", task],
      env: {
        ...process.env,
        HELIX_INSTANCE_ID: id,
        HELIX_MODEL_JSON: JSON.stringify(model), // 完整对象透传
        HELIX_THINKING_LEVEL: thinkingLevel, // thinking 定格值（字符串透传，无 registry 防重建红线）
        HELIX_API_KEYS_JSON: JSON.stringify(apiKeys),
        HELIX_TOOL_CWD: this.deps.toolCwd,
        ...(snapshot !== undefined
          ? {
              HELIX_SYSTEM_PROMPT: snapshot.systemPrompt,
              HELIX_TOOLS_JSON: JSON.stringify(snapshot.tools),
            }
          : {}),
        ...(this.deps.fakeEngineScript !== undefined
          ? { HELIX_FAKE_ENGINE_SCRIPT: this.deps.fakeEngineScript }
          : {}), // 剧本 env 注入
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

  // ── 观测/控制面（send/kill 已收进 InstanceRunner 接缝，其余为观测面） ──

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
      [...this.children.entries()].map(([instanceId, entry]) =>
        entry.transport.kill().catch((err) => {
          // kill 拒绝可观测（transport 契约可拒绝；丢弃但收尾继续）
          this.deps.logger?.warn(
            `[subagent] dispose kill 子进程失败（实例 ${instanceId}）：${(err as Error).message}`,
          );
        }),
      ),
    );
  }

  // ── 内部：线协议分发 + 崩溃检测 ───────────────────────────

  private onChildLine(id: string, line: ChildOutboundLine): void {
    this.deps.onLine?.(id, line);
    if (line.type === "event") {
      // 携事件本体上行（SubAgent 工具调用转 per-instance 领域事件）
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
    if (line.type === "tool-req") {
      void this.onToolRequest(id, line.reqId, line.method, line.args);
      return;
    }
    // started/log：观测面已转发，无需编排动作
  }

  /**
   * H-3 tool-req 转发：scopedBrowserCall 归属校验 + browser 单例执行 →
   * tool-res 回写（出口截断护栏）。只转发不决策（AG-12）——白名单/归属
   * 规则全部在 ScopedBrowserProxy 纯函数面。回写已死子进程 stdin 静默吞错。
   */
  private async onToolRequest(id: string, reqId: number, method: string, args: readonly unknown[]): Promise<void> {
    let res: ToolResponseLine;
    if (this.deps.browser === undefined) {
      res = { type: "tool-res", reqId, ok: false, error: "browser 未装配（SubagentLauncher 无 browser 注入——测试 Fake 引擎形态）" };
    } else {
      try {
        const value = await scopedBrowserCall(this.deps.browser, id, method, args);
        res = { type: "tool-res", reqId, ok: true, value: truncateToolResult(value, this.deps.toolResultMaxBytes) };
      } catch (err) {
        res = { type: "tool-res", reqId, ok: false, error: (err as Error).message };
      }
    }
    try {
      this.children.get(id)?.transport.writeToolRes(res);
    } catch {
      /* 回写已死子进程 stdin：静默吞错（H-3 失败语义） */
    }
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
