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
import { calculateRMultiple, adjustRMultipleForVolatility, analyzeMarketVolatility } from "../tools/trading/takeProfitManagement";
import { getTradingStrategy, getStrategyParams } from "../agents/tradingAgent";

const logger = createLogger({
  name: "partial-tp-executor",
  level: "info",
});

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

/**
 * 分布式锁管理器
 */
class DistributedLock {
  private static readonly LOCK_TIMEOUT_MS = 30000; // 30秒锁超时

  /**
   * 尝试获取锁（使用原子操作避免竞态条件）
   * @param key 锁的键
   * @param holder 锁持有者标识
   * @returns true-获取成功, false-锁被占用
   */
  static async tryAcquire(key: string, holder: string): Promise<boolean> {
    try {
      const now = new Date().toISOString();
      const lockTimeoutSeconds = this.LOCK_TIMEOUT_MS / 1000;

      // 🔧 修复竞态条件：使用原子操作
      // 方案：先清理过期锁，再尝试插入（如果不存在）

      // 1. 清理过期锁（原子操作）
      await dbClient.execute({
        sql: `DELETE FROM system_config
              WHERE key = ?
              AND (julianday('now') - julianday(updated_at)) * 86400 >= ?`,
        args: [key, lockTimeoutSeconds]
      });

      // 2. 检查是否是自己持有的锁（需要刷新时间）
      const checkResult = await dbClient.execute({
        sql: 'SELECT value, updated_at FROM system_config WHERE key = ?',
        args: [key]
      });

      if (checkResult.rows.length > 0) {
        const lockValue = checkResult.rows[0].value as string;
        const lockTime = new Date(checkResult.rows[0].updated_at as string).getTime();
        const lockAge = Date.now() - lockTime;

        if (lockValue === holder) {
          // 自己持有的锁，刷新时间
          await dbClient.execute({
            sql: 'UPDATE system_config SET updated_at = ? WHERE key = ? AND value = ?',
            args: [now, key, holder]
          });
          logger.debug(`🔄 ${holder} 刷新锁: ${key}`);
          return true;
        }

        // 其他服务持有的锁
        logger.debug(`锁 ${key} 被 ${lockValue} 持有，剩余 ${Math.ceil((this.LOCK_TIMEOUT_MS - lockAge) / 1000)}秒`);
        return false;
      }

      // 3. 尝试获取锁（原子操作：仅在不存在时插入）
      // 使用 INSERT 而不是 INSERT OR REPLACE，避免覆盖其他进程的锁
      try {
        await dbClient.execute({
          sql: `INSERT INTO system_config (key, value, updated_at)
                SELECT ?, ?, ?
                WHERE NOT EXISTS (
                  SELECT 1 FROM system_config WHERE key = ?
                )`,
          args: [key, holder, now, key]
        });
      } catch (insertError: any) {
        // 插入失败说明其他进程已经获取了锁
        logger.debug(`锁 ${key} 获取失败（已被占用）`);
        return false;
      }

      // 4. 验证是否成功获取锁（双重检查）
      const verifyResult = await dbClient.execute({
        sql: 'SELECT value FROM system_config WHERE key = ?',
        args: [key]
      });

      if (verifyResult.rows.length > 0 && verifyResult.rows[0].value === holder) {
        logger.debug(`✅ ${holder} 获取锁: ${key}`);
        return true;
      }

      // 验证失败，说明被其他进程抢占了
      logger.debug(`锁 ${key} 验证失败（被其他进程抢占）`);
      return false;
    } catch (error: any) {
      logger.error(`获取锁失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 释放锁
   * @param key 锁的键
   * @param holder 锁持有者标识（必须匹配才能释放）
   */
  static async release(key: string, holder: string): Promise<void> {
    try {
      // 只有锁的持有者才能释放
      const checkResult = await dbClient.execute({
        sql: 'SELECT value FROM system_config WHERE key = ?',
        args: [key]
      });

      if (checkResult.rows.length > 0 && checkResult.rows[0].value === holder) {
        await dbClient.execute({
          sql: 'DELETE FROM system_config WHERE key = ?',
          args: [key]
        });
        logger.debug(`🔓 ${holder} 释放锁: ${key}`);
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

      // 获取当前策略的分批止盈配置
      const currentStrategy = getTradingStrategy();
      const strategyParams = getStrategyParams(currentStrategy);
      const tpConfig = strategyParams.partialTakeProfit;

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

        // 🔧 关键修复：如果已执行过分批止盈，需要从历史记录恢复原始止损价来计算R倍数
        // 因为Stage1执行后止损价会移到入场价，导致风险距离为0，无法计算后续Stage2/Stage3
        let originalStopLoss = stopLossPrice;

        try {
          // 查询是否有分批止盈历史
          const historyResult = await dbClient.execute({
            sql: 'SELECT stage, trigger_price, new_stop_loss_price FROM partial_take_profit_history WHERE symbol = ? AND status = \'completed\' ORDER BY stage ASC LIMIT 1',
            args: [symbol]
          });

          if (historyResult.rows.length > 0) {
            const firstStage = historyResult.rows[0];
            const stage = Number(firstStage.stage);
            const triggerPrice = parseFloat(firstStage.trigger_price as string || '0');

            if (stage === 1 && triggerPrice > 0) {
              // Stage1后止损=成本价，通过triggerPrice反推原始止损价
              // triggerPrice = entry + 1R = entry + (entry - originalStopLoss)
              // 所以: originalStopLoss = 2 * entry - triggerPrice
              originalStopLoss = 2 * entryPrice - triggerPrice;
              logger.debug(`${symbol} 从Stage1历史恢复原始止损价: ${originalStopLoss.toFixed(2)} (当前止损=${stopLossPrice.toFixed(2)})`);
            }
          }
        } catch (historyError: any) {
          logger.debug(`查询${symbol}分批止盈历史失败: ${historyError.message}`);
          // 失败时继续使用当前止损价
        }

        // 计算当前R倍数（使用原始止损价）
        const riskDistance = Math.abs(entryPrice - originalStopLoss);
        if (riskDistance === 0) {
          logger.debug(`${symbol} 风险距离为0，无法计算R倍数，跳过`);
          continue;
        }

        const currentR = calculateRMultiple(entryPrice, currentPrice, originalStopLoss, side);

        // 分析市场波动率并计算动态调整后的R倍数阈值
        const volatility = await analyzeMarketVolatility(symbol, "15m");
        const adjustedR1 = adjustRMultipleForVolatility(tpConfig.stage1.rMultiple, volatility);
        const adjustedR2 = adjustRMultipleForVolatility(tpConfig.stage2.rMultiple, volatility);

        // 检查Stage1条件（使用配置的R倍数 + 波动率调整）
        if (currentR >= adjustedR1) {
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

        // 检查Stage2条件（使用配置的R倍数 + 波动率调整）
        if (currentR >= adjustedR2) {
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
