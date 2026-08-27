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
 * - HELIX_DESKTOP_WORKSPACE_ROOT：daemon workspace 根指认（wrapper cd
 *   目标；缺省 = 仓库父目录，回退规则见 resolveDevWorkspaceRoot——
 *   TR-AD-6 拉起方设 cwd 语义的编排层旋钮，daemon 仍只读 cwd）。
 * - HELIX_DESKTOP_VITE_PORT：vite dev 端口覆盖（测试隔离位；缺省 =
 *   vite 默认 5173，与 tauri.conf devUrl 对齐）。覆盖后经 --config 同步
 *   override build.devUrl 随动——tauri dev 启动前等待 devUrl 可达，不随动
 *   会空等默认 5173 致 180s 超时退出（F4.2 隐患，H-1 顺带修复）。
 *
 * 工程层脚本，不被 apps 任何层 import（架构 §5.2）。
 * 用法：bun run dev:desktop
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { installFromRelease, isInstalled } from "./fetch-rg";

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
 * 经壳 sidecar wrapper 跑源码）与 bundle.resources（dev rg 走 PATH/config
 * 三级解析），剥离后干净态 dev 不再被 tauri-build 生产资源校验误伤。
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
  /** cd 目标（编排处传仓库根）。 */
  readonly workspaceRoot: string;
  /** 可选 --home 注入（HELIX_DESKTOP_HOME dev/测试隔离位）。 */
  readonly home?: string;
}

/**
 * dev sidecar wrapper 脚本内容生成（纯函数，可单测）。
 *
 * 关键语义：cd 在 exec 之前——daemon 进程由 wrapper 进程 exec 替换而来，
 * cwd 顺链继承 wrapper，故先 cd '<workspaceRoot>' 再 exec，daemon 的
 * process.cwd() 即仓库根。缺省下 kg workspace 根/工具 cwd 均以
 * process.cwd() 为准（TR-AD-6：生产恒走启动 cwd，不加 argv/env），故由
 * 拉起方把 cwd 设对——否则 cargo 的 apps/shell/src-tauri 顺链继承，kg
 * 把其一级子目录当项目批量建 .helix-kg 库，落进 tauri dev 文件监视范围
 * 触发“杀壳重建”无限重启（本函数即该循环的止血位）。
 */
export function buildWrapperScript(options: WrapperScriptOptions): string {
  const homeArg = options.home ? ` --home '${options.home}'` : "";
  return (
    `#!/bin/sh\n` +
    `cd '${options.workspaceRoot}'\n` +
    `exec '${options.bunPath}' '${options.mainTsPath}'${homeArg} "$@"\n`
  );
}

// ── dev workspace 根解析（§3.5 语义：workspace=容器，一级目录=项目）──

/**
 * dev 形态 daemon workspace 根解析（纯函数，可单测）。
 *
 * 缺省 = 仓库父目录：§3.5 口径下 workspace 是多项目容器、一级目录才是
 * 项目——helix 仓库自身是“一个项目一个 .helix-kg”，若以仓库根为
 * workspace，apps/packages 等内部目录会被误判为项目并批量物化伪库
 * （2026-08-27 实证：boot 在每个非排除一级目录建 0 节点 .helix-kg）。
 * 仓库坐落在多项目工作区内（clone 的常态布局）时父目录即正确容器。
 * 回退：父目录是 home 或文件系统根（仓库裸躺、无容器语义，扫描面
 * 失控）→ 退回仓库根（ bounded，宁可伪库也不扫全盘）。
 * 覆盖：HELIX_DESKTOP_WORKSPACE_ROOT 显式指认（任意布局兜底）。
 */
export function resolveDevWorkspaceRoot(repoRoot: string, override?: string): string {
  if (override && override.trim() !== "") return override;
  const parent = dirname(repoRoot);
  if (parent === homedir() || parse(parent).root === parent) return repoRoot;
  return parent;
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
 * 不抛出——返回一行警告由调用面输出，dev 继续（PATH/config 三级解析兜底）。
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
        `dev 继续（grep 走 PATH/config 三级解析兜底）；为 build 暖场可手动 bun scripts/fetch-rg.ts`,
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
  // ① 前置自检：缺失 → 一行提示 + 非零退出，不起任何进程
  const precheck = checkRustToolchain(pathProbe);
  if (!precheck.ok) {
    console.error(precheck.hint);
    return 1;
  }

  // H-1 动作③：rg 存在性检查 + 缺失自动 fetch（幂等）；失败一行警告不阻塞
  const rg = await ensureRgAvailable(rgProbe, rgInstall);
  if (!rg.ok) console.error(rg.warning);

  const root = join(import.meta.dir, "..");
  const shellDir = join(root, "apps/shell");
  const workDir = mkdtempSync(join(tmpdir(), "helix-dev-desktop-"));
  // dev sidecar wrapper（AF-3 注入位）：壳恒 spawn sidecar（双形态同构），
  // wrapper 先 cd workspace 根再 exec bun 直跑 daemon 源码（禁 compile 产物，
  // TR-AD-35；daemon cwd 继承 wrapper——TR-AD-6 拉起方设 cwd 的止血位）。
  // workspace 根缺省 = 仓库父目录（§3.5：容器语义，helix 整体为一个项目、
  // 唯一 .helix-kg 在仓库根），HELIX_DESKTOP_WORKSPACE_ROOT 可显式指认。
  const wrapper = join(workDir, "helix-daemon-dev.sh");
  writeFileSync(
    wrapper,
    buildWrapperScript({
      bunPath: process.execPath,
      mainTsPath: join(root, "apps/daemon/src/main.ts"),
      workspaceRoot: resolveDevWorkspaceRoot(root, process.env.HELIX_DESKTOP_WORKSPACE_ROOT),
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
        env: { ...process.env, HELIX_SIDECAR_PATH: wrapper },
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      }),
    },
  ];

  // ③ 任一子进程退出 / SIGINT / SIGTERM → 整体 teardown + tmp 清理
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
    process.on("SIGINT", () => finish(0, "收到 SIGINT"));
    process.on("SIGTERM", () => finish(0, "收到 SIGTERM"));
  });
}

// import.meta.main 守卫：纯函数面被测试 import，导入不得触发编排副作用。
if (import.meta.main) {
  process.exit(await main());
}
