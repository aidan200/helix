import { describe, expect, test } from "bun:test";
import { MAIN_SESSION_SYSTEM_PROMPT } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";

/**
 * T3-C 提示词正向契约（删轮询邀请）：MAIN_SESSION_SYSTEM_PROMPT 关键契约句
 * 常量断言——spawn 后结束回合 + closure/进展报告自动注入 + 不轮询不抢跑 +
 * 零增量 agent_inspect 核实 + agent_status 仅用户主动询问时使用。
 */
describe("T3-C 主会话提示词正向契约", () => {
  test("① 轮询邀请已删除（不再出现「查询进度」邀请句）", () => {
    expect(MAIN_SESSION_SYSTEM_PROMPT).not.toContain("查询进度");
  });

  test("② 关键契约句齐备：结束回合 / 自动注入 / 不轮询不抢跑 / reportIntervalMs / agent_inspect 核实", () => {
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("结束回合");
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("自动注入");
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("不要轮询 agent_status 等待结果");
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("自行重做该任务");
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("reportIntervalMs");
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("agent_inspect 核实");
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("agent_status 仅在用户主动询问进度时使用");
  });

  test("③ 链 C 挂起/恢复指引：暂停用 agent_park；继续先查 parked 再 agent_resume（closure 照常注入）", () => {
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("用户要求暂停某实例时用 agent_park");
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("先 agent_status 查看 parked 实例再 agent_resume 恢复");
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("closure 会照常注入驱动下一轮");
  });
});
