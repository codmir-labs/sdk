/**
 * Chat Integration - autonomus SDK Integration Layer for Chat Interface
 * 
 * Provides seamless integration between the chat interface and autonomus SDK,
 * enabling autonomous ticket/task creation with enhanced intelligence.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

import type {
  Context,
  autonomusConfig,
  Action,
  ActionResult,
  Decision,
  TicketCreationResult,
  TaskCreationResult,
  CodeGenerationResult
} from '../types'

import { AgentEngine } from '../core/AgentEngine'
import { ConversationIntelligence } from '../intelligence/ConversationIntelligence'
import { TicketAgent } from '../agents/TicketAgent'
import { TaskAgent } from '../agents/TaskAgent'
import { CodeAgent } from '../agents/CodeAgent'
import { PlannerAgent } from '../agents/PlannerAgent'

/**
 * ChatIntegration orchestrates autonomus SDK capabilities for chat interactions
 */
export class ChatIntegration extends EventEmitter {
  private agentEngine: AgentEngine
  private conversationIntelligence: ConversationIntelligence
  private ticketAgent: TicketAgent
  private taskAgent: TaskAgent
  private codeAgent: CodeAgent
  private plannerAgent: PlannerAgent

  // Integration state
  private activeConversations = new Map<string, ConversationSession>()
  private integrationMetrics: ChatIntegrationMetrics

  constructor(private config: autonomusConfig) {
    super()

    // Initialize autonomus components
    this.agentEngine = new AgentEngine(config)
    this.conversationIntelligence = new ConversationIntelligence(config)
    this.ticketAgent = new TicketAgent(config)
    this.taskAgent = new TaskAgent(config)
    this.codeAgent = new CodeAgent(config)
    this.plannerAgent = new PlannerAgent(config)

    this.integrationMetrics = this.initializeMetrics()
  }

  async initialize(): Promise<void> {
    console.log('💬 Initializing Chat Integration...')

    await Promise.all([
      this.agentEngine.initialize(),
      this.conversationIntelligence.initialize(),
      this.ticketAgent.initialize(),
      this.taskAgent.initialize(),
      this.codeAgent.initialize(),
      this.plannerAgent.initialize()
    ])

    // Set up event listeners
    this.setupEventListeners()

    console.log('✅ Chat Integration ready')
  }

  /**
   * Process incoming chat message with autonomous intelligence
   */
  async processChatMessage(params: {
    conversationId: string
    message: ChatMessage
    context: Context
    userPreferences?: UserPreferences
  }): Promise<ChatProcessingResult> {
    const startTime = Date.now()

    try {
      console.log(`💬 Processing chat message for conversation ${params.conversationId}`)

      // Get or create conversation session
      const session = await this.getOrCreateConversationSession(params.conversationId, params.context)

      // Update conversation context
      await this.updateConversationContext(session, params.message, params.context)

      // Analyze conversation with intelligence
      const conversationAnalysis = await this.conversationIntelligence.analyzeConversation(params.context)

      // Make autonomous decisions about actions
      const actionDecisions = await this.makeActionDecisions({
        analysis: conversationAnalysis,
        session,
        context: params.context,
        userPreferences: params.userPreferences
      })

      // Execute autonomous actions
      const executedActions = await this.executeAutonomousActions({
        decisions: actionDecisions,
        session,
        context: params.context,
        conversationAnalysis
      })

      // Generate intelligent response suggestions
      const responseSuggestions = await this.generateResponseSuggestions({
        analysis: conversationAnalysis,
        session,
        context: params.context,
        executedActions
      })

      // Update session and metrics
      this.updateSessionMetrics(session, conversationAnalysis, executedActions)
      this.updateIntegrationMetrics(true, Date.now() - startTime)

      const result: ChatProcessingResult = {
        conversationId: params.conversationId,
        analysis: conversationAnalysis,
        executedActions,
        responseSuggestions,
        autonomousRecommendations: await this.generateAutonomousRecommendations(conversationAnalysis, params.context),
        sessionInsights: this.getSessionInsights(session),
        processingTime: Date.now() - startTime
      }

      this.emit('chat_processed', result)

      return result

    } catch (error) {
      console.error('❌ Chat message processing failed:', error)
      this.updateIntegrationMetrics(false, Date.now() - startTime)

      throw new Error(`Chat processing failed: ${error}`)
    }
  }

  /**
   * Create ticket autonomously from conversation
   */
  async createTicketFromConversation(params: {
    conversationId: string
    context: Context
    triggerType: 'manual' | 'autonomous' | 'suggested'
    customParams?: TicketCreationParams
  }): Promise<TicketCreationResult> {
    try {
      console.log('🎫 Creating ticket from conversation...')

      const session = this.activeConversations.get(params.conversationId)
      if (!session) {
        throw new Error(`Conversation session not found: ${params.conversationId}`)
      }

      // Analyze conversation for ticket creation
      const analysisResult = await this.conversationIntelligence.analyzeConversation(params.context)
      const ticketAnalysis = (analysisResult as any).analysis;

      // Create ticket using autonomous agent
      const ticketResult = await this.ticketAgent.createTicketAutonomously({
        context: params.context,
        conversationAnalysis: ticketAnalysis,
        confidence: ticketAnalysis.confidence,
        urgency: params.customParams?.urgency
      })

      // Update session with ticket creation
      if (ticketResult.success && ticketResult.ticket) {
        session.createdTickets.push({
          ticketId: ticketResult.ticket.id,
          createdAt: new Date().toISOString(),
          confidence: ticketResult.confidence || 0.8,
          triggerType: params.triggerType
        })
      }

      this.emit('ticket_created_from_chat', {
        conversationId: params.conversationId,
        ticketResult,
        triggerType: params.triggerType
      })

      return ticketResult as TicketCreationResult

    } catch (error) {
      console.error('❌ Ticket creation from conversation failed:', error)
      throw error
    }
  }

  /**
   * Create task autonomously from conversation
   */
  async createTaskFromConversation(params: {
    conversationId: string
    context: Context
    triggerType: 'manual' | 'autonomous' | 'suggested'
    customParams?: TaskCreationParams
  }): Promise<TaskCreationResult> {
    try {
      console.log('📋 Creating task from conversation...')

      const session = this.activeConversations.get(params.conversationId)
      if (!session) {
        throw new Error(`Conversation session not found: ${params.conversationId}`)
      }

      // Extract task requirements from conversation
      const taskDescription = await this.conversationIntelligence.extractTaskDescription({
        messages: session.messages,
        context: params.context
      })

      // Create task using autonomous agent
      const taskResult = await this.taskAgent.createTaskAutonomously({
        context: params.context,
        description: taskDescription.description,
        parentTicket: params.customParams?.parentTicket,
        confidence: taskDescription.confidence,
        urgency: params.customParams?.urgency
      })

      // Update session with task creation
      if (taskResult.success && taskResult.task) {
        session.createdTasks.push({
          taskId: taskResult.task.id,
          createdAt: new Date().toISOString(),
          confidence: taskResult.confidence || 0.8,
          triggerType: params.triggerType
        })
      }

      this.emit('task_created_from_chat', {
        conversationId: params.conversationId,
        taskResult,
        triggerType: params.triggerType
      })

      return taskResult as TaskCreationResult

    } catch (error) {
      console.error('❌ Task creation from conversation failed:', error)
      throw error
    }
  }

  /**
   * Generate code from conversation
   */
  async generateCodeFromConversation(params: {
    conversationId: string
    context: Context
    codeRequirements?: CodeGenerationRequirements
  }): Promise<CodeGenerationResult> {
    try {
      console.log('💻 Generating code from conversation...')

      const session = this.activeConversations.get(params.conversationId)
      if (!session) {
        throw new Error(`Conversation session not found: ${params.conversationId}`)
      }

      // Extract code requirements from conversation
      const codeRequirements = await this.conversationIntelligence.extractCodeRequirements({
        messages: session.messages,
        context: params.context
      })

      // Generate code using autonomous agent
      const codeResult = await this.codeAgent.generateCodeAutonomously({
        requirements: {
          id: randomUUID(),
          description: codeRequirements.description,
          targetLanguage: codeRequirements.language,
          examples: codeRequirements.examples,
          constraints: codeRequirements.constraints
        },
        context: params.context,
        constraints: params.codeRequirements?.constraints,
        targetLanguage: params.codeRequirements?.targetLanguage,
        style: params.codeRequirements?.style
      })

      // Update session with code generation
      if (codeResult.success) {
        session.generatedCode.push({
          codeId: randomUUID(),
          createdAt: new Date().toISOString(),
          language: codeRequirements.language,
          confidence: codeResult.confidence || 0.8
        })
      }

      this.emit('code_generated_from_chat', {
        conversationId: params.conversationId,
        codeResult
      })

      return codeResult

    } catch (error) {
      console.error('❌ Code generation from conversation failed:', error)
      throw error
    }
  }

  /**
   * Get conversation insights and recommendations
   */
  async getConversationInsights(conversationId: string): Promise<ConversationInsights> {
    try {
      const session = this.activeConversations.get(conversationId)
      if (!session) {
        throw new Error(`Conversation session not found: ${conversationId}`)
      }

      // Get comprehensive analysis
      const analysis = await this.conversationIntelligence.analyzeConversation(session.context)

      // Generate actionable insights
      const actionableItems = await this.identifyActionableItems(analysis, session)
      const improvementSuggestions = await this.generateImprovementSuggestions(analysis, session)
      const nextSteps = await this.suggestNextSteps(analysis, session)

      return {
        conversationId,
        analysis,
        actionableItems,
        improvementSuggestions,
        nextSteps,
        sessionSummary: this.generateSessionSummary(session),
        recommendedActions: await this.recommendActions(analysis, session)
      }
    } catch (error) {
      console.error(`❌ Failed to get insights for conversation ${conversationId}:`, error)
      throw error
    }
  }

  /**
   * Get integration performance metrics and insights
   */
  getIntegrationMetrics(): ChatIntegrationInsights {
    return {
      metrics: { ...this.integrationMetrics },
      activeConversations: this.activeConversations.size,
      conversationInsights: this.getAggregateConversationInsights(),
      performanceInsights: this.getPerformanceInsights(),
      recommendations: this.generateIntegrationRecommendations()
    }
  }

  /**
   * Configure integration behavior
   */
  async configureIntegration(config: ChatIntegrationConfig): Promise<void> {
    // Update autonomous thresholds
    if (config.autonomyThresholds) {
      const current = typeof this.config.confidenceThreshold === 'object'
        ? this.config.confidenceThreshold
        : { low: this.config.confidenceThreshold, medium: this.config.confidenceThreshold, high: this.config.confidenceThreshold }
      this.config.confidenceThreshold = {
        ...current,
        ...config.autonomyThresholds
      }
    }

    // Update agent behaviors
    if (config.agentBehaviors) {
      // Configure individual agents based on settings
      await this.updateAgentConfigurations(config.agentBehaviors)
    }

    // Update integration preferences
    if (config.integrationPreferences) {
      await this.updateIntegrationPreferences(config.integrationPreferences)
    }

    this.emit('integration_configured', config)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private async getOrCreateConversationSession(conversationId: string, context: Context): Promise<ConversationSession> {
    let session = this.activeConversations.get(conversationId)

    if (!session) {
      session = {
        conversationId,
        context,
        messages: [],
        createdTickets: [],
        createdTasks: [],
        generatedCode: [],
        startTime: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        metrics: {
          messageCount: 0,
          analysisCount: 0,
          actionsExecuted: 0,
          averageConfidence: 0
        }
      }

      this.activeConversations.set(conversationId, session)
    }

    return session
  }

  private async updateConversationContext(session: ConversationSession, message: ChatMessage, context: Context): Promise<void> {
    session.messages.push(message)
    session.context = context // Update with latest context
    session.lastActivity = new Date().toISOString()
    session.metrics.messageCount++
  }

  private async makeActionDecisions(params: {
    analysis: any
    session: ConversationSession
    context: Context
    userPreferences?: UserPreferences
  }): Promise<ActionDecision[]> {
    const decisions: ActionDecision[] = []
    const { analysis, session, context, userPreferences } = params

    // Decision: Should create ticket?
    if (analysis.actionableInsights.ticketCreationSuggested &&
      analysis.confidence > this.config.confidenceThreshold) {

      const shouldCreate = await this.shouldCreateTicketAutonomously(analysis, userPreferences)
      decisions.push({
        type: 'create_ticket',
        confidence: analysis.confidence,
        reasoning: analysis.actionableInsights.ticketCreationReasoning,
        shouldExecute: shouldCreate.shouldExecute,
        executionMode: shouldCreate.executionMode,
        parameters: shouldCreate.parameters
      })
    }

    // Decision: Should create task?
    if (analysis.actionableInsights.taskCreationSuggested &&
      analysis.confidence > this.config.confidenceThreshold) {

      const shouldCreate = await this.shouldCreateTaskAutonomously(analysis, userPreferences)
      decisions.push({
        type: 'create_task',
        confidence: analysis.confidence,
        reasoning: analysis.actionableInsights.taskCreationReasoning,
        shouldExecute: shouldCreate.shouldExecute,
        executionMode: shouldCreate.executionMode,
        parameters: shouldCreate.parameters
      })
    }

    // Decision: Should generate code?
    if (analysis.actionableInsights.codeGenerationSuggested &&
      analysis.confidence > this.config.confidenceThreshold) {

      const shouldGenerate = await this.shouldGenerateCodeAutonomously(analysis, userPreferences)
      decisions.push({
        type: 'generate_code',
        confidence: analysis.confidence,
        reasoning: analysis.actionableInsights.codeGenerationReasoning,
        shouldExecute: shouldGenerate.shouldExecute,
        executionMode: shouldGenerate.executionMode,
        parameters: shouldGenerate.parameters
      })
    }

    return decisions
  }

  private async executeAutonomousActions(params: {
    decisions: ActionDecision[]
    session: ConversationSession
    context: Context
    conversationAnalysis: any
  }): Promise<ExecutedAction[]> {
    const executedActions: ExecutedAction[] = []

    for (const decision of params.decisions) {
      if (decision.shouldExecute && decision.executionMode === 'autonomous') {
        try {
          let result: any

          switch (decision.type) {
            case 'create_ticket':
              result = await this.createTicketFromConversation({
                conversationId: params.session.conversationId,
                context: params.context,
                triggerType: 'autonomous',
                customParams: decision.parameters
              })
              break

            case 'create_task':
              result = await this.createTaskFromConversation({
                conversationId: params.session.conversationId,
                context: params.context,
                triggerType: 'autonomous',
                customParams: decision.parameters
              })
              break

            case 'generate_code':
              result = await this.generateCodeFromConversation({
                conversationId: params.session.conversationId,
                context: params.context,
                codeRequirements: decision.parameters
              })
              break

            default:
              console.warn(`Unknown action type: ${decision.type}`)
              continue
          }

          executedActions.push({
            type: decision.type,
            result,
            confidence: decision.confidence,
            executionTime: new Date().toISOString(),
            success: result.success || result.success !== false
          })

          params.session.metrics.actionsExecuted++

        } catch (error) {
          console.error(`Failed to execute action ${decision.type}:`, error)
          executedActions.push({
            type: decision.type,
            result: { success: false, error: (error instanceof Error ? error.message : String(error)) },
            confidence: decision.confidence,
            executionTime: new Date().toISOString(),
            success: false
          })
        }
      }
    }

    return executedActions
  }

  private async generateResponseSuggestions(params: {
    analysis: any
    session: ConversationSession
    context: Context
    executedActions: ExecutedAction[]
  }): Promise<ResponseSuggestion[]> {
    const suggestions: ResponseSuggestion[] = []

    // Suggest based on analysis intent
    if (params.analysis.intent.primary === 'help_request') {
      suggestions.push({
        type: 'helpful_response',
        content: 'I can help you with that. Let me analyze what you need and suggest the best approach.',
        confidence: 0.8,
        reasoning: 'User is requesting help'
      })
    }

    // Suggest based on executed actions
    for (const action of params.executedActions) {
      if (action.success && action.type === 'create_ticket') {
        suggestions.push({
          type: 'confirmation',
          content: `I've created a ticket for you based on our conversation. You can track its progress in the project dashboard.`,
          confidence: 0.9,
          reasoning: 'Ticket was successfully created'
        })
      }

      if (action.success && action.type === 'create_task') {
        suggestions.push({
          type: 'confirmation',
          content: `I've broken this down into a task with subtasks for easier execution. The task includes estimated effort and timeline.`,
          confidence: 0.9,
          reasoning: 'Task was successfully created'
        })
      }
    }

    // Suggest follow-up actions
    if (params.analysis.actionableInsights.followUpSuggested) {
      suggestions.push({
        type: 'follow_up',
        content: `Would you like me to ${params.analysis.actionableInsights.suggestedFollowUp}?`,
        confidence: params.analysis.confidence,
        reasoning: 'Analysis suggests beneficial follow-up action'
      })
    }

    return suggestions
  }

  private async generateAutonomousRecommendations(analysis: any, context: Context): Promise<AutonomousRecommendation[]> {
    const recommendations: AutonomousRecommendation[] = []

    // Process improvement recommendations
    if (analysis.conversation.patterns?.repetitiveIssues) {
      recommendations.push({
        type: 'process_improvement',
        priority: 'medium',
        title: 'Address Repetitive Issues',
        description: 'I notice similar issues coming up repeatedly. Consider creating a knowledge base or process improvement.',
        actionable: true,
        estimatedImpact: 'medium'
      })
    }

    // Automation recommendations
    if (analysis.conversation.patterns?.automationOpportunities) {
      recommendations.push({
        type: 'automation',
        priority: 'high',
        title: 'Automation Opportunities Detected',
        description: 'Some of the tasks discussed could be automated to save time and reduce errors.',
        actionable: true,
        estimatedImpact: 'high'
      })
    }

    // Knowledge gaps
    if (analysis.conversation.gaps?.knowledge) {
      recommendations.push({
        type: 'knowledge_management',
        priority: 'medium',
        title: 'Knowledge Gap Identified',
        description: 'Consider documenting the solution for future reference.',
        actionable: true,
        estimatedImpact: 'medium'
      })
    }

    return recommendations
  }

  private resolveThreshold(): { low: number; medium: number; high: number } {
    const ct = this.config.confidenceThreshold
    return typeof ct === 'object' ? ct : { low: ct, medium: ct, high: ct }
  }

  private async shouldCreateTicketAutonomously(analysis: any, preferences?: UserPreferences): Promise<ExecutionDecision> {
    // Check user preferences
    if (preferences?.disableAutonomousTicketCreation) {
      return {
        shouldExecute: false,
        executionMode: 'suggested',
        parameters: {},
        reasoning: 'User has disabled autonomous ticket creation'
      }
    }

    const threshold = this.resolveThreshold()

    // Check confidence threshold
    if (analysis.confidence < threshold.high) {
      return {
        shouldExecute: false,
        executionMode: 'suggested',
        parameters: {},
        reasoning: 'Confidence below threshold for autonomous execution'
      }
    }

    // Check urgency and context
    const urgency = analysis.urgency || 'medium'
    return {
      shouldExecute: urgency !== 'low',
      executionMode: urgency === 'critical' ? 'autonomous' : 'suggested',
      parameters: { urgency },
      reasoning: `${urgency} urgency level ${urgency === 'critical' ? 'requires' : 'suggests'} autonomous action`
    }
  }

  private async shouldCreateTaskAutonomously(analysis: any, preferences?: UserPreferences): Promise<ExecutionDecision> {
    if (preferences?.disableAutonomousTaskCreation) {
      return {
        shouldExecute: false,
        executionMode: 'suggested',
        parameters: {},
        reasoning: 'User has disabled autonomous task creation'
      }
    }

    const threshold = this.resolveThreshold()

    return {
      shouldExecute: analysis.confidence > threshold.medium,
      executionMode: analysis.confidence > threshold.high ? 'autonomous' : 'suggested',
      parameters: {},
      reasoning: 'Task creation confidence meets threshold'
    }
  }

  private async shouldGenerateCodeAutonomously(analysis: any, preferences?: UserPreferences): Promise<ExecutionDecision> {
    if (preferences?.disableAutonomousCodeGeneration) {
      return {
        shouldExecute: false,
        executionMode: 'manual',
        parameters: {},
        reasoning: 'User has disabled autonomous code generation'
      }
    }

    const threshold = this.resolveThreshold()

    return {
      shouldExecute: analysis.confidence > threshold.medium && analysis.codeComplexity !== 'expert',
      executionMode: 'suggested', // Code generation should usually be suggested, not fully autonomous
      parameters: {},
      reasoning: 'Code generation should be user-confirmed for safety'
    }
  }

  private setupEventListeners(): void {
    // Listen to agent events
    this.ticketAgent.on('ticket_created_autonomously', (event) => {
      this.emit('autonomous_ticket_created', event)
    })

    this.taskAgent.on('task_created_autonomously', (event) => {
      this.emit('autonomous_task_created', event)
    })

    this.codeAgent.on('code_generated_autonomously', (event) => {
      this.emit('autonomous_code_generated', event)
    })

    // Listen to conversation intelligence events
    this.conversationIntelligence.on('conversation_analyzed', (event) => {
      this.emit('conversation_intelligence_update', event)
    })
  }

  private updateSessionMetrics(session: ConversationSession, analysis: any, actions: ExecutedAction[]): void {
    session.metrics.analysisCount++
    session.metrics.averageConfidence =
      (session.metrics.averageConfidence + analysis.confidence) / session.metrics.analysisCount
  }

  private updateIntegrationMetrics(success: boolean, duration: number): void {
    this.integrationMetrics.totalProcessingRequests++
    this.integrationMetrics.averageProcessingTime =
      (this.integrationMetrics.averageProcessingTime + duration) / this.integrationMetrics.totalProcessingRequests

    if (success) {
      this.integrationMetrics.successfulRequests++
      this.integrationMetrics.successRate =
        this.integrationMetrics.successfulRequests / this.integrationMetrics.totalProcessingRequests
    }
  }

  private getSessionInsights(session: ConversationSession): SessionInsights {
    return {
      messageCount: session.metrics.messageCount,
      averageConfidence: session.metrics.averageConfidence,
      actionsExecuted: session.metrics.actionsExecuted,
      ticketsCreated: session.createdTickets.length,
      tasksCreated: session.createdTasks.length,
      codeGenerated: session.generatedCode.length,
      sessionDuration: Date.now() - new Date(session.startTime).getTime(),
      lastActivity: session.lastActivity
    }
  }

  private async identifyActionableItems(analysis: any, session: ConversationSession): Promise<ActionableItem[]> {
    const items: ActionableItem[] = []

    if (analysis.actionableInsights.ticketCreationSuggested) {
      items.push({
        type: 'ticket_creation',
        description: 'Create ticket for the issue discussed',
        priority: analysis.urgency === 'critical' ? 'high' : 'medium',
        confidence: analysis.confidence,
        estimatedEffort: 'low'
      })
    }

    if (analysis.actionableInsights.taskCreationSuggested) {
      items.push({
        type: 'task_creation',
        description: 'Break down the work into manageable tasks',
        priority: 'medium',
        confidence: analysis.confidence,
        estimatedEffort: 'low'
      })
    }

    return items
  }

  private async generateImprovementSuggestions(analysis: any, session: ConversationSession): Promise<string[]> {
    const suggestions: string[] = []

    if (analysis.conversation.clarity < 0.7) {
      suggestions.push('Consider providing more specific details about requirements')
    }

    if (session.metrics.messageCount > 20 && session.createdTickets.length === 0) {
      suggestions.push('Long discussion without actionable outcomes - consider creating tickets or tasks')
    }

    return suggestions
  }

  private async suggestNextSteps(analysis: any, session: ConversationSession): Promise<string[]> {
    const nextSteps: string[] = []

    if (analysis.actionableInsights.followUpSuggested) {
      nextSteps.push(analysis.actionableInsights.suggestedFollowUp)
    }

    if (session.createdTickets.length > 0) {
      nextSteps.push('Track ticket progress and provide updates')
    }

    if (session.createdTasks.length > 0) {
      nextSteps.push('Begin task execution and monitor progress')
    }

    return nextSteps
  }

  private generateSessionSummary(session: ConversationSession): string {
    const parts = []

    parts.push(`Conversation with ${session.metrics.messageCount} messages`)

    if (session.createdTickets.length > 0) {
      parts.push(`${session.createdTickets.length} ticket(s) created`)
    }

    if (session.createdTasks.length > 0) {
      parts.push(`${session.createdTasks.length} task(s) created`)
    }

    if (session.generatedCode.length > 0) {
      parts.push(`${session.generatedCode.length} code generation(s)`)
    }

    return parts.join(', ')
  }

  private async recommendActions(analysis: any, session: ConversationSession): Promise<string[]> {
    const actions: string[] = []

    if (analysis.actionableInsights.ticketCreationSuggested && session.createdTickets.length === 0) {
      actions.push('Create ticket for tracking')
    }

    if (analysis.actionableInsights.taskCreationSuggested && session.createdTasks.length === 0) {
      actions.push('Break down into tasks')
    }

    if (analysis.conversation.patterns?.documentation_needed) {
      actions.push('Document the solution for future reference')
    }

    return actions
  }

  private getAggregateConversationInsights(): any {
    const totalSessions = this.activeConversations.size
    if (totalSessions === 0) return {}

    let totalMessages = 0
    let totalTickets = 0
    let totalTasks = 0
    let avgConfidence = 0

    for (const session of this.activeConversations.values()) {
      totalMessages += session.metrics.messageCount
      totalTickets += session.createdTickets.length
      totalTasks += session.createdTasks.length
      avgConfidence += session.metrics.averageConfidence
    }

    return {
      totalActiveSessions: totalSessions,
      avgMessagesPerSession: totalMessages / totalSessions,
      avgTicketsPerSession: totalTickets / totalSessions,
      avgTasksPerSession: totalTasks / totalSessions,
      overallAvgConfidence: avgConfidence / totalSessions
    }
  }

  private getPerformanceInsights(): string[] {
    const insights: string[] = []

    if (this.integrationMetrics.successRate < 0.95) {
      insights.push('Integration success rate could be improved')
    }

    if (this.integrationMetrics.averageProcessingTime > 5000) {
      insights.push('Processing time is above optimal threshold')
    }

    if (this.integrationMetrics.autonomousActionsExecuted / Math.max(1, this.integrationMetrics.totalProcessingRequests) > 0.8) {
      insights.push('High autonomous action rate - users are trusting the system')
    }

    return insights
  }

  private generateIntegrationRecommendations(): string[] {
    const recommendations: string[] = []

    if (this.activeConversations.size > 100) {
      recommendations.push('Consider implementing conversation cleanup for better performance')
    }

    if (this.integrationMetrics.averageProcessingTime > 3000) {
      recommendations.push('Optimize processing pipeline for better response times')
    }

    return recommendations
  }

  private async updateAgentConfigurations(behaviors: any): Promise<void> {
    // Update agent behaviors based on configuration
    // This would involve calling agent-specific configuration methods
  }

  private async updateIntegrationPreferences(preferences: any): Promise<void> {
    // Update integration-specific preferences
    // This could include response formatting, automation levels, etc.
  }

  private initializeMetrics(): ChatIntegrationMetrics {
    return {
      totalProcessingRequests: 0,
      successfulRequests: 0,
      successRate: 0,
      averageProcessingTime: 0,
      totalConversationsProcessed: 0,
      autonomousActionsExecuted: 0,
      ticketsCreatedViaChat: 0,
      tasksCreatedViaChat: 0,
      codeGeneratedViaChat: 0
    }
  }
}

// Supporting Interfaces
interface ChatMessage {
  id: string
  content: string
  role: 'user' | 'assistant' | 'system'
  timestamp: string
  metadata?: Record<string, any>
}

interface ConversationSession {
  conversationId: string
  context: Context
  messages: ChatMessage[]
  createdTickets: Array<{
    ticketId: string
    createdAt: string
    confidence: number
    triggerType: 'manual' | 'autonomous' | 'suggested'
  }>
  createdTasks: Array<{
    taskId: string
    createdAt: string
    confidence: number
    triggerType: 'manual' | 'autonomous' | 'suggested'
  }>
  generatedCode: Array<{
    codeId: string
    createdAt: string
    language: string
    confidence: number
  }>
  startTime: string
  lastActivity: string
  metrics: {
    messageCount: number
    analysisCount: number
    actionsExecuted: number
    averageConfidence: number
  }
}

interface ChatProcessingResult {
  conversationId: string
  analysis: any
  executedActions: ExecutedAction[]
  responseSuggestions: ResponseSuggestion[]
  autonomousRecommendations: AutonomousRecommendation[]
  sessionInsights: SessionInsights
  processingTime: number
}

interface ActionDecision {
  type: 'create_ticket' | 'create_task' | 'generate_code'
  confidence: number
  reasoning: string
  shouldExecute: boolean
  executionMode: 'autonomous' | 'suggested' | 'manual'
  parameters: Record<string, any>
}

interface ExecutedAction {
  type: string
  result: any
  confidence: number
  executionTime: string
  success: boolean
}

interface ExecutionDecision {
  shouldExecute: boolean
  executionMode: 'autonomous' | 'suggested' | 'manual'
  parameters: Record<string, any>
  reasoning: string
}

interface ResponseSuggestion {
  type: 'helpful_response' | 'confirmation' | 'follow_up' | 'clarification'
  content: string
  confidence: number
  reasoning: string
}

interface AutonomousRecommendation {
  type: 'process_improvement' | 'automation' | 'knowledge_management' | 'optimization'
  priority: 'low' | 'medium' | 'high'
  title: string
  description: string
  actionable: boolean
  estimatedImpact: 'low' | 'medium' | 'high'
}

interface SessionInsights {
  messageCount: number
  averageConfidence: number
  actionsExecuted: number
  ticketsCreated: number
  tasksCreated: number
  codeGenerated: number
  sessionDuration: number
  lastActivity: string
}

interface ConversationInsights {
  conversationId: string
  analysis: any
  actionableItems: ActionableItem[]
  improvementSuggestions: string[]
  nextSteps: string[]
  sessionSummary: string
  recommendedActions: string[]
}

interface ActionableItem {
  type: string
  description: string
  priority: 'low' | 'medium' | 'high'
  confidence: number
  estimatedEffort: 'low' | 'medium' | 'high'
}

interface UserPreferences {
  disableAutonomousTicketCreation?: boolean
  disableAutonomousTaskCreation?: boolean
  disableAutonomousCodeGeneration?: boolean
  preferredConfidenceThreshold?: number
  autonomyLevel?: 'conservative' | 'balanced' | 'aggressive'
}

interface TicketCreationParams {
  urgency?: 'low' | 'medium' | 'high' | 'critical'
  priority?: 'low' | 'medium' | 'high' | 'critical'
  assignee?: string
  labels?: string[]
}

interface TaskCreationParams {
  parentTicket?: string
  urgency?: 'low' | 'medium' | 'high' | 'critical'
  assignee?: string
  maxSubtasks?: number
}

interface CodeGenerationRequirements {
  targetLanguage?: string
  style?: 'conservative' | 'standard' | 'innovative'
  constraints?: any
}

interface ChatIntegrationMetrics {
  totalProcessingRequests: number
  successfulRequests: number
  successRate: number
  averageProcessingTime: number
  totalConversationsProcessed: number
  autonomousActionsExecuted: number
  ticketsCreatedViaChat: number
  tasksCreatedViaChat: number
  codeGeneratedViaChat: number
}

interface ChatIntegrationInsights {
  metrics: ChatIntegrationMetrics
  activeConversations: number
  conversationInsights: any
  performanceInsights: string[]
  recommendations: string[]
}

interface ChatIntegrationConfig {
  autonomyThresholds?: {
    low?: number
    medium?: number
    high?: number
  }
  agentBehaviors?: Record<string, any>
  integrationPreferences?: Record<string, any>
}

// Re-export types for convenience
export type {
  ChatMessage,
  ConversationSession,
  ChatProcessingResult,
  ConversationInsights,
  UserPreferences,
  ChatIntegrationConfig,
  ChatIntegrationInsights
}
