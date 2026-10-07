/**
 * summary.* 通用总结配置域单测（会话总结器独立化批①；TDD 红绿证据链）。
 *
 * 断言面：
 * 1. summary.everyTurns 值语义（resolveSummaryEveryTurns 读面单点裁决）：
 *    合法 1-20 原样生效；非法（0/21/非数字/负数/小数）静默回退缺省 3 不抛错；
 *    缺席/空串 = 缺省；
 * 2. readSummaryConfig：五键现态（enabled/everyTurns/model/task{enabled,model}）
 *    ——model 空串归一 null（未配置态），enabled 只认 "1"；
 * 3. 一次性幂等迁移 migrateLegacySummaryKeys：
 *    - topic_config 单键 JSON（enabled/model；classifyEndpointId 判官退役随旧键
 *      清理丢弃）+ steward.sessionmemory.{enabled,everyturns,model} +
 *      steward.summary.{enabled,model} → summary.*；
 *    - summary.enabled 取「任一旧开关开即开」合流（特性族归一：开面只增不减）；
 *    - summary.model 保序回落（sessionmemory.model → topic_config.model——旧
 *      联合槽位回落链语义保序迁移）；
 *    - 新域已有值不覆盖（新域优先），旧键无条件清空；
 *    - 二次启动零改写（迁移后重跑零 set 调用）+ 旧键清理；
 * 4. 任务总结 gate 换键位后三条件语义不变（管家开 ∧ summary.task.enabled ∧
 *    summary.task.model 配——断点任一回退极简通知的判据在 StewardDiagnosisAdapter
 *    已测，此处钉键位）。
 */
import { describe, expect, test } from "bun:test";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import {
  LEGACY_STEWARD_SESSION_MEMORY_ENABLED_KEY,
  LEGACY_STEWARD_SESSION_MEMORY_EVERY_TURNS_KEY,
  LEGACY_STEWARD_SESSION_MEMORY_MODEL_KEY,
  LEGACY_STEWARD_SUMMARY_ENABLED_KEY,
  LEGACY_STEWARD_SUMMARY_MODEL_KEY,
  LEGACY_TOPIC_CONFIG_KEY,
  SUMMARY_ENABLED_KEY,
  SUMMARY_EVERY_TURNS_DEFAULT,
  SUMMARY_EVERY_TURNS_KEY,
  SUMMARY_MODEL_KEY,
  SUMMARY_TASK_ENABLED_KEY,
  SUMMARY_TASK_MODEL_KEY,
  migrateLegacySummaryKeys,
  readSummaryConfig,
  resolveSummaryEveryTurns,
} from "../../src/application/summary/summaryConfig";

function fakeConfig(initial: Record<string, string> = {}) {
  const kv = new Map(Object.entries(initial));
  const setCalls: { key: string; value: string }[] = [];
  const config: RuntimeConfigPort & { kv: Map<string, string>; setCalls: { key: string; value: string }[] } = {
    kv,
    setCalls,
    get: (key) => kv.get(key),
    set: async (key, value) => {
      setCalls.push({ key, value });
      kv.set(key, value);
    },
  };
  return config;
}

describe("summary.everyTurns 值语义（读面单点裁决）", () => {
  test("合法值原样生效；非法静默回退缺省 3（warn 不抛错）", () => {
    const warns: string[] = [];
    expect(resolveSummaryEveryTurns(fakeConfig({ [SUMMARY_EVERY_TURNS_KEY]: "5" }), (m) => warns.push(m))).toBe(5);
    expect(resolveSummaryEveryTurns(fakeConfig({ [SUMMARY_EVERY_TURNS_KEY]: "1" }))).toBe(1);
    expect(resolveSummaryEveryTurns(fakeConfig({ [SUMMARY_EVERY_TURNS_KEY]: "20" }))).toBe(20);
    expect(resolveSummaryEveryTurns(fakeConfig({ [SUMMARY_EVERY_TURNS_KEY]: " 4 " }))).toBe(4); // 前后空白容忍
    for (const bad of ["0", "21", "-1", "abc", "3.5", ""]) {
      const w: string[] = [];
      expect(resolveSummaryEveryTurns(fakeConfig({ [SUMMARY_EVERY_TURNS_KEY]: bad }), (m) => w.push(m))).toBe(
        SUMMARY_EVERY_TURNS_DEFAULT,
      );
    }
    expect(resolveSummaryEveryTurns(fakeConfig())).toBe(SUMMARY_EVERY_TURNS_DEFAULT);
    expect(warns).toHaveLength(0); // 合法值零 warn
  });
});

describe("readSummaryConfig（五键现态）", () => {
  test("缺省全关；model 空串归一 null；enabled 只认 \"1\"；task 独立键位", () => {
    const state = readSummaryConfig(fakeConfig());
    expect(state).toEqual({
      enabled: false,
      everyTurns: SUMMARY_EVERY_TURNS_DEFAULT,
      model: null,
      task: { enabled: false, model: null },
    });
    const full = readSummaryConfig(
      fakeConfig({
        [SUMMARY_ENABLED_KEY]: "1",
        [SUMMARY_EVERY_TURNS_KEY]: "7",
        [SUMMARY_MODEL_KEY]: "deepseek/summary-flash",
        [SUMMARY_TASK_ENABLED_KEY]: "1",
        [SUMMARY_TASK_MODEL_KEY]: "openai/task-summary",
      }),
    );
    expect(full).toEqual({
      enabled: true,
      everyTurns: 7,
      model: "deepseek/summary-flash",
      task: { enabled: true, model: "openai/task-summary" },
    });
    const blanks = readSummaryConfig(
      fakeConfig({ [SUMMARY_ENABLED_KEY]: "0", [SUMMARY_MODEL_KEY]: "  ", [SUMMARY_TASK_MODEL_KEY]: "" }),
    );
    expect(blanks.enabled).toBe(false);
    expect(blanks.model).toBeNull();
    expect(blanks.task.model).toBeNull();
  });
});

describe("migrateLegacySummaryKeys（一次性幂等迁移）", () => {
  test("三处旧键合流迁入 summary.*：enabled 任一旧开即开、model 保序回落、task 两键直迁", async () => {
    const config = fakeConfig({
      [LEGACY_TOPIC_CONFIG_KEY]: JSON.stringify({ enabled: true, model: "deepseek/topic-flash", classifyEndpointId: "ep-judge" }),
      [LEGACY_STEWARD_SESSION_MEMORY_ENABLED_KEY]: "0",
      [LEGACY_STEWARD_SESSION_MEMORY_EVERY_TURNS_KEY]: "6",
      [LEGACY_STEWARD_SESSION_MEMORY_MODEL_KEY]: "deepseek/session-flash",
      [LEGACY_STEWARD_SUMMARY_ENABLED_KEY]: "1",
      [LEGACY_STEWARD_SUMMARY_MODEL_KEY]: "openai/task-summary",
    });
    const migrated = await migrateLegacySummaryKeys(config);
    expect(migrated).toBe(true);
    expect(config.kv.get(SUMMARY_ENABLED_KEY)).toBe("1"); // topic 开 → 合流开
    expect(config.kv.get(SUMMARY_EVERY_TURNS_KEY)).toBe("6");
    expect(config.kv.get(SUMMARY_MODEL_KEY)).toBe("deepseek/session-flash"); // sessionmemory 优先
    expect(config.kv.get(SUMMARY_TASK_ENABLED_KEY)).toBe("1");
    expect(config.kv.get(SUMMARY_TASK_MODEL_KEY)).toBe("openai/task-summary");
    // 旧键清理（空串 = 未配置态；topic_config 整键清空——classifyEndpointId
    // 随判官退役丢弃，不迁移）
    for (const key of [
      LEGACY_TOPIC_CONFIG_KEY,
      LEGACY_STEWARD_SESSION_MEMORY_ENABLED_KEY,
      LEGACY_STEWARD_SESSION_MEMORY_EVERY_TURNS_KEY,
      LEGACY_STEWARD_SESSION_MEMORY_MODEL_KEY,
      LEGACY_STEWARD_SUMMARY_ENABLED_KEY,
      LEGACY_STEWARD_SUMMARY_MODEL_KEY,
    ]) {
      expect(config.kv.get(key) ?? "").toBe("");
    }
  });

  test("model 回落链保序：sessionmemory.model 缺席 → topic_config.model 兜底", async () => {
    const config = fakeConfig({
      [LEGACY_TOPIC_CONFIG_KEY]: JSON.stringify({ enabled: true, model: "deepseek/topic-flash" }),
    });
    await migrateLegacySummaryKeys(config);
    expect(config.kv.get(SUMMARY_MODEL_KEY)).toBe("deepseek/topic-flash");
    expect(config.kv.get(SUMMARY_ENABLED_KEY)).toBe("1");
  });

  test("两旧开关皆关 → summary.enabled=\"0\"；全新用户（零旧键）零写入", async () => {
    const off = fakeConfig({
      [LEGACY_TOPIC_CONFIG_KEY]: JSON.stringify({ enabled: false }),
      [LEGACY_STEWARD_SESSION_MEMORY_ENABLED_KEY]: "0",
    });
    await migrateLegacySummaryKeys(off);
    expect(off.kv.get(SUMMARY_ENABLED_KEY)).toBe("0");
    const fresh = fakeConfig();
    expect(await migrateLegacySummaryKeys(fresh)).toBe(false);
    expect(fresh.setCalls).toHaveLength(0);
  });

  test("新域优先不覆盖；二次启动零改写（幂等重跑零 set 调用）", async () => {
    const config = fakeConfig({
      [SUMMARY_ENABLED_KEY]: "1",
      [SUMMARY_MODEL_KEY]: "keep/me",
      [LEGACY_TOPIC_CONFIG_KEY]: JSON.stringify({ enabled: true, model: "old/model" }),
      [LEGACY_STEWARD_SUMMARY_ENABLED_KEY]: "1",
      [LEGACY_STEWARD_SUMMARY_MODEL_KEY]: "old/task-model",
    });
    await migrateLegacySummaryKeys(config);
    expect(config.kv.get(SUMMARY_MODEL_KEY)).toBe("keep/me"); // 新域优先
    expect(config.kv.get(SUMMARY_ENABLED_KEY)).toBe("1");
    // 二次启动：旧键已清 → 零改写
    config.setCalls.length = 0;
    expect(await migrateLegacySummaryKeys(config)).toBe(false);
    expect(config.setCalls).toHaveLength(0);
    expect(config.kv.get(SUMMARY_MODEL_KEY)).toBe("keep/me");
  });
});

describe("任务总结 gate 键位（summary.task.*）", () => {
  test("三条件键位语义不变：管家开 ∧ summary.task.enabled=\"1\" ∧ summary.task.model 非空", () => {
    // 键位判据纯读面（管家开关键在 StewardService 单源——此处只钉总结组两键）
    const on = readSummaryConfig(
      fakeConfig({ [SUMMARY_TASK_ENABLED_KEY]: "1", [SUMMARY_TASK_MODEL_KEY]: "openai/task-summary" }),
    );
    expect(on.task.enabled && (on.task.model ?? "") !== "").toBe(true);
    const noModel = readSummaryConfig(fakeConfig({ [SUMMARY_TASK_ENABLED_KEY]: "1", [SUMMARY_TASK_MODEL_KEY]: "" }));
    expect(noModel.task.enabled && (noModel.task.model ?? "") !== "").toBe(false);
    const off = readSummaryConfig(
      fakeConfig({ [SUMMARY_TASK_ENABLED_KEY]: "0", [SUMMARY_TASK_MODEL_KEY]: "openai/task-summary" }),
    );
    expect(off.task.enabled && (off.task.model ?? "") !== "").toBe(false);
  });
});
