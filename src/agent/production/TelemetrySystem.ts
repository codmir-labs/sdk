/**
 * Production Telemetry System
 * 
 * Comprehensive monitoring, analytics, and observability for the Agent SDK
 * in production environments.
 */

import { EventEmitter } from 'events'

export interface TelemetryEvent {
  id: string
  type: 'metric' | 'event' | 'trace' | 'log'
  name: string
  timestamp: Date
  value?: number
  unit?: string
  tags?: Record<string, string>
  metadata?: Record<string, any>
  userId?: string
  projectId?: string
  sessionId?: string
}

export interface MetricPoint {
  name: string
  value: number
  timestamp: Date
  tags?: Record<string, string>
  unit?: string
}

export interface PerformanceTrace {
  id: string
  name: string
  startTime: Date
  endTime?: Date
  duration?: number
  status: 'running' | 'completed' | 'failed'
  spans: TraceSpan[]
  metadata?: Record<string, any>
}

export interface TraceSpan {
  id: string
  name: string
  startTime: Date
  endTime?: Date
  duration?: number
  parentId?: string
  tags?: Record<string, string>
  logs?: { timestamp: Date; message: string; level: string }[]
}

export interface TelemetryConfig {
  enableMetrics?: boolean
  enableTracing?: boolean
  enableLogs?: boolean
  sampleRate?: number // 0-1, fraction of events to capture
  batchSize?: number
  flushInterval?: number // milliseconds
  endpoints?: {
    metrics?: string
    traces?: string
    logs?: string
  }
  apiKey?: string
  environment?: string
  version?: string
}

export class AgentTelemetrySystem extends EventEmitter {
  private events: TelemetryEvent[] = []
  private metrics: Map<string, MetricPoint[]> = new Map()
  private traces: Map<string, PerformanceTrace> = new Map()
  private flushTimer?: NodeJS.Timeout
  private sessionId: string

  constructor(private config: TelemetryConfig = {}) {
    super()
    this.sessionId = this.generateSessionId()
    this.setupPeriodicFlush()
    this.trackSystemMetrics()
  }

  /**
   * Record a custom metric
   */
  recordMetric(name: string, value: number, unit?: string, tags?: Record<string, string>) {
    if (!this.config.enableMetrics) return

    const metric: MetricPoint = {
      name,
      value,
      timestamp: new Date(),
      unit,
      tags: { ...tags, sessionId: this.sessionId }
    }

    if (!this.metrics.has(name)) {
      this.metrics.set(name, [])
    }
    this.metrics.get(name)!.push(metric)

    // Also add as telemetry event
    this.addEvent({
      type: 'metric',
      name,
      value,
      unit,
      tags
    })

    this.emit('metric', metric)
  }

  /**
   * Increment a counter metric
   */
  incrementCounter(name: string, value: number = 1, tags?: Record<string, string>) {
    this.recordMetric(`${name}_total`, value, 'count', tags)
  }

  /**
   * Record a gauge metric (point-in-time value)
   */
  recordGauge(name: string, value: number, unit?: string, tags?: Record<string, string>) {
    this.recordMetric(name, value, unit, { ...tags, type: 'gauge' })
  }

  /**
   * Record a histogram metric (for timing, sizes, etc.)
   */
  recordHistogram(name: string, value: number, unit?: string, tags?: Record<string, string>) {
    this.recordMetric(name, value, unit, { ...tags, type: 'histogram' })
  }

  /**
   * Start a performance trace
   */
  startTrace(name: string, metadata?: Record<string, any>): PerformanceTrace {
    const trace: PerformanceTrace = {
      id: this.generateId(),
      name,
      startTime: new Date(),
      status: 'running',
      spans: [],
      metadata
    }

    this.traces.set(trace.id, trace)

    this.addEvent({
      type: 'trace',
      name: `${name}_started`,
      metadata: { traceId: trace.id, ...metadata }
    })

    return trace
  }

  /**
   * End a performance trace
   */
  endTrace(traceId: string, status: 'completed' | 'failed' = 'completed') {
    const trace = this.traces.get(traceId)
    if (!trace) return

    trace.endTime = new Date()
    trace.duration = trace.endTime.getTime() - trace.startTime.getTime()
    trace.status = status

    // Record duration metric
    this.recordHistogram('trace_duration_ms', trace.duration, 'milliseconds', {
      trace_name: trace.name,
      status
    })

    this.addEvent({
      type: 'trace',
      name: `${trace.name}_completed`,
      value: trace.duration,
      metadata: { traceId, status, duration: trace.duration }
    })

    this.emit('traceCompleted', trace)
  }

  /**
   * Add a span to a trace
   */
  addSpan(traceId: string, name: string, metadata?: Record<string, any>): string {
    const trace = this.traces.get(traceId)
    if (!trace) throw new Error(`Trace not found: ${traceId}`)

    const span: TraceSpan = {
      id: this.generateId(),
      name,
      startTime: new Date(),
      tags: metadata?.tags,
      logs: []
    }

    trace.spans.push(span)
    return span.id
  }

  /**
   * End a span
   */
  endSpan(traceId: string, spanId: string) {
    const trace = this.traces.get(traceId)
    if (!trace) return

    const span = trace.spans.find(s => s.id === spanId)
    if (!span) return

    span.endTime = new Date()
    span.duration = span.endTime.getTime() - span.startTime.getTime()
  }

  /**
   * Add log to a span
   */
  addSpanLog(traceId: string, spanId: string, message: string, level: string = 'info') {
    const trace = this.traces.get(traceId)
    if (!trace) return

    const span = trace.spans.find(s => s.id === spanId)
    if (!span) return

    span.logs = span.logs || []
    span.logs.push({
      timestamp: new Date(),
      message,
      level
    })
  }

  /**
   * Track operation with automatic tracing
   */
  async trackOperation<T>(
    name: string,
    operation: (trace: PerformanceTrace) => Promise<T>,
    metadata?: Record<string, any>
  ): Promise<T> {
    const trace = this.startTrace(name, metadata)
    
    try {
      const result = await operation(trace)
      this.endTrace(trace.id, 'completed')
      return result
    } catch (error) {
      this.endTrace(trace.id, 'failed')
      this.recordEvent('operation_failed', {
        operation: name,
        error: error instanceof Error ? error.message : String(error),
        traceId: trace.id
      })
      throw error
    }
  }

  /**
   * Record a custom event
   */
  recordEvent(name: string, metadata?: Record<string, any>, tags?: Record<string, string>) {
    this.addEvent({
      type: 'event',
      name,
      metadata,
      tags
    })
  }

  /**
   * Record a log entry
   */
  recordLog(level: string, message: string, metadata?: Record<string, any>) {
    if (!this.config.enableLogs) return

    this.addEvent({
      type: 'log',
      name: level,
      metadata: { message, level, ...metadata }
    })
  }

  /**
   * Track Agent SDK specific metrics
   */
  trackAgentMetrics() {
    // Task execution metrics
    this.onAgentEvent('task:submitted', () => {
      this.incrementCounter('agent_tasks_submitted')
    })

    this.onAgentEvent('task:completed', (data) => {
      this.incrementCounter('agent_tasks_completed')
      if (data.duration) {
        this.recordHistogram('agent_task_duration_ms', data.duration, 'milliseconds')
      }
    })

    this.onAgentEvent('task:failed', () => {
      this.incrementCounter('agent_tasks_failed')
    })

    // Decision making metrics
    this.onAgentEvent('decision:made', (data) => {
      this.incrementCounter('agent_decisions_made')
      if (data.confidence) {
        this.recordGauge('agent_decision_confidence', data.confidence)
      }
    })

    // Learning metrics
    this.onAgentEvent('learning:generated', () => {
      this.incrementCounter('agent_learnings_generated')
    })

    // Error metrics
    this.onAgentEvent('error', (data) => {
      this.incrementCounter('agent_errors', 1, {
        component: data.component || 'unknown',
        error_type: data.error?.name || 'unknown'
      })
    })
  }

  /**
   * Get aggregated metrics
   */
  getMetricsSummary(): Record<string, any> {
    const summary: Record<string, any> = {}

    for (const [name, points] of this.metrics.entries()) {
      const values = points.map(p => p.value)
      summary[name] = {
        count: values.length,
        sum: values.reduce((a, b) => a + b, 0),
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        latest: values[values.length - 1],
        unit: points[0]?.unit
      }
    }

    return summary
  }

  /**
   * Get performance insights
   */
  getPerformanceInsights() {
    const completedTraces = Array.from(this.traces.values())
      .filter(t => t.status === 'completed' && t.duration)

    const tracesByName = completedTraces.reduce((groups, trace) => {
      if (!groups[trace.name]) groups[trace.name] = []
      groups[trace.name].push(trace.duration!)
      return groups
    }, {} as Record<string, number[]>)

    const insights: Record<string, any> = {}

    for (const [name, durations] of Object.entries(tracesByName)) {
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length
      const sorted = durations.sort((a, b) => a - b)
      const p95 = sorted[Math.floor(sorted.length * 0.95)]
      const p99 = sorted[Math.floor(sorted.length * 0.99)]

      insights[name] = {
        count: durations.length,
        avg_ms: Math.round(avg),
        p95_ms: Math.round(p95),
        p99_ms: Math.round(p99),
        min_ms: Math.min(...durations),
        max_ms: Math.max(...durations)
      }
    }

    return insights
  }

  /**
   * Flush telemetry data to configured endpoints
   */
  async flush(): Promise<void> {
    if (this.events.length === 0) return

    const batch = this.events.splice(0, this.config.batchSize || 100)
    const promises: Promise<void>[] = []

    // Send metrics
    if (this.config.endpoints?.metrics) {
      const metrics = batch.filter(e => e.type === 'metric')
      if (metrics.length > 0) {
        promises.push(this.sendToEndpoint('metrics', metrics))
      }
    }

    // Send traces
    if (this.config.endpoints?.traces) {
      const traces = Array.from(this.traces.values())
        .filter(t => t.status !== 'running')
      if (traces.length > 0) {
        promises.push(this.sendToEndpoint('traces', traces))
        // Clear sent traces
        traces.forEach(t => this.traces.delete(t.id))
      }
    }

    // Send logs
    if (this.config.endpoints?.logs) {
      const logs = batch.filter(e => e.type === 'log')
      if (logs.length > 0) {
        promises.push(this.sendToEndpoint('logs', logs))
      }
    }

    try {
      await Promise.all(promises)
      this.emit('flushed', { events: batch.length })
    } catch (error) {
      console.error('Failed to flush telemetry data:', error)
      // Re-add failed events to the beginning of the queue
      this.events.unshift(...batch)
    }
  }

  /**
   * Private helpers
   */
  private addEvent(eventData: Partial<TelemetryEvent>) {
    if (Math.random() > (this.config.sampleRate || 1.0)) return

    const event: TelemetryEvent = {
      id: this.generateId(),
      timestamp: new Date(),
      sessionId: this.sessionId,
      ...eventData
    } as TelemetryEvent

    this.events.push(event)
  }

  private async sendToEndpoint(type: string, data: any): Promise<void> {
    const endpoint = this.config.endpoints?.[type as keyof typeof this.config.endpoints]
    if (!endpoint) return

    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.config.apiKey ? `Bearer ${this.config.apiKey}` : '',
        'X-Codmir-Version': this.config.version || '1.0.0',
        'X-Codmir-Environment': this.config.environment || 'production'
      },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        type,
        data,
        session: this.sessionId
      })
    })
  }

  private onAgentEvent(event: string, handler: (data: any) => void) {
    // This would integrate with the actual Agent SDK event system
    // For now, it's a placeholder for the integration pattern
    this.on(`agent:${event}`, handler)
  }

  private setupPeriodicFlush() {
    if (this.config.flushInterval) {
      this.flushTimer = setInterval(() => {
        this.flush().catch(console.error)
      }, this.config.flushInterval)
    }
  }

  private trackSystemMetrics() {
    if (!this.config.enableMetrics) return

    setInterval(() => {
      // Memory usage
      if (typeof process !== 'undefined' && process.memoryUsage) {
        const memUsage = process.memoryUsage()
        this.recordGauge('system_memory_used_bytes', memUsage.heapUsed, 'bytes')
        this.recordGauge('system_memory_total_bytes', memUsage.heapTotal, 'bytes')
      }

      // Event queue size
      this.recordGauge('telemetry_queue_size', this.events.length, 'count')
      this.recordGauge('telemetry_active_traces', this.traces.size, 'count')
    }, 30000) // Every 30 seconds
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * Cleanup resources
   */
  dispose() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
    }
    this.flush().catch(console.error)
  }
}

/**
 * Pre-configured telemetry instance
 */
export const telemetry = new AgentTelemetrySystem({
  enableMetrics: process.env.NODE_ENV === 'production',
  enableTracing: process.env.CODMIR_ENABLE_TRACING === 'true',
  enableLogs: process.env.CODMIR_ENABLE_TELEMETRY_LOGS === 'true',
  sampleRate: parseFloat(process.env.CODMIR_TELEMETRY_SAMPLE_RATE || '1.0'),
  batchSize: parseInt(process.env.CODMIR_TELEMETRY_BATCH_SIZE || '100'),
  flushInterval: parseInt(process.env.CODMIR_TELEMETRY_FLUSH_INTERVAL || '30000'),
  endpoints: {
    metrics: process.env.CODMIR_METRICS_ENDPOINT,
    traces: process.env.CODMIR_TRACES_ENDPOINT,
    logs: process.env.CODMIR_LOGS_ENDPOINT
  },
  apiKey: process.env.CODMIR_TELEMETRY_API_KEY,
  environment: process.env.NODE_ENV || 'production',
  version: process.env.CODMIR_VERSION || '1.0.0'
})

// Set up agent-specific tracking
telemetry.trackAgentMetrics()

// Graceful shutdown
process.on('SIGINT', () => {
  telemetry.dispose()
})

process.on('SIGTERM', () => {
  telemetry.dispose()
})

export default telemetry
