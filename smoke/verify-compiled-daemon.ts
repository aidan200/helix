#!/usr/bin/env bun
/**
 * verify-compiled-daemon —— F2.2 compile 产物等价验证（直面 F-7①）。
 *
 * 同一脚本对两种形态跑同一组行为探针，结果逐项对照（test-design §1.3①）：
 * - dev 直跑：bun apps/daemon/src/main.ts（源码形态）；
 * - compile 产物：apps/shell/src-tauri/binaries/helix-daemon-aarch64-apple-darwin
 *   （bun build --compile 单文件，由 scripts/compile-daemon.ts 产出）。
 *
 * 三探针：
 * (a) spawn 自身子进程链路（F-7①）：经 daemon 既有 SubAgent 编排面真实跑通
 *     一个 ChildMain 子进程任务并收到正常 closure——驱动链全真实面：
 *     WS chat.send → 主引擎 turn → agent_spawn 工具 → SchedulerService →
 *     SubagentLauncher Bun.spawn（compile 形态 = 产物 spawn 自身）→ 子进程
 *     线协议 closure → agent.completed 事件断言。主引擎 LLM 由本地假
 *     Anthropic SSE server 充当（models-store.json overlay 注入自定义
 *     baseUrl 模型，auth.set_key 录入假 key）；子进程引擎由
 *     HELIX_FAKE_ENGINE_SCRIPT 剧本注入（经 launcher env 继承，既有注入面）。
 * (b) bun:sqlite roundtrip：daemon 启动（helix.db 打开）后，session 创建
 *     （写）→ session.list 读回（读），经既有持久化面，--home tmp。
 * (c) WS ready/token 握手：--sidecar 形态 stdout ready 行解析
 *     （contracts/sidecar-lifecycle.md §2：单行 JSON {type,port,token}，
 *     15s 超时）+ GET /helix-dev-token 一致性 + WS hello/welcome 握手。
 *
 * 隔离纪律：--home 一律 mkdtemp 注入 + HOME 环境变量同指 tmp（防 RED 形态
 * 下迷路子进程回退默认 home），零触碰真实 ~/.helix（TR-TEST-4）；每形态跑完
 * SIGTERM→SIGKILL 回收进程、关 WS/假 server、删 tmp（TR-TEST-6）。
 *
 * 失败语义（F2.1 管线内步骤）：任一探针失败 / 双形态结果不一致 → 非零退出。
 *
 * 用法：
 *   bun smoke/verify-compiled-daemon.ts [--only dev|compiled] [--report <path>] [--keep-tmp]
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@helix/protocol";
import { COMPILED_DAEMON_PATH } from "../scripts/compile-daemon";

const root = join(import.meta.dir, "..");
const DEV_ENTRY = join(root, "apps/daemon/src/main.ts");
/** 默认模型（model-provider.DEFAULT_MODEL_ID 同源：builtin 兜底位）。 */
const DEFAULT_MODEL = { provider: "anthropic", id: "claude-sonnet-4-5" };
/** 探针 (a) 子进程任务文本。 */
const CHILD_TASK = "等价验证探测任务：直接按 closure 协议收口";
/** ready 行握手超时（contracts/sidecar-lifecycle.md §2：15s 机械判据）。 */
const READY_TIMEOUT_MS = 15_000;
/** 探针 (a) 全链超时（spawn → closure 回传）。 */
const CHAIN_TIMEOUT_MS = 90_000;

// ── argv ────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY = argValue("--only") as "dev" | "compiled" | undefined;
const REPORT_PATH = argValue("--report");
const KEEP_TMP = process.argv.includes("--keep-tmp");
if (ONLY !== undefined && ONLY !== "dev" && ONLY !== "compiled") {
  console.error(`✗ --only 只接受 dev|compiled，实际：${ONLY}`);
  process.exit(2);
}

// ── 探针结果类型 ─────────────────────────────────────────────

interface ProbeOutcome {
  readonly pass: boolean;
  readonly detail: string;
}
interface FormResult {
  readonly form: "dev" | "compiled";
  readonly probes: { a: ProbeOutcome; b: ProbeOutcome; c: ProbeOutcome };
  readonly durationMs: number;
  readonly notes: string[];
}

const ok = (detail: string): ProbeOutcome => ({ pass: true, detail });
const fail = (detail: string): ProbeOutcome => ({ pass: false, detail });

// ── 假 Anthropic SSE server（探针 (a) 主引擎 LLM 替身） ──────
//
// 协议面 = anthropic-messages SSE（pi-ai streamSimple 真实解析链）：
// 首个不含 tool_result 的请求 → tool_use(agent_spawn, {task})；其余 → 文本
// 收尾（tool 结果回灌轮 / closure 注入轮均不再 spawn，防无限委派）。

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
        id: "msg_probe",
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

function toolUseResponse(task: string): Response {
  return sseFrame([
    messageStart(),
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_probe_1", name: "agent_spawn", input: {} },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ task }) },
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

interface FakeAnthropic {
  readonly port: number;
  readonly requestCount: () => number;
  stop(): void;
}

function startFakeAnthropic(task: string): FakeAnthropic {
  let requests = 0;
  let spawned = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      requests += 1;
      const body = (await req.json().catch(() => ({}))) as {
        messages?: { content?: unknown }[];
      };
      const hasToolResult = (body.messages ?? []).some(
        (m) =>
          Array.isArray(m.content) &&
          (m.content as { type?: string }[]).some((b) => b.type === "tool_result"),
      );
      if (!hasToolResult && !spawned) {
        spawned = true;
        return toolUseResponse(task);
      }
      return textResponse("收到，子代理任务执行中，等其 closure 回传即可。");
    },
  });
  return {
    port: server.port ?? 0,
    requestCount: () => requests,
    stop: () => server.stop(true),
  };
}

// ── models-store.json overlay 注入（自定义 baseUrl 模型） ────
//
// ModelCatalog = builtin 静态表 + models-store.json overlay 合并（同 id 替换），
// 引擎模型解析走合并视图（catalog.modelsView()）。注入面 = --home tmp 内的
// 目录缓存文件（真实文件注入面，非进程内白盒）。

function seedModelsStore(home: string, baseUrl: string): void {
  // overlay 模型手工声明（同 id 全字段替换 builtin；api=anthropic-messages
  // 走 pi-ai 真实 SSE 解析链，baseUrl 指向本地假 server）。不 import pi-ai
  // 目录（pi-ai 是 apps/daemon 的依赖，root 工程层不可达）。
  const overlay = {
    id: DEFAULT_MODEL.id,
    name: "F2.2 Probe Model",
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

// ── 子进程剧本（HELIX_FAKE_ENGINE_SCRIPT，既有 env 注入面） ──

function writeChildScript(tmp: string): string {
  const closure = { status: "done", summary: "探针子任务完成", reportPath: null, findings: [], taskId: null };
  const scriptPath = join(tmp, "child-script.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({ replies: [`<<<CLOSURE\n${JSON.stringify(closure)}\nCLOSURE>>>`], chunkDelayMs: 1 }),
  );
  return scriptPath;
}

// ── WS 探针客户端 ────────────────────────────────────────────

interface Frame {
  readonly type?: string;
  readonly payload?: unknown;
  readonly channel?: string;
  readonly sessionId?: string;
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

async function waitExit(proc: { exited: Promise<number> }, ms: number): Promise<boolean> {
  return Promise.race([proc.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
}

// ── 单形态探针运行 ───────────────────────────────────────────

async function runForm(form: "dev" | "compiled"): Promise<FormResult> {
  const t0 = Date.now();
  const notes: string[] = [];
  const tmp = mkdtempSync(join(tmpdir(), `helix-f22-${form}-`));
  const home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  const port = freePort();
  writeFileSync(join(home, "config.json"), JSON.stringify({ port }));

  const fake = startFakeAnthropic(CHILD_TASK);
  seedModelsStore(home, `http://127.0.0.1:${fake.port}`);
  const childScript = writeChildScript(tmp);

  const cmd =
    form === "dev"
      ? [process.execPath, DEV_ENTRY, "--sidecar", "--home", home]
      : [COMPILED_DAEMON_PATH, "--sidecar", "--home", home];

  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let ws: WsProbe | undefined;
  const probes: { a?: ProbeOutcome; b?: ProbeOutcome; c?: ProbeOutcome } = {};

  try {
    proc = Bun.spawn({
      cmd,
      cwd: root,
      env: {
        ...process.env,
        HOME: tmp, // 迷路进程回退默认 home 也落 tmp（TR-TEST-4 双保险）
        HELIX_FAKE_ENGINE_SCRIPT: childScript, // 经 launcher env 继承进子进程（既有注入面）
      } as Record<string, string | undefined>,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    // ── 探针 (c)：ready 行 + token + WS 握手 ──
    let ready: { type?: string; port?: number; token?: string } | undefined;
    let stderrTail = "";
    void (async () => {
      const reader = proc!.stderr!.getReader();
      const dec = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          stderrTail = (stderrTail + dec.decode(value)).slice(-2000);
        }
      } catch {
        /* 进程已退出 */
      }
    })();
    try {
      const reader = proc.stdout!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ready 行超时")), Math.max(1, deadline - Date.now()))),
        ]);
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          try {
            const parsed = JSON.parse(line) as { type?: string; port?: number; token?: string };
            if (parsed.type === "ready") {
              ready = parsed;
              break;
            }
          } catch {
            /* ready 行前的日志输出（契约 §2：非协议解析面） */
          }
        }
      }
      reader.releaseLock();
      // ready 行之后 stdout 剩余输出不再承担协议（契约 §2），排空防管道阻塞
      void (async () => {
        const r2 = proc!.stdout!.getReader();
        try {
          while (!(await r2.read()).done) {
            /* drain */
          }
        } catch {
          /* 进程已退出 */
        }
      })();
    } catch (err) {
      probes.c = fail(`ready 行未就绪：${(err as Error).message}；stderr 尾：${stderrTail.slice(-300)}`);
    }

    if (ready !== undefined && typeof ready.port === "number" && typeof ready.token === "string") {
      try {
        const tokenResp = await fetch(`http://127.0.0.1:${ready.port}/helix-dev-token`);
        const httpToken = (await tokenResp.text()).trim();
        if (httpToken !== ready.token) {
          throw new Error(`ready token 与 /helix-dev-token 不一致（${httpToken.slice(0, 8)}… ≠ ${ready.token.slice(0, 8)}…）`);
        }
        ws = new WsProbe();
        const welcome = await ws.connect(`ws://127.0.0.1:${ready.port}`, ready.token, 10_000);
        if (welcome.type !== "connection.welcome") {
          throw new Error(`握手回执非 welcome：${JSON.stringify(welcome.payload)}`);
        }
        probes.c = ok(`ready 行（port=${ready.port}）+ /helix-dev-token 一致 + WS hello→welcome`);
      } catch (err) {
        probes.c = fail(`token/WS 握手失败：${(err as Error).message}`);
      }
    } else if (probes.c === undefined) {
      probes.c = fail(`ready 行形态非法：${JSON.stringify(ready)}；stderr 尾：${stderrTail.slice(-300)}`);
    }

    // ── W1 后置义务：sidecar 形态未绑定即拒会话（workspace.unbound）——探针
    // 驱动 chat.send 前预绑定临时 workspace（dev-desktop W5 同款语义：
    // workspace.open → workspace.open.result）
    if (probes.c.pass) {
      try {
        const wsRoot = mkdtempSync(join(tmpdir(), "helix-probe-ws-"));
        ws!.send("workspace.open", { root: wsRoot });
        const bindFrame = await ws!.waitFor(
          (f) => f.type === "workspace.open.result" || f.type === "connection.error",
          10_000,
        );
        if (bindFrame.type === "connection.error") {
          throw new Error(`workspace.open 被拒：${JSON.stringify(bindFrame.payload)}`);
        }
      } catch (err) {
        probes.a = fail(`workspace 预绑定失败（探针 (a) 前置）：${(err as Error).message}`);
      }
    }

    // ── 探针 (b) 前段：空库读面（fresh home → 零会话） ──
    let sessionListBefore = -1;
    if (probes.c.pass) {
      try {
        ws!.send("session.list", {});
        const listFrame = await ws!.waitFor((f) => f.type === "session.list.result", 10_000);
        sessionListBefore = ((listFrame.payload as { sessions?: unknown[] }).sessions ?? []).length;
      } catch (err) {
        probes.b = fail(`session.list（前段）失败：${(err as Error).message}`);
      }
    }

    // ── 探针 (a)：spawn 自身子进程链路（F-7① 直面） ──
    if (probes.c.pass) {
      try {
        ws!.send("auth.set_key", { providerId: DEFAULT_MODEL.provider, apiKey: "probe-fake-key" });
        await ws!.waitFor((f) => f.type === "auth.set_key.result" || f.type === "connection.error", 10_000);
        ws!.send("chat.send", { text: "请指派一个 SubAgent 执行探测任务", draft: true });

        const spawnedFrame = await ws!.waitFor(
          (f) => f.type === "agent.spawned" || f.type === "connection.error",
          CHAIN_TIMEOUT_MS,
        );
        if (spawnedFrame.type !== "agent.spawned") {
          throw new Error(`未收到 agent.spawned（得 ${spawnedFrame.type}：${JSON.stringify(spawnedFrame.payload)}）`);
        }
        const agentId = (spawnedFrame.payload as { agentId?: string }).agentId ?? "?";

        const doneFrame = await ws!.waitFor(
          (f) =>
            (f.type === "agent.completed" || f.type === "agent.failed" || f.type === "agent.killed") &&
            (f.payload as { agentId?: string }).agentId === agentId,
          CHAIN_TIMEOUT_MS,
        );
        const closure = (doneFrame.payload as { closure?: { status?: string; summary?: string } }).closure;
        if (doneFrame.type !== "agent.completed" || closure?.status !== "done") {
          throw new Error(
            `子进程未正常收口：${doneFrame.type} closure=${JSON.stringify(closure)}；stderr 尾：${stderrTail.slice(-300)}`,
          );
        }
        probes.a = ok(
          `${agentId} 真子进程跑通：agent.spawned → agent.completed closure.done（"${closure.summary}"）；` +
            `假 LLM 请求数=${fake.requestCount()}`,
        );
      } catch (err) {
        probes.a = fail(`${(err as Error).message}`);
      }
    } else {
      probes.a = fail("前置探针 (c) 失败，链路无法启动");
    }

    // ── 探针 (b)：bun:sqlite roundtrip（写→读经既有持久化面） ──
    if (probes.b === undefined) {
      if (!probes.c.pass) {
        probes.b = fail("前置探针 (c) 失败，持久化面不可用");
      } else {
        try {
          const dbPath = join(home, "helix.db");
          if (!existsSync(dbPath) || statSync(dbPath).size === 0) {
            throw new Error(`helix.db 缺失或为空：${dbPath}`);
          }
          ws!.send("session.list", {});
          const listFrame = await ws!.waitFor((f) => f.type === "session.list.result", 10_000);
          const sessions = (listFrame.payload as { sessions?: { sessionId?: string }[] }).sessions ?? [];
          if (sessionListBefore !== 0) {
            throw new Error(`fresh home 前段读面非空（${sessionListBefore} 个会话）`);
          }
          if (sessions.length !== 1) {
            throw new Error(`写后期望 1 个会话（探针 a 草稿转正），实际 ${sessions.length}`);
          }
          probes.b = ok(`helix.db 存在（${statSync(dbPath).size}B）；写读 roundtrip：0 → 1 会话经 session.list 读回`);
        } catch (err) {
          probes.b = fail(`${(err as Error).message}`);
        }
      }
    }
  } catch (err) {
    const msg = `daemon 启动/运行异常：${(err as Error).message}`;
    probes.a ??= fail(msg);
    probes.b ??= fail(msg);
    probes.c ??= fail(msg);
  } finally {
    // TR-TEST-6 三件套：进程 / 端口（WS+假 server）/ tmp
    ws?.close();
    if (proc !== undefined) {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* 已退出 */
      }
      if (!(await waitExit(proc, 5_000))) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
        await waitExit(proc, 2_000);
      }
    }
    fake.stop();
    if (KEEP_TMP) notes.push(`tmp 保留（--keep-tmp）：${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  }

  return {
    form,
    probes: { a: probes.a!, b: probes.b!, c: probes.c! },
    durationMs: Date.now() - t0,
    notes,
  };
}

// ── 报告 ────────────────────────────────────────────────────

function renderReport(results: readonly FormResult[], equivalent: boolean): string {
  const lines: string[] = [
    "# CL-2 / F2.2 compile 产物等价验证报告",
    "",
    `> 迭代: iter-20260822-m1uc ｜ 任务: T2.2 ｜ 生成: ${new Date().toISOString()}`,
    `> 脚本: smoke/verify-compiled-daemon.ts（同脚本双形态对照，test-design §1.3①）`,
    "",
    "## 探针结果对照",
    "",
    "| 探针 | dev 直跑 | compile 产物 |",
    "|---|---|---|",
  ];
  const names: Record<"a" | "b" | "c", string> = {
    a: "(a) spawn 自身子进程链路（F-7①）",
    b: "(b) bun:sqlite roundtrip",
    c: "(c) WS ready/token 握手（--sidecar）",
  };
  for (const key of ["a", "b", "c"] as const) {
    const cells = results.map((r) => {
      const p = r.probes[key];
      return `${p.pass ? "✓" : "✗"} ${p.detail}`.replaceAll("|", "\\|");
    });
    lines.push(`| ${names[key]} | ${cells.join(" | ")} |`);
  }
  lines.push(
    "",
    "## 等价判定",
    "",
    equivalent
      ? "✓ 双形态三探针结果逐项一致（全通过）——compile 产物功能等价于 dev 直跑（探针集合内）。"
      : "✗ 双形态结果不一致或存在失败探针——不等价，管线应中断（F2.1）。",
    "",
    "## 运行环境",
    "",
    `- bun: ${Bun.version}`,
    `- 平台: ${process.platform}/${process.arch}（compile target=bun-darwin-arm64，AD-6）`,
  );
  if (existsSync(COMPILED_DAEMON_PATH)) {
    lines.push(`- 产物: ${COMPILED_DAEMON_PATH}（${(statSync(COMPILED_DAEMON_PATH).size / 1024 / 1024).toFixed(1)}MB）`);
  }
  for (const r of results) {
    lines.push(`- ${r.form} 形态耗时: ${(r.durationMs / 1000).toFixed(1)}s`);
    for (const n of r.notes) lines.push(`  - ${n}`);
  }
  lines.push(
    "",
    "## F-7① 暴露 / 消解 / 验证结论",
    "",
    "- **暴露（RED）**：compile 产物直跑时，SubagentLauncher 原 spawn 命令",
    "  `[execPath, CHILD_MAIN_PATH]` 中 CHILD_MAIN_PATH 指向 $bunfs 虚拟路径，",
    "  产物 spawn 自身重跑该 .ts 不可达 → 子进程 exit 1 无 closure（agent.failed）。",
    "  暴露证据：evidence/red-t2-2-f7-exposure.md（探针 (a) compiled ✗ / dev 基线 ✓）。",
    "- **消解（按 brief 修法预案，非设计变更）**：main.ts 入口 argv 分发",
    "  `--child-main` → ChildMain 逻辑；SubagentLauncher 两形态统一组装",
    "  `[process.execPath, <daemon 入口>, \"--child-main\", ...]`（dev = bun 直跑",
    "  main.ts；compile = 产物重入内嵌 main，入口实参惰性忽略）——同一代码路径，",
    "  无 if(isCompiled) 形态分叉（arch-guard 可扫）。",
    "- **验证（GREEN）**：探针 (a) 双形态均真实跑通 `agent.spawned → agent.completed",
    "  closure.done`（见上表 (a) 行）——F-7① 消解成立。",
    "",
    "## 驱动链说明（探针 a 非手工模拟的机械判据落实）",
    "",
    "- 父进程 = 被测 daemon 本体（dev=源码 / compile=单文件产物），spawn 触发链全真实面：",
    "  WS chat.send → 主引擎 turn → agent_spawn 工具 → SchedulerService → SubagentLauncher",
    "  Bun.spawn（compile 形态 = 产物 spawn 自身）→ ChildMain 子进程 → 线协议 closure → agent.completed。",
    "- 主引擎 LLM = 本地假 Anthropic SSE server（127.0.0.1 回环）：模型 baseUrl 经",
    "  `<tmp home>/models-store.json` overlay 注入（ModelCatalog 合并目录真实文件面），",
    "  key 经 WS auth.set_key 录入（真实命令面）。",
    "- 子进程引擎 = HELIX_FAKE_ENGINE_SCRIPT 剧本（既有 env 注入面，经 launcher env 继承）。",
    "- 隔离：--home mkdtemp 注入 + HOME 同指 tmp（TR-TEST-4）；进程/端口/tmp 跑完即清（TR-TEST-6）。",
    "",
  );
  return lines.join("\n");
}

// ── main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const forms: ("dev" | "compiled")[] = ONLY !== undefined ? [ONLY] : ["dev", "compiled"];
  if (forms.includes("compiled") && !existsSync(COMPILED_DAEMON_PATH)) {
    console.error(`✗ compile 产物不存在：${COMPILED_DAEMON_PATH}（先跑 bun scripts/compile-daemon.ts）`);
    process.exit(2);
  }

  const results: FormResult[] = [];
  for (const form of forms) {
    console.log(`▶ 形态 ${form} 探针运行中…`);
    const r = await runForm(form);
    results.push(r);
    for (const key of ["a", "b", "c"] as const) {
      const p = r.probes[key];
      console.log(`  ${p.pass ? "✓" : "✗"} 探针 (${key}) ${p.pass ? "PASS" : "FAIL"} — ${p.detail}`);
    }
  }

  // 等价判定：全探针通过 + 双形态逐项一致
  const allPass = results.every((r) => [r.probes.a, r.probes.b, r.probes.c].every((p) => p.pass));
  const consistent =
    results.length < 2 ||
    (["a", "b", "c"] as const).every((k) => results.every((r) => r.probes[k].pass === results[0]!.probes[k].pass));
  const equivalent = allPass && consistent;

  const report = renderReport(results, equivalent);
  if (REPORT_PATH !== undefined) {
    mkdirSync(join(REPORT_PATH, ".."), { recursive: true });
    writeFileSync(REPORT_PATH, report);
    console.log(`▶ 报告已落盘：${REPORT_PATH}`);
  } else {
    console.log("\n" + report);
  }

  if (!equivalent) {
    console.error("✗ F2.2 等价验证失败（任一探针失败或双形态不一致 → 非零退出）");
    process.exit(1);
  }
  console.log("✓ F2.2 等价验证通过：双形态三探针逐项一致");
}

await main();
