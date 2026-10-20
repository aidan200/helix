/**
 * 架构守护——分层落位与判据单点面（AG-15 + TR-AD-28 @helix/common 通用层零
 * 依赖 / O-1 + O-4 任务四表分域与子进程写面 / O-4 任务域目录落位 / AG-13 通用
 * 记忆配置域不自反依赖管家域 / E-306 默认端点解析单点）。纯位置迁移自
 * arch-guard.test.ts（P1 体量门拆分批，判定逻辑零改动）。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { srcRoot, listFiles, read, importSpecifiers, typeOnly } from "./guard-helpers";

describe("AG-15 / TR-AD-28：@helix/common 业务无关通用层零依赖结构（AD-1，iter-20260821-dg90 T3.3）", () => {
  const repoRoot = path.join(srcRoot, "..", "..", "..");
  const commonRoot = path.join(repoRoot, "packages", "common");

  test("① common/src 全部 .ts import ∈ {相对路径} ∪ {node:*/bun:* 内置}（@helix/* 或裸包名即红）", () => {
    const files = listFiles(path.join(commonRoot, "src"));
    expect(files.length).toBeGreaterThan(0); // 扫描面非空转（constants + index 门面在位）
    for (const rel of files) {
      const src = readFileSync(path.join(commonRoot, "src", rel), "utf8");
      for (const spec of importSpecifiers(src)) {
        expect(
          spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("bun:"),
          `packages/common/src/${rel} 越出零依赖白名单（相对路径/node:*/bun:*）：${spec}`,
        ).toBe(true);
      }
    }
  });

  test("② common/package.json dependencies 恰为空对象（零外部依赖 + 零 @helix/*）", () => {
    const pkg = JSON.parse(readFileSync(path.join(commonRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({});
  });

  test("③ common 依赖边登记（与 AG-05① 四键联动）：daemon workspace:* + protocol 依赖恰一键 @helix/common（空置预留位）", () => {
    // protocol 首条 dependencies（AD-1 预期内）：仅 @helix/common 一键——
    // @helix/common 现为空置预留（尚无源码消费面），此键即预留依赖位，
    // 多一键即越零依赖纪律面。
    const daemonDeps = (
      JSON.parse(readFileSync(path.join(srcRoot, "..", "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      }
    ).dependencies;
    expect(daemonDeps["@helix/common"]).toBe("workspace:*");
    const protocolPkg = JSON.parse(
      readFileSync(path.join(repoRoot, "packages", "protocol", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(protocolPkg.dependencies).toEqual({ "@helix/common": "workspace:*" });
  });
});

describe("O-1/O-4（T2.1）：任务四表表分域与子进程写面（job/stage/batch/work_item 只落 helix.db）", () => {
  const writeQueueRel = path.join("adapters", "driven", "sqlite-session", "WriteQueue.ts");
  const sessionSchemaRel = path.join("adapters", "driven", "sqlite-session", "schema.ts");
  // 任务四表 DML/DDL 形态（SQL 邻接匹配——变量名 batch/注释散文不误伤）。
  // 注意 origin_batch_id/task_id 等下划线复合词不含词边界内的四表名，不命中。
  const taskTableDml = /(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+(job|stage|batch|work_item)\b/i;
  const taskTableDdl = /CREATE\s+TABLE[^;]*\b(job|stage|batch|work_item)\b/i;
  // 父进程任务写方法名（WriteQueue 公共面——子进程禁止调用）。
  const parentTaskWriteMethods =
    /\b(saveTaskJob|saveTaskStage|saveTaskJobStatus|saveTaskStageStatus|saveTaskBatch|updateTaskBatch|deleteTaskJobCascade)\b/;

  test("① .helix-kg 库面（sqlite-kg/**）零任务四表 SQL——任务表 DDL/写路径不出现在 kg 库代码面（O-1 改判断言）", () => {
    const kgDir = path.join("adapters", "driven", "sqlite-kg");
    const files = listFiles(path.join(srcRoot, kgDir));
    expect(files.length).toBeGreaterThan(0); // 扫描面非空转
    for (const rel of files) {
      const src = read(path.join(kgDir, rel));
      expect(src.match(taskTableDml), `${rel} 出现任务四表 DML（任务表不落 .helix-kg 库）`).toBeNull();
      expect(src.match(taskTableDdl), `${rel} 出现任务四表 DDL（任务表不落 .helix-kg 库）`).toBeNull();
    }
  });

  test("② 全 src 任务四表 DML 只在 WriteQueue.ts、DDL 只在 sqlite-session/schema.ts（写语句宿主唯一，O-1）", () => {
    for (const rel of listFiles(srcRoot)) {
      const src = read(rel);
      if (taskTableDml.test(src)) {
        expect(rel === writeQueueRel, `${rel} 出现任务四表 DML（只允许 WriteQueue——父进程单写通道）`).toBe(true);
      }
      if (taskTableDdl.test(src)) {
        expect(rel === sessionSchemaRel, `${rel} 出现任务四表 DDL（只允许 sqlite-session/schema.ts）`).toBe(true);
      }
    }
    // 宿主真实持有（扫描面与实现同步——防扫描空转）
    expect(taskTableDml.test(read(writeQueueRel))).toBe(true);
    expect(taskTableDdl.test(read(sessionSchemaRel))).toBe(true);
  });

  test("③ 子进程写面仅 work_item：subagent/** 零 job/stage/batch 写方法调用与写 SQL（父写三表、子不写，O-1 双面装配）", () => {
    const subagentRoot = path.join("adapters", "driven", "subagent");
    const threeTableDml = /(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+(job|stage|batch)\b/i;
    for (const rel of listFiles(path.join(srcRoot, subagentRoot))) {
      const src = read(path.join(subagentRoot, rel));
      expect(src.match(parentTaskWriteMethods), `${rel} 调用父进程任务写方法（子进程不写 job/stage/batch）`).toBeNull();
      expect(src.match(threeTableDml), `${rel} 出现 job/stage/batch 写 SQL（子进程写面仅 work_item）`).toBeNull();
    }
  });
});

describe("O-4（T2.1）：任务域新分层目录落位（domain/task、services/task、tools/todo、tools/task-create）", () => {
  test("① domain/task 在位且零外层 import（domain 纯逻辑纪律定点声明，AG-02① 同口径）", () => {
    const dir = path.join(srcRoot, "domain", "task");
    const files = listFiles(dir);
    expect(files.length).toBeGreaterThan(0); // T1.1 已落位
    for (const rel of files) {
      for (const spec of importSpecifiers(read(path.join("domain", "task", rel)))) {
        expect(spec.startsWith("."), `domain/task/${rel} 不得 import 外层符号：${spec}`).toBe(true);
      }
    }
  });

  test("② services/task 在位且不 import adapters/infrastructure（service 纪律定点声明，AG-02② 同口径）", () => {
    const dir = path.join(srcRoot, "application", "services", "task");
    const files = listFiles(dir);
    expect(files.length).toBeGreaterThan(0); // T1.3 已落位
    for (const rel of files) {
      for (const spec of importSpecifiers(read(path.join("application", "services", "task", rel)))) {
        expect(spec, `services/task/${rel} 不得依赖 adapters/infrastructure：${spec}`).not.toMatch(/adapters|infrastructure/);
      }
    }
  });

  test("③ tools/todo、tools/task-create 与 tools/task-ops（todo 改名批/T2.4/T2.2 落位即受守护）不 import infrastructure/driving", () => {
    // T1.4/T2.4 并行落地期：目录未建时本断言空转跳过，落位后自动生效（防未来
    // 回归；driven 工具面允许 domain/application ports/service type-only 面）。
    for (const dir of [
      path.join("adapters", "driven", "tools", "todo"),
      path.join("adapters", "driven", "tools", "task-create"),
      path.join("adapters", "driven", "tools", "task-ops"),
    ]) {
      if (!existsSync(path.join(srcRoot, dir))) continue;
      for (const rel of listFiles(path.join(srcRoot, dir))) {
        const relPath = path.join(dir, rel);
        for (const spec of importSpecifiers(read(relPath))) {
          expect(spec, `${relPath} 不得依赖 infrastructure/driving：${spec}`).not.toMatch(/infrastructure|\/driving\//);
        }
      }
    }
  });
});

describe("AG-13：通用记忆配置域不自反依赖管家域（环依赖守护）", () => {
  // memoryConfig 模块裁决「记忆配置不能挂在管家名下」——若反向 import
  // application/steward/**（如引用 StewardMemoryService 常量），则与
  // StewardMemoryService → memoryConfig 的正向引用构成环，且常量落位与
  // 域边界自相矛盾（评审 F1：memoryConfig ↔ StewardMemoryService 环形
  // 依赖实证）。缺省阈值常量归属 memoryConfig，管家侧反向取用。
  test("application/memory/** 不 import application/steward/**", () => {
    const files = listFiles(path.join(srcRoot, "application", "memory"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const rel of files) {
      const relPath = path.join("application", "memory", rel);
      for (const spec of importSpecifiers(read(relPath))) {
        expect(
          spec,
          `${relPath} 不得依赖管家域（steward）——记忆配置域自洽：${spec}`,
        ).not.toMatch(/steward/);
      }
    }
  });
});

describe("E-306：默认端点解析单点（评审 F1——子进程/脚本不得本地复刻判据）", () => {
  // 评审 F1 实证：默认端点语义（读默认引用 → 找记录 → 悬空/非本 kind → null）
  // 曾在 ChildMain 两处 + backfill 脚本一处被本地复刻，靠注释「与父进程同判」
  // 维系，语义演进三处易漂移。现全部收编为 EmbeddingConfigService 导出的纯
  // 函数（resolveDefaultRecordOf / resolveDefaultConfigOf）；本守护钉住不许
  // 回退：该判据的中心表达式只允许出现在单点定义文件里。
  const SINGLE_POINT = path.join("application", "embedding", "EmbeddingConfigService.ts");
  const CENTER_EXPRESSION = /\(record\.kind \?\? "embedding"\) !== /;
  const scriptRoot = path.join(srcRoot, "..", "scripts");

  test("src 内除单点定义文件外无 kind-归一默认端点判据复刻", () => {
    const hits: string[] = [];
    for (const rel of listFiles(srcRoot)) {
      if (rel === SINGLE_POINT) continue;
      if (CENTER_EXPRESSION.test(read(rel))) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });

  test("daemon 独立脚本同守（backfill 类脚本经纯函数复用）", () => {
    const hits: string[] = [];
    for (const entry of readdirSync(scriptRoot) as string[]) {
      if (!entry.endsWith(".ts")) continue;
      const src = readFileSync(path.join(scriptRoot, entry), "utf8");
      if (CENTER_EXPRESSION.test(src)) hits.push(entry);
    }
    expect(hits).toEqual([]);
  });
});
