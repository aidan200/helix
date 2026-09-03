import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SkillScanner } from "../../src/adapters/driven/pi-engine/SkillScanner";
import { TaskSkillRegistry } from "../../src/adapters/driven/task-skill-registry/TaskSkillRegistry";
import { ResourceService } from "../../src/application/services/ResourceService";
import type {
  ProfileKind,
  ResourceStateData,
  ResourceStatePort,
  ResourceType,
} from "../../src/application/ports/outbound/ResourceStatePort";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { buildTaskStack } from "../../src/infrastructure/assembly/buildTaskStack";
import { builtinSkillsDir } from "../../src/infrastructure/paths";
import type { Logger } from "../../src/infrastructure/logging";

/**
 * kg-bootstrap skill 交付 + TaskSkillRegistry 真体（T2.3；testing/test-design.md 映射）：
 * - CL-2-T10：SKILL.md 落 builtin 层随仓目录；manifest（paramsSchema + stages
 *   fixed 三阶段 + confirm + plan + projects）与正文 SOP 五节（产出目标/批次
 *   划分/brief 模板/写作规范五条/完成判定）+ 分层拓扑节；builtin 不可删改
 *   （ResourceService.setEnabled → builtin-immutable 回归）；Registry 扫描装载；
 * - CL-2-T9：坏 manifest（缺 paramsSchema）→ 不入注册表仅 warning 不炸；
 *   无 task 块普通技能（web-access）向后兼容不受影响；
 * - T1.3 接缝：buildTaskStack 真体注入（skillSource）后 createTask 全流程。
 *
 * 隔离（TR-TEST-4）：user/project 层传不存在 tmp 子路径（SkillScanner 静默跳过），
 * builtin 层用随仓真目录或 tmp fixture；零 ~/.helix 触碰。
 */

const tmpRoots: string[] = [];
const warnings: string[] = [];
const noopLogger: Logger = {
  info: () => {},
  warn: (m) => warnings.push(m),
  error: () => {},
};

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** 真实 builtin 层扫描器（user/project = 不存在子路径，隔离）。 */
function builtinScanner(builtin = builtinSkillsDir()): SkillScanner {
  return new SkillScanner({
    userSkillsDir: path.join(tmpDir("helix-t23-user-"), "skills"),
    projectSkillsDir: path.join(tmpDir("helix-t23-project-"), ".helix", "skills"),
    builtinSkillsDir: builtin,
  });
}

/** 装 + 载（装载面真实现：SkillScanner 扫 builtin → frontmatter task 块解析入表）。 */
async function loadRegistry(builtin = builtinSkillsDir()): Promise<TaskSkillRegistry> {
  const registry = new TaskSkillRegistry({ skills: builtinScanner(builtin), warn: (m) => warnings.push(m) });
  await registry.load();
  return registry;
}

/** 造一个技能 fixture：<builtin>/<name>/SKILL.md。 */
function makeSkill(builtin: string, name: string, frontmatter: string, body = "技能正文"): void {
  const dir = path.join(builtin, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

describe("kg-bootstrap skill 装载（CL-2-T10）", () => {
  test("① SKILL.md 落位 builtin 层随仓目录 + SkillScanner 扫到（source=builtin）", async () => {
    const file = path.join(builtinSkillsDir(), "kg-bootstrap", "SKILL.md");
    const text = await readFile(file, "utf8");
    expect(text.startsWith("---\n")).toBe(true); // frontmatter 在文件头

    const scanned = await builtinScanner().scan();
    const hit = scanned.skills.find((s) => s.name === "kg-bootstrap");
    expect(hit).toBeDefined();
    expect(hit!.source).toBe("builtin");
    expect(hit!.filePath).toBe(file);
    expect(hit!.description.length).toBeGreaterThan(0);
  });

  test("② TaskSkillRegistry 装载 manifest 全字段（§7.1）", async () => {
    const registry = await loadRegistry();
    expect(registry.getTaskType("kg-bootstrap")).toEqual({
      paramsSchema: {
        projectRoot: { type: "string", required: true },
        scope: { type: "string", required: false },
      },
      stages: { strategy: "fixed", list: ["L0 核心层", "L1 领域层", "L2 实体层"] },
      confirm: "required",
      plan: "enforced",
      projects: { min: 1, max: 1 },
    });
  });

  test("③ listTaskTypes 含 kg-bootstrap 目录行（/project 入口说明数据源）", async () => {
    const registry = await loadRegistry();
    const row = registry.listTaskTypes().find((t) => t.type === "kg-bootstrap");
    expect(row).toBeDefined();
    expect(row!.description).toContain("知识图谱");
    expect(registry.listTaskTypes().find((t) => t.type === "web-access")).toBeUndefined(); // 无 task 块不入目录
  });
});

describe("SOP 五节锚 + 写作规范六条（CL-2-T10；R23 升六条后锚同步）", () => {
  let body: string;

  test("④ 五节主题锚齐（产出目标与验收/批次划分/brief 模板/写作规范/完成判定）", async () => {
    body = (await readFile(path.join(builtinSkillsDir(), "kg-bootstrap", "SKILL.md"), "utf8")).replace(/^---\n[\s\S]*?\n---\n/, "");
    expect(body).toContain("各层产出目标与验收");
    expect(body).toContain("批次划分原则");
    expect(body).toContain("brief 装配模板");
    expect(body).toContain("写作规范六条");
    expect(body).toContain("完成判定");
  });

  test("⑤ 写作规范六条逐条独立编号可 grep（AD-4①）", () => {
    for (const n of ["规范 1", "规范 2", "规范 3", "规范 4", "规范 5", "规范 6"]) {
      expect(body.includes(n), `正文缺少可 grep 编号「${n}」`).toBe(true);
    }
    // 六条关键内容锚（TR-AD-65① + R23 scene 必填）
    expect(body).toContain("自然语言");
    expect(body).toContain("digest");
    expect(body).toContain("为什么存在");
    expect(body).toContain("符号域锚");
    expect(body).toContain("只看正文");
    expect(body).toContain("scene 必填");
  });

  test("⑥ 分层拓扑节：L0→L1→L2 + 层间传递探索上下文 + supersede 重跑幂等（origin_batchId）", () => {
    expect(body).toContain("分层拓扑");
    for (const layer of ["L0 核心层", "L1 领域层", "L2 实体层"]) {
      expect(body).toContain(layer);
    }
    expect(body).toContain("探索上下文");
    expect(body).toContain("supersede");
    expect(body).toContain("origin_batchId");
  });
});

describe("坏 manifest 防线（CL-2-T9）", () => {
  test("⑦ 坏 fixture（缺 paramsSchema）→ 不入注册表 + warning 不炸装载", async () => {
    const builtin = tmpDir("helix-t23-bad-");
    makeSkill(
      builtin,
      "bad-task",
      [
        "name: bad-task",
        "description: 坏 manifest 演示（缺 paramsSchema）",
        "task:",
        "  stages:",
        "    strategy: fixed",
        "    list: [探索]",
        "  confirm: required",
        "  plan: enforced",
        "  projects: { min: 1, max: 1 }",
      ].join("\n"),
    );

    const registry = await loadRegistry(builtin); // 不抛 = 装载不炸
    expect(registry.getTaskType("bad-task")).toBeNull();
    expect(registry.listTaskTypes()).toEqual([]);
    expect(warnings.some((w) => w.includes("bad-task") && w.includes("manifest"))).toBe(true);
  });

  test("⑧ 坏 + 好 fixture 混扫 → 好者入表、坏者仅 warning", async () => {
    const builtin = tmpDir("helix-t23-mixed-");
    makeSkill(
      builtin,
      "good-task",
      [
        "name: good-task",
        "description: 合法 fixture",
        "task:",
        "  paramsSchema: { root: { type: string, required: true } }",
        "  stages:",
        "    strategy: fixed",
        "    list: [扫描]",
        "  confirm: skip",
        "  plan: optional",
        "  projects: { min: 0, max: 5 }",
      ].join("\n"),
    );
    makeSkill(
      builtin,
      "bad-task",
      ["name: bad-task", "description: 坏 manifest 演示", "task:", "  confirm: required"].join("\n"),
    );

    const registry = await loadRegistry(builtin);
    expect(registry.getTaskType("bad-task")).toBeNull();
    expect(registry.getTaskType("good-task")?.stages).toEqual({ strategy: "fixed", list: ["扫描"] });
  });
});

describe("向后兼容：无 task 块普通技能不受影响（CL-2-T9）", () => {
  test("⑨ web-access → getTaskType null 且随仓 builtin 层扫描零 warning", async () => {
    const registry = await loadRegistry();
    expect(registry.getTaskType("web-access")).toBeNull();
    const scanned = await builtinScanner().scan();
    expect(scanned.diagnostics).toEqual([]); // 随仓 builtin 层（web-access + kg-bootstrap + kg-review + code-review）零坏文件诊断
    expect(scanned.skills.map((s) => s.name).sort()).toEqual(["code-review", "kg-bootstrap", "kg-review", "web-access"]);
  });
});

describe("kg-review skill 装载（W2-F 轨二语义体检任务，R21/R23）", () => {
  test("① SKILL.md 落位 builtin 层随仓目录 + SkillScanner 扫到（source=builtin）", async () => {
    const file = path.join(builtinSkillsDir(), "kg-review", "SKILL.md");
    const text = await readFile(file, "utf8");
    expect(text.startsWith("---\n")).toBe(true);

    const scanned = await builtinScanner().scan();
    const hit = scanned.skills.find((s) => s.name === "kg-review");
    expect(hit).toBeDefined();
    expect(hit!.source).toBe("builtin");
    expect(hit!.filePath).toBe(file);
    expect(hit!.description.length).toBeGreaterThan(0);
  });

  test("② TaskSkillRegistry 装载 manifest 全字段（paramsSchema + fixed 三阶段 + confirm/plan/projects）", async () => {
    const registry = await loadRegistry();
    expect(registry.getTaskType("kg-review")).toEqual({
      paramsSchema: {
        projectRoot: { type: "string", required: true },
      },
      stages: { strategy: "fixed", list: ["L0 结构面预检", "L1 规则册逐节点评审", "L2 实体册逐节点评审"] },
      confirm: "required",
      plan: "enforced",
      projects: { min: 1, max: 1 },
    });
    expect(registry.listTaskTypes().find((t) => t.type === "kg-review")).toBeDefined();
  });

  test("③ SOP 正文锚：评审口径三问 + 数据源三面（kg/codegraph/锚反查）", async () => {
    const body = (await readFile(path.join(builtinSkillsDir(), "kg-review", "SKILL.md"), "utf8")).replace(
      /^---\n[\s\S]*?\n---\n/,
      "",
    );
    // 评审口径三问（代码现实 / scene / 矛盾）
    expect(body).toContain("代码现实");
    expect(body).toContain("scene");
    expect(body).toContain("矛盾");
    // 数据源三面：kg 全量 + codegraph 工具 + 锚反查（W1-C）
    expect(body).toContain("kg search");
    expect(body).toContain("codegraph");
    expect(body).toContain("锚反查");
  });

  test("④ 产出纪律硬锚：内容问题只提 candidate / scene 缺失可 updateNode / 禁直改禁 supersede / 不带 layer", async () => {
    const body = (await readFile(path.join(builtinSkillsDir(), "kg-review", "SKILL.md"), "utf8")).replace(
      /^---\n[\s\S]*?\n---\n/,
      "",
    );
    expect(body).toContain("candidate");
    expect(body).toContain("updateNode");
    expect(body).toContain("supersede");
    expect(body).toContain("不带 layer");
    expect(body).toContain("origin_batchId");
  });

  test("⑤ 完成判定锚：全节点过一遍 + candidates 落账条数 + 遗留清单显式写「无」", async () => {
    const body = (await readFile(path.join(builtinSkillsDir(), "kg-review", "SKILL.md"), "utf8")).replace(
      /^---\n[\s\S]*?\n---\n/,
      "",
    );
    expect(body).toContain("完成判定");
    expect(body).toContain("全节点");
    expect(body).toContain("落账条数");
    expect(body).toContain("遗留清单");
  });
});

describe("code-review skill 装载（代码质量评审任务，D1）", () => {
  test("① SKILL.md 落位 builtin 层随仓目录 + SkillScanner 扫到（source=builtin）", async () => {
    const file = path.join(builtinSkillsDir(), "code-review", "SKILL.md");
    const text = await readFile(file, "utf8");
    expect(text.startsWith("---\n")).toBe(true);

    const scanned = await builtinScanner().scan();
    const hit = scanned.skills.find((s) => s.name === "code-review");
    expect(hit).toBeDefined();
    expect(hit!.source).toBe("builtin");
    expect(hit!.filePath).toBe(file);
    expect(hit!.description.length).toBeGreaterThan(0);
  });

  test("② TaskSkillRegistry 装载 manifest 全字段（paramsSchema 含可选 scope + fixed 三阶段 + confirm/plan/projects）", async () => {
    const registry = await loadRegistry();
    expect(registry.getTaskType("code-review")).toEqual({
      paramsSchema: {
        projectRoot: { type: "string", required: true },
        scope: { type: "string" },
      },
      stages: { strategy: "fixed", list: ["评审范围盘点与分批", "分批评审", "汇总报告"] },
      confirm: "required",
      plan: "enforced",
      projects: { min: 1, max: 1 },
    });
    expect(registry.listTaskTypes().find((t) => t.type === "code-review")).toBeDefined();
  });

  test("③ SOP 正文锚：评审口径四问 + 证据纪律（四要素 + 严重度四级）", async () => {
    const body = (await readFile(path.join(builtinSkillsDir(), "code-review", "SKILL.md"), "utf8")).replace(
      /^---\n[\s\S]*?\n---\n/,
      "",
    );
    // 评审口径四问
    expect(body).toContain("设计合理性");
    expect(body).toContain("逻辑问题");
    expect(body).toContain("可简化");
    expect(body).toContain("卫生性");
    // 证据纪律：file:line + 符号名 + 严重度 + 建议；严重度四级
    expect(body).toContain("file:line");
    expect(body).toContain("阻断");
    expect(body).toContain("无证据");
  });

  test("④ 产出纪律硬锚：issue 进报告与 findings / sediment 唯一例外 / 禁改代码与 kg / 汇总报告固定落点", async () => {
    const body = (await readFile(path.join(builtinSkillsDir(), "code-review", "SKILL.md"), "utf8")).replace(
      /^---\n[\s\S]*?\n---\n/,
      "",
    );
    expect(body).toContain('"issue"');
    expect(body).toContain("sediment");
    expect(body).toContain("禁止修改项目代码");
    expect(body).toContain("summary.md");
    expect(body).toContain("HELIX_REPORT_PATH");
    expect(body).toContain("origin_batchId");
  });

  test("⑤ 完成判定锚：模块零遗漏 + 发现条数如实 + 遗留清单显式写「无」", async () => {
    const body = (await readFile(path.join(builtinSkillsDir(), "code-review", "SKILL.md"), "utf8")).replace(
      /^---\n[\s\S]*?\n---\n/,
      "",
    );
    expect(body).toContain("完成判定");
    expect(body).toContain("模块零遗漏");
    expect(body).toContain("如实");
    expect(body).toContain("遗留清单");
  });
});

describe("builtin 防护回归（CL-2-T10）", () => {
  test("⑩ setEnabled(kg-bootstrap) → skipped(builtin-immutable) 零落库", async () => {
    const service = new ResourceService({
      store: new InMemoryResourceState(),
      skills: builtinScanner(),
      toolsCatalog: { "main-session": ["bash"], "subagent-worker": ["bash"], "subagent-kg-writer": ["kg-update"],
    "subagent-code-reviewer": ["bash"], "orchestrator": ["bash"] } as Record<ProfileKind, readonly string[]>,
      toolSnippets: {},
    });
    const outcome = await service.setEnabled("main-session", "skill", "kg-bootstrap", false);
    expect(outcome).toEqual({ status: "skipped", reason: "builtin-immutable" });
    expect((await service.list("main-session")).skills.find((s) => s.name === "kg-bootstrap")?.enabled).toBe(true);
  });
});

describe("buildTaskStack 真体接线（T1.3 接缝收口）", () => {
  test("⑪ skillSource 注入 → createTask(kg-bootstrap) 引擎校验全流程（一文两消费）", async () => {
    const dir = tmpDir("helix-t23-stack-");
    const queue = new WriteQueue(path.join(dir, "helix.db"));
    try {
      const stack = await buildTaskStack({
        writeQueue: queue,
        clock: { now: () => "2026-08-29T12:00:00.000Z", nowMs: () => Date.parse("2026-08-29T12:00:00.000Z") },
        logger: noopLogger,
        skillSource: builtinScanner(),
      });
      const { jobId } = await stack.taskEngine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      const detail = stack.query.getTaskDetail(jobId);
      expect(detail.type).toBe("kg-bootstrap");
      expect(detail.stages.map((s) => s.name)).toEqual(["L0 核心层", "L1 领域层", "L2 实体层"]);
    } finally {
      await queue.close();
    }
  });

  test("⑫ 缺省（无 skillSource）→ 空注册表占位语义保持（type_unknown）", async () => {
    const dir = tmpDir("helix-t23-empty-");
    const queue = new WriteQueue(path.join(dir, "helix.db"));
    try {
      const stack = await buildTaskStack({
        writeQueue: queue,
        clock: { now: () => "2026-08-29T12:00:00.000Z", nowMs: () => Date.parse("2026-08-29T12:00:00.000Z") },
        logger: noopLogger,
      });
      expect(stack.query.listTasks({})).toEqual([]);
      await expect(
        stack.taskEngine.createTask({
          type: "kg-bootstrap",
          projects: ["demo"],
          params: { projectRoot: "/tmp/demo" },
          createdBy: "page",
        }),
      ).rejects.toMatchObject({ code: "task.type_unknown" });
    } finally {
      await queue.close();
    }
  });
});

/** 内存假实现：镜像 ResourceStatePort 语义（resource-service.test.ts 同构）。 */
class InMemoryResourceState implements ResourceStatePort {
  readonly rows = new Map<string, ResourceStateData>();

  private key(kind: ProfileKind, type: ResourceType, name: string): string {
    return `${kind}|${type}|${name}`;
  }

  async upsert(kind: ProfileKind, resourceType: ResourceType, name: string, enabled: boolean): Promise<void> {
    this.rows.set(this.key(kind, resourceType, name), {
      profileKind: kind,
      resourceType,
      name,
      enabled,
      updatedAt: new Date().toISOString(),
    });
  }

  get(kind: ProfileKind, resourceType: ResourceType, name: string): ResourceStateData | undefined {
    return this.rows.get(this.key(kind, resourceType, name));
  }

  list(kind: ProfileKind, resourceType?: ResourceType): readonly ResourceStateData[] {
    return [...this.rows.values()].filter(
      (r) => r.profileKind === kind && (resourceType === undefined || r.resourceType === resourceType),
    );
  }

  async setModelSlot(): Promise<void> {}
  async clearModelSlot(): Promise<void> {}
  modelSlot(): string | undefined {
    return undefined;
  }
  async setThinkingSlot(): Promise<void> {}
  async clearThinkingSlot(): Promise<void> {}
  thinkingSlot(): string | undefined {
    return undefined;
  }
}
