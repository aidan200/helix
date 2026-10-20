/**
 * shared/api/commands/auth —— auth 域（provider 凭据清单读写 + 连通验证，全局命令）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  AuthDeleteKeyCommand,
  AuthListCommand,
  AuthSetKeyCommand,
  AuthVerifyCommand,
} from "@helix/protocol";

/** auth.list：provider 凭据清单（全局命令；P-4 列表数据）。 */
export function authListCommand(): AuthListCommand {
  return { v: PROTOCOL_VERSION, type: "auth.list", payload: {} };
}

/** auth.set_key：写 ~/.helix/auth.json（全局命令；P-4 key 弹层保存）。 */
export function authSetKeyCommand(providerId: string, apiKey: string): AuthSetKeyCommand {
  return { v: PROTOCOL_VERSION, type: "auth.set_key", payload: { providerId, apiKey } };
}

/** auth.delete_key：删 key（全局命令；P-4 两段式删除二击）。 */
export function authDeleteKeyCommand(providerId: string): AuthDeleteKeyCommand {
  return { v: PROTOCOL_VERSION, type: "auth.delete_key", payload: { providerId } };
}

/** auth.verify：连通验证（全局命令；P-4 测试连通）。 */
export function authVerifyCommand(providerId: string): AuthVerifyCommand {
  return { v: PROTOCOL_VERSION, type: "auth.verify", payload: { providerId } };
}
