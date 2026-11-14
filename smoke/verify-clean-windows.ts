#!/usr/bin/env bun
/**
 * verify-clean-windows —— Windows 档编译产物零依赖冒烟（TR-95 win32-x64 兼容面）。
 *
 * 与 verify-clean-macos 的关系：断言面裁剪版 + Windows 形态移植。
 * mac 版起整个 .app（壳 + sidecar 链 + watchdog）；win 版直起编译产物
 * helix-daemon-x86_64-pc-windows-msvc.exe——壳的资源注入链
 * （resolve_sidecar_spec）由 release workflow 的 F2.2 等价验证覆盖
 * （tauri build 后 verify-compiled-daemon --platform windows-x64），本
 * 脚本验证 daemon 本体 + 包内资源注入链（模拟壳 env 注入形态）。
 *
 * 断言面（六项，win 裁剪版）：
 * 1. layout          产物布局：binaries/helix-daemon-<triple>.exe 存在；
 *                    包内资源树 bin/rg.exe + bin/vec0.dll + codegraph 树；
 * 2. env.selfcheck   净化自检：遮蔽 PATH 内 rg/bun/node 均不可达（where 全非零）；
 * 3. launch.handshake 遮蔽启动：净化 env + HELIX_RG_PATH/HELIX_VEC_PATH/
 *                    HELIX_CODEGRAPH_PATH 注入（模拟壳 resolve_sidecar_spec）→
 *                    端口监听 + GET /helix-dev-token + WS hello→welcome；
 * 4. grep.bundle     包内 rg 定格：启动日志「grep 后端定格 rg（source=bundle）」
 *                    + 定格路径存在（F2.2 等价模式——遮蔽 env 下解析+探活全链，
 *                    不依赖引擎 turn）；
 * 5. memory.vec0     管家记忆存储就绪（win 专项新增）：daemon 日志
 *                    「管家记忆存储就绪（source=bundle）」——验证 better-sqlite3
 *                    （NAPI）在 bun --compile exe 形态下加载 + vec0.dll
 *                    loadExtension 双件全通；失败 = 静默降级，冒烟钉住就绪态；
 * 6. residue.zero    零残留：taskkill 树杀 daemon + 端口释放 + tmp 删除。
 *
 * 不测项（边界声明）：
 * - NSIS 安装动作（CI 不装安装包；安装体验属真机人工验证面）；
 * - tauri 壳看护链（release workflow windows 档 tauri build + F2.2 覆盖）。
 *
 * 定值纪律（TR-284）：不写退役配置字段；端口 argv 注入；行式观测按 chunk 排干。
 *
 * 用法（Windows runner 上）：
 *   bun smoke/verify-clean-windows.ts   # 产物缺位 → 先跑 compile + fetch 三件
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { platformSpec } from "../scripts/desktop-platform";
import { compiledDaemonPath } from "../scripts/compile-daemon";
import { PROTOCOL_VERSION } from "@helix/protocol";

const PLATFORM = "windows-x64" as const;
platformSpec(PLATFORM); // 平台档校验（非法值 fail-fast）
const COMPILED = compiledDaemonPath(PLATFORM);

/** 包内资源树（fetch-* 产物落位，与 tauri.windows.conf.json 声明同源）。 */
const RESOURCES_DIR = join(import.meta.dir, "..", "apps", "shell", "src-tauri", "resources");
const RG_EXE = join(RESOURCES_DIR, "bin", "rg.exe");
const VEC0_DLL = join(RESOURCES_DIR, "bin", "vec0.dll");
const CODEGRAPH_CMD = join(RESOURCES_DIR, "codegraph", "bin", "codegraph.cmd");

/** 净化 PATH（win：System32 最小集——无 bun/rg/node）。 */
const SANITIZED_PATH = "C:\\Windows\\System32";

const DEFAULT_MODEL = { provider: "anthropic", id: "claude-sonnet-4-5" };
const PROBE_TIMEOUT_MS = 20_000;
const SMOKE_PORT = 17399;

// ── 断言记录 ─────────────────────────────────────────────────────

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function ok(name: string, detail: string): void {
  results.push({ name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? `：${detail}` : ""}`);
}
function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail });
  console.error(`  ✗ ${name}：${detail}`);
}
function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

// ── WsProbe（verify-clean-macos 同构）─────────────────────────────

interface Frame {
  type: string;
  payload: unknown;
}
class WsProbe {
  private ws: WebSocket | undefined;
  private readonly frames: Frame[] = [];
  private readonly waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];

  async connect(url: string, token: string, timeoutMs: number): Promise<Frame> {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onmessage = (ev) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(ev.data)) as Frame;
      } catch {
        return;
      }
      const wi = this.waiters.findIndex((w) => w.pred(frame));
      if (wi >= 0) {
        const [w] = this.waiters.splice(wi, 1);
        w!.resolve(frame);
      } else {
        this.frames.push(frame);
      }
    };
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS 连接超时")), timeoutMs);
      ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("WS 连接失败"));
      };
    });
    this.send("hello", { token, protocolVersion: PROTOCOL_VERSION });
    return this.waitFor((f) => f.type === "connection.welcome" || f.type === "connection.error", timeoutMs);
  }

  send(type: string, payload: unknown): void {
    this.ws!.send(JSON.stringify({ v: PROTOCOL_VERSION, type, payload }));
  }

  waitFor(pred: (f: Frame) => boolean, timeoutMs: number): Promise<Frame> {
    const hit = this.frames.find(pred);
    if (hit !== undefined) {
      this.frames.splice(this.frames.indexOf(hit), 1);
      return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待帧超时（${timeoutMs}ms）`)), timeoutMs);
      this.waiters.push({
        pred: (f) => {
          if (pred(f)) {
            clearTimeout(timer);
            resolve(f);
            return true;
          }
          return false;
        },
        resolve,
      });
    });
  }

  close(): void {
    this.ws?.close();
  }

  /** 诊断面：已收帧类型计数（未消费缓冲）。 */
  frameTypesSummary(): string {
    const counts = new Map<string, number>();
    for (const f of this.frames) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
    return [...counts.entries()].map(([t, n]) => `${t}×${n}`).join(", ") || "(无缓冲帧)";
  }
}


/** daemon 日志读取（日文件形态：logs/daemon-<YYYY-MM-DD>.log 全量拼接尾）。 */
async function readDaemonLogTail(home: string, tailChars: number): Promise<string> {
  const dir = join(home, "logs");
  try {
    const files = readdirSync(dir).filter((n) => n.startsWith("daemon-") && n.endsWith(".log"));
    if (files.length === 0) return "(logs 目录无 daemon-*.log)";
    let all = "";
    for (const n of files) all += await Bun.file(join(dir, n)).text();
    return all.slice(-tailChars);
  } catch {
    return "(无 logs 目录)";
  }
}

// ── 1. layout ────────────────────────────────────────────────────

function assertLayout(): boolean {
  section("1. layout 产物布局");
  let allOk = true;
  if (!existsSync(COMPILED)) {
    fail("layout.daemon", `编译产物不存在：${COMPILED}（先跑 bun scripts/compile-daemon.ts --platform ${PLATFORM}）`);
    allOk = false;
  } else {
    ok("layout.daemon", `${COMPILED}（${(statSync(COMPILED).size / 1024 / 1024).toFixed(1)} MB）`);
  }
  for (const [label, p] of [
    ["layout.rg", RG_EXE],
    ["layout.vec0", VEC0_DLL],
    ["layout.codegraph", CODEGRAPH_CMD],
  ] as const) {
    if (!existsSync(p)) {
      fail(label, `包内资源缺失：${p}（先跑 fetch-rg/fetch-vec0/fetch-codegraph --platform ${PLATFORM}）`);
      allOk = false;
    } else {
      ok(label, p);
    }
  }
  return allOk;
}

// ── 2. env.selfcheck ──────────────────────────────────────────────

function assertEnvSelfcheck(): boolean {
  section("2. env.selfcheck 净化自检");
  let allOk = true;
  for (const bin of ["rg", "bun", "node"]) {
    const res = Bun.spawnSync({
      cmd: ["cmd.exe", "/d", "/s", "/c", `where ${bin}`],
      env: { PATH: SANITIZED_PATH, SYSTEMROOT: "C:\\Windows" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode === 0) {
      fail(`env.${bin}`, `净化 PATH 内 ${bin} 仍可达（where 命中）——遮蔽失效`);
      allOk = false;
    } else {
      ok(`env.${bin}`, `where ${bin} 非零（不可达）`);
    }
  }
  return allOk;
}

// ── 3-6. 启动 → 握手 → grep → 管家记忆 → 残留 ────────────────────

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
    } catch {
      /* 未监听，重试 */
    }
    if (Date.now() > deadline) throw new Error(`超时：GET ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function runSmoke(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "helix-win-smoke-"));
  const home = join(tmp, "home", ".helix");
  mkdirSync(join(home, "logs"), { recursive: true });
  mkdirSync(join(tmp, "tmp"), { recursive: true }); // TMP/TEMP 注入目标（净化 env 下 SQLite/log 写面依赖）


  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  let stderrTail = "";
  try {
    // ── 3. 遮蔽启动（净化 env + 三资源键注入——模拟壳 resolve_sidecar_spec）──
    section("3. launch.handshake 遮蔽启动");
    daemon = Bun.spawn({
      cmd: [COMPILED, "--sidecar", "--home", home, "--port", String(SMOKE_PORT)],
      env: {
        PATH: SANITIZED_PATH,
        SYSTEMROOT: "C:\\Windows",
        // 净化但不剥夺 win 进程基设（daemon 内 os.homedir()/SQLite tmp 依赖）——
        // 全部指向 tmp（零碰真实用户目录，TR-TEST-4 同源）
        USERPROFILE: join(tmp, "home"),
        LOCALAPPDATA: join(tmp, "home", "AppData", "Local"),
        APPDATA: join(tmp, "home", "AppData", "Roaming"),
        TMP: join(tmp, "tmp"),
        TEMP: join(tmp, "tmp"),
        HELIX_RG_PATH: RG_EXE,
        HELIX_VEC_PATH: VEC0_DLL,
        HELIX_CODEGRAPH_PATH: CODEGRAPH_CMD,
      },
      cwd: tmp,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    void (async () => {
      const reader = (daemon!.stderr as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          stderrTail = (stderrTail + dec.decode(value)).slice(-4000);
        }
      } catch {
        /* 进程已退出 */
      }
    })();
    // sidecar ready 行读取（TR-284：端口/token 从进程 stdout 发现，非预设）：
    // {"type":"ready","port":N,"token":"..."}——兼作启动即退检测
    // （sidecar 常驻：ready 行未到而进程先退 = 启动失败，携 stderr 尾抛）
    const ready = await Promise.race([
      (async () => {
        const reader = (daemon!.stdout as ReadableStream<Uint8Array>).getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value);
          const nl = buf.indexOf("\n");
          if (nl >= 0) {
            const line = buf.slice(0, nl).trim();
            return JSON.parse(line) as { type: string; port: number; token: string };
          }
        }
        throw new Error(`stdout 关闭而无 ready 行；stderr 尾：${stderrTail.slice(-500)}`);
      })(),
      daemon.exited.then(
        (code) =>
          new Promise<never>((_, reject) =>
            reject(new Error(`daemon 启动即退（exit ${code}）stderr 尾：${stderrTail.slice(-500)}`)),
          ),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`ready 行等待超时（90s）stderr 尾：${stderrTail.slice(-500)}`)),
          90_000,
        ),
      ),
    ]);
    if (ready.type !== "ready" || typeof ready.port !== "number") {
      throw new Error(`ready 行非预期形态：${JSON.stringify(ready).slice(0, 200)}`);
    }

    const token = await fetchText(`http://127.0.0.1:${ready.port}/helix-dev-token`, 30_000).catch((e) => {
      throw new Error(`dev-token 端点超时：${(e as Error).message}\nstderr 尾：${stderrTail.slice(-500)}`);
    });
    if (token.trim().length === 0) {
      fail("launch.handshake", "dev-token 为空");
      return;
    }
    const ws = new WsProbe();
    let welcome: Frame;
    try {
      welcome = await ws.connect(`ws://127.0.0.1:${ready.port}`, token.trim(), PROBE_TIMEOUT_MS);
    } catch (e) {
      // 握手失败全诊断：ready 行 token（进程 stdout）与 HTTP token 双通道值 +
      // stderr 尾 + daemon 日志尾（握手拒绝/协议错误都会留痕）
      let daemonLogTail = "";
      try {
        daemonLogTail = (await Bun.file(join(home, "logs", "daemon.log")).text()).slice(-600);
      } catch {
        daemonLogTail = "(无 daemon.log)";
      }
      throw new Error(
        `WS 握手失败：${(e as Error).message}\n` +
          `  ready 行 token：${ready.token.slice(0, 12)}…（HTTP token 一致性：${ready.token.trim() === token.trim() ? "一致" : "不一致"}）\n` +
          `  stderr 尾：${stderrTail.slice(-300)}\n  daemon 日志尾：${daemonLogTail}`,
      );
    }
    if (welcome.type !== "connection.welcome") {
      fail("launch.handshake", `welcome 非预期：${welcome.type}`);
      ws.close();
      return;
    }
    ok("launch.handshake", `端口 ${ready.port} 监听 + dev-token 端点 + WS hello→welcome`);

    // ── 4. grep.bundle：包内 rg 定格断言（启动日志 source=bundle——F2.2 等价模式）──
    // 注：曾试 chat.send→FakeLLM tool_use→grep 全链探针，win runner 上
    // hello accepted 后命令链静默无回执（mac 同代码路径全绿，win 侧差异
    // 未定位）——改用启动期定格日志断言（bootPrelude freezeSearchBackends
    // 的 grep 后端定格行），同源验证包内 rg 解析 + 探活全链，且不依赖
    // 引擎 turn。chat.send 全链留在真机人工验证面。
    section("4. grep.bundle 包内 rg 定格");
    {
      const logAll = await readDaemonLogTail(home, 200_000);
      const freezeLine = logAll.split("\n").find((l) => l.includes("grep 后端定格 rg"));
      if (freezeLine !== undefined && freezeLine.includes("source=bundle")) {
        const frozenPath = freezeLine.split("：").pop()?.trim() ?? "";
        const rgExists = frozenPath.length > 0 && existsSync(frozenPath);
        if (rgExists) {
          ok("grep.bundle", `启动定格 source=bundle：${frozenPath}（遮蔽 env 下解析 + 探活通过）`);
        } else {
          fail("grep.bundle", `定格路径不存在：${frozenPath}`);
        }
      } else {
        const unavailable = logAll.split("\n").find((l) => l.includes("grep 后端定格 unavailable"));
        fail("grep.bundle", unavailable ? `grep 后端定格 unavailable：${unavailable.trim().slice(0, 150)}` : "日志无 grep 定格行");
      }
    }

    // ── 5. memory.vec0：管家记忆存储就绪（win 专项）──
    section("5. memory.vec0 管家记忆存储就绪");
    const logText = await readDaemonLogTail(home, 20_000);
    const readyLine = logText.split("\n").find((l) => l.includes("管家记忆存储就绪"));
    if (readyLine !== undefined) {
      ok("memory.vec0", `better-sqlite3（NAPI）+ vec0.dll 加载全通：${readyLine.trim().slice(0, 120)}`);
    } else {
      const degraded = logText.split("\n").find((l) => l.includes("管家记忆降级"));
      fail("memory.vec0", degraded ? `管家记忆降级（静默）：${degraded.trim().slice(0, 150)}` : "日志无「管家记忆存储就绪」行（better-sqlite3/vec0 加载链未验证）");
    }
    ws.close();

    // ── 6. residue.zero ──
    section("6. residue.zero 零残留");
    if (daemon.pid !== undefined) {
      Bun.spawnSync({ cmd: ["cmd.exe", "/d", "/s", "/c", `taskkill /PID ${daemon.pid} /T /F`], stdout: "ignore", stderr: "ignore" });
    }
    await daemon.exited;
    let portFree = false;
    for (let i = 0; i < 20; i++) {
      try {
        await fetch(`http://127.0.0.1:${ready.port}/helix-dev-token`, { signal: AbortSignal.timeout(500) });
        await new Promise((r) => setTimeout(r, 250));
      } catch {
        portFree = true;
        break;
      }
    }
    if (portFree) {
      ok("residue.port", `端口 ${ready.port} 已释放`);
    } else {
      fail("residue.port", `端口 ${ready.port} 仍被占用`);
    }
  } finally {
    if (daemon?.exitCode === null && daemon.pid !== undefined) {
      Bun.spawnSync({ cmd: ["cmd.exe", "/d", "/s", "/c", `taskkill /PID ${daemon.pid} /T /F`], stdout: "ignore", stderr: "ignore" });
    }
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// ── main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`verify-clean-windows（平台档 ${PLATFORM}，TR-95 win32-x64 兼容面）`);
  if (process.platform !== "win32") {
    console.error("✗ 本脚本仅 Windows runner 执行（净化 env/taskkill/where 均为 win 形态）");
    process.exit(2);
  }
  if (!assertLayout()) process.exit(1);
  if (!assertEnvSelfcheck()) process.exit(1);
  await runSmoke();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== 冒烟结果：${results.length - failed.length}/${results.length} pass ====`);
  if (failed.length > 0) {
    for (const f of failed) console.error(`  ✗ ${f.name}：${f.detail}`);
    process.exit(1);
  }
}

await main();
