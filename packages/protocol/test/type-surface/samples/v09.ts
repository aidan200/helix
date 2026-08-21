import { PROTOCOL_VERSION } from "../../../src/index";
import type {
  CommandEnvelope,
  EventEnvelope,
  WebStartCommand,
  WebStartResultEvent,
} from "../../../src/index";

/**
 * v0.9 样例帧（web 族扩展：1 命令 + 1 点对点结果帧；T7 CDP 显式启动通路
 * 契约——人侧手动预热连接（popover 启动钮），回执 applied（建连成功/已连接
 * 幂等）/ skipped（未发现可用浏览器，reason 含 remote debugging 引导说明）；
 * 状态回流经既有 web.status.changed 广播链，零新增广播帧）。构造即类型检查
 * （payload 字面量对位窄化）。
 */
// ── 命令样例 ──

/** web.start：显式启动写面（无参全局命令；回执 = web.start.result 点对点 +
 *  状态回 connected 经 web.status.changed 广播） */
export const webStart: WebStartCommand = {
  v: PROTOCOL_VERSION,
  type: "web.start",
  payload: {},
};

// ── 事件样例 ──

/** web.start.result：applied 回执（建连成功/已连接幂等） */
export const webStartResultApplied: WebStartResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "web",
  type: "web.start.result",
  payload: { status: "applied" },
};

/** web.start.result：skipped 回执（未发现可用浏览器；reason 含 remote
 *  debugging 引导说明） */
export const webStartResultSkipped: WebStartResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "web",
  type: "web.start.result",
  payload: { status: "skipped", reason: "未发现开启远程调试的浏览器（--remote-debugging-port）" },
};

export const v09Commands: CommandEnvelope[] = [webStart];
export const v09Events: EventEnvelope[] = [webStartResultApplied, webStartResultSkipped];
