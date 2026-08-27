/**
 * WorkspaceService —— workspace 绑定状态机（W1 绑定闭环）。
 *
 * 语义（设计稿 workspace-feature-design-candidate.md §3/§4）：workspace 从
 * 「daemon 启动 cwd 装配期常量」改为「运行时显式绑定」——零静默猜测，
 * 不存在推导出来的 workspace。本服务是绑定态的**唯一事实源**（daemon 侧）：
 * 持有当前绑定 + recents（MRU 上限 8）+ 绑定 kg 栈（持有者接缝——重绑 =
 * 原子替换持有内容，消费面经 stack()/isBound() 每次取现值）。
 *
 * 生命周期三入口：
 * - restore()：daemon 启动读 KV（workspace.current / workspace.recents）→
 *   校验 current → 有效则绑定（rebind 效应），无效则未绑定 + notice；
 * - open(root)：显式绑定写面——校验 → 活跃 agent 门禁（F2 裁决 v1 禁止
 *   切换）→ rebind → 置 current → KV 持久化（current + recents MRU 去重
 *   上限 8）→ 广播 changed → 返回 { root, projects }；
 * - bindCwd()：CLI 例外条款——终端站位 = 显式选择，绑定注入的 cwd，
 *   **不校验不持久化不广播**（桌面 current/recents 只由桌面 open 写）。
 *
 * 校验规则（daemon 单点，§3.3；前端只显示不重复实现）：
 * ① realpath 规范化（消 symlink 双写：/tmp vs /private/tmp 实证过）；
 * ② 存在且为目录且可读；
 * ③ 危险根拒绝：文件系统根 / 用户主目录（扫描面失控，引导选具体目录）。
 *
 * IO 全注入（对齐 KgProjectService 的注入风格：application 层零直接
 * node:fs）：fs 探测端口 + KV 端口（RuntimeConfigPort，WriteQueue 单写
 * 通道 AG-06——与 default_model 同模式先例，不进 config.json 不新增状态
 * 文件 TR-AD-6）+ kg 栈工厂/background 工厂（组合根注入，重绑接缝）。
 */
import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import type { KgProjectRowView } from "../kg/KgProjectService";
import type { KgAttachmentService } from "../kg/KgAttachmentService";
import type { KgQueryService } from "../kg/KgQueryService";
import type { KgSyncService } from "../kg/KgSyncService";
import type { KgViewerService } from "../kg/KgViewerService";
import type { KgWriteService } from "../kg/KgWriteService";

/** KV 键（helix.db runtime_config 表；不进 config.json——TR-AD-6）。 */
export const WORKSPACE_KV_CURRENT = "workspace.current";
export const WORKSPACE_KV_RECENTS = "workspace.recents";

/** recents 上限（MRU 去重后截断）。 */
export const WORKSPACE_RECENTS_LIMIT = 8;

/**
 * 绑定栈持有者内容物（结构面；真体 = 组合根 buildKnowledgeStack 产物，
 * 结构子集 = 消费面所需——结构化类型免 application 反向 import 组合根）。
 * 持有者语义：重绑 = 原子替换整个内容物（旧栈 dispose，消费面取现值）。
 */
export interface WorkspaceStack {
  readonly viewerService: KgViewerService;
  readonly projectService: { listProjects(): readonly KgProjectRowView[] };
  readonly queryService: KgQueryService;
  readonly writeService: KgWriteService;
  readonly syncService: KgSyncService;
  readonly attachmentService: KgAttachmentService;
  /** 关闭全部 per-project 连接（复用 shutdown 既有 dispose 语义）。 */
  readonly dispose: () => void;
}

/** kg 同步 background 停面（真体 = startKgSyncBackground 产物）。 */
export interface WorkspaceSyncBackground {
  readonly stop: () => void;
}

/** workspace 文件系统探测端口（driven 适配器注入；application 零直接 fs）。 */
export interface WorkspaceFsPort {
  /** realpath 规范化（symlink 消解）；不存在/不可解析 → undefined。 */
  realpath(p: string): string | undefined;
  /** 存在且为目录且可读（stat + 读权限探测）。 */
  isReadableDir(p: string): boolean;
  /** 用户主目录（危险根判定输入）。 */
  homeDir(): string;
  /** 文件系统根（如 "/"；危险根判定输入）。 */
  fsRoot(): string;
}

/** recents 持久化条目（KV JSON 行形状）。 */
export interface WorkspaceRecentEntry {
  readonly root: string;
  readonly name: string;
  readonly lastUsedAt: string;
}

/** recents 视图（get 快照行；valid = 惰性探测结果）。 */
export interface WorkspaceRecentView extends WorkspaceRecentEntry {
  readonly valid: boolean;
}

/** 门禁快照（workspace.get 响应的应用层形状）。 */
export interface WorkspaceSnapshot {
  readonly current: string | null;
  readonly recents: readonly WorkspaceRecentView[];
  readonly notice?: string;
}

/** 结构化错误码（协议 ErrorCode 子集；driving 层映射 connection.error）。 */
export type WorkspaceErrorCode = "WORKSPACE_E_INVALID_ROOT" | "WORKSPACE_E_ACTIVE_AGENT";

export interface WorkspaceOpenError {
  readonly code: WorkspaceErrorCode;
  readonly message: string;
}

/** open 结果（projects 复用 kg.projects 项目行口径）。 */
export type WorkspaceOpenOutcome =
  | { readonly ok: true; readonly root: string; readonly projects: readonly KgProjectRowView[] }
  | { readonly ok: false; readonly error: WorkspaceOpenError };

export interface WorkspaceServiceDeps {
  /** KV 底座（RuntimeConfigStore 经组合根注入；WriteQueue 单写通道 AG-06）。 */
  readonly kv: RuntimeConfigPort;
  /** 文件系统探测端口（driven 适配器注入）。 */
  readonly fs: WorkspaceFsPort;
  /** 时钟（lastUsedAt 单时间源；测试可注入固定值）。 */
  readonly clock: { readonly now: () => string };
  /** CLI 例外条款的 cwd 源（生产 = process.cwd；测试注入）。 */
  readonly cwd: () => string;
  /** kg 栈工厂（组合根注入 buildKnowledgeStack；重绑 = 重建）。 */
  readonly buildStack: (root: string) => WorkspaceStack;
  /** kg background 工厂（组合根注入 startKgSyncBackground；测试可注入 no-op）。 */
  readonly startSync: (stack: WorkspaceStack, root: string) => WorkspaceSyncBackground;
  /** 绑定变更广播（组合根接 EventStream.broadcastWorkspaceChanged）。 */
  readonly broadcast: (root: string) => void;
  /** 活跃 agent 判定（组合根接注册表热会话运行态 + 调度器存活实例）。 */
  readonly hasActiveAgent: () => boolean;
  /** 重绑效应面（W4 债清偿）：替换已绑定栈后卸载全部现有会话——旧会话
   *  executor 闭包持已 dispose 的旧栈（回旧会话用 kg/edit 族工具会打到死栈）；
   *  卸载后回访经懒加载按新栈重建。组合根晚绑接 SessionRegistry.unloadAll
   *  （构造序：本服务先于 registry 建立——hasActiveAgent 同款回填模式）。 */
  readonly unloadSessions: () => void;
  /** 可观测日志（结构面；组合根注入 Logger）。 */
  readonly logger?: { info(msg: string): void; warn(msg: string): void };
}

/**
 * workspace 绑定状态机（单例，daemon 生命周期内一个实例）。
 *
 * 状态：current（当前绑定根，null = 未绑定）+ recents（MRU 内存镜像，
 * restore/open 时与 KV 同步）+ stack/background（绑定 kg 栈持有者——
 * 未绑定时恒 null，保证 unbound boot 零扫描零同步零开库）。
 */
export class WorkspaceService {
  private readonly deps: WorkspaceServiceDeps;
  private current: string | null = null;
  private recents: readonly WorkspaceRecentEntry[] = [];
  private notice: string | undefined;
  /** 绑定 kg 栈（持有者内容物；未绑定恒 null——unbound 零物化的结构保证）。 */
  private bound: WorkspaceStack | null = null;
  private background: WorkspaceSyncBackground | undefined;
  /** 半途态挂起卸载（W1F-F3 配套）：建栈失败时旧栈已 dispose，会话卸载顺延
   *  到下次成功绑定（此刻重建才读得到新栈）——防失败窗口重访重建到无栈态。 */
  private pendingUnload = false;

  constructor(deps: WorkspaceServiceDeps) {
    this.deps = deps;
  }

  // ── 启动恢复（组合根装配序内调用一次） ──────────────────────

  /**
   * 读 KV 恢复绑定：current 有效 → 绑定（rebind 效应，不重写 KV——已是
   * 持久化值）；无效 → 未绑定 + notice（「上次的工作空间已不可用：…」，
   * 前端选择页降级说明）；无 KV → 未绑定（首启，无 notice）。
   * recents 无论成败均恢复（get 面数据源；失效项惰性探测标 valid 不删除）。
   */
  async restore(): Promise<void> {
    this.recents = this.loadRecents();
    const saved = this.deps.kv.get(WORKSPACE_KV_CURRENT);
    if (saved === undefined) return;
    const checked = this.check(saved);
    if (!checked.ok) {
      this.notice = `上次的工作空间已不可用：${checked.reason}`;
      this.deps.logger?.warn(`workspace 恢复失败：${checked.reason}（未绑定启动，等待显式选择）`);
      return;
    }
    this.bind(checked.root);
    this.deps.logger?.info(`workspace 已恢复绑定：${checked.root}`);
  }

  // ── 读面 ───────────────────────────────────────────────────

  /** 绑定态（门禁判别/防御契约判别；同步读面）。 */
  isBound(): boolean {
    return this.current !== null;
  }

  /** 当前绑定根（规范形；未绑定 null）。 */
  boundRoot(): string | null {
    return this.current;
  }

  /** 绑定 kg 栈（持有者读面——消费面每次取现值，重绑后自动跟随）。 */
  stack(): WorkspaceStack | null {
    return this.bound;
  }

  /** 门禁快照（workspace.get 读面）：current + recents（惰性探测标 valid）+ 降级 notice。 */
  get(): WorkspaceSnapshot {
    return {
      current: this.current,
      recents: this.recents.map((e) => ({ ...e, valid: this.deps.fs.isReadableDir(e.root) })),
      ...(this.notice !== undefined ? { notice: this.notice } : {}),
    };
  }

  // ── 写面（workspace.open 的 service 面） ────────────────────

  /**
   * 显式绑定：校验 → 活跃 agent 门禁 → rebind → 置 current → KV 持久化
   * （current + recents MRU 去重上限 8）→ 广播 changed。
   * 幂等：同 root 重复 open = 状态零变（不重建不重写 KV）+ 仍广播一次
   * changed（前端对齐用）。
   */
  async open(root: string): Promise<WorkspaceOpenOutcome> {
    const checked = this.check(root);
    if (!checked.ok) {
      return { ok: false, error: { code: "WORKSPACE_E_INVALID_ROOT", message: checked.reason } };
    }
    if (this.deps.hasActiveAgent()) {
      return {
        ok: false,
        error: {
          code: "WORKSPACE_E_ACTIVE_AGENT",
          message: "存在运行中的会话/智能体，请先等待收尾或中止后再切换工作空间",
        },
      };
    }
    if (this.current === checked.root && this.bound !== null) {
      // 幂等：状态零变 + 仍广播一次（前端对齐用）
      this.deps.broadcast(checked.root);
      return { ok: true, root: checked.root, projects: this.bound.projectService.listProjects() };
    }
    this.bind(checked.root);
    this.notice = undefined; // 换绑成功清除降级说明
    this.recents = [
      { root: checked.root, name: basenameOf(checked.root), lastUsedAt: this.deps.clock.now() },
      ...this.recents.filter((e) => e.root !== checked.root),
    ].slice(0, WORKSPACE_RECENTS_LIMIT);
    // KV 持久化（AG-06 单写通道；current + recents 同批落盘）
    await this.deps.kv.set(WORKSPACE_KV_CURRENT, checked.root);
    await this.deps.kv.set(WORKSPACE_KV_RECENTS, JSON.stringify(this.recents));
    this.deps.broadcast(checked.root);
    this.deps.logger?.info(`workspace 已绑定：${checked.root}`);
    return { ok: true, root: checked.root, projects: this.bound!.projectService.listProjects() };
  }

  // ── CLI 例外条款（main.ts runCli 前调用一次） ────────────────

  /**
   * 绑定 cwd（终端站位 = 显式选择）：**不校验、不持久化、不广播**——
   * 一次性行为，桌面 current/recents 只由桌面 open 写（防 CLI 会话污染
   * 桌面 recents）。rebind 效应照常（CLI 形态 kg 栈可用）。
   */
  async bindCwd(): Promise<void> {
    const cwd = this.deps.cwd();
    const normalized = this.deps.fs.realpath(cwd) ?? cwd;
    this.bind(normalized);
    this.deps.logger?.info(`workspace 已绑定（CLI 例外条款，cwd）：${normalized}`);
  }

  // ── 组合根注入面（初始绑定 = restore 预置等价） ──────────────

  /**
   * 初始绑定（kgWorkspaceRoot 测试注入面 / restore 预置等价）：原样绑定
   * 不校验不持久化不广播——语义 = 「假设 restore 已成功绑定到该 root」。
   */
  bindInitial(root: string): void {
    this.bind(root);
  }

  // ── daemon 关停面（shutdown 路径：dispose 当前栈不变语义） ────

  /**
   * 停 background + dispose 当前栈（幂等；库文件保留）。契约：dispose =
   * shutdown 专用（daemon 关停面唯一调用）——同步清 current 锁定一致态
   * （isBound()=false 与 stack()=null 同步）；解绑/切换走 open 另一根
   * （v1 无 close/unbind 命令）。
   */
  dispose(): void {
    this.background?.stop();
    this.background = undefined;
    this.bound?.dispose();
    this.bound = null;
    this.current = null;
  }

  // ── 内部 ───────────────────────────────────────────────────

  /**
   * rebind 效应：旧 background 先停 → dispose 旧栈 → 建新栈 → 启新
   * background（对绑定 root）→ 置 current → 卸载持旧栈会话（W4 债清偿：
   * 旧栈已 dispose，旧会话 executor 闭包持旧栈服务——回访会打到死栈；卸载
   * 后回访经懒加载按新栈重建）。卸载仅在有旧栈死掉时发生（首绑不卸——
   * CLI bindCwd 保全恢复会话连续性；restore/bindInitial 装配期晚绑闭包
   * 未闭合亦为 no-op）；建栈失败时旧栈已死 → 挂起顺延到下次成功绑定。
   * 同 root 且已有栈 = no-op（幂等保护 bindCwd/bindInitial 双调用）。
   */
  private bind(root: string): void {
    if (this.current === root && this.bound !== null) return;
    const hadStack = this.bound !== null; // 进入时旧栈在场——本次 bind 将 dispose 它
    this.background?.stop();
    this.background = undefined;
    this.bound?.dispose();
    let next: WorkspaceStack;
    try {
      next = this.deps.buildStack(root);
    } catch (err) {
      // 半途态加固（W1F-F3）：建栈失败时旧 background 已停、旧栈已
      // dispose——持有者置空（current 不变），后续消费面走 unbound 路径
      // 而非打到已 dispose 死栈；异常上抛（open → handler 结构化错误；
      // restore → 装配序 fail-fast）。旧栈已死 → 卸载挂起顺延（不在无栈
      // 态卸载：此刻重访重建会永久无 kg 工具，等下次成功绑定重建读新栈）。
      this.bound = null;
      if (hadStack) this.pendingUnload = true;
      throw err;
    }
    this.bound = next;
    this.background = this.deps.startSync(this.bound, root);
    this.current = root;
    // 重绑成功收口：持旧（已 dispose）栈会话全卸（含半途态挂起）；首绑且
    // 无挂起 → no-op。
    if (hadStack || this.pendingUnload) {
      this.pendingUnload = false;
      this.deps.unloadSessions();
    }
  }

  /**
   * 校验（§3.3 单点）：realpath 规范化 → 存在且为目录且可读 → 危险根
   * （文件系统根 / 主目录）拒绝。失败 reason 为用户可读中文（driving 层
   * 直传 connection.error message）。
   */
  private check(root: string): { ok: true; root: string } | { ok: false; reason: string } {
    const real = this.deps.fs.realpath(root);
    if (real === undefined) {
      return { ok: false, reason: `路径不存在或无法解析：${root}` };
    }
    if (!this.deps.fs.isReadableDir(real)) {
      return { ok: false, reason: `路径不是可读目录：${real}` };
    }
    // 危险根比较用规范形对齐（W1F-F5）：$HOME 本身为 symlink 时原值比较
    // 会漏拒主目录——与 realpath(homeDir()) 比较；realpath 失败回退原值
    // （经注入 fs 端口，application 层零直接 fs）。
    const home = this.deps.fs.realpath(this.deps.fs.homeDir()) ?? this.deps.fs.homeDir();
    if (real === this.deps.fs.fsRoot() || real === home) {
      return {
        ok: false,
        reason: `拒绝以 ${real} 作为工作空间（文件系统根/主目录扫描面失控），请选择具体的工作区目录`,
      };
    }
    return { ok: true, root: real };
  }

  /** KV recents 读取（坏 JSON/非数组容错为空——坏数据不阻断启动）。 */
  private loadRecents(): readonly WorkspaceRecentEntry[] {
    const raw = this.deps.kv.get(WORKSPACE_KV_RECENTS);
    if (raw === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (e): e is WorkspaceRecentEntry =>
          typeof e === "object" && e !== null && typeof (e as WorkspaceRecentEntry).root === "string",
      );
    } catch {
      return [];
    }
  }
}

/** basename（显示名；node:path 纯计算，application 白名单内）。 */
function basenameOf(root: string): string {
  const parts = root.split(/[\\/]/).filter((s) => s !== "");
  return parts.length > 0 ? parts[parts.length - 1]! : root;
}
