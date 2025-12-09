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
 * 分批止盈执行器
 * 统一处理健康检查和AI Agent的分批止盈逻辑，避免并发冲突
 */

import { createClient } from "@libsql/client";
import { createLogger } from "../utils/logger";
import { getExchangeClient } from "../exchanges";
import { calculateRMultiple } from "../tools/trading/takeProfitManagement";

const logger = createLogger({
  name: "partial-tp-executor",
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
   * @param key 锁的键
   * @param holder 锁持有者标识
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
   * @param key 锁的键
   * @param holder 锁持有者标识（必须匹配才能释放）
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
   * 检查最近是否有执行记录（防止重复执行）
   * @param symbol 币种
   * @param stage 阶段
   * @param windowSeconds 时间窗口（秒）
   * @returns true-最近有执行, false-没有
   */
  static async hasRecentExecution(symbol: string, stage: number, windowSeconds: number = 30): Promise<boolean> {
    try {
      const cutoffTime = new Date(Date.now() - windowSeconds * 1000).toISOString();
      
      const result = await dbClient.execute({
        sql: `SELECT COUNT(*) as count FROM partial_take_profit_history 
              WHERE symbol = ? AND stage = ? AND timestamp > ? AND status = 'completed'`,
        args: [symbol, stage, cutoffTime]
      });

      const count = Number(result.rows[0]?.count || 0);
      return count > 0;
    } catch (error: any) {
      logger.error(`检查执行记录失败: ${error.message}`);
      return false;
    }
  }
}

/**
 * 分批止盈执行器
 */
export class PartialTakeProfitExecutor {
  /**
   * 执行分批止盈检查和自动执行
   * @param caller 调用者标识（如 'health-check', 'ai-agent'）
   * @returns 执行结果
   */
  static async executeCheck(caller: string): Promise<{
    success: boolean;
    executed: number;
    skipped: number;
    details: Array<{ symbol: string; stage: number; result: string }>;
  }> {
    const executed: Array<{ symbol: string; stage: number; result: string }> = [];
    let executedCount = 0;
    let skippedCount = 0;

    try {
      // 获取所有持仓
      const dbPositions = await dbClient.execute({
        sql: 'SELECT symbol, side, entry_price, stop_loss, quantity FROM positions WHERE quantity != 0'
      });

      if (dbPositions.rows.length === 0) {
        return { success: true, executed: 0, skipped: 0, details: [] };
      }

      const exchangeClient = getExchangeClient();

      for (const pos of dbPositions.rows) {
        const symbol = pos.symbol as string;
        const side = pos.side as 'long' | 'short';
        const entryPrice = parseFloat(pos.entry_price as string || '0');
        const stopLossPrice = parseFloat(pos.stop_loss as string || '0');

        // 跳过没有止损价的持仓
        if (!stopLossPrice || stopLossPrice <= 0) {
          continue;
        }

        // 获取当前价格
        let currentPrice = 0;
        try {
          const contract = exchangeClient.normalizeContract(symbol);
          const ticker = await exchangeClient.getFuturesTicker(contract);
          currentPrice = parseFloat(ticker.last || '0');
        } catch (priceError: any) {
          logger.debug(`获取${symbol}价格失败，跳过: ${priceError.message}`);
          continue;
        }

        if (currentPrice <= 0) continue;

        // 计算当前R倍数
        const riskDistance = Math.abs(entryPrice - stopLossPrice);
        if (riskDistance === 0) continue;

        const currentR = calculateRMultiple(entryPrice, currentPrice, stopLossPrice, side);

        // 检查Stage1条件（≥1R）
        if (currentR >= 1.0) {
          const lockKey = `partial_tp_${symbol}_${side}_stage1`;
          
          // 检查是否最近已执行
          const hasRecent = await DistributedLock.hasRecentExecution(symbol, 1, 30);
          if (hasRecent) {
            logger.debug(`${symbol} Stage1 最近30秒内已执行，跳过`);
            skippedCount++;
            executed.push({ symbol, stage: 1, result: 'recently_executed' });
            continue;
          }

          // 尝试获取锁
          const lockAcquired = await DistributedLock.tryAcquire(lockKey, caller);
          if (!lockAcquired) {
            logger.debug(`${symbol} Stage1 锁被占用，跳过`);
            skippedCount++;
            executed.push({ symbol, stage: 1, result: 'lock_busy' });
            continue;
          }

          try {
            // 检查是否已执行Stage1
            const historyCheck = await dbClient.execute({
              sql: 'SELECT COUNT(*) as count FROM partial_take_profit_history WHERE symbol = ? AND stage = 1 AND status = \'completed\'',
              args: [symbol]
            });

            const stage1Executed = Number(historyCheck.rows[0]?.count || 0) > 0;

            if (!stage1Executed) {
              logger.info(`🎯 [${caller}] ${symbol} 达到 ${currentR.toFixed(2)}R，自动执行Stage1分批止盈`);

              // 动态导入工具，避免循环依赖
              const { partialTakeProfitTool } = await import('../tools/trading/takeProfitManagement');
              
              const result = await partialTakeProfitTool.execute!({
                symbol: symbol.replace('_USDT', '').replace('USDT', ''),
                stage: '1'
              }) as any;

              if (result.success) {
                logger.info(`✅ [${caller}] ${symbol} Stage1 自动执行成功: ${result.message}`);
                executedCount++;
                executed.push({ symbol, stage: 1, result: 'success' });
              } else {
                logger.warn(`⚠️ [${caller}] ${symbol} Stage1 执行失败: ${result.message}`);
                executed.push({ symbol, stage: 1, result: 'failed' });
              }
            } else {
              skippedCount++;
              executed.push({ symbol, stage: 1, result: 'already_executed' });
            }
          } finally {
            // 释放锁
            await DistributedLock.release(lockKey, caller);
          }
        }

        // 检查Stage2条件（≥2R）
        if (currentR >= 2.0) {
          const lockKey = `partial_tp_${symbol}_${side}_stage2`;
          
          // 检查是否最近已执行
          const hasRecent = await DistributedLock.hasRecentExecution(symbol, 2, 30);
          if (hasRecent) {
            logger.debug(`${symbol} Stage2 最近30秒内已执行，跳过`);
            skippedCount++;
            executed.push({ symbol, stage: 2, result: 'recently_executed' });
            continue;
          }

          // 尝试获取锁
          const lockAcquired = await DistributedLock.tryAcquire(lockKey, caller);
          if (!lockAcquired) {
            logger.debug(`${symbol} Stage2 锁被占用，跳过`);
            skippedCount++;
            executed.push({ symbol, stage: 2, result: 'lock_busy' });
            continue;
          }

          try {
            // 检查是否已执行Stage2
            const historyCheck = await dbClient.execute({
              sql: 'SELECT COUNT(*) as count FROM partial_take_profit_history WHERE symbol = ? AND stage = 2 AND status = \'completed\'',
              args: [symbol]
            });

            const stage2Executed = Number(historyCheck.rows[0]?.count || 0) > 0;

            if (!stage2Executed) {
              logger.info(`🎯 [${caller}] ${symbol} 达到 ${currentR.toFixed(2)}R，自动执行Stage2分批止盈`);

              // 动态导入工具，避免循环依赖
              const { partialTakeProfitTool } = await import('../tools/trading/takeProfitManagement');
              
              const result = await partialTakeProfitTool.execute!({
                symbol: symbol.replace('_USDT', '').replace('USDT', ''),
                stage: '2'
              }) as any;

              if (result.success) {
                logger.info(`✅ [${caller}] ${symbol} Stage2 自动执行成功: ${result.message}`);
                executedCount++;
                executed.push({ symbol, stage: 2, result: 'success' });
              } else {
                logger.warn(`⚠️ [${caller}] ${symbol} Stage2 执行失败: ${result.message}`);
                executed.push({ symbol, stage: 2, result: 'failed' });
              }
            } else {
              skippedCount++;
              executed.push({ symbol, stage: 2, result: 'already_executed' });
            }
          } finally {
            // 释放锁
            await DistributedLock.release(lockKey, caller);
          }
        }
      }

      if (executedCount > 0) {
        logger.info(`✅ [${caller}] 自动执行了 ${executedCount} 个分批止盈操作`);
      }

      return {
        success: true,
        executed: executedCount,
        skipped: skippedCount,
        details: executed
      };
    } catch (error: any) {
      logger.error(`[${caller}] 分批止盈检查失败: ${error.message}`);
      return {
        success: false,
        executed: executedCount,
        skipped: skippedCount,
        details: executed
      };
    }
  }
}
