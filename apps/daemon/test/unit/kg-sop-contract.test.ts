import { describe, expect, test } from "bun:test";
import { MAIN_SESSION_SYSTEM_PROMPT } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SUBAGENT_SYSTEM_PROMPT } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "../../src/adapters/driven/pi-engine/runtime/profiles/OrchestratorProfile";
import {
  PLAN_HARD_CONSTRAINT_SEGMENT,
  TEMPLATE_HARD_CONSTRAINTS,
} from "../../src/adapters/driven/engine-shared/templates/catalog";

/**
 * W3-G 知识纪律 SOP 正向契约（kg-driven-dev-loop 设计 R11 软硬分层 + R23
 * scene 三层）：三 profile base prompt 的「遵循知识库 + 完善知识库」软层纪律
 * 关键句常量断言（先例：main-prompt-contract T3-C 契约句断言）。
 *
 * 断言面：
 * - Main/SubAgent：第一铁律（1% 相关必读全文，与技能铁律同构同级）+ 开工链路
 *   （codegraph 落地符号 → kg affected 锚反查 → kg get 读全文）+ 改后纪律
 *   （📎 必读 / kg-update supersede 随改动 / createNode scene 必填）。
 * - SubAgent 专属：闭环纪律——sediment 经 findings 文件上报，禁止直接调
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
      test(`${label}：开工链路四查（技能在第一铁律 → memory_search 检索用户记忆 → codegraph 落地符号 → kg affected 锚反查 + kg get 读全文）+ impact 查影响面`, () => {
        expect(prompt).toContain("开工链路");
        expect(prompt).toContain("codegraph");
        // 批E 四查：memory_search 检索用户偏好/工作状态类记忆，命中即遵守
        expect(prompt).toContain("memory_search");
        expect(prompt).toContain("用户偏好/工作状态");
        expect(prompt).toContain("命中即遵守");
        expect(prompt).toContain("kg affected");
        expect(prompt).toContain("锚反查");
        expect(prompt).toContain("impact 查影响面");
      });
    }
  });

  describe("决策点双查（任务中途自主决策——两层依据综合考量，与开工/收口对称）", () => {
    for (const [label, prompt] of [
      ["Main", MAIN_SESSION_SYSTEM_PROMPT],
      ["SubAgent", SUBAGENT_SYSTEM_PROMPT],
    ] as const) {
      test(`${label}：决策点双查关键句齐备（未规划到的点 / 两层依据 / 既往习惯综合考量 / 不能只看代码不看用户习惯）`, () => {
        expect(prompt).toContain("决策点双查");
        expect(prompt).toContain("未规划到的点");
        expect(prompt).toContain("用户使用习惯与既往同类问题的处理方案");
        expect(prompt).toContain("综合考量");
        expect(prompt).toContain("不能只看代码不看用户习惯");
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

    test("SubAgent：supersede/createNode 声明（含 scene）写入 findings 文件申报，由 MainAgent 在阶段检查点统一落账", () => {
      const p = SUBAGENT_SYSTEM_PROMPT;
      expect(p).toContain("📎 知识块必须读");
      expect(p).toContain("supersede/createNode 声明（含 scene");
      expect(p).toContain("写入 findings 文件申报");
      expect(p).toContain("由 MainAgent 在阶段检查点统一落账");
      expect(p).toContain("不许「下次再说」");
      // W-R6 收权：worker 提示词不再引导直接调 kg-update（工具面也注册不到）
      expect(p).not.toContain("kg-update");
    });
  });

  describe("改后纪律补语义：kg 写入口查重闸（批3 WP-F 全触点同步）", () => {
    for (const [label, prompt] of [
      ["Main", MAIN_SESSION_SYSTEM_PROMPT],
      ["SubAgent", SUBAGENT_SYSTEM_PROMPT],
    ] as const) {
      test(`${label}：查重闸语义关键句齐备（写入口查重闸 / 相似警告 / 确认改用 updateNode/合并）`, () => {
        expect(prompt).toContain("kg 写入口查重闸");
        expect(prompt).toContain("已存在相似节点");
        expect(prompt).toContain("updateNode/合并");
      });
    }
  });

  describe("SubAgent findings 新节点申报条款式模板（kg 写作规范新口径）", () => {
    test("四要素齐备（条款式 / 预算 ≤500 字 / 禁计数快照 / digest 检索关键词）", () => {
      const p = SUBAGENT_SYSTEM_PROMPT;
      expect(p).toContain("条款式");
      expect(p).toContain("≤500 字");
      expect(p).toContain("禁计数快照");
      expect(p).toContain("检索关键词");
    });
  });

  describe("批5 产线文本清扫：写面持有者条款式口径 + 编排收口锚对账点", () => {
    test("Main：新节点 body/digest 条款式口径进写面持有者提示（条款式 / ≤500 字 / 禁计数快照 / 检索关键词——与 SubAgent findings 申报口径同规）", () => {
      const p = MAIN_SESSION_SYSTEM_PROMPT;
      expect(p).toContain("新节点 body/digest 按 kg 写作规范条款式模板");
      expect(p).toContain("≤500 字");
      expect(p).toContain("禁计数快照");
      expect(p).toContain("检索关键词");
    });

    test("Orchestrator：申报完成前同刻收口锚对账 + 机械处置/人审边界不混装", () => {
      const p = ORCHESTRATOR_SYSTEM_PROMPT;
      expect(p).toContain("申报完成前同刻做收口锚对账");
      expect(p).toContain("不混入机械处置");
    });
  });

  describe("SubAgent 专属：闭环纪律（R2 候选单点重申）", () => {
    test("sediment 经 findings 文件上报 + 禁止直接调候选 op", () => {
      expect(SUBAGENT_SYSTEM_PROMPT).toContain("闭环纪律");
      expect(SUBAGENT_SYSTEM_PROMPT).toContain("sediment");
      expect(SUBAGENT_SYSTEM_PROMPT).toContain("经 findings 文件上报");
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

  describe("收口记忆召回点（工程纪律②衔接——收口/交代前 memory_search 善后偏好检索）", () => {
    for (const [label, prompt] of [
      ["Main", MAIN_SESSION_SYSTEM_PROMPT],
      ["SubAgent", SUBAGENT_SYSTEM_PROMPT],
    ] as const) {
      test(`${label}：收口记忆召回点关键句齐备（收口/向用户交代前 / 「收尾/善后/清理」意图检索 / 命中按偏好善后 / 无命中正常收口）`, () => {
        expect(prompt).toContain("收口记忆召回点");
        expect(prompt).toContain("收口/向用户交代前");
        expect(prompt).toContain("「收尾/善后/清理」");
        expect(prompt).toContain("命中即按偏好完成善后再收口");
        expect(prompt).toContain("无命中即正常收口");
      });
    }

    test("同刻衔接：召回点紧随「收尾前先提交——未提交的工作等于没做」（不重写检查点既有句，仅衔接）", () => {
      for (const prompt of [MAIN_SESSION_SYSTEM_PROMPT, SUBAGENT_SYSTEM_PROMPT]) {
        expect(prompt).toContain("未提交的工作等于没做。收口记忆召回点");
      }
    });
  });

  describe("收口锚对账点（工程纪律②衔接——批4 WP-G 任务收口锚对账闭环）", () => {
    for (const [label, prompt] of [
      ["Main", MAIN_SESSION_SYSTEM_PROMPT],
      ["SubAgent", SUBAGENT_SYSTEM_PROMPT],
    ] as const) {
      test(`${label}：收口锚对账点关键句齐备（改动面锚对账链 / 机械项当场处置 / 残量进收口报告直接交代 / 不留台账等体检）`, () => {
        expect(prompt).toContain("收口锚对账点");
        expect(prompt).toContain("改动文件 → kg affected 反查 → 锚健康检查");
        expect(prompt).toContain("机械项当场处置");
        expect(prompt).toContain("残量（符号消亡后节点去留等需内容判断的）进收口报告直接交代用户，不留台账等体检");
      });

      test(`${label}：边界条款——「节点内容还对不对」走 findings→候选人审通道，内容人审边界与锚机械维护严格分开`, () => {
        expect(prompt).toContain("凡涉及「节点内容还对不对」的（supersede/正文修订）仍走 findings→候选人审通道");
        expect(prompt).toContain("内容人审边界与锚机械维护严格分开");
      });
    }

    test("同刻衔接：锚对账点紧随收口记忆召回点（「无命中即正常收口。收口锚对账点」）", () => {
      for (const prompt of [MAIN_SESSION_SYSTEM_PROMPT, SUBAGENT_SYSTEM_PROMPT]) {
        expect(prompt).toContain("无命中即正常收口。收口锚对账点");
      }
    });

    test("SubAgent 收口 SOP 同步句齐备（subagent-worker.md 报告落盘前锚对账 + 残量直接交代）", () => {
      expect(SUBAGENT_SYSTEM_PROMPT).toContain("报告落盘前对本任务改动面做锚对账");
      expect(SUBAGENT_SYSTEM_PROMPT).toContain("残量（符号消亡后节点去留等需内容判断的）在报告中直接交代用户");
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

    test("PLAN_HARD_CONSTRAINT_SEGMENT 原文（五条 + 模板层强制标题；todo 改名批措辞同步；第 5 条 = 按清单条目逐步 commit，2026-08-30 用户裁决补入）", () => {
      expect(PLAN_HARD_CONSTRAINT_SEGMENT).toContain("## todo 硬约束（任务系统追加，模板层强制——不可裁）");
      expect(PLAN_HARD_CONSTRAINT_SEGMENT).toContain("1. 开工先用 todo_write 建待办清单（一次给出全部计划条目）再动手执行；");
      expect(PLAN_HARD_CONSTRAINT_SEGMENT).toContain("2. 阶段转换必须同步更新清单项状态（in_progress/done/abandoned）；");
      expect(PLAN_HARD_CONSTRAINT_SEGMENT).toContain("3. 收口时清单须全部 resolve——每项 done，或 abandoned 且带非空理由 note；");
      expect(PLAN_HARD_CONSTRAINT_SEGMENT).toContain("4. 清单 note 记录关键事实与产物指针（文件路径/知识节点 id），供接力恢复与幂等重跑使用。");
      expect(PLAN_HARD_CONSTRAINT_SEGMENT).toContain("5. 按清单条目逐步提交（commit）——每条目完成且验证绿即提交一次；收尾前先提交，未提交的工作等于没做。");
    });
  });
});
