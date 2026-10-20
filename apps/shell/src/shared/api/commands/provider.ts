/**
 * shared/api/commands/provider —— provider 域（三方 OpenAI 兼容平台 CRUD）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  ProviderDeleteCommand,
  ProviderListCommand,
  ProviderSetCommand,
  ProviderSetPayload,
} from "@helix/protocol";

// ── provider 族命令（三方平台批：自定义 OpenAI 兼容平台 CRUD；全局命令）
// 回执 = provider.list.result 点对点（list/set/delete 三命令共用——写后
// 即刷新清单）；key 录入/连通验证走既有 auth 族（不另设通路）。

/** provider.list：三方平台清单读面。 */
export function providerListCommand(): ProviderListCommand {
  return { v: PROTOCOL_VERSION, type: "provider.list", payload: {} };
}

/** provider.set：新增/更新平台（按 id upsert；id = 模型字符串前缀）。 */
export function providerSetCommand(payload: ProviderSetPayload): ProviderSetCommand {
  return { v: PROTOCOL_VERSION, type: "provider.set", payload };
}

/** provider.delete：删除平台（回执新清单）。 */
export function providerDeleteCommand(id: string): ProviderDeleteCommand {
  return { v: PROTOCOL_VERSION, type: "provider.delete", payload: { id } };
}
