import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_CATALOG_BASE_URL,
  ModelCatalog,
  effectiveOverlay,
  mergeModels,
  parseCatalog,
  type OverlayEntry,
} from "../../src/adapters/driven/pi-engine/model-catalog";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model } from "@earendil-works/pi-ai";

/**
 * AD-2 ModelCatalog（T2.3 brief TDD 组3 + 组5；契约 C §3）：
 * - 合并（builtin 为 baseline、overlay 同 id 替换/新 id 追加）；
 * - ETag 三分支（304 只挪 checkedAt / 过期重拉 / force 绕过——HTTP mock pi.dev）；
 * - 瞬时失败保缓存；404/501 清 etag；落盘兜底（离线 builtin fallback）；
 * - localGeneratedAt 防降级（stored.lastModified <= local 丢弃远端）；
 * - verify stub server（成功含延迟 / 401 含原因——真 anthropic-messages SSE）。
 */

const tmpRoots: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-catalog-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

// ── 测试底座：受控小目录（两 provider 各两模型）+ 固定时钟 ──────────

const T0 = 1_700_000_000_000;
let nowMs = T0;
const tick = (ms: number): void => {
  nowMs += ms;
};

function fakeModel(provider: string, id: string, contextWindow = 1000): Model<any> {
  return {
    id,
    provider,
    name: id,
    api: "anthropic-messages",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
    contextWindow,
    maxTokens: 4096,
  } as unknown as Model<any>;
}

/** 受控底座（测试注入 fake catalog——与 builtinModels() 同接口的最小两 provider）。 */
function fakeModels(): ReturnType<typeof builtinModels> {
  const byProvider: Record<string, Model<any>[]> = {
    anthropic: [fakeModel("anthropic", "claude-a"), fakeModel("anthropic", "claude-b")],
    openai: [fakeModel("openai", "gpt-a")],
  };
  return {
    getProviders: () => Object.keys(byProvider).map((id) => ({ id })) as never,
    getProvider: (id: string) => ({ id }) as never,
    getModels: (pid?: string) =>
      pid === undefined ? Object.values(byProvider).flat() : (byProvider[pid] ?? []),
    getModel: (pid: string, id: string) => (byProvider[pid] ?? []).find((m) => m.id === id),
  } as unknown as ReturnType<typeof builtinModels>;
}

/** mock pi.dev：per-provider 状态机（请求计数 + ETag + 响应控制）。 */
class MockCatalogServer {
  readonly requests: { providerId: string; ifNoneMatch?: string }[] = [];
  private readonly states = new Map<string, { body: unknown; etag: string; lastModified: number }>();
  private readonly modes = new Map<string, "ok" | "not-modified" | "gone" | "error">();

  setBody(providerId: string, body: unknown, etag: string, lastModified: number): void {
    this.states.set(providerId, { body, etag, lastModified });
    this.modes.set(providerId, "ok");
  }

  setMode(providerId: string, mode: "not-modified" | "gone" | "error"): void {
    this.modes.set(providerId, mode);
  }

  handler = (input: Request | URL | string, init?: { headers?: Record<string, string> }): Response => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const providerId = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    this.requests.push({ providerId, ifNoneMatch: init?.headers?.["if-none-match"] });
    const state = this.states.get(providerId);
    const mode = this.modes.get(providerId) ?? "ok";
    if (mode === "error") return new Response("boom", { status: 503 });
    if (mode === "gone") return new Response("{}", { status: 404 });
    if (mode === "not-modified") return new Response(null, { status: 304 });
    if (state === undefined) return new Response("[]", { status: 200 });
    return new Response(JSON.stringify(state.body), {
      status: 200,
      headers: { "content-type": "application/json", etag: state.etag, "last-modified": new Date(state.lastModified).toUTCString() },
    });
  };
}

function makeCatalog(overrides: Partial<ConstructorParameters<typeof ModelCatalog>[0]> = {}): ModelCatalog {
  return new ModelCatalog({
    models: fakeModels(),
    localGeneratedAt: T0 - 1000, // builtin 生成时间早于远端 lastModified → overlay 有效
    now: () => nowMs,
    // 缺省离线（防真网请求泄漏进单测）；需要 mock pi.dev 的用例显式注入 fetchImpl
    fetchImpl: () => {
      throw new Error("offline（本测试未注入 fetchImpl）");
    },
    ...overrides,
  });
}

describe("合并与防降级（纯函数面）", () => {
  test("mergeModels：baseline 保持序、同 id 替换、新 id 追加", () => {
    const base = [fakeModel("p", "a"), fakeModel("p", "b")];
    const dyn = [fakeModel("p", "b", 999), fakeModel("p", "c")];
    const merged = mergeModels(base, dyn);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged[1]!.contextWindow).toBe(999); // 替换生效
  });

  test("parseCatalog：数组 / {models} / 对象值表三形态 + provider 归位", () => {
    expect(parseCatalog("p", [{ id: "x" }])[0]!.provider).toBe("p");
    expect(parseCatalog("p", { models: [{ id: "y" }] }).map((m) => m.id)).toEqual(["y"]);
    expect(parseCatalog("p", { k: { id: "z" } }).map((m) => m.id)).toEqual(["z"]);
    expect(() => parseCatalog("p", "bad")).toThrow();
  });

  test("localGeneratedAt 防降级：lastModified 缺失/不晚于本地 → overlay 丢弃", () => {
    const models = [fakeModel("p", "x")];
    expect(effectiveOverlay({ models, lastModified: T0 + 500, checkedAt: T0 }, T0)).toHaveLength(1); // 更新 → 生效
    expect(effectiveOverlay({ models, lastModified: T0, checkedAt: T0 }, T0)).toHaveLength(0); // 等于 → 防降级
    expect(effectiveOverlay({ models, lastModified: T0 - 1, checkedAt: T0 }, T0)).toHaveLength(0); // 更旧 → 丢弃
    expect(effectiveOverlay({ models, checkedAt: T0 }, T0)).toHaveLength(0); // 无 lastModified → 丢弃
  });
});

describe("目录读面（builtin 基线 + overlay 合并投影）", () => {
  test("builtin-only：source=builtin、四费率/contextWindow 投影、hasModel/providerIds", async () => {
    const catalog = makeCatalog();
    const snapshot = await catalog.catalog(); // store 无缓存不刷新（fetch 计数为 0 才算离线安全）
    expect(snapshot.source).toBe("builtin");
    expect(snapshot.models.map((m) => m.id).sort()).toEqual(["anthropic/claude-a", "anthropic/claude-b", "openai/gpt-a"]);
    expect(snapshot.models[0]!.cost).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 });
    expect(catalog.hasModel("anthropic/claude-a")).toBe(true);
    expect(catalog.hasModel("anthropic/nope")).toBe(false);
    expect([...catalog.providerIds()].sort()).toEqual(["anthropic", "openai"]);
  });
});

describe("ETag 三分支（HTTP mock pi.dev，TDD 组3）", () => {
  test("① 过期重拉：200 + ETag/Last-Modified 存入 store；overlay 替换/追加 + source 标记", async () => {
    const server = new MockCatalogServer();
    server.setBody("anthropic", { models: [{ id: "claude-a", contextWindow: 999_999 }, { id: "claude-new" }] }, '"v1"', T0 + 1000);
    server.setBody("openai", [], '"o1"', T0 + 1000);
    const storePath = path.join(tmpDir(), "models-store.json");
    const catalog = makeCatalog({ baseUrl: "http://127.0.0.1:1", fetchImpl: server.handler, storePath });
    await catalog.refresh();
    const snapshot = await catalog.catalog(); // 新鲜（<4h）不再发请求
    const claudeA = snapshot.models.find((m) => m.id === "anthropic/claude-a")!;
    expect(claudeA.source).toBe("overlay"); // 同 id 替换 → overlay 标记
    expect(claudeA.contextWindow).toBe(999_999);
    expect(snapshot.models.find((m) => m.id === "anthropic/claude-new")!.source).toBe("overlay"); // 新 id 追加
    expect(snapshot.models.find((m) => m.id === "openai/gpt-a")!.source).toBe("builtin"); // 空数组 overlay 不影响
    expect(snapshot.source).toBe("cache"); // catalog() 读面口径
    expect(snapshot.refreshedAt).toBeGreaterThan(0);
    // 请求验证：首轮 2 个（refresh），catalog() 未追加
    expect(server.requests.length).toBe(2);
  });

  test("② 304 命中：条件请求带 If-None-Match；只挪 checkedAt（body 不重拉不丢失）", async () => {
    const server = new MockCatalogServer();
    server.setBody("anthropic", { models: [{ id: "claude-a", contextWindow: 777 }] }, '"etag-1"', T0 + 1000);
    server.setBody("openai", [], '"o1"', T0 + 1000);
    const catalog = makeCatalog({ fetchImpl: server.handler });
    await catalog.refresh();
    const afterFirst = await catalog.catalog();
    expect(afterFirst.models.find((m) => m.id === "anthropic/claude-a")!.contextWindow).toBe(777);

    // 4h 过期 → 条件请求 → 304：模型保持、checkedAt 前移、etag 不清
    server.setMode("anthropic", "not-modified");
    server.setMode("openai", "not-modified");
    tick(4 * 60 * 60 * 1000 + 1);
    const refreshed = await catalog.catalog();
    expect(refreshed.models.find((m) => m.id === "anthropic/claude-a")!.contextWindow).toBe(777); // body 保留
    const lastAnthropic = server.requests.filter((r) => r.providerId === "anthropic").pop()!;
    expect(lastAnthropic.ifNoneMatch).toBe('"etag-1"'); // 条件请求回传 ETag
    expect(server.requests.filter((r) => r.providerId === "anthropic").length).toBe(2); // 确实重验过
  });

  test("③ 强制绕过（catalog_refresh）：4h 窗口内也重拉", async () => {
    const server = new MockCatalogServer();
    server.setBody("anthropic", { models: [{ id: "claude-a", contextWindow: 111 }] }, '"e1"', T0 + 1000);
    server.setBody("openai", [], '"o1"', T0 + 1000);
    const catalog = makeCatalog({ fetchImpl: server.handler });
    await catalog.refresh();
    expect(server.requests.length).toBe(2);
    await catalog.refresh(); // 窗口内强制再来一轮
    expect(server.requests.length).toBe(4); // force 绕过 4h
  });

  test("④ 瞬时失败保缓存：503 → degraded 列明细；缓存 entry 原样保留（overlay 仍生效）", async () => {
    const server = new MockCatalogServer();
    server.setBody("anthropic", { models: [{ id: "claude-a", contextWindow: 555 }] }, '"e1"', T0 + 1000);
    server.setBody("openai", [], '"o1"', T0 + 1000);
    const catalog = makeCatalog({ fetchImpl: server.handler });
    await catalog.refresh();
    server.setMode("anthropic", "error");
    server.setMode("openai", "error");
    tick(4 * 60 * 60 * 1000 + 1);
    const result = await catalog.refresh();
    expect(result.degraded.length).toBe(2); // 两 provider 都 503 → 明细列出
    expect(result.source).not.toBe("remote"); // 全部失败 → 非 remote 口径
    // 瞬时失败不清缓存（entry 不动）：overlay 模型仍可用（withRemoteCatalog 同构语义）
    const claudeA = result.models.find((m) => m.id === "anthropic/claude-a")!;
    expect(claudeA.contextWindow).toBe(555);
    expect(claudeA.source).toBe("overlay");
  });

  test("⑤ 404/501：清 etag + lastModified=0（overlay 失效回 builtin）", async () => {
    const server = new MockCatalogServer();
    server.setBody("anthropic", { models: [{ id: "claude-a", contextWindow: 444 }] }, '"e1"', T0 + 1000);
    server.setBody("openai", [], '"o1"', T0 + 1000);
    const catalog = makeCatalog({ fetchImpl: server.handler });
    await catalog.refresh();
    expect((await catalog.catalog()).models.find((m) => m.id === "anthropic/claude-a")!.contextWindow).toBe(444);
    server.setMode("anthropic", "gone"); // 404：provider 无远端目录
    server.setMode("openai", "not-modified");
    await catalog.refresh();
    const snapshot = await catalog.catalog();
    const claudeA = snapshot.models.find((m) => m.id === "anthropic/claude-a")!;
    expect(claudeA.source).toBe("builtin"); // lastModified=0 ≤ localGeneratedAt → overlay 防降级丢弃
    expect(claudeA.contextWindow).toBe(1000);
  });
});

describe("落盘兜底 + 离线 builtin fallback（TDD 组3）", () => {
  test("落盘：refresh 后 store 落盘；新实例无网络读缓存（source=cache、不 fetch）", async () => {
    const server = new MockCatalogServer();
    server.setBody("anthropic", { models: [{ id: "claude-a", contextWindow: 321 }] }, '"e1"', T0 + 1000);
    server.setBody("openai", [], '"o1"', T0 + 1000);
    const storePath = path.join(tmpDir(), "models-store.json");
    await makeCatalog({ fetchImpl: server.handler, storePath }).refresh();
    expect(JSON.parse(readFileSync(storePath, "utf8")).providers.anthropic).toBeDefined();

    // 新实例（离线 fetch 全拒）：store 未过期 → 直接读缓存
    let fetchAttempts = 0;
    const offline = makeCatalog({
      storePath,
      fetchImpl: () => {
        fetchAttempts += 1;
        throw new Error("offline");
      },
    });
    const snapshot = await offline.catalog();
    expect(fetchAttempts).toBe(0); // 新鲜缓存不触网
    expect(snapshot.source).toBe("cache");
    expect(snapshot.models.find((m) => m.id === "anthropic/claude-a")!.contextWindow).toBe(321);
  });

  test("离线且无缓存：builtin 兜底可用（无外网单测）", async () => {
    const catalog = makeCatalog({
      fetchImpl: () => {
        throw new Error("offline");
      },
    });
    const snapshot = await catalog.catalog();
    expect(snapshot.source).toBe("builtin");
    expect(snapshot.models.length).toBe(3);
    expect(catalog.hasModel("anthropic/claude-a")).toBe(true);
  });
});

describe("auth.verify 连通最小请求（TDD 组5：stub server 真 SSE）", () => {
  // anthropic-messages 最小 SSE 剧本（pi-ai 解析器实测形状）
  const SSE_OK = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"claude-a","stop_reason":null,"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");

  function verifyRig(mode: "ok" | "unauthorized"): { catalog: ModelCatalog; stop: () => void } {
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        if (mode === "unauthorized") {
          return new Response(
            '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key (stub)"}}',
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(SSE_OK, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const catalog = new ModelCatalog({
      models: builtinModels(), // 真 pi-ai 底座（streamSimple 真体；anthropic SSE 真解析）
      now: () => nowMs,
      // 连通验证模型指向 stub server（生产 = 真实 provider baseUrl）
      verifyModelTransform: (m) => ({ ...m, baseUrl: `http://127.0.0.1:${server.port}` }),
    });
    return { catalog, stop: () => server.stop(true) };
  }

  test("成功：ok + latencyMs（stub 延迟计入）", async () => {
    const { catalog, stop } = verifyRig("ok");
    try {
      const result = await catalog.verify("anthropic", "sk-good");
      expect(result.status).toBe("ok");
      if (result.status === "ok") expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      stop();
    }
  });

  test("401：fail + reason 含状态与 provider 原文", async () => {
    const { catalog, stop } = verifyRig("unauthorized");
    try {
      const result = await catalog.verify("anthropic", "sk-bad");
      expect(result.status).toBe("fail");
      if (result.status === "fail") {
        expect(result.reason).toMatch(/401/);
        expect(result.reason).toContain("stub");
      }
    } finally {
      stop();
    }
  });

  test("未录 key / 未知 provider：fail 带中文原因（不触网）", async () => {
    const { catalog, stop } = verifyRig("ok");
    try {
      const noKey = await catalog.verify("anthropic", undefined);
      expect(noKey.status).toBe("fail");
      if (noKey.status === "fail") expect(noKey.reason).toMatch(/未录入/);
      const noProvider = await catalog.verify("no-such", "k");
      expect(noProvider.status).toBe("fail");
    } finally {
      stop();
    }
  });
});

describe("modelsView / resolveModel（引擎装配面）", () => {
  test("overlay 模型经 modelsView().getModel/resolveModel 可解析（set_default 链）", async () => {
    const server = new MockCatalogServer();
    server.setBody("anthropic", { models: [{ id: "claude-remote-only" }] }, '"e1"', T0 + 1000);
    server.setBody("openai", [], '"o1"', T0 + 1000);
    const catalog = makeCatalog({ fetchImpl: server.handler });
    await catalog.refresh();
    const view = catalog.modelsView();
    expect(view.getModel("anthropic", "claude-remote-only")).toBeDefined();
    expect(view.getModel("anthropic", "claude-a")).toBeDefined(); // builtin 仍在
    expect(view.getModels("anthropic").map((m) => m.id).sort()).toEqual(["claude-a", "claude-b", "claude-remote-only"]);
    expect(catalog.resolveModel("anthropic/claude-remote-only")!.id).toBe("claude-remote-only");
    expect(catalog.resolveModel("anthropic/none")).toBeUndefined();
  });
});
