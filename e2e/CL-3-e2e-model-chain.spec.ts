/**
 * T4.2 —— CL-3 模型真链路（真 daemon，E 层；AD-2 / 契约 C；test-design K-1）。
 *
 * 断言链（FakeLLM 模型感知：launcher 每 turn 实际请求的 model 追加记录
 * <home>/llm-model-log.jsonl——set_model 语义的机械判据数据源）：
 * ① auth.json 写入面：设置页模型分区 anthropic 录 key（auth.set_key）→ Node 侧核验
 *    0600 + Credential 形状 + 锁零残留 + 分区脱敏回显（T5.3 起前置——
 *    菜单可用性口径下 provider 未配置的模型不在 P-3 菜单显示）；
 * ② builtin fallback 无外网（K-1）：daemon 注入死代理 HTTP(S)_PROXY →
 *    model.catalog 刷新全部失败（快失不超时）→ P-3 菜单列出 configured
 *    provider 分组（anthropic 在场）+ SQLite 默认读面（claude-sonnet-4-5
 *    DEFAULT 徽标 = model.get_default）；
 * ③ 首 turn 记录初始模型（fake/model）；
 * ④ set_model 下一 turn 生效 + in-flight 不变：慢速 turn2 流式中经 P-3 菜单
 *    切到 anthropic/claude-haiku-4-5（catalog 校验 → ChatService → 引擎
 *    AgentState.model 直改全链真跑）→ 徽标即时更新（model.changed 广播）
 *    → turn2 以旧模型完成（记录面 fake/model）→ turn3 记录面新值；
 * ⑤ P-4 全局默认链：顶部只读展示 + 行内「设为默认」（2dad85e 选择器
 *    #sel-default 退役）→ openai/gpt-4.1（model.set_default）→ 展示即时反映。
 *
 * 「新会话继承 SQLite 默认」（set_default → 新草稿会话引擎 currentModel）
 * 的引擎构造期链路在 E 层 FakeLLM 引擎注入形态下不可观测（注入引擎绕过
 * 生产 engineFor 的默认模型源）——以集成级证据覆盖：
 * apps/daemon/test/integration/default-model.test.ts「set_default 后新建草稿
 * 会话 → 引擎 currentModel = 新默认；既有会话不跟随」（本 spec ④ 验浏览器
 * 面的 set_default/get_default 真链路，与集成证据互补拼合完整链）。
 */
import { test, expect } from "./harness/daemon-fixture";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { reply, slowReply, type DaemonScript } from "./harness/daemon-script";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const TARGET = "anthropic/claude-haiku-4-5";
const DEFAULT_INIT = "anthropic/claude-sonnet-4-5";
const NEW_DEFAULT = "openai/gpt-4.1";
const API_KEY = "sk-e2e-test-key-1234";

/** 通用前置：建 home+沙箱。 */
function prepHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "helix-e2e-cl3-model-"));
  mkdirSync(path.join(home, "sandbox"), { recursive: true });
  return home;
}

/** 读取模型记录面（每 turn 一行 JSON）。 */
function readModelLog(home: string): string[] {
  const file = path.join(home, "llm-model-log.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => (JSON.parse(l) as { model: string }).model);
}

test.describe("T4.2 CL-3 模型真链路（真 daemon）", () => {
  test("builtin fallback 无外网 + set_model 下一 turn 生效（in-flight 不变）+ auth.json 写入面", async ({ e2e, page }) => {
    test.setTimeout(180_000);
    const home = prepHome();
    const script: DaemonScript = {
      entries: [
        reply("模型链首轮回复。（完M1）"), // turn1（初始模型）
        slowReply("模型链慢速轮：流式中切模型，本 turn 应以旧模型完成。（完M2）", 400, 4), // turn2（in-flight 切模）
        reply("模型链第三轮：应以新模型请求。（完M3）"), // turn3（新模型）
      ],
    };
    // 死代理：daemon 进程外网全不可达且快失（builtin fallback 判据前提）
    const deadProxy = { HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" };

    const d = await e2e.startDaemon({ script, home, env: deadProxy });
    await e2e.openApp(page);
    await e2e.waitForConnected(page);

    // ── ① auth.json 写入面（auth.set_key → AuthStore；T5.3 起前置——
    //    菜单仅显示 configured provider 的可用模型）────────────────
    await page.locator('.rail-btn[data-page="settings"]').click();
    await expect(page.locator("[data-models-section]")).toBeVisible();
    const provAnthropic = page.locator('[data-prov="anthropic"]');
    await provAnthropic.locator("[data-prov-toggle]").click();
    await provAnthropic.locator("[data-prov-addkey]").click();
    await page.locator("#key-input").fill(API_KEY);
    await page.locator("#btn-modal-save").click();
    // P-4 脱敏回显（auth.list 结果帧：configured + 尾 4 位）
    await expect(provAnthropic.locator(".key-chip")).toBeVisible({ timeout: 10_000 });
    await expect(provAnthropic.locator(".key-chip")).toContainText("1234");
    // Node 侧核验：0600 权限位 + Credential JSON 形状 + 锁零残留
    const authPath = path.join(home, "auth.json");
    expect(existsSync(authPath)).toBe(true);
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
    const authFile = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { type: string; key?: string }>;
    expect(authFile.anthropic).toEqual({ type: "api_key", key: API_KEY });
    expect(existsSync(`${authPath}.lock`)).toBe(false); // 锁文件用后即删
    await shotEvidence(page, "cl3-model-auth-json", "CL-3");
    await page.locator('.rail-btn[data-page="chat"]').click();
    await expect(page.locator("[data-settings-page]")).toHaveCount(0);

    // ── ② builtin fallback 无外网（K-1）+ 默认读面 ────────────
    const badge = page.locator("[data-model-badge]");
    await expect(badge).toHaveText("fake/model");
    await badge.click();
    const menu = page.locator(".model-menu");
    await expect(menu).toBeVisible();
    // 死代理下目录刷新全部失败 → 保底 builtin；T5.3 可用性口径下仅
    // configured 的 anthropic 分组在场（未配置分组整体隐藏）
    await expect(menu.locator('[data-group="anthropic"]')).toBeVisible({ timeout: 15_000 });
    await expect(menu.locator(`[data-model-item="${TARGET}"]`)).toBeVisible();
    // SQLite 默认读面（model.get_default → DEFAULT 徽标）
    await expect(menu.locator(`[data-model-item="${DEFAULT_INIT}"] .mm-def`)).toBeVisible();
    await shotEvidence(page, "cl3-model-catalog-builtin", "CL-3");

    // ── ③ 首 turn：初始模型记录 ───────────────────────────────
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await e2e.send(page, "模型链第一轮");
    await e2e.waitForTurnDone(page, "（完M1）");
    expect(readModelLog(home)).toEqual(["fake/model"]);

    // ── ④ set_model：in-flight 不变 + 下一 turn 新值 ──────────
    await e2e.send(page, "模型链第二轮（慢速）");
    await expect(page.locator(".stream-cursor")).toBeVisible({ timeout: 10_000 });
    // 流式中切模型（catalog 校验 → ChatService.setModel → 引擎 AgentState.model）
    await badge.click();
    await expect(menu).toBeVisible();
    await menu.locator(`[data-model-item="${TARGET}"]`).click();
    // 即时 ack 面：model.changed 广播 → 徽标更新（in-flight run 不受影响）
    await expect(badge).toHaveText(TARGET, { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await shotEvidence(page, "cl3-model-switched-inflight", "CL-3");
    // turn2 以旧模型完成（记录面第 2 行 = fake/model）
    await e2e.waitForTurnDone(page, "（完M2）", 30_000);
    expect(readModelLog(home)).toEqual(["fake/model", "fake/model"]);
    // turn3：新模型生效（记录面第 3 行 = TARGET）
    await e2e.send(page, "模型链第三轮");
    await e2e.waitForTurnDone(page, "（完M3）");
    expect(readModelLog(home)).toEqual(["fake/model", "fake/model", TARGET]);
    writeEvidence(
      "cl3-model-per-turn-log",
      "txt",
      `FakeLLM 每 turn model 记录面（${path.join(home, "llm-model-log.jsonl")}）：\n${readModelLog(home).join("\n")}\n判据: turn2 流式中 set_model → in-flight 旧值 fake/model 完成；turn3 新值 ${TARGET}\n`,
      "CL-3",
    );

    // ── ⑤ P-4 全局默认链：顶部只读展示 + 行内设默认（2dad85e 选择器退役）──
    // S1：菜单内 P-3 → P-4 流转入口（mm-more）随 onOpenSettings 链退役，改走 rail 导航
    await page.locator("#msg-input").click(); // 点输入条关菜单（点外关闭）
    await expect(menu).toBeHidden();
    await page.locator('.rail-btn[data-page="settings"]').click();
    await expect(page.locator("[data-models-section]")).toBeVisible();
    await expect(page.locator("#sel-default")).toHaveCount(0); // 选择器形态退役钉住
    const display = page.locator("[data-default-model]");
    await expect(display).toHaveText(DEFAULT_INIT, { timeout: 15_000 }); // get_default 读面
    // 行内设默认：openai 组展开 → gpt-4.1 行内按钮 → set_default → 展示即时反映
    await page.locator('[data-prov="openai"] [data-prov-toggle]').click();
    await page.locator(`[data-set-default="${NEW_DEFAULT}"]`).click();
    await expect(display).toHaveText(NEW_DEFAULT, { timeout: 10_000 });
    await expect(page.locator(`[data-model-row="${NEW_DEFAULT}"]`)).toHaveClass(/is-default/);
    await shotEvidence(page, "cl3-model-set-default", "CL-3");

    // 返回工作台：徽标仍为会话模型（per-session 不随 set_default 变）
    await page.locator('.rail-btn[data-page="chat"]').click();
    await expect(badge).toHaveText(TARGET, { timeout: 10_000 });

    await d.stop();
    writeEvidence(
      "cl3-model-chain",
      "txt",
      [
        "T4.2 CL-3 模型真链路：PASS（T5.3：auth 配置前置——菜单可用性口径）",
        "① auth.json: 0600 + {anthropic: {type: api_key, key}} + 锁零残留 + P-4 脱敏回显（····1234）",
        "② builtin fallback 无外网（K-1）: 死代理下 model.catalog 刷新全失败 → builtin 合并目录；",
        `   可用性口径下 configured 的 anthropic 分组在场 + SQLite 默认读面（${DEFAULT_INIT} DEFAULT 徽标）`,
        "③ 首 turn 记录: fake/model",
        `④ set_model 下一 turn 生效: 流式中切 ${TARGET} → 徽标即时更新（model.changed）;`,
        "   turn2 记录面 fake/model（in-flight 不变）→ turn3 记录面新值",
        `⑤ P-4 set_default: ${DEFAULT_INIT} → ${NEW_DEFAULT}（2dad85e 只读展示 + 行内设默认）`,
        "补充: 「新会话继承 SQLite 默认」引擎构造期链路以集成级证据覆盖",
        "  （default-model.test.ts：set_default 后新建草稿会话 → 引擎 currentModel = 新默认）",
      ].join("\n"),
      "CL-3",
    );
  });
});
