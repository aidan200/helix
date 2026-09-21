/**
 * embedding 配置域批（管家记忆 B2）additive 断言：
 * - embedding.list / embedding.set / embedding.delete / embedding.verify
 *   四命令（端点 CRUD + 连通测试；apiKey 只进不出）；
 * - embedding.list.result 端点清单回执（list/set/delete 共用——写后即刷
 *   新清单；行含 hasApiKey/verifiedAt，无 apiKey 原值）；
 * - embedding.verify.result 连通回执两判别（ok 含 dim / fail 含 error；
 *   payload 回携 id——多端点并发验证归属无歧义）；
 * - CHANNEL 目录扩 "embedding"（新增族 = additive，不动分发器，steward
 *   族先例同构口径）。
 *
 * 同批 steward 面瘦身断言见 steward.test.ts（memory 组 {enabled?,endpointId?}
 * + memory_* 四命令 + memory_list.result）。
 */
import { describe, expect, test } from "bun:test";
import { COMMAND_TYPES, EVENT_CHANNELS, EVENT_TYPES, PROTOCOL_VERSION } from "../../src/index";
import type {
  EmbeddingDeleteCommand,
  EmbeddingEndpointView,
  EmbeddingListCommand,
  EmbeddingListResultEvent,
  EmbeddingSetCommand,
  EmbeddingVerifyCommand,
  EmbeddingVerifyResultEvent,
} from "../../src/index";
import type { Equal, Expect, TypeOfChannel } from "./samples/helpers";
import { dispatchCommand, familyOf, summarizeEvent } from "./samples/helpers";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败）──

// set 载荷：id 可选（缺省新增/带 id 更新），name/baseUrl/model 必填，
// apiKey 可选（空串 = 清除）
type _SetId = Expect<Equal<EmbeddingSetCommand["payload"]["id"], string | undefined>>;
type _SetName = Expect<Equal<EmbeddingSetCommand["payload"]["name"], string>>;
type _SetBaseUrl = Expect<Equal<EmbeddingSetCommand["payload"]["baseUrl"], string>>;
type _SetApiKey = Expect<Equal<EmbeddingSetCommand["payload"]["apiKey"], string | undefined>>;
type _SetModel = Expect<Equal<EmbeddingSetCommand["payload"]["model"], string>>;

// delete/verify 载荷：id 必填
type _DeleteId = Expect<Equal<EmbeddingDeleteCommand["payload"]["id"], string>>;
type _VerifyId = Expect<Equal<EmbeddingVerifyCommand["payload"]["id"], string>>;

// 清单行凭据卫生：hasApiKey 布尔 + verifiedAt（null = 从未验证），
// 无 apiKey 原值字段
type _ViewHasKey = Expect<Equal<EmbeddingEndpointView["hasApiKey"], boolean>>;
type _ViewVerifiedAt = Expect<Equal<EmbeddingEndpointView["verifiedAt"], number | null>>;

// verify.result 两判别窄化（ok 含 dim / fail 含 error）
type _VerifyOk = Expect<Equal<Extract<EmbeddingVerifyResultEvent["payload"], { state: "ok" }>["dim"], number>>;
type _VerifyFail = Expect<Equal<Extract<EmbeddingVerifyResultEvent["payload"], { state: "fail" }>["error"], string>>;

// channel = "embedding" 新族窄化（familyOf case 存在 + TypeOfChannel 收窄）
type _EmbeddingFamily = Expect<
  Equal<TypeOfChannel<"embedding">, "embedding.list.result" | "embedding.verify.result">
>;

// ── 运行级断言（目录登记 + 构造/窄化消费）──

const listCommand: EmbeddingListCommand = {
  v: PROTOCOL_VERSION,
  type: "embedding.list",
  payload: {},
};

const setCommand: EmbeddingSetCommand = {
  v: PROTOCOL_VERSION,
  type: "embedding.set",
  payload: { name: "Ollama 本地", baseUrl: "http://localhost:11434/v1", model: "bge-m3" },
};

const setUpdateCommand: EmbeddingSetCommand = {
  v: PROTOCOL_VERSION,
  type: "embedding.set",
  payload: { id: "ep-1", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "text-embedding-3-small" },
};

const deleteCommand: EmbeddingDeleteCommand = {
  v: PROTOCOL_VERSION,
  type: "embedding.delete",
  payload: { id: "ep-1" },
};

const verifyCommand: EmbeddingVerifyCommand = {
  v: PROTOCOL_VERSION,
  type: "embedding.verify",
  payload: { id: "ep-1" },
};

const listResult: EmbeddingListResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "embedding",
  type: "embedding.list.result",
  payload: {
    endpoints: [
      {
        id: "ep-1",
        name: "Ollama 本地",
        baseUrl: "http://localhost:11434/v1",
        model: "bge-m3",
        hasApiKey: false,
        verifiedAt: 1760000000000,
      },
      {
        id: "ep-2",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        hasApiKey: true,
        verifiedAt: null,
      },
    ],
  },
};

const verifyOk: EmbeddingVerifyResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "embedding",
  type: "embedding.verify.result",
  payload: { id: "ep-1", state: "ok", dim: 1024 },
};

const verifyFail: EmbeddingVerifyResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "embedding",
  type: "embedding.verify.result",
  payload: { id: "ep-2", state: "fail", error: "嵌入端点不可达（https://api.openai.com/v1/embeddings）：timeout" },
};

describe("embedding 配置域批（管家记忆 B2）：四命令 additive", () => {
  test("命令/事件/通道目录登记（COMMAND_TYPES / EVENT_TYPES / EVENT_CHANNELS）", () => {
    for (const t of ["embedding.list", "embedding.set", "embedding.delete", "embedding.verify"] as const) {
      expect(COMMAND_TYPES).toContain(t);
    }
    for (const t of ["embedding.list.result", "embedding.verify.result"] as const) {
      expect(EVENT_TYPES).toContain(t);
      expect(EVENT_CHANNELS[t]).toBe("embedding");
    }
  });

  test("四命令可构造且 dispatch 窄化消费独有字段", () => {
    expect(dispatchCommand(listCommand)).toBe("embedding-list");
    expect(dispatchCommand(setCommand)).toBe("embedding-set:-:Ollama 本地:http://localhost:11434/v1:bge-m3:-");
    expect(dispatchCommand(setUpdateCommand)).toBe(
      "embedding-set:ep-1:OpenAI:https://api.openai.com/v1:text-embedding-3-small:",
    );
    expect(dispatchCommand(deleteCommand)).toBe("embedding-delete:ep-1");
    expect(dispatchCommand(verifyCommand)).toBe("embedding-verify:ep-1");
  });

  test("list.result 清单行全字段窄化可达（含 verifiedAt null 面）", () => {
    expect(summarizeEvent(listResult)).toBe("embedding-list:2:Ollama 本地");
    const [ollama, openai] = listResult.payload.endpoints;
    expect(ollama?.verifiedAt).toBe(1760000000000);
    expect(openai?.hasApiKey).toBe(true);
    expect(openai?.verifiedAt).toBeNull();
  });

  test("verify.result 两判别窄化：ok 含 dim / fail 含 error（id 回携）", () => {
    expect(summarizeEvent(verifyOk)).toBe("embedding-verify-ok:ep-1:1024");
    expect(summarizeEvent(verifyFail)).toContain("embedding-verify-fail:ep-2:");
    if (verifyFail.payload.state === "fail") expect(verifyFail.payload.error).toContain("不可达");
  });

  test("familyOf 分族窄化：channel=embedding → 'embedding/<type>'", () => {
    expect(familyOf(listResult)).toBe("embedding/embedding.list.result");
    expect(familyOf(verifyOk)).toBe("embedding/embedding.verify.result");
  });
});
