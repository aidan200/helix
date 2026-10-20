/**
 * shared/api/commands/embedding —— embedding 域（向量/分类端点 CRUD、默认端点、连通测试）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  EmbeddingDeleteCommand,
  EmbeddingListCommand,
  EmbeddingSetCommand,
  EmbeddingSetDefaultCommand,
  EmbeddingVerifyCommand,
} from "@helix/protocol";

// ── embedding 配置域（管家记忆 B2）：端点 CRUD + 连通测试（向量模型 tab）──
// 回执 = embedding.list.result（list/set/delete 共用）/ embedding.verify.result。

/** embedding.list：端点清单读面（凭据卫生视图——行含 hasApiKey/verifiedAt）。 */
export function embeddingListCommand(): EmbeddingListCommand {
  return { v: PROTOCOL_VERSION, type: "embedding.list", payload: {} };
}

/** embedding.set：新增（id 缺省）/更新端点（apiKey 空串 = 清除；kind
 *  可选——缺省 embedding，classifier = 分类判官端点，更新缺省不动）。 */
export function embeddingSetCommand(payload: {
  id?: string;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  kind?: "embedding" | "classifier";
  variant?: string;
}): EmbeddingSetCommand {
  return { v: PROTOCOL_VERSION, type: "embedding.set", payload };
}

/** embedding.delete：删除端点（回执新清单）。 */
export function embeddingDeleteCommand(id: string): EmbeddingDeleteCommand {
  return { v: PROTOCOL_VERSION, type: "embedding.delete", payload: { id } };
}

/** embedding.set_default：设置全局默认端点（批1 向量默认；D1 泛化 kind 维度
 *  ——kind 缺省 = embedding，"classifier" = 默认分类端点；单选语义，
 *  校验三拒（不存在/kind 不吻合/未 verify）在 daemon，回执新清单）。 */
export function embeddingSetDefaultCommand(id: string, kind?: "embedding" | "classifier"): EmbeddingSetDefaultCommand {
  return { v: PROTOCOL_VERSION, type: "embedding.set_default", payload: { id, ...(kind !== undefined ? { kind } : {}) } };
}

/** embedding.verify：连通测试（回执 embedding.verify.result 两判别，id 回携）。 */
export function embeddingVerifyCommand(id: string): EmbeddingVerifyCommand {
  return { v: PROTOCOL_VERSION, type: "embedding.verify", payload: { id } };
}
