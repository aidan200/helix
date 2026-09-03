#!/usr/bin/env bun
/**
 * dev-desktop —— CL-4/F4.1/F4.2 一行命令桌面端 dev 编排（architecture §4.6）。
 *
 * ① 前置自检（F4.1）：cargo/rustc 在 PATH 可执行（`<bin> --version` 探测）。
 *    缺失 → 一行安装提示（含 rustup 命令）+ 退出码 1，不起任何进程。
 *    判定逻辑 = 注入探测函数的纯函数 checkRustToolchain（全分支可单测）。
 *    自检只在本入口——`bun run dev`（daemon 直跑）不检 cargo：Rust 是
 *    Tauri 壳构建前提，非 helix 运行时依赖（§4.6）。
 *    H-1 扩：rg 存在性检查 + 缺失自动 fetch-rg（幂等；fetch 失败一行
 *    警告不阻塞 dev——dev rg 走 PATH/config 三级解析兜底，顺带为 build
 *    暖场）。daemon 二进制 dev 零检查（②的 --config override 剥离
 *    externalBin 生产校验后自然兑现，不设任何检查代码）。
 * ② 三进程编排（F4.2）：daemon（bun 直跑 apps/daemon/src/main.ts 源码，
 *    禁 compile 产物，TR-AD-35）+ vite dev（apps/shell）+ tauri dev。
 *    dev 形态 daemon 经壳 sidecar 机制起跑（contracts/sidecar-lifecycle.md
 *    双形态同构：壳恒 spawn sidecar + ready 行握手，禁形态分支）——本脚本
 *    生成 wrapper 脚本并注入 HELIX_SIDECAR_PATH（AF-3 注入位），wrapper
 *    先 cd 仓库根再 exec bun 直跑源码（daemon cwd 继承 wrapper——TR-AD-6
 *    拉起方设 cwd，止住 src-tauri 顺链污染）；编排直接子进程 = vite dev + cargo tauri dev，
 *    daemon 为壳 sidecar 子孙（源码直跑）。任一直接子进程退出 → 整体
 *    teardown；daemon 异常退出由壳看护重启（契约 §3）。
 * ③ teardown（TR-TEST-6 三件套）：SIGINT/SIGTERM/子进程退出 → ps 快照
 *    枚举全后代 → SIGTERM 全树 → 5s 未死 SIGKILL 兑底（进程树全灭、端口
 *    随之释放）→ wrapper tmp 目录清理。
 *
 * env 注入面：
 * - HELIX_DESKTOP_HOME：注入 daemon `--home`（dev/测试隔离位；缺省 =
 *   daemon 默认 ~/.helix）。daemon 端口经 `<home>/config.json` 的 port
 *   键注入（既有配置面，非本脚本旋钮）。
 * - HELIX_DESKTOP_WORKSPACE_ROOT：workspace **可选预绑定**（W5 旋钮降级，
 *   设计稿 §7 迁移与兼容）：未设 → 正常起编排，daemon 以未绑定态启动，
 *   前端门禁（W3）引导 UI 选择（旧 TTY prompt 机制已删——UI 门禁取代
 *   之）；已设（目录须存在，否则起编排前 fail-fast）→ wrapper cd 保留 +
 *   daemon ready 后经 WS 发 workspace.open {root} 预绑定（token =
 *   `<home>/dev-token` 文件，端口 = `<home>/config.json` port 键，缺省
 *   7333），预绑定失败（超时/校验错）非零退出——显式指认错误的
 *   fail-fast 精神保留。e2e/无头场景设它跳过交互门禁。
 * - HELIX_DESKTOP_VITE_PORT：vite dev 端口覆盖（测试隔离位；缺省 =
 *   vite 默认 5173，与 tauri.conf devUrl 对齐）。覆盖后经 --config 同步
 *   override build.devUrl 随动——tauri dev 启动前等待 devUrl 可达，不随动
 *   会空等默认 5173 致 180s 超时退出（F4.2 隐患，H-1 顺带修复）。
 *
 * 工程层脚本，不被 apps 任何层 import（架构 §5.2）。
 * 用法：bun run dev:desktop
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { PROTOCOL_VERSION } from "@helix/protocol";
import { installFromRelease, isInstalled, RG_DEST } from "./fetch-rg";

// ── 前置自检（F4.1，纯函数面）──────────────────────────────

/** 一行安装提示（F4.1：单行输出，含 rustup 命令 + brew 等价）。 */
export function renderInstallHint(missing: readonly string[]): string {
  return (
    `✗ dev:desktop 需要 Rust 工具链（缺少：${missing.join("、")}）——` +
    `安装：curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh（或 brew install rustup）`
  );
}

export interface PrecheckResult {
  readonly ok: boolean;
  readonly missing: string[];
  /** ok=false 时的一行安装提示；ok=true 时为空串。 */
  readonly hint: string;
}

/** cargo/rustc 自检判定（探测函数注入，全分支可单测）。 */
export function checkRustToolchain(probe: (bin: string) => boolean): PrecheckResult {
  const missing = ["cargo", "rustc"].filter((bin) => !probe(bin));
  if (missing.length === 0) return { ok: true, missing: [], hint: "" };
  return { ok: false, missing, hint: renderInstallHint(missing) };
}

/** 生产探测：`<bin> --version` 可执行且退出码 0（ENOENT 等视为缺失）。 */
function pathProbe(bin: string): boolean {
  try {
    const r = Bun.spawnSync({ cmd: [bin, "--version"], stdout: "ignore", stderr: "ignore" });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

// ── H-1 方案 C：dev 剥离 bundle 资源生产校验 ─────────────────────

/**
 * tauri dev --config override（H-1）：dev 形态不消费 externalBin（daemon
 * 经壳 sidecar wrapper 跑源码）与 bundle.resources（dev rg 由本脚本经
 * HELIX_RG_PATH 注入 RG_DEST——与打包形态同走 bundle 级，无 PATH 级），
 * 剥离后干净态 dev 不再被 tauri-build 生产资源校验误伤。
 *
 * 写法硬约束（2026-08-22 实测，tauri-cli 2.11.4 / tauri-build 2.6.3 双侧
 * 均用 json_patch::merge = RFC 7386 JSON Merge Patch）：
 * - 数组字段（externalBin）覆盖语义成立 → [] 剥离；
 * - map 字段（resources）必须写 [] 而非 {}——RFC 7386 下 {} 是递归合并
 *   空操作（不删键），[] 非对象 patch 整体替换；
 * - 必须 v2 格式（无 "tauri" 包装键，v1 风格被 schema 校验拒绝）。
 * 只作用于 dev CLI 参数；tauri.conf.json 生产三通道声明零改动（TR-AD-34）。
 */
export const TAURI_DEV_CONFIG_OVERRIDE = '{"bundle":{"externalBin":[],"resources":[]}}';

/**
 * tauri dev --config override JSON 组装（纯函数，可单测）。
 * vitePort 注入位（HELIX_DESKTOP_VITE_PORT 测试隔离位）：覆盖后 devUrl
 * 必须随动——tauri dev 启动前会等待 devUrl 可达（CLI 侧 90×2s=180s
 * 超时 exit(1)），不随动则空等默认 5173 致编排永远起不来（F4.2 隐患）。
 */
export function tauriDevConfigOverride(vitePort?: string): string {
  if (!vitePort) return TAURI_DEV_CONFIG_OVERRIDE;
  return JSON.stringify({
    bundle: { externalBin: [], resources: [] },
    build: { devUrl: `http://localhost:${vitePort}` },
  });
}

/** tauri dev 命令参数组装（纯函数，override 单源于 tauriDevConfigOverride）。 */
export function tauriDevArgs(vitePort?: string): string[] {
  return ["tauri", "dev", "--config", tauriDevConfigOverride(vitePort)];
}

// ── dev sidecar wrapper 生成（cwd 止血）──────────────────

/** buildWrapperScript 入参（wrapper 内容纯函数面）。 */
export interface WrapperScriptOptions {
  /** bun 可执行（process.execPath）。 */
  readonly bunPath: string;
  /** daemon 源码入口绝对路径（cd 后 exec 目标不受 cwd 影响）。 */
  readonly mainTsPath: string;
  /** cd 目标（编排处传 workspace 预绑定根；W5 旋钮降级后可选——env
   * 未设时省略，生成无 cd 行形态，daemon 以未绑定态启动）。 */
  readonly workspaceRoot?: string;
  /** 可选 --home 注入（HELIX_DESKTOP_HOME dev/测试隔离位）。 */
  readonly home?: string;
}

/**
 * dev sidecar wrapper 脚本内容生成（纯函数，可单测；两形态）。
 *
 * 关键语义：cd 在 exec 之前——daemon 进程由 wrapper 进程 exec 替换而来，
 * cwd 顺链继承 wrapper，故先 cd '<workspaceRoot>' 再 exec，daemon 的
 * process.cwd() 即预绑定根。缺省下 kg workspace 根/工具 cwd 均以
 * process.cwd() 为准（TR-AD-6：生产恒走启动 cwd，不加 argv/env），故由
 * 拉起方把 cwd 设对——否则 cargo 的 apps/shell/src-tauri 顺链继承，kg
 * 把其一级子目录当项目批量建 .helix-kg 库，落进 tauri dev 文件监视范围
 * 触发“杀壳重建”无限重启（本函数即该循环的止血位）。workspaceRoot
 * 省略时（W5：env 未设）无 cd 行——daemon 未绑定态，workspace 绑定
 * 恒经 WS（workspace.open），无 cwd 兼容缺省（W1/TR-AD-6 补款）。
 */
export function buildWrapperScript(options: WrapperScriptOptions): string {
  const homeArg = options.home ? ` --home '${options.home}'` : "";
  const cdLine = options.workspaceRoot ? `cd '${options.workspaceRoot}'\n` : "";
  return (
    `#!/bin/sh\n` +
    cdLine +
    `exec '${options.bunPath}' '${options.mainTsPath}'${homeArg} "$@"\n`
  );
}

// ── dev workspace 预绑定根解析（W5 旋钮降级：可选预绑定，UI 门禁取代 TTY prompt）──

/** resolveDevWorkspaceRoot 注入面（全分支可单测）。 */
export interface WorkspaceRootDeps {
  /** HELIX_DESKTOP_WORKSPACE_ROOT（可选预绑定指认）。 */
  readonly envRoot?: string;
  /** 目录存在校验读面（缺省 statSync；测试注入）。 */
  readonly existsDir?: (p: string) => boolean;
}

/**
 * dev 形态 workspace 预绑定根解析（W5：可选预绑定，两分支）。
 *
 * - env 已设（非空白）：目录必须存在——不存在 → 抛错（起编排前
 *   fail-fast，显式指认错误应修正，不回退不猜测）；存在 → 返回 root
 *   （wrapper cd 目标 + WS workspace.open 预绑定目标）。
 * - env 未设：返回 undefined——正常起编排，daemon 以未绑定态启动，
 *   前端门禁（W3）引导开发者 UI 选择（设计稿 §7：交互开发走前端门禁，
 *   旧 TTY prompt/readline 机制已删；e2e/无头场景设 env 以预绑定）。
 */
export function resolveDevWorkspaceRoot(deps: WorkspaceRootDeps): string | undefined {
  const existsDir = deps.existsDir ?? ((p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  const envRoot = deps.envRoot?.trim();
  if (envRoot === undefined || envRoot === "") return undefined;
  if (!existsDir(envRoot)) {
    throw new Error(
      `HELIX_DESKTOP_WORKSPACE_ROOT 指向的目录不存在：${envRoot}（显式指认错误应修正，不做缺省回退）`,
    );
  }
  return envRoot;
}

// ── WS 预绑定（W5：env 已设时 daemon ready 后 workspace.open）────────

/** 预绑定总超时（对齐握手超时量级；超时 → 非零退出）。 */
export const PREBIND_TIMEOUT_MS = 15_000;

/** daemon 默认 WS 端口（同值锚：apps/daemon/src/infrastructure/config.ts DEFAULT_PORT；<home>/config.json port 键缺省值）。 */
const DEFAULT_WS_PORT = 7333;

/** prebindWorkspace 注入面（成功/超时/校验错三分支可单测，零真网络依赖）。 */
export interface PrebindDeps {
  /** 待绑定 workspace 根（workspace.open payload.root）。 */
  readonly root: string;
  /** daemon WS 端口（`<home>/config.json` port 键解析值）。 */
  readonly port: number;
  /** WS 端口可达探测（daemon ready 信号 = 端口监听；不可达轮询直至超时抛错）。 */
  readonly waitPortReachable: (port: number, timeoutMs: number) => Promise<void>;
  /** dev-token 读面（`<home>/dev-token` 文件；daemon 启动时重写——须在端口可达后读，取本次进程新写值）。 */
  readonly readToken: () => Promise<string>;
  /** WS 单次命令面：hello 握手 + workspace.open 发送 + 结果帧裁决。 */
  readonly openWorkspace: (params: {
    port: number;
    token: string;
    root: string;
    timeoutMs: number;
  }) => Promise<void>;
  /** 总超时（缺省 PREBIND_TIMEOUT_MS）。 */
  readonly timeoutMs?: number;
}

/**
 * workspace 预绑定编排（W5）：等 daemon WS 端口可达 → 读 dev-token →
 * hello 握手 + workspace.open {root} → 等 workspace.open.result。
 * 任何环节失败（含整体超时兑底）抛错——编排面据此非零退出：env 已设即
 * 预绑定意图明确，失败不静默放行（显式指认错误的 fail-fast 精神）。
 */
export async function prebindWorkspace(deps: PrebindDeps): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? PREBIND_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`预绑定超时（${timeoutMs}ms）——daemon WS 未就绪或无响应`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([
      (async () => {
        await deps.waitPortReachable(deps.port, timeoutMs);
        const token = (await deps.readToken()).trim();
        if (token === "") throw new Error("dev-token 文件为空（<home>/dev-token）");
        await deps.openWorkspace({ port: deps.port, token, root: deps.root, timeoutMs });
      })(),
      guard,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** dev home（与 wrapper --home 同源：HELIX_DESKTOP_HOME ?? daemon 默认 ~/.helix）。 */
function devHome(): string {
  return process.env.HELIX_DESKTOP_HOME ?? join(homedir(), ".helix");
}

/** daemon WS 端口读取：`<home>/config.json` port 键（缺省/不可读 → 7333，对齐 daemon 既有配置面）。 */
function readWsPort(home: string): number {
  try {
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { port?: unknown };
    return typeof cfg.port === "number" && cfg.port > 0 ? cfg.port : DEFAULT_WS_PORT;
  } catch {
    return DEFAULT_WS_PORT;
  }
}

/** 生产面：TCP 可达探测（daemon WS 钉 127.0.0.1，container §driving）。 */
function tcpConnectable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/** 生产面：WS 端口可达轮询（daemon ready 信号 = 端口监听；500ms 间隔）。 */
async function waitWsPortReachable(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tcpConnectable(port)) return;
    if (Date.now() > deadline) {
      throw new Error(`daemon WS 端口 ${port} 在 ${timeoutMs}ms 内不可达`);
    }
    await Bun.sleep(500);
  }
}

/**
 * 生产面 WS 客户端最小实现（按 daemon 现有握手形态：hello → welcome →
 * workspace.open → workspace.open.result；错误统一 connection.error 帧
 * 回执——握手拒绝 auth.族/protocol.族与 workspace.open 校验错 WORKSPACE_E.族
 * 同一裁决面）。
 */
async function openWorkspaceOverWs(params: {
  port: number;
  token: string;
  root: string;
  timeoutMs: number;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${params.port}`);
    let settled = false;
    let openSent = false;
    const timer = setTimeout(
      () => settle(new Error(`WS 无结果帧（${params.timeoutMs}ms 超时）`)),
      params.timeoutMs,
    );
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      if (err === undefined) resolve();
      else reject(err);
    };
    ws.onopen = () => {
      // hello 握手（契约 §2）：token + protocolVersion 严格单值（v0.11）
      ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "hello",
          payload: { token: params.token, protocolVersion: PROTOCOL_VERSION },
        }),
      );
    };
    ws.onmessage = (ev: { data: unknown }) => {
      let frame: { type?: unknown; payload?: { code?: unknown; message?: unknown } };
      try {
        frame = JSON.parse(String(ev.data)) as typeof frame;
      } catch {
        return; // 非 JSON 帧忽略（连接层垃圾数据由 close 收口）
      }
      if (frame.type === "connection.welcome" && !openSent) {
        openSent = true;
        ws.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "workspace.open",
            payload: { root: params.root },
          }),
        );
        return;
      }
      if (frame.type === "workspace.open.result") {
        settle(); // 绑定回执（root + projects）——预绑定成功
        return;
      }
      if (frame.type === "connection.error") {
        const code = typeof frame.payload?.code === "string" ? frame.payload.code : "unknown";
        const message =
          typeof frame.payload?.message === "string" ? frame.payload.message : "";
        settle(new Error(`${code}：${message}`));
        return;
      }
      // 其余帧（session.snapshot / workspace_changed 广播等）与预绑定裁决无关
    };
    ws.onerror = () => {
      /* close 事件紧随其后，作为失败收口的唯一依据 */
    };
    ws.onclose = () => {
      settle(new Error("WS 连接关闭（未收到 workspace.open.result）"));
    };
  });
}

/** 生产面 prebind 装配（home 解析单点：HELIX_DESKTOP_HOME ?? ~/.helix）。 */
function prebindProductionDeps(root: string): PrebindDeps {
  const home = devHome();
  return {
    root,
    port: readWsPort(home),
    waitPortReachable: waitWsPortReachable,
    readToken: () => Promise.resolve(readFileSync(join(home, "dev-token"), "utf8")),
    openWorkspace: openWorkspaceOverWs,
  };
}

// ── H-1 动作③：rg 环境无关自动补（幂等，失败不阻塞 dev）─────────

export interface RgEnsureResult {
  /** 是否触发了安装（false = 已装幂等跳过）。 */
  readonly attempted: boolean;
  /** 最终 rg 可用（已装跳过或安装成功）。 */
  readonly ok: boolean;
  /** ok=false 时的一行警告；否则空串。 */
  readonly warning: string;
}

/**
 * rg 存在性检查 + 缺失自动 fetch（H-1：环境无关 + 为 build 暖场）。
 * 探测/安装函数注入（全分支可单测）；探测抛错视为未装；安装失败
 * 不抛出——返回一行警告由调用面输出，dev 继续（grep 将响亮失败，
 * 仅剩 config.json rgPath 逃生门）。
 */
export async function ensureRgAvailable(
  probe: () => Promise<boolean>,
  install: () => Promise<unknown>,
): Promise<RgEnsureResult> {
  let installed = false;
  try {
    installed = await probe();
  } catch {
    installed = false;
  }
  if (installed) return { attempted: false, ok: true, warning: "" };
  try {
    await install();
    return { attempted: true, ok: true, warning: "" };
  } catch (e) {
    return {
      attempted: true,
      ok: false,
      warning:
        `⚠ dev:desktop 自动获取 rg 失败（${e instanceof Error ? e.message : e}）——` +
        `dev 继续，但 grep 工具将响亮失败（rg 二级解析仅剩 config.json rgPath 逃生门）；` +
        `可手动 bun scripts/fetch-rg.ts 修复`,
    };
  }
}

/** 生产面：fetch-rg 默认落位（RG_DEST）的存在性 + arm64 校验。 */
function rgProbe(): Promise<boolean> {
  return isInstalled();
}

/** 生产面：fetch-rg 固定版本下载安装（幂等）。 */
async function rgInstall(): Promise<unknown> {
  return installFromRelease();
}

// ── 进程树枚举（macOS dev 面：ps 快照 + ppid 递推）─────────

/** `ps -Ao pid=,ppid=` 输出解析（纯函数，可单测）。 */
export function parsePsTable(text: string): Array<[pid: number, ppid: number]> {
  const edges: Array<[number, number]> = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) edges.push([Number(m[1]), Number(m[2])]);
  }
  return edges;
}

/** rootPid 的全部后代 pid（不含 rootPid 本身；纯函数，可单测）。 */
export function collectDescendantPids(
  rootPid: number,
  edges: readonly [number, number][],
): number[] {
  const byPpid = new Map<number, number[]>();
  for (const [pid, ppid] of edges) {
    const list = byPpid.get(ppid) ?? [];
    list.push(pid);
    byPpid.set(ppid, list);
  }
  const out: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const pid of byPpid.get(cur) ?? []) {
      out.push(pid);
      queue.push(pid);
    }
  }
  return out;
}

function psSnapshot(): [number, number][] {
  const r = Bun.spawnSync({ cmd: ["ps", "-Ao", "pid=,ppid="], stdout: "pipe", stderr: "ignore" });
  return parsePsTable(r.stdout.toString());
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const SIGTERM_GRACE_MS = 5000;
const SIGKILL_SETTLE_MS = 2000;

/** 进程树全灭：快照枚举全后代 → SIGTERM 全树 → 兑底 SIGKILL。 */
async function killTree(rootPids: readonly number[]): Promise<void> {
  const all = [...rootPids];
  const snapshot = psSnapshot();
  for (const rootPid of rootPids) all.push(...collectDescendantPids(rootPid, snapshot));
  for (const pid of all) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  let survivors = all.filter(alive);
  const graceDeadline = Date.now() + SIGTERM_GRACE_MS;
  while (survivors.length > 0 && Date.now() < graceDeadline) {
    await Bun.sleep(100);
    survivors = survivors.filter(alive);
  }
  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  const settleDeadline = Date.now() + SIGKILL_SETTLE_MS;
  while (survivors.length > 0 && Date.now() < settleDeadline) {
    await Bun.sleep(50);
    survivors = survivors.filter(alive);
  }
}

// ── 编排主流程 ──────────────────────────────────────────────

async function main(): Promise<number> {
  // ⓪ workspace 预绑定根决议（W5 旋钮降级：可选预绑定）——env 已设但
  // 目录不存在时在任何前置工作（自检/rg fetch/进程编排）之前 fail-fast；
  // 未设 → undefined（正常起编排，daemon 未绑定态启动）。回显在①自检后
  //（不污染 F4.1 一行提示契约）。
  const workspaceRoot = resolveDevWorkspaceRoot({
    envRoot: process.env.HELIX_DESKTOP_WORKSPACE_ROOT,
  });

  // ① 前置自检：缺失 → 一行提示 + 非零退出，不起任何进程
  const precheck = checkRustToolchain(pathProbe);
  if (!precheck.ok) {
    console.error(precheck.hint);
    return 1;
  }
  console.error(
    workspaceRoot === undefined
      ? "[dev-desktop] 未设 HELIX_DESKTOP_WORKSPACE_ROOT——daemon 未绑定态启动，前端将引导选择（e2e/无头场景请设置以预绑定）"
      : `[dev-desktop] workspace 根（env 预绑定）：${workspaceRoot}`,
  );

  // H-1 动作③：rg 存在性检查 + 缺失自动 fetch（幂等）；失败一行警告不阻塞
  const rg = await ensureRgAvailable(rgProbe, rgInstall);
  if (!rg.ok) console.error(rg.warning);

  const root = join(import.meta.dir, "..");
  const shellDir = join(root, "apps/shell");
  const workDir = mkdtempSync(join(tmpdir(), "helix-dev-desktop-"));
  // dev sidecar wrapper（AF-3 注入位）：壳恒 spawn sidecar（双形态同构），
  // wrapper 先 cd workspace 预绑定根再 exec bun 直跑 daemon 源码（禁
  // compile 产物，TR-AD-35；daemon cwd 继承 wrapper——TR-AD-6 拉起方设
  // cwd 的止血位）；env 未设时无 cd 行（daemon 未绑定态，绑定恒经 WS）。
  const wrapper = join(workDir, "helix-daemon-dev.sh");
  writeFileSync(
    wrapper,
    buildWrapperScript({
      bunPath: process.execPath,
      mainTsPath: join(root, "apps/daemon/src/main.ts"),
      workspaceRoot, // undefined → 无 cd 行
      home: process.env.HELIX_DESKTOP_HOME,
    }),
  );
  chmodSync(wrapper, 0o755);

  // ② 三进程编排：vite dev + cargo tauri dev（daemon 经壳 sidecar wrapper 起跑）。
  //    vite --strictPort：5173 被占时 fail-fast（tauri.conf devUrl 钉死 5173，
  //    静默漂移会让窗口加载落空），退出码经「任一退出 → 整体 teardown」传导。
  const vitePortArgs = process.env.HELIX_DESKTOP_VITE_PORT
    ? ["--port", process.env.HELIX_DESKTOP_VITE_PORT]
    : [];
  const children = [
    {
      name: "vite dev",
      proc: Bun.spawn({
        cmd: [process.execPath, "run", "dev", "--strictPort", ...vitePortArgs],
        cwd: shellDir,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      }),
    },
    {
      name: "tauri dev",
      proc: Bun.spawn({
        // H-1 方案 C：--config override 剥离 bundle 资源生产校验（常量单源）；
        // vite 端口覆盖位透传 → devUrl 随动（tauri dev 前端等待钉对端口）
        cmd: ["cargo", ...tauriDevArgs(process.env.HELIX_DESKTOP_VITE_PORT)],
        cwd: shellDir,
        env: { ...process.env, HELIX_SIDECAR_PATH: wrapper, HELIX_RG_PATH: RG_DEST },
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      }),
    },
  ];

  // ②‘ WS 预绑定任务（W5）：env 已设时等 daemon ready（WS 端口可达）后读
  //    dev-token + 发 workspace.open；成功一行日志，失败（超时/校验错）→
  //    非零退出（预绑定意图明确，不静默放行）。
  const prebindTask: Promise<string | null> =
    workspaceRoot === undefined
      ? Promise.resolve(null)
      : prebindWorkspace(prebindProductionDeps(workspaceRoot)).then(
          () => {
            console.error(`[dev-desktop] workspace 预绑定成功：${workspaceRoot}`);
            return null;
          },
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        );

  // ③ 任一子进程退出 / SIGINT / SIGTERM / 预绑定失败 → 整体 teardown + tmp 清理
  return await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number, reason: string): void => {
      if (settled) return;
      settled = true;
      console.error(`[dev-desktop] ${reason}——整体 teardown（进程树 SIGTERM→SIGKILL 兑底 + tmp 清理）`);
      void killTree(children.map((c) => c.proc.pid)).then(() => {
        rmSync(workDir, { recursive: true, force: true });
        resolve(code);
      });
    };
    for (const c of children) {
      void c.proc.exited.then((code) => finish(code, `${c.name} 已退出（exit ${code}）`));
    }
    void prebindTask.then((err) => {
      if (err !== null) finish(1, `workspace 预绑定失败（${err}）`);
    });
    process.on("SIGINT", () => finish(0, "收到 SIGINT"));
    process.on("SIGTERM", () => finish(0, "收到 SIGTERM"));
  });
}

// import.meta.main 守卫：纯函数面被测试 import，导入不得触发编排副作用。
if (import.meta.main) {
  process.exit(await main());
}
