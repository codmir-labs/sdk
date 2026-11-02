/**
 * Event System Integration for Overseer
 * 
 * Connects the Overseer with the existing event bus system to monitor
 * all business events and trigger appropriate actions.
 */

import { EventEmitter } from 'events'
import type { OverseerSystem, BusinessEvent } from '../OverseerSystem'

export class EventSystemIntegration extends EventEmitter {
  private eventPatterns: EventPattern[] = []
  private eventHistory: EventHistoryEntry[] = []
  private historySize = 10000
  private correlationWindow = 300000 // 5 minutes

  constructor(
    private overseer: OverseerSystem,
    private config: EventSystemConfig = {}
  ) {
    super()
    this.initializePatterns()
  }

  /**
   * Connect to event system
   */
  async connect(): Promise<void> {
    // Subscribe to all events
    await this.subscribeToEvents()
    
    // Start correlation analysis
    this.startCorrelationAnalysis()
    
    this.emit('connected')
  }

  /**
   * Process incoming event
   */
  async processEvent(event: SystemEvent): Promise<void> {
    // Add to history
    this.addToHistory(event)
    
    // Check for immediate issues
    const immediateIssue = this.checkImmediateIssue(event)
    if (immediateIssue) {
      await this.reportToOverseer(immediateIssue)
    }
    
    // Check for pattern matches
    const patterns = this.checkPatterns(event)
    for (const pattern of patterns) {
      await this.handlePatternMatch(pattern, event)
    }
    
    // Correlate with recent events
    const correlations = this.correlateEvents(event)
    if (correlations.length > 0) {
      await this.handleCorrelations(correlations, event)
    }
  }

  /**
   * Subscribe to specific event types
   */
  subscribeToEventType(eventType: string, handler?: (event: SystemEvent) => void): void {
    const pattern: EventPattern = {
      name: `Subscription: ${eventType}`,
      eventTypes: [eventType],
      conditions: [],
      action: 'monitor',
      severity: 'low'
    }
    
    this.eventPatterns.push(pattern)
    
    if (handler) {
      this.on(`event:${eventType}`, handler)
    }
  }

  /**
   * Get event statistics
   */
  getEventStats(): EventStatistics {
    const stats: EventStatistics = {
      totalEvents: this.eventHistory.length,
      eventsByType: {},
      eventsByHour: {},
      correlations: [],
      anomalies: []
    }
    
    // Count by type
    for (const entry of this.eventHistory) {
      stats.eventsByType[entry.event.type] = (stats.eventsByType[entry.event.type] || 0) + 1
    }
    
    // Count by hour
    for (const entry of this.eventHistory) {
      const hour = new Date(entry.timestamp).getHours()
      stats.eventsByHour[hour] = (stats.eventsByHour[hour] || 0) + 1
    }
    
    return stats
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private async subscribeToEvents(): Promise<void> {
    // This would connect to the actual event system
    // For now, we provide methods that can be called
    
    // Common event types to monitor
    const eventTypes = [
      'task.created',
      'task.completed',
      'task.failed',
      'ticket.created',
      'ticket.resolved',
      'deployment.started',
      'deployment.failed',
      'error.occurred',
      'user.action',
      'system.alert'
    ]
    
    for (const eventType of eventTypes) {
      this.subscribeToEventType(eventType)
    }
  }

  private startCorrelationAnalysis(): void {
    setInterval(() => {
      this.analyzeRecentEvents()
    }, this.config.correlationInterval || 60000) // Every minute
  }

  private addToHistory(event: SystemEvent): void {
    this.eventHistory.push({
      event,
      timestamp: new Date().toISOString(),
      processed: true
    })
    
    // Trim history if too large
    if (this.eventHistory.length > this.historySize) {
      this.eventHistory = this.eventHistory.slice(-this.historySize)
    }
  }

  private checkImmediateIssue(event: SystemEvent): BusinessEvent | null {
    // Critical events need immediate attention
    if (event.type === 'error.occurred' || event.type === 'deployment.failed') {
      return {
        id: `event-${event.id}`,
        type: 'critical_event',
        source: 'event_system',
        data: event,
        timestamp: event.timestamp,
        severity: 'high',
        projectId: event.metadata?.projectId
      }
    }
    
    // Check for high-priority patterns
    if (event.metadata?.priority === 'critical' || event.metadata?.severity === 'critical') {
      return {
        id: `event-${event.id}`,
        type: 'priority_event',
        source: 'event_system',
        data: event,
        timestamp: event.timestamp,
        severity: 'critical',
        projectId: event.metadata?.projectId
      }
    }
    
    return null
  }

  private checkPatterns(event: SystemEvent): EventPattern[] {
    const matches: EventPattern[] = []
    
    for (const pattern of this.eventPatterns) {
      if (this.matchesPattern(event, pattern)) {
        matches.push(pattern)
      }
    }
    
    return matches
  }

  private matchesPattern(event: SystemEvent, pattern: EventPattern): boolean {
    // Check event type
    if (pattern.eventTypes.length > 0 && !pattern.eventTypes.includes(event.type)) {
      return false
    }
    
    // Check conditions
    for (const condition of pattern.conditions) {
      if (!this.evaluateCondition(event, condition)) {
        return false
      }
    }
    
    return true
  }

  private evaluateCondition(event: SystemEvent, condition: EventCondition): boolean {
    const value = this.getEventValue(event, condition.field)
    
    switch (condition.operator) {
      case 'equals':
        return value === condition.value
      case 'contains':
        return String(value).includes(String(condition.value))
      case 'greater_than':
        return Number(value) > Number(condition.value)
      case 'less_than':
        return Number(value) < Number(condition.value)
      case 'matches':
        return new RegExp(String(condition.value)).test(String(value))
      default:
        return false
    }
  }

  private getEventValue(event: SystemEvent, field: string): any {
    const parts = field.split('.')
    let value: any = event
    
    for (const part of parts) {
      value = value?.[part]
    }
    
    return value
  }

  private async handlePatternMatch(pattern: EventPattern, event: SystemEvent): Promise<void> {
    console.log(`Pattern matched: ${pattern.name}`)
    
    switch (pattern.action) {
      case 'alert':
        await this.reportToOverseer({
          id: `pattern-${Date.now()}`,
          type: 'pattern_match',
          source: 'event_system',
          data: {
            pattern: pattern.name,
            event
          },
          timestamp: new Date().toISOString(),
          severity: pattern.severity
        })
        break
        
      case 'aggregate':
        // Aggregate similar events
        this.aggregateEvents(pattern, event)
        break
        
      case 'monitor':
        // Just track, no immediate action
        this.emit(`event:${event.type}`, event)
        break
    }
  }

  private correlateEvents(event: SystemEvent): EventCorrelation[] {
    const correlations: EventCorrelation[] = []
    const now = new Date().getTime()
    const windowStart = now - this.correlationWindow
    
    // Get recent events
    const recentEvents = this.eventHistory.filter(entry => 
      new Date(entry.timestamp).getTime() > windowStart
    )
    
    // Look for patterns
    const relatedEvents = recentEvents.filter(entry => 
      this.areEventsRelated(event, entry.event)
    )
    
    if (relatedEvents.length > 0) {
      correlations.push({
        primaryEvent: event,
        relatedEvents: relatedEvents.map(e => e.event),
        correlationType: this.determineCorrelationType(event, relatedEvents),
        confidence: this.calculateCorrelationConfidence(event, relatedEvents)
      })
    }
    
    return correlations
  }

  private areEventsRelated(event1: SystemEvent, event2: SystemEvent): boolean {
    // Same entity
    if (event1.entityId && event1.entityId === event2.entityId) {
      return true
    }
    
    // Same user
    if (event1.metadata?.userId && event1.metadata.userId === event2.metadata?.userId) {
      return true
    }
    
    // Same project
    if (event1.metadata?.projectId && event1.metadata.projectId === event2.metadata?.projectId) {
      return true
    }
    
    // Related types
    const relatedTypes: Record<string, string[]> = {
      'task.failed': ['task.created', 'task.started'],
      'deployment.failed': ['deployment.started', 'build.completed'],
      'error.occurred': ['api.called', 'user.action']
    }
    
    if (relatedTypes[event1.type]?.includes(event2.type)) {
      return true
    }
    
    return false
  }

  private determineCorrelationType(event: SystemEvent, relatedEvents: EventHistoryEntry[]): string {
    // Check for cascade failures
    const failures = relatedEvents.filter(e => 
      e.event.type.includes('failed') || e.event.type.includes('error')
    )
    if (failures.length > 2) {
      return 'cascade_failure'
    }
    
    // Check for retry patterns
    const sameType = relatedEvents.filter(e => e.event.type === event.type)
    if (sameType.length > 3) {
      return 'retry_pattern'
    }
    
    // Check for user frustration
    const userActions = relatedEvents.filter(e => e.event.type === 'user.action')
    if (userActions.length > 10) {
      return 'user_frustration'
    }
    
    return 'general_correlation'
  }

  private calculateCorrelationConfidence(event: SystemEvent, relatedEvents: EventHistoryEntry[]): number {
    let confidence = 0.5
    
    // Increase confidence for more related events
    confidence += Math.min(0.3, relatedEvents.length * 0.05)
    
    // Increase confidence for same entity
    const sameEntity = relatedEvents.filter(e => e.event.entityId === event.entityId)
    confidence += Math.min(0.2, sameEntity.length * 0.1)
    
    return Math.min(1, confidence)
  }

  private async handleCorrelations(correlations: EventCorrelation[], event: SystemEvent): Promise<void> {
    for (const correlation of correlations) {
      if (correlation.confidence > 0.7) {
        await this.reportToOverseer({
          id: `correlation-${Date.now()}`,
          type: 'event_correlation',
          source: 'event_system',
          data: {
            correlation,
            primaryEvent: event
          },
          timestamp: new Date().toISOString(),
          severity: this.determineCorrelationSeverity(correlation)
        })
      }
    }
  }

  private determineCorrelationSeverity(correlation: EventCorrelation): 'low' | 'medium' | 'high' | 'critical' {
    switch (correlation.correlationType) {
      case 'cascade_failure':
        return 'critical'
      case 'retry_pattern':
        return 'high'
      case 'user_frustration':
        return 'medium'
      default:
        return 'low'
    }
  }

  private aggregateEvents(pattern: EventPattern, event: SystemEvent): void {
    // Implement event aggregation logic
    // This would batch similar events together
  }

  private async analyzeRecentEvents(): Promise<void> {
    const now = new Date().getTime()
    const analysisWindow = 300000 // 5 minutes
    const windowStart = now - analysisWindow
    
    const recentEvents = this.eventHistory.filter(entry =>
      new Date(entry.timestamp).getTime() > windowStart
    )
    
    // Detect anomalies
    const anomalies = this.detectAnomalies(recentEvents)
    
    for (const anomaly of anomalies) {
      await this.reportToOverseer({
        id: `anomaly-${Date.now()}`,
        type: 'event_anomaly',
        source: 'event_system',
        data: anomaly,
        timestamp: new Date().toISOString(),
        severity: anomaly.severity
      })
    }
  }

  private detectAnomalies(events: EventHistoryEntry[]): EventAnomaly[] {
    const anomalies: EventAnomaly[] = []
    
    // Check for unusual event frequency
    const eventCounts: Record<string, number> = {}
    for (const entry of events) {
      eventCounts[entry.event.type] = (eventCounts[entry.event.type] || 0) + 1
    }
    
    for (const [eventType, count] of Object.entries(eventCounts)) {
      const expectedRate = this.getExpectedEventRate(eventType)
      if (count > expectedRate * 2) {
        anomalies.push({
          type: 'high_frequency',
          description: `Unusually high frequency of ${eventType} events: ${count} in 5 minutes`,
          events: events.filter(e => e.event.type === eventType).map(e => e.event),
          severity: count > expectedRate * 3 ? 'high' : 'medium'
        })
      }
    }
    
    return anomalies
  }

  private getExpectedEventRate(eventType: string): number {
    // This would be based on historical data
    const rates: Record<string, number> = {
      'task.created': 20,
      'task.completed': 15,
      'error.occurred': 5,
      'deployment.started': 2,
      'user.action': 100
    }
    
    return rates[eventType] || 10
  }

  private async reportToOverseer(event: BusinessEvent): Promise<void> {
    await this.overseer.processEvent(event)
  }

  private initializePatterns(): void {
    this.eventPatterns = [
      {
        name: 'Multiple Task Failures',
        eventTypes: ['task.failed'],
        conditions: [],
        action: 'aggregate',
        severity: 'high',
        threshold: 5,
        window: 300000 // 5 minutes
      },
      {
        name: 'Deployment Failure',
        eventTypes: ['deployment.failed'],
        conditions: [],
        action: 'alert',
        severity: 'critical'
      },
      {
        name: 'High Error Rate',
        eventTypes: ['error.occurred'],
        conditions: [],
        action: 'aggregate',
        severity: 'high',
        threshold: 10,
        window: 60000 // 1 minute
      },
      {
        name: 'User Frustration',
        eventTypes: ['user.action'],
        conditions: [
          { field: 'metadata.actionType', operator: 'equals', value: 'retry' }
        ],
        action: 'aggregate',
        severity: 'medium',
        threshold: 5,
        window: 120000 // 2 minutes
      }
    ]
    
    // Add custom patterns from config
    if (this.config.customPatterns) {
      this.eventPatterns.push(...this.config.customPatterns)
    }
  }
}

// Interfaces
export interface EventSystemConfig {
  correlationInterval?: number
  historySize?: number
  customPatterns?: EventPattern[]
}

export interface SystemEvent {
  id: string
  type: string
  entityId?: string
  timestamp: string
  data?: any
  metadata?: {
    userId?: string
    projectId?: string
    priority?: string
    severity?: string
    [key: string]: any
  }
}

export interface EventPattern {
  name: string
  eventTypes: string[]
  conditions: EventCondition[]
  action: 'alert' | 'aggregate' | 'monitor'
  severity: 'low' | 'medium' | 'high' | 'critical'
  threshold?: number
  window?: number
}

export interface EventCondition {
  field: string
  operator: 'equals' | 'contains' | 'greater_than' | 'less_than' | 'matches'
  value: any
}

export interface EventHistoryEntry {
  event: SystemEvent
  timestamp: string
  processed: boolean
}

export interface EventCorrelation {
  primaryEvent: SystemEvent
  relatedEvents: SystemEvent[]
  correlationType: string
  confidence: number
}

export interface EventAnomaly {
  type: string
  description: string
  events: SystemEvent[]
  severity: 'low' | 'medium' | 'high' | 'critical'
}

export interface EventStatistics {
  totalEvents: number
  eventsByType: Record<string, number>
  eventsByHour: Record<number, number>
  correlations: EventCorrelation[]
  anomalies: EventAnomaly[]
}
