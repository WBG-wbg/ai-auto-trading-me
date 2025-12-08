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
 * Binance 交易所客户端实现 - 使用原生 fetch API
 */
import * as crypto from 'crypto';
import { createLogger } from "../utils/logger";
import { RISK_PARAMS } from "../config/riskParams";
import type {
  IExchangeClient,
  ExchangeConfig,
  TickerInfo,
  CandleData,
  AccountInfo,
  PositionInfo,
  OrderParams,
  OrderResponse,
  ContractInfo,
  TradeRecord,
} from "./IExchangeClient";

const logger = createLogger({
  name: "binance-exchange",
  level: "info",
});

/**
 * 安全的 JSON 解析，保护大整数不丢失精度
 * 将大整数字段（如 orderId）转换为字符串
 */
function safeJsonParse(text: string): any {
  // 使用正则替换：将数字字段（如 "orderId": 123456789... ）转为字符串
  // 匹配超过安全整数范围的数字（16位以上）
  const safeText = text.replace(
    /"(\w+)"\s*:\s*(\d{16,})/g,  // 匹配 "key": 大数字
    (match, key, value) => `"${key}":"${value}"`  // 转为字符串
  );
  return JSON.parse(safeText);
}

export class BinanceExchangeClient implements IExchangeClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly config: ExchangeConfig;
  private timeOffset = 0;
  private readonly defaultRecvWindow = 60000;
  private lastSyncTime = 0;
  private syncPromise: Promise<void> | null = null;
  // 订单缓存：存储最近的订单信息 (orderId -> {contract, orderInfo, timestamp})
  private orderCache: Map<string, {contract: string, orderInfo: any, timestamp: number}> = new Map();
  private readonly MAX_CACHE_SIZE = 1000; // 最大缓存数量
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 缓存有效期：24小时
  private readonly contractInfoCache: Map<string, ContractInfo> = new Map();

  // ============ 数据缓存机制 ============
  private positionsCache: { data: PositionInfo[]; timestamp: number } | null = null;
  private readonly POSITIONS_CACHE_TTL = 3000; // 持仓缓存3秒
  private accountInfoCache: { data: AccountInfo; timestamp: number } | null = null;
  private readonly ACCOUNT_INFO_CACHE_TTL = 5000; // 账户信息缓存5秒
  private tickerCache: Map<string, { data: TickerInfo; timestamp: number }> = new Map();
  private readonly TICKER_CACHE_TTL = 10000; // 行情缓存10秒 (从2秒增加)
  private candleCache: Map<string, { data: CandleData[]; timestamp: number }> = new Map();
  private readonly CANDLE_CACHE_TTL = 300000; // K线缓存5分钟 (从30秒大幅增加)
  
  // ============ 请求限流机制 ============
  private requestTimestamps: number[] = [];
  private readonly MAX_REQUESTS_PER_MINUTE = 5500; // 币安限制6000，保留安全边界
  private readonly REQUEST_INTERVAL = 60000; // 1分钟窗口
  private readonly MIN_REQUEST_DELAY = 100; // 最小请求间隔100ms
  private lastRequestTime = 0;

  // ============ 熔断器机制 ============
  private consecutiveFailures = 0;
  private readonly MAX_CONSECUTIVE_FAILURES = 3; // 连续失败3次触发熔断
  private circuitBreakerOpenUntil = 0;
  private readonly CIRCUIT_BREAKER_TIMEOUT = 60000; // 熔断器打开60秒后尝试恢复
  
  // ============ IP封禁感知 ============
  private ipBannedUntil = 0; // IP被封禁的截止时间

  constructor(config: ExchangeConfig) {
    this.config = config;
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    
    // Binance测试网URL (按优先级排列)
    // 注意: Binance测试网可能会变更或维护，如果一个不可用请尝试另一个
    const testnetUrls = [
      'https://testnet.binancefuture.com',  // 官方测试网
      'https://testnet.binance.vision',      // 备用测试网1
    ];
    
    this.baseUrl = config.isTestnet 
      ? testnetUrls[0]  // 默认使用第一个
      : 'https://fapi.binance.com';

    if (config.isTestnet) {
      logger.info('使用 Binance U本位合约测试网');
      logger.info(`测试网URL: ${this.baseUrl}`);
      logger.info('⚠️  如果测试网连接失败，可以尝试以下备选URL:');
      testnetUrls.slice(1).forEach((url, idx) => {
        logger.info(`   备选${idx + 1}: ${url}`);
      });
    } else {
      logger.info('使用 Binance U本位合约正式网');
    }

    logger.info('Binance API 客户端初始化完成');

    // 初始化时同步服务器时间
    this.syncPromise = this.syncServerTime();
  }

  getExchangeName(): string {
    return "binance";
  }

  isTestnet(): boolean {
    return this.config.isTestnet;
  }

  normalizeContract(symbol: string): string {
    // 处理各种输入格式，转换为 Binance 格式 BTCUSDT
    let normalized = symbol.replace('_', '').replace('/', '').replace(':USDT', '');
    
    // 如果是简单的币种符号（如 BTC），添加 USDT 后缀
    if (!normalized.endsWith('USDT') && !normalized.includes('USDT')) {
      normalized = normalized + 'USDT';
    }
    
    return normalized;
  }

  extractSymbol(contract: string): string {
    // 从 BTCUSDT 或 BTC/USDT:USDT 提取 BTC
    const normalized = this.normalizeContract(contract);
    return normalized.replace('USDT', '');
  }

  /**
   * 清理过期的订单缓存
   */
  private cleanupCache(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    
    // 找出过期的缓存 - 使用 Array.from 避免 Map 迭代器问题
    Array.from(this.orderCache.entries()).forEach(([orderId, cache]) => {
      if (now - cache.timestamp > this.CACHE_TTL) {
        keysToDelete.push(orderId);
      }
    });
    
    // 删除过期缓存
    for (const key of keysToDelete) {
      this.orderCache.delete(key);
    }
    
    // 如果缓存数量超过限制，删除最旧的条目
    if (this.orderCache.size > this.MAX_CACHE_SIZE) {
      const entries = Array.from(this.orderCache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDelete = entries.slice(0, entries.length - this.MAX_CACHE_SIZE);
      for (const [orderId] of toDelete) {
        this.orderCache.delete(orderId);
      }
    }
  }

  /**
   * 同步服务器时间
   */
  private async syncServerTime(): Promise<void> {
    try {
      const t0 = Date.now();
      const response = await this.publicRequest('/fapi/v1/time');
      const t1 = Date.now();
      const serverTime = response.serverTime;
      
      // 计算往返时间和时间偏移
      const rtt = t1 - t0; // 往返时间
      const estimatedServerTime = serverTime + Math.floor(rtt / 2); // 估计当前服务器时间
      const localTime = t1;
      
      // 计算偏移量，并减去2秒的安全余量以避免时间戳超前
      const rawOffset = estimatedServerTime - localTime;
      this.timeOffset = rawOffset - 2000; // 减去2秒安全余量
      this.lastSyncTime = Date.now();
      
    //   logger.info(`服务器时间同步完成，原始偏差: ${rawOffset}ms，应用偏差: ${this.timeOffset}ms，RTT: ${rtt}ms`);
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      // 如果是HTML响应错误，提供更详细的指导
      if (errorMsg.includes('HTML页面')) {
        logger.error('❌ Binance API连接失败: 服务器返回HTML而非JSON');
        logger.error('可能的原因:');
        logger.error('  1. 测试网URL已变更或服务已关闭');
        logger.error('  2. 网络被拦截或重定向');
        logger.error('  3. DNS解析错误');
        logger.error(`当前URL: ${this.baseUrl}`);
        
        if (this.config.isTestnet) {
          logger.error('建议操作:');
          logger.error('  - 验证测试网是否可访问: curl ' + this.baseUrl + '/fapi/v1/ping');
          logger.error('  - 尝试使用备用测试网URL (修改配置文件)');
          logger.error('  - 或切换到正式网进行测试 (设置 BINANCE_TESTNET=false)');
        }
      } else {
        logger.error('同步服务器时间失败:', error as Error);
      }
      
      throw error;
    }
  }

  /**
   * 确保时间已同步
   */
  private async ensureTimeSynced(): Promise<void> {
    // 如果正在同步，等待完成
    if (this.syncPromise) {
      await this.syncPromise;
      this.syncPromise = null;
      return;
    }
    
    // 如果超过2分钟未同步，重新同步（更频繁的同步）
    const timeSinceLastSync = Date.now() - this.lastSyncTime;
    if (timeSinceLastSync > 2 * 60 * 1000) {
    //   logger.info('时间同步已过期，重新同步...');
      await this.syncServerTime();
    }
  }

  /**
   * 获取当前服务器时间
   */
  private getServerTime(): number {
    return Date.now() + this.timeOffset;
  }

  /**
   * 生成签名
   */
  private generateSignature(data: any): string {
    const queryString = Object.keys(data)
      .map(key => `${key}=${data[key]}`)
      .join('&');
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  /**
   * 检查熔断器状态
   */
  private isCircuitBreakerOpen(): boolean {
    const now = Date.now();
    
    // 检查IP封禁状态
    if (this.ipBannedUntil > now) {
      const remainingSeconds = Math.ceil((this.ipBannedUntil - now) / 1000);
      if (remainingSeconds % 10 === 0) { // 每10秒提示一次
        logger.warn(`⏰ IP仍被封禁，剩余 ${remainingSeconds} 秒，使用缓存数据`);
      }
      return true;
    }
    
    // IP封禁结束，清除状态
    if (this.ipBannedUntil > 0 && this.ipBannedUntil <= now) {
      logger.info('✅ IP封禁已解除，恢复API请求');
      this.ipBannedUntil = 0;
      this.consecutiveFailures = 0;
      this.circuitBreakerOpenUntil = 0;
      return false;
    }
    
    // 检查普通熔断器
    if (this.circuitBreakerOpenUntil > now) {
      return true;
    }
    
    // 熔断器超时后重置
    if (this.circuitBreakerOpenUntil > 0 && this.circuitBreakerOpenUntil <= now) {
      logger.info('🔄 熔断器恢复，尝试重新连接...');
      this.consecutiveFailures = 0;
      this.circuitBreakerOpenUntil = 0;
    }
    
    return false;
  }

  /**
   * 记录请求成功
   */
  private recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      logger.info(`✅ API请求恢复正常，清除 ${this.consecutiveFailures} 次失败记录`);
      this.consecutiveFailures = 0;
    }
  }

  /**
   * 记录请求失败
   */
  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
      this.circuitBreakerOpenUntil = Date.now() + this.CIRCUIT_BREAKER_TIMEOUT;
      logger.error(`🚨 连续失败 ${this.consecutiveFailures} 次，触发熔断器，${this.CIRCUIT_BREAKER_TIMEOUT / 1000}秒内将使用缓存数据`);
    }
  }

  /**
   * 请求限流控制
   * 确保请求频率不超过币安限制
   */
  private async rateLimitControl(): Promise<void> {
    const now = Date.now();
    
    // 清理1分钟前的时间戳
    this.requestTimestamps = this.requestTimestamps.filter(
      timestamp => now - timestamp < this.REQUEST_INTERVAL
    );
    
    // 如果达到限制，等待
    if (this.requestTimestamps.length >= this.MAX_REQUESTS_PER_MINUTE) {
      const oldestTimestamp = this.requestTimestamps[0];
      const waitTime = this.REQUEST_INTERVAL - (now - oldestTimestamp) + 100; // 额外等待100ms
      if (waitTime > 0) {
        logger.warn(`请求频率达到限制，等待 ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    // 确保最小请求间隔
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.MIN_REQUEST_DELAY) {
      await new Promise(resolve => setTimeout(resolve, this.MIN_REQUEST_DELAY - timeSinceLastRequest));
    }
    
    // 记录本次请求
    this.requestTimestamps.push(Date.now());
    this.lastRequestTime = Date.now();
  }

  /**
   * 检查缓存是否有效
   */
  private isCacheValid(timestamp: number, ttl: number): boolean {
    return Date.now() - timestamp < ttl;
  }

  /**
   * 处理API请求，包含重试、超时和错误处理逻辑
   */
  private async handleRequest(url: URL, options: RequestInit, retries = 3): Promise<any> {
    // 检查熔断器状态
    if (this.isCircuitBreakerOpen()) {
      throw new Error('熔断器已打开，暂停API请求');
    }

    // 应用限流控制
    await this.rateLimitControl();
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      const controller = new AbortController();
      // 增加超时时间，第一次30秒，之后递增
      const timeoutMs = 30000 + (attempt - 1) * 10000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        options.signal = controller.signal;
        // 添加连接keepAlive以提高连接复用
        if (!options.headers) {
          options.headers = {};
        }
        (options.headers as Record<string, string>)['Connection'] = 'keep-alive';
        
        const response = await fetch(url.toString(), options);
        clearTimeout(timeoutId);

        // 检查响应内容类型，防止HTML响应被当作JSON解析
        const contentType = response.headers.get('content-type');
        const isHtmlResponse = contentType?.includes('text/html') || contentType?.includes('text/plain');
        
        if (!response.ok) {
          // 处理HTML错误响应
          if (isHtmlResponse) {
            const htmlText = await response.text();
            const errorMsg = `API返回HTML页面 (HTTP ${response.status})，可能是URL错误或服务不可用`;
            
            if (attempt === retries) {
              this.recordFailure();
              logger.error(`${errorMsg}`);
              logger.error(`URL: ${url.toString()}`);
              logger.error(`响应预览: ${htmlText.substring(0, 200)}...`);
              
              if (this.config.isTestnet) {
                logger.error(`⚠️  Binance 测试网可能已迁移或不可用`);
                logger.error(`建议检查: https://testnet.binancefuture.com 是否可访问`);
                logger.error(`或考虑切换到正式网进行测试`);
              }
            }
            
            throw new Error(errorMsg);
          }

          const errorText = await response.text();
          const error = safeJsonParse(errorText);
          
          // 🔥 特殊处理: IP被封禁 (-1003)
          if (error.code === -1003) {
            // 解析封禁时间
            const banMessage = error.msg || '';
            const banMatch = banMessage.match(/banned until (\d+)/);
            if (banMatch) {
              const banUntilTimestamp = parseInt(banMatch[1]);
              this.ipBannedUntil = banUntilTimestamp;
              const banDuration = Math.ceil((banUntilTimestamp - Date.now()) / 1000);
              
              logger.error(`🚨 IP被Binance封禁，封禁时长: ${banDuration}秒`);
              logger.error(`💡 建议: 使用WebSocket或大幅减少API调用频率`);
              logger.error(`⏰ 系统将在封禁期间使用缓存数据`);
              
              // 立即触发熔断器，使用封禁时长
              this.circuitBreakerOpenUntil = banUntilTimestamp;
              this.consecutiveFailures = this.MAX_CONSECUTIVE_FAILURES;
            } else {
              // 没有封禁时间，使用默认熔断时长
              logger.error(`🚨 IP被Binance封禁（-1003），触发熔断器`);
              this.circuitBreakerOpenUntil = Date.now() + this.CIRCUIT_BREAKER_TIMEOUT;
              this.consecutiveFailures = this.MAX_CONSECUTIVE_FAILURES;
            }
            
            throw new Error(`IP被封禁: ${error.msg}`);
          }
          
          // 如果是时间戳错误 (-1021)，重新同步时间并重试
          if (error.code === -1021 && attempt < retries) {
            logger.debug(`时间戳错误，重新同步服务器时间 (${attempt}/${retries})`);
            await this.syncServerTime();
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
          
          if (attempt === retries) {
            this.recordFailure();
            logger.error(`API请求失败(${attempt}/${retries}):`, error as Error);
          }
          logger.warn(`API请求失败(${attempt}/${retries}):`, error);
          // 增加重试间隔，使用指数退避策略
          await new Promise(resolve => setTimeout(resolve, Math.min(2000 * Math.pow(2, attempt - 1), 10000)));
          continue;
        }

        // 成功响应也检查是否是HTML
        if (isHtmlResponse) {
          const htmlText = await response.text();
          const errorMsg = `API返回HTML页面而非JSON数据`;
          
          if (attempt === retries) {
            this.recordFailure();
            logger.error(`${errorMsg}`);
            logger.error(`URL: ${url.toString()}`);
            logger.error(`响应预览: ${htmlText.substring(0, 200)}...`);
            
            if (this.config.isTestnet) {
              logger.error(`⚠️  Binance 测试网URL可能不正确`);
              logger.error(`当前使用: ${this.baseUrl}`);
              logger.error(`建议验证测试网是否可用或切换到正式网`);
            }
          }
          
          throw new Error(errorMsg);
        }

        // 请求成功，记录成功状态并解析JSON
        this.recordSuccess();

        try {
          const text = await response.text();
          return safeJsonParse(text);
        } catch (jsonError: any) {
          // JSON解析失败，可能是返回了HTML
          const text = await response.text().catch(() => 'Unable to read response');
          const errorMsg = `JSON解析失败: ${jsonError.message}`;
          
          logger.error(`${errorMsg}`);
          logger.error(`URL: ${url.toString()}`);
          logger.error(`响应预览: ${text.substring(0, 200)}...`);
          
          if (text.includes('<!DOCTYPE') || text.includes('<html')) {
            logger.error(`⚠️  API返回了HTML页面而非JSON数据`);
            if (this.config.isTestnet) {
              logger.error(`Binance 测试网可能存在问题，建议：`);
              logger.error(`1. 检查 ${this.baseUrl} 是否可访问`);
              logger.error(`2. 验证API Key是否用于正确的环境(测试网/正式网)`);
              logger.error(`3. 考虑切换到正式网或检查网络代理设置`);
            }
          }
          
          this.recordFailure();
          throw new Error(`${errorMsg} - 响应可能是HTML而非JSON`);
        }

      } catch (error: any) {
        clearTimeout(timeoutId);

        const isTimeout = error.name === 'AbortError' || 
                         error.message?.includes('timeout') ||
                         error.message?.includes('aborted') ||
                         error.message?.includes('Timeout');
        
        const isJsonError = error.message?.includes('JSON') || 
                           error.message?.includes('Unexpected token');

        if (attempt === retries) {
          this.recordFailure();
          logger.error(`API请求失败(${attempt}/${retries}):`, error as Error);
          throw error;
        }
        
        // JSON解析错误不重试，直接失败
        if (isJsonError) {
          logger.warn(`JSON解析错误，不再重试`);
          this.recordFailure();
          throw error;
        }

        // 使用指数退避策略，超时错误延迟更长
        const delay = isTimeout ? 
          Math.min(3000 * Math.pow(2, attempt - 1), 15000) : 
          Math.min(2000 * Math.pow(2, attempt - 1), 10000);
          
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    this.recordFailure();
    throw new Error(`API请求失败，已重试${retries}次`);
  }

  /**
   * 发送公共请求
   */
  private async publicRequest(endpoint: string, params: any = {}, retries = 3): Promise<any> {
    const url = new URL(this.baseUrl + endpoint);
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

    return this.handleRequest(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 AI-Auto-Trading Bot',
      }
    }, retries);
  }

  /**
   * 发送私有请求（需要签名）
   */
  private async privateRequest(endpoint: string, params: any = {}, method = 'GET', retries = 3): Promise<any> {
    // 确保时间已同步
    await this.ensureTimeSynced();
    
    // 使用专门的处理函数来处理带签名的请求
    return this.handleSignedRequest(endpoint, params, method, retries);
  }

  /**
   * 处理需要签名的请求（每次重试都重新生成签名）
   */
  private async handleSignedRequest(endpoint: string, params: any, method: string, retries: number): Promise<any> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // 每次重试都生成新的时间戳和签名
        const timestamp = this.getServerTime();
        const data = {
          ...params,
          timestamp,
          recvWindow: this.defaultRecvWindow
        };
        
        // 生成签名
        const signature = this.generateSignature(data);
        data.signature = signature;

        // 准备请求URL和选项
        const url = new URL(this.baseUrl + endpoint);
        const options: RequestInit = {
          method,
          headers: {
            'X-MBX-APIKEY': this.apiKey,
            'User-Agent': 'Mozilla/5.0 AI-Auto-Trading Bot',
          }
        };

        if (method === 'GET' || method === 'DELETE') {
          Object.keys(data).forEach(key => url.searchParams.append(key, data[key]));
        } else {
          options.body = new URLSearchParams(data);
          options.headers = {
            ...options.headers,
            'Content-Type': 'application/x-www-form-urlencoded'
          };
        }

        // 执行单次请求
        const controller = new AbortController();
        const timeoutMs = 15000 + (attempt - 1) * 5000;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
          options.signal = controller.signal;
          const response = await fetch(url.toString(), options);
          clearTimeout(timeoutId);

          // 检查响应内容类型
          const contentType = response.headers.get('content-type');
          const isHtmlResponse = contentType?.includes('text/html') || contentType?.includes('text/plain');
          
          if (!response.ok) {
            // 处理HTML错误响应
            if (isHtmlResponse) {
              const htmlText = await response.text();
              if (attempt === retries) {
                logger.error(`API返回HTML页面 (HTTP ${response.status})`);
                logger.error(`URL: ${url.toString()}`);
                throw new Error(`API返回HTML页面而非JSON数据`);
              }
              await new Promise(resolve => setTimeout(resolve, Math.min(1000 * attempt, 3000)));
              continue;
            }

            const errorText = await response.text();
            const error = safeJsonParse(errorText);
            
            // 🔥 特殊处理: IP被封禁 (-1003)
            if (error.code === -1003) {
              const banMessage = error.msg || '';
              const banMatch = banMessage.match(/banned until (\d+)/);
              if (banMatch) {
                const banUntilTimestamp = parseInt(banMatch[1]);
                this.ipBannedUntil = banUntilTimestamp;
                const banDuration = Math.ceil((banUntilTimestamp - Date.now()) / 1000);
                
                if (attempt === retries) {
                  logger.error(`🚨 IP被Binance封禁，封禁时长: ${banDuration}秒`);
                }
                
                this.circuitBreakerOpenUntil = banUntilTimestamp;
                this.consecutiveFailures = this.MAX_CONSECUTIVE_FAILURES;
              } else {
                this.circuitBreakerOpenUntil = Date.now() + this.CIRCUIT_BREAKER_TIMEOUT;
                this.consecutiveFailures = this.MAX_CONSECUTIVE_FAILURES;
              }
              
              throw new Error(`IP被封禁: ${error.msg}`);
            }
            
            // 如果是时间戳错误 (-1021)，重新同步时间并重试
            if (error.code === -1021 && attempt < retries) {
              logger.debug(`时间戳错误，重新同步服务器时间 (${attempt}/${retries})`);
              await this.syncServerTime();
              await new Promise(resolve => setTimeout(resolve, 500));
              continue;
            }
            
            if (attempt === retries) {
              logger.error(`API请求失败(${attempt}/${retries}):`, error as Error);
              throw new Error(`API请求失败: ${error.msg || error.message || response.statusText}`);
            }
            logger.warn(`API请求失败(${attempt}/${retries}):`, error);
            await new Promise(resolve => setTimeout(resolve, Math.min(1000 * attempt, 3000)));
            continue;
          }

          // 成功响应也检查是否是HTML
          if (isHtmlResponse) {
            const htmlText = await response.text();
            if (attempt === retries) {
              logger.error(`API返回HTML页面而非JSON数据`);
              logger.error(`URL: ${url.toString()}`);
              throw new Error(`API返回HTML页面而非JSON数据`);
            }
            await new Promise(resolve => setTimeout(resolve, Math.min(1000 * attempt, 3000)));
            continue;
          }

          // 安全地解析JSON
          try {
            const text = await response.text();
            return safeJsonParse(text);
          } catch (jsonError: any) {
            const text = await response.text().catch(() => 'Unable to read response');
            logger.error(`JSON解析失败: ${jsonError.message}`);
            logger.error(`URL: ${url.toString()}`);
            logger.error(`响应预览: ${text.substring(0, 200)}...`);
            
            if (attempt === retries) {
              throw new Error(`JSON解析失败: ${jsonError.message}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, Math.min(1000 * attempt, 3000)));
            continue;
          }
        } catch (fetchError: any) {
          clearTimeout(timeoutId);
          
          const isTimeout = fetchError.name === 'AbortError' || 
                           fetchError.message?.includes('timeout') ||
                           fetchError.message?.includes('aborted');
          
          const isJsonError = fetchError.message?.includes('JSON') || 
                             fetchError.message?.includes('Unexpected token');

          if (attempt === retries) {
            throw fetchError;
          }
          
          // JSON解析错误不重试
          if (isJsonError) {
            logger.warn(`JSON解析错误，不再重试`);
            throw fetchError;
          }

        //   logger.warn(`${isTimeout ? '请求超时' : 'API请求失败'}(${attempt}/${retries}), 将在 ${attempt} 秒后重试`);
          await new Promise(resolve => setTimeout(resolve, Math.min(1000 * attempt, 3000)));
        }
      } catch (error) {
        if (attempt === retries) {
          throw error;
        }
      }
    }

    throw new Error(`API请求失败，已重试${retries}次`);
  }

  async getFuturesTicker(contract: string, retries: number = 2): Promise<TickerInfo> {
    try {
      const symbol = this.normalizeContract(contract);

      // 检查缓存
      const cacheKey = symbol;
      const cached = this.tickerCache.get(cacheKey);
      if (cached && this.isCacheValid(cached.timestamp, this.TICKER_CACHE_TTL)) {
        return cached.data;
      }

      // 如果熔断器打开，使用过期缓存
      if (this.isCircuitBreakerOpen()) {
        if (cached) {
          logger.warn(`熔断器已打开，使用 ${symbol} 的缓存数据`);
          return cached.data;
        }
        throw new Error('熔断器已打开且无可用缓存');
      }

      const [ticker, markPrice] = await Promise.all([
        this.publicRequest('/fapi/v1/ticker/24hr', { symbol }, retries),
        this.publicRequest('/fapi/v1/premiumIndex', { symbol }, retries)
      ]);
      
      const result = {
        contract: contract,
        last: ticker.lastPrice,
        markPrice: markPrice.markPrice,
        indexPrice: markPrice.indexPrice,
        volume24h: ticker.volume,
        high24h: ticker.highPrice,
        low24h: ticker.lowPrice,
        change24h: ticker.priceChangePercent,
      };

      // 更新缓存
      this.tickerCache.set(cacheKey, {
        data: result,
        timestamp: Date.now()
      });

      return result;
    } catch (error) {
      // 如果出错且有缓存，使用缓存降级
      const symbol = this.normalizeContract(contract);
      const cached = this.tickerCache.get(symbol);
      if (cached) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.warn(`获取 ${symbol} 行情失败，使用缓存数据: ${errorMsg}`);
        return cached.data;
      }
      
      logger.error(`获取 ${contract} 行情失败:`, error as Error);
      throw error;
    }
  }

  async getFuturesCandles(
    contract: string,
    interval: string = '1h',
    limit: number = 100,
    from?: number,
    to?: number,
    retries: number = 2
  ): Promise<CandleData[]> {
    try {
      const symbol = this.normalizeContract(contract);

      // 检查缓存 (如果没有指定时间范围，才使用缓存)
      if (!from && !to) {
        const cacheKey = `${symbol}-${interval}-${limit}`;
        const cached = this.candleCache.get(cacheKey);
        if (cached && this.isCacheValid(cached.timestamp, this.CANDLE_CACHE_TTL)) {
          return cached.data;
        }
      }

      const params: any = {
        symbol,
        interval,
        limit
      };

      if (from) params.startTime = from;
      if (to) params.endTime = to;

      const response = await this.publicRequest('/fapi/v1/klines', params, retries);

      const result = response.map((k: any[]) => ({
        timestamp: k[0],
        open: k[1].toString(),
        high: k[2].toString(),
        low: k[3].toString(),
        close: k[4].toString(),
        volume: k[5].toString(),
      }));

      // 更新缓存 (仅当没有指定时间范围时)
      if (!from && !to) {
        const cacheKey = `${symbol}-${interval}-${limit}`;
        this.candleCache.set(cacheKey, {
          data: result,
          timestamp: Date.now()
        });
      }

      return result;
    } catch (error) {
      logger.debug(`获取 ${contract} K线数据失败:`, error as Error);
      throw error;
    }
  }

  async getFuturesAccount(retries: number = 2): Promise<AccountInfo> {
    try {
      // 检查缓存
      if (this.accountInfoCache && this.isCacheValid(this.accountInfoCache.timestamp, this.ACCOUNT_INFO_CACHE_TTL)) {
        return this.accountInfoCache.data;
      }

      // 如果熔断器打开，使用过期缓存
      if (this.isCircuitBreakerOpen()) {
        if (this.accountInfoCache) {
          logger.warn('熔断器已打开，使用账户信息缓存数据');
          return this.accountInfoCache.data;
        }
        throw new Error('熔断器已打开且无可用缓存');
      }

      const account = await this.privateRequest('/fapi/v2/account', {}, 'GET', retries);
      
      const result = {
        currency: 'USDT',
        total: account.totalWalletBalance,
        available: account.availableBalance,
        positionMargin: account.totalPositionInitialMargin || '0',
        orderMargin: account.totalOpenOrderInitialMargin || '0',
        unrealisedPnl: account.totalUnrealizedProfit,
      };

      // 更新缓存
      this.accountInfoCache = {
        data: result,
        timestamp: Date.now()
      };

      return result;
    } catch (error) {
      // 如果出错且有缓存，使用缓存降级
      if (this.accountInfoCache) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.warn(`获取账户信息失败，使用缓存数据: ${errorMsg}`);
        return this.accountInfoCache.data;
      }
      
      logger.error('获取账户信息失败:', error as Error);
      throw error;
    }
  }

  async getPositions(retries: number = 2): Promise<PositionInfo[]> {
    try {
      // 检查缓存
      if (this.positionsCache && this.isCacheValid(this.positionsCache.timestamp, this.POSITIONS_CACHE_TTL)) {
        return this.positionsCache.data;
      }

      // 如果熔断器打开，使用过期缓存
      if (this.isCircuitBreakerOpen()) {
        if (this.positionsCache) {
          logger.warn('熔断器已打开，使用持仓信息缓存数据');
          return this.positionsCache.data;
        }
        throw new Error('熔断器已打开且无可用缓存');
      }

      const positions = await this.privateRequest('/fapi/v2/positionRisk', {}, 'GET', retries);
      
    //   logger.info(`API 返回 ${positions.length} 个持仓记录`);
      
      // 详细记录每个持仓的原始数据
      const filteredPositions = positions.filter((p: any) => {
        const posAmount = parseFloat(p.positionAmt);
        const entryPrice = parseFloat(p.entryPrice);
        // 有时候 positionAmt 为 0 但 entryPrice 不为 0，说明订单还在处理中
        return posAmount !== 0 || entryPrice !== 0;
      });
      
    //   logger.info(`过滤后有效持仓数: ${filteredPositions.length}`);
      
      const result = filteredPositions.map((p: any) => {
        const posAmount = parseFloat(p.positionAmt);
        const entryPrice = parseFloat(p.entryPrice);
        const markPrice = parseFloat(p.markPrice);
        const leverage = parseInt(p.leverage);
        
        // 🔧 计算保证金（开仓价值）
        // Binance USDT永续合约：保证金 = |持仓数量 * 开仓价格| / 杠杆
        const notional = Math.abs(posAmount * entryPrice);
        const margin = leverage > 0 ? (notional / leverage) : notional;
        
        // 保留原始的 posAmount（带符号），供平仓时使用
        return {
          contract: p.symbol,
          size: posAmount.toString(), // 保留符号：正数=多头，负数=空头
          leverage: leverage.toString(),
          entryPrice: entryPrice.toString(),
          markPrice: markPrice.toString(),
          liqPrice: p.liquidationPrice,
          unrealisedPnl: p.unRealizedProfit,
          realisedPnl: '0',
          margin: margin.toString(),
        };
      });

      // 更新缓存
      this.positionsCache = {
        data: result,
        timestamp: Date.now()
      };

      return result;
    } catch (error) {
      // 如果出错且有缓存，使用缓存降级
      if (this.positionsCache) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.warn(`获取持仓失败，使用缓存数据: ${errorMsg}`);
        return this.positionsCache.data;
      }
      
      logger.error('获取持仓失败:', error as Error);
      throw error;
    }
  }

  async placeOrder(params: OrderParams, retries: number = 2): Promise<OrderResponse> {
    try {
      const symbol = this.normalizeContract(params.contract);
      const orderType = params.price ? 'LIMIT' : 'MARKET';
      
      // 🔧 币安使用 quantity 字段（币种数量），需要处理精度
      let quantity = Math.abs(params.size);
      
      // 获取合约信息以确定精度
      try {
        const contractInfo = await this.getContractInfo(params.contract);
        const minQty = contractInfo.orderSizeMin;
        
        // 根据 minQty 确定小数位数
        const decimalPlaces = minQty >= 1 ? 0 : Math.abs(Math.floor(Math.log10(minQty)));
        const multiplier = Math.pow(10, decimalPlaces);
        
        // 🔧 修复：使用 round 代替 floor，避免小数量被截断为0
        // 对于 0.00019112，精度3位时：round(0.19112) / 1000 = 0.000191
        quantity = Math.round(quantity * multiplier) / multiplier;
        
        // 确保不小于最小下单量
        if (quantity < minQty) {
          logger.warn(`计算数量 ${quantity} 小于最小下单量 ${minQty}，调整为最小值`);
          quantity = minQty;
        }
        
        // 🔧 币安最小名义价值检查(Binance minimum notional value: 20 USDT)
        // 名义价值 = 数量 * 价格
        const MIN_NOTIONAL = 20; // USDT
        let estimatedPrice = params.price || 0;
        
        // 如果是市价单,需要获取当前市场价格来估算名义价值
        if (!estimatedPrice || estimatedPrice === 0) {
          try {
            const ticker = await this.getFuturesTicker(params.contract);
            estimatedPrice = parseFloat(ticker.last || '0');
          } catch (error) {
            logger.warn('获取市场价格失败,跳过名义价值检查:', error as Error);
          }
        }
        
        if (estimatedPrice > 0) {
          const notionalValue = quantity * estimatedPrice;
          if (notionalValue < MIN_NOTIONAL) {
            // 计算满足最小名义价值所需的数量
            const minRequiredQty = MIN_NOTIONAL / estimatedPrice;
            // 考虑精度,向上调整
            const adjustedQty = Math.ceil(minRequiredQty * multiplier) / multiplier;
            
            logger.warn(`订单名义价值 ${notionalValue.toFixed(2)} USDT 小于最小要求 ${MIN_NOTIONAL} USDT`);
            logger.warn(`自动调整数量: ${quantity} -> ${adjustedQty} (价格: ${estimatedPrice})`);
            
            quantity = adjustedQty;
          }
        }
        
        logger.debug(`下单数量精度修正: 原始=${Math.abs(params.size).toFixed(8)} -> 修正=${quantity.toFixed(8)} (精度=${decimalPlaces}位, 最小量=${minQty})`);
      } catch (error) {
        logger.warn('获取合约精度失败，使用默认精度处理:', error as Error);
        // 使用默认精度（3位小数）
        quantity = Math.round(quantity * 1000) / 1000;
      }
      
      const data: any = {
        symbol,
        side: params.size > 0 ? 'BUY' : 'SELL',
        type: orderType,
        // 使用 toFixed 避免科学计数法，然后移除末尾的0
        quantity: parseFloat(quantity.toFixed(8)).toString()
      };

      if (params.price) {
        data.price = params.price.toString();
        data.timeInForce = params.tif || 'GTC';
      }

      if (params.reduceOnly) {
        data.reduceOnly = true;
      }

      const response = await this.privateRequest('/fapi/v1/order', data, 'POST', retries);
      
      logger.debug(`币安下单响应原始数据: ${JSON.stringify(response)}`);
      
      // 🔧 币安的市价单返回不包含实际成交价，需要查询成交记录获取
      let actualPrice = response.avgPrice || response.price || '0';
      
      logger.debug(`初始成交价: avgPrice=${response.avgPrice}, price=${response.price}, actualPrice=${actualPrice}`);
      
      if (orderType === 'MARKET' && (actualPrice === '0' || !actualPrice || parseFloat(actualPrice) === 0)) {
        // 等待订单成交
        await new Promise(resolve => setTimeout(resolve, 800));
        
        try {
          // 方法1: 查询订单详情获取实际成交价
          const orderDetail = await this.privateRequest('/fapi/v1/order', {
            symbol,
            orderId: response.orderId
          }, 'GET', 2);
          
          logger.debug(`订单详情: ${JSON.stringify(orderDetail)}`);
          actualPrice = orderDetail.avgPrice || actualPrice;
          
          // 方法2: 如果订单详情也没有价格，查询成交记录
          if (!actualPrice || parseFloat(actualPrice) === 0) {
            const trades = await this.privateRequest('/fapi/v1/userTrades', {
              symbol,
              orderId: response.orderId
            }, 'GET', 2);
            
            logger.debug(`成交记录数量: ${trades?.length || 0}`);
            
            if (trades && trades.length > 0) {
              // 使用最新成交记录的价格
              actualPrice = trades[trades.length - 1].price;
              logger.debug(`从成交记录获取价格: ${actualPrice}`);
            }
          }
          
          logger.info(`✅ 获取到订单成交价: ${actualPrice}`);
        } catch (error) {
          logger.warn(`获取订单成交价失败:`, error as Error);
          
          // 最后的兜底方案：使用当前市场价格
          try {
            const ticker = await this.getFuturesTicker(params.contract);
            actualPrice = ticker.last;
            logger.warn(`⚠️ 使用当前市场价格作为成交价: ${actualPrice}`);
          } catch (tickerError) {
            logger.error(`获取市场价格也失败，成交价将为0`, tickerError as Error);
          }
        }
      }
      
      const orderResponse = {
        id: response.orderId.toString(),
        contract: params.contract,
        size: params.size,
        price: actualPrice,
        status: response.status === 'FILLED' ? 'finished' : 
                response.status === 'NEW' ? 'open' : 
                response.status.toLowerCase(),
        create_time: response.updateTime,
        fill_price: actualPrice,
        left: (parseFloat(response.origQty || '0') - parseFloat(response.executedQty || '0')).toString()
      };
      
      // 缓存订单信息供后续查询使用
      this.orderCache.set(orderResponse.id, {
        contract: params.contract,
        orderInfo: orderResponse,
        timestamp: Date.now()
      });
      
      // 定期清理过期缓存
      this.cleanupCache();

      // 清除相关缓存（因为持仓和账户信息已改变）
      this.positionsCache = null;
      this.accountInfoCache = null;
      
      return orderResponse;
    } catch (error) {
      logger.error('下单失败:', error as Error);
      throw error;
    }
  }

  async getOrder(orderId: string): Promise<OrderResponse> {
    try {
      // 首先检查缓存
      const cached = this.orderCache.get(orderId);
      
      if (cached) {
        // 从缓存中获取 contract，使用 Binance API 查询最新状态
        const symbol = this.normalizeContract(cached.contract);
        try {
          const response = await this.privateRequest('/fapi/v1/order', {
            symbol,
            orderId
          }, 'GET', 2);
          
          const orderResponse = {
            id: response.orderId.toString(),
            contract: cached.contract,
            size: (response.side === 'BUY' ? 1 : -1) * parseFloat(response.origQty || '0'),
            price: response.price || '0',
            status: response.status === 'FILLED' ? 'finished' : 
                    response.status === 'NEW' ? 'open' : 
                    response.status === 'CANCELED' ? 'cancelled' :
                    response.status.toLowerCase(),
            create_time: response.time,
            fill_price: response.avgPrice || '0',
            left: (parseFloat(response.origQty || '0') - parseFloat(response.executedQty || '0')).toString()
          };
          
          // 更新缓存
          this.orderCache.set(orderId, {
            contract: cached.contract,
            orderInfo: orderResponse,
            timestamp: Date.now()
          });
          
          return orderResponse;
        } catch (apiError) {
          // 如果 API 查询失败，返回缓存的信息
          logger.warn(`API查询订单失败，使用缓存信息: ${apiError}`);
          return cached.orderInfo;
        }
      }
      
      // 如果缓存中没有，尝试从未成交订单中查找
      const openOrders = await this.getOpenOrders();
      const order = openOrders.find(o => o.id === orderId);
      
      if (order) {
        return order;
      }
      
      // 如果都找不到，返回一个基本的响应（避免中断交易流程）
      logger.warn(`订单 ${orderId} 未在缓存或未成交订单中找到，返回默认状态`);
      return {
        id: orderId,
        contract: 'UNKNOWN',
        size: 0,
        price: '0',
        status: 'finished', // 假设已成交
        create_time: Date.now(),
        fill_price: '0',
        left: '0'
      };
    } catch (error) {
      logger.error('获取订单失败:', error as Error);
      throw error;
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    // Binance 需要 symbol 参数，但接口定义只有 orderId
    // 这里我们尝试从缓存或未成交订单来查找 symbol
    try {
      // 先检查缓存
      const cached = this.orderCache.get(orderId);
      let symbol: string | undefined;
      
      if (cached) {
        symbol = this.normalizeContract(cached.contract);
      } else {
        // 从未成交订单中查找
        const openOrders = await this.getOpenOrders();
        const order = openOrders.find(o => o.id === orderId);
        
        if (order) {
          symbol = this.normalizeContract(order.contract);
        }
      }
      
      if (!symbol) {
        // 订单不存在或已完成，无需取消
        logger.debug(`订单 ${orderId} 未找到，可能已完成或不存在`);
        return;
      }
      
      await this.privateRequest('/fapi/v1/order', {
        symbol,
        orderId
      }, 'DELETE');
      
      // 清除相关缓存
      this.positionsCache = null;
      this.accountInfoCache = null;
      
      logger.debug(`已取消订单 ${orderId}`);
    } catch (error: any) {
      // 如果订单已经不存在，不应该抛出错误
      if (error.message?.includes('Unknown order') || 
          error.message?.includes('Order does not exist')) {
        logger.debug(`订单 ${orderId} 已不存在，无需取消`);
        return;
      }
      logger.error('取消订单失败:', error as Error);
      throw error;
    }
  }

  async getOpenOrders(contract?: string, retries: number = 2): Promise<OrderResponse[]> {
    try {
      const params: any = {};
      if (contract) {
        params.symbol = this.normalizeContract(contract);
      }
      
      const orders = await this.privateRequest('/fapi/v1/openOrders', params, 'GET', retries);
      
      return orders.map((order: any) => ({
        id: order.orderId.toString(),
        contract: order.symbol,
        size: (order.side === 'BUY' ? 1 : -1) * parseFloat(order.origQty || '0'),
        price: order.price || '0',
        status: 'open',
        create_time: order.time,
        fill_price: order.avgPrice || '0',
        left: (parseFloat(order.origQty || '0') - parseFloat(order.executedQty || '0')).toString()
      }));
    } catch (error) {
      logger.error('获取未成交订单失败:', error as Error);
      throw error;
    }
  }

  async setLeverage(contract: string, leverage: number, retries: number = 2): Promise<void> {
    try {
      const symbol = this.normalizeContract(contract);
      await this.privateRequest('/fapi/v1/leverage', {
        symbol,
        leverage
      }, 'POST', retries);
      logger.info(`已设置 ${contract} 杠杆为 ${leverage}x`);
    } catch (error) {
      logger.error(`设置杠杆失败:`, error as Error);
      throw error;
    }
  }

  async getContractInfo(contract: string, retries: number = 2): Promise<ContractInfo> {
    // 先检查缓存
    if (this.contractInfoCache.has(contract)) {
      return this.contractInfoCache.get(contract)!;
    }
    
    try {
      const symbol = this.normalizeContract(contract);
      const response = await this.publicRequest('/fapi/v1/exchangeInfo', {}, retries);
      const symbolInfo = response.symbols.find((s: any) => s.symbol === symbol);
      
      if (!symbolInfo) {
        throw new Error(`Contract ${contract} not found`);
      }

      const lotSizeFilter = symbolInfo.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
      const priceFilter = symbolInfo.filters?.find((f: any) => f.filterType === 'PRICE_FILTER');
      
      const contractInfo: ContractInfo = {
        name: symbolInfo.symbol,
        quantoMultiplier: '1',
        orderSizeMin: parseFloat(lotSizeFilter?.minQty || '0.001'),
        orderSizeMax: parseFloat(lotSizeFilter?.maxQty || '1000000'),
        orderPriceDeviate: '0.05',
        orderPriceRound: priceFilter?.tickSize || '0.01',
        markPriceRound: priceFilter?.tickSize || '0.01',
        type: 'direct',
        leverage_min: '1',
        leverage_max: '125',
        maintenance_rate: '0.004',
        mark_type: 'index',
        mark_price: '0',
        index_price: '0',
        last_price: '0',
        maker_fee_rate: symbolInfo.maker || '0.0002',
        taker_fee_rate: symbolInfo.taker || '0.0004',
        funding_rate: '0',
        funding_interval: 28800,
        funding_next_apply: Date.now() + 28800000,
        risk_limit_base: '1000000',
        risk_limit_step: '500000',
        risk_limit_max: '8000000',
        ref_discount_rate: '0',
        ref_rebate_rate: '0.15',
        orderbook_id: Date.now(),
        trade_id: Date.now(),
        trade_size: 0,
        position_size: 0,
        config_change_time: Date.now(),
        in_delisting: false,
        orders_limit: 200,
      };
      
      // 缓存合约信息
      this.contractInfoCache.set(contract, contractInfo);
      
      return contractInfo;
    } catch (error) {
      logger.error(`获取合约信息失败:`, error as Error);
      throw error;
    }
  }

  async getOrderBook(contract: string, limit: number = 100, retries: number = 2): Promise<any> {
    try {
      const symbol = this.normalizeContract(contract);
      const response = await this.publicRequest('/fapi/v1/depth', {
        symbol,
        limit
      }, retries);
      
      // 将 Binance 的格式 [["价格", "数量"]] 转换为 Gate.io 的格式 [{p: "价格", s: "数量"}]
      // 以保持接口一致性
      return {
        bids: response.bids.map((bid: any[]) => ({
          p: bid[0].toString(),
          s: bid[1].toString()
        })),
        asks: response.asks.map((ask: any[]) => ({
          p: ask[0].toString(),
          s: ask[1].toString()
        }))
      };
    } catch (error) {
      logger.error('获取订单簿失败:', error as Error);
      throw error;
    }
  }

  async getMyTrades(contract?: string, limit: number = 100, startTime?: number, retries: number = 2): Promise<TradeRecord[]> {
    try {
      const params: any = { limit };
      if (contract) {
        params.symbol = this.normalizeContract(contract);
      }
      
      // 🔧 关键修复：币安默认返回最早的记录，必须指定起始时间
      // 如果传入startTime则使用，否则查询最近7天的交易（币安API限制）
      if (startTime) {
        params.startTime = startTime;
      } else {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        params.startTime = sevenDaysAgo;
      }
      
      const trades = await this.privateRequest('/fapi/v1/userTrades', params, 'GET', retries);
      
      return trades.map((trade: any) => ({
        id: trade.id.toString(),
        contract: trade.symbol,
        create_time: trade.time,
        order_id: trade.orderId.toString(),
        size: (trade.side === 'BUY' ? 1 : -1) * parseFloat(trade.qty),
        price: trade.price,
        role: trade.maker ? 'maker' : 'taker',
        fee: trade.commission || '0',
        timestamp: trade.time,
      }));
    } catch (error) {
      logger.error('获取成交记录失败:', error as Error);
      throw error;
    }
  }

  async getFundingRate(contract: string, retries: number = 2): Promise<any> {
    try {
      const symbol = this.normalizeContract(contract);
      const response = await this.publicRequest('/fapi/v1/premiumIndex', { symbol }, retries);
      
      return {
        funding_rate: response.lastFundingRate,
        next_funding_time: response.nextFundingTime
      };
    } catch (error) {
      logger.error('获取资金费率失败:', error as Error);
      throw error;
    }
  }

  async getAllContracts(): Promise<any[]> {
    try {
      const response = await this.publicRequest('/fapi/v1/exchangeInfo');
      return response.symbols.filter((s: any) => 
        s.status === 'TRADING' && 
        s.contractType === 'PERPETUAL' &&
        s.quoteAsset === 'USDT'
      );
    } catch (error) {
      logger.error('获取所有合约失败:', error as Error);
      throw error;
    }
  }

  async getPositionHistory(contract?: string, limit?: number, offset?: number): Promise<any[]> {
    // Binance doesn't have a direct position history endpoint, return empty array
    return [];
  }

  async getSettlementHistory(contract?: string, limit?: number, offset?: number): Promise<any[]> {
    // Binance doesn't have a direct settlement history endpoint, return empty array
    return [];
  }

  async getOrderHistory(contract?: string, limit?: number): Promise<any[]> {
    try {
      const params: any = {};
      if (contract) {
        params.symbol = this.normalizeContract(contract);
      }
      if (limit) {
        params.limit = limit;
      }
      return await this.privateRequest('/fapi/v1/allOrders', params);
    } catch (error) {
      logger.error('获取订单历史失败:', error as Error);
      throw error;
    }
  }

  getContractType(contract?: string): 'inverse' | 'linear' {
    return 'linear'; // Binance USDT 永续合约是正向合约（USDT 本位）
  }

  async cancelAllOrders(contract?: string): Promise<any> {
    try {
      const params: any = {};
      if (contract) {
        params.symbol = this.normalizeContract(contract);
      }
      return await this.privateRequest('/fapi/v1/allOpenOrders', params, 'DELETE');
    } catch (error) {
      logger.error('取消所有订单失败:', error as Error);
      throw error;
    }
  }

  async calculateQuantity(
    amountUsdt: number,
    price: number,
    leverage: number,
    contract: string
  ): Promise<number> {
    // Binance 使用币种数量（币本位）
    // 计算公式：数量 = (保证金金额 * 杠杆) / 价格
    const quantity = (amountUsdt * leverage) / price;
    
    // 获取合约信息以确定精度
    try {
      const contractInfo = await this.getContractInfo(contract);
      const minQty = contractInfo.orderSizeMin;
      
      // 🔧 精度修复：根据 minQty 确定小数位数
      // minQty=0.001 -> 3位, 0.01 -> 2位, 0.1 -> 1位, 1 -> 0位
      const decimalPlaces = minQty >= 1 ? 0 : Math.abs(Math.floor(Math.log10(minQty)));
      const multiplier = Math.pow(10, decimalPlaces);
      
      // 🔧 向下取整到指定精度，避免浮点数精度问题
      // 注意：这里使用floor是合理的，确保不超出用户资金
      let roundedQuantity = Math.floor(quantity * multiplier) / multiplier;
      
      // 🔧 修复：如果取整后为0，则使用最小值
      if (roundedQuantity < minQty) {
        logger.warn(`计算数量 ${roundedQuantity} 小于最小下单量 ${minQty}，调整为最小值`);
        roundedQuantity = minQty;
      }
      
      logger.debug(`精度修正: 原始=${quantity.toFixed(8)} -> 取整=${roundedQuantity.toFixed(8)} (minQty=${minQty}, 精度=${decimalPlaces}位)`);
      
      return roundedQuantity;
    } catch (error) {
      logger.warn('获取合约信息失败，使用默认精度:', error as Error);
      // 使用默认精度（3位小数）
      return Math.floor(quantity * 1000) / 1000;
    }
  }

  async calculatePnl(
    entryPrice: number,
    exitPrice: number,
    quantity: number,
    side: 'long' | 'short',
    contract: string
  ): Promise<number> {
    // Binance USDT 永续合约 PNL 计算（正向合约）
    // 多头：PNL = 数量 * (平仓价 - 开仓价)
    // 空头：PNL = 数量 * (开仓价 - 平仓价)
    
    if (side === 'long') {
      return quantity * (exitPrice - entryPrice);
    } else {
      return quantity * (entryPrice - exitPrice);
    }
  }

  /**
   * 根据合约的价格步长格式化价格
   * @param contract 合约名称
   * @param price 原始价格
   * @returns 格式化后符合交易所要求的价格字符串
   */
  private async formatPriceByTickSize(contract: string, price: number): Promise<string> {
    try {
      const contractInfo = await this.getContractInfo(contract);
      const tickSize = parseFloat(contractInfo.orderPriceRound || "0.01");
      
      // 将价格调整为tickSize的整数倍
      const roundedPrice = Math.round(price / tickSize) * tickSize;
      
      // 确定小数位数
      const decimals = tickSize.toString().split('.')[1]?.length || 0;
      
      return roundedPrice.toFixed(decimals);
    } catch (error) {
      logger.error(`格式化价格失败，使用默认精度: ${error}`);
      // 如果获取合约信息失败，使用默认精度
      return price.toFixed(2);
    }
  }

  /**
   * 设置持仓的止损止盈价格
   * Binance 使用独立的条件单（STOP_MARKET/TAKE_PROFIT_MARKET）
   */
  async setPositionStopLoss(
    contract: string,
    stopLoss?: number,
    takeProfit?: number
  ): Promise<{
    success: boolean;
    stopLossOrderId?: string;
    takeProfitOrderId?: string;
    actualStopLoss?: number;
    actualTakeProfit?: number;
    message?: string;
  }> {
    try {
      const symbol = this.normalizeContract(contract);
      
      // 获取当前持仓
      const positions = await this.getPositions();
      const position = positions.find(p => p.contract === contract);
      
      if (!position || Math.abs(parseFloat(position.size)) === 0) {
        return {
          success: false,
          message: `未找到 ${contract} 的持仓`
        };
      }

      const posSize = parseFloat(position.size);
      const quantity = Math.abs(posSize);
      const positionSide = posSize > 0 ? 'LONG' : 'SHORT';

      // 提取币种符号（如 BTCUSDT -> BTC）
      const symbolName = this.extractSymbol(contract);

      // 先取消现有的止损止盈订单
      await this.cancelPositionStopLoss(contract);

      let stopLossOrderId: string | undefined;
      let takeProfitOrderId: string | undefined;
      let actualStopLoss: number | undefined = stopLoss;
      let actualTakeProfit: number | undefined = takeProfit;

      // 创建止损订单（STOP_MARKET）
      if (stopLoss !== undefined && stopLoss > 0) {
        // 在 try 块外部定义变量，确保在 catch 块中也能访问
        let currentPrice = 0;
        let formattedStopLoss = '';
        let stopLossData: any = null;
        
        try {
          // 获取当前价格用于验证
          const ticker = await this.getFuturesTicker(contract);
          currentPrice = parseFloat(ticker.markPrice || ticker.last || "0");
          
          if (currentPrice <= 0) {
            throw new Error(`无法获取 ${contract} 的当前价格`);
          }
          
          // 验证止损价格的合理性 - 确保止损在正确的方向
          // 多单止损必须低于当前价，空单止损必须高于当前价
          const side = posSize > 0 ? 'long' : 'short';
          const isInvalidStopLoss = (side === 'long' && stopLoss >= currentPrice) || 
                                    (side === 'short' && stopLoss <= currentPrice);
          
          if (isInvalidStopLoss) {
            // 🔧 修复：价格已突破止损位，调整止损价到当前价附近（留0.1%缓冲）
            const buffer = 0.001; // 0.1%缓冲
            const adjustedStopLoss = side === 'long' 
              ? currentPrice * (1 - buffer)  // 多单：略低于当前价
              : currentPrice * (1 + buffer); // 空单：略高于当前价
            
            logger.warn(`⚠️ ${contract} 价格已突破止损位: 原止损=${stopLoss.toFixed(6)}, 当前价=${currentPrice.toFixed(6)}`);
            logger.info(`🔧 自动调整止损价: ${stopLoss.toFixed(6)} → ${adjustedStopLoss.toFixed(6)} (${side}单，缓冲${(buffer*100).toFixed(1)}%)`);
            
            // 使用调整后的止损价
            stopLoss = adjustedStopLoss;
          }
          
          // 检查止损距离是否合理（至少0.05%的距离，放宽要求）
          const priceDeviation = Math.abs(stopLoss - currentPrice) / currentPrice;
          const minSafeDistance = 0.0005; // 最小0.05%的安全距离（从0.3%放宽）
          
          if (priceDeviation < minSafeDistance) {
            logger.warn(`⚠️ ${contract} 止损价格 ${stopLoss.toFixed(6)} 距离当前价 ${currentPrice.toFixed(6)} 太近(${(priceDeviation * 100).toFixed(2)}%)，可能立即触发`);
          }
          
          formattedStopLoss = await this.formatPriceByTickSize(contract, stopLoss);
          stopLossData = {
            symbol,
            side: posSize > 0 ? 'SELL' : 'BUY', // 平仓方向相反
            type: 'STOP_MARKET',
            stopPrice: formattedStopLoss,
            closePosition: 'true', // 平掉整个仓位
            workingType: 'MARK_PRICE', // 使用标记价格触发（避免插针）
            priceProtect: 'TRUE' // 启用价格保护
          };

          const response = await this.privateRequest('/fapi/v1/order', stopLossData, 'POST', 2);
          stopLossOrderId = response.orderId?.toString();
          
          logger.info(`✅ ${contract} 止损单已创建: ID=${stopLossOrderId}, 触发价=${formattedStopLoss}, 当前价=${currentPrice.toFixed(6)}`);
        } catch (error: any) {
          const errorMsg = error.message || String(error);
          const errorCode = error.code;
          
          logger.error(`❌ 创建止损单失败: ${errorMsg}`, { 
            contract, 
            stopLoss: formattedStopLoss,
            currentPrice: currentPrice.toFixed(6),
            errorCode 
          });
          
          // 检查是否是超时错误
          const isTimeoutError = errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT') || 
                                 errorMsg.includes('ECONNRESET') || errorCode === 'ETIMEDOUT' ||
                                 errorCode === 'ECONNRESET';
          
          if (isTimeoutError) {
            logger.warn(`⚠️ 网络超时，等待3秒后重试...`);
            
            try {
              // 等待3秒，给网络更多恢复时间
              await new Promise(resolve => setTimeout(resolve, 3000));
              
              logger.info(`🔄 重试创建止损单 (网络超时): 触发价=${formattedStopLoss}`);
              
              const retryResponse = await this.privateRequest('/fapi/v1/order', stopLossData, 'POST', 2);
              stopLossOrderId = retryResponse.orderId?.toString();
              
              logger.info(`✅ ${contract} 止损单创建成功(超时重试): ID=${stopLossOrderId}, 触发价=${formattedStopLoss}`);
            } catch (retryError: any) {
              logger.error(`❌ 创建止损单重试仍然失败: ${retryError.message}`);
              
              // 超时错误不影响持仓，只是条件单未创建
              logger.warn(`⚠️ ${contract} 止损单创建失败但持仓已存在，请手动设置止损或稍后系统会自动重试`);
              return {
                success: false,
                message: `创建止损单超时，请手动设置或等待自动重试: ${retryError.message}`
              };
            }
          } else {
            return {
              success: false,
              message: `创建止损单失败: ${errorMsg}`
            };
          }
        }
      }

      // 创建止盈订单（TAKE_PROFIT_MARKET）
      if (takeProfit !== undefined && takeProfit > 0) {
        // 在 try 块外部定义变量，确保在 catch 块中也能访问
        let currentPrice = 0;
        let formattedTakeProfit = '';
        let takeProfitData: any = null;
        
        try {
          // 获取当前价格用于验证
          const ticker = await this.getFuturesTicker(contract);
          currentPrice = parseFloat(ticker.markPrice || ticker.last || "0");
          
          if (currentPrice <= 0) {
            throw new Error(`无法获取 ${contract} 的当前价格`);
          }
          
          // 验证止盈价格的合理性 - 确保止盈在正确的方向
          // 多单止盈必须高于当前价，空单止盈必须低于当前价
          const side = posSize > 0 ? 'long' : 'short';
          const isInvalidTakeProfit = (side === 'long' && takeProfit <= currentPrice) || 
                                      (side === 'short' && takeProfit >= currentPrice);
          
          if (isInvalidTakeProfit) {
            // 🔧 修复：价格已突破止盈位，调整止盈价到当前价附近（留0.1%缓冲）
            const buffer = 0.001; // 0.1%缓冲
            const adjustedTakeProfit = side === 'long' 
              ? currentPrice * (1 + buffer)  // 多单：略高于当前价
              : currentPrice * (1 - buffer); // 空单：略低于当前价
            
            logger.warn(`⚠️ ${contract} 价格已突破止盈位: 原止盈=${takeProfit.toFixed(6)}, 当前价=${currentPrice.toFixed(6)}`);
            logger.info(`🔧 自动调整止盈价: ${takeProfit.toFixed(6)} → ${adjustedTakeProfit.toFixed(6)} (${side}单，缓冲${(buffer*100).toFixed(1)}%)`);
            
            // 使用调整后的止盈价
            takeProfit = adjustedTakeProfit;
          }
          
          // 检查止盈距离是否合理（至少0.05%的距离）
          const priceDeviation = Math.abs(takeProfit - currentPrice) / currentPrice;
          const minSafeDistance = 0.0005;
          
          if (priceDeviation < minSafeDistance) {
            logger.warn(`⚠️ ${contract} 止盈价格 ${takeProfit.toFixed(6)} 距离当前价 ${currentPrice.toFixed(6)} 太近(${(priceDeviation * 100).toFixed(2)}%)，可能立即触发`);
          }
          
          formattedTakeProfit = await this.formatPriceByTickSize(contract, takeProfit);
          takeProfitData = {
            symbol,
            side: posSize > 0 ? 'SELL' : 'BUY', // 平仓方向相反
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: formattedTakeProfit,
            closePosition: 'true', // 平掉整个仓位
            workingType: 'MARK_PRICE', // 使用标记价格触发
            priceProtect: 'TRUE' // 启用价格保护
          };

          const response = await this.privateRequest('/fapi/v1/order', takeProfitData, 'POST', 2);
          takeProfitOrderId = response.orderId?.toString();
          
          logger.info(`✅ ${contract} 止盈单已创建: ID=${takeProfitOrderId}, 触发价=${formattedTakeProfit}, 当前价=${currentPrice.toFixed(6)}`);
        } catch (error: any) {
          const errorMsg = error.message || String(error);
          const errorCode = error.code;
          
          logger.error(`❌ 创建止盈单失败: ${errorMsg}`, { 
            contract, 
            takeProfit: formattedTakeProfit,
            currentPrice: currentPrice > 0 ? currentPrice.toFixed(6) : 'N/A',
            errorCode 
          });
          
          // 检查是否是超时错误
          const isTimeoutError = errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT') || 
                                 errorMsg.includes('ECONNRESET') || errorCode === 'ETIMEDOUT' ||
                                 errorCode === 'ECONNRESET';
          
          if (isTimeoutError && takeProfitData) {
            logger.warn(`⚠️ 网络超时，等待3秒后重试...`);
            
            try {
              // 等待3秒，给网络更多恢复时间
              await new Promise(resolve => setTimeout(resolve, 3000));
              
              logger.info(`🔄 重试创建止盈单 (网络超时): 触发价=${formattedTakeProfit}`);
              
              const retryResponse = await this.privateRequest('/fapi/v1/order', takeProfitData, 'POST', 2);
              takeProfitOrderId = retryResponse.orderId?.toString();
              
              logger.info(`✅ ${contract} 止盈单创建成功(超时重试): ID=${takeProfitOrderId}, 触发价=${formattedTakeProfit}`);
            } catch (retryError: any) {
              logger.error(`❌ 创建止盈单重试仍然失败: ${retryError.message}`);
              // 如果止盈单失败但止损单成功，仍返回成功（止损更重要）
              if (stopLossOrderId) {
                return {
                  success: true,
                  stopLossOrderId,
                  message: `止损单已创建，止盈单创建超时: ${retryError.message}`
                };
              }
              return {
                success: false,
                message: `创建止盈单超时: ${retryError.message}`
              };
            }
          } else {
            // 如果止盈单失败但止损单成功，仍返回成功（止损更重要）
            if (stopLossOrderId) {
              return {
                success: true,
                stopLossOrderId,
                message: `止损单已创建，止盈单创建失败: ${errorMsg}`
              };
            }
            return {
              success: false,
              message: `创建止盈单失败: ${errorMsg}`
            };
          }
        }
      }

      return {
        success: true,
        stopLossOrderId,
        takeProfitOrderId,
        actualStopLoss: stopLoss, // 返回实际使用的止损价格
        actualTakeProfit: takeProfit, // 返回实际使用的止盈价格
        message: `止损止盈已设置${stopLoss ? ` 止损=${stopLoss}` : ''}${takeProfit ? ` 止盈=${takeProfit}` : ''}`
      };

    } catch (error: any) {
      logger.error(`设置止损止盈失败: ${error.message}`);
      return {
        success: false,
        message: `设置失败: ${error.message}`
      };
    }
  }

  /**
   * 取消持仓的止损止盈订单
   */
  async cancelPositionStopLoss(contract: string): Promise<{
    success: boolean;
    message?: string;
  }> {
    try {
      const symbol = this.normalizeContract(contract);
      
      // 获取所有未成交订单
      const response = await this.privateRequest('/fapi/v1/openOrders', { symbol }, 'GET', 2);
      const orders = response || [];
      
      // 筛选出止损止盈订单
      const stopOrders = orders.filter((order: any) => 
        order.type === 'STOP_MARKET' || 
        order.type === 'TAKE_PROFIT_MARKET' ||
        order.type === 'STOP' ||
        order.type === 'TAKE_PROFIT'
      );

      if (stopOrders.length === 0) {
        return {
          success: true,
          message: `${contract} 没有活跃的止损止盈订单`
        };
      }

      // 取消所有止损止盈订单
      for (const order of stopOrders) {
        try {
          await this.privateRequest('/fapi/v1/order', {
            symbol,
            orderId: order.orderId
          }, 'DELETE', 2);
          logger.info(`已取消订单: ${order.orderId} (${order.type})`);
        } catch (error: any) {
          logger.warn(`取消订单失败: ${order.orderId}, ${error.message}`);
        }
      }
      
      logger.info(`✅ 已取消 ${contract} 的 ${stopOrders.length} 个止损止盈订单`);
      return {
        success: true,
        message: `已取消 ${contract} 的 ${stopOrders.length} 个止损止盈订单`
      };
    } catch (error: any) {
      logger.error(`取消止损止盈订单失败: ${error.message}`);
      return {
        success: false,
        message: `取消失败: ${error.message}`
      };
    }
  }

  /**
   * 获取持仓的止损止盈订单状态
   */
  async getPositionStopLossOrders(contract: string): Promise<{
    stopLossOrder?: any;
    takeProfitOrder?: any;
  }> {
    try {
      const symbol = this.normalizeContract(contract);
      
      // 获取所有未成交订单
      const response = await this.privateRequest('/fapi/v1/openOrders', { symbol }, 'GET', 2);
      const orders = response || [];
      
      let stopLossOrder: any;
      let takeProfitOrder: any;

      for (const order of orders) {
        if (order.type === 'STOP_MARKET' || order.type === 'STOP') {
          stopLossOrder = {
            id: order.orderId?.toString(),
            contract: contract,
            type: order.type,
            side: order.side,
            stopPrice: order.stopPrice,
            quantity: order.origQty,
            status: order.status,
            workingType: order.workingType
          };
        } else if (order.type === 'TAKE_PROFIT_MARKET' || order.type === 'TAKE_PROFIT') {
          takeProfitOrder = {
            id: order.orderId?.toString(),
            contract: contract,
            type: order.type,
            side: order.side,
            stopPrice: order.stopPrice,
            quantity: order.origQty,
            status: order.status,
            workingType: order.workingType
          };
        }
      }

      return {
        stopLossOrder,
        takeProfitOrder
      };
    } catch (error: any) {
      // 如果没有订单或查询失败,这是正常情况,使用debug级别
      logger.debug(`${contract} 暂无止损止盈订单或查询失败: ${error.message}`);
      return {
        stopLossOrder: undefined,
        takeProfitOrder: undefined
      };
    }
  }

  /**
   * 获取条件单列表（Binance实现）
   * @param contract 合约名称（可选）
   * @param status 状态过滤（Binance不支持，忽略此参数）
   */
  async getPriceOrders(contract?: string, status?: string): Promise<any[]> {
    const params: any = {};
    if (contract) {
      params.symbol = this.normalizeContract(contract);
    }
    
    // Binance获取所有未成交订单（包含条件单）
    const response = await this.privateRequest('/fapi/v1/openOrders', params, 'GET', 2);
    
    // 过滤出条件单（止损止盈订单）
    const orders = (response || []).filter((order: any) => {
      return order.type === 'STOP_MARKET' || 
             order.type === 'STOP' || 
             order.type === 'TAKE_PROFIT_MARKET' || 
             order.type === 'TAKE_PROFIT';
    });
    
    return orders;
  }
}