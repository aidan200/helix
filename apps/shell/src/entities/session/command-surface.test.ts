/**
 * LISTEN_SURFACE 帧匹配谓词存在性测试（skill-content 批教训回归）。
 *
 * 背景：agent.skill_content.get.result 曾漏登 subscribeAgentConfigFrames
 * 谓词——页面测试 mock 了 subscribe 函数直通回调，真实谓词无测试，导致
 * daemon 回执到达但页面收不到（"正在读取" 卡死）。本测试钉住各域谓词的
 * 应转发/应拦截帧清单，新增点对点回执必须同步登谓词。
 */
import { describe, expect, it } from "vitest";
import { LISTEN_SURFACE } from "./command-surface";

describe("LISTEN_SURFACE.subscribeAgentConfigFrames", () => {
  const { match } = LISTEN_SURFACE.subscribeAgentConfigFrames;

  it("转发 agent.config 族全部点对点回执", () => {
    expect(match("agent.config.list.result")).toBe(true);
    expect(match("agent.config.set_enabled.result")).toBe(true);
    expect(match("agent.base_prompt.get.result")).toBe(true);
    expect(match("agent.skill_content.get.result")).toBe(true);
    expect(match("agent.skill.create.result")).toBe(true); // skills 添加批
  });

  it("不转发 changed 广播与其他域帧", () => {
    expect(match("agent.config.changed")).toBe(false);
    expect(match("kg.search.result")).toBe(false);
    expect(match("task.list.result")).toBe(false);
    expect(match("trace.query.result")).toBe(false);
  });
});

describe("LISTEN_SURFACE.subscribeMcpFrames", () => {
  const { match } = LISTEN_SURFACE.subscribeMcpFrames;

  it("转发 mcp 族全部点对点回执 + 状态广播 + connection.error", () => {
    expect(match("mcp.servers.list.result")).toBe(true);
    expect(match("mcp.servers.add.result")).toBe(true);
    expect(match("mcp.servers.update.result")).toBe(true);
    expect(match("mcp.servers.remove.result")).toBe(true);
    expect(match("mcp.servers.test.result")).toBe(true);
    expect(match("mcp.tools.list.result")).toBe(true);
    expect(match("mcp.status.changed")).toBe(true);
    expect(match("connection.error")).toBe(true);
  });

  it("不转发其他域帧", () => {
    expect(match("web.status.changed")).toBe(false);
    expect(match("agent.config.list.result")).toBe(false);
    expect(match("task.list.result")).toBe(false);
  });
});
