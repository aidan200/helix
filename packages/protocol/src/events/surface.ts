/**
 * surface 族（M0 表面协议地基批，additive；设计：workspace docs/temp/
 * steward-browser-awareness-design.md §1/D2/D3/D7/D8）。
 *
 * 统一表面协议三原语 + 指令帧唯一性登记面：
 * - SurfaceEvent（表面→daemon 统一事件；kind 词汇表宿主无关封闭——D2）；
 * - SurfaceAction（管家→表面动作；risk 三档挂动作不挂宿主——D3；seq 执行
 *   回执锚——D7-1 原子性；origin="steward" 字段本批就带上——D7-2 回声过滤
 *   预备，消费接线留 M1）；
 * - SurfaceDescriptor（表面自述：capabilities 能力=动词清单 + policy 采集
 *   策略——D4 能力协商，新表面靠声明发现不加工具）。
 *
 * D8 通道治理：管家→页面的指令帧恒一种（SURFACE_INSTRUCTION_FRAME_TYPES
 * 只认 surface.action）；存量 steward.navigate 迁 surface.action
 * {verb:"navigate"}，兼容期双发、旧帧标 deprecated（DEPRECATED_EVENT_TYPES
 * 在册——M1 前检查点删除）。新指令帧禁令：想让页面做新事 = 声明新
 * capability，禁止再造专用帧。
 *
 * 两帧（channel = "surface"）：
 * - surface.action = 动作指令帧（定向到已注册表面连接；带 seq 执行回执）；
 * - surface.registered = 注册回执（点对点；daemon 分配 connId 身份）。
 */
import type { EventFrame } from "../envelope";

// ── 词汇表（封闭集；D2 跨表面通用，新表面不新增词汇）──────────────

/** SurfaceEvent kind 词汇表（D2 宿主无关封闭集）。 */
export const SURFACE_EVENT_KINDS = [
  "activated",
  "navigated",
  "user_click",
  "user_input",
  "idle",
  "error",
] as const;

/** SurfaceEvent kind（封闭词汇表成员）。 */
export type SurfaceEventKind = (typeof SURFACE_EVENT_KINDS)[number];

/** 事件来源三值（D7-2 回声过滤与 D10 系统族归一的基础）。 */
export const SURFACE_EVENT_ORIGINS = ["user", "steward", "system"] as const;

/** 事件来源（user = 用户真实操作 / steward = 管家动作回声 / system = 系统活动）。 */
export type SurfaceEventOrigin = (typeof SURFACE_EVENT_ORIGINS)[number];

/** 动作风险三档（D3 risk 挂动作不挂宿主；全表面统一闸门语义）。 */
export const SURFACE_RISK_LEVELS = ["read", "write", "destructive"] as const;

/** 动作风险（read 免确认 / write 走确认闸 / destructive 强制确认不可豁免）。 */
export type SurfaceRisk = (typeof SURFACE_RISK_LEVELS)[number];

/** surfaceId 命名空间词汇表（§1 Registry 寻址：每宿主一个 adapter 包）。 */
export const SURFACE_NAMESPACE_KINDS = ["shell", "browser", "cli"] as const;

/** surfaceId 命名空间（宿主种类）。 */
export type SurfaceNamespaceKind = (typeof SURFACE_NAMESPACE_KINDS)[number];

/** surfaceId 组合（`<namespace>:<connId>:<page>`——daemon 侧盖章单源）。 */
export function surfaceIdOf(namespace: SurfaceNamespaceKind, connId: string, page: string): string {
  return `${namespace}:${connId}:${page}`;
}

// ── 词汇表/结构类型守卫（运行时判别面；daemon handler 校验共用）────

/** kind 词汇表成员判定。 */
export function isSurfaceEventKind(v: unknown): v is SurfaceEventKind {
  return typeof v === "string" && (SURFACE_EVENT_KINDS as readonly string[]).includes(v);
}

/** origin 词汇表成员判定。 */
export function isSurfaceEventOrigin(v: unknown): v is SurfaceEventOrigin {
  return typeof v === "string" && (SURFACE_EVENT_ORIGINS as readonly string[]).includes(v);
}

/** risk 词汇表成员判定。 */
export function isSurfaceRisk(v: unknown): v is SurfaceRisk {
  return typeof v === "string" && (SURFACE_RISK_LEVELS as readonly string[]).includes(v);
}

/** surfaceId 命名空间成员判定。 */
export function isSurfaceNamespaceKind(v: unknown): v is SurfaceNamespaceKind {
  return typeof v === "string" && (SURFACE_NAMESPACE_KINDS as readonly string[]).includes(v);
}

// ── 动词封闭词汇表 + 注册校验面（M2，D4）──────────────────────

/**
 * 动词封闭词汇表（D4 跨表面通用封闭集——M2 动词注册校验面）：想让表面做
 * 新事 = 声明本词汇表内的动词能力，**缺词停下申报不私造**；各表面私造
 * 动词/跨表面同义不同名（如 click/tap/press 并存）由注册校验面拒绝。
 */
export const SURFACE_VERBS = ["click", "type", "navigate", "scroll", "focus"] as const;

/** 动作动词（封闭词汇表成员）。 */
export type SurfaceVerb = (typeof SURFACE_VERBS)[number];

/**
 * 命名空间→已注册动词清单（D4 封闭注册：browser 五动词 / shell 恰
 * navigate（M0 收编存量）/ cli 空（M3 CLI surface 批补面））。
 */
export const SURFACE_VERB_CAPABILITIES: Record<SurfaceNamespaceKind, readonly SurfaceVerb[]> = {
  shell: ["navigate"],
  browser: ["click", "type", "navigate", "scroll", "focus"],
  cli: [],
};

/**
 * 动词→risk 注册档（D3 risk 挂动作不挂宿主：档是动作的内在属性——
 * 请求 risk 只可升档不可降档）。scroll/focus 为浏览态读操作（read 免
 * 确认）；click/type/navigate 改变页面与目标（write 走确认闸）。
 */
export const SURFACE_VERB_RISKS: Record<SurfaceVerb, SurfaceRisk> = {
  click: "write",
  type: "write",
  navigate: "write",
  scroll: "read",
  focus: "read",
};

/** 动词词汇表成员判定（运行时守卫——私造动词拒收）。 */
export function isSurfaceVerb(v: unknown): v is SurfaceVerb {
  return typeof v === "string" && (SURFACE_VERBS as readonly string[]).includes(v);
}

/** 动词→命名空间注册面校验（跨表面越权/同义不同名防点）。 */
export function isSurfaceVerbAllowed(kind: SurfaceNamespaceKind, verb: string): boolean {
  return (SURFACE_VERB_CAPABILITIES[kind] as readonly string[]).includes(verb);
}

/** 动词 risk 注册档读取（D3 挂动作——降档即拒的判定基准）。 */
export function surfaceVerbRisk(verb: SurfaceVerb): SurfaceRisk {
  return SURFACE_VERB_RISKS[verb];
}

/** SurfaceDescriptor 结构判定（kind ∈ 命名空间 + capabilities 非空动词清单）。 */
export function isSurfaceDescriptor(v: unknown): v is SurfaceDescriptor {
  if (typeof v !== "object" || v === null) return false;
  const d = v as { kind?: unknown; capabilities?: unknown };
  if (!isSurfaceNamespaceKind(d.kind)) return false;
  if (!Array.isArray(d.capabilities) || d.capabilities.length === 0) return false;
  return d.capabilities.every((c) => typeof c === "string" && c !== "");
}

// ── 三原语（SurfaceEvent / SurfaceAction / SurfaceDescriptor）────

/**
 * SurfaceEvent 原语（表面→daemon 统一事件，归一后形态）：surfaceId 由
 * daemon 按 `<namespace>:<connId>:<page>` 盖章（表面不自报身份）。
 */
export interface SurfaceEvent {
  /** 事件种类（封闭词汇表）。 */
  kind: SurfaceEventKind;
  /** 来源（user/steward/system——回声过滤基础）。 */
  origin: SurfaceEventOrigin;
  /** 归属表面（`shell:<connId>:<page>` 等）。 */
  surfaceId: string;
  /** 事件时刻（epoch ms；daemon 归一时盖章）。 */
  at?: number;
  /** 宿主自定义补充（如 navigated 携 from 页；不承诺结构）。 */
  detail?: Record<string, unknown>;
}

/**
 * surface.event 命令载荷（上行 SurfaceEvent）：surfaceId 缺席——daemon 按
 * 连接身份 + page 组合盖章（表面不知道自己的 connId）。
 */
export interface SurfaceEventUplinkPayload {
  /** 事件种类（封闭词汇表）。 */
  kind: SurfaceEventKind;
  /** 来源（M0 shell 页面级事件恒 user；steward 回声接线留 M1）。 */
  origin: SurfaceEventOrigin;
  /** 当前页面标识（宿主自定义，如 shell 路由 id；surfaceId 第三段）。 */
  page: string;
  /** 宿主自定义补充（可选）。 */
  detail?: Record<string, unknown>;
}

/**
 * SurfaceAction 原语（管家→表面动作）：经确认闸路由（D3 write/destructive
 * 过闸后才产生本帧）；seq 单调供执行回执对账（D7-1 原子性）。
 */
export interface SurfaceAction {
  /** 动词（能力=动词清单——D4；M0 动词注册校验面留 M2）。 */
  verb: string;
  /** 动词参数（如 navigate 携 {sessionId}）。 */
  args: Record<string, unknown>;
  /** 风险档（read/write/destructive——D3 挂动作）。 */
  risk: SurfaceRisk;
  /** 执行回执序号（registry 内单调；回执 surface.action.result 对账锚）。 */
  seq: number;
  /** 触发来源（M0 恒 "steward"——D7-2 回声过滤预备字段）。 */
  origin: "steward";
}

/** surface.action payload（指令帧载荷）。 */
export interface SurfaceActionPayload extends SurfaceAction {
  /** 目标表面 id 清单（定向到具体表面——D8 与事件总线的分野）。 */
  surfaceIds?: readonly string[];
}

/** surface.action：统一动作指令帧（channel = "surface"；定向到已注册表面
 *  连接——D8 指令帧恒一种；回执经 surface.action.result 命令上行）。 */
export interface SurfaceActionEvent extends EventFrame<SurfaceActionPayload> {
  channel?: "surface";
  type: "surface.action";
}

/** surface.registered payload（注册回执）。 */
export interface SurfaceRegisteredPayload {
  /** 命名空间（回显 descriptor.kind）。 */
  namespace: SurfaceNamespaceKind;
  /** daemon 分配的连接内表面身份（surfaceId 第二段）。 */
  connId: string;
}

/** surface.registered：注册回执（channel = "surface"；点对点——回发发起
 *  surface.register 的连接；幂等重注册覆盖回执）。 */
export interface SurfaceRegisteredEvent extends EventFrame<SurfaceRegisteredPayload> {
  channel?: "surface";
  type: "surface.registered";
}

/**
 * SurfaceDescriptor 原语（表面自述——D4 能力协商）：注册时上送；capabilities
 * = 动词清单（Registry act 路由 verb→adapter 的判据），policy = 采集策略/
 * 隐私边界（M0 仅声明位，SalienceGate/隐私面板后续批次消费）。
 */
export interface SurfaceDescriptor {
  /** 表面宿主种类（surfaceId 命名空间第一段）。 */
  kind: SurfaceNamespaceKind;
  /** 能力 = 动词清单（非空；如 shell: ["navigate"]）。 */
  capabilities: readonly string[];
  /** 采集策略（可选；如上报事件子集/输入采集边界——D1 隐私一等公民）。 */
  policy?: {
    /** 自述可上报的事件 kind 子集（缺省 = 全词汇表）。 */
    events?: readonly SurfaceEventKind[];
    /** 输入采集边界（M0 shell 恒 false——页面级事件不采输入内容）。 */
    inputCapture?: boolean;
  };
}

// ── D8 指令帧唯一性登记面（机械可检验）────────────────────────

/**
 * 管家→页面的指令帧注册面（D8 通道治理：恒一种，不可扩——想让页面做新事
 * = 声明新 capability，禁止再造专用指令帧）。成员须已登记 EVENT_TYPES。
 */
export const SURFACE_INSTRUCTION_FRAME_TYPES = ["surface.action"] as const;
