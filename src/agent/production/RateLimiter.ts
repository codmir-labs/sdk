/**
 * Production Rate Limiting System
 * 
 * Implements comprehensive rate limiting for API calls, task execution,
 * and resource usage to ensure system stability and fair usage.
 */

import { EventEmitter } from 'events'

export interface RateLimitConfig {
  identifier: string // User ID, API key, IP, etc.
  windowMs: number // Time window in milliseconds
  maxRequests: number // Max requests per window
  skipOnError?: boolean // Skip rate limiting on errors
  skipOnSuccess?: boolean // Skip rate limiting on successful requests
  keyGenerator?: (request: any) => string // Custom key generation
  onLimitReached?: (info: RateLimitInfo) => void
  storage?: RateLimitStorage // Custom storage backend
}

export interface RateLimitInfo {
  identifier: string
  limit: number
  current: number
  remaining: number
  resetTime: Date
  retryAfter: number // Seconds until next request allowed
}

export interface RateLimitStorage {
  get(key: string): Promise<{ count: number; resetTime: number } | null>
  set(key: string, value: { count: number; resetTime: number }, ttl: number): Promise<void>
  increment(key: string, ttl: number): Promise<{ count: number; resetTime: number }>
  delete(key: string): Promise<void>
  cleanup(): Promise<void>
}

export class AgentRateLimiter extends EventEmitter {
  private storage: RateLimitStorage
  private configs: Map<string, RateLimitConfig> = new Map()

  constructor(storage?: RateLimitStorage) {
    super()
    this.storage = storage || new MemoryStorage()
    this.setupCleanupInterval()
  }

  /**
   * Set rate limit configuration for a specific operation
   */
  setLimit(operation: string, config: Omit<RateLimitConfig, 'identifier'> & { identifier?: string }) {
    this.configs.set(operation, {
      identifier: config.identifier || 'default',
      ...config
    })
  }

  /**
   * Check if request is within rate limits
   */
  async checkLimit(operation: string, identifier?: string): Promise<RateLimitInfo> {
    const config = this.configs.get(operation)
    if (!config) {
      throw new Error(`No rate limit configuration found for operation: ${operation}`)
    }

    const effectiveIdentifier = identifier || config.identifier
    const key = `${operation}:${effectiveIdentifier}`

    // Get current count
    const current = await this.storage.get(key)
    const now = Date.now()
    
    // Calculate window reset time
    const windowStart = now - (now % config.windowMs)
    const resetTime = windowStart + config.windowMs

    // If no current record or window has reset
    if (!current || current.resetTime <= now) {
      const newRecord = { count: 1, resetTime }
      await this.storage.set(key, newRecord, config.windowMs)
      
      return {
        identifier: effectiveIdentifier,
        limit: config.maxRequests,
        current: 1,
        remaining: config.maxRequests - 1,
        resetTime: new Date(resetTime),
        retryAfter: 0
      }
    }

    // Increment counter
    const updated = await this.storage.increment(key, config.windowMs)
    const remaining = Math.max(0, config.maxRequests - updated.count)
    const retryAfter = remaining === 0 ? Math.ceil((resetTime - now) / 1000) : 0

    const limitInfo: RateLimitInfo = {
      identifier: effectiveIdentifier,
      limit: config.maxRequests,
      current: updated.count,
      remaining,
      resetTime: new Date(resetTime),
      retryAfter
    }

    // Check if limit exceeded
    if (updated.count > config.maxRequests) {
      this.emit('limitExceeded', { operation, ...limitInfo })
      
      if (config.onLimitReached) {
        config.onLimitReached(limitInfo)
      }
    }

    return limitInfo
  }

  /**
   * Enforce rate limit - throws error if exceeded
   */
  async enforceLimit(operation: string, identifier?: string): Promise<void> {
    const limitInfo = await this.checkLimit(operation, identifier)
    
    if (limitInfo.remaining === 0) {
      const error = new RateLimitExceededError(
        `Rate limit exceeded for ${operation}. Try again in ${limitInfo.retryAfter} seconds.`,
        limitInfo
      )
      throw error
    }
  }

  /**
   * Middleware for enforcing rate limits
   */
  middleware(operation: string) {
    return async (req: any, res: any, next: any) => {
      try {
        const config = this.configs.get(operation)
        const identifier = config?.keyGenerator 
          ? config.keyGenerator(req)
          : req.ip || req.user?.id || 'anonymous'

        const limitInfo = await this.checkLimit(operation, identifier)
        
        // Add rate limit headers
        if (res.set) {
          res.set({
            'X-RateLimit-Limit': limitInfo.limit.toString(),
            'X-RateLimit-Remaining': limitInfo.remaining.toString(),
            'X-RateLimit-Reset': limitInfo.resetTime.toISOString(),
            'X-RateLimit-RetryAfter': limitInfo.retryAfter.toString()
          })
        }

        if (limitInfo.remaining === 0) {
          const error = new RateLimitExceededError(
            'Rate limit exceeded',
            limitInfo
          )
          
          if (res.status) {
            return res.status(429).json({
              error: 'Too Many Requests',
              message: error.message,
              retryAfter: limitInfo.retryAfter
            })
          } else {
            throw error
          }
        }

        next()
      } catch (error) {
        next(error)
      }
    }
  }

  /**
   * Get current usage for identifier
   */
  async getUsage(operation: string, identifier: string): Promise<RateLimitInfo | null> {
    const config = this.configs.get(operation)
    if (!config) return null

    const key = `${operation}:${identifier}`
    const current = await this.storage.get(key)
    
    if (!current) return null

    const now = Date.now()
    const remaining = Math.max(0, config.maxRequests - current.count)
    const retryAfter = remaining === 0 ? Math.ceil((current.resetTime - now) / 1000) : 0

    return {
      identifier,
      limit: config.maxRequests,
      current: current.count,
      remaining,
      resetTime: new Date(current.resetTime),
      retryAfter: Math.max(0, retryAfter)
    }
  }

  /**
   * Reset rate limit for specific identifier
   */
  async resetLimit(operation: string, identifier: string): Promise<void> {
    const key = `${operation}:${identifier}`
    await this.storage.delete(key)
    
    this.emit('limitReset', { operation, identifier })
  }

  /**
   * Get usage statistics
   */
  async getStats(): Promise<{
    activeOperations: string[]
    totalRequests: number
    limitExceeded: number
  }> {
    return {
      activeOperations: Array.from(this.configs.keys()),
      totalRequests: 0, // Would be tracked by storage implementation
      limitExceeded: 0   // Would be tracked by event emissions
    }
  }

  private setupCleanupInterval() {
    setInterval(async () => {
      try {
        await this.storage.cleanup()
      } catch (error) {
        console.warn('Rate limiter cleanup failed:', error)
      }
    }, 60000) // Cleanup every minute
  }
}

/**
 * Memory-based storage implementation
 */
export class MemoryStorage implements RateLimitStorage {
  private store: Map<string, { count: number; resetTime: number }> = new Map()

  async get(key: string): Promise<{ count: number; resetTime: number } | null> {
    const value = this.store.get(key)
    
    // Clean up expired entries
    if (value && value.resetTime <= Date.now()) {
      this.store.delete(key)
      return null
    }
    
    return value || null
  }

  async set(key: string, value: { count: number; resetTime: number }): Promise<void> {
    this.store.set(key, value)
  }

  async increment(key: string, ttl: number): Promise<{ count: number; resetTime: number }> {
    const current = await this.get(key)
    const now = Date.now()
    
    if (!current) {
      const newValue = { count: 1, resetTime: now + ttl }
      this.store.set(key, newValue)
      return newValue
    }
    
    const updated = { ...current, count: current.count + 1 }
    this.store.set(key, updated)
    return updated
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }

  async cleanup(): Promise<void> {
    const now = Date.now()
    for (const [key, value] of this.store.entries()) {
      if (value.resetTime <= now) {
        this.store.delete(key)
      }
    }
  }
}

/**
 * Redis-based storage implementation
 */
export class RedisStorage implements RateLimitStorage {
  constructor(private redis: any) {} // Redis client

  async get(key: string): Promise<{ count: number; resetTime: number } | null> {
    const data = await this.redis.hgetall(`ratelimit:${key}`)
    
    if (!data.count) return null
    
    const result = {
      count: parseInt(data.count, 10),
      resetTime: parseInt(data.resetTime, 10)
    }
    
    // Check if expired
    if (result.resetTime <= Date.now()) {
      await this.delete(key)
      return null
    }
    
    return result
  }

  async set(key: string, value: { count: number; resetTime: number }, ttl: number): Promise<void> {
    const redisKey = `ratelimit:${key}`
    const pipeline = this.redis.multi()
    
    pipeline.hset(redisKey, 'count', value.count)
    pipeline.hset(redisKey, 'resetTime', value.resetTime)
    pipeline.pexpire(redisKey, ttl)
    
    await pipeline.exec()
  }

  async increment(key: string, ttl: number): Promise<{ count: number; resetTime: number }> {
    const redisKey = `ratelimit:${key}`
    const now = Date.now()
    
    // Use Lua script for atomic increment
    const luaScript = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local ttl = tonumber(ARGV[2])
      
      local current = redis.call('HGETALL', key)
      local count = 0
      local resetTime = now + ttl
      
      if #current > 0 then
        count = tonumber(current[2]) or 0
        resetTime = tonumber(current[4]) or (now + ttl)
        
        -- Check if expired
        if resetTime <= now then
          count = 0
          resetTime = now + ttl
        end
      end
      
      count = count + 1
      
      redis.call('HSET', key, 'count', count, 'resetTime', resetTime)
      redis.call('PEXPIRE', key, ttl)
      
      return {count, resetTime}
    `
    
    const result = await this.redis.eval(luaScript, 1, redisKey, now, ttl)
    
    return {
      count: result[0],
      resetTime: result[1]
    }
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(`ratelimit:${key}`)
  }

  async cleanup(): Promise<void> {
    // Redis handles TTL cleanup automatically
  }
}

/**
 * Rate limit exceeded error
 */
export class RateLimitExceededError extends Error {
  constructor(message: string, public limitInfo: RateLimitInfo) {
    super(message)
    this.name = 'RateLimitExceededError'
  }
}

/**
 * Pre-configured rate limiters for common operations
 */
export const rateLimiters = {
  // API calls
  api: new AgentRateLimiter(),
  
  // Task execution
  tasks: new AgentRateLimiter(),
  
  // LLM requests
  llm: new AgentRateLimiter(),
  
  // File operations
  files: new AgentRateLimiter()
}

// Configure default limits
rateLimiters.api.setLimit('chat_completion', {
  windowMs: 60000, // 1 minute
  maxRequests: 60 // 60 requests per minute
})

rateLimiters.api.setLimit('code_generation', {
  windowMs: 300000, // 5 minutes
  maxRequests: 20 // 20 generations per 5 minutes
})

rateLimiters.tasks.setLimit('task_submission', {
  windowMs: 300000, // 5 minutes
  maxRequests: 10 // 10 tasks per 5 minutes
})

rateLimiters.llm.setLimit('model_inference', {
  windowMs: 60000, // 1 minute
  maxRequests: 100 // 100 inferences per minute
})

rateLimiters.files.setLimit('file_upload', {
  windowMs: 60000, // 1 minute
  maxRequests: 30 // 30 uploads per minute
})

export { rateLimiters as default }
