import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { DomainError } from "../../../domain/DomainError";
import { parseTaskManifest } from "../../../domain/task/manifest";
import type { TaskManifest } from "../../../domain/task/types";
import type { SkillSourcePort } from "../../../application/ports/outbound/SkillSourcePort";
import type {
  TaskSkillRegistryPort,
  TaskTypeInfo,
} from "../../../application/ports/outbound/TaskSkillRegistryPort";

/**
 * TaskSkillRegistry —— 任务类型 manifest 注册表真体（architecture §4.3/§7.1，
 * AD-9②）：实现 outbound TaskSkillRegistryPort，消费 SkillScanner 扫描产物
 * 的 builtin task/ 层（audience="task"；F-8：任务类型 skill 随仓分发、产品
 * 不可删改——user/project 层与 builtin agent/ 层技能即使带 task 块也不
 * 入表，任务类型是产品功能不是用户扩展点；分类即目录，agent/ 放任务
 * skill = 放错目录不入表）。
 *
 * 装载口径：scan() → builtin 技能 → 读 SKILL.md frontmatter（yaml 解析，
 * 与 pi loadSourcedSkills 底层同一解析器同版本）→ domain/task
 * parseTaskManifest（T1.1 复用，纯函数）→ 入内存表。四类不入表且不炸：
 * 无 task 块（普通技能向后兼容）/ 无 frontmatter（task/ 目录下必缺 task 块
 * ——与无 task 块同源 warning，清单 #2.7：不再静默跳过）/ manifest 非法
 * （warning 不入表）/ frontmatter 读取或解析失败（warning 跳过）。坏
 * manifest 只 warning——与 SkillScanner「坏文件出 warning 不炸扫描」同哲学
 * （防线在引擎 createTask 的 task.type_unknown，装载面保持可用性）。
 *
 * 生命周期：组合根构造后 await load() 一次（builtin 层随仓不可变，无重扫
 * 面）；getTaskType/listTaskTypes 同步读内存表——装载完成前调用返回空表
 * （TaskEngineService 消费面同步签名，T1.3 接缝契约）。
 */
export interface TaskSkillRegistryDeps {
  /** 技能源（真体 = SkillScanner；测试可注入 fake SkillSourcePort）。 */
  readonly skills: SkillSourcePort;
  /** 坏 manifest warning 出口（结构兼容 infrastructure Logger.warn——组合根直接传 logger）。 */
  readonly warn: (message: string) => void;
}

export class TaskSkillRegistry implements TaskSkillRegistryPort {
  private readonly table = new Map<string, { manifest: TaskManifest; description: string }>();

  constructor(private readonly deps: TaskSkillRegistryDeps) {}

  /** 装载（一次性）：扫描 builtin task/ 层并解析全部 task 块入表。 */
  async load(): Promise<void> {
    const scanned = await this.deps.skills.scan();
    for (const skill of scanned.skills) {
      if (skill.source !== "builtin" || skill.audience !== "task") continue;
      const read = await this.readFrontmatter(skill.filePath, skill.name);
      if (read.kind === "failed") continue; // 读取/解析失败：warning 已出，只跳过
      if (read.kind === "absent") {
        // 无 frontmatter → 必缺 task 块（清单 #2.7：与下方 manifest===null 同为
        // 「task/ 目录放错文件」情形，同源 warning——不再静默跳过）
        this.deps.warn(
          `任务类型 skill "${skill.name}" 无 frontmatter（task/ 目录技能必须携带含 task 块的 frontmatter——放错目录或文件损坏），未入注册表（${skill.filePath}）`,
        );
        continue;
      }
      try {
        const manifest = parseTaskManifest(read.value);
        if (manifest === null) {
          // task/ 目录 = 任务类型 SOP 的机械约定：缺 task 块 = 放错目录，warning 不入表
          this.deps.warn(
            `任务类型 skill "${skill.name}" 缺 task 块（task/ 目录技能必须携带任务 manifest——放错目录？），未入注册表（${skill.filePath}）`,
          );
          continue;
        }
        this.table.set(skill.name, { manifest, description: skill.description });
      } catch (error) {
        this.deps.warn(
          `任务类型 skill "${skill.name}" manifest 非法，未入注册表（${skill.filePath}）：` +
            `${(error as DomainError).message}`,
        );
      }
    }
  }

  getTaskType(type: string): TaskManifest | null {
    return this.table.get(type)?.manifest ?? null;
  }

  listTaskTypes(): readonly TaskTypeInfo[] {
    return [...this.table.entries()].map(([type, e]) => ({ type, description: e.description }));
  }

  /**
   * 读 SKILL.md 的 frontmatter（YAML 对象）。结果三态（清单 #2.7 诊断口径）：
   * present=有 frontmatter（value）；absent=无 frontmatter 块（调用方在
   * task/ 目录语境下 warning）；failed=读取/解析失败（warning 已在本方法出，
   * 调用方只跳过）。
   */
  private async readFrontmatter(
    filePath: string,
    skillName: string,
  ): Promise<{ readonly kind: "present"; readonly value: Record<string, unknown> } | { readonly kind: "absent" } | { readonly kind: "failed" }> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      this.deps.warn(`任务类型 skill "${skillName}" 文件读取失败，跳过（${filePath}）：${String(error)}`);
      return { kind: "failed" };
    }
    const normalized = raw.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---\n")) return { kind: "absent" };
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1) return { kind: "absent" };
    try {
      const parsed = parseYaml(normalized.slice(4, endIndex));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { kind: "present", value: parsed as Record<string, unknown> };
      }
      this.deps.warn(
        `任务类型 skill "${skillName}" frontmatter 非映射形状（解析得到 ${typeof parsed}），跳过（${filePath}）`,
      );
      return { kind: "failed" };
    } catch (error) {
      this.deps.warn(`任务类型 skill "${skillName}" frontmatter YAML 解析失败，跳过（${filePath}）：${String(error)}`);
      return { kind: "failed" };
    }
  }
}
