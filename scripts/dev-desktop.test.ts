/**
 * dev-desktop 编排测试（CL-4/F4.1/F4.2；test-design §CL-4；TR-TEST-6）。
 *
 * - F4.1 前置自检：checkRustToolchain 纯函数全分支（cargo 缺/rustc 缺/
 *   齐全/全缺）+ 脚本级 PATH 净化注入 → 一行安装提示 + 非零退出 +
 *   零进程起（ps 断言）。
 * - F4.2 编排 + teardown：真起三进程（daemon bun 直跑源码经壳 sidecar
 *   wrapper + vite dev + cargo tauri dev）→ WS/HTTP 连通断言 → SIGINT →
 *   三件套零残留（进程树/端口/tmp）→ 连跑两轮零残留。
 * - `bun run dev` 不受影响：根 package.json dev 脚本无 cargo 自检耦合。
 *
 * 注（AF-5）：bun test 进程内首次 Bun.spawn 有预热延迟，本文件全部等待
 * 阈值为秒级，不受影响。集成用例需本机 7333/5173 端口空闲（tauri dev
 * 会真实编译并开窗，属预期——窗口/HMR 体感为人工确认项）。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkRustToolchain,
  collectDescendantPids,
  parsePsTable,
  renderInstallHint,
} from "./dev-desktop";

// H-1 TDD-RED：以下 import 的符号尚未实现（先红后绿）
import { ensureRgAvailable, tauriDevArgs, TAURI_DEV_CONFIG_OVERRIDE } from "./dev-desktop";

// TDD-RED：wrapper cwd 止血——buildWrapperScript 尚未实现（先红后绿）
import { buildWrapperScript, resolveDevWorkspaceRoot } from "./dev-desktop";

const root = join(import.meta.dir, "..");
const SCRIPT = join(root, "scripts/dev-desktop.ts");

// ── 测试工具 ────────────────────────────────────────────────

function psEdges(): [number, number][] {
  const r = Bun.spawnSync({ cmd: ["ps", "-Ao", "pid=,ppid="], stdout: "pipe", stderr: "ignore" });
  return parsePsTable(r.stdout.toString());
}

/** 编排特征进程（cargo tauri dev / vite / daemon main.ts）的 pid 集合。 */
function orchestrationPids(): Set<number> {
  const r = Bun.spawnSync({ cmd: ["ps", "-Ao", "pid=,command="], stdout: "pipe", stderr: "ignore" });
  const out = new Set<number>();
  for (const line of r.stdout.toString().split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const cmd = m[2]!;
    if (
      cmd.includes("cargo tauri dev") ||
      cmd.includes("tauri dev") ||
      /vite(?!st)/.test(cmd) || // vite 本体（排除 vitest）
      cmd.includes("apps/daemon/src/main.ts")
    ) {
      out.add(Number(m[1]));
    }
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tcpOpenOn(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
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

function rawHttpGetOn(
  port: number,
  path: string,
  host: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`rawHttpGet 超时（${host}:${port}${path}）`));
    }, 5000);
    sock.on("connect", () =>
      // Host 钉 localhost：vite host-check 对回环 IP Host 返 403
      sock.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`),
    );
    sock.on("data", (chunk) => (buf += chunk.toString()));
    sock.on("close", () => {
      clearTimeout(timer);
      const m = buf.match(/^HTTP\/\d\.\d (\d{3})/);
      const body = buf.slice(buf.indexOf("\r\n\r\n") + 4);
      resolve({ status: m ? Number(m[1]) : 0, body });
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 裸 socket HTTP GET（双栈；绕过 HTTP_PROXY 环境代理——本机常驻代理会
 *  劫持 fetch 致 502；断言目标是回环服务本身）。 */
async function rawHttpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  try {
    return await rawHttpGetOn(port, path, "127.0.0.1");
  } catch {
    return await rawHttpGetOn(port, path, "::1");
  }
}

/** 双栈探测：vite 默认绑 localhost（可能落 IPv6 ::1），daemon 钉 127.0.0.1。 */
async function tcpOpen(port: number): Promise<boolean> {
  return (await tcpOpenOn(port, "127.0.0.1")) || (await tcpOpenOn(port, "::1"));
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${what}`);
    await Bun.sleep(500);
  }
}

/** WS 连通断言：token 端点取 token → hello 握手 → 收首帧（welcome）。 */
async function wsHello(port: number): Promise<boolean> {
  const res = await rawHttpGet(port, "/helix-dev-token");
  if (res.status !== 200) return false;
  const token = res.body.trim();
  return await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.close();
      resolve(false);
    }, 5000);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          v: "0.10",
          id: "dev-desktop-test",
          payload: { token, protocolVersion: "0.10" },
        }),
      );
    ws.onmessage = () => {
      clearTimeout(timer);
      ws.close();
      resolve(true);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
}

// ── F4.1 自检判定纯函数（全分支）─────────────────────────────

describe("checkRustToolchain（自检判定纯函数，探测函数注入）", () => {
  test("cargo/rustc 齐全 → ok", () => {
    const r = checkRustToolchain(() => true);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.hint).toBe("");
  });

  test("缺 cargo → 缺失列表含 cargo，提示为单行且含 rustup 安装命令", () => {
    const r = checkRustToolchain((bin) => bin !== "cargo");
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["cargo"]);
    expect(r.hint).not.toContain("\n");
    expect(r.hint).toContain("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh");
    expect(r.hint).toContain("cargo");
  });

  test("缺 rustc → 缺失列表含 rustc", () => {
    const r = checkRustToolchain((bin) => bin !== "rustc");
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["rustc"]);
    expect(r.hint).toContain("rustc");
  });

  test("cargo/rustc 全缺 → 缺失列表全量", () => {
    const r = checkRustToolchain(() => false);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["cargo", "rustc"]);
    expect(r.hint).not.toContain("\n");
  });

  test("renderInstallHint 恒单行", () => {
    expect(renderInstallHint(["cargo", "rustc"])).not.toContain("\n");
  });
});

describe("ps 快照解析（teardown 进程树枚举纯函数面）", () => {
  test("parsePsTable 解析 pid/ppid 行，跳过噪声行", () => {
    const edges = parsePsTable("  PID  PPID\n    1     0\n  100     1\n garbage line \n  101   100\n");
    expect(edges).toContainEqual([1, 0]);
    expect(edges).toContainEqual([100, 1]);
    expect(edges).toContainEqual([101, 100]);
    expect(edges.length).toBe(3);
  });

  test("collectDescendantPids 递归收集全部后代（不含根）", () => {
    const edges: [number, number][] = [
      [1, 0],
      [10, 1],
      [11, 1],
      [20, 10],
      [21, 20],
      [99, 0],
    ];
    expect(collectDescendantPids(1, edges).sort((a, b) => a - b)).toEqual([10, 11, 20, 21]);
    expect(collectDescendantPids(10, edges).sort((a, b) => a - b)).toEqual([20, 21]);
    expect(collectDescendantPids(99, edges)).toEqual([]);
  });
});

// ── H-1 方案 C：tauri dev override 组装（RFC 7386 覆盖语义）────────

describe("tauriDevArgs（H-1 方案 C：dev 剥离 bundle 资源生产校验）", () => {
  test("携带 --config，override 为 v2 格式且数组字段覆盖写法精确", () => {
    const args = tauriDevArgs();
    expect(args.slice(0, 2)).toEqual(["tauri", "dev"]);
    const idx = args.indexOf("--config");
    expect(idx).toBeGreaterThanOrEqual(2);
    const override = JSON.parse(args[idx + 1]!);
    // v2 格式：无 tauri 包装键（v1 风格被 schema 拒绝，实测）
    expect(override).not.toHaveProperty("tauri");
    // 数组字段覆盖：externalBin 空数组 → dev 对 daemon 二进制零检查
    expect(override.bundle.externalBin).toEqual([]);
    // 回归钉：resources 必须是 [] 而非 {}——RFC 7386 下 {} 对 map 字段
    // 是递归合并空操作（不删键），实测 {} 时 rg 缺失报错依旧
    expect(override.bundle.resources).toEqual([]);
  });

  test("override 常量与 args 内嵌值一致（单源）", () => {
    const args = tauriDevArgs();
    expect(args[args.indexOf("--config") + 1]).toBe(TAURI_DEV_CONFIG_OVERRIDE);
    expect(JSON.parse(TAURI_DEV_CONFIG_OVERRIDE)).toEqual({
      bundle: { externalBin: [], resources: [] },
    });
  });

  test("vite 端口覆盖位注入 → devUrl 随动（tauri dev 前端等待钉对端口）", () => {
    // F4.2 隐患修复：HELIX_DESKTOP_VITE_PORT 覆盖后 tauri dev 的 devUrl
    // 等待必须钉覆盖端口，否则等默认 5173 空等 180s exit(1)，编排永远起不来
    const args = tauriDevArgs("15173");
    const override = JSON.parse(args[args.indexOf("--config") + 1]!);
    expect(override.bundle).toEqual({ externalBin: [], resources: [] });
    expect(override.build.devUrl).toBe("http://localhost:15173");
    // 无注入位时不得带 build 键（生产默认路径零干扰）
    expect(JSON.parse(TAURI_DEV_CONFIG_OVERRIDE)).not.toHaveProperty("build");
  });
});

// ── H-1 动作③：rg 自动补判定（探测/安装注入，全分支）─────────────

describe("ensureRgAvailable（H-1 rg 环境无关：存在性检查 + 缺失自动 fetch）", () => {
  test("已装且校验通过 → 幂等跳过，不触发安装", async () => {
    let installs = 0;
    const r = await ensureRgAvailable(
      async () => true,
      async () => {
        installs++;
      },
    );
    expect(r).toEqual({ attempted: false, ok: true, warning: "" });
    expect(installs).toBe(0);
  });

  test("缺失 → 自动触发安装，成功则 ok", async () => {
    let installs = 0;
    const r = await ensureRgAvailable(
      async () => false,
      async () => {
        installs++;
      },
    );
    expect(r.attempted).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.warning).toBe("");
    expect(installs).toBe(1);
  });

  test("缺失 + 安装失败 → 一行警告不抛出（dev 继续，PATH/config 三级解析兜底）", async () => {
    const r = await ensureRgAvailable(
      async () => false,
      async () => {
        throw new Error("下载失败：HTTP 404");
      },
    );
    expect(r.attempted).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.warning).not.toContain("\n");
    expect(r.warning).toContain("HTTP 404");
  });

  test("探测函数抛错视为未装（健壮性）→ 走安装分支", async () => {
    let installs = 0;
    const r = await ensureRgAvailable(
      async () => {
        throw new Error("lipo 异常");
      },
      async () => {
        installs++;
      },
    );
    expect(r.attempted).toBe(true);
    expect(installs).toBe(1);
  });
});

// ── dev sidecar wrapper 生成（cwd 止血：exec 前 cd 仓库根）──────────

describe("buildWrapperScript（wrapper 内容纯函数：cd 在 exec 前）", () => {
  const bunPath = "/usr/local/bin/bun";
  const mainTsPath = "/repo/apps/daemon/src/main.ts";
  const workspaceRoot = "/repo";

  test("无 home：shebang + cd 行 + exec 行含 mainTsPath 与 \"$@\" 尾参，不含 --home", () => {
    const script = buildWrapperScript({ bunPath, mainTsPath, workspaceRoot });
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(`cd '${workspaceRoot}'`);
    // mainTsPath 为绝对路径 → cd 不影响 exec 目标解析（TR-AD-6：拉起方设 cwd，daemon 零 argv/env）
    expect(script).toContain(`exec '${bunPath}' '${mainTsPath}'`);
    expect(script).toContain(`"$@"`);
    expect(script).not.toContain("--home");
  });

  test("有 home：exec 行注入 --home（HELIX_DESKTOP_HOME 隔离位语义不变）", () => {
    const script = buildWrapperScript({ bunPath, mainTsPath, workspaceRoot, home: "/tmp/hx-home" });
    expect(script).toContain(`exec '${bunPath}' '${mainTsPath}' --home '/tmp/hx-home'`);
    expect(script).toContain(`"$@"`);
  });

  test("cd 行在 exec 行之前（daemon cwd 由 wrapper 进程 exec 替换后继承）", () => {
    const script = buildWrapperScript({ bunPath, mainTsPath, workspaceRoot });
    const cdIdx = script.indexOf(`cd '${workspaceRoot}'`);
    const execIdx = script.indexOf("exec ");
    expect(cdIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(cdIdx);
  });

  test("引号/换行与模板严格一致（生成物是 shell 脚本，内容即契约）", () => {
    expect(buildWrapperScript({ bunPath, mainTsPath, workspaceRoot })).toBe(
      `#!/bin/sh\ncd '${workspaceRoot}'\nexec '${bunPath}' '${mainTsPath}' "$@"\n`,
    );
    expect(
      buildWrapperScript({ bunPath, mainTsPath, workspaceRoot, home: "/tmp/hx-home" }),
    ).toBe(
      `#!/bin/sh\ncd '${workspaceRoot}'\nexec '${bunPath}' '${mainTsPath}' --home '/tmp/hx-home' "$@"\n`,
    );
  });
});

// ── dev workspace 根解析（领域原则：必须显式，零静默缺省）──

describe("resolveDevWorkspaceRoot（env 指认 / TTY 选择 / fail-fast，全注入面）", () => {
  const repoRoot = "/ws/helix";
  const exists = new Set(["/ws", "/tmp/picked"]);
  const existsDir = (p: string) => exists.has(p);

  test("env 显式指认且存在 → 直接生效，不走 prompt", async () => {
    let prompted = 0;
    const r = await resolveDevWorkspaceRoot({
      repoRoot,
      envRoot: "/ws",
      existsDir,
      prompt: async () => {
        prompted += 1;
        return "/never";
      },
    });
    expect(r).toEqual({ root: "/ws", source: "env" });
    expect(prompted).toBe(0);
  });

  test("env 指认不存在 → fail-fast（显式输入错误不回退不猜测）", async () => {
    await expect(
      resolveDevWorkspaceRoot({ repoRoot, envRoot: "/nope", existsDir }),
    ).rejects.toThrow("不存在");
  });

  test("env 空白 + TTY + 输入存在路径 → prompt 来源生效", async () => {
    const r = await resolveDevWorkspaceRoot({
      repoRoot,
      envRoot: "   ",
      isTTY: true,
      existsDir,
      prompt: async (suggestion) => {
        expect(suggestion).toBe("/ws"); // 建议 = 仓库父目录
        return "/tmp/picked";
      },
    });
    expect(r).toEqual({ root: "/tmp/picked", source: "prompt" });
  });

  test("env 空白 + TTY + 空输入 → 采纳建议（父目录，当场确认非静默缺省）", async () => {
    const r = await resolveDevWorkspaceRoot({
      repoRoot,
      isTTY: true,
      existsDir,
      prompt: async () => "",
    });
    expect(r).toEqual({ root: "/ws", source: "prompt" });
  });

  test("env 空白 + TTY + 输入不存在 → 报错指引重跑", async () => {
    await expect(
      resolveDevWorkspaceRoot({
        repoRoot,
        isTTY: true,
        existsDir,
        prompt: async () => "/nope",
      }),
    ).rejects.toThrow("不存在");
  });

  test("env 空白 + 无 TTY（CI/测试）→ fail-fast 带一行指引", async () => {
    await expect(
      resolveDevWorkspaceRoot({ repoRoot, isTTY: false, existsDir }),
    ).rejects.toThrow("HELIX_DESKTOP_WORKSPACE_ROOT");
  });
});

/** 空闲端口分配（port 0 由 OS 指派后释放；轻微竞争窗口可接受）。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// ── F4.1 脚本级：PATH 净化注入缺 cargo ─────────────────────

test(
  "F4.1 PATH 净化缺 cargo/rustc → 一行安装提示 + 非零退出 + 零进程起",
  async () => {
    const emptyPath = mkdtempSync(join(tmpdir(), "helix-dev-desktop-nopath-"));
    try {
      const before = orchestrationPids();
      const proc = Bun.spawn({
        cmd: [process.execPath, SCRIPT],
        cwd: root,
        env: { PATH: emptyPath, HELIX_DESKTOP_WORKSPACE_ROOT: emptyPath },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(code).toBe(1); // 非零退出
      const lines = (out + err)
        .trim()
        .split("\n")
        .filter((l) => l.trim() !== "");
      expect(lines.length).toBe(1); // 一行安装提示
      expect(lines[0]).toContain("https://sh.rustup.rs");
      // 零进程起：编排特征进程集合无新增
      const after = orchestrationPids();
      expect([...after].filter((pid) => !before.has(pid))).toEqual([]);
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  },
  30_000,
);

// ── F4.2 编排 + teardown 三件套零残留（连跑两轮）────────────

test(
  "F4.2 三进程编排起（WS 连通）→ SIGINT → 进程树/端口/tmp 零残留（两轮）",
  async () => {
    for (let round = 1; round <= 2; round++) {
      // 端口隔离（TR-TEST-4 同口径：不依赖本机 7333/5173 空闲——daemon 端口
      // 经 <home>/config.json 既有配置面注入，vite 端口经 HELIX_DESKTOP_VITE_PORT
      // 注入；窗口 devUrl 不随动，编排面断言不依赖窗口内容）
      const daemonPort = await freePort();
      const vitePort = await freePort();

      const sandbox = mkdtempSync(join(tmpdir(), "helix-dev-desktop-test-"));
      const home = join(sandbox, "home"); // TR-TEST-4：真实 ~/.helix 零触碰
      const workspace = join(sandbox, "ws"); // workspace 必须显式（领域原则）：注入隔离工作区
      mkdirSync(home, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(home, "config.json"), JSON.stringify({ port: daemonPort }));
      let proc: ReturnType<typeof Bun.spawn> | undefined;
      try {
        proc = Bun.spawn({
          cmd: [process.execPath, SCRIPT],
          cwd: root,
          env: {
            ...process.env,
            HELIX_DESKTOP_HOME: home,
            HELIX_DESKTOP_WORKSPACE_ROOT: workspace,
            HELIX_DESKTOP_VITE_PORT: String(vitePort),
            TMPDIR: sandbox,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        // 输出持续 drain（防管道背压），失败时随断言带出尾部诊断
        let outTail = "";
        const drain = async (s: ReadableStream<Uint8Array>) => {
          for await (const chunk of s as unknown as AsyncIterable<Uint8Array>) {
            outTail = (outTail + Buffer.from(chunk).toString()).slice(-8000);
          }
        };
        void drain(proc.stdout as ReadableStream<Uint8Array>);
        void drain(proc.stderr as ReadableStream<Uint8Array>);

        // 三进程编排起：daemon WS（壳 sidecar 链末端 = 全链就绪）+ vite HTTP
        await waitFor(() => tcpOpen(daemonPort), 300_000, `第 ${round} 轮 daemon WS 端口监听`);
        await waitFor(() => tcpOpen(vitePort), 30_000, `第 ${round} 轮 vite dev 端口监听`);
        const viteRes = await rawHttpGet(vitePort, "/");
        expect(viteRes.status).toBe(200);
        expect(await wsHello(daemonPort)).toBe(true);

        // 编排进程树快照（SIGINT 前）：脚本 + 全部后代（vite/cargo/壳/daemon）
        const tree = [proc.pid, ...collectDescendantPids(proc.pid, psEdges())];
        expect(tree.length).toBeGreaterThanOrEqual(3); // 至少 vite + cargo 链 + daemon

        // SIGINT → 优雅 teardown
        proc.kill("SIGINT");
        const code = await proc.exited;
        expect(code).toBe(0);

        // 三件套①：进程树全灭
        await waitFor(
          async () => tree.every((pid) => !alive(pid)),
          30_000,
          `第 ${round} 轮进程树全灭（残留：${tree.filter(alive).join(",")}）\n${outTail}`,
        );
        // 三件套②：端口释放
        await waitFor(async () => !(await tcpOpen(daemonPort)), 15_000, `第 ${round} 轮 daemon 端口释放`);
        await waitFor(async () => !(await tcpOpen(vitePort)), 15_000, `第 ${round} 轮 vite 端口释放`);
        // 三件套③：编排 tmp（wrapper 目录）清理
        const leftovers = readdirSync(sandbox).filter((n) => n.startsWith("helix-dev-desktop-"));
        expect(leftovers).toEqual([]);
      } finally {
        // 失败兜底：整树 SIGKILL，不污染后续轮次/本机
        if (proc !== undefined && alive(proc.pid)) {
          const tree = [proc.pid, ...collectDescendantPids(proc.pid, psEdges())];
          for (const pid of tree) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        }
        rmSync(sandbox, { recursive: true, force: true });
      }
    }
  },
  900_000,
);

// ── 边界：`bun run dev` 不受 cargo 自检影响 ─────────────────

test("bun run dev 不受影响：dev 脚本无 dev-desktop/cargo 自检耦合", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts["dev"]).toBe("bun apps/daemon/src/main.ts");
  expect(pkg.scripts["dev"]).not.toContain("dev-desktop");
  expect(pkg.scripts["dev"]).not.toContain("cargo");
  expect(pkg.scripts["dev:desktop"]).toContain("dev-desktop");
});
