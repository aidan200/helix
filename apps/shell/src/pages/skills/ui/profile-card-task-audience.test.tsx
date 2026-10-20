// @vitest-environment jsdom
/**
 * ProfileCard 技能开关 · audience=task 恒失败控件消除（F3a 续修）。
 * 钉住：可写 kind 卡上出现 audience="task"（任务 SOP）技能行时开关置灰——
 * daemon 写面 ResourceService.setEnabled 对 task 受众恒 skipped（audience-guard），
 * 原实现只按 writePending/readOnly 置灰 → 可写卡上会给出必失败控件。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { AgentConfigProfileBlock } from "@helix/protocol";
import { I18nProvider } from "@/shared/i18n";
import ProfileCard from "@/pages/skills/ui/ProfileCard";

localStorage.setItem("helix-lang", "zh-CN");
afterEach(() => cleanup());

function blockWith(skills: AgentConfigProfileBlock["skills"]): AgentConfigProfileBlock {
  return {
    profileKind: "main-session",
    tools: [],
    skills,
    diagnostics: [],
    model: null,
    thinkingLevel: null,
  };
}

function renderCard(onToggle: (kind: string, rt: string, name: string, enabled: boolean) => void) {
  return render(
    <I18nProvider>
      <ProfileCard
        kind="main-session"
        block={blockWith([
          {
            name: "agent-skill",
            description: "行为技能",
            filePath: "/x/agent-skill/SKILL.md",
            source: "user",
            audience: "agent",
            enabled: true,
          },
          {
            name: "code-review",
            description: "任务 SOP",
            filePath: "/daemon/resources/skills/task/code-review/SKILL.md",
            source: "builtin",
            audience: "task",
            enabled: false,
          },
        ])}
        skeleton={false}
        catalog={null}
        defaultModel={undefined}
        auth={{}}
        authLoaded={false}
        writePending={false}
        onToggle={onToggle as never}
        onModelChange={() => {}}
        basePrompt={null}
        skillContents={{}}
        skillContentPending={new Set<string>()}
        skillContentOpen={null}
        onSkillContentToggle={() => {}}
      />
    </I18nProvider>,
  );
}

describe("ProfileCard · MCP 归属（工具组 vs server 组）", () => {
  /** 带 MCP server + 三类工具（真 MCP 归属 / 名字含 __ 但无 server 归属 / 普通）。 */
  function renderMcp() {
    const block: AgentConfigProfileBlock = {
      profileKind: "main-session",
      mcpServers: [{ name: "codegraph", state: "running", enabled: true, toolCount: 1 } as never],
      tools: [
        { name: "codegraph__search", snippet: "MCP 工具", enabled: false },
        { name: "my_tool__v2", snippet: "普通工具（名里带双下划线）", enabled: false },
        { name: "bash", snippet: "普通工具", enabled: false },
      ],
      skills: [],
      diagnostics: [],
      model: null,
      thinkingLevel: null,
    } as AgentConfigProfileBlock;
    return render(
      <I18nProvider>
        <ProfileCard
          kind="main-session"
          block={block}
          skeleton={false}
          catalog={null}
          defaultModel={undefined}
          auth={{}}
          authLoaded={false}
          writePending={false}
          onToggle={() => {}}
          onModelChange={() => {}}
          basePrompt={null}
          skillContents={{}}
          skillContentPending={new Set<string>()}
          skillContentOpen={null}
          onSkillContentToggle={() => {}}
        />
      </I18nProvider>,
    );
  }

  it("归属按 server 前缀判（非裸 includes \"__\"）：无归属的 __ 工具不丢行", () => {
    const { container } = renderMcp();
    // MCP 归属行在 server 组
    expect(container.querySelector('[data-mcp-server="codegraph"] [data-mcp-server-row]')).not.toBeNull();
    // 工具组：含普通工具 + 名字带 __ 但无 server 归属的工具（旧实现会被 includes("__") 吞掉）
    expect(container.querySelector('[data-tool-row="bash"]')).not.toBeNull();
    expect(container.querySelector('[data-tool-row="my_tool__v2"]')).not.toBeNull();
    // MCP 归属工具只在 server 组渲染（带 sub 变体），不再进「工具」组
    const mcpRow = container.querySelector('[data-tool-row="codegraph__search"]')!;
    expect(mcpRow.closest("[data-mcp-server]")).not.toBeNull();
    expect(container.querySelectorAll('[data-tool-row="codegraph__search"]')).toHaveLength(1); // 不重复出现
  });
});

describe("ProfileCard · audience=task 技能开关", () => {
  it("task 受众行开关置灰且点击不触发写命令（可写卡亦然）", () => {
    const onToggle = vi.fn();
    const { container } = renderCard(onToggle);
    const taskSwitch = container.querySelector('[data-switch="code-review"]') as HTMLButtonElement;
    expect(taskSwitch.disabled).toBe(true);
    fireEvent.click(taskSwitch);
    expect(onToggle).not.toHaveBeenCalled();
    // 对照面：agent 受众行照常可点（证明不是整卡禁用）
    const agentSwitch = container.querySelector('[data-switch="agent-skill"]') as HTMLButtonElement;
    expect(agentSwitch.disabled).toBe(false);
    fireEvent.click(agentSwitch);
    expect(onToggle).toHaveBeenCalledWith("main-session", "skill", "agent-skill", false);
  });
});
