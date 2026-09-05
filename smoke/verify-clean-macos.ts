#!/usr/bin/env bun
/**
 * verify-clean-macos —— CL-1 干净机零依赖冒烟（T3.3，AD-5/F1.3/F1.4）。
 *
 * 对 T3.2 产出的真 .app 产物做零依赖冒烟（脚本 + 退出码，不经测试运行器）。
 * 「干净 macOS 等效沙箱」的机械判据（brief 决策消解）：`/usr/bin/env -i`
 * 净化环境启动——PATH 仅系统最小集（无 Bun/rg/node），HOME 指向 mkdtemp
 * （daemon home 落 tmp，零触碰真实 ~/.helix，TR-TEST-4）。CI 无法提供裸机
 * 为已知边界（test-design 可测试性检查②已登记）。
 *
 * 断言项（逐项 ✓/✗，任一 ✗ → 非零退出）：
 * 1. layout.rg       资源布局：Contents/Resources/bin/rg 存在且 lipo=arm64；
 * 2. layout.daemon   externalBin daemon 单文件存在（Contents/MacOS/helix-daemon*）
 *                    + 主 exe helix-shell 存在；
 * 3. env.selfcheck   净化自检：遮蔽 env 内 rg/bun/node 均不可达（证明遮蔽生效）；
 * 4. launch.handshake 遮蔽启动：env -i 起 app → 端口监听 + GET /helix-dev-token
 *                    + WS hello→welcome（AF-3 连接面：config 端口 + dev-token 端点）；
 * 5. grep.bundle     包内 rg 命中：遮蔽 env 下经 WS chat.send 驱动一次真实 grep
 *                    检索（假 LLM SSE server 回 tool_use(grep)，T2.2 既有模式），
 *                    tool.call.result 命中 + daemon 定格日志 source=bundle（AF-1
 *                    观测面，不靠猜）；
 * 6. watchdog.sigkill SIGKILL sidecar → 壳看护重启恢复（新 pid、父=壳、端口重听）
 *                    → WS 重连 welcome（F1.4）；
 * 7. grep.unavailable 响亮失败：重启前使包内 rg 不可执行（chmod 000）→ 重启后
 *                    定格日志「grep 后端定格 unavailable」+ 同一检索返回
 *                    「grep 工具不可用」响亮失败文案（rg 单后端，无 TS 降级）；
 * 8. residue.zero    零残留（TR-TEST-6）：壳/守护进程树清零 + 端口释放 + tmp 删除
 *                    + 包内 rg 权限复原。
 *
 * 人工验证项（脚本不做，写入报告验收清单）：右键打开绕过 Gatekeeper（GUI 人工
 * 交互）；真·干净 macOS 裸机双击体验（发布检查项）。
 *
 * 驱动链说明（grep 探针非手工模拟）：WS chat.send(draft) → 主引擎 turn →
 * 引擎 tool_use(grep) → CoreToolExecutor → GrepTool 门面（AF-1 定格后端）→
 * tool.call.result 帧断言。主引擎 LLM = 本地假 Anthropic SSE server（127.0.0.1
 * 回环，models-store.json overlay 注入自定义 baseUrl 模型 + auth.set_key 录
 * 假 key——T2.2 已验证的全真实注入面组合，零新增生产面）。
 *
 * 用法：
 *   bun smoke/verify-clean-macos.ts [--app <helix.app 路径>] [--report <path>]
 *                                   [--sanitized-path <PATH>] [--keep-tmp]
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@helix/protocol";

const root = join(import.meta.dir, "..");
const DEFAULT_APP = join(root, "apps/shell/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/helix.app");
const DEFAULT_REPORT = join(root, "docs/iterations/iter-20260822-m1uc/evidence/CL-1-smoke.md");
/** 净化 PATH 缺省值：系统最小集（无 Bun/rg/node——干净机等效判据）。 */
const DEFAULT_SANITIZED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** 默认模型（model-provider DEFAULT_MODEL_ID 同源：builtin 兜底位）。 */
const DEFAULT_MODEL = { provider: "anthropic", id: "claude-sonnet-4-5" };
/** 检索夹具唯一 token（结果断言锚点）。 */
const SEARCH_TOKEN = "HELIX_CL1_SMOKE_TOKEN";
/** ready/端口等待上限（真机首次启动 WebView 初始化可能偏慢）。 */
const LAUNCH_TIMEOUT_MS = 45_000;
/** 看护重启等待上限（握手 15s 契约上限 + 余量）。 */
const RESTART_TIMEOUT_MS = 45_000;
/** 单轮 grep 探针全链超时。 */
const PROBE_TIMEOUT_MS = 60_000;

// ── argv ────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APP_PATH = argValue("--app") ?? DEFAULT_APP;
const REPORT_PATH = argValue("--report") ?? DEFAULT_REPORT;
const SANITIZED_PATH = argValue("--sanitized-path") ?? DEFAULT_SANITIZED_PATH;
const KEEP_TMP = process.argv.includes("--keep-tmp");

// ── 检查结果模型 ─────────────────────────────────────────────

interface CheckOutcome {
  readonly id: string;
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}
const checks: CheckOutcome[] = [];
function record(id: string, name: string, pass: boolean, detail: string): void {
  checks.push({ id, name, pass, detail });
  console.log(`  ${pass ? "✓" : "✗"} [${id}] ${detail}`);
}
/** 任一 ✗ → 非零退出（brief 失败语义）。 */
const anyFail = (): boolean => checks.some((c) => !c.pass);

// ── 假 Anthropic SSE server（grep 探针主引擎 LLM 替身） ──────
//
// 协议面 = anthropic-messages SSE（pi-ai streamSimple 真实解析链）：不含
// tool_result 的请求 → tool_use(grep, {pattern, path})；含 tool_result 的
// 请求（工具结果回灌轮）→ 文本收尾（防无限工具循环，tool_use 计数兜底）。

function sseFrame(events: readonly { event: string; data: unknown }[]): Response {
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function messageStart() {
  return {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_smoke",
        type: "message",
        role: "assistant",
        content: [],
        model: DEFAULT_MODEL.id,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 16, output_tokens: 1 },
      },
    },
  };
}

function messageStop(stopReason: "tool_use" | "end_turn") {
  return [
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 8 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

function grepToolUseResponse(pattern: string, path: string): Response {
  return sseFrame([
    messageStart(),
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_smoke_1", name: "grep", input: {} },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ pattern, path }) },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    ...messageStop("tool_use"),
  ]);
}

function textResponse(text: string): Response {
  return sseFrame([
    messageStart(),
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    ...messageStop("end_turn"),
  ]);
}

interface FakeLlm {
  readonly port: number;
  stop(): void;
}

function startFakeLlm(grepArgs: { pattern: string; path: string }): FakeLlm {
  let toolUseCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = (await req.json().catch(() => ({}))) as {
        messages?: { content?: unknown }[];
      };
      const hasToolResult = (body.messages ?? []).some(
        (m) =>
          Array.isArray(m.content) &&
          (m.content as { type?: string }[]).some((b) => b.type === "tool_result"),
      );
      if (!hasToolResult && toolUseCount < 3) {
        toolUseCount += 1;
        return grepToolUseResponse(grepArgs.pattern, grepArgs.path);
      }
      return textResponse("冒烟检索已回传，无需进一步动作。");
    },
  });
  return { port: server.port ?? 0, stop: () => server.stop(true) };
}

/** models-store.json overlay 注入（T2.2 既有模式：同 id 全字段替换 builtin，
 *  baseUrl 指向本地假 server；真实文件注入面，非进程内白盒）。 */
function seedModelsStore(home: string, baseUrl: string): void {
  const overlay = {
    id: DEFAULT_MODEL.id,
    name: "CL-1 Smoke Model",
    api: "anthropic-messages",
    provider: DEFAULT_MODEL.provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
  writeFileSync(
    join(home, "models-store.json"),
    JSON.stringify({
      version: 1,
      providers: {
        [DEFAULT_MODEL.provider]: { models: [overlay], lastModified: Date.now(), checkedAt: Date.now() },
      },
    }),
  );
}

// ── WS 探针客户端 ────────────────────────────────────────────

interface Frame {
  readonly type?: string;
  readonly payload?: unknown;
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
    const hit = this.frames.findIndex(pred);
    if (hit >= 0) {
      const [f] = this.frames.splice(hit, 1);
      return Promise.resolve(f!);
    }
    return new Promise<Frame>((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === wrapped);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`等待帧超时（${timeoutMs}ms）`));
      }, timeoutMs);
      const wrapped = (f: Frame) => {
        clearTimeout(t);
        resolve(f);
      };
      this.waiters.push({ pred, resolve: wrapped });
    });
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* 已关闭 */
    }
  }
}

// ── 工具 ────────────────────────────────────────────────────

function freePort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = s.port ?? 0;
  s.stop(true);
  return port;
}

async function waitUntil(pred: () => Promise<boolean> | boolean, timeoutMs: number, stepMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

/** GET /helix-dev-token（连接面 AF-3）；未就绪返回 undefined。 */
async function fetchToken(port: number): Promise<string | undefined> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/helix-dev-token`);
    if (!resp.ok) return undefined;
    const token = (await resp.text()).trim();
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 壳进程的 helix-daemon 直接子进程 pid 集（ps 快照解析，ppid 精确归口）。 */
function daemonChildrenOf(shellPid: number): number[] {
  const out = Bun.spawnSync({ cmd: ["ps", "-axo", "pid=,ppid=,comm="] }).stdout.toString();
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    if (m === null) continue;
    if (Number(m[2]) === shellPid && m[3]!.endsWith("helix-daemon")) pids.push(Number(m[1]));
  }
  return pids;
}

// ── 阶段 1：资源布局断言 ─────────────────────────────────────

function checkLayout(): { rgPath: string; shellExe: string } | undefined {
  const macosDir = join(APP_PATH, "Contents/MacOS");
  const rgPath = join(APP_PATH, "Contents/Resources/bin/rg");
  const shellExe = join(macosDir, "helix-shell");

  // 1. rg 存在 + lipo arm64
  if (!existsSync(rgPath)) {
    record("layout.rg", "包内 rg 布局", false, `缺失项：Contents/Resources/bin/rg（${APP_PATH} 内不存在）`);
    return undefined;
  }
  const lipo = Bun.spawnSync({ cmd: ["lipo", "-info", rgPath] });
  const lipoOut = (lipo.stdout.toString() + lipo.stderr.toString()).trim();
  if (lipo.exitCode !== 0 || !lipoOut.includes("arm64")) {
    record("layout.rg", "包内 rg 布局", false, `lipo -info 非 arm64：${lipoOut}`);
    return undefined;
  }
  record("layout.rg", "包内 rg 布局", true, `Contents/Resources/bin/rg 存在；lipo -info = ${lipoOut}`);

  // 2. externalBin daemon 单文件 + 主 exe
  const entries = existsSync(macosDir) ? readdirSync(macosDir) : [];
  const daemons = entries.filter((e) => e.startsWith("helix-daemon"));
  if (daemons.length !== 1 || !existsSync(shellExe)) {
    record(
      "layout.daemon",
      "externalBin 布局",
      false,
      `Contents/MacOS 期望主 exe helix-shell + 单文件 helix-daemon*，实际：${entries.join(", ") || "(目录缺失)"}`,
    );
    return undefined;
  }
  record(
    "layout.daemon",
    "externalBin 布局",
    true,
    `Contents/MacOS/helix-shell（主 exe）+ ${daemons[0]}（externalBin 单文件）`,
  );
  return { rgPath, shellExe };
}

// ── 阶段 2：净化自检（遮蔽生效的机械判据） ───────────────────

function checkSanitizer(): boolean {
  const reachable: string[] = [];
  for (const bin of ["rg", "bun", "node"]) {
    const r = Bun.spawnSync({
      cmd: ["/usr/bin/env", "-i", `PATH=${SANITIZED_PATH}`, "/bin/sh", "-c", `command -v ${bin}`],
    });
    if (r.exitCode === 0) reachable.push(`${bin}=${r.stdout.toString().trim()}`);
  }
  if (reachable.length > 0) {
    record("env.selfcheck", "净化自检", false, `遮蔽 env 内仍可触达：${reachable.join("；")}（净化未生效）`);
    return false;
  }
  record(
    "env.selfcheck",
    "净化自检",
    true,
    `env -i PATH=${SANITIZED_PATH} 内 rg/bun/node 均不可达（command -v 全非零）`,
  );
  return true;
}

// ── 阶段 3-7：遮蔽启动 → 检索 → 看护 → 响亮失败 ─────────────────

interface RunContext {
  readonly tmp: string;
  readonly home: string;
  readonly port: number;
  readonly rgPath: string;
  readonly rgMode: number;
  shell: ReturnType<typeof Bun.spawn> | undefined;
  shellStderrTail: string;
  ws: WsProbe | undefined;
  fake: FakeLlm | undefined;
}

/** 一次真实 grep 检索探针：auth.set_key + chat.send → tool.call.result 命中断言。 */
async function grepProbe(ws: WsProbe, searchDir: string): Promise<string> {
  ws.send("auth.set_key", { providerId: DEFAULT_MODEL.provider, apiKey: "smoke-fake-key" });
  await ws.waitFor((f) => f.type === "auth.set_key.result" || f.type === "connection.error", 10_000);
  ws.send("chat.send", { text: "请用 grep 工具检索指定内容", draft: true });
  const resultFrame = await ws.waitFor(
    (f) =>
      f.type === "tool.call.result" &&
      (f.payload as { entry?: { name?: string } }).entry?.name === "grep",
    PROBE_TIMEOUT_MS,
  );
  const entry = (resultFrame.payload as { entry?: { state?: string; result?: string } }).entry;
  if (entry?.state !== "done") {
    throw new Error(`grep 工具结果非 done：state=${entry?.state} result=${entry?.result ?? "(无)"}`);
  }
  const result = entry.result ?? "";
  if (!result.includes(SEARCH_TOKEN) || !result.includes("notes.txt")) {
    throw new Error(`grep 结果未命中夹具：${result.slice(0, 200)}（检索目录 ${searchDir}）`);
  }
  return result.split("\n")[0]!;
}

/** 响亮失败探针：chat.send → grep tool.call.result 返回「grep 工具不可用」文案。 */
async function grepProbeExpectUnavailable(ws: WsProbe): Promise<string> {
  ws.send("auth.set_key", { providerId: DEFAULT_MODEL.provider, apiKey: "smoke-fake-key" });
  await ws.waitFor((f) => f.type === "auth.set_key.result" || f.type === "connection.error", 10_000);
  ws.send("chat.send", { text: "请用 grep 工具检索指定内容", draft: true });
  const resultFrame = await ws.waitFor(
    (f) =>
      f.type === "tool.call.result" &&
      (f.payload as { entry?: { name?: string } }).entry?.name === "grep",
    PROBE_TIMEOUT_MS,
  );
  const entry = (resultFrame.payload as { entry?: { state?: string; result?: string } }).entry;
  const result = entry?.result ?? "";
  if (!result.includes("grep 工具不可用")) {
    throw new Error(`grep 未返回响亮失败文案：state=${entry?.state} result=${result.slice(0, 200)}`);
  }
  return result.split("\n")[0]!;
}

async function runSmoke(layout: { rgPath: string; shellExe: string }): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "helix-cl1-smoke-"));
  const home = join(tmp, "home", ".helix"); // os.homedir()=HOME → daemon home（AG-07 单点展开）
  const searchDir = join(tmp, "search-root");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(tmp, "tmp"), { recursive: true });
  mkdirSync(searchDir, { recursive: true });
  writeFileSync(join(searchDir, "notes.txt"), `${SEARCH_TOKEN} 第一行命中\n第二行噪音\n`);

  const port = freePort();
  writeFileSync(join(home, "config.json"), JSON.stringify({ port }));
  const fake = startFakeLlm({ pattern: SEARCH_TOKEN, path: searchDir });
  seedModelsStore(home, `http://127.0.0.1:${fake.port}`);

  const ctx: RunContext = {
    tmp,
    home,
    port,
    rgPath: layout.rgPath,
    rgMode: statSync(layout.rgPath).mode,
    shell: undefined,
    shellStderrTail: "",
    ws: undefined,
    fake,
  };
  const daemonLog = (): string => {
    try {
      return Bun.spawnSync({ cmd: ["cat", join(home, "logs/daemon.log")] }).stdout.toString();
    } catch {
      return "";
    }
  };

  try {
    // ── 4. 遮蔽启动（env -i 字面构造：PATH 无 Bun/rg/node，HOME→tmp） ──
    ctx.shell = Bun.spawn({
      cmd: [
        "/usr/bin/env",
        "-i",
        `HOME=${join(tmp, "home")}`,
        `PATH=${SANITIZED_PATH}`,
        `TMPDIR=${join(tmp, "tmp")}`,
        "LANG=en_US.UTF-8",
        layout.shellExe,
      ],
      cwd: tmp,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    // 壳 stderr（sidecar 日志转发面）持续排空，留尾行作失败诊断
    void (async () => {
      const reader = (ctx.shell!.stderr as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          ctx.shellStderrTail = (ctx.shellStderrTail + dec.decode(value)).slice(-2000);
        }
      } catch {
        /* 进程已退出 */
      }
    })();
    void (async () => {
      const reader = (ctx.shell!.stdout as ReadableStream<Uint8Array>).getReader();
      try {
        while (!(await reader.read()).done) {
          /* drain */
        }
      } catch {
        /* 进程已退出 */
      }
    })();

    const token = await waitUntil(async () => fetchToken(port), LAUNCH_TIMEOUT_MS).then(async (ok_) => {
      if (!ok_) return undefined;
      return fetchToken(port);
    });
    if (token === undefined) {
      record(
        "launch.handshake",
        "遮蔽启动握手",
        false,
        `env -i 启动后 ${LAUNCH_TIMEOUT_MS / 1000}s 内 /helix-dev-token 未就绪；壳 stderr 尾：${ctx.shellStderrTail.slice(-300)}`,
      );
      return;
    }
    ctx.ws = new WsProbe();
    const welcome = await ctx.ws.connect(`ws://127.0.0.1:${port}`, token, 10_000);
    if (welcome.type !== "connection.welcome") {
      record("launch.handshake", "遮蔽启动握手", false, `握手回执非 welcome：${JSON.stringify(welcome.payload)}`);
      return;
    }
    record(
      "launch.handshake",
      "遮蔽启动握手",
      true,
      `env -i（PATH 无 Bun/rg）起 app → 端口 ${port} 监听 + /helix-dev-token 取 token + WS hello→welcome`,
    );

    // ── 5. 包内 rg 命中（检索可用 + 定格日志 source=bundle） ──
    try {
      const firstLine = await grepProbe(ctx.ws, searchDir);
      const log = daemonLog();
      if (!log.includes("source=bundle")) {
        throw new Error(`定格日志未见 source=bundle（日志尾：${log.slice(-300)}）`);
      }
      record(
        "grep.bundle",
        "包内 rg 命中",
        true,
        `遮蔽 env 下检索命中（${firstLine}）+ daemon 定格日志「grep 后端定格 rg（source=bundle）」`,
      );
    } catch (err) {
      record("grep.bundle", "包内 rg 命中", false, (err as Error).message);
      return;
    }

    // ── 6+7. 使包内 rg 不可执行 → SIGKILL sidecar → 看护重启 → 响亮失败 ──
    const shellPid = ctx.shell.pid;
    const oldDaemons = daemonChildrenOf(shellPid);
    if (oldDaemons.length !== 1) {
      record("watchdog.sigkill", "SIGKILL 看护", false, `未定位唯一 daemon 子进程（ppid=${shellPid}）：${oldDaemons}`);
      return;
    }
    chmodSync(ctx.rgPath, 0o000); // 响亮失败注入：包内 rg 不可执行（finally 复原）
    process.kill(oldDaemons[0]!, "SIGKILL");

    const restarted = await waitUntil(() => {
      const now = daemonChildrenOf(shellPid);
      return now.length === 1 && now[0] !== oldDaemons[0] && pidAlive(now[0]!);
    }, RESTART_TIMEOUT_MS);
    const newToken = restarted
      ? await waitUntil(async () => fetchToken(port), RESTART_TIMEOUT_MS).then(async (ok_) =>
          ok_ ? fetchToken(port) : undefined,
        )
      : undefined;
    if (!restarted || newToken === undefined) {
      record(
        "watchdog.sigkill",
        "SIGKILL 看护",
        false,
        `SIGKILL 后 ${RESTART_TIMEOUT_MS / 1000}s 内看护未恢复（restarted=${restarted}）；壳 stderr 尾：${ctx.shellStderrTail.slice(-300)}`,
      );
      return;
    }
    ctx.ws.close();
    ctx.ws = new WsProbe();
    const welcome2 = await ctx.ws.connect(`ws://127.0.0.1:${port}`, newToken, 10_000);
    if (welcome2.type !== "connection.welcome") {
      record("watchdog.sigkill", "SIGKILL 看护", false, `重连握手回执非 welcome：${JSON.stringify(welcome2.payload)}`);
      return;
    }
    const newPid = daemonChildrenOf(shellPid)[0]!;
    record(
      "watchdog.sigkill",
      "SIGKILL 看护",
      true,
      `SIGKILL daemon(pid=${oldDaemons[0]}) → 壳看护重启新 daemon(pid=${newPid}，父=壳 ${shellPid}) → 端口重听 + 新 token WS 重连 welcome（F1.4）`,
    );

    // 7. 响亮失败：定格日志翻「unavailable」+ 同一检索返回「grep 工具不可用」文案
    try {
      const log = daemonLog();
      if (!log.includes("grep 后端定格 unavailable")) {
        throw new Error(`定格日志未见「unavailable」行（日志尾：${log.slice(-300)}）`);
      }
      const errLine = await grepProbeExpectUnavailable(ctx.ws);
      record(
        "grep.unavailable",
        "响亮失败",
        true,
        `包内 rg chmod 000 → 重启定格日志「grep 后端定格 unavailable」+ 同一检索响亮失败（${errLine}）`,
      );
    } catch (err) {
      record("grep.unavailable", "响亮失败", false, (err as Error).message);
      return;
    }
  } finally {
    // ── 8. 零残留（TR-TEST-6）：先 SIGKILL 壳（断看护重启链）→ SIGTERM→
    //    SIGKILL daemon → 进程/端口/tmp 三清 + 包内 rg 权限复原 ──
    const shellPid = ctx.shell?.pid;
    const daemonPids = shellPid !== undefined ? daemonChildrenOf(shellPid) : [];
    ctx.ws?.close();
    if (shellPid !== undefined && pidAlive(shellPid)) {
      try {
        process.kill(shellPid, "SIGKILL"); // 壳无 SIGTERM 优雅面；先杀壳防看护再拉起 daemon
      } catch {
        /* 已退出 */
      }
    }
    for (const pid of daemonPids) {
      if (!pidAlive(pid)) continue;
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* 已退出 */
      }
    }
    await waitUntil(() => daemonPids.every((p) => !pidAlive(p)), 5_000);
    for (const pid of daemonPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
    fake.stop();
    try {
      chmodSync(ctx.rgPath, ctx.rgMode); // 包内 rg 权限复原（连跑第二轮前置）
    } catch {
      /* 布局阶段失败时未 chmod */
    }

    const procsGone =
      (shellPid === undefined || !pidAlive(shellPid)) && daemonPids.every((p) => !pidAlive(p));
    const portClosed = (await fetchToken(ctx.port)) === undefined;
    let tmpRemoved = true;
    if (KEEP_TMP) {
      console.log(`  ▶ tmp 保留（--keep-tmp）：${tmp}`);
    } else {
      rmSync(tmp, { recursive: true, force: true });
      tmpRemoved = !existsSync(tmp);
    }
    record(
      "residue.zero",
      "零残留",
      procsGone && portClosed && tmpRemoved,
      `进程树清零=${procsGone}（壳 ${shellPid ?? "?"} + daemon ${daemonPids.join("/") || "?"}）；` +
        `端口 ${ctx.port} 释放=${portClosed}；tmp ${KEEP_TMP ? "保留" : `删除=${tmpRemoved}`}；包内 rg 权限已复原`,
    );
  }
}

// ── 报告 ────────────────────────────────────────────────────

function renderReport(): string {
  const lines: string[] = [
    "# CL-1 干净机零依赖冒烟报告",
    "",
    `> 迭代: iter-20260822-m1uc ｜ 任务: T3.3 ｜ 生成: ${new Date().toISOString()}`,
    `> 脚本: smoke/verify-clean-macos.ts（不经测试运行器，退出码语义）`,
    `> 产物: ${APP_PATH}`,
    "",
    "## 冒烟断言逐项结果",
    "",
    "| # | 断言项 | 结果 | 证据 |",
    "|---|---|---|---|",
  ];
  checks.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${c.id}（${c.name}） | ${c.pass ? "✓" : "✗"} | ${c.detail.replaceAll("|", "\\|")} |`);
  });
  lines.push(
    "",
    "## 干净机等效判据（brief 决策消解）",
    "",
    `- 机械判据 = /usr/bin/env -i 净化环境启动：PATH=${SANITIZED_PATH}（无 Bun/rg/node，`,
    "  env.selfcheck 项机械断言遮蔽生效）+ HOME 指向 mkdtemp（daemon home 全程落 tmp，",
    "  零触碰真实 ~/.helix）+ 包内资源断言（layout.* 两项）。",
    "- 已知边界：CI 无法提供真·干净 macOS 裸机（test-design 可测试性检查②已登记）→",
    "  裸机双击体验列下方人工验证项。",
    "",
    "## 人工验证项（脚本不自动化，验收清单登记）",
    "",
    "- [ ] 右键打开绕过 Gatekeeper：ad-hoc 签名 .app 经 Finder 右键→打开 可绕过",
    "  Gatekeeper 拦截正常启动（GUI 人工交互，发布前人工验证）。",
    "- [ ] 真·干净 macOS 裸机双击体验：无 Bun/rg/开发工具的裸机上双击 .app 全链路",
    "  可用（发布检查项，需裸机环境，本迭代 CI/本机不等效）。",
    "",
    "## 观测面与驱动链（非手工模拟的机械判据落实）",
    "",
    "- 包内 rg 命中观测面 = daemon 定格日志（AF-1：装配层一次性 resolve+探针，日志行",
    "  「grep 后端定格 rg（source=bundle）」）+ 一次真实检索的 tool.call.result 帧；不靠猜。",
    "- 响亮失败观测面 = 定格日志「grep 后端定格 unavailable」行 + 同一检索返回「grep 工具不可用」文案。",
    "- 检索驱动链全真实面：WS auth.set_key（录假 key）→ chat.send(draft) → 主引擎 turn",
    "  → tool_use(grep) → CoreToolExecutor → GrepTool 门面 → tool.call.result。主引擎 LLM",
    "  = 127.0.0.1 回环假 Anthropic SSE server（models-store.json overlay 注入 baseUrl，",
    "  T2.2 既有模式复用，零新增生产面）。",
    "- 看护断言 = SIGKILL sidecar 后 ps 快照验证新 daemon pid（父=壳）+ 端口重听 + 新",
    "  token WS 重连 welcome（F1.4）。",
    "",
    "## 运行环境",
    "",
    `- bun: ${Bun.version}（仅冒烟脚本自身使用；被测 app 全程 env -i 无 Bun）`,
    `- 平台: ${process.platform}/${process.arch}（AD-6 目标 arm64）`,
  );
  if (existsSync(APP_PATH)) {
    lines.push(`- 净化 PATH: ${SANITIZED_PATH}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ── main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("▶ CL-1 干净机零依赖冒烟（T3.3）");
  if (!existsSync(APP_PATH)) {
    console.error(`✗ .app 产物不存在：${APP_PATH}（先跑 bun scripts/build-desktop.ts，T3.2）`);
    process.exit(2);
  }

  // 阶段 1-2：布局 + 净化自检（失败即中断——产物残缺/遮蔽失效时后续无意义）
  const layout = checkLayout();
  const sanitized = checkSanitizer();
  if (layout !== undefined && sanitized) {
    // 阶段 3-8：遮蔽启动 → 检索 → 看护 → 响亮失败 → 零残留
    await runSmoke(layout);
  }

  const report = renderReport();
  mkdirSync(join(REPORT_PATH, ".."), { recursive: true });
  writeFileSync(REPORT_PATH, report);
  console.log(`▶ 冒烟记录已落盘：${REPORT_PATH}`);

  if (anyFail()) {
    console.error(`✗ CL-1 冒烟失败（${checks.filter((c) => !c.pass).length} 项 ✗ → 非零退出）`);
    process.exit(1);
  }
  console.log(`✓ CL-1 冒烟通过：${checks.length} 项断言全 ✓`);
}

await main();
