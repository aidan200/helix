/**
 * 总结配置出站端口（outbound，会话总结器独立化批①）。
 *
 * 职责：summary.* 通用总结配置域（三产物开关 / 锚点节奏 / 总结模型 + 任务总结
 * 子功能两键）的读写面。实现体 = driven/sqlite-session/SummaryConfigStore
 *（RuntimeConfigPort KV 五键——memory.* 域同构形态：键位/解析/迁移单源在
 * application/summary/summaryConfig.ts）。写面经 WriteQueue 单写通道（AG-06）。
 *
 * 生效语义：运行期即热——锚点判定前实时读（SessionSummaryService），设置
 * 保存后下一次锚点即按新配置执行，无需重启。写面不做前置值校验（与
 * memoryConfig「读面兜底」哲学一致），协议 handler 只做类型闸 + everyTurns
 * 范围闸（invalid_payload）。
 */
import type { SummaryConfigState } from "../../summary/summaryConfig";

/** 总结配置部分更新载荷（携带项写入，未携带项保留现值）。 */
export interface SummaryConfigPatch {
  /** 三产物总开关。 */
  readonly enabled?: boolean;
  /** 锚点轮次间隔（1-20；handler 类型闸先行）。 */
  readonly everyTurns?: number;
  /** 总结模型槽位（""/null = 清空回未配置态——显式配才产进展+记忆点）。 */
  readonly model?: string | null;
  /** 任务总结子功能组。 */
  readonly task?: {
    readonly enabled?: boolean;
    readonly model?: string | null;
  };
}

export interface SummaryConfigPort {
  /** 当前配置（生效值读面——readSummaryConfig 单源）。 */
  current(): SummaryConfigState;
  /** 部分更新写入（单写通道，落盘完成即返回；回读新现态）。 */
  set(patch: SummaryConfigPatch): Promise<SummaryConfigState>;
}
