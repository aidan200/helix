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
 */
import { test as base, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { DaemonScript } from "./daemon-script";

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
  /** static serve 目录（TC3.4 基线 B 用；缺省不 serve） */
  staticDir?: string;
  /** spawn 重试次数（同端口重启时端口短暂占用的缓冲） */
  retries?: number;
  /** 复用已存在的 home（TS4 重启语义：同 --home 重建） */
  home?: string;
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

    const args = [
      LAUNCHER,
      "--home",
      home,
      "--port",
      String(E2E_DAEMON_PORT),
      "--script",
      scriptFile,
      "--tool-cwd",
      toolCwd,
    ];
    if (opts.staticDir) args.push("--static-dir", opts.staticDir);

    try {
      return await spawnAndWait(home, toolCwd, args);
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

function spawnAndWait(home: string, toolCwd: string, args: string[]): Promise<DaemonProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn(BUN, args, {
      cwd: WORKTREE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
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
    for (const d of started.reverse()) {
      if (d.running) await d.stop().catch(() => undefined);
    }
  },
});

export { expect };
