/**
 * Event-Driven Engine for Codmir Agent SDK
 * 
 * Inspired by the experimental SDK event queue system, this provides
 * a robust event-driven architecture for the Agent SDK.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

export interface AgentEvent {
  id: string
  type: string
  subtype?: string
  timestamp: string
  sessionId?: string
  data: any
  metadata?: Record<string, any>
}

export interface TaskEvent extends AgentEvent {
  type: 'task'
  subtype: 'started' | 'progress' | 'completed' | 'failed' | 'stopped'
  taskId: string
  toolUseId?: string
  description?: string
  progress?: {
    totalTokens: number
    toolUses: number
    durationMs: number
  }
  summary?: string
  outputFile?: string
}

export interface SystemEvent extends AgentEvent {
  type: 'system'
  subtype: 'state_changed' | 'error' | 'warning' | 'info'
  state?: 'idle' | 'running' | 'requires_action'
  message?: string
  error?: Error
}

export interface DecisionEvent extends AgentEvent {
  type: 'decision'
  subtype: 'made' | 'executed' | 'failed'
  decisionId: string
  confidence: number
  reasoning?: string
  result?: any
}

export interface LearningEvent extends AgentEvent {
  type: 'learning'
  subtype: 'insight' | 'pattern' | 'failure' | 'success'
  learningId: string
  description: string
  confidence: number
  applicableContexts?: string[]
}

type EventHandler<T = AgentEvent> = (event: T) => void | Promise<void>
type EventFilter = (event: AgentEvent) => boolean

interface QueuedEvent {
  event: AgentEvent
  async: boolean
}

export class EventEngine extends EventEmitter {
  private static instance: EventEngine
  
  private eventQueue: QueuedEvent[] = []
  private eventHistory: AgentEvent[] = []
  private handlers = new Map<string, Set<EventHandler>>()
  private filters = new Map<string, EventFilter>()
  
  private config = {
    maxQueueSize: 1000,
    maxHistorySize: 10000,
    flushInterval: 100,
    enableHistory: true,
    enableAsync: true
  }
  
  private flushTimer: NodeJS.Timeout | null = null
  private isProcessing = false
  private sessionId = randomUUID()

  private constructor() {
    super()
    this.startFlushTimer()
  }

  static getInstance(): EventEngine {
    if (!EventEngine.instance) {
      EventEngine.instance = new EventEngine()
    }
    return EventEngine.instance
  }

  /**
   * Emit an event synchronously
   */
  emitEvent<T extends AgentEvent>(event: Omit<T, 'id' | 'timestamp'>): void {
    const fullEvent: T = {
      ...event,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId
    } as T

    if (this.config.enableHistory) {
      this.addToHistory(fullEvent)
    }

    // Apply filters
    if (!this.shouldProcessEvent(fullEvent)) {
      return
    }

    // Queue for processing
    this.enqueueEvent(fullEvent, false)
  }

  /**
   * Emit an event asynchronously
   */
  async emitEventAsync<T extends AgentEvent>(event: Omit<T, 'id' | 'timestamp'>): Promise<void> {
    const fullEvent: T = {
      ...event,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId
    } as T

    if (this.config.enableHistory) {
      this.addToHistory(fullEvent)
    }

    // Apply filters
    if (!this.shouldProcessEvent(fullEvent)) {
      return
    }

    // Queue for processing
    this.enqueueEvent(fullEvent, true)
    
    // Wait for processing if async is disabled
    if (!this.config.enableAsync) {
      await this.flushQueue()
    }
  }

  /**
   * Register a handler for specific event types
   */
  on(eventType: string, handler: EventHandler): this {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set())
    }
    this.handlers.get(eventType)!.add(handler)
    
    // Also register with EventEmitter for compatibility
    super.on(eventType, handler)
    
    return this
  }

  /**
   * Register a one-time handler
   */
  once(eventType: string, handler: EventHandler): this {
    const wrappedHandler: EventHandler = (event) => {
      this.off(eventType, wrappedHandler)
      handler(event)
    }
    return this.on(eventType, wrappedHandler)
  }

  /**
   * Remove a handler
   */
  off(eventType: string, handler: EventHandler): this {
    const handlers = this.handlers.get(eventType)
    if (handlers) {
      handlers.delete(handler)
    }
    
    // Also remove from EventEmitter
    super.off(eventType, handler)
    
    return this
  }

  /**
   * Add an event filter
   */
  addFilter(name: string, filter: EventFilter): void {
    this.filters.set(name, filter)
  }

  /**
   * Remove an event filter
   */
  removeFilter(name: string): void {
    this.filters.delete(name)
  }

  /**
   * Get event history
   */
  getHistory(filter?: {
    type?: string
    subtype?: string
    since?: Date
    limit?: number
  }): AgentEvent[] {
    let events = [...this.eventHistory]
    
    if (filter) {
      if (filter.type) {
        events = events.filter(e => e.type === filter.type)
      }
      if (filter.subtype) {
        events = events.filter(e => e.subtype === filter.subtype)
      }
      if (filter.since) {
        const sinceTime = filter.since.getTime()
        events = events.filter(e => new Date(e.timestamp).getTime() > sinceTime)
      }
      if (filter.limit) {
        events = events.slice(-filter.limit)
      }
    }
    
    return events
  }

  /**
   * Clear event history
   */
  clearHistory(): void {
    this.eventHistory = []
  }

  /**
   * Get queue size
   */
  getQueueSize(): number {
    return this.eventQueue.length
  }

  /**
   * Flush the event queue immediately
   */
  async flushQueue(): Promise<void> {
    if (this.isProcessing || this.eventQueue.length === 0) {
      return
    }

    this.isProcessing = true
    const events = this.eventQueue.splice(0)
    
    for (const { event, async } of events) {
      try {
        if (async) {
          await this.processEvent(event)
        } else {
          this.processEvent(event)
        }
      } catch (error) {
        console.error('Error processing event:', error)
        this.emitEvent<SystemEvent>({
          type: 'system',
          subtype: 'error',
          data: { message: `Failed to process event: ${event.type}` },
          error: error instanceof Error ? error : new Error(String(error)),
          metadata: { originalEvent: event }
        })
      }
    }
    
    this.isProcessing = false
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<typeof this.config>): void {
    this.config = { ...this.config, ...updates }
    
    if (updates.flushInterval !== undefined) {
      this.stopFlushTimer()
      this.startFlushTimer()
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    queueSize: number
    historySize: number
    handlerCount: number
    filterCount: number
    sessionId: string
  } {
    let handlerCount = 0
    this.handlers.forEach(handlers => {
      handlerCount += handlers.size
    })
    
    return {
      queueSize: this.eventQueue.length,
      historySize: this.eventHistory.length,
      handlerCount,
      filterCount: this.filters.size,
      sessionId: this.sessionId
    }
  }

  /**
   * Reset the engine
   */
  reset(): void {
    this.eventQueue = []
    this.eventHistory = []
    this.sessionId = randomUUID()
    this.stopFlushTimer()
    this.startFlushTimer()
  }

  // Private methods

  private enqueueEvent(event: AgentEvent, async: boolean): void {
    if (this.eventQueue.length >= this.config.maxQueueSize) {
      // Remove oldest event
      this.eventQueue.shift()
    }
    
    this.eventQueue.push({ event, async })
  }

  private addToHistory(event: AgentEvent): void {
    this.eventHistory.push(event)
    
    // Trim history if too large
    if (this.eventHistory.length > this.config.maxHistorySize) {
      this.eventHistory = this.eventHistory.slice(-this.config.maxHistorySize)
    }
  }

  private shouldProcessEvent(event: AgentEvent): boolean {
    // Check all filters
    for (const filter of this.filters.values()) {
      if (!filter(event)) {
        return false
      }
    }
    return true
  }

  private async processEvent(event: AgentEvent): Promise<void> {
    // Emit to specific handlers
    const handlers = this.handlers.get(event.type)
    if (handlers) {
      for (const handler of handlers) {
        await handler(event)
      }
    }
    
    // Emit to EventEmitter
    this.emit(event.type, event)
    
    // Emit with subtype if available
    if (event.subtype) {
      const subtypeEvent = `${event.type}:${event.subtype}`
      const subtypeHandlers = this.handlers.get(subtypeEvent)
      if (subtypeHandlers) {
        for (const handler of subtypeHandlers) {
          await handler(event)
        }
      }
      this.emit(subtypeEvent, event)
    }
    
    // Emit wildcard event
    this.emit('*', event)
  }

  private startFlushTimer(): void {
    if (this.flushTimer) {
      return
    }
    
    this.flushTimer = setInterval(() => {
      this.flushQueue().catch(console.error)
    }, this.config.flushInterval)
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }
}

// Export singleton instance
export const eventEngine = EventEngine.getInstance()

// Helper functions for common event types

export function emitTaskStarted(params: {
  taskId: string
  description: string
  toolUseId?: string
  metadata?: Record<string, any>
}): void {
  eventEngine.emitEvent<TaskEvent>({
    type: 'task',
    subtype: 'started',
    taskId: params.taskId,
    toolUseId: params.toolUseId,
    description: params.description,
    data: params.metadata || {}
  })
}

export function emitTaskProgress(params: {
  taskId: string
  progress: {
    totalTokens: number
    toolUses: number
    durationMs: number
  }
  summary?: string
  metadata?: Record<string, any>
}): void {
  eventEngine.emitEvent<TaskEvent>({
    type: 'task',
    subtype: 'progress',
    taskId: params.taskId,
    progress: params.progress,
    summary: params.summary,
    data: params.metadata || {}
  })
}

export function emitTaskCompleted(params: {
  taskId: string
  summary: string
  outputFile?: string
  progress?: {
    totalTokens: number
    toolUses: number
    durationMs: number
  }
  metadata?: Record<string, any>
}): void {
  eventEngine.emitEvent<TaskEvent>({
    type: 'task',
    subtype: 'completed',
    taskId: params.taskId,
    summary: params.summary,
    outputFile: params.outputFile,
    progress: params.progress,
    data: params.metadata || {}
  })
}

export function emitDecisionMade(params: {
  decisionId: string
  confidence: number
  reasoning: string
  metadata?: Record<string, any>
}): void {
  eventEngine.emitEvent<DecisionEvent>({
    type: 'decision',
    subtype: 'made',
    decisionId: params.decisionId,
    confidence: params.confidence,
    reasoning: params.reasoning,
    data: params.metadata || {}
  })
}

export function emitLearningInsight(params: {
  learningId: string
  description: string
  confidence: number
  applicableContexts?: string[]
  metadata?: Record<string, any>
}): void {
  eventEngine.emitEvent<LearningEvent>({
    type: 'learning',
    subtype: 'insight',
    learningId: params.learningId,
    description: params.description,
    confidence: params.confidence,
    applicableContexts: params.applicableContexts,
    data: params.metadata || {}
  })
}

export function emitSystemStateChanged(state: 'idle' | 'running' | 'requires_action'): void {
  eventEngine.emitEvent<SystemEvent>({
    type: 'system',
    subtype: 'state_changed',
    state,
    data: {}
  })
}
