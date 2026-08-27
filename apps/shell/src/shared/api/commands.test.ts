/**
 * 命令构造器单测 —— chatSendDraftCommand 草稿建会话模型参数（T3，bug4 发送链）。
 *
 * 契约（packages/protocol ChatSendPayload.model?，T4 已落地）：model 仅
 * draft:true 建会话链消费；缺省 = 全局默认（payload 不携带 model 键）。
 */
import { describe, expect, it } from "vitest";
import { chatSendCommand, chatSendDraftCommand, thinkingSetCommand, workspaceGetCommand, workspaceOpenCommand } from "./commands";

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
