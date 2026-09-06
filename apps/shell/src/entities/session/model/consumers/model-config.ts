/**
 * model-config 消费者 —— 模型/厂商全局配置面（model/auth 9 类 *.result 结果
 * 帧，契约 C §1/§2.2；T3.3 P-3/P-4 数据源）。
 *
 * 拓扑级消费者（操作 TopologyState.modelConfig，与 directory 同构——不入
 * dispatcher/index.ts 会话 store 注册表，经 dispatcher/frame.ts 前置路由）：
 * - model.catalog.result / model.catalog_refresh.result → 目录快照（P-3 菜单
 *   分组列表 + P-4 模型表四费率数据源；refresh 含 degraded 降级明细）；
 * - model.get.result / model.get_default.result / model.set_default.result
 *   → 全局默认态（P-3 DEFAULT 徽标 + 重置入口 + P-4 选择器）；
 * - auth.list.result → provider 凭据行整体替换（daemon 权威；本地 verifying
 *   in-flight 态不被覆盖）；
 * - auth.set_key / delete_key / verify.result → 凭据增量（结果帧 payload 无
 *   providerId 回携——归属经 in-flight 单值锁定，stale 帧丢弃）。
 *
 * verify 四态互斥（review.md §6 状态模型）：started action 先清旧 ok/fail
 * 置 verifying；结果帧到达即转 ok（含延迟）/ fail（含原因）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { EventEnvelope } from "@helix/protocol";
import type { ModelConfigState, TopologyState } from "../state";
import type { SessionAction } from "../state";

/** 本块承接的帧事件 type（拓扑级注册面；dispatcher/frame.ts 消费）。 */
export const MODEL_CONFIG_EVENT_TYPES = [
  "model.get.result",
  "model.catalog.result",
  "model.catalog_refresh.result",
  "model.set_default.result",
  "model.get_default.result",
  "model.set_thinking_default.result",
  "config.get_compaction.result",
  "config.set_compaction.result",
  "config.get_scheduling.result",
  "config.set_scheduling.result",
  "config.get_port.result",
  "config.set_port.result",
  "auth.list.result",
  "auth.set_key.result",
  "auth.delete_key.result",
  "auth.verify.result",
] as const;

/** 是否模型/厂商配置族事件（dispatcher 路由前置判定）。 */
export function isModelConfigEventType(type: string): type is (typeof MODEL_CONFIG_EVENT_TYPES)[number] {
  return (MODEL_CONFIG_EVENT_TYPES as readonly string[]).includes(type);
}

/** auth.list 帧行 → 凭据条目（四态初始：daemon 三态映射，无 verifying）。 */
function entryOf(p: {
  providerId: string;
  configured: boolean;
  keyMasked?: string;
  verifyStatus?: "ok" | "fail" | "unverified";
}): import("../state").AuthProviderEntry {
  return {
    providerId: p.providerId,
    configured: p.configured,
    ...(p.keyMasked !== undefined ? { keyMasked: p.keyMasked } : {}),
    verifyStatus: p.verifyStatus ?? "unverified",
  };
}

/** auth.list 整体替换（保留本地 verifying in-flight 条目——帧驱动权威不覆盖在途态）。 */
function replaceAuth(
  mc: ModelConfigState,
  providers: { providerId: string; configured: boolean; keyMasked?: string; verifyStatus?: "ok" | "fail" | "unverified" }[],
): ModelConfigState {
  const auth: Record<string, import("../state").AuthProviderEntry> = {};
  for (const p of providers) auth[p.providerId] = entryOf(p);
  // in-flight verify 不被清单替换覆盖（结果帧到达前保持 verifying）
  const inflight = mc.verifyInflight;
  if (inflight !== null && auth[inflight] !== undefined) {
    auth[inflight] = { ...auth[inflight], verifyStatus: "verifying" };
  }
  return { ...mc, auth, authLoaded: true };
}

/** 单 provider 条目更新（不可变）。 */
function patchAuth(
  mc: ModelConfigState,
  providerId: string,
  patch: Partial<import("../state").AuthProviderEntry>,
): ModelConfigState {
  const prev = mc.auth[providerId] ?? { providerId, configured: false, verifyStatus: "unverified" as const };
  return { ...mc, auth: { ...mc.auth, [providerId]: { ...prev, ...patch } } };
}

/** auth.verify.result：ok/fail 写入 in-flight 归属 provider（stale 帧丢弃）。 */
function applyVerifyResult(mc: ModelConfigState, payload: { status: "ok"; latencyMs: number } | { status: "fail"; reason: string }): ModelConfigState {
  const target = mc.verifyInflight;
  if (target === null) return mc; // stale（无在途请求）
  const next = patchAuth(mc, target, payload.status === "ok" ? { verifyStatus: "ok", latencyMs: payload.latencyMs, failReason: undefined } : { verifyStatus: "fail", failReason: payload.reason, latencyMs: undefined });
  return { ...next, verifyInflight: null };
}

/** 帧消费（dispatcher/frame.ts 前置路由）；stale/无变化时保持原拓扑引用。 */
export function applyModelConfigEvent(topo: TopologyState, frame: EventEnvelope): TopologyState {
  const mc = topo.modelConfig;
  let next: ModelConfigState;
  switch (frame.type) {
    case "model.get.result":
      // 目标会话查询回执：defaultModel 面（会话 model 态归活跃 store 快照/
      // model.changed，不在此写——双源防护）
      next = { ...mc, defaultModel: frame.payload.defaultModel };
      break;
    case "model.catalog.result":
      next = {
        ...mc,
        catalog: { models: frame.payload.models, refreshedAt: frame.payload.refreshedAt, source: frame.payload.source, degraded: [] },
      };
      break;
    case "model.catalog_refresh.result":
      next = {
        ...mc,
        catalogRefreshing: false,
        catalog: { models: frame.payload.models, refreshedAt: frame.payload.refreshedAt, source: frame.payload.source, degraded: frame.payload.degraded },
      };
      break;
    case "model.set_default.result":
      // 乐观值已由 set-default-started 写入；回执仅清 in-flight
      next = { ...mc, setDefaultInflight: null };
      break;
    case "model.get_default.result":
      // R7：全局默认推理强度随行（旧 daemon 不携带 → null = 未配置）
      next = { ...mc, defaultModel: frame.payload.model, defaultThinking: frame.payload.thinkingDefault ?? null };
      break;
    case "model.set_thinking_default.result":
      // 乐观值已由 set-thinking-default-started 写入；回执仅确认（无 in-flight 锁——档位选择器本地幂等）
      next = mc;
      break;
    case "config.get_compaction.result":
    case "config.set_compaction.result":
      // 压缩参数读/写回执：整体覆盖（无乐观更新——写面靠 result 帧驱动）
      next = { ...mc, compaction: { reserveTokens: frame.payload.reserveTokens, keepRecentTokens: frame.payload.keepRecentTokens } };
      break;
    case "config.get_scheduling.result":
    case "config.set_scheduling.result":
      // 调度预算读/写回执（config 瘦身批；result 帧驱动同构）
      next = { ...mc, scheduling: { maxConcurrent: frame.payload.maxConcurrent, maxQueued: frame.payload.maxQueued } };
      break;
    case "config.get_port.result":
      next = { ...mc, port: { effectivePort: frame.payload.effectivePort, storedPort: frame.payload.storedPort, overriddenByArgv: frame.payload.overriddenByArgv } };
      break;
    case "config.set_port.result":
      // 写回执只带 port 数——保持 argv 三态不变（写后不覆盖本次运行实际值）
      next = { ...mc, port: { effectivePort: mc.port?.effectivePort ?? frame.payload.port, storedPort: frame.payload.port, overriddenByArgv: mc.port?.overriddenByArgv ?? false } };
      break;
    case "auth.list.result":
      next = replaceAuth(mc, frame.payload.providers);
      break;
    case "auth.set_key.result": {
      const target = mc.setKeyInflight;
      if (target === null) return topo; // stale
      // 保存后：脱敏即时更新 + 连通态重置未验证（review.md F(3.4).2）
      next = { ...patchAuth(mc, target, { configured: true, keyMasked: frame.payload.keyMasked, verifyStatus: "unverified", latencyMs: undefined, failReason: undefined }), setKeyInflight: null };
      break;
    }
    case "auth.delete_key.result": {
      const target = mc.deleteKeyInflight;
      if (target === null) return topo; // stale
      next = { ...patchAuth(mc, target, { configured: false, keyMasked: undefined, verifyStatus: "unverified", latencyMs: undefined, failReason: undefined }), deleteKeyInflight: null };
      break;
    }
    case "auth.verify.result":
      next = applyVerifyResult(mc, frame.payload);
      if (next === mc) return topo; // stale（无在途请求）
      break;
    default:
      return topo;
  }
  return { ...topo, modelConfig: next };
}

/**
 * UI action 消费（topologyReducer 透传；命令发送同刻 dispatch）。
 * 串行化约束：同类 in-flight 非 null 时忽略新 started（结果帧 payload 无
 * providerId 回携——并发归属不可判定，UI 层同步禁用入口）。
 */
export function applyModelConfigAction(mc: ModelConfigState, action: SessionAction): ModelConfigState {
  switch (action.type) {
    case "model/verify-started": {
      if (mc.verifyInflight !== null && mc.verifyInflight !== action.providerId) return mc;
      // 重测先清旧态（ok/fail → verifying；四态互斥单值）
      return {
        ...patchAuth(mc, action.providerId, { verifyStatus: "verifying", latencyMs: undefined, failReason: undefined }),
        verifyInflight: action.providerId,
      };
    }
    case "model/set-key-started":
      if (mc.setKeyInflight !== null) return mc;
      return { ...mc, setKeyInflight: action.providerId };
    case "model/delete-key-started":
      if (mc.deleteKeyInflight !== null) return mc;
      return { ...mc, deleteKeyInflight: action.providerId };
    case "model/set-default-started":
      // 乐观更新（选择器即时反映）+ 回执锁定
      return { ...mc, defaultModel: action.model, setDefaultInflight: action.model };
    case "model/set-thinking-default-started":
      // R7 乐观更新（null = 清除）
      return { ...mc, defaultThinking: action.level };
    case "model/catalog-refresh-started":
      return { ...mc, catalogRefreshing: true };
    // ── F5 批：send 失败回滚族（TR-84——未发出即复原在途态/乐观值）──
    case "model/catalog-refresh-aborted":
      return mc.catalogRefreshing ? { ...mc, catalogRefreshing: false } : mc;
    case "model/set-default-aborted":
      // 回滚乐观值（action.model = 发送前捕获的旧默认）+ 清回执锁定
      return { ...mc, defaultModel: action.model, setDefaultInflight: null };
    case "model/verify-aborted": {
      if (mc.verifyInflight === null) return mc;
      const auth = { ...mc.auth };
      if (action.prev === undefined) delete auth[action.providerId];
      else auth[action.providerId] = action.prev;
      return { ...mc, auth, verifyInflight: null };
    }
    case "model/set-key-aborted":
      return mc.setKeyInflight === null ? mc : { ...mc, setKeyInflight: null };
    case "model/delete-key-aborted":
      return mc.deleteKeyInflight === null ? mc : { ...mc, deleteKeyInflight: null };
    case "model/consume-error":
      return mc.writeError === null ? mc : { ...mc, writeError: null };
    default:
      return mc;
  }
}

/**
 * 清 modelConfig 全部写面 in-flight 位（F5 批统一收口面）：
 * - conn/disconnected（断连夭折——在途命令的结果帧永不到达，永锁防护）；
 * - connection.error 在途失败（applyModelConfigConnError 内部复用）。
 * 断连/失败夭折的 verifying 条目回 unverified（daemon 侧调用已作废，防四态
 * 卡死）；set_default 乐观值不回滚（旧值状态面无留存，重连后 get_default
 * 重拉权威化）。无 in-flight 时保持原引用（浅比较友好）。
 */
export function clearModelConfigInflight(mc: ModelConfigState): ModelConfigState {
  if (
    !mc.catalogRefreshing &&
    mc.verifyInflight === null &&
    mc.setKeyInflight === null &&
    mc.deleteKeyInflight === null &&
    mc.setDefaultInflight === null
  ) {
    return mc;
  }
  let auth = mc.auth;
  if (mc.verifyInflight !== null) {
    const entry = mc.auth[mc.verifyInflight];
    if (entry !== undefined && entry.verifyStatus === "verifying") {
      auth = {
        ...auth,
        [mc.verifyInflight]: { ...entry, verifyStatus: "unverified" as const },
      };
    }
  }
  return {
    ...mc,
    auth,
    catalogRefreshing: false,
    verifyInflight: null,
    setKeyInflight: null,
    deleteKeyInflight: null,
    setDefaultInflight: null,
  };
}

/**
 * connection.error 伴转消费（F5 批 #3；dispatcher/frame.ts 前置路由调用）：
 * model/auth 写面命令的 daemon 失败回执走 connection.error 而非 *.result——
 * 有任一 in-flight 时清全部在途位 + 置 writeError（页面 err toast 交代）；
 * 无 in-flight 原样返回（单飞门控：非本族在途的 connection.error 不消费，
 * trace/workspace 先例）。
 */
export function applyModelConfigConnError(
  topo: TopologyState,
  frame: EventEnvelope,
  ts?: number,
): TopologyState {
  const mc = topo.modelConfig;
  const cleared = clearModelConfigInflight(mc);
  if (cleared === mc) return topo; // 无在途——不消费
  const message =
    (frame.payload as { message?: string } | undefined)?.message ?? "connection.error";
  return {
    ...topo,
    modelConfig: { ...cleared, writeError: { message, ts: ts ?? 0 } },
  };
}
