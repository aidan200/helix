// @vitest-environment jsdom
/**
 * 管家记忆独立页测试（B2-④）：
 * - 头部：搜索框（前端过滤）+ 统计「N 条 · dim 维」+ 端点徽标 + 新增入口
 *   （不可用态禁用 + 提示）；
 * - 列表（memory_list.result 驱动）：text/kind 徽标/来源轮次；
 * - 行内编辑：保存 → sendStewardMemoryUpdate（向量化中异步态）→ 新清单回执清态；
 * - armed 删除 + 新增弹窗（text + kind 下拉 → sendStewardMemoryAppend）。
 *
 * vi.mock SessionContext 先例（EmbeddingModelsTab.test.tsx）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";

const sendStewardMemoryList = vi.fn(() => true);
const sendStewardMemoryAppend = vi.fn(() => true);
const sendStewardMemoryUpdate = vi.fn(() => true);
const sendStewardMemoryDelete = vi.fn(() => true);
const sendStewardMemoryPin = vi.fn(() => true);
const sendStewardMemoryRestore = vi.fn(() => true);
const sendStewardGetConfig = vi.fn(() => true);
let stewardListeners: ((e: EventEnvelope) => void)[] = [];

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      sendStewardMemoryList,
      sendStewardMemoryAppend,
      sendStewardMemoryUpdate,
      sendStewardMemoryDelete,
      sendStewardMemoryPin,
      sendStewardMemoryRestore,
      sendStewardGetConfig,
      subscribeStewardFrames: (listener: (e: EventEnvelope) => void) => {
        stewardListeners.push(listener);
        return () => {
          stewardListeners = stewardListeners.filter((l) => l !== listener);
        };
      },
    }),
  };
});

vi.mock("@/widgets/app-layout/ui/AppLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import StewardMemoryPage from "./StewardMemoryPage";

beforeEach(() => {
  localStorage.setItem("helix-lang", "zh-CN");
});

afterEach(() => {
  cleanup();
  stewardListeners = [];
  vi.clearAllMocks();
});

const ENTRIES = [
  { id: 1, text: "用户偏好简洁回复", kind: "preference", createdAt: 1_760_000_000_000, sourceTurn: "manual" },
  { id: 2, text: "主技术栈：TypeScript + React", kind: "fact", createdAt: 1_760_001_000_000, sourceTurn: "steward-turn" },
];

function feedList(entries: typeof ENTRIES) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "steward",
    type: "steward.memory_list.result",
    ts: 1,
    payload: { entries },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of stewardListeners) l(frame);
  });
}

function feedConfig(available: boolean) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "steward",
    type: "steward.config.result",
    ts: 1,
    payload: {
      enabled: true,
      model: "deepseek/x",
      memory: {
        enabled: true,
        available,
        entryCount: ENTRIES.length,
        dim: 1024,
      },
    },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of stewardListeners) l(frame);
  });
}

function ui() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <StewardMemoryPage path="/steward/memory" />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe("管家记忆独立页（B2-④）", () => {
  it("进入拉取：memory_list + get_config；头部统计 + 条目渲染", () => {
    const { container } = ui();
    expect(sendStewardMemoryList).toHaveBeenCalledTimes(1);
    expect(sendStewardGetConfig).toHaveBeenCalledTimes(1);
    feedConfig(true);
    act(() => feedList(ENTRIES));
    expect(container.querySelector("[data-memory-stats]")!.textContent).toContain("1024");
    expect(container.querySelector('[data-memory-item-text="1"]')!.textContent).toBe("用户偏好简洁回复");
    expect(container.querySelector('[data-memory-item-kind="1"]')!.textContent).toContain("偏好");
    expect(container.querySelector('[data-memory-item-kind="2"]')!.textContent).toContain("事实");
    expect(container.querySelector('[data-memory-item-meta="2"]')!.textContent).toContain("对话记录");
  });

  it("搜索过滤：前端子串过滤（大小写不敏感）", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(ENTRIES));
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-memory-search]")!, { target: { value: "typescript" } });
    expect(container.querySelector('[data-memory-item="1"]')).toBeNull();
    expect(container.querySelector('[data-memory-item="2"]')).not.toBeNull();
  });

  it("不可用态：新增/编辑禁用 + 提示行（available false——批1：无默认端点即不可用）", () => {
    const { container } = ui();
    feedConfig(false);
    act(() => feedList(ENTRIES));
    expect(container.querySelector<HTMLButtonElement>("[data-memory-add-open]")!.disabled).toBe(true);
    expect(container.querySelector("[data-memory-unavailable]")!).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-memory-edit-btn="1"]')!.disabled).toBe(true);
  });

  it("行内编辑：进入编辑态 → 保存 sendStewardMemoryUpdate + 向量化中态 → 新清单清态", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(ENTRIES));
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-memory-edit-btn="1"]')!);
    const input = container.querySelector<HTMLInputElement>("[data-memory-edit-input]")!;
    expect(input.value).toBe("用户偏好简洁回复");
    fireEvent.change(input, { target: { value: "改写后的记忆" } });
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-edit-save]")!);
    expect(sendStewardMemoryUpdate).toHaveBeenCalledWith(1, "改写后的记忆");
    expect(container.querySelector("[data-memory-edit-input]")).toBeNull(); // 编辑态退出（在途）
    // 新清单回执到达 → 正常渲染新文本
    act(() => feedList([{ ...ENTRIES[0]!, text: "改写后的记忆" }, ENTRIES[1]!]));
    expect(container.querySelector('[data-memory-item-text="1"]')!.textContent).toBe("改写后的记忆");
  });

  it("armed 删除：首击 armed → 二击 sendStewardMemoryDelete", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(ENTRIES));
    const del = container.querySelector<HTMLButtonElement>('[data-memory-delete-btn="1"]')!;
    fireEvent.click(del);
    expect(sendStewardMemoryDelete).not.toHaveBeenCalled();
    expect(del.dataset.armed).toBe("1");
    fireEvent.click(del);
    expect(sendStewardMemoryDelete).toHaveBeenCalledWith(1);
  });

  it("新增弹窗：空文本内联错误 → text + kind → sendStewardMemoryAppend", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(ENTRIES));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-add-open]")!);
    expect(container.querySelector("[data-memory-add-input]")).not.toBeNull();
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-add-save]")!);
    expect(container.querySelector("[data-memory-add-err]")!.textContent).toContain("不得为空");
    expect(sendStewardMemoryAppend).not.toHaveBeenCalled();
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-memory-add-input]")!, { target: { value: "手动新增一条" } });
    fireEvent.change(container.querySelector<HTMLSelectElement>("[data-memory-add-kind]")!, { target: { value: "preference" } });
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-add-save]")!);
    expect(sendStewardMemoryAppend).toHaveBeenCalledWith("手动新增一条", "preference", "general", undefined);
    expect(container.querySelector("[data-memory-add-input]")).toBeNull(); // 弹窗关闭（向量化在途）
  });

  it("空列表空态提示", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList([]));
    expect(container.querySelector("[data-memory-list-empty]")!.textContent).toContain("暂无记忆条目");
  });
});

// ── 遗忘机制批：筛选/排序/分页/faded·pin 接线 ───────────────────

describe("管家记忆独立页（遗忘机制批）", () => {
  const LIFE_ENTRIES = [
    { id: 1, text: "置顶的偏好", kind: "preference", createdAt: 1000, sourceTurn: "manual", updatedAt: 5000, lastRecalledAt: 4500, recallCount: 3, faded: false, pinned: true },
    { id: 2, text: "活跃事实", kind: "fact", createdAt: 2000, sourceTurn: "steward-turn", updatedAt: 3000, lastRecalledAt: 0, recallCount: 0, faded: false, pinned: false },
    { id: 3, text: "淡忘条目", kind: "fact", createdAt: 3000, sourceTurn: "steward-turn", updatedAt: 3000, lastRecalledAt: 0, recallCount: 0, faded: true, pinned: false },
  ];

  it("生命周期字段渲染：被想起次数/最后想起/淡忘徽标/已置顶徽标；meta 零值段省略", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(LIFE_ENTRIES));
    // 置顶条：次数 + 最后想起 + 已置顶徽标 + pin 钮激活
    expect(container.querySelector('[data-memory-item-meta="1"]')!.textContent).toContain("被想起 3 次");
    expect(container.querySelector('[data-memory-item-meta="1"]')!.textContent).toContain("最后想起");
    expect(container.querySelector('[data-memory-item-pinnedchip="1"]')!.textContent).toContain("已置顶");
    // 零值条目：无被想起段（防零值噪音）
    expect(container.querySelector('[data-memory-item-meta="2"]')!.textContent).not.toContain("被想起");
    // 淡忘条：灰显 data-faded + 淡忘徽标 + 从未被想起 + 恢复钮
    expect(container.querySelector('[data-memory-item="3"]')!.getAttribute("data-faded")).toBe("1");
    expect(container.querySelector('[data-memory-item-faded="3"]')!.textContent).toContain("淡忘中");
    expect(container.querySelector('[data-memory-item-meta="3"]')!.textContent).toContain("从未被想起");
    expect(container.querySelector('[data-memory-restore-btn="3"]')).not.toBeNull();
    expect(container.querySelector('[data-memory-restore-btn="1"]')).toBeNull(); // 活跃条无恢复钮
  });

  it("筛选 chip：零值档隐藏；点淡忘 chip 只显示 faded 条目", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(LIFE_ENTRIES));
    // 淡忘=1 置顶=1 → 两 chip 在场
    expect(container.querySelector("[data-memory-filter='faded']")).not.toBeNull();
    expect(container.querySelector("[data-memory-filter='pinned']")).not.toBeNull();
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-filter='faded']")!);
    expect(container.querySelector('[data-memory-item="1"]')).toBeNull();
    expect(container.querySelector('[data-memory-item="3"]')).not.toBeNull();
    // 零值场景：无 faded 条目 → chip 隐藏
    act(() => feedList(LIFE_ENTRIES.filter((e) => e.id !== 3)));
    expect(container.querySelector("[data-memory-filter='faded']")).toBeNull();
  });

  it("pin/restore 接线：pin 钮 → sendStewardMemoryPin(id, !pinned)；恢复钮 → sendStewardMemoryRestore", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(LIFE_ENTRIES));
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-memory-pin-btn="1"]')!); // 已置顶 → 取消
    expect(sendStewardMemoryPin).toHaveBeenCalledWith(1, false);
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-memory-pin-btn="2"]')!); // 未置顶 → 置顶
    expect(sendStewardMemoryPin).toHaveBeenCalledWith(2, true);
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-memory-restore-btn="3"]')!);
    expect(sendStewardMemoryRestore).toHaveBeenCalledWith(3);
  });

  it("排序切换：最早创建 → createdAt 升序（覆盖服务端 updatedAt 降序缺省）", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(LIFE_ENTRIES));
    // 缺省 updatedAt 降序：5000/3000/3000 → id 1 在首（updatedAt 5000）；tie 回落不敏感此处仅断言切档后行为
    fireEvent.change(container.querySelector<HTMLSelectElement>("[data-memory-sort]")!, { target: { value: "created" } });
    const items = [...container.querySelectorAll("[data-memory-list] [data-memory-item]")];
    expect(items.map((el) => el.getAttribute("data-memory-item"))).toEqual(["1", "2", "3"]); // createdAt 升序
  });

  it("客户端分页：超一页时页码条在场，翻页切片；搜索重置回第 1 页；总页数 ≤1 隐藏", () => {
    const { container } = ui();
    feedConfig(true);
    // 3 条 + 每页 2（无法直接改 pageSize——用 105 条跨 3 页（缺省 50））
    const many = Array.from({ length: 105 }, (_, i) => ({
      id: i + 1, text: `条目${i + 1}`, kind: "fact" as const, createdAt: i + 1, sourceTurn: "steward-turn", updatedAt: i + 1,
    }));
    act(() => feedList(many));
    // 缺省 updatedAt 降序 → 首条是 id 105；第 1 页 = 105..56
    expect(container.querySelector('[data-memory-item="105"]')).not.toBeNull();
    expect(container.querySelector('[data-memory-item="55"]')).toBeNull(); // 第 2 页
    expect(container.querySelector("[data-memory-pager]")).not.toBeNull();
    expect(container.querySelector("[data-memory-page-range]")!.textContent).toContain("共 105");
    // 翻到第 2 页
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-memory-page-btn="2"]')!);
    expect(container.querySelector('[data-memory-item="55"]')).not.toBeNull();
    expect(container.querySelector('[data-memory-item="105"]')).toBeNull();
    // 搜索重置回第 1 页（命中首条 105）
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-memory-search]")!, { target: { value: "条目10" } });
    expect(container.querySelector('[data-memory-item="105"]')).not.toBeNull(); // 第 1 页（过滤后唯一/前几位命中）
    // 清空搜索 → 回全量；页码条在单页场景隐藏（3 条）
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-memory-search]")!, { target: { value: "" } });
    act(() => feedList(many.slice(0, 3)));
    expect(container.querySelector("[data-memory-pager]")).toBeNull();
  });

  it("加载骨架：清单未达首帧渲染骨架行（非 spinner）", () => {
    const { container } = ui();
    feedConfig(true);
    expect(container.querySelectorAll(".memory-skeleton").length).toBe(3);
  });
});

// ── domain 维度批：source 四值映射 + kind×domain 双维筛选 + 徽标/打标 ──

describe("管家记忆独立页（domain 维度批）", () => {
  const DOMAIN_ENTRIES = [
    { id: 1, text: "手动习惯条目", kind: "preference", domain: "habit", createdAt: 1000, sourceTurn: "manual", updatedAt: 1000 },
    { id: 2, text: "对话事实条目", kind: "fact", domain: "general", createdAt: 2000, sourceTurn: "steward-turn", updatedAt: 2000 },
    { id: 3, text: "总结沉淀条目", kind: "preference", domain: "habit", createdAt: 3000, sourceTurn: "session-summary", updatedAt: 3000 },
    { id: 4, text: "会话进展条目", kind: "progress", domain: "project", createdAt: 4000, sourceTurn: "session-progress", updatedAt: 4000 },
  ];

  it("source 标签四值映射：manual→手动 / steward-turn→对话记录 / session-summary→总结沉淀 / session-progress→会话进展", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(DOMAIN_ENTRIES));
    expect(container.querySelector('[data-memory-item-meta="1"]')!.textContent).toContain("手动");
    expect(container.querySelector('[data-memory-item-meta="2"]')!.textContent).toContain("对话记录");
    expect(container.querySelector('[data-memory-item-meta="3"]')!.textContent).toContain("总结沉淀");
    expect(container.querySelector('[data-memory-item-meta="4"]')!.textContent).toContain("会话进展");
  });

  it("条目行 domain 徽标：习惯/通用/项目三值渲染", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(DOMAIN_ENTRIES));
    expect(container.querySelector('[data-memory-item-domain="1"]')!.textContent).toContain("习惯");
    expect(container.querySelector('[data-memory-item-domain="2"]')!.textContent).toContain("通用");
    expect(container.querySelector('[data-memory-item-domain="4"]')!.textContent).toContain("项目");
  });

  it("双维筛选：kind 与 domain 独立过滤（交叉组合生效）", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(DOMAIN_ENTRIES));
    // kind 维：只看进展
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-kind-filter='progress']")!);
    expect(container.querySelector('[data-memory-item="4"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-memory-item]")).toHaveLength(1);
    // domain 维叠加：kind=progress ∧ domain=habit → 空集
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-domain-filter='habit']")!);
    expect(container.querySelectorAll("[data-memory-item]")).toHaveLength(0);
    // 回到 kind 全部 ∧ domain=habit → 两条习惯条目
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-kind-filter='all']")!);
    expect(container.querySelectorAll("[data-memory-item]")).toHaveLength(2);
    // domain 全部 → 四条全回
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-domain-filter='all']")!);
    expect(container.querySelectorAll("[data-memory-item]")).toHaveLength(4);
  });

  it("新增弹窗 domain 打标：缺省 general；选 project 露出项目名输入并随载荷透传", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(DOMAIN_ENTRIES));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-add-open]")!);
    // 缺省 general（不传 domain → 载荷缺省 general）
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-memory-add-input]")!, { target: { value: "通用事实一条" } });
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-add-save]")!);
    expect(sendStewardMemoryAppend).toHaveBeenCalledWith("通用事实一条", "fact", "general", undefined);
    // domain=project：项目名输入随载荷透传
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-add-open]")!);
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-memory-add-input]")!, { target: { value: "helix 项目事实" } });
    fireEvent.change(container.querySelector<HTMLSelectElement>("[data-memory-add-domain]")!, { target: { value: "project" } });
    expect(container.querySelector("[data-memory-add-project]")).not.toBeNull();
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-memory-add-project]")!, { target: { value: "helix" } });
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-add-save]")!);
    expect(sendStewardMemoryAppend).toHaveBeenCalledWith("helix 项目事实", "fact", "project", "helix");
  });
});

// ── 写面失败收口（评审 StewardMemoryPage:131,150-172 / TR-272）────────
describe("写命令失败经 connection.error 收口（向量化行不永挂 + 不静默）", () => {
  function feedConnError(message: string) {
    const frame = {
      v: PROTOCOL_VERSION,
      sessionId: "__system__",
      channel: "notification",
      type: "connection.error",
      ts: 1,
      payload: { code: "command.invalid_payload", message },
    } as unknown as EventEnvelope;
    act(() => {
      for (const l of stewardListeners) l(frame);
    });
  }

  it("编辑保存被拒 → 向量化在途清位（行恢复可编辑/可删）+ 行内交代原因", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(ENTRIES));
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-memory-edit-btn="1"]')!);
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-memory-edit-input]")!, {
      target: { value: "改写后的记忆" },
    });
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-edit-save]")!);
    expect(container.querySelector("[data-memory-item-vectorizing]")).not.toBeNull(); // 在途
    // 他族命令拒绝 → 不误清在途
    feedConnError("追踪查询失败（命令 trace.query）");
    expect(container.querySelector("[data-memory-item-vectorizing]")).not.toBeNull();
    // 本命令拒绝 → 清在途（原实现永挂「向量化中」整行占位、零交代）
    feedConnError("文本过长（命令 steward.memory_update）");
    expect(container.querySelector("[data-memory-item-vectorizing]")).toBeNull();
    expect(container.querySelector("[data-memory-write-error]")!.textContent).toContain("文本过长");
    // 行恢复可交互（不再被在途位占位锁死）
    expect(container.querySelector<HTMLButtonElement>('[data-memory-edit-btn="1"]')!.disabled).toBe(false);
  });

  it("新增被拒 → 不静默（行内交代）", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(ENTRIES));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-add-open]")!);
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-memory-add-input]")!, {
      target: { value: "手动新增一条" },
    });
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-add-save]")!);
    feedConnError("向量端点不可用（命令 steward.memory_append）");
    expect(container.querySelector("[data-memory-write-error]")!.textContent).toContain("向量端点不可用");
  });

  it("pin 失败（无本地在途位）同样交代；读命令失败不误报写面", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(ENTRIES));
    feedConnError("记忆读面失败（命令 steward.memory_list）");
    expect(container.querySelector("[data-memory-write-error]")).toBeNull();
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-memory-pin-btn="2"]')!);
    feedConnError("条目不存在（命令 steward.memory_pin）");
    expect(container.querySelector("[data-memory-write-error]")!.textContent).toContain("条目不存在");
  });
});
