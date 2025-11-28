/**
 * ai-auto-trading - AI 加密货币自动交易系统
 * Copyright (C) 2025 losesky
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 * 
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * 币种冷静期管理器
 * 
 * 功能：防止短期内对同一币种重复犯错
 * 
 * 规则：
 * - 单次亏损 ≥ 15%: 冷静期12小时
 * - 24小时内亏损2次: 冷静期24小时
 * - 24小时内亏损 ≥ 3次: 冷静期48小时
 * - 趋势反转平仓: 额外冷静期6小时
 */

import { createClient } from "@libsql/client";
import { createLogger } from "../utils/logger";

const logger = createLogger({
  name: "cooldown-manager",
  level: "info",
});

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

interface CooldownRecord {
  symbol: string;
  lossPercent: number;
  closeReason: string;
  closedAt: string;
  cooldownUntil: string;
}

/**
 * 检查币种是否在冷静期
 *
 * ⚠️ 已禁用：失败惩罚机制已关闭，始终允许交易
 */
export async function isSymbolInCooldown(symbol: string): Promise<{
  inCooldown: boolean;
  reason?: string;
  cooldownUntil?: string;
  remainingHours?: number;
}> {
  // 🔧 失败惩罚机制已禁用 - 始终返回 inCooldown: false
  return { inCooldown: false };

  /* 原始冷静期逻辑已禁用
  try {
    const now = new Date();

    // 查询24小时内的亏损记录（从position_close_events表）
    const result = await dbClient.execute({
      sql: `SELECT symbol, pnl_percent, close_reason, created_at
            FROM position_close_events
            WHERE symbol = ?
              AND pnl < 0
              AND created_at > datetime('now', '-24 hours')
            ORDER BY created_at DESC`,
      args: [symbol],
    });

    if (!result.rows || result.rows.length === 0) {
      return { inCooldown: false };
    }

    const losses = result.rows.map((row: any) => ({
      symbol: row.symbol,
      lossPercent: Math.abs(Number.parseFloat(row.pnl_percent || "0")),
      closeReason: row.close_reason,
      closedAt: row.created_at,
    }));

    // 规则1: 单次亏损 ≥ 15%，冷静期12小时
    const recentLoss = losses[0];
    if (recentLoss.lossPercent >= 15) {
      const closedTime = new Date(recentLoss.closedAt);
      const cooldownUntil = new Date(closedTime.getTime() + 12 * 60 * 60 * 1000);

      if (now < cooldownUntil) {
        const remainingHours = (cooldownUntil.getTime() - now.getTime()) / (1000 * 60 * 60);
        return {
          inCooldown: true,
          reason: `单次亏损${recentLoss.lossPercent.toFixed(1)}%超过15%阈值`,
          cooldownUntil: cooldownUntil.toISOString(),
          remainingHours: Math.ceil(remainingHours * 10) / 10,
        };
      }
    }

    // 规则2: 24小时内亏损2次，冷静期24小时
    if (losses.length >= 2) {
      const closedTime = new Date(losses[0].closedAt);
      const cooldownUntil = new Date(closedTime.getTime() + 24 * 60 * 60 * 1000);

      if (now < cooldownUntil) {
        const remainingHours = (cooldownUntil.getTime() - now.getTime()) / (1000 * 60 * 60);
        return {
          inCooldown: true,
          reason: `24小时内亏损${losses.length}次`,
          cooldownUntil: cooldownUntil.toISOString(),
          remainingHours: Math.ceil(remainingHours * 10) / 10,
        };
      }
    }

    // 规则3: 24小时内亏损 ≥ 3次，冷静期48小时
    if (losses.length >= 3) {
      const closedTime = new Date(losses[0].closedAt);
      const cooldownUntil = new Date(closedTime.getTime() + 48 * 60 * 60 * 1000);

      if (now < cooldownUntil) {
        const remainingHours = (cooldownUntil.getTime() - now.getTime()) / (1000 * 60 * 60);
        return {
          inCooldown: true,
          reason: `24小时内亏损${losses.length}次，进入长期冷静期`,
          cooldownUntil: cooldownUntil.toISOString(),
          remainingHours: Math.ceil(remainingHours * 10) / 10,
        };
      }
    }

    // 规则4: 趋势反转平仓，额外冷静期6小时
    const hasReversalLoss = losses.some(l => l.closeReason === 'trend_reversal');
    if (hasReversalLoss) {
      const reversalLoss = losses.find(l => l.closeReason === 'trend_reversal')!;
      const closedTime = new Date(reversalLoss.closedAt);
      const cooldownUntil = new Date(closedTime.getTime() + 6 * 60 * 60 * 1000);

      if (now < cooldownUntil) {
        const remainingHours = (cooldownUntil.getTime() - now.getTime()) / (1000 * 60 * 60);
        return {
          inCooldown: true,
          reason: `趋势反转亏损，等待市场稳定`,
          cooldownUntil: cooldownUntil.toISOString(),
          remainingHours: Math.ceil(remainingHours * 10) / 10,
        };
      }
    }

    return { inCooldown: false };
  } catch (error: any) {
    logger.error(`检查冷静期失败 ${symbol}:`, error);
    // 出错时保守处理，不阻止交易
    return { inCooldown: false };
  }
  */
}

/**
 * 获取币种的历史亏损统计（24小时和48小时）
 */
export async function getSymbolLossStats(symbol: string): Promise<{
  losses24h: number;
  losses48h: number;
  totalLoss24h: number;
  totalLoss48h: number;
  avgLossPercent24h: number;
  hasReversalLoss: boolean;
}> {
  try {
    // 24小时内的亏损
    const result24h = await dbClient.execute({
      sql: `SELECT pnl, pnl_percent, close_reason
            FROM position_close_events
            WHERE symbol = ?
              AND pnl < 0
              AND created_at > datetime('now', '-24 hours')`,
      args: [symbol],
    });
    
    // 48小时内的亏损
    const result48h = await dbClient.execute({
      sql: `SELECT pnl, pnl_percent, close_reason
            FROM position_close_events
            WHERE symbol = ?
              AND pnl < 0
              AND created_at > datetime('now', '-48 hours')`,
      args: [symbol],
    });
    
    const losses24h = result24h.rows || [];
    const losses48h = result48h.rows || [];
    
    const totalLoss24h = losses24h.reduce((sum, row: any) => 
      sum + Number.parseFloat(row.pnl || "0"), 0
    );
    
    const totalLoss48h = losses48h.reduce((sum, row: any) => 
      sum + Number.parseFloat(row.pnl || "0"), 0
    );
    
    const avgLossPercent24h = losses24h.length > 0
      ? losses24h.reduce((sum, row: any) => 
          sum + Math.abs(Number.parseFloat(row.pnl_percent || "0")), 0
        ) / losses24h.length
      : 0;
    
    const hasReversalLoss = losses24h.some((row: any) => 
      row.close_reason === 'trend_reversal'
    );
    
    return {
      losses24h: losses24h.length,
      losses48h: losses48h.length,
      totalLoss24h,
      totalLoss48h,
      avgLossPercent24h,
      hasReversalLoss,
    };
  } catch (error: any) {
    logger.error(`获取亏损统计失败 ${symbol}:`, error);
    return {
      losses24h: 0,
      losses48h: 0,
      totalLoss24h: 0,
      totalLoss48h: 0,
      avgLossPercent24h: 0,
      hasReversalLoss: false,
    };
  }
}

/**
 * 计算历史失败对评分的惩罚
 *
 * ⚠️ 已禁用：失败惩罚机制已关闭，不对历史亏损进行评分惩罚
 */
export function calculateHistoricalLossPenalty(stats: {
  losses24h: number;
  losses48h: number;
  avgLossPercent24h: number;
  hasReversalLoss: boolean;
}): number {
  // 🔧 失败惩罚机制已禁用 - 始终返回 0（无惩罚）
  return 0;

  /* 原始惩罚逻辑已禁用
  let penalty = 0;

  // 24小时内有亏损记录
  if (stats.losses24h > 0) {
    penalty += 20; // 基础惩罚

    // 平均亏损越大，惩罚越重
    if (stats.avgLossPercent24h >= 20) {
      penalty += 15;
    } else if (stats.avgLossPercent24h >= 15) {
      penalty += 10;
    } else if (stats.avgLossPercent24h >= 10) {
      penalty += 5;
    }
  }

  // 48小时内亏损2次以上
  if (stats.losses48h >= 2) {
    penalty += 20;
  }

  // 有趋势反转亏损
  if (stats.hasReversalLoss) {
    penalty += 15;
  }

  return penalty;
  */
}
