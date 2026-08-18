/**
 * T3.1 —— CL-1 spawn 锚点：shell 撤推导与锚定渲染（契约 v0.3 §1；AD-5；
 * Q-1b 窗口外不渲染 / Q-1c 一步替换无兼容层；R-P1-2/R-P1-3）。
 *
 * 剧本（F 层 mock transport；instances DTO / agent.spawned 帧携带
 * anchorEntryId，字段形状直引 @helix/protocol 类型）：
 * ① 快照 DTO 锚点定位：卡片 DOM 序 = 锚 entry 之后（e2 → 卡 → e3）；
 * ② 尾窗截断锚出窗 → 卡片 DOM 不存在（非 hidden、无占位无钉窗底）；
 *    滚顶 loadEarlier 前插锚 entry 回窗 → 卡片完整恢复锚位；
 * ③ null 流首锚 → 卡片渲染在首条 entry 之前；
 * ④ agent.spawned 增量帧锚点 → 新实例卡片实时归位（锚 e1，不落流尾）。
 *
 * 断言纪律：语义类（.sa-card[data-instance]/.msg）+ .session-active 直接
 * 子节点 DOM 顺序；窗口外断言 = toHaveCount(0)（DOM 不存在，非可见性）。
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./harness/fixtures";
import {
  agentInstance,
  agentSpawned,
  loadHistoryResult,
  msgEntry,
  v02Snapshot,
  welcome,
} from "./harness/protocol";

const SID = "sess-anchor";

/** .session-active 直接子节点令牌序列（card:<instanceId> / msg:<内容> / 其他类名）。 */
const flowTokens = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".session-active > *")).map((el) => {
      const card = el.classList.contains("sa-card") ? el : el.querySelector(".sa-card");
      if (card) return `card:${card.getAttribute("data-instance")}`;
      const msg = el.classList.contains("msg") ? el : el.querySelector(".msg");
      if (msg) return `msg:${msg.textContent ?? ""}`;
      return `other:${el.className}`;
    }),
  );

const msgs = (ids: string[]) => ids.map((id) => msgEntry(id, "assistant", `正文-${id}`));

/** 令牌序列中首个含 frag 的位次（.msg textContent 含 who/时间戳等附加文本）。 */
const idxOf = (tokens: string[], frag: string): number => tokens.findIndex((t) => t.includes(frag));

test.describe("T3.1 CL-1 spawn 锚点：DTO 锚定渲染（撤推导）", () => {
  test("① 快照 DTO 锚点定位：卡片 DOM 序 = 锚 entry 之后", async ({ mock, page }) => {
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([
      welcome({ sessionId: SID }),
      v02Snapshot(SID, {
        tail: msgs(["e1", "e2", "e3"]),
        totalEntries: 3,
        tailStartCursor: null,
        instances: [agentInstance("a1", { state: "running", task: "锚定剧本", anchorEntryId: "e2" })],
      }),
    ]);
    await mock.waitForConn("connected");

    const tokens = await flowTokens(page);
    const iE2 = idxOf(tokens, "正文-e2");
    const iCard = idxOf(tokens, "card:a1");
    const iE3 = idxOf(tokens, "正文-e3");
    expect(iE2).toBeGreaterThanOrEqual(0);
    expect(iCard).toBeGreaterThan(iE2); // 锚 entry 之后
    expect(iCard).toBeLessThan(iE3); // 次条 entry 之前
  });

  test("② 尾窗截断锚出窗 → 卡片 DOM 不存在；loadEarlier 回窗恢复锚位", async ({ mock, page }) => {
    const tail = msgs(["e10", "e11", "e12"]);
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([
      welcome({ sessionId: SID }),
      v02Snapshot(SID, {
        tail,
        totalEntries: 12,
        tailStartCursor: "e10", // 有更早历史 → hasMore
        instances: [agentInstance("a1", { state: "running", task: "锚在窗外", anchorEntryId: "e5" })],
      }),
    ]);
    await mock.waitForConn("connected");

    // 锚 e5 ∉ 装载窗口（尾窗 e10~e12）→ 卡片不渲染（DOM 不存在，无钉窗底无占位）
    const card = page.locator('.sa-card[data-instance="a1"]');
    await expect(card).toHaveCount(0);
    await expect(page.locator(".msg-flow .msg")).toHaveCount(3); // 尾窗条目照常

    // 点击「加载更早」胶囊 → loadHistory 前插（含锚 e5）→ 卡片回窗恢复锚位
    // （尾窗仅 3 条不溢出滚动容器，滚顶不触发 scroll 事件——走正式 UI 面点击）
    await page.locator(".load-earlier").click();
    const cmd = await mock.waitForCommand("session.loadHistory");
    expect(cmd.sessionId).toBe(SID);
    await mock.emit(
      loadHistoryResult(SID, {
        entries: msgs(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"]),
        hasMore: false,
        nextCursor: null,
      }),
    );
    await expect(card).toHaveCount(1);
    const tokens = await flowTokens(page);
    expect(idxOf(tokens, "card:a1")).toBeGreaterThan(idxOf(tokens, "正文-e5"));
    expect(idxOf(tokens, "card:a1")).toBeLessThan(idxOf(tokens, "正文-e6"));
  });

  test("③ null 流首锚 → 卡片渲染在首条 entry 之前", async ({ mock, page }) => {
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([
      welcome({ sessionId: SID }),
      v02Snapshot(SID, {
        tail: msgs(["e1", "e2"]),
        totalEntries: 2,
        tailStartCursor: null,
        instances: [agentInstance("a1", { state: "running", task: "流首锚", anchorEntryId: null })],
      }),
    ]);
    await mock.waitForConn("connected");

    const tokens = await flowTokens(page);
    const iCard = idxOf(tokens, "card:a1");
    const iE1 = idxOf(tokens, "正文-e1");
    expect(iCard).toBeGreaterThanOrEqual(0);
    expect(iCard).toBeLessThan(iE1); // 首条 entry 之前
  });

  test("④ agent.spawned 增量帧锚点 → 新实例卡片实时归位（不落流尾）", async ({ mock, page }) => {
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([
      welcome({ sessionId: SID }),
      v02Snapshot(SID, { tail: msgs(["e1", "e2", "e3"]), totalEntries: 3, tailStartCursor: null }),
    ]);
    await mock.waitForConn("connected");
    await expect(page.locator(".sa-card")).toHaveCount(0);

    // 增量供给面：spawn 帧携带锚 e1（尾部已是 e3）→ 卡片归位 e1 之后
    await mock.emit(agentSpawned("a1", "增量归位剧本", { anchorEntryId: "e1" }));
    const card = page.locator('.sa-card[data-instance="a1"]');
    await expect(card).toHaveCount(1);
    const tokens = await flowTokens(page);
    expect(idxOf(tokens, "card:a1")).toBeGreaterThan(idxOf(tokens, "正文-e1"));
    expect(idxOf(tokens, "card:a1")).toBeLessThan(idxOf(tokens, "正文-e2"));
  });
});
