import type { AgentEnginePort } from "../../src/application/ports/outbound/AgentEnginePort";
import type { InstanceRunner } from "../../src/application/services/InstanceRunner";
import type { BrowserPort } from "../../src/application/ports/outbound/BrowserPort";
import { assembleDaemon, type Daemon } from "../../src/infrastructure/container";
import type { EngineAssemblyMode } from "../../src/infrastructure/assembly/buildSessionStack";
import { CdpConnectionManager } from "../../src/adapters/driven/cdp/CdpConnectionManager";
import { createPaths, osHomeDir } from "../../src/infrastructure/paths";
import { acquireSingletonLock } from "../../src/infrastructure/lifecycle";
import { ensureConfigTemplate, loadConfig, DEFAULT_PORT, type LoadedConfig } from "../../src/infrastructure/config";
import { DEFAULT_SCHEDULING } from "../../src/domain/agent/SchedulingPolicy";

/**
 * 测试 daemon 工厂（T2.3，architecture §4.3）：持有全部测试注入口，内部
 * 以显式模式调组合根装配函数族（共享装配核心 assembleDaemon 的接缝切片）。
 *
 * 与生产入口 createDaemon 的关系：生产面 DaemonOptions 仅四真实启动参数
 * （home/port/cliInput/cliOutput）；本工厂承载原 15 字段形态（4 生产字段 +
 * 11 测试注入口），测试装配调用面（unit/integration/e2e launcher/fixtures）
 * 统一走本函数。位于 src 扫描面之外（AG-02④ 不涉及）。
 *
 * 字段语义（与 T2.3 前的 DaemonOptions 逐字段等价）：
 * - engine：Fake 引擎注入——传实例 = 全部会话共享（单会话测试形态）；
 *   传工厂 = 每会话独立引擎（多会话并行测试形态）。缺省 = 生产引擎形态
 *   （engineMode production：真 PiAgentEngineAdapter + SubagentLauncher
 *   真体，构造期无网络——「不注入即真引擎」的决断收口在本工厂单点，
 *   组合根锚面不从注入缺省推断，TP-2.3b）。
 * - skipLock：跳单例锁（单测并行用）。
 * - skipConfig：跳 config 文件读面与旧格式迁移（走硬编码缺省——与
 *   loadConfig 文件缺失分支同值：DEFAULT_PORT + DEFAULT_SCHEDULING）。
 * - 其余注入口透传组合根接缝（staticDir/toolCwd/builtinSkillsDir/
 *   subagentRunner/browser/session 三参数）。
 */
export interface TestDaemonOptions {
  /** 显式 home（测试指向 tmp 目录，TR-TEST-4）。 */
  readonly home?: string;
  /** 引擎覆盖（FakeAgentEngine 实例 = 全会话共享；工厂 = 每会话独立）。 */
  readonly engine?: AgentEnginePort | ((sessionId: string) => AgentEnginePort);
  /** CLI 输入/输出流覆盖（PassThrough）。 */
  readonly cliInput?: NodeJS.ReadableStream;
  readonly cliOutput?: NodeJS.WritableStream;
  /** WS 监听端口覆盖（0 = 随机；缺省取 config.port）。 */
  readonly port?: number;
  /** 前端静态产物目录覆盖（fixture；缺省取 config.staticDir）。 */
  readonly staticDir?: string;
  /** 跳过单例锁（单测并行用）。 */
  readonly skipLock?: boolean;
  /**
   * 跳过 config 加载与旧格式迁移（FakeAgentEngine 演示/单测注入）。
   * 真引擎模式（未注入 engine）仍由 engine 缺省判定——本开关只管 config
   * 文件读面（T2.3 AD-2 判定重定义语义保持）。
   */
  readonly skipConfig?: boolean;
  /** 工具沙箱 cwd 覆盖（测试指向 tmp；缺省为进程工作区）。 */
  readonly toolCwd?: string;
  /** builtin 层技能目录覆盖（空 tmp 目录隔离恰等断言；缺省随仓真目录）。 */
  readonly builtinSkillsDir?: string;
  /** SubAgent runner 覆盖（integration 注入 fake runner 驱动收口时序）。 */
  readonly subagentRunner?: InstanceRunner;
  /** findings 落账管道覆盖（F3.0，T4.1：注入替身真 KgWriteService/故障注入；缺省 = kg 栈真体）。 */
  readonly findingsSink?: Parameters<typeof assembleDaemon>[0]["findingsSinkOverride"];
  /** 编排会话 LLM 覆盖（T4.1 E 层：fake 剧本 streamFn 驱动编排批次循环；缺省生产形态）。 */
  readonly orchestratorLlmOverride?: Parameters<typeof assembleDaemon>[0]["orchestratorLlmOverride"];
  /** kg workspace 根初始绑定（e2e：指向 tmp fixture workspace；语义同既有字段，见下）。 */
  /** BrowserPort 覆盖（fake BrowserPort 驱动 web 族命令/广播断言）。 */
  readonly browser?: BrowserPort;
  /** 主时间轴尾窗大小（G-1：缺省 30；测试注入面）。 */
  readonly sessionTailSize?: number;
  /** 空闲卸载窗口 ms（G-5：缺省 30min；测试注入缩短到秒级）。 */
  readonly sessionIdleUnloadMs?: number;
  /** 空闲卸载轮询间隔 ms（测试注入面；缺省 min(60s, 窗口/10)）。 */
  readonly sessionIdlePollMs?: number;
  /**
   * kg workspace 根初始绑定值（W1 语义演进：等价 restore 预置）。缺省 =
   * process.cwd()——保既有测试形态（绑定态照常：会话创建门禁放行/kg
   * 读面可用）；显式 null = 强制 unbound boot 形态（集成测试面：门禁/
   * 防御契约断言用）。
   */
  readonly kgWorkspaceRoot?: string | null;
}

/**
 * 创建测试 daemon：装配序前置（home 补建 → 锁 → config）+ 组合根接缝切片
 * 构造后调共享装配核心。返回形态与生产 createDaemon 完全同构（Daemon）。
 */
export async function createTestDaemon(options: TestDaemonOptions = {}): Promise<Daemon> {
  // ── 启动序前置（与生产入口同序：目录补建先于锁获取，TR-AD-6） ──
  const paths = createPaths(options.home);
  paths.ensureHome();
  const lock = options.skipLock ? undefined : acquireSingletonLock(paths.lockPath());
  // 模板幂等写入与生产一致（文件已存在不动）；跳配置读面形态走硬编码缺省
  //（与 loadConfig 文件缺失分支同值——legacy 为空即不触发启动迁移）。
  ensureConfigTemplate(paths.configPath());
  const loaded: LoadedConfig = options.skipConfig
    ? {
        config: {
          port: DEFAULT_PORT,
          maxConcurrent: DEFAULT_SCHEDULING.maxConcurrent,
          maxQueued: DEFAULT_SCHEDULING.maxQueued,
        },
        legacy: {},
      }
    : loadConfig(paths.configPath());
  // 引擎装配形态归一（决断收口在本工厂单点）：实例注入 → 每会话共享工厂；
  // 工厂注入 → 直传；缺省 → 生产真引擎形态。
  const injected = options.engine;
  const engineMode: EngineAssemblyMode =
    injected === undefined
      ? { kind: "production" }
      : typeof injected === "function"
        ? { kind: "override", factory: injected }
        : { kind: "override", factory: () => injected };
  return assembleDaemon({
    home: options.home,
    port: options.port,
    cliInput: options.cliInput,
    cliOutput: options.cliOutput,
    engineMode,
    lock,
    config: loaded.config,
    legacy: loaded.legacy,
    browserPort: options.browser ?? new CdpConnectionManager({ homeDir: osHomeDir() }),
    subagentRunnerOverride: options.subagentRunner,
    findingsSinkOverride: options.findingsSink,
    orchestratorLlmOverride: options.orchestratorLlmOverride,
    staticDir: options.staticDir,
    tailSize: options.sessionTailSize,
    toolCwd: options.toolCwd,
    builtinSkillsDir: options.builtinSkillsDir,
    sessionIdleUnloadMs: options.sessionIdleUnloadMs,
    sessionIdlePollMs: options.sessionIdlePollMs,
    // W1 语义演进：缺省初始绑定 process.cwd()（等价 restore 预置——保既有
    // 测试形态）；显式 null = 强制 unbound boot（门禁/防御契约集成测试面）。
    kgWorkspaceRoot: options.kgWorkspaceRoot === undefined ? process.cwd() : options.kgWorkspaceRoot,
  });
}
