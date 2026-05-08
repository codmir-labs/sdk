/**
 * Logging Integration for Overseer System
 * 
 * Connects the Overseer with existing logging infrastructure to monitor
 * logs in real-time and detect anomalies or issues.
 */

import { EventEmitter } from 'events'
import type { OverseerSystem, BusinessEvent } from '../OverseerSystem'

export class LoggingIntegration extends EventEmitter {
  private logBuffer: LogEntry[] = []
  private bufferSize = 1000
  private flushInterval: NodeJS.Timeout | null = null
  private patterns: LogPattern[] = []

  constructor(
    private overseer: OverseerSystem,
    private config: LoggingIntegrationConfig = {}
  ) {
    super()
    this.initializePatterns()
  }

  /**
   * Start monitoring logs
   */
  start(): void {
    // Set up flush interval
    this.flushInterval = setInterval(() => {
      this.flushBuffer()
    }, this.config.flushInterval || 5000)

    // Hook into existing logger
    this.setupLogInterception()
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval)
      this.flushInterval = null
    }
    this.flushBuffer()
  }

  /**
   * Process incoming log entry
   */
  async processLog(entry: LogEntry): Promise<void> {
    // Add to buffer
    this.logBuffer.push(entry)
    
    // Check for immediate issues
    if (this.isImmediateIssue(entry)) {
      await this.reportIssue(entry)
    }

    // Flush if buffer is full
    if (this.logBuffer.length >= this.bufferSize) {
      await this.flushBuffer()
    }
  }

  /**
   * Analyze buffered logs for patterns
   */
  private async flushBuffer(): Promise<void> {
    if (this.logBuffer.length === 0) return

    const logs = [...this.logBuffer]
    this.logBuffer = []

    // Analyze for patterns
    const analysis = await this.analyzeLogs(logs)
    
    // Report any detected issues
    for (const issue of analysis.issues) {
      await this.reportIssue(issue)
    }

    // Update metrics
    this.emit('logs_processed', {
      count: logs.length,
      issues: analysis.issues.length
    })
  }

  /**
   * Check if log entry indicates immediate issue
   */
  private isImmediateIssue(entry: LogEntry): boolean {
    // Critical errors need immediate attention
    if (entry.level === 'error' || entry.level === 'fatal') {
      return true
    }

    // Check for critical patterns
    for (const pattern of this.patterns) {
      if (pattern.severity === 'critical' && pattern.regex.test(entry.message)) {
        return true
      }
    }

    return false
  }

  /**
   * Analyze logs for patterns and anomalies
   */
  private async analyzeLogs(logs: LogEntry[]): Promise<LogAnalysis> {
    const issues: LogIssue[] = []
    const patterns: DetectedPattern[] = []

    // Group logs by level
    const errorLogs = logs.filter(l => l.level === 'error' || l.level === 'fatal')
    const warnLogs = logs.filter(l => l.level === 'warn')

    // Check error rate
    const errorRate = errorLogs.length / logs.length
    if (errorRate > (this.config.errorRateThreshold || 0.1)) {
      issues.push({
        type: 'high_error_rate',
        severity: 'high',
        description: `Error rate ${(errorRate * 100).toFixed(1)}% exceeds threshold`,
        logs: errorLogs,
        timestamp: new Date().toISOString()
      })
    }

    // Detect patterns
    for (const pattern of this.patterns) {
      const matches = logs.filter(log => pattern.regex.test(log.message))
      if (matches.length >= pattern.threshold) {
        patterns.push({
          pattern: pattern.name,
          count: matches.length,
          severity: pattern.severity,
          logs: matches
        })

        if (pattern.severity === 'high' || pattern.severity === 'critical') {
          issues.push({
            type: 'pattern_detected',
            severity: pattern.severity,
            description: `Pattern "${pattern.name}" detected ${matches.length} times`,
            logs: matches,
            timestamp: new Date().toISOString()
          })
        }
      }
    }

    // Detect error bursts
    const errorBursts = this.detectErrorBursts(errorLogs)
    for (const burst of errorBursts) {
      issues.push({
        type: 'error_burst',
        severity: 'high',
        description: `Error burst detected: ${burst.count} errors in ${burst.duration}ms`,
        logs: burst.logs,
        timestamp: burst.startTime
      })
    }

    return { issues, patterns, totalLogs: logs.length }
  }

  /**
   * Detect bursts of errors
   */
  private detectErrorBursts(errorLogs: LogEntry[]): ErrorBurst[] {
    const bursts: ErrorBurst[] = []
    const burstWindow = this.config.burstWindow || 60000 // 1 minute
    const burstThreshold = this.config.burstThreshold || 10

    // Sort by timestamp
    const sorted = [...errorLogs].sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    )

    let currentBurst: LogEntry[] = []
    let burstStart: string | null = null

    for (const log of sorted) {
      if (!burstStart) {
        burstStart = log.timestamp
        currentBurst = [log]
        continue
      }

      const timeDiff = new Date(log.timestamp).getTime() - new Date(burstStart).getTime()
      
      if (timeDiff <= burstWindow) {
        currentBurst.push(log)
      } else {
        // Check if it was a burst
        if (currentBurst.length >= burstThreshold) {
          bursts.push({
            count: currentBurst.length,
            duration: timeDiff,
            startTime: burstStart,
            logs: currentBurst
          })
        }
        
        // Start new potential burst
        burstStart = log.timestamp
        currentBurst = [log]
      }
    }

    // Check final burst
    if (currentBurst.length >= burstThreshold && burstStart) {
      const duration = new Date(currentBurst[currentBurst.length - 1].timestamp).getTime() - 
                      new Date(burstStart).getTime()
      bursts.push({
        count: currentBurst.length,
        duration,
        startTime: burstStart,
        logs: currentBurst
      })
    }

    return bursts
  }

  /**
   * Report issue to overseer
   */
  private async reportIssue(issue: LogEntry | LogIssue): Promise<void> {
    let event: BusinessEvent

    if ('level' in issue) {
      // Single log entry
      event = {
        id: `log-${Date.now()}`,
        type: 'log_error',
        source: 'logging_integration',
        data: {
          log: issue,
          context: this.extractContext(issue)
        },
        timestamp: issue.timestamp,
        severity: this.mapLogSeverity(issue.level)
      }
    } else {
      // Log issue
      event = {
        id: `log-issue-${Date.now()}`,
        type: 'log_issue',
        source: 'logging_integration',
        data: issue,
        timestamp: issue.timestamp,
        severity: issue.severity
      }
    }

    await this.overseer.processEvent(event)
  }

  /**
   * Extract context from log entry
   */
  private extractContext(entry: LogEntry): any {
    const context: any = {}

    // Extract common fields
    if (entry.metadata) {
      context.projectId = entry.metadata.projectId
      context.userId = entry.metadata.userId
      context.requestId = entry.metadata.requestId
      context.service = entry.metadata.service
    }

    // Extract error details
    if (entry.error) {
      context.errorType = entry.error.name
      context.errorMessage = entry.error.message
      context.stackTrace = entry.error.stack
    }

    return context
  }

  /**
   * Map log level to severity
   */
  private mapLogSeverity(level: LogLevel): 'low' | 'medium' | 'high' | 'critical' {
    switch (level) {
      case 'fatal':
        return 'critical'
      case 'error':
        return 'high'
      case 'warn':
        return 'medium'
      default:
        return 'low'
    }
  }

  /**
   * Initialize known error patterns
   */
  private initializePatterns(): void {
    this.patterns = [
      {
        name: 'Database Connection Error',
        regex: /database.*connection.*error|connection.*refused|ECONNREFUSED/i,
        threshold: 3,
        severity: 'critical'
      },
      {
        name: 'Out of Memory',
        regex: /out of memory|heap out of memory|ENOMEM/i,
        threshold: 1,
        severity: 'critical'
      },
      {
        name: 'Rate Limit',
        regex: /rate limit|too many requests|429/i,
        threshold: 5,
        severity: 'high'
      },
      {
        name: 'Authentication Failure',
        regex: /auth.*fail|unauthorized|401|forbidden|403/i,
        threshold: 10,
        severity: 'high'
      },
      {
        name: 'Timeout',
        regex: /timeout|timed out|ETIMEDOUT/i,
        threshold: 5,
        severity: 'medium'
      },
      {
        name: 'Null Reference',
        regex: /cannot read property.*of null|undefined is not/i,
        threshold: 5,
        severity: 'medium'
      }
    ]

    // Add custom patterns from config
    if (this.config.customPatterns) {
      this.patterns.push(...this.config.customPatterns)
    }
  }

  /**
   * Set up log interception
   */
  private setupLogInterception(): void {
    // This would hook into the actual logging system
    // For now, we'll provide a method that can be called
    this.emit('ready')
  }
}

// Interfaces
export interface LoggingIntegrationConfig {
  flushInterval?: number
  bufferSize?: number
  errorRateThreshold?: number
  burstWindow?: number
  burstThreshold?: number
  customPatterns?: LogPattern[]
}

export interface LogEntry {
  level: LogLevel
  message: string
  timestamp: string
  metadata?: Record<string, any>
  error?: {
    name: string
    message: string
    stack?: string
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface LogPattern {
  name: string
  regex: RegExp
  threshold: number
  severity: 'low' | 'medium' | 'high' | 'critical'
}

export interface LogAnalysis {
  issues: LogIssue[]
  patterns: DetectedPattern[]
  totalLogs: number
}

export interface LogIssue {
  type: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  description: string
  logs: LogEntry[]
  timestamp: string
}

export interface DetectedPattern {
  pattern: string
  count: number
  severity: 'low' | 'medium' | 'high' | 'critical'
  logs: LogEntry[]
}

export interface ErrorBurst {
  count: number
  duration: number
  startTime: string
  logs: LogEntry[]
}
