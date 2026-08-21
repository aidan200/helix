/**
 * 命令构造器单测 —— chatSendDraftCommand 草稿建会话模型参数（T3，bug4 发送链）。
 *
 * 契约（packages/protocol ChatSendPayload.model?，T4 已落地）：model 仅
 * draft:true 建会话链消费；缺省 = 全局默认（payload 不携带 model 键）。
 */
import { describe, expect, it } from "vitest";
import { chatSendCommand, chatSendDraftCommand } from "./commands";

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
