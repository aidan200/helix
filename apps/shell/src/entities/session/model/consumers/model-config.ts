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
import { commandOfConnectionError } from "@/shared/lib/command-error";

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
  "config.get_sandbox.result",
  "config.set_sandbox.result",
  "config.get_proxy.result",
  "config.set_proxy.result",
  "config.get_summary.result",
  "config.set_summary.result",
  "config.get_kg.result",
  "config.set_kg.result",
  "config.get_voice_models.result",
  "config.set_voice_models.result",
  "auth.list.result",
  "auth.set_key.result",
  "auth.delete_key.result",
  "auth.verify.result",
  "auth.login.result",
  "auth.logout.result",
  "auth.prompt",
  "auth.notify",
  "auth.changed",
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
  credentialType?: import("@helix/protocol").AuthCredentialType;
  oauth?: { loginLabel: string; isSubscription: boolean; expires?: number };
}): import("../state").AuthProviderEntry {
  return {
    providerId: p.providerId,
    configured: p.configured,
    ...(p.keyMasked !== undefined ? { keyMasked: p.keyMasked } : {}),
    verifyStatus: p.verifyStatus ?? "unverified",
    ...(p.credentialType !== undefined ? { credentialType: p.credentialType } : {}),
    ...(p.oauth !== undefined ? { oauth: p.oauth } : {}),
  };
}

/** auth.list 整体替换（保留本地 verifying in-flight 条目——帧驱动权威不覆盖在途态）。 */
function replaceAuth(
  mc: ModelConfigState,
  providers: { providerId: string; configured: boolean; keyMasked?: string; verifyStatus?: "ok" | "fail" | "unverified"; credentialType?: import("@helix/protocol").AuthCredentialType; oauth?: { loginLabel: string; isSubscription: boolean } }[],
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
    case "config.get_sandbox.result":
    case "config.set_sandbox.result":
      // 沙箱开关读/写回执（沙箱开关批；result 帧驱动同构——无乐观更新）；
      // autoApprove 兑底 false（旧 daemon 回执缺键——自动通过必须显式开启）
      next = { ...mc, sandbox: { enabled: frame.payload.enabled, extraRoots: frame.payload.extraRoots ?? [], autoApprove: frame.payload.autoApprove === true } };
      break;
    case "config.get_proxy.result":
      // 网络代理读回执（网络代理批）：现态回显——读帧不置「已保存」
      next = { ...mc, proxy: { enabled: frame.payload.enabled, url: frame.payload.url } };
      break;
    case "config.set_proxy.result":
      // 网络代理写回执（部分更新语义回全量现值）：回填 + 收口在途 + 置「已保存」
      next = {
        ...mc,
        proxy: { enabled: frame.payload.enabled, url: frame.payload.url },
        proxyInflight: false,
        proxySaved: true,
      };
      break;
    case "config.get_kg.result":
    case "config.set_kg.result":
      // 知识库配置读/写回执（批2 WP-C；回执恒回生效值——回填不乐观）
      next = { ...mc, kg: { similarityWarn: frame.payload.similarityWarn, similarityDup: frame.payload.similarityDup } };
      break;
    case "config.get_summary.result":
      // 总结配置读回执（总结器独立化批①；get = summary.* 现态）
      next = { ...mc, summary: { enabled: frame.payload.enabled, everyTurns: frame.payload.everyTurns, model: frame.payload.model, task: { enabled: frame.payload.task.enabled, model: frame.payload.task.model } } };
      break;
    case "config.set_summary.result":
      // 总结配置写回执（state = 写入后新现态回读——回填不乐观）
      next = { ...mc, summary: { enabled: frame.payload.state.enabled, everyTurns: frame.payload.state.everyTurns, model: frame.payload.state.model, task: { enabled: frame.payload.state.task.enabled, model: frame.payload.state.task.model } } };
      break;
    case "config.get_voice_models.result":
      // ASR/TTS 模型配置读回执（模型配置接入 P0；get = 5 槽位全量生效态）
      next = { ...mc, voiceModels: { sttModel: frame.payload.sttModel, sttSiliconflowModel: frame.payload.sttSiliconflowModel, sttRealtimeModel: frame.payload.sttRealtimeModel, ttsModel: frame.payload.ttsModel, ttsStreamModel: frame.payload.ttsStreamModel } };
      break;
    case "config.set_voice_models.result":
      // ASR/TTS 模型配置写回执（state = 写入后新现态回读——回填不乐观）
      next = { ...mc, voiceModels: { sttModel: frame.payload.state.sttModel, sttSiliconflowModel: frame.payload.state.sttSiliconflowModel, sttRealtimeModel: frame.payload.state.sttRealtimeModel, ttsModel: frame.payload.state.ttsModel, ttsStreamModel: frame.payload.state.ttsStreamModel } };
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
    case "auth.prompt":
      // 登录交互 prompt 推送（订阅登录批）：登录卡内渲染回填表单；无登录卡 = stale
      next = mc.login === null ? mc : { ...mc, login: { ...mc.login, prompt: { requestId: frame.payload.requestId, prompt: frame.payload.prompt } } };
      if (next === mc) return topo;
      break;
    case "auth.notify":
      // 登录交互 notify 推送（auth_url/device_code/progress/info）：登录卡过程显示
      next = mc.login === null ? mc : { ...mc, login: { ...mc.login, notify: frame.payload.event } };
      if (next === mc) return topo;
      break;
    case "auth.login.result": {
      // 登录成功：凭据行更新（credentialType + configured）+ 登录卡收口 + 终态登记（成功 toast 消费）
      const prev = mc.auth[frame.payload.providerId];
      next = {
        ...mc,
        auth: {
          ...mc.auth,
          [frame.payload.providerId]: {
            providerId: frame.payload.providerId,
            configured: true,
            verifyStatus: "unverified",
            credentialType: frame.payload.credentialType,
            ...(prev?.oauth !== undefined ? { oauth: prev.oauth } : {}),
          },
        },
        login: null,
        loginSucceeded: { providerId: frame.payload.providerId },
      };
      break;
    }
    case "auth.logout.result":
      // 登出回执：收口在途（凭据行归零由 auth.changed 广播承担）
      next = { ...mc, logoutInflight: null };
      break;
    case "auth.changed": {
      // 凭据变更广播（登录/登出/录入/删除——daemon 权威同步）；无凭据类型 = 已无凭据
      const { providerId, credentialType } = frame.payload;
      const prev = mc.auth[providerId];
      if (credentialType === undefined) {
        if (prev === undefined || !prev.configured) return topo;
        next = patchAuth(mc, providerId, { configured: false, keyMasked: undefined, credentialType: undefined, verifyStatus: "unverified", latencyMs: undefined, failReason: undefined });
      } else {
        next = patchAuth(mc, providerId, {
          configured: true,
          credentialType,
          // oauth 态无 key 掩码（keyMasked 归零）；api_key 态保留既有掩码
          keyMasked: credentialType === "oauth" ? undefined : prev?.keyMasked,
        });
      }
      break;
    }
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
    case "model/set-thinking-default-aborted":
      // code-review M：send false 回滚乐观值（action.level = 发送前旧值）
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
    // ── 订阅登录批（§17.39）：登录流/登出 in-flight（终态由结果帧驱动）──
    case "model/login-started":
      // 单登录卡不变式：已有登录流时忽略新 started（UI 同步禁用其余入口）；
      // 新尝试同时清旧终态（防上一轮 toast 残留触发）
      return mc.login === null
        ? { ...mc, login: { providerId: action.providerId, loginType: action.loginType }, loginSucceeded: null }
        : { ...mc, loginSucceeded: null };
    case "model/login-aborted":
      return mc.login === null ? mc : { ...mc, login: null };
    case "model/logout-started":
      return mc.logoutInflight !== null ? mc : { ...mc, logoutInflight: action.providerId };
    case "model/logout-aborted":
      return mc.logoutInflight === null ? mc : { ...mc, logoutInflight: null };
    case "model/proxy-save-started":
      // 网络代理保存发起：在途置位 + 清上一轮「已保存」（回执驱动翻转，无乐观态）
      return { ...mc, proxyInflight: true, proxySaved: false };
    case "model/proxy-save-aborted":
      // 未发出（send false）：不留在途、不假「已保存」（TR-84）
      return mc.proxyInflight ? { ...mc, proxyInflight: false, proxySaved: false } : mc;
    case "model/consume-error":
      return mc.writeError === null ? mc : { ...mc, writeError: null };
    case "model/consume-login-success":
      return mc.loginSucceeded === null ? mc : { ...mc, loginSucceeded: null };
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
export function clearModelConfigInflight(mc: ModelConfigState, clearProxy = true): ModelConfigState {
  if (
    !mc.catalogRefreshing &&
    mc.verifyInflight === null &&
    mc.setKeyInflight === null &&
    mc.deleteKeyInflight === null &&
    mc.setDefaultInflight === null &&
    mc.login === null &&
    mc.logoutInflight === null &&
    (!clearProxy || (!mc.proxyInflight && !mc.proxySaved))
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
    login: null,
    logoutInflight: null,
    // 网络代理：断连夭折在途（结果帧永不到达）；「已保存」不残留假反馈
    ...(clearProxy ? { proxyInflight: false, proxySaved: false } : {}),
  };
}

/**
 * connection.error 伴转消费（F5 批 #3；dispatcher/frame.ts 前置路由调用）：
 * model/auth 写面命令的 daemon 失败回执走 connection.error 而非 *.result——
 * 有任一 in-flight 时清全部在途位 + 置 writeError（页面 err toast 交代）；
 * 无 in-flight 原样返回（单飞门控：非本族在途的 connection.error 不消费，
 * trace/workspace 先例）。
 */
/** 本族写面命令集（code-review 族B 尾缀归因面；「（命令 <type>）」单一构造点
 *  WsServerAdapter）。 */
const MODEL_CONFIG_COMMANDS: ReadonlySet<string> = new Set([
  "model.set_default",
  "model.set_thinking_default",
  "model.catalog_refresh",
  "auth.set_key",
  "auth.delete_key",
  "auth.verify",
  // 订阅登录批：login/logout 失败走 connection.error（清登录卡/在途 + toast）；
  // auth.respond/auth.cancel 故意不入表（respond 竞态错容忍静默，cancel 零回执）
  "auth.login",
  "auth.logout",
  // 网络代理批：config.set_proxy 拒绝走 connection.error（无结果帧）——清在途
  // + writeError 交代；config.get_proxy 零失败面入表会误清他命令在途，故不入
  "config.set_proxy",
]);

export function applyModelConfigConnError(
  topo: TopologyState,
  frame: EventEnvelope,
  ts?: number,
): TopologyState {
  const mc = topo.modelConfig;
  const message =
    (frame.payload as { message?: string } | undefined)?.message ?? "connection.error";
  // code-review 族B（尾缀归因，General 沙箱/WorkspaceContext 先例）：带命令
  // 尾缀时仅本族写面命令消费——别族（mcp/sandbox 等）拒绝不误清本族在途、
  // 不误弹 writeError toast；无尾缀旧 daemon 容忍也交代（宁误交代不静默）。
  const cmd = commandOfConnectionError(message);
  if (cmd !== undefined && !MODEL_CONFIG_COMMANDS.has(cmd)) return topo;
  // 代理与 auth/model 可以并发；带尾缀的拒绝只收自己的 flight，禁止互相摘位。
  if (cmd === "config.set_proxy") {
    if (!mc.proxyInflight) return topo;
    return { ...topo, modelConfig: { ...mc, proxyInflight: false, proxySaved: false } };
  }
  const cleared = clearModelConfigInflight(mc, cmd === undefined);
  if (cleared === mc) return topo; // 无在途——不消费（单飞门控）
  return {
    ...topo,
    modelConfig: { ...cleared, writeError: { message, ts: ts ?? 0 } },
  };
}
