/**
 * Production Error Boundary System
 * 
 * Provides comprehensive error handling, recovery strategies,
 * and monitoring for production deployments.
 */

import { EventEmitter } from 'events'

export interface ErrorContext {
  component: string
  operation: string
  userId?: string
  projectId?: string
  timestamp: Date
  environment: 'development' | 'staging' | 'production'
  metadata?: Record<string, any>
}

export interface ErrorRecoveryStrategy {
  type: 'retry' | 'fallback' | 'degrade' | 'fail_fast'
  maxAttempts?: number
  backoffMs?: number
  fallbackHandler?: () => Promise<any>
  degradedHandler?: () => Promise<any>
}

export interface ErrorReport {
  id: string
  error: Error
  context: ErrorContext
  stackTrace: string
  recoveryAttempted: boolean
  recoverySuccess: boolean
  userImpact: 'none' | 'minor' | 'major' | 'critical'
  reportedAt: Date
}

export class AgentErrorBoundary extends EventEmitter {
  private errors: Map<string, ErrorReport> = new Map()
  private recoveryStrategies: Map<string, ErrorRecoveryStrategy> = new Map()
  private circuitBreakers: Map<string, CircuitBreaker> = new Map()

  constructor(private config: {
    enableTelemetry?: boolean
    enableRecovery?: boolean
    maxErrorHistory?: number
    telemetryEndpoint?: string
    alertThresholds?: {
      errorRate: number
      responseTime: number
    }
  } = {}) {
    super()
    this.setupDefaultStrategies()
  }

  private setupDefaultStrategies() {
    // Network operation recovery
    this.setRecoveryStrategy('network_operation', {
      type: 'retry',
      maxAttempts: 3,
      backoffMs: 1000
    })

    // LLM API call recovery
    this.setRecoveryStrategy('llm_api_call', {
      type: 'retry',
      maxAttempts: 2,
      backoffMs: 2000,
      fallbackHandler: async () => ({
        content: 'I apologize, but I\'m experiencing technical difficulties. Please try again.',
        fallback: true
      })
    })

    // Database operation recovery
    this.setRecoveryStrategy('database_operation', {
      type: 'retry',
      maxAttempts: 3,
      backoffMs: 500,
      degradedHandler: async () => {
        console.warn('Database degraded mode activated')
        return { degraded: true }
      }
    })

    // Task execution recovery
    this.setRecoveryStrategy('task_execution', {
      type: 'fallback',
      maxAttempts: 1,
      fallbackHandler: async () => ({
        status: 'partial_completion',
        message: 'Task completed with limited functionality'
      })
    })
  }

  /**
   * Main error handling wrapper
   */
  async withErrorBoundary<T>(
    operation: () => Promise<T>,
    context: ErrorContext,
    strategyKey?: string
  ): Promise<T> {
    const operationId = `${context.component}_${context.operation}_${Date.now()}`
    
    try {
      // Check circuit breaker
      const breaker = this.circuitBreakers.get(context.component)
      if (breaker && breaker.isOpen()) {
        throw new Error(`Circuit breaker open for ${context.component}`)
      }

      const result = await operation()
      
      // Record success
      if (breaker) {
        breaker.recordSuccess()
      }
      
      return result
    } catch (error) {
      return this.handleError(error as Error, context, strategyKey, operation)
    }
  }

  /**
   * Handle errors with recovery strategies
   */
  private async handleError<T>(
    error: Error,
    context: ErrorContext,
    strategyKey?: string,
    originalOperation?: () => Promise<T>
  ): Promise<T> {
    const errorReport = this.createErrorReport(error, context)
    this.errors.set(errorReport.id, errorReport)

    // Update circuit breaker
    const breaker = this.getOrCreateCircuitBreaker(context.component)
    breaker.recordFailure()

    // Emit error event for monitoring
    this.emit('error', errorReport)

    // Send telemetry
    if (this.config.enableTelemetry) {
      await this.sendTelemetry(errorReport)
    }

    // Attempt recovery if enabled and strategy exists
    if (this.config.enableRecovery && strategyKey && originalOperation) {
      const strategy = this.recoveryStrategies.get(strategyKey)
      if (strategy) {
        try {
          const recoveredResult = await this.attemptRecovery(
            originalOperation,
            strategy,
            errorReport
          )
          errorReport.recoveryAttempted = true
          errorReport.recoverySuccess = true
          return recoveredResult
        } catch (recoveryError) {
          errorReport.recoveryAttempted = true
          errorReport.recoverySuccess = false
          // Fall through to throw original error
        }
      }
    }

    // Classify user impact
    errorReport.userImpact = this.classifyUserImpact(error, context)

    // Alert if critical
    if (errorReport.userImpact === 'critical') {
      this.emit('critical_error', errorReport)
    }

    throw error
  }

  /**
   * Attempt error recovery with backoff
   */
  private async attemptRecovery<T>(
    operation: () => Promise<T>,
    strategy: ErrorRecoveryStrategy,
    errorReport: ErrorReport,
    attempt: number = 1
  ): Promise<T> {
    if (attempt > (strategy.maxAttempts || 1)) {
      throw new Error(`Recovery failed after ${attempt - 1} attempts`)
    }

    // Apply backoff delay
    if (attempt > 1 && strategy.backoffMs) {
      const backoffTime = strategy.backoffMs * Math.pow(2, attempt - 2) // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, backoffTime))
    }

    try {
      switch (strategy.type) {
        case 'retry':
          return await operation()
        
        case 'fallback':
          if (strategy.fallbackHandler) {
            return await strategy.fallbackHandler()
          }
          throw new Error('Fallback handler not configured')
        
        case 'degrade':
          if (strategy.degradedHandler) {
            return await strategy.degradedHandler()
          }
          throw new Error('Degraded handler not configured')
        
        case 'fail_fast':
        default:
          throw errorReport.error
      }
    } catch (retryError) {
      return this.attemptRecovery(operation, strategy, errorReport, attempt + 1)
    }
  }

  /**
   * Set custom recovery strategy
   */
  setRecoveryStrategy(key: string, strategy: ErrorRecoveryStrategy) {
    this.recoveryStrategies.set(key, strategy)
  }

  /**
   * Create detailed error report
   */
  private createErrorReport(error: Error, context: ErrorContext): ErrorReport {
    return {
      id: `error_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      error,
      context,
      stackTrace: error.stack || '',
      recoveryAttempted: false,
      recoverySuccess: false,
      userImpact: 'none',
      reportedAt: new Date()
    }
  }

  /**
   * Classify user impact based on error and context
   */
  private classifyUserImpact(error: Error, context: ErrorContext): ErrorReport['userImpact'] {
    // Critical operations
    const criticalComponents = ['authentication', 'payment', 'data_loss']
    if (criticalComponents.some(comp => context.component.includes(comp))) {
      return 'critical'
    }

    // Major functionality
    const majorOperations = ['task_execution', 'code_generation', 'file_operations']
    if (majorOperations.some(op => context.operation.includes(op))) {
      return 'major'
    }

    // Network/timeout errors are usually minor
    if (error.message.includes('timeout') || error.message.includes('network')) {
      return 'minor'
    }

    // Default to minor for unknown errors
    return 'minor'
  }

  /**
   * Get or create circuit breaker
   */
  private getOrCreateCircuitBreaker(component: string): CircuitBreaker {
    if (!this.circuitBreakers.has(component)) {
      this.circuitBreakers.set(component, new CircuitBreaker({
        failureThreshold: 5,
        recoveryTimeout: 30000,
        monitoringPeriod: 60000
      }))
    }
    return this.circuitBreakers.get(component)!
  }

  /**
   * Send telemetry data
   */
  private async sendTelemetry(errorReport: ErrorReport) {
    if (!this.config.telemetryEndpoint) return

    try {
      await fetch(this.config.telemetryEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'error',
          timestamp: errorReport.reportedAt.toISOString(),
          component: errorReport.context.component,
          operation: errorReport.context.operation,
          error: {
            message: errorReport.error.message,
            name: errorReport.error.name,
            stack: errorReport.stackTrace
          },
          context: errorReport.context,
          userImpact: errorReport.userImpact,
          recoveryAttempted: errorReport.recoveryAttempted,
          recoverySuccess: errorReport.recoverySuccess
        })
      })
    } catch (telemetryError) {
      console.warn('Failed to send error telemetry:', telemetryError)
    }
  }

  /**
   * Get error statistics
   */
  getErrorStats() {
    const errorArray = Array.from(this.errors.values())
    const last24h = errorArray.filter(
      err => Date.now() - err.reportedAt.getTime() < 24 * 60 * 60 * 1000
    )

    return {
      totalErrors: this.errors.size,
      last24Hours: last24h.length,
      byComponent: this.groupBy(errorArray, 'context.component'),
      byUserImpact: this.groupBy(errorArray, 'userImpact'),
      recoverySuccessRate: errorArray.filter(e => e.recoveryAttempted).length > 0
        ? errorArray.filter(e => e.recoverySuccess).length / errorArray.filter(e => e.recoveryAttempted).length
        : 0
    }
  }

  private groupBy(array: ErrorReport[], key: string) {
    return array.reduce((groups: Record<string, number>, item) => {
      const value = this.getNestedProperty(item, key)
      groups[value] = (groups[value] || 0) + 1
      return groups
    }, {})
  }

  private getNestedProperty(obj: any, key: string) {
    return key.split('.').reduce((curr, prop) => curr?.[prop], obj)
  }

  /**
   * Clear old errors to prevent memory leaks
   */
  cleanup() {
    const maxHistory = this.config.maxErrorHistory || 1000
    if (this.errors.size > maxHistory) {
      const sortedErrors = Array.from(this.errors.entries())
        .sort(([, a], [, b]) => b.reportedAt.getTime() - a.reportedAt.getTime())
      
      // Keep only the most recent errors
      const toKeep = sortedErrors.slice(0, maxHistory)
      this.errors.clear()
      toKeep.forEach(([id, error]) => this.errors.set(id, error))
    }
  }
}

/**
 * Circuit Breaker Implementation
 */
class CircuitBreaker {
  private failures = 0
  private lastFailureTime = 0
  private state: 'closed' | 'open' | 'half_open' = 'closed'

  constructor(private config: {
    failureThreshold: number
    recoveryTimeout: number
    monitoringPeriod: number
  }) {}

  recordSuccess() {
    this.failures = 0
    this.state = 'closed'
  }

  recordFailure() {
    this.failures++
    this.lastFailureTime = Date.now()
    
    if (this.failures >= this.config.failureThreshold) {
      this.state = 'open'
    }
  }

  isOpen(): boolean {
    if (this.state === 'closed') return false
    
    if (this.state === 'open') {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime
      if (timeSinceLastFailure >= this.config.recoveryTimeout) {
        this.state = 'half_open'
        return false
      }
      return true
    }
    
    return false // half_open allows requests
  }

  getState() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime
    }
  }
}

// Global error boundary instance
export const globalErrorBoundary = new AgentErrorBoundary({
  enableTelemetry: process.env.NODE_ENV === 'production',
  enableRecovery: true,
  maxErrorHistory: 1000,
  telemetryEndpoint: process.env.CODMIR_TELEMETRY_ENDPOINT,
  alertThresholds: {
    errorRate: 0.05, // 5%
    responseTime: 10000 // 10 seconds
  }
})
