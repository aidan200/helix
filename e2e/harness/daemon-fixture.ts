/**
 * E 层 daemon fixture（TS3/TS4）—— Node 侧（Playwright 进程内）以子进程方式
 * 启停真 daemon（bun apps/daemon/test/e2e/launcher.ts），浏览器经真 WebSocket
 * 连接（无 fake transport、无帧拦截——连接与收发全真）。
 *
 * 隔离纪律（TR-TEST-4 / 铁律）：
 * - --home 一律 tmp（mkdtemp），真实 ~/.helix 零触碰；
 * - 工具沙箱 cwd 独立 tmp（spec 预置夹具文件，副作用可从 Node 侧核验）；
 * - LLM 为 FakeLLM（launcher 内 streamFnOverride），零真实网络；
 * - 端口固定 5333（避开 daemon 默认 7333 与 vite 5199/5210），workers=1 串行
 *   复用；重启场景同 home 同端口（端口被占时自动重试 spawn）。
 *
 * teardown 零残留纪律（TR-TEST-6 / T5.2）：fixture 是清理责任的唯一归属——
 * ①tmp home 全删（含 spec 自建 home，旁路清理收编）；②SubAgent 子进程树
 * 兜底回收（daemon SIGTERM 后 ps 特征扫描，SIGTERM→3s 超时 SIGKILL——
 * 独立于 Launcher O-6 业务路径的双层兜底）；③端口释放验证（bind 探测）。
 * 任一命中即红（非软警告），由 CL-4-teardown-residue.spec + 本 fixture 的
 * teardown 断言机械化守护（连跑两轮判据）。
 */
import { test as base, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { DaemonScript, SubagentScript } from "./daemon-script";
import type { FakeEngineScript } from "../../apps/daemon/src/adapters/driven/subagent/child/scriptedEngine";

const WORKTREE_ROOT = path.resolve(__dirname, "..", "..");
const LAUNCHER = path.join(WORKTREE_ROOT, "apps", "daemon", "test", "e2e", "launcher.ts");
const BUN = process.env.HELIX_E2E_BUN ?? "bun";

/** E 层 daemon 固定端口（前端经 VITE_HELIX_PORT 烘焙指向它）。 */
export const E2E_DAEMON_PORT = 5333;
/** vite dev 基址（TC3.4 双基线 A；playwright.e2e.config.ts webServer）。 */
export const E2E_VITE_BASE = `http://127.0.0.1:5210`;
/** daemon static serve 基址（TC3.4 双基线 B；dist 由 globalSetup 构建）。 */
export const E2E_DAEMON_BASE = `http://127.0.0.1:${E2E_DAEMON_PORT}`;
/** 前端静态产物目录（globalSetup 以 VITE_HELIX_PORT=5333 构建）。 */
export const SHELL_DIST = path.join(WORKTREE_ROOT, "apps", "shell", "dist");

const READY_PREFIX = "##HELIX-DAEMON## ready ";
const STOPPED_PREFIX = "##HELIX-DAEMON## stopped";
const FATAL_PREFIX = "##HELIX-DAEMON## fatal ";

export interface DaemonStartOptions {
  /** FakeLLM 剧本（随本进程消费；重启进程从头消费） */
  script: DaemonScript;
  /** SubAgent 剧本（T2.4：按 launch 次序收口/挂起；缺省全部挂起） */
  subagentScript?: SubagentScript;
  /** static serve 目录（TC3.4 基线 B 用；缺省不 serve） */
  staticDir?: string;
  /** spawn 重试次数（同端口重启时端口短暂占用的缓冲） */
  retries?: number;
  /** 复用已存在的 home（TS4 重启语义：同 --home 重建） */
  home?: string;
  /** 真子进程 SubAgent 模式（T5.2）：注入真 SubagentLauncher + K3 剧本引擎——
   *  agent_spawn 真实 spawn detached 子进程（teardown 兜底回收的观测面）。
   *  缺省用 ScriptedSubagentRunner（进程内剧本，无子进程）。 */
  realSubagent?: { engineScript: FakeEngineScript };
  /** 额外环境变量（T4.2 模型链：注入死代理 HTTP(S)_PROXY 使 ModelCatalog
   *  刷新快速失败 → builtin fallback 无外网断言，K-1）。 */
  env?: Record<string, string>;
}

/** 一个 daemon 子进程的句柄。 */
export class DaemonProcess {
  private constructor(
    readonly home: string,
    readonly toolCwd: string,
    private readonly proc: ChildProcess,
    readonly port: number,
  ) {}

  static async start(opts: DaemonStartOptions, retries = opts.retries ?? 0): Promise<DaemonProcess> {
    const home = opts.home ?? mkdtempSync(path.join(tmpdir(), "helix-e2e-home-"));
    const toolCwd = path.join(home, "sandbox");
    mkdirSync(toolCwd, { recursive: true });
    const scriptFile = path.join(home, "llm-script.json");
    writeFileSync(scriptFile, JSON.stringify(opts.script), "utf8");
    const subagentScriptFile = path.join(home, "subagent-script.json");
    writeFileSync(subagentScriptFile, JSON.stringify(opts.subagentScript ?? []), "utf8");
    let subagentEngineScriptFile: string | undefined;
    if (opts.realSubagent) {
      subagentEngineScriptFile = path.join(home, "subagent-engine-script.json");
      writeFileSync(subagentEngineScriptFile, JSON.stringify(opts.realSubagent.engineScript), "utf8");
    }

    const args = [
      LAUNCHER,
      "--home",
      home,
      "--port",
      String(E2E_DAEMON_PORT),
      "--script",
      scriptFile,
      "--subagent-script",
      subagentScriptFile,
      "--tool-cwd",
      toolCwd,
    ];
    if (subagentEngineScriptFile) args.push("--subagent-engine-script", subagentEngineScriptFile);
    if (opts.staticDir) args.push("--static-dir", opts.staticDir);

    try {
      return await spawnAndWait(home, toolCwd, args, opts.env);
    } catch (err) {
      if (retries > 0) {
        // 同端口重启时旧监听可能尚未释放（TIME_WAIT/收尾竞态）：退避重试
        await new Promise((r) => setTimeout(r, 400));
        return DaemonProcess.start({ ...opts, home }, retries - 1);
      }
      throw err;
    }
  }

  get running(): boolean {
    return this.proc.exitCode === null && !this.proc.killed;
  }

  get exited(): boolean {
    return this.proc.exitCode !== null || this.proc.killed;
  }

  /** 优雅停机（SIGTERM → launcher shutdown → drain + 释放锁；TS4 优雅变体）。 */
  async stop(): Promise<void> {
    if (this.exited) return;
    this.proc.kill("SIGTERM");
    await waitFor(() => this.exited, 15_000, "daemon SIGTERM 后未退出");
  }

  /** 强杀（kill -9；不给 drain 机会——TS4 可选变体）。 */
  async kill(): Promise<void> {
    if (this.exited) return;
    this.proc.kill("SIGKILL");
    await waitFor(() => this.exited, 5_000, "daemon SIGKILL 后未退出");
  }
}

function spawnAndWait(home: string, toolCwd: string, args: string[], spawnEnv?: Record<string, string>): Promise<DaemonProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn(BUN, args, {
      cwd: WORKTREE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...spawnEnv },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill("SIGKILL");
      } catch {}
      reject(new Error(`daemon 启动超时（20s）\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 20_000);

    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      const line = chunk.split("\n").find((l) => l.startsWith(READY_PREFIX));
      if (line && !settled) {
        settled = true;
        clearTimeout(timer);
        try {
          const port = (JSON.parse(line.slice(READY_PREFIX.length)) as { port: number }).port;
          resolve(new DaemonProcess(home, toolCwd, proc, port));
        } catch {
          reject(new Error(`daemon ready 行解析失败：${line}`));
        }
      }
    });
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`daemon 提前退出（code=${code}）\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(what);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ── TR-TEST-6 零残留纪律：残留探测 / 兜底回收 / 端口验证 ─────

/** E 层 fixture tmp 基目录前缀（fixture 自建 + spec 自建 home 统一形态）。 */
export const E2E_TMP_PREFIX = "helix-e2e-";

/** 残留进程特征：本 worktree 内的 daemon launcher / SubAgent ChildMain。 */
const RESIDUE_COMMAND_FEATURES = [/launcher\.ts/, /ChildMain\.ts/];

export interface ResidueProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly command: string;
}

/** ps 特征扫描：命令行含本 worktree 路径 + launcher/ChildMain 特征的进程
 *  （daemon 与其派生的 SubAgent 子进程树——含孤儿化后 reparent 的成员）。 */
export function findResidueProcesses(): ResidueProcess[] {
  const out = execSync("ps axo pid=,pgid=,command=", {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const hits: ResidueProcess[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue; // 自身（spec 进程命令行可能含 worktree 路径）
    const command = m[3]!.trim();
    if (!command.includes(WORKTREE_ROOT)) continue; // 只回收本 worktree 的
    if (!RESIDUE_COMMAND_FEATURES.some((re) => re.test(command))) continue;
    hits.push({ pid, pgid: Number(m[2]), command });
  }
  return hits;
}

/** tmp 基目录残留清单（helix-e2e-* 前缀；空 = 三面之一干净）。 */
export function listE2eTmpResidue(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(E2E_TMP_PREFIX));
}

/** 兜底回收残留子进程树（独立于 Launcher O-6 业务路径的双层兜底）：
 *  SIGTERM（detached 子进程为组长——负 pid 命中全组含工具孙进程）→
 *  graceMs 超时 SIGKILL。返回仍未退出者（空 = 回收干净）。 */
export async function recoverResidueProcesses(graceMs = 3000): Promise<ResidueProcess[]> {
  let targets = findResidueProcesses();
  if (targets.length === 0) return [];
  for (const t of targets) killResidue(t, "SIGTERM");
  if (await waitResidueGone(graceMs)) return [];
  targets = findResidueProcesses();
  for (const t of targets) killResidue(t, "SIGKILL");
  if (await waitResidueGone(2000)) return [];
  return findResidueProcesses();
}

function killResidue(t: ResidueProcess, sig: NodeJS.Signals): void {
  try {
    // 组长（pgid===pid，detached spawn 形态）→ 负 pid 组杀；否则单 pid
    // （避免误伤与 runner 同组的无关进程）
    if (t.pgid === t.pid) process.kill(-t.pid, sig);
    else process.kill(t.pid, sig);
  } catch {
    /* ESRCH：目标已退出 */
  }
}

async function waitResidueGone(timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
    if (findResidueProcesses().length === 0) return true;
  }
  return findResidueProcesses().length === 0;
}

/** 端口可 bind 探测（true = 已释放）。 */
export async function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** 端口释放验证（三件套之三）：timeoutMs 内 bind 探测成功才算释放，
 *  超时抛错（→ 断言红）。 */
export async function waitForPortFree(port: number, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!(await canBindPort(port))) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`端口 127.0.0.1:${port} 在 ${timeoutMs}ms 内未释放（残留 daemon？）`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── Playwright fixture ─────────────────────────────────────

export interface E2eContext {
  readonly daemonPort: number;
  readonly viteBase: string;
  readonly daemonBase: string;
  readonly shellDist: string;
  /** 启动一个真 daemon（FakeLLM 剧本 + tmp home；用后自动收尾） */
  startDaemon(opts: DaemonStartOptions): Promise<DaemonProcess>;
  /** 打开 P-1（默认 vite dev 基址；TC3.4 基线 B 传 daemon static serve） */
  openApp(page: Page, origin?: string): Promise<void>;
  /** 等 data-conn=connected（真 WS 握手 + welcome + snapshot 完成） */
  waitForConnected(page: Page, timeout?: number): Promise<void>;
  /** 真实键盘路径发送消息（fill + Enter） */
  send(page: Page, text: string): Promise<void>;
  /** 等某条 assistant 气泡含指定文本（流式完成后的终态断言入口） */
  waitForAssistantText(page: Page, text: string, timeout?: number): Promise<Locator>;
  /** 等一轮对话收口（文末标记到达 + 流式光标消失 + composer 离开 streaming）。
   *  停机/断言前的前置等待必须用它——只等开头子串会在流中途中命中，导致
   *  SIGTERM 抢在 message_end 落盘前（重启后丢 assistant 条目）。 */
  waitForTurnDone(page: Page, endText: string, timeout?: number): Promise<Locator>;
  /** 安装 data-conn 变化序列记录器（重启恢复序列断言用） */
  installConnRecorder(page: Page): Promise<void>;
  readConnSeq(page: Page): Promise<string[]>;
}

async function routeOfflineFonts(page: Page): Promise<void> {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/css", body: "/* e2e offline */" });
  });
}

export const test = base.extend<{ e2e: E2eContext }>({
  e2e: async ({ page }, use) => {
    const started: DaemonProcess[] = [];
    const ctx: E2eContext = {
      daemonPort: E2E_DAEMON_PORT,
      viteBase: E2E_VITE_BASE,
      daemonBase: E2E_DAEMON_BASE,
      shellDist: SHELL_DIST,
      async startDaemon(opts) {
        const d = await DaemonProcess.start(opts);
        started.push(d);
        return d;
      },
      async openApp(pg, origin = E2E_VITE_BASE) {
        await routeOfflineFonts(pg);
        await pg.goto(origin + "/");
        await expect(pg.locator(".app")).toBeVisible();
      },
      async waitForConnected(pg, timeout = 15_000) {
        await expect
          .poll(() => pg.locator(".app").getAttribute("data-conn"), { timeout })
          .toBe("connected");
      },
      async send(pg, text) {
        const input = pg.locator("#msg-input");
        await input.fill(text);
        await input.press("Enter");
      },
      async waitForAssistantText(pg, text, timeout = 20_000) {
        const hit = pg.locator(".msg.assistant .md-body", { hasText: text }).last();
        await expect(hit).toBeVisible({ timeout });
        return hit;
      },
      async waitForTurnDone(pg, endText, timeout = 30_000) {
        const hit = await this.waitForAssistantText(pg, endText, timeout);
        await expect(pg.locator(".stream-cursor")).toHaveCount(0, { timeout: timeout });
        await expect(pg.locator(".composer")).not.toHaveClass(/streaming/, { timeout: timeout });
        return hit;
      },
      async installConnRecorder(pg) {
        // 对已加载页面直接装 MutationObserver（addInitScript 仅加载前生效）
        await pg.evaluate(() => {
          const w = window as unknown as { __connSeq?: string[] };
          const app = document.querySelector(".app");
          if (!app) throw new Error("installConnRecorder: .app 不存在");
          const seq: string[] = w.__connSeq ?? [];
          seq.push(app.getAttribute("data-conn") ?? "");
          new MutationObserver(() => seq.push(app.getAttribute("data-conn") ?? "")).observe(app, {
            attributes: true,
            attributeFilter: ["data-conn"],
          });
          w.__connSeq = seq;
        });
      },
      async readConnSeq(pg) {
        return pg.evaluate(() => (window as unknown as { __connSeq?: string[] }).__connSeq ?? []);
      },
    };
    await use(ctx);
    // ── teardown 三件套（TR-TEST-6；任一命中即红，非软警告）──
    // 旧 teardown 只 SIGTERM（TR-TEST-4 残留实锤）：tmp home 不删、子进程树不
    // 回收、端口不验——现由 fixture 統一收编（含 spec 自建 home 的旁路清理）。
    const failures: string[] = [];
    // ① 停机：SIGTERM 15s 优雅 → 未退出（挂起剧本等）SIGKILL 升级兑底
    for (const d of started.reverse()) {
      try {
        if (d.running) await d.stop();
      } catch {
        /* 超时/挂起：走下方 kill 升级 */
      }
      try {
        if (d.running) await d.kill();
      } catch (err) {
        failures.push(`daemon(${d.home}) SIGKILL 升级后仍存活：${err}`);
      }
    }
    // ② 子进程树兑底回收（独立于 Launcher O-6：注入 runner 的子进程不在
    //    daemon dispose 范围，daemon 异常退出时真体同样失守——双层兑底）
    const residue = await recoverResidueProcesses();
    if (residue.length > 0) {
      failures.push(
        `残留进程未回收：${residue.map((r) => `pid=${r.pid} pgid=${r.pgid} ${r.command}`).join("；")}`,
      );
    }
    // ③ tmp home 全删（fixture 自建 + spec 自建一并收编——旁路清理归一）
    for (const home of [...new Set(started.map((d) => d.home))]) {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch (err) {
        failures.push(`tmp home 删除失败 ${home}：${err}`);
      }
    }
    // ④ 端口释放验证（bind 探测成功才算释放）
    try {
      await waitForPortFree(E2E_DAEMON_PORT, 5000);
    } catch (err) {
      failures.push(String(err));
    }
    if (failures.length > 0) {
      throw new Error(
        `【TR-TEST-6】E 层 teardown 零残留断言失败：\n- ${failures.join("\n- ")}`,
      );
    }
  },
});

export { expect };
