/**
 * ai-auto-trading - AI 加密货币自动交易系统
 * Copyright (C) 2025 losesky
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * 反转监控执行器
 * 统一处理反转监控线程和健康检查的反转平仓逻辑，避免并发冲突
 * 参考: partialTakeProfitExecutor.ts 的分布式锁实现
 */

import { createClient } from "@libsql/client";
import { createLogger } from "../utils/logger";
import { getExchangeClient } from "../exchanges";
import { analyzeMarketState } from "./marketStateAnalyzer";

const logger = createLogger({
  name: "reversal-executor",
  level: "info",
});

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

/**
 * 分布式锁管理器（原子操作版本 - 修复竞态条件）
 */
class DistributedLock {
  private static readonly LOCK_TIMEOUT_MS = 30000; // 30秒锁超时

  /**
   * 尝试获取锁（原子操作，无竞态条件）
   * @param key 锁的键（如 "reversal_close_BTC_USDT_long"）
   * @param holder 锁持有者标识（如 "health-check", "reversal-monitor"）
   * @returns true-获取成功, false-锁被占用
   */
  static async tryAcquire(key: string, holder: string): Promise<boolean> {
    try {
      const timeoutSeconds = this.LOCK_TIMEOUT_MS / 1000;

      // 原子操作：使用单个 SQL 语句完成检查、获取或刷新锁
      // 使用 INSERT OR REPLACE + CASE 表达式确保原子性
      const result = await dbClient.execute({
        sql: `
          INSERT INTO system_config (key, value, updated_at)
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET
            value = CASE
              -- 情况1: 锁已过期，任何人都可以获取
              WHEN (julianday('now') - julianday(updated_at)) * 86400 > ? THEN ?
              -- 情况2: 是自己持有的锁，刷新时间
              WHEN value = ? THEN ?
              -- 情况3: 其他人持有且未过期，保持不变
              ELSE value
            END,
            updated_at = CASE
              -- 只有在成功获取锁或刷新自己的锁时才更新时间
              WHEN (julianday('now') - julianday(updated_at)) * 86400 > ? OR value = ? THEN datetime('now')
              ELSE updated_at
            END
          RETURNING value, updated_at
        `,
        args: [
          key, holder,                    // INSERT 部分
          timeoutSeconds, holder,         // 过期判断 + 新持有者
          holder, holder,                 // 自己持有判断 + 保持持有者
          timeoutSeconds, holder          // 刷新时间判断
        ]
      });

      if (result.rows.length === 0) {
        logger.error(`获取锁失败: 未返回结果 ${key}`);
        return false;
      }

      const currentHolder = result.rows[0].value as string;
      const lockAcquired = currentHolder === holder;

      if (lockAcquired) {
        logger.debug(`✅ ${holder} 获取锁: ${key}`);
      } else {
        // 计算剩余时间（用于日志）
        const lockTime = new Date(result.rows[0].updated_at as string).getTime();
        const now = Date.now();
        const lockAge = now - lockTime;
        const remaining = Math.ceil((this.LOCK_TIMEOUT_MS - lockAge) / 1000);
        logger.debug(`锁 ${key} 被 ${currentHolder} 持有，剩余 ${remaining}秒`);
      }

      return lockAcquired;
    } catch (error: any) {
      logger.error(`获取锁失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 释放锁（原子操作，只有持有者能释放）
   */
  static async release(key: string, holder: string): Promise<void> {
    try {
      // 原子操作：只删除自己持有的锁
      const result = await dbClient.execute({
        sql: 'DELETE FROM system_config WHERE key = ? AND value = ? RETURNING key',
        args: [key, holder]
      });

      if (result.rows.length > 0) {
        logger.debug(`🔓 ${holder} 释放锁: ${key}`);
      } else {
        logger.debug(`锁 ${key} 不是由 ${holder} 持有，无需释放`);
      }
    } catch (error: any) {
      logger.error(`释放锁失败: ${error.message}`);
    }
  }

  /**
   * 检查最近是否有平仓记录（防止重复平仓）
   * @param symbol 币种
   * @param side 方向
   * @param windowSeconds 时间窗口（秒）
   */
  static async hasRecentClose(symbol: string, side: string, windowSeconds: number = 30): Promise<boolean> {
    try {
      const cutoffTime = new Date(Date.now() - windowSeconds * 1000).toISOString();
      
      const result = await dbClient.execute({
        sql: `SELECT COUNT(*) as count FROM position_close_events 
              WHERE symbol = ? AND side = ? AND created_at > ? AND close_reason LIKE '%reversal%'`,
        args: [symbol, side, cutoffTime]
      });

      const count = Number(result.rows[0]?.count || 0);
      return count > 0;
    } catch (error: any) {
      logger.error(`检查平仓记录失败: ${error.message}`);
      return false;
    }
  }
}

/**
 * 反转监控执行器
 */
export class ReversalMonitorExecutor {
  /**
   * 执行反转监控检查和自动平仓
   * @param caller 调用者标识（如 'health-check', 'reversal-monitor'）
   * @returns 执行结果
   */
  static async executeCheck(caller: string): Promise<{
    success: boolean;
    warned: number;
    closed: number;
    skipped: number;
    details: Array<{ 
      symbol: string; 
      side: string;
      reversalScore: number;
      action: 'warned' | 'closed' | 'skipped';
      reason: string;
    }>;
  }> {
    const details: Array<any> = [];
    let warnedCount = 0;
    let closedCount = 0;
    let skippedCount = 0;

    try {
      // 获取所有持仓
      const dbPositions = await dbClient.execute({
        sql: 'SELECT symbol, side, entry_price, current_price, unrealized_pnl, quantity, leverage FROM positions WHERE quantity != 0'
      });

      if (dbPositions.rows.length === 0) {
        return { success: true, warned: 0, closed: 0, skipped: 0, details: [] };
      }

      const exchangeClient = getExchangeClient();

      for (const pos of dbPositions.rows) {
        const symbol = pos.symbol as string;
        const side = pos.side as 'long' | 'short';
        const entryPrice = parseFloat(pos.entry_price as string || '0');
        let currentPrice = parseFloat(pos.current_price as string || '0');

        // 获取最新价格（适配币安和gate.io）
        try {
          const contract = exchangeClient.normalizeContract(symbol);
          const ticker = await exchangeClient.getFuturesTicker(contract);
          currentPrice = parseFloat(ticker.last || '0');
        } catch (priceError: any) {
          logger.debug(`获取${symbol}价格失败，跳过: ${priceError.message}`);
          continue;
        }

        if (currentPrice <= 0) continue;

        // 计算当前盈亏
        const pnlPercent = side === 'long'
          ? ((currentPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - currentPrice) / entryPrice) * 100;

        // 分析市场状态
        let reversalScore = 0;
        try {
          const analysis = await analyzeMarketState(symbol, { direction: side });
          reversalScore = analysis.reversalAnalysis?.reversalScore || 0;
        } catch (analysisError: any) {
          logger.debug(`分析${symbol}市场状态失败: ${analysisError.message}`);
          continue;
        }

        // 早期预警（30-70分）：仅记录
        if (reversalScore >= 30 && reversalScore < 70) {
          logger.warn(`⚠️ [${caller}] ${symbol} 早期反转预警 (${reversalScore.toFixed(0)}分)`);
          
          // 更新持仓metadata（非锁字段，只是标记）
          await dbClient.execute({
            sql: `UPDATE positions SET metadata = json_set(
                    COALESCE(metadata, '{}'), 
                    '$.reversalWarning', 1,
                    '$.warningScore', ?,
                    '$.warningTime', ?
                  ) WHERE symbol = ? AND side = ?`,
            args: [reversalScore, new Date().toISOString(), symbol, side]
          });

          warnedCount++;
          details.push({ 
            symbol, 
            side,
            reversalScore, 
            action: 'warned', 
            reason: 'early_warning' 
          });
          continue;
        }

        // 🚨 紧急平仓（≥70分）
        if (reversalScore >= 70) {
          const lockKey = `reversal_close_${symbol}_${side}`;
          
          // 检查是否最近已平仓
          const hasRecent = await DistributedLock.hasRecentClose(symbol, side, 30);
          if (hasRecent) {
            logger.debug(`${symbol} ${side} 最近30秒内已平仓，跳过`);
            skippedCount++;
            details.push({ 
              symbol, 
              side,
              reversalScore, 
              action: 'skipped', 
              reason: 'recently_closed' 
            });
            continue;
          }

          // 尝试获取锁
          const lockAcquired = await DistributedLock.tryAcquire(lockKey, caller);
          if (!lockAcquired) {
            logger.debug(`${symbol} ${side} 锁被占用，跳过`);
            skippedCount++;
            details.push({ 
              symbol, 
              side,
              reversalScore, 
              action: 'skipped', 
              reason: 'lock_busy' 
            });
            continue;
          }

          try {
            logger.error(`🚨 [${caller}] ${symbol} ${side} 触发紧急平仓: score=${reversalScore.toFixed(0)}, pnl=${pnlPercent.toFixed(2)}%`);

            // 再次确认持仓仍存在（双重检查）
            const checkResult = await dbClient.execute({
              sql: "SELECT * FROM positions WHERE symbol = ? AND side = ?",
              args: [symbol, side]
            });

            if (checkResult.rows.length === 0) {
              logger.info(`${symbol} ${side} 持仓已被其他线程平仓，跳过`);
              skippedCount++;
              details.push({ 
                symbol, 
                side,
                reversalScore, 
                action: 'skipped', 
                reason: 'already_closed' 
              });
              continue;
            }

            // 调用平仓API（适配币安和gate.io）
            // 使用减仓订单平仓整个持仓
            const contract = exchangeClient.normalizeContract(symbol);
            
            // 计算平仓数量（与持仓方向相反）
            const closeSize = side === 'long' ? -Math.abs(parseFloat(pos.quantity as string)) : Math.abs(parseFloat(pos.quantity as string));
            
            // 使用市价单减仓平仓
            await exchangeClient.placeOrder({
              contract,
              size: closeSize,
              price: 0,  // 市价单
              reduceOnly: true, // 只减仓
            });

            // 记录平仓事件
            await dbClient.execute({
              sql: `
                INSERT INTO position_close_events (
                  symbol, side, close_reason, trigger_type,
                  close_price, entry_price, quantity, leverage,
                  pnl, pnl_percent, created_at, processed
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
              `,
              args: [
                symbol, side, `reversal_monitor_emergency_by_${caller}`, 'system_risk',
                currentPrice, entryPrice, pos.quantity, pos.leverage,
                pos.unrealized_pnl, pnlPercent, new Date().toISOString()
              ]
            });

            // 从positions表删除
            await dbClient.execute({
              sql: "DELETE FROM positions WHERE symbol = ? AND side = ?",
              args: [symbol, side]
            });

            logger.info(`✅ [${caller}] ${symbol} ${side} 紧急平仓完成`);
            closedCount++;
            details.push({ 
              symbol, 
              side,
              reversalScore, 
              action: 'closed', 
              reason: 'emergency' 
            });

          } finally {
            // 释放锁（必须执行，即使发生异常）
            await DistributedLock.release(lockKey, caller);
          }
        }
      }

      return {
        success: true,
        warned: warnedCount,
        closed: closedCount,
        skipped: skippedCount,
        details
      };

    } catch (error: any) {
      logger.error(`[${caller}] 反转监控执行器失败: ${error.message}`);
      return {
        success: false,
        warned: warnedCount,
        closed: closedCount,
        skipped: skippedCount,
        details
      };
    }
  }
}
