/**
 * autonomus Autonomous Agents - Export Module
 * 
 * Exports all autonomous agents that provide specialized intelligence
 * and decision-making capabilities for the autonomus SDK.
 */

export { TicketAgent } from './TicketAgent'
export { TaskAgent } from './TaskAgent'
export { CodeAgent } from './CodeAgent'
export { PlannerAgent } from './PlannerAgent'

// Re-export common types used by agents
export type {
  AgentCapability,
  AgentInsights,
  AgentMetrics
} from '../types'

/**
 * Agent factory functions for convenient initialization
 */
import type { autonomusConfig } from '../types'
import { TicketAgent } from './TicketAgent'
import { TaskAgent } from './TaskAgent'
import { CodeAgent } from './CodeAgent'
import { PlannerAgent } from './PlannerAgent'

/**
 * Create and initialize all agents with shared configuration
 */
export async function createAgentSuite(config: autonomusConfig) {
  const agents = {
    ticketAgent: new TicketAgent(config),
    taskAgent: new TaskAgent(config),
    codeAgent: new CodeAgent(config),
    plannerAgent: new PlannerAgent(config)
  }

  // Initialize all agents
  await Promise.all([
    agents.ticketAgent.initialize(),
    agents.taskAgent.initialize(),
    agents.codeAgent.initialize(),
    agents.plannerAgent.initialize()
  ])

  return agents
}

/**
 * Agent configuration presets for different use cases
 */
export const AgentPresets = {
  // Conservative: High confidence thresholds, manual confirmations
  conservative: {
    confidenceThreshold: {
      low: 0.7,
      medium: 0.8,
      high: 0.9
    },
    autonomyMode: 'conservative' as const,
    enableAutonomousActions: false
  },

  // Balanced: Moderate autonomy with intelligent decision making
  balanced: {
    confidenceThreshold: {
      low: 0.6,
      medium: 0.75,
      high: 0.85
    },
    autonomyMode: 'balanced' as const,
    enableAutonomousActions: true
  },

  // Aggressive: High autonomy for experienced users
  aggressive: {
    confidenceThreshold: {
      low: 0.5,
      medium: 0.7,
      high: 0.8
    },
    autonomyMode: 'aggressive' as const,
    enableAutonomousActions: true,
    enableExperimentalFeatures: true
  }
} as const

/**
 * Agent capability matrix - shows which agent handles what
 */
export const AgentCapabilities = {
  ticket_creation: ['TicketAgent'],
  ticket_analysis: ['TicketAgent'],
  ticket_prioritization: ['TicketAgent', 'PlannerAgent'],

  task_creation: ['TaskAgent'],
  task_breakdown: ['TaskAgent'],
  task_estimation: ['TaskAgent'],
  task_monitoring: ['TaskAgent'],

  code_generation: ['CodeAgent'],
  code_analysis: ['CodeAgent'],
  code_review: ['CodeAgent'],
  code_refactoring: ['CodeAgent'],
  test_generation: ['CodeAgent'],

  strategic_planning: ['PlannerAgent'],
  decision_making: ['PlannerAgent'],
  resource_optimization: ['PlannerAgent'],
  risk_management: ['PlannerAgent']
} as const

/**
 * Utility functions for working with agents
 */
export class AgentUtils {
  /**
   * Find which agents can handle a specific capability
   */
  static getCapableAgents(capability: keyof typeof AgentCapabilities): string[] {
    return [...(AgentCapabilities[capability] || [])]
  }

  /**
   * Get comprehensive insights from all agents
   */
  static async getAllAgentInsights(agents: ReturnType<typeof createAgentSuite>): Promise<Record<string, any>> {
    const suite = await agents

    return {
      ticketAgent: suite.ticketAgent.getAgentInsights(),
      taskAgent: suite.taskAgent.getAgentInsights(),
      codeAgent: suite.codeAgent.getAgentInsights(),
      plannerAgent: suite.plannerAgent.getAgentInsights(),

      // Aggregate metrics
      totalCapabilities: Object.keys(AgentCapabilities).length,
      activeAgents: 4,
      overallHealthScore: this.calculateOverallHealthScore(suite)
    }
  }

  /**
   * Calculate overall health score across all agents
   */
  private static calculateOverallHealthScore(agents: any): number {
    // This would aggregate performance metrics from all agents
    // For now, returning a mock score
    return 85
  }

  /**
   * Validate agent configuration
   */
  static validateConfig(config: Partial<autonomusConfig>): { isValid: boolean; errors: string[] } {
    const errors: string[] = []

    if (config.confidenceThreshold && typeof config.confidenceThreshold === 'object') {
      if (config.confidenceThreshold.low > config.confidenceThreshold.medium) {
        errors.push('Low confidence threshold cannot be higher than medium')
      }
      if (config.confidenceThreshold.medium > config.confidenceThreshold.high) {
        errors.push('Medium confidence threshold cannot be higher than high')
      }
    }

    if (config.enableAutonomousActions && !config.autonomyMode) {
      errors.push('Autonomy mode must be specified when autonomous actions are enabled')
    }

    return {
      isValid: errors.length === 0,
      errors
    }
  }
}

/**
 * Agent event types for monitoring and integration
 */
export const AgentEvents = {
  // Ticket Agent Events
  TICKET_CREATED_AUTONOMOUSLY: 'ticket_created_autonomously',
  TICKET_ANALYZED: 'ticket_analyzed',
  TICKET_PRIORITIZED: 'ticket_prioritized',

  // Task Agent Events
  TASK_CREATED_AUTONOMOUSLY: 'task_created_autonomously',
  TASK_BREAKDOWN_COMPLETED: 'task_breakdown_completed',
  TASK_EXECUTION_MONITORED: 'task_execution_monitored',
  TASK_LEARNING_EXTRACTED: 'task_learning_extracted',

  // Code Agent Events
  CODE_GENERATED_AUTONOMOUSLY: 'code_generated_autonomously',
  CODE_ANALYZED: 'code_analyzed',
  CODE_REVIEWED: 'code_reviewed',
  CODE_REFACTORED: 'code_refactored',

  // Planner Agent Events
  STRATEGIC_PLAN_CREATED: 'strategic_plan_created',
  PLAN_EXECUTION_MONITORED: 'plan_execution_monitored',
  AUTONOMOUS_DECISION_MADE: 'autonomous_decision_made'
} as const
