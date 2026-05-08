/**
 * Codmir Agent SDK - Main Entry Point
 * 
 * The Codmir Agent SDK provides autonomous decision-making capabilities for AI agents,
 * enabling them to make confident, context-aware decisions and execute actions
 * with minimal human intervention.
 */

// Core Engine - The heart of autonomous decision making
export { AgentEngine } from './core/AgentEngine'

// Core Modules - Foundation systems for autonomous operation
export { ContextManager } from './core/ContextManager'
export { PlanningEngine } from './core/PlanningEngine'
export { ActionExecutor } from './core/ActionExecutor'
export { LearningSystem } from './core/LearningSystem'

// Intelligence Modules - Specialized analysis and insight systems
export { ConversationIntelligence } from './intelligence/ConversationIntelligence'
export { CodebaseIntelligence } from './intelligence/CodebaseIntelligence'
export { TaskIntelligence } from './intelligence/TaskIntelligence'
export { ProjectIntelligence } from './intelligence/ProjectIntelligence'

// Autonomous Agents - Specialized decision-making entities
export { TicketAgent } from './agents/TicketAgent'
export { TaskAgent } from './agents/TaskAgent' 
export { CodeAgent } from './agents/CodeAgent'
export { PlannerAgent } from './agents/PlannerAgent'

// Agent utilities and presets
export { 
  createAgentSuite, 
  AgentPresets, 
  AgentCapabilities, 
  AgentUtils, 
  AgentEvents 
} from './agents/index'

// Integration Layers - Connect Codmir Agent with external systems
export { ChatIntegration } from './integrations/ChatIntegration'
export { CLIIntegration } from './integrations/CLIIntegration'
export { 
  createChatIntegration,
  createCLIIntegration, 
  IntegrationPresets, 
  IntegrationUtils, 
  IntegrationEvents 
} from './integrations/index'

// Note: Add more integrations as they are implemented
// export { TaskRunnerIntegration } from './integrations/TaskRunnerIntegration'

// Type Definitions - Complete type system for Codmir Agent SDK
export type * from './types'

/**
 * Factory function to create a complete Codmir Agent SDK instance
 */
import { AgentEngine } from './core/AgentEngine'
import { ConversationIntelligence } from './intelligence/ConversationIntelligence'
import { CodebaseIntelligence } from './intelligence/CodebaseIntelligence'
import { TaskIntelligence } from './intelligence/TaskIntelligence'
import { ProjectIntelligence } from './intelligence/ProjectIntelligence'
import { createAgentSuite } from './agents/index'
import { createChatIntegration, createCLIIntegration } from './integrations/index'
import type { AgentConfig } from './types'
import type { TicketAgent } from './agents/TicketAgent'
import type { TaskAgent } from './agents/TaskAgent'
import type { CodeAgent } from './agents/CodeAgent'
import type { PlannerAgent } from './agents/PlannerAgent'
import type { ChatIntegration } from './integrations/ChatIntegration'
import type { CLIIntegration } from './integrations/CLIIntegration'

export async function createAgentSDK(config: AgentConfig): Promise<{
  engine: AgentEngine
  intelligence: {
    conversation: ConversationIntelligence
    codebase: CodebaseIntelligence
    task: TaskIntelligence
    project: ProjectIntelligence
  }
  agents: {
    ticketAgent: TicketAgent
    taskAgent: TaskAgent
    codeAgent: CodeAgent
    plannerAgent: PlannerAgent
  }
  integrations: {
    chat: ChatIntegration
    cli: CLIIntegration
  }
  makeDecision: (context: any, options: any) => Promise<any>
  createPlan: (objective: any, context: any) => Promise<any>
  analyzeConversation: (messages: any[], context: any) => Promise<any>
  createTicketFromChat: (conversationId: string, context: any) => Promise<any>
  createTaskFromChat: (conversationId: string, context: any) => Promise<any>
  generateCode: (requirements: any, context: any) => Promise<any>
  createStrategicPlan: (objective: any, context: any) => Promise<any>
  getSDKInsights: () => Promise<any>
}> {
  // Initialize core engine
  const engine = new AgentEngine(config)
  await engine.initialize()
  
  // Initialize intelligence modules
  const intelligence = {
    conversation: new ConversationIntelligence(config),
    codebase: new CodebaseIntelligence(config),
    task: new TaskIntelligence(config),
    project: new ProjectIntelligence(config)
  }
  
  await Promise.all([
    intelligence.conversation.initialize(),
    intelligence.codebase.initialize(),
    intelligence.task.initialize(),
    intelligence.project.initialize()
  ])
  
  // Initialize autonomous agents
  const agents = await createAgentSuite(config)
  
  // Initialize integrations
  const integrations = {
    chat: await createChatIntegration(config),
    cli: await createCLIIntegration(config)
  }
  
  return {
    // Core components
    engine,
    intelligence,
    agents,
    integrations,
    
    // Convenience methods for common operations
    async makeDecision(content: any, context?: any) {
      const result = await engine.processInput({
        type: 'request',
        content,
        context
      })
      return result.decisions[0]
    },
    
    async createPlan(content: any, context?: any) {
      const result = await engine.processInput({
        type: 'request',
        content,
        context
      })
      return result.plans[0]
    },
    
    async analyzeConversation(context: any) {
      return intelligence.conversation.analyzeConversation(context)
    },
    
    async createTicketFromChat(conversationId: string, context: any) {
      return integrations.chat.createTicketFromConversation({
        conversationId,
        context,
        triggerType: 'manual'
      })
    },
    
    async createTaskFromChat(conversationId: string, context: any) {
      return integrations.chat.createTaskFromConversation({
        conversationId,
        context,
        triggerType: 'manual'
      })
    },
    
    async generateCode(requirements: any, context: any) {
      return agents.codeAgent.generateCodeAutonomously({
        requirements,
        context
      })
    },
    
    async createStrategicPlan(objective: any, context: any) {
      return agents.plannerAgent.createStrategicPlan({
        objective,
        context,
        timeHorizon: 'medium'
      })
    },
    
    // Get comprehensive insights from all components
    async getSDKInsights() {
      return {
        engine: engine.getMetrics(),
        intelligence: {
          conversation: intelligence.conversation.getAnalysisHistory(),
          codebase: intelligence.codebase.getInsights(),
          task: intelligence.task.getInsights(),
          project: intelligence.project.getInsights()
        },
        agents: {
          ticket: agents.ticketAgent.getAgentInsights(),
          task: agents.taskAgent.getAgentInsights(),
          code: agents.codeAgent.getAgentInsights(),
          planner: agents.plannerAgent.getAgentInsights()
        },
        integrations: {
          chat: integrations.chat.getIntegrationMetrics()
        }
      }
    }
  }
}

/**
 * Simplified factory for chat-focused Agent integration
 */
export async function createChatAgent(config: AgentConfig) {
  const sdk = await createAgentSDK(config)
  
  return {
    processMessage: async (conversationId: string, message: any, context: any) => {
      return sdk.integrations.chat.processChatMessage({
        conversationId,
        message,
        context
      })
    },
    
    createTicket: async (conversationId: string, context: any) => {
      return sdk.integrations.chat.createTicketFromConversation({
        conversationId,
        context,
        triggerType: 'manual'
      })
    },
    
    createTask: async (conversationId: string, context: any) => {
      return sdk.integrations.chat.createTaskFromConversation({
        conversationId,
        context,
        triggerType: 'manual'
      })
    },
    
    getInsights: async (conversationId: string) => {
      return sdk.integrations.chat.getConversationInsights(conversationId)
    }
  }
}
