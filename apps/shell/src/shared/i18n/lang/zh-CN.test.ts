/**
 * i18n zh-CN 词条完备性测试（AG-16-②）：覆盖 prototype/review.md「P-1 文案
 * key 清单」全集（40+ key，含 theme.dark/light 双键与 tsFormat）；en-US
 * 结构随迁（键集合一致，内容不在本迭代范围）。
 */
import { describe, expect, it } from "vitest";
import { zhCN } from "./zh-CN";
import { enUS } from "./en-US";
import { t } from "@/shared/i18n";
import type { Translations } from "@/shared/i18n/types";

/** review.md「P-1 文案 key 清单」全集（逐行登记，缺一即失败）。 */
const REQUIRED_KEYS = [
  "chat.header.session",
  "chat.header.home",
  "chat.conn.connected",
  "chat.conn.connecting",
  "chat.conn.disconnected",
  "chat.conn.error",
  "chat.banner.reconnecting",
  "chat.banner.reconnectAttempt",
  "chat.banner.reconnectingAddr",
  "chat.overlay.connecting",
  "chat.overlay.addr",
  "chat.error.title",
  "chat.error.desc",
  "chat.error.retry",
  "chat.error.retryOk",
  "chat.error.retryOkSub",
  "chat.empty.title",
  "chat.empty.suggest.read",
  "chat.empty.suggest.test",
  "chat.empty.suggest.grep",
  "chat.composer.placeholder",
  "chat.composer.placeholderConnecting",
  "chat.composer.placeholderWaiting",
  "chat.composer.send",
  "chat.composer.enterHint",
  "chat.composer.projectionNote",
  "chat.steer.hint",
  "chat.steer.queued",
  "chat.steer.drained",
  "chat.restore.toast",
  "chat.restore.toastSub",
  "chat.msg.you",
  "chat.msg.agent",
  "chat.tool.running",
  "chat.tool.done",
  "chat.tool.error",
  "chat.tool.args",
  "chat.tool.result",
  "chat.tool.resultFailed",
  "chat.theme.dark",
  "chat.theme.light",
  "chat.tsFormat",
] as const;

function flatten(obj: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") {
      for (const [p, val] of flatten(v, path)) out.set(p, val);
    } else if (typeof v === "string") {
      out.set(path, v);
    }
  }
  return out;
}

describe("AG-16-② zh-CN 词条完备性", () => {
  const flat = flatten(zhCN);

  it("覆盖 review.md 全部 42 个 key（≥40 口径）", () => {
    expect(REQUIRED_KEYS.length).toBeGreaterThanOrEqual(40);
    const missing = REQUIRED_KEYS.filter((k) => !flat.has(k));
    expect(missing).toEqual([]);
  });

  it("全部词条值为非空字符串（占位空串不算覆盖）", () => {
    const empty = [...flat].filter(([, v]) => v.trim() === "").map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("zh-CN 词条不含多余分支（裁剪版，不搬 desk 全量）", () => {
    // P-1 只需要 chat.* 一族（header 名与发送 hint 等），顶层不应出现 desk 的
    // sidebar/settings/trace/kg 等非 P-1 命名空间。
    expect(Object.keys(zhCN)).toEqual(["chat"]);
  });
});

describe("i18n 结构随迁（en-US）", () => {
  it("en-US 与 zh-CN 键集合一致（值内容不在本迭代范围）", () => {
    const zh = flatten(zhCN);
    const en = flatten(enUS as Translations);
    expect([...en.keys()].sort()).toEqual([...zh.keys()].sort());
  });
});

describe("t() 插值", () => {
  it("{n}/{addr}/{code} 变量替换；缺 key 回退 key 本身", () => {
    const translations = zhCN as unknown as Translations;
    expect(t(translations, "chat.banner.reconnectAttempt", { n: 3 })).toBe("第 3 次尝试");
    expect(t(translations, "chat.overlay.addr", { addr: "ws://127.0.0.1:7333" })).toBe(
      "ws://127.0.0.1:7333",
    );
    expect(t(translations, "chat.not.exists.key")).toBe("chat.not.exists.key");
  });
});
