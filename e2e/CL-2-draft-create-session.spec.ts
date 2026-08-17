/**
 * T3.2 —— CL-2 草稿 → 首条消息建会话（F(1.2).1；契约 B §1.5）。
 *
 * 链路：活跃会话 → 新建草稿（本地态，clientFrames 断言零建会话命令——仅
 * unsubscribe 旧会话）→ 主区草稿空态（呼吸文案 + violet 光标 + 建会话提示）
 * → 首条消息 = chat.send{draft:true} 无信封 sessionId（clientFrames 断言）
 * → list_changed{created} + 新会话快照 → 草稿卡消失 + 新卡片（标题 = 首
 * 条消息前 20 字符，daemon 命名规则的 mock 镜像）+ 顶栏标题同步。
 */
import { test, expect } from "./harness/fixtures";
import { sessionListChanged, sessionListResult, v02Snapshot, welcome } from "./harness/protocol";
import { msgEntry } from "./harness/protocol";
import {
  MULTI_DRAFT_TEXT,
  MULTI_DRAFT_TITLE,
  MULTI_NEW_SESSION,
  MULTI_SESSION_A,
  MULTI_TITLE_A,
  multiSessionList,
} from "./harness/scenarios";

test.describe("T3.2 CL-2 草稿建会话", () => {
  test("新建草稿零建会话帧 → 草稿空态 → 首条消息 draft:true → created + 快照转活跃 + 20 字符命名", async ({ mock, page }) => {
    // ── 活跃会话 A 起步 ──
    await mock.open();
    await mock.waitForCommand("hello");
    await mock.emitAll([
      welcome({ sessionId: MULTI_SESSION_A }),
      v02Snapshot(MULTI_SESSION_A, { tail: [msgEntry("a-1", "user", "既有会话首条", { ts: 1 })] }),
      sessionListResult(multiSessionList()),
    ]);
    await mock.waitForConn("connected");
    await expect(page.locator('[data-session-card="draft"]')).toHaveCount(0);

    // ── 新建草稿：本地态，零建会话命令（仅 unsubscribe 旧会话）──
    const before = (await mock.clientFrames()).length;
    await page.locator("#btn-new-session").click();
    const after = await mock.clientFrames();
    expect(after.length - before).toBe(1); // 点击产生的唯一新帧 = unsubscribe 旧会话
    // 命令断言：unsubscribe A 在场；无 subscribe / 无 chat.send / 无建会话类命令
    const unsub = after.slice(before).find((f) => f.type === "session.unsubscribe");
    expect(unsub?.sessionId).toBe(MULTI_SESSION_A);
    const createLike = after.filter((f) => f.type.startsWith("session.create") || f.type === "session.subscribe");
    expect(createLike).toHaveLength(0);

    // 草稿卡片 + 草稿空态（F(1.2).1）：呼吸文案 + violet 方块光标 + 建会话提示
    const draftCard = page.locator('[data-session-card="draft"]');
    await expect(draftCard).toHaveCount(1);
    await expect(draftCard).toHaveAttribute("data-active", "1");
    await expect(draftCard).toContainText("草稿");
    await expect(page.locator("[data-draft-empty]")).toBeVisible();
    await expect(page.locator("[data-draft-empty] .empty-cursor")).toBeVisible();
    await expect(page.locator("[data-draft-empty]")).toContainText("发送第一条消息后将创建会话");
    // 旧会话内容不渲染（草稿空态互斥）+ 输入可用
    await expect(page.locator(".session-active .msg")).toHaveCount(0);
    await expect(page.locator("#msg-input")).toBeEnabled();
    await expect(page.locator(".app")).toHaveAttribute("data-session", "empty");
    // 顶栏标题切草稿文案
    await expect(page.locator("[data-session-title]")).toHaveText("新会话");

    // ── 首条消息：chat.send{draft:true} 无信封 sessionId ──
    const send = await mock.sendUserMessage(MULTI_DRAFT_TEXT, "chat.send");
    expect(send.payload).toMatchObject({ text: MULTI_DRAFT_TEXT, draft: true });
    expect((send as { sessionId?: string }).sessionId).toBeUndefined();

    // ── daemon 链路 mock：created + 新会话快照 → 草稿卡消失 + 新卡片 + 标题同步 ──
    await mock.emitAll([
      sessionListChanged("created", {
        sessionId: MULTI_NEW_SESSION,
        session: {
          sessionId: MULTI_NEW_SESSION,
          title: MULTI_DRAFT_TITLE,
          lastActivityAt: 9_000,
          runState: "streaming",
          loaded: true,
        },
      }),
      v02Snapshot(MULTI_NEW_SESSION, {
        tail: [
          msgEntry("n-1", "user", MULTI_DRAFT_TEXT, { ts: 2 }),
          msgEntry("n-2", "assistant", "收到，开始处理。", { ts: 3 }),
        ],
        totalEntries: 2,
        tailStartCursor: null,
      }),
    ]);
    await expect(page.locator('[data-session-card="draft"]')).toHaveCount(0);
    const newCard = page.locator(`[data-session-card="${MULTI_NEW_SESSION}"]`);
    await expect(newCard).toHaveCount(1);
    await expect(newCard).toHaveAttribute("data-active", "1");
    // 标题 = 首条消息前 20 字符（daemon 命名规则的 mock 镜像）
    expect(Array.from(MULTI_DRAFT_TITLE)).toHaveLength(20);
    await expect(newCard.locator(".ses-title")).toHaveText(MULTI_DRAFT_TITLE);
    await expect(page.locator("[data-session-title]")).toHaveText(MULTI_DRAFT_TITLE);
    // 草稿空态消失（会话投影接管）
    await expect(page.locator("[data-draft-empty]")).toBeHidden();
    await expect(page.locator(".session-active .msg")).toHaveCount(2);
    // 旧会话 A 卡片在场（转后台照常执行，F(1.0).5 呈现面归徽标剧本）
    await expect(page.locator(`[data-session-card="${MULTI_SESSION_A}"]`)).toHaveCount(1);
    // 草稿建会话链客户端不发 subscribe（契约 B §1.5：daemon 侧订阅切换 + 快照回推）
    expect((await mock.clientFrames()).filter((f) => f.type === "session.subscribe")).toHaveLength(0);
    // 清单未重拉场景下 A 标题仍取自既有清单（multiSessionList）
    await expect(page.locator(`[data-session-card="${MULTI_SESSION_A}"] .ses-title`)).toHaveText(MULTI_TITLE_A);
  });
});
