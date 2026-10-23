/**
 * 命令构造器单测 —— chatSendDraftCommand 草稿建会话模型参数（T3，bug4 发送链）。
 *
 * 契约（packages/protocol ChatSendPayload.model?，T4 已落地）：model 仅
 * draft:true 建会话链消费；缺省 = 全局默认（payload 不携带 model 键）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@helix/protocol";
import { chatSendCommand, chatSendDraftCommand, chatSteerCommand, agentKillCommand, agentSubscribeCommand, agentUnsubscribeCommand, thinkingSetCommand, workspaceGetCommand, workspaceOpenCommand, voiceSynthesizeStreamCommand, voiceSynthesizeStopCommand, stewardCancelCommand, stewardSetConfigCommand,
  configSetSummaryCommand, configGetVoiceModelsCommand, configSetVoiceModelsCommand, configGetProxyCommand, configSetProxyCommand, stewardMemoryListCommand, stewardMemoryAppendCommand, stewardMemoryUpdateCommand, stewardMemoryDeleteCommand, embeddingListCommand, embeddingSetCommand, embeddingDeleteCommand, embeddingVerifyCommand } from "./commands";

describe("chatSendDraftCommand（T3：草稿所选模型随首条 chat.send 上送）", () => {
  it("model 缺省 → payload 仅 text + draft:true（不携带 model 键；回归）", () => {
    const cmd = chatSendDraftCommand("你好");
    expect(cmd.type).toBe("chat.send");
    expect(cmd.sessionId).toBeUndefined();
    expect(cmd.payload).toEqual({ text: "你好", draft: true });
    expect("model" in cmd.payload).toBe(false);
  });

  it("携带 model → payload 携带（draft:true 建会话链消费）", () => {
    const cmd = chatSendDraftCommand("你好", "openai/gpt-5");
    expect(cmd.payload).toEqual({ text: "你好", draft: true, model: "openai/gpt-5" });
    expect(cmd.sessionId).toBeUndefined();
  });

  it("空串 model → 不携带 model 键（与注释「仅非空时携带」一致；空串 = 未选模型）", () => {
    const cmd = chatSendDraftCommand("你好", "");
    expect("model" in cmd.payload).toBe(false);
    expect(cmd.payload).toEqual({ text: "你好", draft: true });
  });
});

// ── 源码定式断言（TR-285：注释口径漂移无行为面可测，用源码断言钉住）──
// 读点 = task 域模块（体量门 P3 按命令域迁出后，task 族头注释随实现体落在
// commands/task.ts；断言文本与语义未改）。
describe("commands 注释口径定式（TR-285）", () => {
  const SRC = readFileSync(new URL("./commands/task.ts", import.meta.url), "utf8");

  it("task 族头注释不写计数快照、如实登记 task.retry（曾写死「九命令…无 steer/重试」而 task.retryCommand 在位）", () => {
    // 计数一律引用式（TR-206）：头注释以「本族全部…清单以本文件构造器为单源」表述
    expect(SRC).not.toContain("九命令");
    expect(SRC).toContain("人工复活 = task.retry");
    expect(SRC).toContain("命令清单以本文件构造器为单源");
  });
});

// ── T9 图片上行：chat.send images 透传（契约 v0.10）──

describe("chatSend 族 images 载荷（T9，契约 v0.10）", () => {
  const IMG = "data:image/png;base64,AAAA";

  it("chatSendCommand：images 可选透传（不携带时 payload 无 key）", () => {
    const withImages = chatSendCommand("看图", "s1", [IMG]);
    expect(withImages.payload).toEqual({ text: "看图", images: [IMG] });
    const plain = chatSendCommand("纯文本", "s1");
    expect(plain.payload).toEqual({ text: "纯文本" });
  });

  it("chatSendDraftCommand：draft + model + images 三可选共存", () => {
    const cmd = chatSendDraftCommand("看图", "openai/gpt-5", [IMG]);
    expect(cmd.payload).toEqual({ text: "看图", draft: true, model: "openai/gpt-5", images: [IMG] });
  });
});

// ── P1 会话模式：chat.send draft 链 mode 透传（协议 ChatSendPayload.mode?）──

describe("chatSendDraftCommand mode 载荷（P1 T4：非 default 才带，default 走协议缺省）", () => {
  it("mode 缺省 / default → payload 不携带 mode 键（帧噪音最小化）", () => {
    const omitted = chatSendDraftCommand("你好");
    expect("mode" in omitted.payload).toBe(false);
    const def = chatSendDraftCommand("你好", undefined, undefined, "default");
    expect("mode" in def.payload).toBe(false);
    expect(def.payload).toEqual({ text: "你好", draft: true });
  });

  it("非 default mode → payload 携带（建会话定格链消费）", () => {
    const cmd = chatSendDraftCommand("你好", undefined, undefined, "staged");
    expect(cmd.payload).toEqual({ text: "你好", draft: true, mode: "staged" });
  });

  it("draft + model + images + mode 四可选共存", () => {
    const cmd = chatSendDraftCommand("看图", "openai/gpt-5", ["data:image/png;base64,AAAA"], "staged");
    expect(cmd.payload).toEqual({
      text: "看图",
      draft: true,
      model: "openai/gpt-5",
      images: ["data:image/png;base64,AAAA"],
      mode: "staged",
    });
  });
});

// ── thinking 批（契约 v0.11 §17.11；T2.1 P-1 滑块选档命令）──

// ── workspace 族命令（W3 门禁；契约 §15.10）──

describe("workspaceGet/Open 构造器（W3 门禁读/写面；全局命令）", () => {
  it("workspaceGet：无参全局命令（信封 sessionId 省略 + payload {}）", () => {
    const cmd = workspaceGetCommand();
    expect(cmd.type).toBe("workspace.get");
    expect(cmd.sessionId).toBeUndefined();
    expect(cmd.payload).toEqual({});
  });

  it("workspaceOpen：payload { root } 透传（daemon 单点校验，前端零重复实现）", () => {
    const cmd = workspaceOpenCommand("/ws/helix");
    expect(cmd.type).toBe("workspace.open");
    expect(cmd.sessionId).toBeUndefined();
    expect(cmd.payload).toEqual({ root: "/ws/helix" });
  });
});

describe("thinkingSetCommand（thinking 批①；仿 modelSetCommand 形态）", () => {
  it("信封 sessionId 必填 + payload { level }（字符串透传，无关闭态）", () => {
    const cmd = thinkingSetCommand("xhigh", "s1");
    expect(cmd.type).toBe("thinking.set");
    expect(cmd.sessionId).toBe("s1");
    expect(cmd.payload).toEqual({ level: "xhigh" });
    expect(typeof cmd.v).toBe("string"); // PROTOCOL_VERSION 信封章印（字面量版本串）
  });
});

// ── M9 #2.18：agent 三命令构造器 + chatSteerCommand 可选 sessionId 形态 ──

describe("agent 实例三命令构造器（M9 #2.18：command-surface 内联裸帧收编）", () => {
  it("agentKillCommand / agentSubscribeCommand / agentUnsubscribeCommand：payload { agentId } + 无信封 sessionId", () => {
    const kill = agentKillCommand("a1");
    expect(kill.type).toBe("agent.kill");
    expect(kill.payload).toEqual({ agentId: "a1" });
    expect(kill.sessionId).toBeUndefined();
    expect(agentSubscribeCommand("a2").type).toBe("agent.subscribe");
    expect(agentSubscribeCommand("a2").payload).toEqual({ agentId: "a2" });
    expect(agentUnsubscribeCommand("a3").type).toBe("agent.unsubscribe");
    expect(agentUnsubscribeCommand("a3").payload).toEqual({ agentId: "a3" });
  });
});

describe("chatSteerCommand 可选 sessionId 形态（M9 #2.18：草稿防御分支收编）", () => {
  it("sessionId 省略 → 信封不携带 sessionId（daemon 解析当前会话）", () => {
    const cmd = chatSteerCommand("加一条约束");
    expect(cmd.type).toBe("chat.steer");
    expect(cmd.sessionId).toBeUndefined();
    expect("sessionId" in cmd).toBe(false);
    expect(cmd.payload).toEqual({ text: "加一条约束" });
  });

  it("sessionId 携带 → 既有形态零变更（含 instanceId 定向）", () => {
    expect(chatSteerCommand("hi", "s1")).toMatchObject({ sessionId: "s1", payload: { text: "hi" } });
    expect(chatSteerCommand("hi", "s1", "inst-1").payload).toEqual({ text: "hi", instanceId: "inst-1" });
  });
});

// ── V3b-2 接线：流式 TTS 两命令构造器（哑帧修复批）──

describe("voice 流式两命令构造器（V3b-2：管家朗读流式接线）", () => {
  it("voiceSynthesizeStreamCommand：utterId + text 必携带，voice 可选（缺省不携带键）", () => {
    const cmd = voiceSynthesizeStreamCommand("utt-1", "第一句。", { voice: "longanlingxi" });
    expect(cmd.type).toBe("voice.synthesize.stream");
    expect(cmd.payload).toEqual({ utterId: "utt-1", text: "第一句。", voice: "longanlingxi" });
    expect(cmd.sessionId).toBeUndefined();
    const bare = voiceSynthesizeStreamCommand("utt-2", "第二句。");
    expect(bare.payload).toEqual({ utterId: "utt-2", text: "第二句。" });
    expect("voice" in bare.payload).toBe(false);
  });

  it("voiceSynthesizeStopCommand：utterId 省略 → payload 空（全部在途句）；携带 → 定向", () => {
    expect(voiceSynthesizeStopCommand().payload).toEqual({});
    expect(voiceSynthesizeStopCommand("utt-9").payload).toEqual({ utterId: "utt-9" });
  });
});

// ── 管家记忆 B2：steward.set_config 构造器 memory 槽位透传（回归：修复前构造器
//    签名只收 enabled/model，memory 字段被静默丢弃——UI 开关勾不上）+
//    memory 组瘦身形态 {enabled?,judgeEndpointId?,recall*}（批1：endpointId
//    退役——向量端点选择收编全局默认 embedding 端点）──

describe("stewardSetConfigCommand 槽位透传（批1 收编形态）", () => {
  it("memory 槽位携带 → payload.memory 透传（修复前被丢弃）", () => {
    const cmd = stewardSetConfigCommand({ memory: { enabled: true } });
    expect(cmd.type).toBe("steward.set_config");
    expect(cmd.payload).toEqual({ memory: { enabled: true } });
  });

  it("三槽位共存：enabled + model + memory（judgeEndpointId 引用）同时携带互不覆盖", () => {
    const cmd = stewardSetConfigCommand({ enabled: true, model: "openai/gpt-5-mini", memory: { enabled: true, judgeEndpointId: "ep-1" } });
    expect(cmd.payload).toEqual({ enabled: true, model: "openai/gpt-5-mini", memory: { enabled: true, judgeEndpointId: "ep-1" } });
  });

  it("单槽位最小帧：只携带传入位，缺省不携带键（帧噪音最小化）", () => {
    expect(stewardSetConfigCommand({ enabled: false }).payload).toEqual({ enabled: false });
    expect(stewardSetConfigCommand({}).payload).toEqual({});
    // judgeEndpointId 空串 = 清除引用（显式解绑）
    expect(stewardSetConfigCommand({ memory: { judgeEndpointId: "" } }).payload).toEqual({ memory: { judgeEndpointId: "" } });
  });

  it("B4a：judgeEndpointId 槽位透传（classifier 端点引用）", () => {
    const cmd = stewardSetConfigCommand({ memory: { judgeEndpointId: "ep-9" } });
    expect(cmd.payload).toEqual({ memory: { judgeEndpointId: "ep-9" } });
    const both = stewardSetConfigCommand({ memory: { enabled: true, judgeEndpointId: "ep-9" } });
    expect(both.payload.memory).toEqual({ enabled: true, judgeEndpointId: "ep-9" });
  });

  // ── 总结器独立化批①：summary/sessionMemory 组已摘除（协议契约变更）——
  //    总结配置迁 config.set_summary（summary.* 通用域）；steward.set_config
  //    构造器类型面即拒收旧组（携带旧组 = 编译不过）──
  it("configSetSummaryCommand：总结配置组透传（部分更新——携带项写入）", () => {
    expect(configSetSummaryCommand({ enabled: true })).toEqual({
      v: PROTOCOL_VERSION,
      type: "config.set_summary",
      payload: { enabled: true },
    });
    expect(
      configSetSummaryCommand({ everyTurns: 5, model: "deepseek/summary-flash", task: { enabled: true, model: null } }).payload,
    ).toEqual({ everyTurns: 5, model: "deepseek/summary-flash", task: { enabled: true, model: null } });
  });

  it("configSetSummaryCommand：model 空串/null = 清空槽位（显式解绑，不同于缺省不携带）", () => {
    expect(configSetSummaryCommand({ model: null }).payload).toEqual({ model: null });
    expect(configSetSummaryCommand({ task: { model: "" } }).payload).toEqual({ task: { model: "" } });
    expect(configSetSummaryCommand({}).payload).toEqual({});
  });

  it("config.get/set_voice_models：模型配置两构造器（模型配置接入 P0；部分更新 + 空串回落默认）", () => {
    expect(configGetVoiceModelsCommand()).toEqual({
      v: PROTOCOL_VERSION,
      type: "config.get_voice_models",
      payload: {},
    });
    expect(configSetVoiceModelsCommand({ sttModel: "custom-asr-v2" })).toEqual({
      v: PROTOCOL_VERSION,
      type: "config.set_voice_models",
      payload: { sttModel: "custom-asr-v2" },
    });
    expect(configSetVoiceModelsCommand({ ttsStreamModel: "" }).payload).toEqual({ ttsStreamModel: "" });
    expect(configSetVoiceModelsCommand({}).payload).toEqual({});
  });

  it("三槽位共存（摘组后）：enabled + model + memory 同时携带互不覆盖", () => {
    const cmd = stewardSetConfigCommand({
      enabled: true,
      model: "openai/gpt-5-mini",
      memory: { enabled: false },
    });
    expect(cmd.payload).toEqual({
      enabled: true,
      model: "openai/gpt-5-mini",
      memory: { enabled: false },
    });
  });
});

// ── 管家记忆 B2：memory_* 四命令 + embedding 四命令构造器 ──

describe("stewardCancelCommand（B1 两段式确认批）", () => {
  it("最小帧：type + actionId 透传", () => {
    expect(stewardCancelCommand("act-9")).toEqual({
      v: PROTOCOL_VERSION,
      type: "steward.cancel",
      payload: { actionId: "act-9" },
    });
  });
});

describe("steward memory_* / embedding.* 构造器（管家记忆 B2）", () => {
  it("steward.memory_list：零载荷", () => {
    expect(stewardMemoryListCommand()).toEqual({ v: PROTOCOL_VERSION, type: "steward.memory_list", payload: {} });
  });

  it("steward.memory_append：kind/domain/projectScope 缺省不携带键；携带时逐字段透传（TR-159 命令写路径）", () => {
    expect(stewardMemoryAppendCommand("手动记一条")).toEqual({ v: PROTOCOL_VERSION, type: "steward.memory_append", payload: { text: "手动记一条" } });
    expect(stewardMemoryAppendCommand("偏好", "preference").payload).toEqual({ text: "偏好", kind: "preference" });
    // domain 维度批：domain + projectScope 逐字段透传（漏登即静默剥成缺省）
    expect(stewardMemoryAppendCommand("项目事实", "fact", "project", "helix").payload).toEqual({
      text: "项目事实",
      kind: "fact",
      domain: "project",
      projectScope: "helix",
    });
    expect(stewardMemoryAppendCommand("通用事实", "fact", "general").payload).toEqual({
      text: "通用事实",
      kind: "fact",
      domain: "general",
    });
  });

  it("steward.memory_update / memory_delete：id + text / id 最小帧", () => {
    expect(stewardMemoryUpdateCommand(2, "改").payload).toEqual({ id: 2, text: "改" });
    expect(stewardMemoryDeleteCommand(2).payload).toEqual({ id: 2 });
  });

  it("embedding.set：新增形态（id 缺省不携带）/ 更新形态（id + apiKey 空串清除）", () => {
    expect(embeddingSetCommand({ name: "Ollama", baseUrl: "http://localhost:11434/v1", model: "bge-m3" }).payload).toEqual({
      name: "Ollama",
      baseUrl: "http://localhost:11434/v1",
      model: "bge-m3",
    });
    expect(embeddingSetCommand({ id: "ep-1", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "m" }).payload).toEqual({
      id: "ep-1",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "m",
    });
  });

  it("embedding.set：variant 透传 + pi-ai 目录形态免 baseUrl（分类 tab 链路守护）", () => {
    expect(embeddingSetCommand({ name: "目录判官", model: "typesafe/jev-latest", kind: "classifier", variant: "pi-ai" }).payload).toEqual({
      name: "目录判官",
      model: "typesafe/jev-latest",
      kind: "classifier",
      variant: "pi-ai",
    });
    expect(embeddingSetCommand({ id: "ep-3", name: "Jev", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", kind: "classifier", variant: "jev" }).payload).toEqual({
      id: "ep-3",
      name: "Jev",
      baseUrl: "https://api.typesafe.ai/v1",
      model: "jev-latest",
      kind: "classifier",
      variant: "jev",
    });
  });

  it("embedding.list / delete / verify：最小帧", () => {
    expect(embeddingListCommand()).toEqual({ v: PROTOCOL_VERSION, type: "embedding.list", payload: {} });
    expect(embeddingDeleteCommand("ep-1").payload).toEqual({ id: "ep-1" });
    expect(embeddingVerifyCommand("ep-1").payload).toEqual({ id: "ep-1" });
  });
});

// ── 网络代理批：config.get/set_proxy 构造器（全局命令，省略 sessionId）──
describe("config.proxy 族构造器（网络代理批）", () => {
  it("configGetProxyCommand：全局命令（无 sessionId）+ 空载荷", () => {
    const cmd = configGetProxyCommand();
    expect(cmd.type).toBe("config.get_proxy");
    expect(cmd.v).toBe(PROTOCOL_VERSION);
    expect(cmd.sessionId).toBeUndefined();
    expect(cmd.payload).toEqual({});
  });

  it("configSetProxyCommand：部分更新载荷原样透传（只带携带项）", () => {
    expect(configSetProxyCommand({ enabled: true }).payload).toEqual({ enabled: true });
    expect(configSetProxyCommand({ url: "http://127.0.0.1:7890" }).payload).toEqual({ url: "http://127.0.0.1:7890" });
    const both = configSetProxyCommand({ enabled: false, url: "" });
    expect(both.type).toBe("config.set_proxy");
    expect(both.payload).toEqual({ enabled: false, url: "" });
    expect(both.sessionId).toBeUndefined();
  });
});
