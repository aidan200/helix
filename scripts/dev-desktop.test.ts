/**
 * dev-desktop 编排测试（CL-4/F4.1/F4.2；test-design §CL-4；TR-TEST-6）。
 *
 * - F4.1 前置自检：checkRustToolchain 纯函数全分支（cargo 缺/rustc 缺/
 *   齐全/全缺）+ 脚本级 PATH 净化注入 → 一行安装提示 + 非零退出 +
 *   零进程起（ps 断言）。
 * - F4.2 编排 + teardown：真起三进程（daemon bun 直跑源码经壳 sidecar
 *   wrapper + vite dev + cargo tauri dev）→ WS/HTTP 连通断言 → SIGINT →
 *   三件套零残留（进程树/端口/tmp）→ 连跑两轮零残留。
 * - W5 旋钮降级：env 未设 → 正常起编排（未绑定态）+ 提示日志；env 已设
 *   → daemon ready 后 WS 预绑定（成功日志 + workspace.get 绑定事实断言）；
 *   预绑定失败（危险根被 daemon 拒）→ 非零退出 + 整体 teardown。
 * - `bun run dev` 不受影响：根 package.json dev 脚本无 cargo 自检耦合。
 *
 * 注（AF-5）：bun test 进程内首次 Bun.spawn 有预热延迟，本文件全部等待
 * 阈值为秒级，不受影响。集成用例需本机 7333/5173 端口空闲（tauri dev
 * 会真实编译并开窗，属预期——窗口/HMR 体感为人工确认项）。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { PROTOCOL_VERSION } from "@helix/protocol";
import {
  checkRustToolchain,
  collectDescendantPids,
  parsePsTable,
  renderInstallHint,
} from "./dev-desktop";

// H-1 TDD-RED：以下 import 的符号尚未实现（先红后绿）
import { ensureRgAvailable, tauriDevArgs, TAURI_DEV_CONFIG_OVERRIDE } from "./dev-desktop";

// TDD-RED：W5 预绑定——prebindWorkspace 尚未实现（先红后绿）
import { prebindWorkspace } from "./dev-desktop";

// TDD-RED：wrapper cwd 止血 + W5 两形态——buildWrapperScript 尚未实现（先红后绿）
import { buildWrapperScript, parseDevDesktopArgs, resolveDevWorkspaceRoot } from "./dev-desktop";

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

/** WS 连通断言：token 端点取 token → hello 握手 → 必须收到 welcome
 *（W5 顺带修正：旧版 v 位便硬编码 "0.10" 且任意首帧即过——daemon 实为
 * protocol.version_unsupported 拒绝后仍判绿，假阳性；现钉 PROTOCOL_VERSION
 * 且只认 connection.welcome，connection.error 判红）。 */
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
          v: PROTOCOL_VERSION,
          type: "hello",
          id: "dev-desktop-test",
          payload: { token, protocolVersion: PROTOCOL_VERSION },
        }),
      );
    ws.onmessage = (ev: { data: unknown }) => {
      const frame = JSON.parse(String(ev.data)) as { type?: string };
      if (frame.type === "connection.welcome") {
        clearTimeout(timer);
        ws.close();
        resolve(true);
      }
      if (frame.type === "connection.error") {
        clearTimeout(timer);
        ws.close();
        resolve(false);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
}

/** WS 绑定读面：hello 握手 → workspace.get → 回执 current.root（null = 未绑定）。
 *（W5 预绑定冒烟：验证 daemon 侧绑定事实，非仅客户端日志。） */
async function wsWorkspaceBoundRoot(port: number): Promise<string | null> {
  const res = await rawHttpGet(port, "/helix-dev-token");
  if (res.status !== 200) throw new Error(`dev-token 端点 HTTP ${res.status}`);
  const token = res.body.trim();
  return await new Promise<string | null>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("workspace.get.result 超时"));
    }, 5000);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "hello",
          payload: { token, protocolVersion: PROTOCOL_VERSION },
        }),
      );
    ws.onmessage = (ev: { data: unknown }) => {
      const frame = JSON.parse(String(ev.data)) as {
        type?: string;
        payload?: { current?: { root?: string } | null; code?: string; message?: string };
      };
      // welcome 后才发命令（握手序：hello → welcome → workspace.get）
      if (frame.type === "connection.welcome") {
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "workspace.get", payload: {} }));
        return;
      }
      if (frame.type === "workspace.get.result") {
        clearTimeout(timer);
        ws.close();
        resolve(frame.payload?.current?.root ?? null);
      }
      if (frame.type === "connection.error") {
        clearTimeout(timer);
        ws.close();
        reject(
          new Error(
            `workspace.get 握手/命令被拒：${frame.payload?.code ?? "unknown"}：${frame.payload?.message ?? ""}`,
          ),
        );
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WS 连接失败（workspace.get）"));
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
    // F4.2 隐患修复：--vite-port 覆盖后 tauri dev 的 devUrl
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

// ── dev sidecar wrapper 生成（cwd 止血：exec 前 cd 预绑定根；W5 两形态）──────────

describe("buildWrapperScript（wrapper 内容纯函数：cd 在 exec 前；W5 两形态）", () => {
  const bunPath = "/usr/local/bin/bun";
  const mainTsPath = "/repo/apps/daemon/src/main.ts";
  const workspaceRoot = "/repo";

  test("有 workspaceRoot（env 已设）：shebang + cd 行 + exec 行含 mainTsPath 与 \"$@\" 尾参，不含 --home", () => {
    const script = buildWrapperScript({ bunPath, mainTsPath, workspaceRoot });
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(`cd '${workspaceRoot}'`);
    // mainTsPath 为绝对路径 → cd 不影响 exec 目标解析（TR-AD-6：拉起方设 cwd，daemon 零 argv/env）
    expect(script).toContain(`exec '${bunPath}' '${mainTsPath}'`);
    expect(script).toContain(`"$@"`);
    expect(script).not.toContain("--home");
  });

  test("有 home：exec 行注入 --home（HELIX_DESKTOP_HOME 隔离位语义不变；两形态均适用）", () => {
    const withRoot = buildWrapperScript({ bunPath, mainTsPath, workspaceRoot, home: "/tmp/hx-home" });
    expect(withRoot).toContain(`exec '${bunPath}' '${mainTsPath}' --home '/tmp/hx-home'`);
    expect(withRoot).toContain(`"$@"`);
    // W5 无根形态 + home：同样注入 --home（隔离位与预绑定根正交）
    expect(buildWrapperScript({ bunPath, mainTsPath, home: "/tmp/hx-home" })).toBe(
      `#!/bin/sh\nexec '${bunPath}' '${mainTsPath}' --home '/tmp/hx-home' "$@"\n`,
    );
  });

  test("cd 行在 exec 行之前（daemon cwd 由 wrapper 进程 exec 替换后继承）", () => {
    const script = buildWrapperScript({ bunPath, mainTsPath, workspaceRoot });
    const cdIdx = script.indexOf(`cd '${workspaceRoot}'`);
    const execIdx = script.indexOf("exec ");
    expect(cdIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(cdIdx);
  });

  test("引号/换行与模板严格一致（生成物是 shell 脚本，内容即契约；无根形态另测）", () => {
    expect(buildWrapperScript({ bunPath, mainTsPath, workspaceRoot })).toBe(
      `#!/bin/sh\ncd '${workspaceRoot}'\nexec '${bunPath}' '${mainTsPath}' "$@"\n`,
    );
  });
});

// ── dev workspace 预绑定根解析（W5 旋钮降级：传参校验 + 缺省放行两分支）──

describe("resolveDevWorkspaceRoot（W5：传参校验 / 缺省放行，全注入面）", () => {
  const exists = new Set(["/ws", "/tmp/picked"]);
  const existsDir = (p: string) => exists.has(p);

  test("显式指认且存在 → 返回 root（wrapper cd + 预绑定目标）", () => {
    expect(resolveDevWorkspaceRoot({ root: "/ws", existsDir })).toBe("/ws");
  });

  test("指认不存在 → fail-fast（显式输入错误不回退不猜测，起编排前拦截）", () => {
    expect(() => resolveDevWorkspaceRoot({ root: "/nope", existsDir })).toThrow("不存在");
    expect(() => resolveDevWorkspaceRoot({ root: "/nope", existsDir })).toThrow("--workspace-root");
  });

  test("未传 → undefined 放行（daemon 未绑定态启动，前端门禁引导）", () => {
    expect(resolveDevWorkspaceRoot({ existsDir })).toBeUndefined();
  });

  test("空白字符串 → 同未传（放行）", () => {
    expect(resolveDevWorkspaceRoot({ root: "   ", existsDir })).toBeUndefined();
  });
});

// ── argv 旋钮解析（--flag=value / --flag value 双形态 + 未知参数/缺值 fail-fast）──

describe("parseDevDesktopArgs（argv 旋钮面）", () => {
  test("空 argv → 两键缺席", () => {
    expect(parseDevDesktopArgs([])).toEqual({});
  });

  test("--flag=value 形态", () => {
    expect(parseDevDesktopArgs(["--workspace-root=/ws", "--vite-port=5174"])).toEqual({
      workspaceRoot: "/ws",
      vitePort: "5174",
    });
  });

  test("--flag value 分词形态", () => {
    expect(parseDevDesktopArgs(["--workspace-root", "/ws", "--vite-port", "5174"])).toEqual({
      workspaceRoot: "/ws",
      vitePort: "5174",
    });
  });

  test("未知参数 → fail-fast（不静默吞掉拼错的旋钮）", () => {
    expect(() => parseDevDesktopArgs(["--workspace-rooot=/ws"])).toThrow("未知参数");
  });

  test("缺值 → fail-fast", () => {
    expect(() => parseDevDesktopArgs(["--vite-port"])).toThrow("缺值");
  });
});

// ── W5 WS 预绑定编排（纯注入面：成功/超时/校验错三分支）──────────

describe("prebindWorkspace（W5 预绑定：端口可达→读 token→workspace.open）", () => {
  test("成功：三步顺序执行（waitPort→readToken→open），open 参数透传 root/token/port", async () => {
    const order: string[] = [];
    let openParams: { port: number; token: string; root: string; timeoutMs: number } | undefined;
    await prebindWorkspace({
      root: "/ws",
      port: 7333,
      waitPortReachable: async () => {
        order.push("port");
      },
      readToken: async () => {
        order.push("token");
        return "tok";
      },
      openWorkspace: async (p) => {
        order.push("open");
        openParams = p;
      },
      timeoutMs: 1000,
    });
    expect(order).toEqual(["port", "token", "open"]);
    expect(openParams).toEqual({ port: 7333, token: "tok", root: "/ws", timeoutMs: 1000 });
  });

  test("超时：端口永不可达 → 整体超时兑底拒绝（注入短超时，不真等 15s）", async () => {
    const t0 = Date.now();
    await expect(
      prebindWorkspace({
        root: "/ws",
        port: 7333,
        waitPortReachable: () => new Promise<void>(() => {}), // 永不 resolve
        readToken: async () => "tok",
        openWorkspace: async () => {},
        timeoutMs: 100,
      }),
    ).rejects.toThrow("预绑定超时");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("校验错：workspace.open 被 daemon 拒（WORKSPACE_E_INVALID_ROOT）→ 错误透传", async () => {
    await expect(
      prebindWorkspace({
        root: "/",
        port: 7333,
        waitPortReachable: async () => {},
        readToken: async () => "tok",
        openWorkspace: async () => {
          throw new Error("WORKSPACE_E_INVALID_ROOT：文件系统根为危险根");
        },
      }),
    ).rejects.toThrow("WORKSPACE_E_INVALID_ROOT");
  });

  test("dev-token 空文件 → 抛错且不发起 WS（token 是握手必需凭证）", async () => {
    let opened = false;
    await expect(
      prebindWorkspace({
        root: "/ws",
        port: 7333,
        waitPortReachable: async () => {},
        readToken: async () => "  ",
        openWorkspace: async () => {
          opened = true;
        },
      }),
    ).rejects.toThrow("dev-token");
    expect(opened).toBe(false);
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
      // W5：env 不再必需——PATH 净化路径不带 workspace env 仍应走到自检
      const proc = Bun.spawn({
        cmd: [process.execPath, SCRIPT],
        cwd: root,
        env: { PATH: emptyPath },
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
      // 经 <home>/config.json 既有配置面注入，vite 端口经 --vite-port argv
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
          cmd: [
            process.execPath,
            SCRIPT,
            `--workspace-root=${workspace}`,
            `--vite-port=${vitePort}`,
          ],
          cwd: root,
          env: {
            ...process.env,
            HELIX_DESKTOP_HOME: home,
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

        // W5 预绑定冒烟（env 已设路径）：成功日志 + daemon 侧绑定事实
        //（workspace.get 回执 current.root = realpath 规范形——macOS tmpdir
        // 有 /var → /private/var symlink，须 realpathSync 对齐）
        await waitFor(
          () => Promise.resolve(outTail.includes("workspace 预绑定成功")),
          15_000,
          `第 ${round} 轮 workspace 预绑定成功日志\n${outTail}`,
        );
        expect(await wsWorkspaceBoundRoot(daemonPort)).toBe(realpathSync(workspace));

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

// ── W5：env 未设 → 未绑定态正常起编排（提示日志 + UI 门禁引导语义）──

test(
  "W5 未传 --workspace-root → 正常起编排（提示日志）+ SIGINT 优雅 teardown（无预绑定）",
  async () => {
    const vitePort = await freePort();
    const sandbox = mkdtempSync(join(tmpdir(), "helix-dev-desktop-unbound-"));
    const home = join(sandbox, "home"); // TR-TEST-4：真实 ~/.helix 零触碰
    mkdirSync(home, { recursive: true });
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        HELIX_DESKTOP_HOME: home,
        // --workspace-root 故意不传——W5 旋钮降级：不再 fail-fast
        TMPDIR: sandbox,
      };
      proc = Bun.spawn({
        cmd: [process.execPath, SCRIPT, `--vite-port=${vitePort}`],
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      let outTail = "";
      const drain = async (s: ReadableStream<Uint8Array>) => {
        for await (const chunk of s as unknown as AsyncIterable<Uint8Array>) {
          outTail = (outTail + Buffer.from(chunk).toString()).slice(-8000);
        }
      };
      void drain(proc.stdout as ReadableStream<Uint8Array>);
      void drain(proc.stderr as ReadableStream<Uint8Array>);

      // 提示日志（①自检后）：未传 → 未绑定态启动，前端门禁引导
      await waitFor(
        () => Promise.resolve(outTail.includes("未传 --workspace-root")),
        60_000,
        `未传提示日志\n${outTail}`,
      );
      expect(outTail).toContain("daemon 未绑定态启动");

      // 正常起编排：vite 端口监听（直接子进程；不依赖 cargo 编译完成）
      await waitFor(() => tcpOpen(vitePort), 120_000, "未传参不阻塞编排（vite dev 监听）");

      // SIGINT → 优雅退出（未绑定态无预绑定动作日志——提示文案本身含“预绑定”字样不算）
      expect(outTail).not.toContain("workspace 预绑定");
      proc.kill("SIGINT");
      expect(await proc.exited).toBe(0);
      await waitFor(async () => !(await tcpOpen(vitePort)), 15_000, "vite 端口释放");
    } finally {
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
  },
  300_000,
);

// ── W5：--workspace-root 已传但目录不存在 → 起编排前 fail-fast（现状保留）─

test(
  "W5 --workspace-root 目录不存在 → 起编排前 fail-fast（非零退出 + 零进程起）",
  async () => {
    const emptyPath = mkdtempSync(join(tmpdir(), "helix-dev-desktop-nopath-"));
    const before = orchestrationPids();
    try {
      const proc = Bun.spawn({
        cmd: [process.execPath, SCRIPT, `--workspace-root=${join(emptyPath, "no-such-dir")}`],
        cwd: root,
        env: { PATH: emptyPath },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(code).toBe(1); // 非零退出
      expect(out + err).toContain("--workspace-root");
      expect(out + err).toContain("不存在");
      // 零进程起：编排特征进程集合无新增
      const after = orchestrationPids();
      expect([...after].filter((pid) => !before.has(pid))).toEqual([]);
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  },
  30_000,
);

// ── W5：预绑定失败（daemon 校验拒危险根）→ 非零退出 + 整体 teardown ──

test(
  "W5 预绑定失败（危险根被 daemon 拒）→ 非零退出 + daemon 端口释放",
  async () => {
    // daemon 危险根 = 文件系统根 / 用户主目录（WorkspaceService §3.3）——
    // 用真实 homedir() 作传参值：目录存在（过编排侧校验）但 daemon open
    // 拒绝 → WORKSPACE_E_INVALID_ROOT 回执 → 预绑定失败非零退出
    const daemonPort = await freePort();
    const vitePort = await freePort();
    const sandbox = mkdtempSync(join(tmpdir(), "helix-dev-desktop-prebind-fail-"));
    const home = join(sandbox, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: daemonPort }));
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      proc = Bun.spawn({
        cmd: [
          process.execPath,
          SCRIPT,
          `--workspace-root=${homedir()}`,
          `--vite-port=${vitePort}`,
        ],
        cwd: root,
        env: {
          ...process.env,
          HELIX_DESKTOP_HOME: home,
          TMPDIR: sandbox,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const combined = out + err;
      expect(code).toBe(1); // 预绑定失败 → 非零退出（fail-fast 精神保留）
      expect(combined).toContain("workspace 预绑定失败");
      expect(combined).toContain("WORKSPACE_E_INVALID_ROOT");
      expect(combined).toContain("整体 teardown");
      // teardown 有效性：daemon 端口随进程树全灭释放
      await waitFor(async () => !(await tcpOpen(daemonPort)), 30_000, "daemon 端口释放");
      const leftovers = readdirSync(sandbox).filter((n) => n.startsWith("helix-dev-desktop-"));
      expect(leftovers).toEqual([]);
    } finally {
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
  },
  600_000,
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
