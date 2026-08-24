/**
 * 会话模式注册表（P1 会话模式框架 T2，mode-framework-p1；PROTOCOL.md §18
 * 微批登记——版本位不 bump，§14 同构先例）。
 *
 * session 一对一绑定模式：草稿态可切（chat.send{draft:true, mode} 唯一写
 * 入口）、建会话定格锁定（无第二条写路径——锁定语义 = 结构不可能，非
 * 校验拒绝；故不设 mode.set 命令）。
 *
 * 注册表 schema 须能表达三模式不返工（P1 只落 default 一条）：
 * - single：单 agent 会话（default——main agent 绑 main-session 槽位）；
 * - staged：阶段迭代（P2 phase——design/build/verify 三阶段 agent，
 *   stages 数组预留）；
 * - orchestrated：动态工作流编排（P3 workflow——编排者 agent，
 *   profileKind 绑编排者槽位）。
 *
 * mode 的 wire 面一律 string（AD-2 字符串透传同构）：协议层不校验注册表
 * 成员资格——未知 mode 由消费侧（daemon 模式注册表单点，T3）fallback
 * DEFAULT_MODE_ID。本包纯契约（无 IO/无 React），注册表为 daemon/前端
 * 共享常量单点。
 */

/** staged 模式的阶段规格（P2 phase 预留；P1 注册表无 staged 条目）。 */
export interface StageSpec {
  id: string;
  /** 阶段绑定槽位（design/build/verify 各自的 agent 槽位）。 */
  profileKind: string;
  /** 阶段欢迎词 i18n key（P2 交接/欢迎词预留）。 */
  welcomeKey?: string;
}

/** 模式规格：kind 三值联合 = 三模式不返工的结构保障。 */
export interface ModeSpec {
  /** 模式 id（如 "default"；联合面见 ModeId）。 */
  id: string;
  kind: "single" | "staged" | "orchestrated";
  /** single/orchestrated 的绑定槽位；staged 模式看 stages[].profileKind。 */
  profileKind: string;
  /** staged 模式阶段清单（P2 预留）。 */
  stages?: readonly StageSpec[];
}

/**
 * 模式注册表（运行时常量，daemon/前端共享单点）。
 * `as const` 保留字面量供 ModeId 派生；`satisfies` 保证条目形状合式
 * （kind/profileKind 键拼错 → 编译失败）。
 */
export const MODES = [
  { id: "default", kind: "single", profileKind: "main-session" },
] as const satisfies readonly ModeSpec[];

/** 模式 id 联合（类型级保障：自 MODES 常量派生，注册表外 id 不可表达）。 */
export type ModeId = (typeof MODES)[number]["id"];

/** 缺省模式（chat.send.mode 缺省值 / daemon 未知 mode fallback 值——语义单点）。 */
export const DEFAULT_MODE_ID: ModeId = "default";
