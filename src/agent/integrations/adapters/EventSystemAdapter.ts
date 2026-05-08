/**
 * Event System Integration Adapter for Codmir Agent SDK
 * 
 * Connects the Agent SDK with existing event infrastructure,
 * enabling bi-directional event flow and event-driven decision making.
 */

import { EventEmitter } from 'events'
import type { AgentEngine } from '../../core/AgentEngine'
import type { EventEngine, AgentEvent } from '../../core/EventEngine'
import type { Context } from '../../types'

export interface EventSystemAdapterConfig {
  engine: AgentEngine
  eventEngine: EventEngine
  externalEventEmitter?: EventEmitter
  eventPrefix?: string
}

export class EventSystemAdapter {
  private eventMappings = new Map<string, string>()
  
  constructor(private config: EventSystemAdapterConfig) {
    this.setupEventBridge()
    this.setupDefaultMappings()
  }

  /**
   * Setup bi-directional event bridge
   */
  private setupEventBridge(): void {
    // Forward Agent Engine events to Event Engine
    this.config.engine.on('decision_made', (data) => {
      this.config.eventEngine.emitEvent({
        type: 'agent',
        subtype: 'decision_made',
        data
      })
    })

    this.config.engine.on('action_executed', (data) => {
      this.config.eventEngine.emitEvent({
        type: 'agent',
        subtype: 'action_executed',
        data
      })
    })

    this.config.engine.on('plan_created', (data) => {
      this.config.eventEngine.emitEvent({
        type: 'agent',
        subtype: 'plan_created',
        data
      })
    })

    this.config.engine.on('learning_generated', (data) => {
      this.config.eventEngine.emitEvent({
        type: 'agent',
        subtype: 'learning_generated',
        data
      })
    })

    // Forward Event Engine events to Agent Engine for processing
    this.config.eventEngine.on('task:failed', async (event) => {
      await this.processExternalEvent('task_failed', event)
    })

    this.config.eventEngine.on('system:error', async (event) => {
      await this.processExternalEvent('system_error', event)
    })

    this.config.eventEngine.on('user:action', async (event) => {
      await this.processExternalEvent('user_action', event)
    })

    // Bridge with external event system if provided
    if (this.config.externalEventEmitter) {
      this.bridgeExternalEvents()
    }
  }

  /**
   * Bridge with external event emitter
   */
  private bridgeExternalEvents(): void {
    const emitter = this.config.externalEventEmitter!
    const prefix = this.config.eventPrefix || 'agent'

    // Forward external events to Event Engine
    emitter.on('*', (eventName: string, data: any) => {
      if (!eventName.startsWith(prefix)) return

      this.config.eventEngine.emitEvent({
        type: 'external',
        subtype: eventName.replace(`${prefix}.`, ''),
        data
      })
    })

    // Forward Event Engine events to external system
    this.config.eventEngine.on('*', (event: AgentEvent) => {
      if (event.type === 'external') return // Avoid loops

      emitter.emit(`${prefix}.${event.type}.${event.subtype}`, event)
    })
  }

  /**
   * Setup default event mappings
   */
  private setupDefaultMappings(): void {
    // Map external events to agent events
    this.eventMappings.set('ticket.created', 'process_ticket')
    this.eventMappings.set('task.created', 'process_task')
    this.eventMappings.set('pr.opened', 'review_pr')
    this.eventMappings.set('deployment.failed', 'handle_deployment_failure')
    this.eventMappings.set('error.critical', 'handle_critical_error')
    this.eventMappings.set('user.frustrated', 'assist_user')
  }

  /**
   * Register custom event mapping
   */
  registerEventMapping(externalEvent: string, agentAction: string): void {
    this.eventMappings.set(externalEvent, agentAction)
  }

  /**
   * Process external event through Agent Engine
   */
  private async processExternalEvent(eventType: string, event: AgentEvent): Promise<void> {
    const action = this.eventMappings.get(eventType)
    if (!action) return

    try {
      await this.config.engine.processInput({
        type: 'event',
        content: {
          eventType,
          action,
          eventData: event.data
        },
        context: this.buildContextFromEvent(event),
        urgency: this.determineUrgency(eventType)
      })
    } catch (error) {
      console.error(`Failed to process external event ${eventType}:`, error)
    }
  }

  /**
   * Build context from event
   */
  private buildContextFromEvent(event: AgentEvent): Partial<Context> {
    const envMap: Record<string, Context['system']['environment']> = {
      development: 'development',
      staging: 'staging',
      production: 'production',
      test: 'development'
    }
    const environment = envMap[process.env.NODE_ENV || 'production'] || 'production'

    const context: Partial<Context> = {
      system: {
        platform: process.platform,
        environment,
        capabilities: ['event_processing'].map(name => ({
          name,
          available: true,
          performance: 1,
          lastChecked: new Date().toISOString()
        })),
        resources: {
          cpu: 100,
          memory: 100000,
          storage: 1000000
        }
      }
    } as unknown as Partial<Context>

    // Extract context from event data
    if (event.data) {
      if (event.data.projectId) {
        context.project = { id: event.data.projectId } as any
      }
      if (event.data.userId) {
        context.user = { id: event.data.userId } as any
      }
      if (event.data.conversationId) {
        context.conversation = { id: event.data.conversationId } as any
      }
    }

    return context
  }

  /**
   * Determine urgency based on event type
   */
  private determineUrgency(eventType: string): 'low' | 'medium' | 'high' | 'critical' {
    if (eventType.includes('critical') || eventType.includes('error')) {
      return 'critical'
    }
    if (eventType.includes('failed') || eventType.includes('frustrated')) {
      return 'high'
    }
    if (eventType.includes('created') || eventType.includes('opened')) {
      return 'medium'
    }
    return 'low'
  }

  /**
   * Subscribe to specific event patterns
   */
  subscribeToPattern(pattern: string | RegExp, handler: (event: AgentEvent) => void): void {
    this.config.eventEngine.addFilter(`pattern_${pattern}`, (event) => {
      const eventKey = `${event.type}:${event.subtype}`
      if (typeof pattern === 'string') {
        return eventKey.includes(pattern)
      }
      return pattern.test(eventKey)
    })

    this.config.eventEngine.on('*', (event: AgentEvent) => {
      const eventKey = `${event.type}:${event.subtype}`
      if (typeof pattern === 'string' ? eventKey.includes(pattern) : pattern.test(eventKey)) {
        handler(event)
      }
    })
  }

  /**
   * Get event statistics
   */
  getEventStats(): {
    totalEvents: number
    eventsByType: Record<string, number>
    recentEvents: AgentEvent[]
    engineStats: any
  } {
    const engineStats = this.config.eventEngine.getStats()
    const history = this.config.eventEngine.getHistory({ limit: 100 })
    
    const eventsByType: Record<string, number> = {}
    history.forEach(event => {
      const key = `${event.type}:${event.subtype || 'default'}`
      eventsByType[key] = (eventsByType[key] || 0) + 1
    })

    return {
      totalEvents: engineStats.historySize,
      eventsByType,
      recentEvents: history.slice(-10),
      engineStats
    }
  }
}
