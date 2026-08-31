/**
 * T2.3 —— CL-5 TracePage E 层行为验证（真 daemon + 剧本引擎 + --home mkdtemp；
 * workers=1 串行口径，playwright.e2e.config.ts 入口）。
 *
 * 与 fidelity 套件（CL-5-fidelity-trace-page.spec.ts，F 层 mock mode）互补：
 * 本 spec 走真 WS + 真 SQLite（domain_events 唯一真实源）+ 真子进程
 * （realSubagent 装配，T1.4 先例），断言页面行为与 daemon 口径一致。
 *
 * 场景映射（test-design §四 原型行为测试点 / §CL-5 / brief 验收标准 2）：
 *   T1 实例面板交互（选择/切换/「全部实例」混排 + 面板随会话选择重建）
 *      + 上下文卡（快照渲染：systemPrompt 展开收起/工具 chips/model/
 *        compaction 主有 Sub 无/Sub task 引用块；model.set 后模型时间线
 *        from→to 当前值高亮；单发 Sub 纯快照退化无时间线段）
 *      + 组合过滤交集下推（三维交集计数与行内容齐性；缺省全量回归）
 *      + 行展开收起（手风琴单开 + aria-expanded）+ IconRail /trace 高亮
 *      + trace 页签非施工牌
 *   T2 分页收口（加载更多 → 已加载全部禁用 + footer 计数同步；id 降序拼接
 *      首新末旧，末行 = 会话首事件 agent.instantiated）
 *   T3 SubAgent engine.error 可见性（CL-1×CL-5 数据面打通，F5.3 锚 3；
 *      scriptedEngine error 形态逐字段 mirror T1.4 已交付先例）
 *   T4 重启后回放一致性（重启前 Sub 历史 + instantiated + model.changed →
 *      SIGTERM → 同 home 重启 → trace 事件不丢不错（DB per-id 全等 +
 *      UI 行序列相等）+ 上下文卡可重建）+ 快照缺失降级（停机窗口直插
 *      domain_events 构造无 instantiated 的历史实例，brief 许可路径）
 *
 * 纪律：TR-TEST-4（mkdtemp 隔离）/ TR-TEST-5（无帧拦截，全真连接）/
 * TR-TEST-6（teardown 零残留归 fixture；本 spec 无旁路清理——自建 home
 * 经 startDaemon({home}) 注入由 fixture 统一回收）。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./harness/daemon-fixture";
import { reply, toolCall, type DaemonScript } from "./harness/daemon-script";
import { computed } from "./harness/style-utils";
import { shotEvidence, writeEvidence } from "./harness/evidence";

const BUN = process.env.HELIX_E2E_BUN ?? "bun";

/** 模型链目标（CL-3 先例：builtin fallback 目录内的 anthropic 模型）。 */
const TARGET_MODEL = "anthropic/claude-haiku-4-5";
const API_KEY = "sk-e2e-trace-key-1234";
/** 死代理：daemon 外网快失 → model.catalog builtin fallback（K-1 先例）。 */
const DEAD_PROXY = { HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" };

/** 真子进程收口回复（CLOSURE 协议块 → done 收口），含可辨识文本锚。 */
const SA_TASK = "trace 面板验证子任务";
const SA_MARKER = "回放一致性结论 Q";
const SA_REPLY =
  `子任务完成：${SA_MARKER}。\n` +
  '<<<CLOSURE\n{"status":"done","summary":"子任务完成","reportPath":null,"findings":[],"taskId":null}\nCLOSURE>>>';

// P2 ⑦ 网络重试批：429 现属瞬时类（引擎级退避重试会拖入真实等待），错误
// 透传链路验证改用永久类 401 鉴权错误——首帧即失败，断言面不变。
const ERROR_TEXT = "401: {\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}";
const ERROR_FRAGMENT = "invalid x-api-key";

/** 直插的历史实例（无 agent.instantiated → 快照缺失降级构造面）。 */
const LEGACY_ID = "agent-legacy-1";
const LEGACY_TASK = "历史调研任务（无快照）";

// ── 通用辅助 ───────────────────────────────────────────────

function prepHome(prefix: string): string {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(home, "sandbox"), { recursive: true });
  return home;
}

/** 证据落当前迭代 evidence/e2e（T4.2 / F(5).1：统一走 harness/evidence.ts
 *  迭代感知单点，本地 helper 仅透传闭环 id 前缀）。 */
async function shotLocal(page: Page, name: string): Promise<void> {
  await shotEvidence(page, name, "CL-5");
}

function writeLocalEvidence(name: string, content: string): void {
  writeEvidence(name, "txt", content, "CL-5");
}

/** IconRail 进 /trace 并等自动查询收口（success：行在场 + 分页脚全载）。 */
async function openTrace(page: Page): Promise<void> {
  await page.locator('.rail-btn[data-page="trace"]').click();
  await expect(page.locator('[data-trace-page="/trace"]')).toBeVisible();
  await expect(page.locator(".p1-tbody .p1-entry").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".p1-foot .hud-btn")).toHaveText("已加载全部", { timeout: 15_000 });
}

/** 表头命中计数（success 态才渲染；查询中为空串 → poll 到非 -1）。 */
async function waitHitCount(page: Page): Promise<number> {
  await expect
    .poll(
      async () => {
        const text = await page.locator(".p1-thead .hit").innerText();
        const m = text.match(/命中 (\d+) 条/);
        return m === null ? -1 : Number(m[1]);
      },
      { timeout: 15_000 },
    )
    .not.toBe(-1);
  const text = await page.locator(".p1-thead .hit").innerText();
  return Number(text.match(/命中 (\d+) 条/)![1]);
}

/** 混排视图当前已加载行（实例 id / 类型 / 摘要三元组，DOM 序 = id 降序）。 */
async function readMixedRows(page: Page): Promise<{ inst: string; type: string; summary: string }[]> {
  return page.locator(".p1-tbody .p1-entry").evaluateAll((els) =>
    els.map((el) => ({
      inst: el.querySelector(".inst-id")?.textContent ?? "",
      type: el.querySelector(".p1-tt")?.textContent ?? "",
      summary: el.querySelector(".p1-summary")?.textContent ?? "",
    })),
  );
}

/** 当前可见行类型清单（过滤齐性断言数据源）。 */
async function visibleRowTypes(page: Page): Promise<string[]> {
  return page.locator(".p1-tbody .p1-entry .p1-tt").allInnerTexts();
}

/** 设置页模型分区录 anthropic key（T5.3 菜单可用性口径前置；S2 原独立页迁入）。 */
async function provisionAnthropicKey(page: Page): Promise<void> {
  await page.locator('.rail-btn[data-page="settings"]').click();
  await expect(page.locator("[data-models-section]")).toBeVisible();
  const prov = page.locator('[data-prov="anthropic"]');
  await prov.locator("[data-prov-toggle]").click();
  await prov.locator("[data-prov-addkey]").click();
  await page.locator("#key-input").fill(API_KEY);
  await page.locator("#btn-modal-save").click();
  await expect(prov.locator(".key-chip")).toBeVisible({ timeout: 10_000 });
  await page.locator('.rail-btn[data-page="chat"]').click();
  await expect(page.locator("[data-settings-page]")).toHaveCount(0);
}

/** P-3 菜单切会话模型（model.set 真链路：catalog 校验 → ChatService → 引擎）。 */
async function switchSessionModel(page: Page, model: string): Promise<void> {
  const badge = page.locator("[data-model-badge]");
  await badge.click();
  const menu = page.locator(".model-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-group="anthropic"]')).toBeVisible({ timeout: 15_000 });
  await menu.locator(`[data-model-item="${model}"]`).click();
  await expect(badge).toHaveText(model, { timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
}

// ── SQLite 直查/直插（daemon 停机窗口；bun:sqlite，T1.4 先例形态）──────

interface DbEventRow {
  id: number;
  session_id: string;
  agent_kind: string;
  agent_instance_id: string;
  type: string;
  payload: string;
  ts: string;
}

function dumpEvents(dbPath: string, sessionId: string): DbEventRow[] {
  const script = `
import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
console.log(JSON.stringify(db.query("SELECT id, session_id, agent_kind, agent_instance_id, type, payload, ts FROM domain_events WHERE session_id = ? ORDER BY id").all(${JSON.stringify(sessionId)})));
`;
  const out = execFileSync(BUN, ["-e", script], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(out.trim().split("\n").at(-1)!) as DbEventRow[];
}

/** 直插无 instantiated 快照的历史 SubAgent 实例（3 行：spawned/message/completed）。 */
function insertLegacyInstance(dbPath: string, sessionId: string): void {
  const t0 = Date.now();
  const rows = [
    [sessionId, "subagent", LEGACY_ID, "agent.spawned", JSON.stringify({ agentId: LEGACY_ID, task: LEGACY_TASK, profileKind: "phase-explorer", model: "fake/model" }), new Date(t0).toISOString()],
    [sessionId, "subagent", LEGACY_ID, "message.completed", JSON.stringify({ entryId: "legacy-1", role: "assistant", text: "历史实例的旧回复。", isSteer: false }), new Date(t0 + 1).toISOString()],
    [sessionId, "subagent", LEGACY_ID, "agent.completed", JSON.stringify({ reason: "done" }), new Date(t0 + 2).toISOString()],
  ];
  const script = `
import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(dbPath)});
const stmt = db.prepare("INSERT INTO domain_events (session_id, agent_kind, agent_instance_id, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)");
for (const r of ${JSON.stringify(rows)}) stmt.run(...r);
db.close();
console.log("inserted");
`;
  execFileSync(BUN, ["-e", script], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

// ── T1：面板交互 + 上下文卡双段 + 组合过滤 + 行展开 + IconRail ─────

test.describe("T2.3 CL-5 TracePage E 层行为（真 daemon）", () => {
  test("实例面板交互 + 上下文卡（快照/时间线/纯快照退化）+ 组合过滤交集 + 行展开 + IconRail 高亮", async ({ e2e, page }) => {
    test.setTimeout(180_000);
    const home = prepHome("helix-e2e-cl5-trace-main-");
    // 会话甲剧本：e0 turn1；e1+e2 turn2（spawn 工具 + 续写）；e3 closure 自动轮。
    // 会话乙 turn1 消费自身队列的 e0（每会话引擎独立队列从头消费）。
    const script: DaemonScript = {
      entries: [
        reply("trace 首轮回复。（完T1）"),
        toolCall("agent_spawn", { task: SA_TASK }),
        reply("主线续写收口。（完T2）"),
        reply("closure 注入自动轮收口。（完TC）"),
      ],
    };
    const d = await e2e.startDaemon({
      script,
      home,
      realSubagent: { engineScript: { replies: [SA_REPLY], chunkDelayMs: 6 } },
      env: DEAD_PROXY,
    });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // ── 前置：auth key（模型菜单可用性口径）+ 会话甲三轮 + 会话乙 ──
    await provisionAnthropicKey(page);
    await e2e.send(page, "trace 会话首轮");
    await e2e.waitForTurnDone(page, "（完T1）");
    await e2e.send(page, "派发子任务");
    await e2e.waitForAssistantText(page, "（完T2）", 30_000);
    await expect(page.locator(".sa-card.done")).toHaveCount(1, { timeout: 30_000 });
    await e2e.waitForTurnDone(page, "（完TC）", 30_000);
    // model.set：会话模型 fake/model → TARGET（agent.model.changed 落盘，F5.9）
    await switchSessionModel(page, TARGET_MODEL);

    // 会话乙（面板随会话选择重建的对照面）
    await page.locator("#btn-new-session").click();
    await e2e.send(page, "乙会话首轮：面板重建");
    await e2e.waitForTurnDone(page, "（完T1）");
    await page.locator(".ses", { hasText: "trace 会话首轮" }).click();

    // ── IconRail 高亮 + 页签非施工牌 ────────────────────────
    await openTrace(page);
    await expect(page.locator('.rail-btn[data-page="trace"]')).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('.rail-btn[aria-selected="true"]')).toHaveCount(1);
    await expect(page.locator('[data-construction="/trace"]')).toHaveCount(0);
    await expect(page.locator(".p1-title")).toHaveText("事件追溯");

    // ── 实例面板：全部实例混排 + 主/Sub 条目 ────────────────
    const totalAll = await waitHitCount(page);
    expect(totalAll).toBeGreaterThan(10); // 甲三轮 + Sub 事件，量级守护（精确值随事件族演进）
    await expect(page.locator(".ip-count")).toHaveText("2 实例");
    const all = page.locator(".ip-item.ip-all");
    await expect(all).toHaveAttribute("aria-pressed", "true");
    await expect(all).toContainText("全部实例");
    await expect(all).toContainText(`${totalAll} 条`);
    const items = page.locator(".ip-item:not(.ip-all)");
    await expect(items).toHaveCount(2);
    const mainItem = items.filter({ hasText: "主实例" });
    await expect(mainItem.locator(".ii-pk.main-pk")).toHaveText("main-session");
    await expect(mainItem.locator(".ii-model")).toHaveText("fake/model");
    const subItem = items.filter({ has: page.locator(".ii-pk", { hasText: "subagent-worker" }) }); // T10：id=hex，按 pk 定位 Sub
    await expect(subItem).toHaveAttribute("data-status", "completed");
    await expect(subItem.locator(".ii-status")).toHaveText("已完成");
    await expect(subItem.locator(".ii-pk")).toHaveText("subagent-worker");
    await expect(subItem.locator(".ii-name")).toContainText("trace 面板验证子任务");
    // 混排四列表头
    const thead = page.locator(".p1-thead");
    for (const col of ["时间", "实例", "类型", "摘要"]) {
      await expect(thead).toContainText(col);
    }
    await shotLocal(page, "e2e-trace-panel-mixed");

    // ── 上下文卡（Sub）：task 引用块 + 快照 + 无 compaction + 无时间线 ──
    await subItem.click();
    await expect(subItem).toHaveAttribute("aria-pressed", "true");
    await expect(thead).not.toContainText("实例"); // 详情三列
    const card = page.locator(".ctx-card");
    await expect(card).toBeVisible();
    await expect(card.locator("blockquote.ctx-task")).toContainText(SA_TASK);
    await expect(card.locator("blockquote.ctx-task .cite")).toHaveText("spawn task · 首条 user 消息");
    // T12：SubAgent 模型 = 槽位 ?? 全局默认（不再继承会话 fake/model）——本 spec 意图是上下文卡渲染非模型链，改钉「模型」字段在场 + 工具数（模型链归 CL-3）
    await expect(card.locator(".ctx-facts")).toContainText("模型");
    await expect(card.locator(".ctx-facts")).not.toContainText("compaction");
    await expect(card.locator(".ctx-tools .hud-chip")).toHaveCount(8); // SubAgentProfile 工具集（T1 联网两工具后 5→7；H-3 +browser 7→8）
    // systemPrompt 折叠 3 行 + 字数 + 展开/收起（全文含 closure 协议常量段）
    const promptBody = card.locator(".cp-body");
    await expect(promptBody).toHaveClass(/folded/);
    await expect(card.locator(".cp-count")).toContainText("字");
    const toggle = card.locator(".cp-head .hud-btn");
    await expect(toggle).toHaveText("展开全文");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(promptBody).not.toHaveClass(/folded/);
    await expect(promptBody).toContainText("收口协议");
    await toggle.click();
    await expect(promptBody).toHaveClass(/folded/);
    // 单发 Sub 纯快照退化：无变更轨迹段
    await expect(card.locator(".ctx-tl")).toHaveCount(0);

    // ── 上下文卡（主）：compaction 有 + 模型时间线 from→to 当前高亮 ──
    await mainItem.click();
    await expect(card.locator(".ctx-facts")).toContainText("compaction");
    await expect(card.locator(".cf-v").first()).toContainText(TARGET_MODEL);
    await expect(card.locator(".cf-note").first()).toContainText("基准 fake/model · 已切换 1 次");
    const tl = card.locator(".ctx-tl");
    await expect(tl).toBeVisible();
    await expect(tl.locator(".tl-row")).toHaveCount(1);
    const cur = tl.locator(".tl-cur");
    await expect(cur).toContainText("fake/model");
    await expect(cur).toContainText(TARGET_MODEL);
    await expect(cur).toContainText("当前");
    await shotLocal(page, "e2e-trace-context-main");

    // ── 组合过滤交集（下推 daemon 口径）+ 缺省全量 ──────────
    await all.click(); // 回混排
    expect(await waitHitCount(page)).toBe(totalAll);
    // 类型维：message 单选
    await page.locator('.tchip[data-type="message"]').click();
    const hitMsg = await waitHitCount(page);
    expect(hitMsg).toBeGreaterThan(0);
    expect(hitMsg).toBeLessThan(totalAll);
    for (const t of await visibleRowTypes(page)) expect(t).toBe("message.completed");
    // 类型维多选：+ lifecycle（Shift 集合 toggle）
    await page.locator('.tchip[data-type="lifecycle"]').click({ modifiers: ["Shift"] });
    const hitMsgLc = await waitHitCount(page);
    expect(hitMsgLc).toBeGreaterThan(hitMsg);
    const lifecycleTypes = new Set(["message.completed", "turn.started", "turn.completed", "turn.interrupted", "steer.queued", "steer.drained", "agent.state.changed", "agent.spawned", "agent.queued", "agent.started", "agent.stalled", "agent.completed", "agent.failed", "agent.killed", "agent.instantiated"]);
    for (const t of await visibleRowTypes(page)) expect(lifecycleTypes.has(t)).toBe(true);
    // 实例维交集：选中 Sub → 计数再收窄且行类型仍在集合内
    await page.locator(".ip-item:not(.ip-all)").filter({ has: page.locator(".ii-pk", { hasText: "subagent-worker" }) }).click();
    const hitSub = await waitHitCount(page);
    expect(hitSub).toBeGreaterThan(0);
    expect(hitSub).toBeLessThan(hitMsgLc);
    for (const t of await visibleRowTypes(page)) expect(lifecycleTypes.has(t)).toBe(true);
    // 时间维交集：最近 5 分钟（参考零点 = 会话最新事件 ts；本轮事件全在窗内 → 计数不变）
    await page.locator("#p1-sel-range").selectOption("300");
    expect(await waitHitCount(page)).toBe(hitSub);
    await page.locator("#p1-sel-range").selectOption("all");
    expect(await waitHitCount(page)).toBe(hitSub);
    // 全不选 = 空结果（empty 筛选 flavor 文案）
    await page.locator('.tchip[data-type="message"]').click({ modifiers: ["Shift"] });
    await page.locator('.tchip[data-type="lifecycle"]').click({ modifiers: ["Shift"] });
    await expect(page.locator(".p1-empty .e-title")).toContainText("当前筛选无匹配事件");
    await expect(page.locator(".p1-empty .e-hint")).toContainText("调整实例 / 类型 / 时间范围");
    // 缺省全量回归：chip 单选→再点回全量，实例回全部
    await page.locator('.tchip[data-type="message"]').click();
    await waitHitCount(page);
    await page.locator('.tchip[data-type="message"]').click();
    await page.locator(".ip-item.ip-all").click();
    expect(await waitHitCount(page)).toBe(totalAll);

    // ── 行展开收起（手风琴单开 + aria-expanded 同步）─────────
    const rows = page.locator(".p1-tbody .p1-entry");
    const firstRow = rows.nth(0).locator(".p1-row");
    const secondRow = rows.nth(1).locator(".p1-row");
    await firstRow.click();
    await expect(firstRow).toHaveAttribute("aria-expanded", "true");
    const payload = page.locator(".p1-entry.open .p1-payload");
    await expect(payload).toBeVisible();
    await expect(payload.locator(".hud-code")).toContainText("{");
    await expect(payload.locator(".hud-btn")).toHaveText("复制 JSON");
    await secondRow.click();
    await expect(firstRow).toHaveAttribute("aria-expanded", "false");
    await expect(secondRow).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".p1-entry.open")).toHaveCount(1);
    await secondRow.click();
    await expect(secondRow).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".p1-payload")).toHaveCount(0);

    // ── 面板随会话选择重建（S3b：sidebar 上分区点击；甲 2 实例 ↔ 乙 1 实例）──
    const activeSes = page.locator(".tsb-ses.on");
    const sidA = (await activeSes.getAttribute("data-session-id"))!;
    const itemB = page.locator(".tsb-ses", { hasText: "乙会话首轮" });
    const sidB = (await itemB.getAttribute("data-session-id"))!;
    expect(sidB).not.toBe(sidA);
    await itemB.click();
    await expect(page.locator(".ip-count")).toHaveText("1 实例");
    await waitHitCount(page);
    await expect(page.locator(".ip-item:not(.ip-all)")).toHaveCount(1);
    await expect(page.locator(".ip-item:not(.ip-all)").filter({ has: page.locator(".ii-pk", { hasText: "subagent-worker" }) })).toHaveCount(0);
    await page.locator(".tsb-ses", { hasText: "trace 会话首轮" }).click();
    await expect(page.locator(".ip-count")).toHaveText("2 实例");
    await waitHitCount(page);
    await expect(page.locator(".ip-item:not(.ip-all)").filter({ has: page.locator(".ii-pk", { hasText: "subagent-worker" }) })).toHaveCount(1);
    await shotLocal(page, "e2e-trace-session-rebuild");

    await d.stop();
    writeLocalEvidence(
      "e2e-trace-main",
      [
        "T2.3 CL-5 E 层 T1（面板/上下文卡/过滤/行展开/高亮）：PASS",
        `会话甲事件总数 ${totalAll}；过滤链 hit: message=${hitMsg} → +lifecycle=${hitMsgLc} → ∩Sub=${hitSub}（300s 窗内不变）`,
        "上下文卡: Sub(task 引用块/5 工具 chips/无 compaction/无时间线纯快照) + 主(compaction/时间线 fake/model→" + TARGET_MODEL + " 当前高亮)",
        "行展开手风琴单开 + aria-expanded 同步；IconRail /trace aria-selected 恰一；页签非施工牌",
        "面板随会话选择重建: 乙 1 实例（无 SubAgent）↔ 甲 2 实例",
      ].join("\n"),
    );
  });

  // ── T2：分页收口 ─────────────────────────────────────────

  test("分页：加载更多步进追加 → 已加载全部收口（禁用）+ footer 计数同步", async ({ e2e, page }) => {
    test.setTimeout(180_000);
    const home = prepHome("helix-e2e-cl5-trace-page-");
    const TURNS = 12; // 每轮 ≥5 事件（turn.started/message×2/usage/turn.completed）→ 总数 > PAGE_SIZE 50
    const script: DaemonScript = {
      entries: Array.from({ length: TURNS }, (_, i) => reply(`第${i + 1}轮回复。（完P${i + 1}）`)),
    };
    const d = await e2e.startDaemon({ script, home });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    for (let i = 1; i <= TURNS; i++) {
      await e2e.send(page, `翻页第${i}轮`);
      await e2e.waitForTurnDone(page, `（完P${i}）`, 30_000);
    }

    await page.locator('.rail-btn[data-page="trace"]').click();
    await expect(page.locator('[data-trace-page="/trace"]')).toBeVisible();
    // 首页 50 行（PAGE_SIZE 步进）+ footer 计数
    await expect(page.locator(".p1-tbody .p1-entry")).toHaveCount(50, { timeout: 15_000 });
    const metaText = await page.locator(".p1-foot .meta").innerText();
    const m = metaText.match(/已加载 50 \/ (\d+) 条 · 每页 50 条/);
    expect(m, `footer 计数文案：${metaText}`).not.toBeNull();
    const total = Number(m![1]);
    expect(total).toBeGreaterThan(50);
    const more = page.locator(".p1-foot .hud-btn");
    await expect(more).toHaveText("加载更多");
    await expect(more).toBeEnabled();

    await more.click();
    await expect(page.locator(".p1-tbody .p1-entry")).toHaveCount(total, { timeout: 15_000 });
    await expect(page.locator(".p1-foot .meta")).toHaveText(`已加载 ${total} / ${total} 条 · 每页 50 条`);
    await expect(more).toHaveText("已加载全部");
    await expect(more).toBeDisabled();
    // id 降序拼接：末行 = 会话首事件 agent.instantiated（id 1）
    await expect(page.locator(".p1-entry").last().locator(".p1-tt")).toHaveText("agent.instantiated");
    await shotLocal(page, "e2e-trace-paging");

    await d.stop();
    writeLocalEvidence(
      "e2e-trace-paging",
      `T2.3 CL-5 E 层 T2（分页收口）：PASS\n${TURNS} 轮 → 总数 ${total}（>50）→ 加载更多后 ${total}/${total}，按钮收口「已加载全部」禁用；末行 agent.instantiated（id 降序首新末旧）`,
    );
  });

  // ── T3：SubAgent engine.error 可见性（CL-1×CL-5 数据面打通）──

  test("SubAgent engine.error 在 trace 页可见且 error 色系（scriptedEngine error 形态）", async ({ e2e, page }) => {
    test.setTimeout(150_000);
    const home = prepHome("helix-e2e-cl5-trace-err-");
    const script: DaemonScript = {
      entries: [
        toolCall("agent_spawn", { task: "provider 错误剧本验证任务" }),
        reply("主线已派出错误验证实例。（完S1）"),
        reply("closure 注入自动轮收口。（完C）"),
      ],
    };
    const d = await e2e.startDaemon({
      script,
      home,
      realSubagent: { engineScript: { replies: [], error: { message: ERROR_TEXT } } },
    });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    await e2e.send(page, "派出错误剧本 SubAgent");
    await e2e.waitForAssistantText(page, "（完S1）", 30_000);
    await expect(page.locator(".sa-card.failed")).toHaveCount(1, { timeout: 30_000 });
    await e2e.waitForTurnDone(page, "（完C）", 30_000);

    await openTrace(page);
    // 面板：Sub 实例 failed 态
    const subItem = page.locator(".ip-item:not(.ip-all)").filter({ has: page.locator(".ii-pk", { hasText: "subagent-worker" }) });
    await expect(subItem).toHaveAttribute("data-status", "failed");
    await expect(subItem.locator(".ii-status")).toHaveText("失败");
    // 混排视图：engine.error 行 err-row 着色 + 摘要透出 provider 原文
    const errEntry = page.locator(".p1-entry.err-row");
    await expect(errEntry).toHaveCount(1);
    await expect(errEntry.locator(".p1-tt-engineerr")).toHaveText("engine.error");
    await expect(errEntry.locator(".err-text")).toContainText(ERROR_FRAGMENT);
    expect(await computed(page, ".p1-entry.err-row .err-text", "color")).toBe("rgb(248, 113, 113)");
    // 详情视图（选中该实例）：错误行在场 + 展开 payload 原文
    await subItem.click();
    await expect(errEntry).toHaveCount(1);
    await errEntry.locator(".p1-row").click();
    await expect(page.locator(".p1-entry.open .hud-code")).toContainText(ERROR_FRAGMENT);
    // 失败实例上下文卡：instantiated 快照仍在（spawn 时刻落盘），无变更轨迹
    const card = page.locator(".ctx-card");
    await expect(card.locator(".cp-body")).toBeVisible();
    await expect(card.locator(".ctx-tl")).toHaveCount(0);
    await shotLocal(page, "e2e-trace-engine-error");

    await d.stop();
    writeLocalEvidence(
      "e2e-trace-engine-error",
      "T2.3 CL-5 E 层 T3（engine.error 可见性）：PASS\n混排+详情双视图 err-row ×1（--error-rgb 色系 rgb(248,113,113)），摘要与 payload 均透出 provider 原文；面板实例 failed 态",
    );
  });

  // ── T4：重启后回放一致性 + 快照缺失降级 ──────────────────

  test("重启后回放一致性（事件不丢不错 + 上下文卡可重建）+ 快照缺失降级", async ({ e2e, page }) => {
    test.setTimeout(180_000);
    const home = prepHome("helix-e2e-cl5-trace-restart-");
    const script: DaemonScript = {
      entries: [
        reply("回放首轮回复。（完R1）"),
        toolCall("agent_spawn", { task: SA_TASK }),
        reply("主线续写收口。（完R2）"),
        reply("closure 注入自动轮收口。（完RC）"),
      ],
    };
    const d1 = await e2e.startDaemon({
      script,
      home,
      realSubagent: { engineScript: { replies: [SA_REPLY], chunkDelayMs: 6 } },
      env: DEAD_PROXY,
    });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // ── 重启前现场：会话甲（Sub 历史 + instantiated + model.changed）──
    await provisionAnthropicKey(page);
    await e2e.send(page, "回放会话首轮");
    await e2e.waitForTurnDone(page, "（完R1）");
    await e2e.send(page, "派发回放子任务");
    await e2e.waitForAssistantText(page, "（完R2）", 30_000);
    await expect(page.locator(".sa-card.done")).toHaveCount(1, { timeout: 30_000 });
    await e2e.waitForTurnDone(page, "（完RC）", 30_000);
    await switchSessionModel(page, TARGET_MODEL);

    // trace 页基线（混排全量）：行序列 + 计数 + 主/Sub 上下文卡
    await openTrace(page);
    const preRows = await readMixedRows(page);
    const preTotal = await waitHitCount(page);
    expect(preRows.length).toBe(preTotal); // 全量单页（<50）
    const sid = (await page.locator(".tsb-ses.on").getAttribute("data-session-id"))!;
    const card = page.locator(".ctx-card");
    await page.locator(".ip-item:not(.ip-all)").filter({ hasText: "主实例" }).click();
    await expect(card.locator(".tl-cur")).toContainText(TARGET_MODEL);
    await expect(card.locator(".cp-body")).toBeVisible();
    await page.locator(".ip-item:not(.ip-all)").filter({ has: page.locator(".ii-pk", { hasText: "subagent-worker" }) }).click();
    await expect(card.locator("blockquote.ctx-task")).toContainText(SA_TASK);
    await page.locator(".ip-item.ip-all").click(); // 回混排全量（重连重查的过滤基线）
    await waitHitCount(page);
    await shotLocal(page, "e2e-trace-before-restart");

    // ── 优雅停机 → 持久化面基线 + 直插无快照历史实例 → 同 home 重启 ──
    await d1.stop(); // SIGTERM drain（写队列落盘完成）
    const dbPath = path.join(home, "helix.db");
    const preDump = dumpEvents(dbPath, sid);
    // 停机 seal 里程碑（既设计口径）：优雅停机 sealAll 为热会话补落一行
    // agent.state.changed stopped（ChatService.stop 幂等；恢复路径生命周期
    // 重建为初始态 → 每次优雅停机恰 +1）。该行在末次 UI 查询之后落盘。
    const sealOf = (rows: DbEventRow[]) =>
      rows.filter((r) => r.type === "agent.state.changed" && r.payload.includes('"state":"stopped"'));
    const seal1 = sealOf(preDump);
    expect(seal1, "d1 停机应恰补落 1 行 seal 里程碑").toHaveLength(1);
    // T10：seal 行归属 = 主实例（发布带 hex id 或缺省回填 legacy "main"——两形态皆主实例）
    expect(seal1[0]!.agent_instance_id).toMatch(/^(main|agent-[0-9a-f]+)$/);
    expect(preDump.length).toBe(preTotal + 1); // UI 计数 + seal = DB 行数（同源一致）
    insertLegacyInstance(dbPath, sid);

    const d2 = await e2e.startDaemon({
      script: { entries: [reply("重启后续轮。（完RR）")] },
      home,
      retries: 8,
    });
    expect(d2.home).toBe(home);
    await e2e.waitForConnected(page, 30_000);
    await expect(page.locator(".toast.ok", { hasText: "已重新连接 daemon" })).toBeVisible({ timeout: 15_000 });

    // ── 回放一致性（UI 面）：重连重查后 = 直插 3 行（id 最大居首）+ seal 行 + 原序列 ──
    await expect(page.locator(".p1-tbody .p1-entry")).toHaveCount(preDump.length + 3, { timeout: 15_000 });
    expect(await waitHitCount(page)).toBe(preDump.length + 3);
    const postRows = await readMixedRows(page);
    expect(postRows.slice(0, 3).every((r) => r.inst === LEGACY_ID)).toBe(true);
    expect(postRows[3]!.type).toBe("agent.state.changed"); // d1 seal 行（id 介于直插与原序列之间）
    expect(postRows.slice(4)).toEqual(preRows); // 原事件序列不丢不错（UI 口径）

    // ── 回放一致性（持久化面）：per-id 全等 + 计数精确（重启本身零新增；d2 停机 seal +1）──
    await d2.stop();
    const postDump = dumpEvents(dbPath, sid);
    const postById = new Map(postDump.map((r) => [r.id, r]));
    expect(postDump.length).toBe(preDump.length + 3 + 1); // 直插 3 行 + d2 停机 seal 1 行
    expect(sealOf(postDump)).toHaveLength(2);
    for (const pre of preDump) {
      const post = postById.get(pre.id);
      expect(post, `domain_events id=${pre.id}（${pre.type}）重启后缺失`).toBeDefined();
      expect({
        type: post!.type,
        inst: post!.agent_instance_id,
        ts: post!.ts,
        payload: post!.payload,
      }).toEqual({ type: pre.type, inst: pre.agent_instance_id, ts: pre.ts, payload: pre.payload });
    }
    const legacyDump = postDump.filter((r) => r.agent_instance_id === LEGACY_ID);
    expect(legacyDump.map((r) => r.type)).toEqual(["agent.spawned", "message.completed", "agent.completed"]);

    // ── 重启后页面：上下文卡可重建 + 快照缺失降级 ─────────────
    //（d2 已停：页面断言基于重连期间已拉取的数据面，故重开 daemon 再验页面）
    const d3 = await e2e.startDaemon({
      script: { entries: [reply("重启后续轮。（完RR）")] },
      home,
      retries: 8,
    });
    await e2e.waitForConnected(page, 30_000);
    await expect(page.locator(".p1-tbody .p1-entry")).toHaveCount(preDump.length + 4, { timeout: 15_000 });
    // 面板 3 实例（主 + Sub + 历史实例）
    await expect(page.locator(".ip-count")).toHaveText("3 实例");
    // 历史实例：快照缺失降级（卡保留 + 标注，无 prompt 段，不报错）
    const legacyItem = page.locator(".ip-item:not(.ip-all)").filter({ hasText: LEGACY_ID });
    await expect(legacyItem).toHaveAttribute("data-status", "completed");
    await expect(legacyItem.locator(".ii-name")).toContainText("历史调研任务");
    await legacyItem.click();
    await expect(card.locator(".ctx-missing .hud-badge")).toHaveText("快照缺失");
    await expect(card.locator(".ctx-missing-hint")).toContainText("执行上下文不可回溯");
    await expect(card.locator(".cp-body")).toHaveCount(0);
    // 主实例卡可重建：快照 + 模型时间线（与 replaySubAgentHistory 同源 domain_events）
    await page.locator(".ip-item:not(.ip-all)").filter({ hasText: "主实例" }).click();
    await expect(card.locator(".cp-body")).toBeVisible();
    await expect(card.locator(".ctx-facts")).toContainText("compaction");
    await expect(card.locator(".tl-cur")).toContainText(TARGET_MODEL);
    await expect(card.locator(".tl-cur")).toContainText("当前");
    // Sub 卡可重建 + 同源采样：trace 行与聊天抽屉重放读同一事件源（文本一致）
    await page.locator(".ip-item:not(.ip-all)").filter({ has: page.locator(".ii-pk", { hasText: "subagent-worker" }) }).click();
    await expect(card.locator(".cp-body")).toBeVisible();
    await expect(card.locator("blockquote.ctx-task")).toContainText(SA_TASK);
    const subMsgRow = page.locator(".p1-entry", { hasText: SA_MARKER });
    await expect(subMsgRow).toHaveCount(1);
    const traceSummary = await subMsgRow.locator(".p1-summary").innerText();
    expect(traceSummary).toContain(SA_MARKER);
    await shotLocal(page, "e2e-trace-after-restart");
    // 聊天面同源样本：抽屉重放 bubble 含同一 Sub 回复文本
    await page.locator('.rail-btn[data-page="chat"]').click();
    await expect(page.locator(".sa-card.done")).toHaveCount(1, { timeout: 15_000 });
    await page.locator(".sa-card.done").click();
    const drawer = page.locator(".drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".ch-msg .bubble")).toContainText(SA_MARKER, { timeout: 15_000 });
    await page.keyboard.press("Escape");

    await d3.stop();
    writeLocalEvidence(
      "e2e-trace-restart",
      [
        "T2.3 CL-5 E 层 T4（重启回放一致性 + 快照缺失降级）：PASS",
        `事件不丢不错: UI 行序列（直插 3 行居首 + seal 行 + 原 ${preTotal} 行逐行相等）；DB per-id 全等 ${preDump.length} 行 + 计数精确（seal 为优雅停机既设计口径：d1/d2 各 +1）`,
        "上下文卡可重建: 主（快照+compaction+时间线当前高亮）/ Sub（快照+task 引用块）重启后均可重建",
        `快照缺失降级: ${LEGACY_ID}（直插无 instantiated）→ 「快照缺失」标注 + 无 prompt 段，不报错`,
        `同源采样: trace message.completed 摘要与聊天抽屉重放 bubble 均含「${SA_MARKER}」（同一 domain_events 源）`,
      ].join("\n"),
    );
  });
});
