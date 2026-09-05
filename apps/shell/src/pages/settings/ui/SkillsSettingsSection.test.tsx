// @vitest-environment jsdom
/**
 * settings skills 分区组件测试（单源管理裁决批；AgentPage.test 先例：
 * vi.mock SessionContext，帧注入 = 捕获的订阅回调直接回放）。
 *
 * 机械判据：
 * ① 进分区拉取：mount → agent.config.list 一次；list.result 双块 →
 *    只渲染 user 源技能行（builtin 不进管理面）；双 kind 启停位徽标
 *    （禁用位 = hud-chip-off）；
 * ② 空态：无 user 技能 → 空态引导文案（目录指引）；
 * ③ 正文 md 渲染流：点查看 → agent.skill_content.get({name}) → 回执
 *    （SKILL.md 全文含 frontmatter）→ frontmatter 剥离 + 文档元素渲染
 *    （h2 标题/代码块 .md-code；文档语义无 breaks）+ 再点收起；
 * ④ 纯函数：stripFrontmatter（无 frontmatter 原样/有则剥离）+
 *    mergeUserSkillRows（双块按名合并、sub 独有行兜底）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AgentConfigListResultPayload, EventEnvelope } from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";
import { I18nProvider } from "@/shared/i18n";
import { stripFrontmatter, mergeUserSkillRows } from "./SkillsSettingsSection";

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      sendAgentConfigList: () => {
        mock.sentList += 1;
        return true;
      },
      sendAgentSkillContentGet: (call: { name: string }) => {
        mock.sentContentGet.push(call.name);
        return true;
      },
      subscribeAgentConfigFrames: (listener: (frame: EventEnvelope) => void) => {
        mock.listener = listener;
        return () => {};
      },
    }),
  };
});

const mock = vi.hoisted(() => ({
  sentList: 0,
  sentContentGet: [] as string[],
  listener: ((_frame: EventEnvelope) => {}) as (frame: EventEnvelope) => void,
}));

import SkillsSettingsSection from "./SkillsSettingsSection";

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，SettingsPage.test 同款）
localStorage.setItem("helix-lang", "zh-CN");

afterEach(() => {
  cleanup();
  mock.sentList = 0;
  mock.sentContentGet = [];
});

const listPayload: AgentConfigListResultPayload = {
  profiles: [
    {
      profileKind: "main-session",
      tools: [],
      skills: [
        { name: "hello-skill", description: "问候技能", filePath: "/home/dev/.helix/skills/hello-skill/SKILL.md", source: "user", audience: "agent", enabled: true },
        { name: "deploy-helper", description: "部署向导", filePath: "/home/dev/.helix/skills/deploy-helper/SKILL.md", source: "user", audience: "agent", enabled: false },
        { name: "web-access", description: "联网操作指引", filePath: "/daemon/resources/skills/agent/web-access/SKILL.md", source: "builtin", audience: "agent", enabled: true },
      ],
      diagnostics: [],
      model: null,
      thinkingLevel: null,
    },
    {
      profileKind: "subagent-worker",
      tools: [],
      skills: [
        { name: "hello-skill", description: "问候技能", filePath: "/home/dev/.helix/skills/hello-skill/SKILL.md", source: "user", audience: "agent", enabled: true },
        { name: "deploy-helper", description: "部署向导", filePath: "/home/dev/.helix/skills/deploy-helper/SKILL.md", source: "user", audience: "agent", enabled: true },
      ],
      diagnostics: [],
      model: null,
      thinkingLevel: null,
    },
  ],
};

function frameOf(type: string, payload: unknown): EventEnvelope {
  return { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "agent", type, ts: 1, payload } as EventEnvelope;
}

function mount() {
  return render(
    <I18nProvider>
      <SkillsSettingsSection />
    </I18nProvider>,
  );
}

describe("SkillsSettingsSection（settings skills 分区）", () => {
  it("① 进分区拉取：list 一次 → 仅 user 源行渲染（builtin 不进管理面）+ 双 kind 启停徽标", async () => {
    mount();
    expect(mock.sentList).toBe(1);

    mock.listener(frameOf("agent.config.list.result", listPayload));

    await waitFor(() => {
      expect(document.querySelector('[data-skill-row="hello-skill"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-skill-row="deploy-helper"]')).not.toBeNull();
    // builtin 层不可管理不展示
    expect(document.querySelector('[data-skill-row="web-access"]')).toBeNull();
    // 双 kind 启停徽标：main 禁用 deploy-helper → hud-chip-off；sub 启用无弱化
    const deployEntry = document.querySelector('[data-skill-entry="deploy-helper"]')!;
    const chips = deployEntry.querySelectorAll(".hud-chip");
    expect(chips.length).toBe(2);
    expect(chips[0]!.className).toContain("hud-chip-off");
    expect(chips[0]!.textContent).toContain("已禁用");
    expect(chips[1]!.className).not.toContain("hud-chip-off");
  });

  it("② 空态：无 user 技能 → 引导文案", async () => {
    mount();
    mock.listener(frameOf("agent.config.list.result", { profiles: [{ ...listPayload.profiles[0]!, skills: [] }] }));
    await waitFor(() => {
      expect(document.querySelector("[data-skills-empty]")).not.toBeNull();
    });
    expect(document.querySelector("[data-skills-empty]")!.textContent).toContain("~/.helix/skills");
  });

  it("③ 正文 md 渲染流：查看 → skill_content.get → frontmatter 剥离 + 文档元素渲染 + 收起", async () => {
    mount();
    mock.listener(frameOf("agent.config.list.result", listPayload));
    await waitFor(() => {
      expect(document.querySelector('[data-skill-row="hello-skill"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('[data-skill-content-toggle="hello-skill"]')!);
    expect(mock.sentContentGet).toEqual(["hello-skill"]);

    mock.listener(
      frameOf("agent.skill_content.get.result", {
        name: "hello-skill",
        filePath: "/home/dev/.helix/skills/hello-skill/SKILL.md",
        content: "---\nname: hello-skill\ndescription: 问候技能\n---\n\n## 使用指南\n\n正文段落。\n\n```bash\necho hi\n```\n",
      }),
    );

    await waitFor(() => {
      expect(document.querySelector("[data-skill-doc]")).not.toBeNull();
    });
    const doc = document.querySelector("[data-skill-doc]")!;
    // frontmatter 剥离（yaml 头不渲染）
    expect(doc.textContent).not.toContain("name: hello-skill");
    // md 文档元素：h2 标题 + 代码块卡（全局 .md-code）
    expect(doc.querySelector("h2")!.textContent).toBe("使用指南");
    expect(doc.querySelector(".md-code")).not.toBeNull();
    expect(doc.querySelector(".md-code pre")!.textContent).toContain("echo hi");

    // 收起
    fireEvent.click(document.querySelector('[data-skill-content-toggle="hello-skill"]')!);
    expect(document.querySelector("[data-skill-doc]")).toBeNull();
  });
});

describe("stripFrontmatter / mergeUserSkillRows（纯函数）", () => {
  it("④a stripFrontmatter：frontmatter 块剥离；无块原样；CRLF 归一", () => {
    expect(stripFrontmatter("---\nname: a\n---\n\n正文")).toBe("正文");
    expect(stripFrontmatter("## 直接正文")).toBe("## 直接正文");
    expect(stripFrontmatter("---\r\nname: a\r\n---\r\n\r\n正文")).toBe("正文");
    // 无闭合块（残缺）→ 原样不误剥
    expect(stripFrontmatter("---\nname: a\n\n正文")).toBe("---\nname: a\n\n正文");
  });

  it("④b mergeUserSkillRows：双块按名合并 + sub 独有行兜底 + builtin 剔除", () => {
    const rows = mergeUserSkillRows(listPayload);
    expect(rows.map((r) => r.name).sort()).toEqual(["deploy-helper", "hello-skill"]);
    const deploy = rows.find((r) => r.name === "deploy-helper")!;
    expect(deploy.enabledMain).toBe(false);
    expect(deploy.enabledSub).toBe(true);
    // sub 独有行兜底（main 缺行 = 默认启用 + 描述取自 sub）
    const subOnly = mergeUserSkillRows({
      profiles: [
        { ...listPayload.profiles[0]!, skills: [] },
        listPayload.profiles[1]!,
      ],
    });
    expect(subOnly.find((r) => r.name === "hello-skill")!.enabledMain).toBe(true);
  });
});
