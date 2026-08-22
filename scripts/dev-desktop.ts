#!/usr/bin/env bun
/**
 * dev-desktop —— CL-4/F4.1/F4.2 一行命令桌面端 dev 编排（architecture §4.6）。
 *
 * ① 前置自检（F4.1）：cargo/rustc 在 PATH 可执行（`<bin> --version` 探测）。
 *    缺失 → 一行安装提示（含 rustup 命令）+ 退出码 1，不起任何进程。
 *    判定逻辑 = 注入探测函数的纯函数 checkRustToolchain（全分支可单测）。
 *    自检只在本入口——`bun run dev`（daemon 直跑）不检 cargo：Rust 是
 *    Tauri 壳构建前提，非 helix 运行时依赖（§4.6）。
 * ② 三进程编排（F4.2）：daemon（bun 直跑 apps/daemon/src/main.ts 源码，
 *    禁 compile 产物，TR-AD-35）+ vite dev（apps/shell）+ tauri dev。
 *    dev 形态 daemon 经壳 sidecar 机制起跑（contracts/sidecar-lifecycle.md
 *    双形态同构：壳恒 spawn sidecar + ready 行握手，禁形态分支）——本脚本
 *    生成 wrapper 脚本并注入 HELIX_SIDECAR_PATH（AF-3 注入位），wrapper
 *    exec bun 直跑源码；编排直接子进程 = vite dev + cargo tauri dev，
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
 * - HELIX_DESKTOP_VITE_PORT：vite dev 端口覆盖（测试隔离位；缺省 =
 *   vite 默认 5173，与 tauri.conf devUrl 对齐——覆盖后窗口 devUrl 不随
 *   动，仅供不依赖窗口内容的编排面自动化断言使用）。
 *
 * 工程层脚本，不被 apps 任何层 import（架构 §5.2）。
 * 用法：bun run dev:desktop
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  const root = join(import.meta.dir, "..");
  const shellDir = join(root, "apps/shell");
  const workDir = mkdtempSync(join(tmpdir(), "helix-dev-desktop-"));
  // dev sidecar wrapper（AF-3 注入位）：壳恒 spawn sidecar（双形态同构），
  // wrapper exec bun 直跑 daemon 源码（禁 compile 产物，TR-AD-35）。
  const wrapper = join(workDir, "helix-daemon-dev.sh");
  const homeArg = process.env.HELIX_DESKTOP_HOME ? ` --home '${process.env.HELIX_DESKTOP_HOME}'` : "";
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec '${process.execPath}' '${join(root, "apps/daemon/src/main.ts")}'${homeArg} "$@"\n`,
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
        cmd: ["cargo", "tauri", "dev"],
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
