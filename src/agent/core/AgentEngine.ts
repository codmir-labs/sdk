/**
 * AgentEngine - Core autonomous decision-making engine
 * 
 * The brain of the Agent SDK that orchestrates all decision-making,
 * planning, and action execution with configurable autonomy levels.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

import type {
  AgentConfig,
  Context,
  Decision,
  Plan,
  Action,
  ActionResult,
  DecisionOptions,
  DecisionResult,
  PlanResult,
  PlanObjective,
  ActionType,
  ActionStatus,
  AutonomyMode
} from '../types'

import { ContextManager } from './ContextManager'
import { PlanningEngine } from './PlanningEngine'
import { ActionExecutor } from './ActionExecutor'
import { LearningSystem } from './LearningSystem'

/**
 * AgentEngine - "Autonomous Decision Maker"
 * 
 * Philosophy: Make smart decisions quickly, act with confidence,
 * learn from everything, and don't overthink.
 */
export class AgentEngine extends EventEmitter {
  private config: AgentConfig
  private contextManager: ContextManager
  private planningEngine: PlanningEngine
  private actionExecutor: ActionExecutor
  private learningSystem: LearningSystem

  // State Management
  private currentContext?: Context
  private activePlans = new Map<string, Plan>()
  private pendingActions = new Map<string, Action>()
  private recentDecisions: Decision[] = []

  // Performance Tracking
  private metrics = {
    decisionsPerMinute: 0,
    actionsExecuted: 0,
    successRate: 0,
    averageConfidence: 0,
    learningEventsGenerated: 0
  }

  private isInitialized = false
  private sessionId = randomUUID()

  constructor(config: Partial<AgentConfig> = {}) {
    super()

    this.config = {
      autonomyMode: 'balanced',
      confidenceThreshold: 0.7,
      learningEnabled: true,
      contextDepth: 'deep',
      planningHorizon: 'strategic',
      maxActionsPerMinute: 60,
      maxConcurrentTasks: 5,
      safetyChecksEnabled: true,
      humanApprovalRequired: ['deploy', 'delete', 'external_api'],
      features: {
        conversationIntelligence: true,
        codebaseAnalysis: true,
        automaticTaskCreation: true,
        proactiveTicketGeneration: true,
        strategicPlanning: true,
        learningFromFailures: true
      },
      learning: {
        memoryRetentionDays: 30,
        patternRecognitionEnabled: true,
        successMetricsTracking: true,
        failureAnalysisEnabled: true
      },
      ...config
    }

    // Initialize core systems
    this.contextManager = new ContextManager(this.config)
    this.planningEngine = new PlanningEngine(this.config)
    this.actionExecutor = new ActionExecutor(this.config)
    this.learningSystem = new LearningSystem(this.config)

    this.setupEventHandlers()
  }

  /**
   * Initialize the Agent Engine
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    console.log(`🧠 Initializing Agent Engine (mode: ${this.config.autonomyMode})`)

    // Initialize all subsystems
    await this.contextManager.initialize()
    await this.planningEngine.initialize()
    await this.actionExecutor.initialize()
    await this.learningSystem.initialize()

    // Load existing learnings
    if (this.config.learningEnabled) {
      await this.learningSystem.loadMemory()
    }

    this.isInitialized = true

    this.emit('initialized', {
      sessionId: this.sessionId,
      config: this.config,
      capabilities: this.getCapabilities()
    })

    console.log(`✅ Agent Engine ready - ${this.getCapabilities().length} capabilities available`)
  }

  /**
   * Main Intelligence Loop - Process input and take autonomous action
   */
  async processInput(input: {
    type: 'conversation' | 'event' | 'data' | 'request'
    content: any
    context?: Partial<Context>
    urgency?: 'low' | 'medium' | 'high' | 'critical'
  }): Promise<{
    decisions: Decision[]
    actions: Action[]
    plans: Plan[]
    learnings: any[]
    confidence: number
  }> {
    const startTime = Date.now()

    try {
      // 1. Build Rich Context
      console.log(`🔍 Building context for ${input.type} input...`)
      const context = await this.contextManager.buildContext({
        input,
        existingContext: input.context,
        depth: this.config.contextDepth
      })

      this.currentContext = context
      this.emit('context_built', { context, duration: Date.now() - startTime })

      // 2. Analyze and Make Decisions
      console.log('🤔 Analyzing situation and making decisions...')
      const decisions = await this.makeDecisions(context, input.urgency || 'medium')
      this.recentDecisions.push(...decisions)

      // Keep recent decisions manageable
      if (this.recentDecisions.length > 100) {
        this.recentDecisions = this.recentDecisions.slice(-50)
      }

      // 3. Generate Strategic Plans (if needed)
      let plans: Plan[] = []
      if (this.shouldCreatePlan(context, decisions)) {
        console.log('📋 Creating strategic plan...')
        const plan = await this.planningEngine.createPlan({
          context,
          decisions,
          horizon: this.config.planningHorizon
        })
        plans = [plan]
        this.activePlans.set(plan.id, plan)
      }

      // 4. Execute Actions Autonomously
      console.log('⚡ Executing autonomous actions...')
      const actions = await this.executeActions(decisions, context)

      // 5. Generate Learnings
      let learnings: any[] = []
      if (this.config.learningEnabled) {
        learnings = await this.learningSystem.extractLearnings({
          context,
          decisions,
          actions,
          plans
        })

        // Apply learnings immediately
        await this.learningSystem.applyLearnings(learnings)
      }

      // 6. Calculate Overall Confidence
      const confidence = this.calculateOverallConfidence(decisions, actions)

      // 7. Update Metrics
      this.updateMetrics(decisions, actions, confidence)

      const result = {
        decisions,
        actions,
        plans,
        learnings,
        confidence
      }

      this.emit('processing_complete', {
        ...result,
        duration: Date.now() - startTime,
        context
      })

      return result

    } catch (error) {
      console.error('❌ Agent Engine processing failed:', error)

      // Learn from failures
      if (this.config.learningEnabled) {
        await this.learningSystem.learnFromFailure({
          error: error instanceof Error ? error.message : String(error),
          context: this.currentContext,
          input
        })
      }

      throw error
    }
  }

  /**
   * Convenience method for backward compatibility
   */
  async makeAutonomousDecision(context: Context, options: any): Promise<any> {
    const result = await this.processInput({
      type: 'request',
      content: options,
      context
    })

    return {
      success: result.decisions.length > 0,
      decision: result.decisions[0],
      confidence: result.confidence,
      reasoning: result.decisions[0]?.reasoning || 'No decision could be made'
    }
  }

  /**
   * Convenience method for backward compatibility
   */
  async createExecutionPlan(objective: any, context: Context): Promise<any> {
    const result = await this.processInput({
      type: 'request',
      content: objective,
      context
    })

    return {
      success: result.plans.length > 0,
      plan: result.plans[0],
      confidence: result.confidence,
      reasoning: result.plans[0]?.description || 'No plan could be generated'
    }
  }


  /**
   * Make autonomous decisions based on context
   */
  private async makeDecisions(context: Context, urgency: string): Promise<Decision[]> {
    const decisions: Decision[] = []

    // Analyze conversation intent and generate decisions
    if (context.conversation) {
      const conversationDecisions = await this.analyzeConversationIntent(context)
      decisions.push(...conversationDecisions)
    }

    // Analyze project state and generate proactive decisions
    if (context.project) {
      const projectDecisions = await this.analyzeProjectState(context)
      decisions.push(...projectDecisions)
    }

    // Apply urgency weighting
    decisions.forEach(decision => {
      decision.confidence = this.adjustConfidenceForUrgency(decision.confidence, urgency)
    })

    // Filter by confidence threshold
    const threshold = typeof this.config.confidenceThreshold === 'object'
      ? this.config.confidenceThreshold.medium
      : this.config.confidenceThreshold
    const confidentDecisions = decisions.filter(d =>
      d.confidence >= threshold ||
      urgency === 'critical'
    )

    this.emit('decisions_made', { decisions: confidentDecisions, totalConsidered: decisions.length })

    return confidentDecisions
  }

  /**
   * Analyze conversation to understand what the user needs
   */
  private async analyzeConversationIntent(context: Context): Promise<Decision[]> {
    const decisions: Decision[] = []
    const { conversation } = context

    // Ticket Creation Decision
    if (this.shouldCreateTicket(conversation)) {
      decisions.push({
        id: randomUUID(),
        question: 'Should I create a ticket for this issue?',
        options: [
          {
            id: 'create_ticket',
            title: 'Create Ticket',
            description: 'Create a detailed ticket based on the conversation',
            pros: ['Tracks the issue', 'Enables collaboration', 'Provides structure'],
            cons: ['Might be premature', 'Could duplicate existing tickets'],
            effort: 2,
            risk: 1,
            confidence: 0.85,
            estimatedOutcome: 'Well-structured ticket ready for development'
          },
          {
            id: 'gather_more_info',
            title: 'Gather More Information',
            description: 'Ask clarifying questions before creating ticket',
            pros: ['Better ticket quality', 'Avoids misunderstanding'],
            cons: ['Delays action', 'User might lose context'],
            effort: 1,
            risk: 2,
            confidence: 0.6,
            estimatedOutcome: 'More detailed requirements but delayed action'
          }
        ],
        chosen: 'create_ticket',
        reasoning: 'User has provided sufficient context and shows clear intent to address an issue. Creating a ticket maintains momentum and provides structure.',
        confidence: 0.85,
        context,
        factors: [
          { name: 'clarity_of_request', importance: 0.9, value: 0.8, reasoning: 'User request is clear and actionable' },
          { name: 'urgency_signals', importance: 0.7, value: 0.7, reasoning: 'Some urgency indicators present' },
          { name: 'completeness', importance: 0.8, value: 0.75, reasoning: 'Most required info available' }
        ],
        constraints: [],
        tradeoffs: [
          {
            giving_up: 'Perfect information',
            getting: 'Quick action and momentum',
            worthIt: true,
            reasoning: 'Better to act with good info than wait for perfect info'
          }
        ],
        expectedOutcome: 'User gets structured task tracking and development can begin',
        madeAt: new Date().toISOString(),
        madeBy: 'agent_engine'
      })
    }

    // Task Creation Decision
    if (this.shouldCreateTask(conversation)) {
      decisions.push({
        id: randomUUID(),
        question: 'Should I create a development task?',
        options: [
          {
            id: 'create_task',
            title: 'Create Development Task',
            description: 'Create a structured task with subtasks and timeline',
            pros: ['Breaks down complexity', 'Provides roadmap', 'Enables tracking'],
            cons: ['Might over-engineer', 'Could be premature'],
            effort: 3,
            risk: 1,
            confidence: 0.8,
            estimatedOutcome: 'Well-structured development roadmap'
          }
        ],
        chosen: 'create_task',
        reasoning: 'Conversation indicates complex work that benefits from structured breakdown',
        confidence: 0.8,
        context,
        factors: [
          { name: 'complexity', importance: 0.9, value: 0.8, reasoning: 'Task has multiple components' },
          { name: 'planning_needed', importance: 0.8, value: 0.9, reasoning: 'Work requires coordination' }
        ],
        constraints: [],
        tradeoffs: [],
        expectedOutcome: 'Organized development process with clear milestones',
        madeAt: new Date().toISOString(),
        madeBy: 'agent_engine'
      })
    }

    return decisions
  }

  /**
   * Analyze project state for proactive opportunities
   */
  private async analyzeProjectState(context: Context): Promise<Decision[]> {
    const decisions: Decision[] = []
    const { project } = context

    // Code Quality Decision
    if (project.codebaseAnalysis.issues.length > 0) {
      const criticalIssues = project.codebaseAnalysis.issues.filter(i => i.severity === 'critical')

      if (criticalIssues.length > 0) {
        decisions.push({
          id: randomUUID(),
          question: 'Should I create tickets for critical code issues?',
          options: [
            {
              id: 'create_issue_tickets',
              title: 'Create Issue Tickets',
              description: 'Create tickets for critical code issues found in analysis',
              pros: ['Addresses technical debt', 'Prevents future problems', 'Maintains code quality'],
              cons: ['Might interrupt current work', 'Could be overwhelming'],
              effort: 2,
              risk: 1,
              confidence: 0.9,
              estimatedOutcome: 'Critical issues tracked and prioritized'
            }
          ],
          chosen: 'create_issue_tickets',
          reasoning: 'Critical issues should be addressed promptly to prevent bigger problems',
          confidence: 0.9,
          context,
          factors: [
            { name: 'severity', importance: 1.0, value: 1.0, reasoning: 'Critical issues require immediate attention' },
            { name: 'impact', importance: 0.9, value: 0.8, reasoning: 'High impact on code quality and maintainability' }
          ],
          constraints: [],
          tradeoffs: [],
          expectedOutcome: 'Proactive issue resolution and improved code quality',
          madeAt: new Date().toISOString(),
          madeBy: 'agent_engine'
        })
      }
    }

    return decisions
  }

  /**
   * Execute actions based on decisions
   */
  private async executeActions(decisions: Decision[], context: Context): Promise<Action[]> {
    const actions: Action[] = []

    for (const decision of decisions) {
      // Convert decision to actions
      const decisionActions = await this.convertDecisionToActions(decision, context)

      for (const action of decisionActions) {
        // Check autonomy mode and confidence
        if (this.shouldExecuteAutonomously(action)) {
          try {
            console.log(`🚀 Executing autonomous action: ${action.title}`)
            const result = await this.actionExecutor.execute(action, context)
            action.status = result.success ? 'completed' : 'failed'
            action.result = result
            action.executedAt = new Date().toISOString()
            action.duration = Date.now() - new Date(action.createdAt).getTime()

            this.emit('action_executed', { action, result })
          } catch (error) {
            action.status = 'failed'
            action.result = {
              success: false,
              output: null,
              artifacts: [],
              confidence: 0,
              executionTime: 0,
              resourcesUsed: [],
              sideEffects: [],
              learnings: [{
                id: randomUUID(),
                type: 'failure',
                description: `Action failed: ${action.title}`,
                context: {
                  situation: 'action_execution',
                  factors: { action: action.type, error: error instanceof Error ? error.message : String(error) },
                  environment: { autonomy_mode: this.config.autonomyMode },
                  actors: ['agent_engine'],
                  timeframe: 'immediate'
                },
                whatHappened: `Failed to execute action: ${error instanceof Error ? error.message : String(error)}`,
                whyItHappened: 'Unknown - requires investigation',
                whatToDoNext: 'Review action parameters and retry with safer approach',
                confidence: 0.7,
                applicableContexts: [action.type],
                actionableInsights: ['Add better error handling', 'Validate inputs more thoroughly'],
                preventionMeasures: ['Pre-execution validation', 'Rollback mechanisms'],
                learnedAt: new Date().toISOString(),
                importance: 0.8,
                verified: false,
                timesApplied: 0,
                successRate: 0
              }]
            }

            console.error(`❌ Action failed: ${action.title}`, error)
            this.emit('action_failed', { action, error })
          }
        } else {
          // Requires human approval
          action.status = 'pending_approval'
          console.log(`⏳ Action requires approval: ${action.title}`)
          this.emit('approval_required', { action })
        }

        actions.push(action)
      }
    }

    return actions
  }

  /**
   * Convert decision to executable actions
   */
  private async convertDecisionToActions(decision: Decision, context: Context): Promise<Action[]> {
    const actions: Action[] = []
    const chosenOption = decision.options.find(o => o.id === decision.chosen)

    if (!chosenOption) {
      return actions
    }

    // Create actions based on chosen option
    switch (decision.chosen) {
      case 'create_ticket':
        actions.push({
          id: randomUUID(),
          type: 'create_ticket',
          title: 'Create Issue Ticket',
          description: 'Create a structured ticket based on conversation analysis',
          input: {
            contextId: context.conversation.id,
            requiredData: {
              title: this.extractTicketTitle(context),
              description: this.extractTicketDescription(context),
              priority: this.determinePriority(context),
              labels: this.extractLabels(context)
            },
            constraints: []
          },
          parameters: {
            projectId: context.project.id,
            conversationId: context.conversation.id,
            autoAssign: this.config.autonomyMode === 'autonomus'
          },
          status: 'planned',
          confidence: decision.confidence,
          requiredCapabilities: ['ticket_creation'],
          reasoning: decision.reasoning,
          alternatives: decision.options.filter(o => o.id !== decision.chosen).map(o => ({
            description: o.description,
            confidence: o.confidence,
            tradeoffs: [`Effort: ${o.effort}`, `Risk: ${o.risk}`],
            estimatedOutcome: o.estimatedOutcome
          })),
          risks: ['Might duplicate existing ticket', 'Could misinterpret requirements'],
          createdAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        })
        break

      case 'create_task':
        actions.push({
          id: randomUUID(),
          type: 'create_task',
          title: 'Create Development Task',
          description: 'Create a structured development task with breakdown',
          input: {
            contextId: context.conversation.id,
            requiredData: {
              title: this.extractTaskTitle(context),
              description: this.extractTaskDescription(context),
              subtasks: this.generateSubtasks(context),
              estimatedHours: this.estimateEffort(context)
            },
            constraints: []
          },
          parameters: {
            projectId: context.project.id,
            conversationId: context.conversation.id,
            createSubtasks: true
          },
          status: 'planned',
          confidence: decision.confidence,
          requiredCapabilities: ['task_creation', 'project_planning'],
          reasoning: decision.reasoning,
          alternatives: [],
          risks: ['Might over-complicate simple task', 'Estimates could be inaccurate'],
          createdAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 2
        })
        break

      case 'create_issue_tickets':
        // Create actions for each critical issue
        const criticalIssues = context.project.codebaseAnalysis.issues.filter(i => i.severity === 'critical')

        for (const issue of criticalIssues) {
          actions.push({
            id: randomUUID(),
            type: 'create_ticket',
            title: `Create Ticket for ${issue.type} Issue`,
            description: `Create ticket to address critical ${issue.type} issue in ${issue.file}`,
            input: {
              contextId: context.project.id,
              requiredData: {
                title: `Fix ${issue.type}: ${issue.description}`,
                description: `**Critical Issue Detected**\n\nFile: ${issue.file}\nLine: ${issue.line || 'N/A'}\n\nDescription: ${issue.description}\n\nSuggested Fix: ${issue.suggestion || 'To be determined'}`,
                priority: 'high',
                labels: ['bug', 'critical', issue.type]
              },
              constraints: []
            },
            parameters: {
              projectId: context.project.id,
              autoAssign: false,
              issueData: issue
            },
            status: 'planned',
            confidence: 0.9,
            requiredCapabilities: ['ticket_creation', 'code_analysis'],
            reasoning: 'Critical code issue requires immediate attention to prevent problems',
            alternatives: [],
            risks: ['Might not be actual issue', 'Could interrupt current work'],
            createdAt: new Date().toISOString(),
            retryCount: 0,
            maxRetries: 1
          })
        }
        break
    }

    return actions
  }

  /**
   * Determine if action should be executed autonomously
   */
  private shouldExecuteAutonomously(action: Action): boolean {
    // Check if action type requires human approval
    if (this.config.humanApprovalRequired.includes(action.type)) {
      return false
    }

    // Check confidence threshold
    const threshold = typeof this.config.confidenceThreshold === 'object'
      ? this.config.confidenceThreshold.medium
      : this.config.confidenceThreshold
    if (action.confidence < threshold) {
      return false
    }

    // Check autonomy mode
    switch (this.config.autonomyMode) {
      case 'conservative':
        return action.confidence >= 0.9 && ['create_ticket', 'ask_question'].includes(action.type)

      case 'balanced':
        return action.confidence >= 0.7 && !['deploy', 'delete', 'external_api'].includes(action.type)

      case 'aggressive':
        return action.confidence >= 0.6

      case 'autonomus':
        return action.confidence >= 0.5

      default:
        return false
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Analysis Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private shouldCreateTicket(conversation: Context['conversation']): boolean {
    const keywords = ['bug', 'issue', 'problem', 'error', 'broken', 'fix', 'feature', 'add', 'implement']
    const hasKeywords = keywords.some(keyword =>
      conversation.messages.some(msg =>
        msg.content.toLowerCase().includes(keyword)
      )
    )

    return hasKeywords && conversation.intent.primary !== 'question'
  }

  private shouldCreateTask(conversation: Context['conversation']): boolean {
    const taskKeywords = ['build', 'create', 'implement', 'develop', 'make', 'add feature']
    return taskKeywords.some(keyword =>
      conversation.messages.some(msg =>
        msg.content.toLowerCase().includes(keyword)
      )
    ) && conversation.intent.complexity !== 'simple'
  }

  private shouldCreatePlan(context: Context, decisions: Decision[]): boolean {
    return decisions.length > 2 ||
      context.conversation.intent.complexity === 'expert' ||
      this.config.planningHorizon === 'strategic'
  }

  private extractTicketTitle(context: Context): string {
    const lastMessage = context.conversation.messages[context.conversation.messages.length - 1]
    return lastMessage.content.split('\n')[0].substring(0, 80) || 'Issue from conversation'
  }

  private extractTicketDescription(context: Context): string {
    const messages = context.conversation.messages.slice(-3)
    return messages.map(m => `${m.role}: ${m.content}`).join('\n\n')
  }

  private extractTaskTitle(context: Context): string {
    return this.extractTicketTitle(context).replace('Issue', 'Task')
  }

  private extractTaskDescription(context: Context): string {
    return this.extractTicketDescription(context)
  }

  private determinePriority(context: Context): 'low' | 'medium' | 'high' | 'critical' {
    if (context.conversation.intent.urgency === 'critical') return 'critical'
    if (context.conversation.intent.urgency === 'high') return 'high'
    if (context.conversation.sentiment === 'frustrated') return 'high'
    return 'medium'
  }

  private extractLabels(context: Context): string[] {
    const labels = []
    if (context.conversation.intent.primary === 'problem') labels.push('bug')
    if (context.conversation.intent.primary === 'request') labels.push('enhancement')
    labels.push(...context.conversation.topics.slice(0, 3))
    return labels
  }

  private generateSubtasks(context: Context): string[] {
    // Simple heuristic for subtask generation
    const complexity = context.conversation.intent.complexity
    switch (complexity) {
      case 'simple': return ['Implementation', 'Testing']
      case 'moderate': return ['Analysis', 'Implementation', 'Testing', 'Documentation']
      case 'complex': return ['Research', 'Design', 'Implementation', 'Testing', 'Documentation', 'Review']
      case 'expert': return ['Research', 'Architecture Design', 'Proof of Concept', 'Implementation', 'Integration Testing', 'Documentation', 'Code Review', 'Deployment']
      default: return ['Implementation', 'Testing']
    }
  }

  private estimateEffort(context: Context): number {
    const complexity = context.conversation.intent.complexity
    switch (complexity) {
      case 'simple': return 2
      case 'moderate': return 8
      case 'complex': return 24
      case 'expert': return 80
      default: return 8
    }
  }

  private adjustConfidenceForUrgency(confidence: number, urgency: string): number {
    switch (urgency) {
      case 'critical': return Math.min(1.0, confidence + 0.2)
      case 'high': return Math.min(1.0, confidence + 0.1)
      case 'medium': return confidence
      case 'low': return Math.max(0.0, confidence - 0.1)
      default: return confidence
    }
  }

  private calculateOverallConfidence(decisions: Decision[], actions: Action[]): number {
    if (decisions.length === 0) return 0

    const decisionConfidence = decisions.reduce((sum, d) => sum + d.confidence, 0) / decisions.length
    const actionConfidence = actions.length > 0
      ? actions.reduce((sum, a) => sum + a.confidence, 0) / actions.length
      : decisionConfidence

    return (decisionConfidence + actionConfidence) / 2
  }

  private updateMetrics(decisions: Decision[], actions: Action[], confidence: number): void {
    this.metrics.actionsExecuted += actions.length
    this.metrics.averageConfidence = (this.metrics.averageConfidence + confidence) / 2

    const successfulActions = actions.filter(a => a.status === 'completed').length
    this.metrics.successRate = this.metrics.actionsExecuted > 0
      ? successfulActions / this.metrics.actionsExecuted
      : 0
  }

  private setupEventHandlers(): void {
    // Handle learning events
    this.learningSystem.on('learning_applied', (learning) => {
      console.log(`📚 Applied learning: ${learning.description}`)
      this.emit('learning_applied', learning)
    })

    // Handle action completion
    this.actionExecutor.on('action_completed', (action) => {
      this.emit('action_completed', action)
    })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public Interface
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get current capabilities
   */
  getCapabilities(): string[] {
    const capabilities = ['conversation_intelligence', 'decision_making', 'action_execution']

    if (this.config.features.codebaseAnalysis) capabilities.push('codebase_analysis')
    if (this.config.features.automaticTaskCreation) capabilities.push('task_creation')
    if (this.config.features.proactiveTicketGeneration) capabilities.push('ticket_generation')
    if (this.config.features.strategicPlanning) capabilities.push('strategic_planning')
    if (this.config.learningEnabled) capabilities.push('learning_system')

    return capabilities
  }

  /**
   * Get current metrics
   */
  getMetrics() {
    return { ...this.metrics }
  }

  /**
   * Get recent decisions
   */
  getRecentDecisions(limit = 10): Decision[] {
    return this.recentDecisions.slice(-limit)
  }

  /**
   * Get active plans
   */
  getActivePlans(): Plan[] {
    return Array.from(this.activePlans.values())
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...updates }
    this.emit('config_updated', this.config)
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    if (this.config.learningEnabled) {
      await this.learningSystem.saveMemory()
    }

    this.removeAllListeners()
    console.log('🧹 Agent Engine cleaned up')
  }
}
