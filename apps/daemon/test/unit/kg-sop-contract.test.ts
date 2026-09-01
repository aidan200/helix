import { describe, expect, test } from "bun:test";
import { MAIN_SESSION_SYSTEM_PROMPT } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SUBAGENT_SYSTEM_PROMPT } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "../../src/adapters/driven/pi-engine/runtime/profiles/OrchestratorProfile";
import {
  PLAN_HARD_CONSTRAINT_SEGMENT,
  TEMPLATE_HARD_CONSTRAINTS,
} from "../../src/adapters/driven/pi-engine/runtime/templates/catalog";

/**
 * W3-G 知识纪律 SOP 正向契约（kg-driven-dev-loop 设计 R11 软硬分层 + R23
 * scene 三层）：三 profile base prompt 的「遵循知识库 + 完善知识库」软层纪律
 * 关键句常量断言（先例：main-prompt-contract T3-C 契约句断言）。
 *
 * 断言面：
 * - Main/SubAgent：第一铁律（1% 相关必读全文，与技能铁律同构同级）+ 开工链路
 *   （codegraph 落地符号 → kg affected 锚反查 → kg get 读全文）+ 改后纪律
 *   （📎 必读 / kg-update supersede 随改动 / createNode scene 必填）。
 * - SubAgent 专属：闭环纪律——sediment 经 closure findings 上报，禁止直接调
 *   proposeCandidate/decideCandidate（MainAgent 单点）。
 * - Main 专属：候选台账唯一写者（decideCandidate）+ 清台前必看 kg.health
 *   看板五项（R16）+ sync 提示向用户确认后触发（R13 动手权在用户）。
 * - Orchestrator：只加 brief 派发提示一句（AD-10：不挂 codegraph/kg-update）。
 * - 硬约束面不动：三条硬约束恰三条、plan 硬约束段原文不变（R12 不装新门禁）。
 */

describe("W3-G 知识纪律 SOP（R11 软层 + R23 scene）", () => {
  describe("第一铁律（Main + SubAgent 同构同级）", () => {
    for (const [label, prompt] of [
      ["Main", MAIN_SESSION_SYSTEM_PROMPT],
      ["SubAgent", SUBAGENT_SYSTEM_PROMPT],
    ] as const) {
      test(`${label}：第一铁律关键句齐备（1% 相关 / kg get 读全文 / 宁可多读不可漏读 / scene 适用场景）`, () => {
        expect(prompt).toContain("第一铁律");
        expect(prompt).toContain("1% 相关");
        expect(prompt).toContain("kg get");
        expect(prompt).toContain("宁可多读，不可漏读");
        expect(prompt).toContain("scene 适用场景");
      });
    }
  });

  describe("开工链路（Main + SubAgent 同构）", () => {
    for (const [label, prompt] of [
      ["Main", MAIN_SESSION_SYSTEM_PROMPT],
      ["SubAgent", SUBAGENT_SYSTEM_PROMPT],
    ] as const) {
      test(`${label}：开工链路三段（codegraph 落地符号 → kg affected 锚反查 → kg get 读全文）+ impact 查影响面`, () => {
        expect(prompt).toContain("开工链路");
        expect(prompt).toContain("codegraph");
        expect(prompt).toContain("kg affected");
        expect(prompt).toContain("锚反查");
        expect(prompt).toContain("impact 查影响面");
      });
    }
  });

  describe("改后纪律（W-R6 写面收权分叉：Main 直落 / SubAgent findings 申报）", () => {
    test("Main：📎 必读 / kg-update supersede 随改动直落 / createNode scene 必填（收权后 Main 独占即时落账面）", () => {
      const p = MAIN_SESSION_SYSTEM_PROMPT;
      expect(p).toContain("📎 知识块必须读");
      expect(p).toContain("kg-update supersede");
      expect(p).toContain("不许「下次再说」");
      expect(p).toContain("createNode");
      expect(p).toContain("scene 必填");
    });

    test("SubAgent：supersede/createNode 声明（含 scene）写入 closure findings 申报，由 MainAgent 在阶段检查点统一落账", () => {
      const p = SUBAGENT_SYSTEM_PROMPT;
      expect(p).toContain("📎 知识块必须读");
      expect(p).toContain("supersede/createNode 声明（含 scene");
      expect(p).toContain("写入 closure findings 申报");
      expect(p).toContain("由 MainAgent 在阶段检查点统一落账");
      expect(p).toContain("不许「下次再说」");
      // W-R6 收权：worker 提示词不再引导直接调 kg-update（工具面也注册不到）
      expect(p).not.toContain("kg-update");
    });
  });

  describe("SubAgent 专属：闭环纪律（R2 候选单点重申）", () => {
    test("sediment 经 closure findings 上报 + 禁止直接调候选 op", () => {
      expect(SUBAGENT_SYSTEM_PROMPT).toContain("闭环纪律");
      expect(SUBAGENT_SYSTEM_PROMPT).toContain("sediment");
      expect(SUBAGENT_SYSTEM_PROMPT).toContain("closure findings 上报");
      expect(SUBAGENT_SYSTEM_PROMPT).toContain("禁止直接调用 proposeCandidate/decideCandidate");
      expect(SUBAGENT_SYSTEM_PROMPT).toContain("MainAgent 单点");
    });

    test("findings 结构化 schema 明确（changeType/name/targetNode/project + iterationId/taskId 接线层回落）", () => {
      const p = SUBAGENT_SYSTEM_PROMPT;
      expect(p).toContain("changeType");
      expect(p).toContain("targetNode");
      expect(p).toContain("project");
      expect(p).toContain("iterationId 由接线层回落");
      expect(p).toContain("taskId 由接线层机械注入");
    });
  });

  describe("Main 专属：候选台账 + 体检 + sync 确认（R2/R16/R13）", () => {
    test("台账唯一写者 decideCandidate + 清台前必看 kg.health 五项 + sync 用户确认", () => {
      expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("台账唯一写者");
      expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("decideCandidate");
      expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("applied/discarded/deferred");
      expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("kg.health 看板五项");
      expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("kg sync 提示");
      expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("动手权在用户");
    });

    test("SubAgent 不携带 Main 专属纪律（台账裁决/sync 提示职责不进 worker prompt）", () => {
      expect(SUBAGENT_SYSTEM_PROMPT).not.toContain("decideCandidate 裁决");
      expect(SUBAGENT_SYSTEM_PROMPT).not.toContain("kg.health");
    });
  });

  describe("W-R4/W-R6 检查点落账 + W-R5 worktree 豁免（Main 工程纪律）", () => {
    test("阶段检查点落账 SubAgent 经 findings 申报的 kg 变更（supersede/createNode 走 kg-update，知识与代码同一检查点合入）", () => {
      expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("落账 SubAgent 经 findings 申报的 kg 变更");
      expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("supersede/createNode 走 kg-update");
      expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("知识与代码同一检查点合入");
    });

    test("工程纪律①：图谱产出型任务（kg-bootstrap/kg-review）不开 worktree，主工作树执行（W-R5）", () => {
      expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("图谱产出型任务（kg-bootstrap/kg-review）不开 worktree，主工作树执行");
    });
  });

  describe("Orchestrator：只加 brief 派发提示一句（AD-10 不挂写面）", () => {
    test("派发提示句齐备（codegraph → kg affected → kg get）", () => {
      expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("派发提示");
      expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("开工链路");
      expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("codegraph 落地符号 → kg affected 锚反查 → kg get 读全文");
    });

    test("Orchestrator 工具面不变（无 codegraph/kg-update——AD-10）", () => {
      // 工具面契约由编排装配断言；此处锚定 prompt 不承诺新工具（派发提示是
      // 给执行者的 brief 指引，非编排器自持工具）
      expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("kg-update");
    });
  });

  describe("硬约束面零改动（R12：本批全是软层，不装新门禁）", () => {
    test("三条硬约束恰三条且 id 集不变", () => {
      expect(TEMPLATE_HARD_CONSTRAINTS.map((c) => c.id)).toEqual([
        "brief-three-elements",
        "report-summary-findings",
        "no-empty-section",
      ]);
    });

    test("PLAN_HARD_CONSTRAINT_SEGMENT 原文（五条 + 模板层强制标题；第 5 条 = 按计划条目逐步 commit，2026-08-30 用户裁决补入）", () => {
      expect(PLAN_HARD_CONSTRAINT_SEGMENT).toContain("## plan 硬约束（任务系统追加，模板层强制——不可裁）");
      expect(PLAN_HARD_CONSTRAINT_SEGMENT).toContain("1. 开工先建工作台账（一次给出全部计划条目）再动手执行；");
      expect(PLAN_HARD_CONSTRAINT_SEGMENT).toContain("2. 阶段转换必须同步更新台账项状态（in_progress/done/abandoned）；");
      expect(PLAN_HARD_CONSTRAINT_SEGMENT).toContain("3. 收口时台账须全部 resolve——每项 done，或 abandoned 且带非空理由 note；");
      expect(PLAN_HARD_CONSTRAINT_SEGMENT).toContain("4. 台账 note 记录关键事实与产物指针（文件路径/知识节点 id），供接力恢复与幂等重跑使用。");
      expect(PLAN_HARD_CONSTRAINT_SEGMENT).toContain("5. 按计划条目逐步提交（commit）——每条目完成且验证绿即提交一次；收尾前先提交，未提交的工作等于没做。");
    });
  });
});
