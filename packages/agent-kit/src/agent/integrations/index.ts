/**
 * autonomus Integration Layers - Export Module
 * 
 * Exports all integration layers that connect autonomus SDK with external systems
 * and provide seamless autonomous functionality.
 */

export { ChatIntegration } from './ChatIntegration'
export { CLIIntegration } from './CLIIntegration'

// Re-export integration types
export type {
  ChatMessage,
  ConversationSession,
  ChatProcessingResult,
  ConversationInsights,
  UserPreferences,
  ChatIntegrationConfig,
  ChatIntegrationInsights
} from './ChatIntegration'

export type {
  CLICommand,
  CLISession,
  CLIOptions,
  CLIProcessingResult,
  CLIWorkflow,
  WorkflowExecutionResult,
  IntelligentHelpResult,
  CLIIntegrationInsights,
  AutocompleteSuggestion
} from './CLIIntegration'

/**
 * Integration factory functions
 */
import type { autonomusConfig } from '../types'
import { ChatIntegration } from './ChatIntegration'
import { CLIIntegration } from './CLIIntegration'

/**
 * Create and initialize chat integration with autonomus capabilities
 */
export async function createChatIntegration(config: autonomusConfig): Promise<ChatIntegration> {
  const integration = new ChatIntegration(config)
  await integration.initialize()
  return integration
}

/**
 * Create and initialize CLI integration with autonomus capabilities
 */
export async function createCLIIntegration(config: autonomusConfig): Promise<CLIIntegration> {
  const integration = new CLIIntegration(config)
  await integration.initialize()
  return integration
}

/**
 * Integration configuration presets
 */
export const IntegrationPresets = {
  // Minimal integration for basic chat enhancement
  minimal: {
    enableAutonomousActions: false,
    enableIntelligentSuggestions: true,
    enableConversationAnalysis: true,
    confidenceThreshold: {
      low: 0.7,
      medium: 0.8,
      high: 0.9
    }
  },

  // Standard integration with balanced autonomy
  standard: {
    enableAutonomousActions: true,
    enableIntelligentSuggestions: true,
    enableConversationAnalysis: true,
    enableTicketCreation: true,
    enableTaskCreation: true,
    confidenceThreshold: {
      low: 0.6,
      medium: 0.75,
      high: 0.85
    }
  },

  // Full integration with maximum autonomous capabilities
  full: {
    enableAutonomousActions: true,
    enableIntelligentSuggestions: true,
    enableConversationAnalysis: true,
    enableTicketCreation: true,
    enableTaskCreation: true,
    enableCodeGeneration: true,
    enableStrategicPlanning: true,
    confidenceThreshold: {
      low: 0.5,
      medium: 0.7,
      high: 0.8
    }
  }
} as const

/**
 * Integration utilities
 */
export class IntegrationUtils {
  /**
   * Validate integration configuration
   */
  static validateIntegrationConfig(config: any): { isValid: boolean; errors: string[] } {
    const errors: string[] = []

    if (config.enableAutonomousActions && !config.confidenceThreshold) {
      errors.push('Confidence thresholds must be defined when autonomous actions are enabled')
    }

    if (config.enableCodeGeneration && !config.enableTaskCreation) {
      errors.push('Task creation should be enabled when code generation is enabled')
    }

    return {
      isValid: errors.length === 0,
      errors
    }
  }

  /**
   * Get integration capabilities based on configuration
   */
  static getIntegrationCapabilities(config: any): string[] {
    const capabilities: string[] = []

    if (config.enableConversationAnalysis) capabilities.push('conversation_analysis')
    if (config.enableIntelligentSuggestions) capabilities.push('intelligent_suggestions')
    if (config.enableTicketCreation) capabilities.push('autonomous_ticket_creation')
    if (config.enableTaskCreation) capabilities.push('autonomous_task_creation')
    if (config.enableCodeGeneration) capabilities.push('autonomous_code_generation')
    if (config.enableStrategicPlanning) capabilities.push('strategic_planning')

    return capabilities
  }

  /**
   * Generate integration health report
   */
  static generateHealthReport(integration: ChatIntegration): IntegrationHealthReport {
    const metrics = integration.getIntegrationMetrics()

    return {
      overallHealth: this.calculateOverallHealth(metrics),
      performanceScore: this.calculatePerformanceScore(metrics),
      reliabilityScore: this.calculateReliabilityScore(metrics),
      recommendations: this.generateHealthRecommendations(metrics),
      timestamp: new Date().toISOString()
    }
  }

  private static calculateOverallHealth(metrics: any): number {
    // Weighted average of various health factors
    const performanceWeight = 0.4
    const reliabilityWeight = 0.4
    const utilizationWeight = 0.2

    const performanceScore = Math.min(100, 100 - (metrics.averageProcessingTime - 1000) / 100)
    const reliabilityScore = metrics.successRate * 100
    const utilizationScore = Math.min(100, metrics.activeConversations * 2)

    return Math.round(
      performanceScore * performanceWeight +
      reliabilityScore * reliabilityWeight +
      utilizationScore * utilizationWeight
    )
  }

  private static calculatePerformanceScore(metrics: any): number {
    // Performance based on processing time and throughput
    const idealProcessingTime = 1000 // 1 second
    const maxAcceptableTime = 5000 // 5 seconds

    if (metrics.averageProcessingTime <= idealProcessingTime) return 100
    if (metrics.averageProcessingTime >= maxAcceptableTime) return 0

    return Math.round(100 - ((metrics.averageProcessingTime - idealProcessingTime) / (maxAcceptableTime - idealProcessingTime)) * 100)
  }

  private static calculateReliabilityScore(metrics: any): number {
    return Math.round(metrics.successRate * 100)
  }

  private static generateHealthRecommendations(metrics: any): string[] {
    const recommendations: string[] = []

    if (metrics.averageProcessingTime > 3000) {
      recommendations.push('Consider optimizing processing pipeline for better response times')
    }

    if (metrics.successRate < 0.95) {
      recommendations.push('Investigate and address integration failures')
    }

    if (metrics.activeConversations < 5) {
      recommendations.push('Low utilization detected - consider promoting integration features')
    }

    return recommendations
  }
}

/**
 * Integration event types for monitoring
 */
export const IntegrationEvents = {
  // Chat Integration Events
  CHAT_PROCESSED: 'chat_processed',
  TICKET_CREATED_FROM_CHAT: 'ticket_created_from_chat',
  TASK_CREATED_FROM_CHAT: 'task_created_from_chat',
  CODE_GENERATED_FROM_CHAT: 'code_generated_from_chat',
  AUTONOMOUS_ACTION_EXECUTED: 'autonomous_action_executed',
  CONVERSATION_INTELLIGENCE_UPDATE: 'conversation_intelligence_update',
  INTEGRATION_CONFIGURED: 'integration_configured'
} as const

// Supporting interfaces
interface IntegrationHealthReport {
  overallHealth: number
  performanceScore: number
  reliabilityScore: number
  recommendations: string[]
  timestamp: string
}
