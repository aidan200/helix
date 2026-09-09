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
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
      sendAgentSkillCreate: (call: { content: string }) => {
        mock.sentCreate.push(call.content);
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
  sentCreate: [] as string[],
  listener: ((_frame: EventEnvelope) => {}) as (frame: EventEnvelope) => void,
}));

import SkillsSettingsSection from "./SkillsSettingsSection";

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，SettingsPage.test 同款）
localStorage.setItem("helix-lang", "zh-CN");

afterEach(() => {
  cleanup();
  mock.sentList = 0;
  mock.sentContentGet = [];
  mock.sentCreate = [];
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
    // sub 独有行兜底（main 缺行 → 保守报禁（TR-125 user 技能显式启用制，
    // W3 #2.32：缺省回落 true 会误报「启用」）+ 描述取自 sub）
    const subOnly = mergeUserSkillRows({
      profiles: [
        { ...listPayload.profiles[0]!, skills: [] },
        listPayload.profiles[1]!,
      ],
    });
    expect(subOnly.find((r) => r.name === "hello-skill")!.enabledMain).toBe(false);
  });
});

describe("SkillsSettingsSection 添加表单（skills 添加批：两渠道创建流）", () => {
  it("⑤ 表单渠道：三字段 → 拼装 frontmatter 全文发送 → applied 回执 → 表单收起 + 重拉 list", async () => {
    mount();
    mock.listener(frameOf("agent.config.list.result", listPayload));
    await waitFor(() => {
      expect(document.querySelector('[data-skill-row="hello-skill"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector("[data-skills-add-toggle]")!);
    const form = document.querySelector("[data-skills-form]")!;
    expect(form).not.toBeNull();

    fireEvent.change(document.querySelector("[data-skills-name]")!, { target: { value: "my-skill" } });
    fireEvent.change(document.querySelector("[data-skills-desc]")!, { target: { value: "测试技能" } });
    fireEvent.change(document.querySelector("[data-skills-body]")!, { target: { value: "## 正文\n\n内容。" } });
    fireEvent.click(document.querySelector("[data-skills-submit]")!);

    // 拼装全文：frontmatter（description 双引号安全）+ 正文
    expect(mock.sentCreate).toEqual(['---\nname: my-skill\ndescription: "测试技能"\n---\n\n## 正文\n\n内容。\n']);
    const listCalls = mock.sentList;
    mock.listener(frameOf("agent.skill.create.result", { status: "applied", name: "my-skill" }));
    await waitFor(() => {
      expect(mock.sentList).toBe(listCalls + 1); // applied → 重拉清单收口
    });
    await waitFor(() => {
      expect(document.querySelector("[data-skills-form]")).toBeNull(); // 表单收起
    });
  });

  it("⑥ 文件渠道：导入 SKILL.md 原文填充 → 原样发送；skipped(already-exists) → 行内错误不收表单", async () => {
    mount();
    mock.listener(frameOf("agent.config.list.result", listPayload));
    await waitFor(() => {
      expect(document.querySelector('[data-skill-row="hello-skill"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector("[data-skills-add-toggle]")!);
    fireEvent.click(document.querySelector('[data-skills-mode-tab="file"]')!);
    const raw = "---\nname: imported\ndescription: 导入技能\n---\n\n正文";
    const file = new File([raw], "imported.md", { type: "text/markdown" });
    fireEvent.change(document.querySelector("[data-skills-file]")!, { target: { files: [file] } });
    await waitFor(() => {
      expect((document.querySelector("[data-skills-file-name]") as HTMLElement | null)?.textContent).toContain("imported.md");
    });

    fireEvent.click(document.querySelector("[data-skills-submit]")!);
    expect(mock.sentCreate).toEqual([raw]); // 原文直发（前端零解析）

    mock.listener(frameOf("agent.skill.create.result", { status: "skipped", reason: "already-exists" }));
    await waitFor(() => {
      expect((document.querySelector("[data-skills-form-error]") as HTMLElement | null)?.textContent).toContain("已存在");
    });
    expect(document.querySelector("[data-skills-form]")).not.toBeNull(); // skipped 不收表单（可修正重试）
  });
});

describe("M10 批①：协议层失败回执（connection.error）清在途 + 行内错误交代", () => {
  it("创建在途收 connection.error → addPending 清（提交钮复用）+ 表单错误交代", async () => {
    mount();
    mock.listener(frameOf("agent.config.list.result", listPayload));
    await waitFor(() => {
      expect(document.querySelector('[data-skill-row="hello-skill"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector("[data-skills-add-toggle]")!);
    fireEvent.change(document.querySelector("[data-skills-name]")!, { target: { value: "my-skill" } });
    fireEvent.change(document.querySelector("[data-skills-desc]")!, { target: { value: "测试技能" } });
    fireEvent.change(document.querySelector("[data-skills-body]")!, { target: { value: "## 正文" } });
    fireEvent.click(document.querySelector("[data-skills-submit]")!);
    expect(mock.sentCreate.length).toBe(1);
    // 在途：提交钮 disabled（addPending）
    expect((document.querySelector("[data-skills-submit]") as HTMLButtonElement).disabled).toBe(true);

    // daemon commandError 走 connection.error（无 skill.create.result 帧）
    act(() => {
      mock.listener(frameOf("connection.error", { code: "skill.invalid", message: "frontmatter 解析失败" }));
    });
    // 在途清：提交钮不再永久 disabled + 行内错误交代（表单不收，可修正重试）
    expect((document.querySelector("[data-skills-submit]") as HTMLButtonElement).disabled).toBe(false);
    expect((document.querySelector("[data-skills-form-error]") as HTMLElement | null)?.textContent).toContain("frontmatter 解析失败");
    expect(document.querySelector("[data-skills-form]")).not.toBeNull();
  });

  it("正文懒查询在途收 connection.error → pending 清（查看钮复用）+ 错误面交代；重试重发", async () => {
    mount();
    mock.listener(frameOf("agent.config.list.result", listPayload));
    await waitFor(() => {
      expect(document.querySelector('[data-skill-row="hello-skill"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('[data-skill-content-toggle="hello-skill"]')!);
    expect(mock.sentContentGet).toEqual(["hello-skill"]);
    // 在途：查看钮 disabled
    expect((document.querySelector('[data-skill-content-toggle="hello-skill"]') as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      mock.listener(frameOf("connection.error", { code: "skill.not_found", message: "技能不存在" }));
    });
    // pending 清：钮复用 + 错误面（非永久 loading）
    const toggle = document.querySelector('[data-skill-content-toggle="hello-skill"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(document.querySelector("[data-skill-content-error]")?.textContent).toContain("技能不存在");
    expect(document.querySelector('[role="status"]')).toBeNull();

    // 重试：收起 → 再查看 = 重发（错误面随重开清）
    fireEvent.click(toggle);
    expect(document.querySelector("[data-skill-content-error]")).toBeNull(); // 面板收起
    fireEvent.click(document.querySelector('[data-skill-content-toggle="hello-skill"]')!);
    expect(mock.sentContentGet).toEqual(["hello-skill", "hello-skill"]);
    expect(document.querySelector("[data-skill-content-error]")).toBeNull();
  });

  it("单飞门控：无在途时 connection.error 不消费（无错误面、无状态扰动）", async () => {
    mount();
    mock.listener(frameOf("agent.config.list.result", listPayload));
    await waitFor(() => {
      expect(document.querySelector('[data-skill-row="hello-skill"]')).not.toBeNull();
    });
    act(() => {
      mock.listener(frameOf("connection.error", { code: "task.not_found", message: "job 不存在" }));
    });
    expect(document.querySelector("[data-skill-content-error]")).toBeNull();
    expect(document.querySelector("[data-skills-form-error]")).toBeNull();
    // 查看钮仍可用（未被误清/误锁）
    expect((document.querySelector('[data-skill-content-toggle="hello-skill"]') as HTMLButtonElement).disabled).toBe(false);
  });
});
