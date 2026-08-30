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
 * 的 builtin 层（F-8：任务类型 skill 随仓分发、产品不可删改——user/project
 * 层技能即使带 task 块也不入表，任务类型是产品功能不是用户扩展点）。
 *
 * 装载口径：scan() → builtin 技能 → 读 SKILL.md frontmatter（yaml 解析，
 * 与 pi loadSourcedSkills 底层同一解析器同版本）→ domain/task
 * parseTaskManifest（T1.1 复用，纯函数）→ 入内存表。三类不入表且不炸：
 * 无 task 块（普通技能向后兼容）/ manifest 非法（warning 不入表）/
 * frontmatter 读取或解析失败（warning 跳过）。坏 manifest 只 warning——
 * 与 SkillScanner「坏文件出 warning 不炸扫描」同哲学（防线在引擎
 * createTask 的 task.type_unknown，装载面保持可用性）。
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

  /** 装载（一次性）：扫描 builtin 层并解析全部 task 块入表。 */
  async load(): Promise<void> {
    const scanned = await this.deps.skills.scan();
    for (const skill of scanned.skills) {
      if (skill.source !== "builtin") continue;
      const frontmatter = await this.readFrontmatter(skill.filePath, skill.name);
      if (frontmatter === null) continue;
      try {
        const manifest = parseTaskManifest(frontmatter);
        if (manifest === null) continue; // 无 task 块 → 普通技能，不入表
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
   * 读 SKILL.md 的 frontmatter（YAML 对象）。无 frontmatter / 读取失败 /
   * 解析失败 → null（warning 仅在失败路径出——无 frontmatter 的普通技能是
   * 常态，不是诊断）。
   */
  private async readFrontmatter(filePath: string, skillName: string): Promise<Record<string, unknown> | null> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      this.deps.warn(`任务类型 skill "${skillName}" 文件读取失败，跳过（${filePath}）：${String(error)}`);
      return null;
    }
    const normalized = raw.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---\n")) return null;
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1) return null;
    try {
      const parsed = parseYaml(normalized.slice(4, endIndex));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch (error) {
      this.deps.warn(`任务类型 skill "${skillName}" frontmatter YAML 解析失败，跳过（${filePath}）：${String(error)}`);
      return null;
    }
  }
}
