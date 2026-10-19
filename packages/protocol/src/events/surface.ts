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
  "presence",
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

// ── 动词参数形状校验（事故热修批①，act 参数契约收紧） ─────────────

/**
 * 动词参数形状（按命名空间×动词——与各表面执行面消费字段同源）：
 * - shell / navigate：{ sessionId }（会话切换——shell 唯一动词）；
 * - browser / navigate：{ url }；browser / click：{ selector }；
 *   browser / type：{ selector, text }；browser / scroll：{ y? | direction? }
 *   （至少其一；direction ∈ up/down/top/bottom）；browser / focus：{ selector }。
 *
 * 2026-10-07 事故：act 工具描述只写了 browser 形状（navigate {url}），模型在
 * shell 表面发明 url 参数 → shell 载荷防御静默弃帧 → 60s 挂死。本校验面在
 * 挂闸/派发前即时拒绝（模型可自纠），错误文本携正确形状与示例。
 *
 * **覆盖范围与前置校验链（勿把本函数当总闸单独用）**：
 * - 只覆盖**已登记形状**的组合（shell×navigate、browser×上列五动词）；
 * - 未覆盖组合（如 shell×click、browser×未登记动词）返回 undefined = 「本函数
 *   无该组合的形状规则」，**不等于校验通过**；
 * - 动词词汇表合法性由调用方先行判定（`isSurfaceVerb` / Registry
 *   `isSurfaceVerbAllowed`）——现唯一生产调用点 StewardToolKit act 工具即此顺序
 *   （先 isSurfaceVerb 拒私造动词，再调本函数校形状）；
 * - 跳过前置直接调用 = 未覆盖组合静默放行（已知缺口：收紧为显式拒绝属**行为
 *   变更**，未经裁决不擅自改）。
 */
export function validateSurfaceActArgs(
  namespace: SurfaceNamespaceKind,
  verb: SurfaceVerb,
  args: Record<string, unknown>,
): string | undefined {
  const nonEmptyString = (key: string): string | undefined => {
    const v = args[key];
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  };
  if (namespace === "shell" && verb === "navigate") {
    const sessionId = nonEmptyString("sessionId");
    if (sessionId === undefined) {
      return `act 参数形状不合法：navigate 在 shell 表面需要 args.sessionId（目标会话 id 字符串，非空）——收到 ${JSON.stringify(args)}。示例：{"verb":"navigate","surfaceId":"shell:<connId>","args":{"sessionId":"<会话id>"}}（切换会话用 sessionId，不是 url）`;
    }
    return undefined;
  }
  if (namespace === "browser") {
    if (verb === "navigate") {
      const url = nonEmptyString("url");
      if (url === undefined) {
        return `act 参数形状不合法：navigate 在 browser 表面需要 args.url（目标网址字符串，非空）——收到 ${JSON.stringify(args)}。示例：{"verb":"navigate","surfaceId":"browser:<targetId>","args":{"url":"https://…"}}`;
      }
      return undefined;
    }
    if (verb === "click" || verb === "focus") {
      const selector = nonEmptyString("selector");
      if (selector === undefined) {
        return `act 参数形状不合法：${verb} 需要 args.selector（CSS 选择器字符串，非空）——收到 ${JSON.stringify(args)}。示例：{"verb":"${verb}","args":{"selector":"#submit"}}`;
      }
      return undefined;
    }
    if (verb === "type") {
      const selector = nonEmptyString("selector");
      if (selector === undefined) {
        return `act 参数形状不合法：type 需要 args.selector（CSS 选择器字符串，非空）——收到 ${JSON.stringify(args)}。示例：{"verb":"type","args":{"selector":"#q","text":"搜索词"}}`;
      }
      if (typeof args.text !== "string") {
        return `act 参数形状不合法：type 需要 args.text（要输入的文本字符串）——收到 ${JSON.stringify(args)}。示例：{"verb":"type","args":{"selector":"#q","text":"搜索词"}}`;
      }
      return undefined;
    }
    if (verb === "scroll") {
      const hasY = typeof args.y === "number" && Number.isFinite(args.y);
      const direction = args.direction;
      const hasDirection =
        direction === "up" || direction === "down" || direction === "top" || direction === "bottom";
      if (args.y !== undefined && !hasY) {
        return `act 参数形状不合法：scroll 的 args.y 应为有限数字——收到 ${JSON.stringify(args)}。示例：{"verb":"scroll","args":{"y":500}} 或 {"direction":"down"}`;
      }
      if (direction !== undefined && !hasDirection) {
        return `act 参数形状不合法：scroll 的 args.direction 应为 up/down/top/bottom——收到 ${JSON.stringify(args)}。示例：{"verb":"scroll","args":{"direction":"down"}}`;
      }
      if (!hasY && !hasDirection) {
        return `act 参数形状不合法：scroll 需要 args.y（数字）或 args.direction（up/down/top/bottom）至少其一——收到 ${JSON.stringify(args)}。示例：{"verb":"scroll","args":{"y":500}}`;
      }
      return undefined;
    }
  }
  return undefined; // cli 无注册动词（Registry 注册面拒绝前置）——零形状面
}

/** SurfaceDescriptor **形状**判定（kind ∈ 命名空间 + capabilities 为非空字符串
 *  数组）。注意：不校验 capabilities 是否为 SURFACE_VERBS 成员——词汇表成员校验
 *  单点在 daemon SurfaceRegistry 注册面（逐项 isSurfaceVerb +
 *  isSurfaceVerbAllowed）。 */
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
  /** 动词（能力 = 动词清单，D4）。线格式有意保持 string 不收窄 SurfaceVerb：
   *  词汇表校验单点在 daemon SurfaceRegistry（注册面 + act 路由）与
   *  StewardToolKit act 入参闸，协议面收窄需两端同动（收窄属契约变更，非注释
   *  对齐）。 */
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
  /** 能力 = 动词清单（非空；如 shell: ["navigate"]）。类型层保持 string[]：
   *  成员合法性单点在 Registry 注册面（isSurfaceVerb + isSurfaceVerbAllowed，
   *  非法项拒注册），协议面只约束形状（isSurfaceDescriptor）。 */
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
