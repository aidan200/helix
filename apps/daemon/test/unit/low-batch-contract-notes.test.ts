/**
 * 低危修复批次（daemon 核心层）注释口径定式断言（TR-285）。
 *
 * 本批主体是「注释承诺 ≠ 实现」型缺陷（无行为面可测）：修复后在此钉住
 * 新口径在场 + 旧措辞禁回潮，防历次评审反复产出同型条目。
 * 仓库先例：adapter-contract-notes.test.ts / doc_contract.rs。
 *
 * 纪律（TR-285）：负向断言（旧措辞不在场）的待禁字符串必须**分片拼接**——
 * 直接在同文件里写整串会让「不在场」恒真（本文件与被测源码非同文件，但
 * 分片写法照守，防后续把断言挪进同文件时静默失效）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../../src");

function src(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/** 分片拼接待禁/待查串（TR-285：防同文件自指恒真）。 */
const join_ = (...parts: string[]): string => parts.join("");

describe("注释口径定式断言：steward 域", () => {
  test("#1 快照标题不再另写推导链与分叉兜底文案", () => {
    const s = src("application/steward/StewardService.ts");
    expect(s).toContain("displayTitle 单源（TR-207）：推导链只在 displayTitleOf");
    expect(s).toContain("title: displayTitleOf(r),");
    expect(s).not.toContain(join_("（无主题", "会话）"));
  });

  test("#4 软上限 GC 口径按两条收敛轨陈述（工具写路径不即时触发）", () => {
    const s = src("application/steward/StewardMemoryService.ts");
    expect(s).toContain("工具写路径（remember 直入）不走即时");
    expect(s).not.toContain(join_("软上限 append", " 后主动触发"));
  });

  test("#8 工具面计数改引用式（禁写死计数快照，TR-206）", () => {
    const s = src("application/steward/tools/StewardToolKit.ts");
    expect(s).toContain("工具清单与计数一律以 registerTools 注册点为准");
    expect(s).not.toContain(join_("八", "工具注册 ToolRegistry"));
    expect(s).not.toContain(join_("registerTools 16 ", "工具"));
  });
});

describe("注释口径定式断言：kg / domain 域", () => {
  test("#16 KnowledgeWriteOpKind 不再自称 KnowledgeWriteOp 判别值同义", () => {
    const s = src("domain/kg/types.ts");
    expect(s).toContain("不是 KnowledgeWriteOp 判别值的同义词");
    expect(s).not.toContain(join_("KnowledgeWriteOp 判别值；", "change_log.op 取值同源"));
  });

  test("#21 AgentSpawnedPayload.model 注释补全解析归属", () => {
    const s = src("domain/events/DomainEvent.ts");
    expect(s).toContain("模型解析归属 = spawn 请求侧");
    expect(s).not.toContain(join_("（解析", "归，此处可选）"));
  });

  test("#23 buildChangeReport 检查类条目不再归因本迭代", () => {
    const s = src("application/services/kg/KgReportService.ts");
    expect(s).toContain("机械检查发现（全量现状扫描）");
    expect(s).not.toContain(join_("本迭代机械", "检查发现"));
  });

  test("#32 paths.modelsDir 注释与 ensureHome 实现一致", () => {
    const s = src("infrastructure/paths.ts");
    expect(s).toContain("ensureHome 不补建本目录");
    expect(s).not.toContain(join_("ensureHome ", "时一并补建"));
  });

  test("#33 buildKnowledgeStack env 收束点指向 bootPrelude", () => {
    const s = src("infrastructure/assembly/buildKnowledgeStack.ts");
    expect(s).toContain("bootPrelude.freezeSearchBackends");
    expect(s).not.toContain(join_("收束于 ", "container.ts"));
  });

  test("#50/#51 TaskEngineService 编排回口注释与门语义/依赖面一致", () => {
    const s = src("application/services/task/TaskEngineService.ts");
    expect(s).toContain("推进动作即接管激活");
    expect(s).not.toContain(join_("推进动作前查 ", "job.status==running"));
    expect(s).not.toContain(join_("getItems 读 + ", "deleteByInstanceIds 清理"));
  });

  test("#55 profileKind 映射注释改单源口径（无「临时显式传参」双轨暗示）", () => {
    const s = src("application/services/task/TaskOrchestratorService.ts");
    expect(s).toContain("映射已收口进本表");
    expect(s).not.toContain(join_("临时显式传参", "兜底"));
  });

  test("#70 终态词表不再列不存在的 killed 态", () => {
    const s = src("domain/agent/SchedulingPolicy.ts");
    expect(s).toContain("无 killed 态");
    expect(s).not.toContain(join_("cancelled/", "killed 收口"));
  });
});

describe("注释口径定式断言：ports / 服务面", () => {
  test("#42 SessionChatPort 可赋值机制 = TS 方法双变（非参数逆变兼容）", () => {
    const s = src("application/ports/inbound/ChatPort.ts");
    expect(s).toContain("TS 方法双变");
    expect(s).not.toContain(join_("参数逆变", "兼容"));
  });

  test("#43 EmbeddingConfigService verifiedAt 清理口径与实现一致", () => {
    const s = src("application/embedding/EmbeddingConfigService.ts");
    expect(s).toContain("只在 baseUrl/model 变更时清");
    expect(s).not.toContain(join_("编辑", "即清"));
    expect(s).not.toContain("查我丽");
  });

  test("#44 StreamDelta.diff 不再以「ports 零包外 import」归因（AG-02 白名单实态）", () => {
    const s = src("application/ports/outbound/EventPublisherPort.ts");
    expect(s).toContain("端口自持结构形状");
    expect(s).not.toContain(join_("AG-02：ports ", "零包外 import"));
  });

  test("#13/#14 bashExtract 写头集合与写作数命名口径", () => {
    const s = src("domain/writefact/bashExtract.ts");
    expect(s).not.toContain(join_("单参写命令（参数即目标", "：tee/rmdir/touch/truncate"));
    expect(s).toContain("集合里只允许放「无专门分支」的成员");
  });

  test("#18 anchor-relocate 死构造已删（rewriteKeys 不再在场）", () => {
    const s = src("domain/kg/anchor-relocate.ts");
    expect(s).not.toContain(join_("rewriteKeys", " = new Set("));
  });

  test("#3 StewardService 尾部 A2 死注释段头已摘", () => {
    const s = src("application/steward/StewardService.ts");
    expect(s).not.toContain(join_("── A2：", "query_recent_work"));
  });
});
