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
 * 分批止盈实时监控服务
 * 持续检查持仓是否达到分批止盈条件，实时执行
 */

import { createClient } from "@libsql/client";
import { createLogger } from "../utils/logger";
import { PartialTakeProfitExecutor } from "../services/partialTakeProfitExecutor";

const logger = createLogger({
  name: "partial-tp-monitor",
  level: "info",
});

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

export class PartialTakeProfitMonitor {
  private checkInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private intervalSeconds: number;

  constructor(intervalSeconds: number = 10) {
    this.intervalSeconds = intervalSeconds;
  }

  /**
   * 启动实时监控服务
   */
  async start() {
    if (this.checkInterval) {
      logger.warn('分批止盈监控服务已在运行');
      return;
    }

    logger.info(`🚀 启动分批止盈实时监控服务，检测间隔: ${this.intervalSeconds}秒`);

    // 立即执行第一次检测
    await this.checkAndExecute();

    // 定期执行
    this.checkInterval = setInterval(async () => {
      await this.checkAndExecute();
    }, this.intervalSeconds * 1000);
  }

  /**
   * 停止监控服务
   */
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('分批止盈监控服务已停止');
    }
  }

  /**
   * 检查并执行分批止盈
   */
  private async checkAndExecute() {
    if (this.isRunning) {
      logger.debug('⏭️  上一次检测尚未完成，跳过本次');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      // 快速检查是否有持仓
      const posCount = await dbClient.execute({
        sql: 'SELECT COUNT(*) as count FROM positions WHERE quantity != 0'
      });

      const hasPositions = Number(posCount.rows[0]?.count || 0) > 0;

      if (!hasPositions) {
        logger.debug('📊 当前无持仓，跳过检测');
        return;
      }

      // 执行分批止盈检查
      const result = await PartialTakeProfitExecutor.executeCheck('tp-monitor');

      if (result.success) {
        if (result.executed > 0) {
          logger.info(`✅ 执行了 ${result.executed} 个分批止盈操作`);
        } else {
          logger.debug(`📊 无符合条件的分批止盈机会`);
        }
      } else {
        logger.warn('⚠️ 分批止盈检查失败');
      }
    } catch (error: any) {
      logger.error('❌ 分批止盈检测失败:', error);
    } finally {
      this.isRunning = false;
      const elapsedTime = Date.now() - startTime;
      logger.debug(`⏱️  本次检测完成，耗时: ${elapsedTime}ms`);
    }
  }
}

/**
 * 全局实例（单例模式）
 */
let monitorInstance: PartialTakeProfitMonitor | null = null;

/**
 * 启动分批止盈监控服务
 */
export function startPartialTakeProfitMonitor() {
  const enabled = process.env.PARTIAL_TP_MONITOR_ENABLED !== 'false'; // 默认启用

  if (!enabled) {
    logger.info('分批止盈实时监控已禁用 (PARTIAL_TP_MONITOR_ENABLED=false)');
    return;
  }

  const intervalSeconds = parseInt(process.env.PARTIAL_TP_CHECK_INTERVAL || '10');

  if (monitorInstance) {
    logger.warn('分批止盈监控服务已存在，停止旧实例');
    monitorInstance.stop();
  }

  monitorInstance = new PartialTakeProfitMonitor(intervalSeconds);
  monitorInstance.start();
}

/**
 * 停止分批止盈监控服务
 */
export function stopPartialTakeProfitMonitor() {
  if (monitorInstance) {
    monitorInstance.stop();
    monitorInstance = null;
  }
}
