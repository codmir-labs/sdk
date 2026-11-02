/**
 * Action Executor - Autonomous Action Execution System
 * 
 * Executes actions with confidence, handles failures gracefully,
 * and provides detailed feedback for learning and improvement.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

import type {
  autonomusConfig,
  Context,
  Action,
  ActionResult,
  ActionType,
  ActionStatus,
  Learning,
  Artifact,
  Resource,
  SideEffect
} from '../types'

/**
 * ActionExecutor handles autonomous execution of planned actions
 */
export class ActionExecutor extends EventEmitter {
  private config: autonomusConfig
  private executors = new Map<ActionType, ActionHandler>()
  private activeActions = new Map<string, ActionExecution>()

  // Execution tracking
  private metrics = {
    actionsExecuted: 0,
    successfulActions: 0,
    failedActions: 0,
    averageExecutionTime: 0,
    resourcesUsed: 0
  }

  constructor(config: autonomusConfig) {
    super()
    this.config = config
    this.initializeExecutors()
  }

  async initialize(): Promise<void> {
    console.log('⚡ Initializing Action Executor...')

    // Initialize all action executors
    for (const [type, handler] of this.executors) {
      try {
        await handler.initialize()
        console.log(`  ✅ ${type} executor ready`)
      } catch (error) {
        console.warn(`  ⚠️  ${type} executor failed to initialize:`, error)
      }
    }

    console.log('✅ Action Executor ready')
  }

  /**
   * Execute an action with full context and monitoring
   */
  async execute(action: Action, context: Context): Promise<ActionResult> {
    const executionId = randomUUID()
    const startTime = Date.now()

    // Track execution
    const execution: ActionExecution = {
      id: executionId,
      action,
      context,
      startTime,
      status: 'running',
      attempts: 0,
      maxAttempts: action.maxRetries + 1
    }

    this.activeActions.set(executionId, execution)
    this.emit('execution_started', { executionId, action, context })

    try {
      // Pre-execution validation
      const validation = await this.validateExecution(action, context)
      if (!validation.valid) {
        throw new Error(`Pre-execution validation failed: ${validation.reasons.join(', ')}`)
      }

      // Get appropriate executor
      const handler = this.executors.get(action.type)
      if (!handler) {
        throw new Error(`No executor available for action type: ${action.type}`)
      }

      // Execute with retries
      let result: ActionResult | null = null
      let lastError: Error | null = null

      for (let attempt = 1; attempt <= execution.maxAttempts; attempt++) {
        execution.attempts = attempt

        try {
          console.log(`🚀 Executing ${action.type}: ${action.title} (attempt ${attempt}/${execution.maxAttempts})`)

          result = await this.executeWithTimeout(handler, action, context)

          if (result.success) {
            execution.status = 'completed'
            break
          } else {
            lastError = new Error(result.output?.error || 'Execution failed')
            if (attempt < execution.maxAttempts) {
              console.warn(`⚠️  Attempt ${attempt} failed, retrying...`)
              await this.delay(1000 * attempt) // Exponential backoff
            }
          }
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
          if (attempt < execution.maxAttempts) {
            console.warn(`⚠️  Attempt ${attempt} failed with error, retrying...`, error)
            await this.delay(1000 * attempt)
          }
        }
      }

      // Finalize result
      if (!result || !result.success) {
        execution.status = 'failed'
        result = this.createFailureResult(action, lastError || new Error('Unknown error'), startTime)
      }

      // Post-execution processing
      result = await this.postProcessResult(result, action, context, startTime)

      // Update metrics
      this.updateMetrics(result, Date.now() - startTime)

      this.activeActions.delete(executionId)
      this.emit('execution_completed', {
        executionId,
        action,
        result,
        duration: Date.now() - startTime
      })

      return result

    } catch (error) {
      execution.status = 'failed'
      const result = this.createFailureResult(action, error instanceof Error ? error : new Error(String(error)), startTime)

      this.activeActions.delete(executionId)
      this.emit('execution_failed', { executionId, action, error, result })

      return result
    }
  }

  /**
   * Execute multiple actions in parallel with concurrency control
   */
  async executeParallel(actions: Action[], context: Context, maxConcurrency = 3): Promise<ActionResult[]> {
    const results: ActionResult[] = []
    const executing: Promise<ActionResult>[] = []

    console.log(`⚡ Executing ${actions.length} actions in parallel (max concurrency: ${maxConcurrency})`)

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]

      // Start execution
      const promise = this.execute(action, context)
      executing.push(promise)

      // Wait if we hit concurrency limit
      if (executing.length >= maxConcurrency) {
        const result = await Promise.race(executing)
        results.push(result)

        // Remove completed promise
        const completedIndex = executing.findIndex(p => p === Promise.resolve(result))
        if (completedIndex >= 0) {
          executing.splice(completedIndex, 1)
        }
      }
    }

    // Wait for remaining actions
    const remainingResults = await Promise.all(executing)
    results.push(...remainingResults)

    return results
  }

  /**
   * Get execution status for active actions
   */
  getActiveExecutions(): Array<{
    id: string
    actionType: ActionType
    actionTitle: string
    status: string
    duration: number
    attempts: number
  }> {
    return Array.from(this.activeActions.values()).map(execution => ({
      id: execution.id,
      actionType: execution.action.type,
      actionTitle: execution.action.title,
      status: execution.status,
      duration: Date.now() - execution.startTime,
      attempts: execution.attempts
    }))
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private async executeWithTimeout(
    handler: ActionHandler,
    action: Action,
    context: Context
  ): Promise<ActionResult> {
    const timeoutMs = 30000 // 30 second timeout

    return Promise.race([
      handler.execute(action, context),
      new Promise<ActionResult>((_, reject) =>
        setTimeout(() => reject(new Error('Execution timeout')), timeoutMs)
      )
    ])
  }

  private async validateExecution(action: Action, context: Context): Promise<{
    valid: boolean
    reasons: string[]
  }> {
    const reasons: string[] = []

    // Check required capabilities
    if (action.requiredCapabilities?.length > 0) {
      const availableCapabilities = context.system.capabilities.filter(c => c.available).map(c => c.name)
      const missingCapabilities = action.requiredCapabilities.filter(cap => !availableCapabilities.includes(cap))

      if (missingCapabilities.length > 0) {
        reasons.push(`Missing required capabilities: ${missingCapabilities.join(', ')}`)
      }
    }

    // Check input data
    if (action.input?.requiredData) {
      const missingData = Object.keys(action.input.requiredData).filter(key => {
        const value = action.input.requiredData[key]
        return value === null || value === undefined || value === ''
      })

      if (missingData.length > 0) {
        reasons.push(`Missing required input data: ${missingData.join(', ')}`)
      }
    }

    // Check safety constraints
    if (this.config.safetyChecksEnabled && action.confidence < 0.5) {
      reasons.push('Action confidence too low for safe execution')
    }

    return {
      valid: reasons.length === 0,
      reasons
    }
  }

  private async postProcessResult(
    result: ActionResult,
    action: Action,
    context: Context,
    startTime: number
  ): Promise<ActionResult> {
    // Add timing information
    result.executionTime = Date.now() - startTime

    // Generate learnings if enabled
    if (this.config.learningEnabled) {
      const learnings = await this.generateLearnings(result, action, context)
      result.learnings.push(...learnings)
    }

    // Track resource usage
    result.resourcesUsed = this.calculateResourceUsage(result, action)

    // Detect side effects
    result.sideEffects = await this.detectSideEffects(result, action, context)

    return result
  }

  private createFailureResult(action: Action, error: Error, startTime: number): ActionResult {
    return {
      success: false,
      output: {
        error: error.message,
        stack: error.stack
      },
      artifacts: [],
      confidence: 0,
      executionTime: Date.now() - startTime,
      resourcesUsed: [],
      sideEffects: [],
      learnings: [{
        id: randomUUID(),
        type: 'failure',
        description: `Action failed: ${action.title}`,
        context: {
          situation: 'action_execution_failure',
          factors: {
            actionType: action.type,
            error: error.message,
            confidence: action.confidence
          },
          environment: { autonomyMode: this.config.autonomyMode },
          actors: ['action_executor'],
          timeframe: 'immediate'
        },
        whatHappened: `Failed to execute ${action.type} action: ${error.message}`,
        whyItHappened: 'Could be due to missing dependencies, invalid parameters, or system constraints',
        whatToDoNext: 'Review action parameters and retry with adjusted confidence or different approach',
        confidence: 0.7,
        applicableContexts: [action.type],
        actionableInsights: [
          'Validate action inputs before execution',
          'Add better error handling for this action type',
          'Consider alternative approaches for similar actions'
        ],
        preventionMeasures: [
          'Pre-execution validation checks',
          'Better input sanitization',
          'Timeout and retry mechanisms'
        ],
        learnedAt: new Date().toISOString(),
        importance: 0.8,
        verified: false,
        timesApplied: 0,
        successRate: 0
      }]
    }
  }

  private async generateLearnings(
    result: ActionResult,
    action: Action,
    context: Context
  ): Promise<Learning[]> {
    const learnings: Learning[] = []

    // Success learning
    if (result.success && result.executionTime < 1000) {
      learnings.push({
        id: randomUUID(),
        type: 'success',
        description: `Fast execution of ${action.type} action`,
        context: {
          situation: 'efficient_action_execution',
          factors: {
            actionType: action.type,
            executionTime: result.executionTime,
            confidence: action.confidence
          },
          environment: { autonomyMode: this.config.autonomyMode },
          actors: ['action_executor'],
          timeframe: 'immediate'
        },
        whatHappened: `Successfully executed ${action.type} in ${result.executionTime}ms`,
        whyItHappened: 'Good action configuration and favorable execution environment',
        whatToDoNext: 'Apply similar patterns to other actions of this type',
        confidence: 0.8,
        applicableContexts: [action.type],
        actionableInsights: [
          'This action type can be executed efficiently',
          'Similar confidence levels work well for this action'
        ],
        learnedAt: new Date().toISOString(),
        importance: 0.6,
        verified: true,
        timesApplied: 0,
        successRate: 1.0
      })
    }

    // Performance learning
    if (result.executionTime > 10000) { // > 10 seconds
      learnings.push({
        id: randomUUID(),
        type: 'insight',
        description: `Slow execution detected for ${action.type}`,
        context: {
          situation: 'slow_action_execution',
          factors: {
            actionType: action.type,
            executionTime: result.executionTime
          },
          environment: { autonomyMode: this.config.autonomyMode },
          actors: ['action_executor'],
          timeframe: 'immediate'
        },
        whatHappened: `Action took ${result.executionTime}ms to execute`,
        whyItHappened: 'Could be due to network latency, complex processing, or resource constraints',
        whatToDoNext: 'Consider optimization or async execution for similar actions',
        confidence: 0.7,
        applicableContexts: [action.type],
        actionableInsights: [
          'This action type may need longer timeouts',
          'Consider breaking down into smaller actions',
          'Monitor resource usage for optimization'
        ],
        optimizationOpportunities: [
          'Implement caching for repeated operations',
          'Use parallel processing where possible',
          'Add progress indicators for long-running actions'
        ],
        learnedAt: new Date().toISOString(),
        importance: 0.7,
        verified: false,
        timesApplied: 0,
        successRate: 0
      })
    }

    return learnings
  }

  private calculateResourceUsage(result: ActionResult, action: Action): Resource[] {
    const resources: Resource[] = []

    // Time resource
    resources.push({
      type: 'time',
      amount: result.executionTime,
      unit: 'milliseconds',
      cost: result.executionTime * 0.001 // Simple cost model
    })

    // Memory estimate (very rough)
    const memoryUsage = JSON.stringify(result.output).length * 2 // bytes
    resources.push({
      type: 'memory',
      amount: memoryUsage,
      unit: 'bytes'
    })

    // API calls (if applicable)
    if (['create_ticket', 'create_task', 'analyze_code'].includes(action.type)) {
      resources.push({
        type: 'api_calls',
        amount: 1,
        unit: 'requests',
        cost: 0.01
      })
    }

    return resources
  }

  private async detectSideEffects(
    result: ActionResult,
    action: Action,
    context: Context
  ): Promise<SideEffect[]> {
    const sideEffects: SideEffect[] = []

    // Creation side effects
    if (action.type === 'create_ticket' && result.success) {
      sideEffects.push({
        type: 'created',
        target: 'ticket',
        description: 'New ticket created in project',
        reversible: true
      })
    }

    if (action.type === 'create_task' && result.success) {
      sideEffects.push({
        type: 'created',
        target: 'task',
        description: 'New development task created',
        reversible: true
      })
    }

    // Notification side effects
    if (result.success && ['create_ticket', 'create_task'].includes(action.type)) {
      sideEffects.push({
        type: 'notified',
        target: 'project_team',
        description: 'Team members notified of new work item',
        reversible: false
      })
    }

    return sideEffects
  }

  private updateMetrics(result: ActionResult, duration: number): void {
    this.metrics.actionsExecuted++
    this.metrics.averageExecutionTime = (this.metrics.averageExecutionTime + duration) / this.metrics.actionsExecuted

    if (result.success) {
      this.metrics.successfulActions++
    } else {
      this.metrics.failedActions++
    }

    this.metrics.resourcesUsed += result.resourcesUsed.length
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private initializeExecutors(): void {
    // Ticket Creation Executor
    this.executors.set('create_ticket', {
      name: 'Ticket Creator',
      initialize: async () => {
        console.log('  🎫 Initializing ticket creation executor')
      },
      execute: async (action: Action, context: Context) => {
        return await this.executeCreateTicket(action, context)
      }
    })

    // Task Creation Executor
    this.executors.set('create_task', {
      name: 'Task Creator',
      initialize: async () => {
        console.log('  📋 Initializing task creation executor')
      },
      execute: async (action: Action, context: Context) => {
        return await this.executeCreateTask(action, context)
      }
    })

    // Code Analysis Executor
    this.executors.set('analyze_code', {
      name: 'Code Analyzer',
      initialize: async () => {
        console.log('  🔍 Initializing code analysis executor')
      },
      execute: async (action: Action, context: Context) => {
        return await this.executeAnalyzeCode(action, context)
      }
    })

    // Question Executor
    this.executors.set('ask_question', {
      name: 'Question Handler',
      initialize: async () => {
        console.log('  ❓ Initializing question executor')
      },
      execute: async (action: Action, context: Context) => {
        return await this.executeAskQuestion(action, context)
      }
    })

    // Decision Maker Executor
    this.executors.set('make_decision', {
      name: 'Decision Maker',
      initialize: async () => {
        console.log('  🤔 Initializing decision executor')
      },
      execute: async (action: Action, context: Context) => {
        return await this.executeMakeDecision(action, context)
      }
    })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Action Executors
  // ═══════════════════════════════════════════════════════════════════════════

  private async executeCreateTicket(action: Action, context: Context): Promise<ActionResult> {
    const startTime = Date.now()

    try {
      const ticketData = action.input.requiredData

      // Simulate ticket creation (in real implementation, would call API)
      const ticketId = `TK-${Date.now()}`

      // Mock API call
      await new Promise(resolve => setTimeout(resolve, 500))

      const ticket = {
        id: ticketId,
        title: ticketData.title,
        description: ticketData.description,
        priority: ticketData.priority,
        labels: ticketData.labels || [],
        status: 'open',
        createdAt: new Date().toISOString(),
        projectId: action.parameters.projectId
      }

      return {
        success: true,
        output: { ticket },
        artifacts: [{
          type: 'data',
          name: 'created_ticket',
          content: ticket,
          metadata: { ticketId, projectId: action.parameters.projectId }
        }],
        confidence: action.confidence,
        executionTime: Date.now() - startTime,
        resourcesUsed: [],
        sideEffects: [],
        learnings: []
      }
    } catch (error) {
      return {
        success: false,
        output: { error: error instanceof Error ? error.message : String(error) },
        artifacts: [],
        confidence: 0,
        executionTime: Date.now() - startTime,
        resourcesUsed: [],
        sideEffects: [],
        learnings: []
      }
    }
  }

  private async executeCreateTask(action: Action, context: Context): Promise<ActionResult> {
    const startTime = Date.now()

    try {
      const taskData = action.input.requiredData

      // Simulate task creation
      const taskId = `TSK-${Date.now()}`

      await new Promise(resolve => setTimeout(resolve, 750))

      const task = {
        id: taskId,
        title: taskData.title,
        description: taskData.description,
        subtasks: taskData.subtasks || [],
        estimatedHours: taskData.estimatedHours || 8,
        status: 'pending',
        createdAt: new Date().toISOString(),
        projectId: action.parameters.projectId
      }

      return {
        success: true,
        output: { task },
        artifacts: [{
          type: 'data',
          name: 'created_task',
          content: task,
          metadata: { taskId, projectId: action.parameters.projectId }
        }],
        confidence: action.confidence,
        executionTime: Date.now() - startTime,
        resourcesUsed: [],
        sideEffects: [],
        learnings: []
      }
    } catch (error) {
      return {
        success: false,
        output: { error: error instanceof Error ? error.message : String(error) },
        artifacts: [],
        confidence: 0,
        executionTime: Date.now() - startTime,
        resourcesUsed: [],
        sideEffects: [],
        learnings: []
      }
    }
  }

  private async executeAnalyzeCode(action: Action, context: Context): Promise<ActionResult> {
    const startTime = Date.now()

    try {
      // Simulate code analysis
      await new Promise(resolve => setTimeout(resolve, 2000))

      const analysis = {
        files: context.project.codebaseAnalysis.totalFiles,
        complexity: context.project.codebaseAnalysis.complexity,
        issues: context.project.codebaseAnalysis.issues.length,
        recommendations: [
          'Consider refactoring complex functions',
          'Add unit tests for critical paths',
          'Update documentation for public APIs'
        ]
      }

      return {
        success: true,
        output: { analysis },
        artifacts: [{
          type: 'report',
          name: 'code_analysis_report',
          content: analysis,
          metadata: { projectId: context.project.id }
        }],
        confidence: action.confidence,
        executionTime: Date.now() - startTime,
        resourcesUsed: [],
        sideEffects: [],
        learnings: []
      }
    } catch (error) {
      return {
        success: false,
        output: { error: error instanceof Error ? error.message : String(error) },
        artifacts: [],
        confidence: 0,
        executionTime: Date.now() - startTime,
        resourcesUsed: [],
        sideEffects: [],
        learnings: []
      }
    }
  }

  private async executeAskQuestion(action: Action, context: Context): Promise<ActionResult> {
    const startTime = Date.now()

    try {
      const question = action.input.requiredData.question

      // Simulate question processing
      await new Promise(resolve => setTimeout(resolve, 200))

      const response = {
        question,
        answer: "This would be answered by the AI system based on context",
        confidence: 0.8,
        sources: ["context_analysis", "project_knowledge"]
      }

      return {
        success: true,
        output: { response },
        artifacts: [{
          type: 'data',
          name: 'question_response',
          content: response,
          metadata: { question }
        }],
        confidence: action.confidence,
        executionTime: Date.now() - startTime,
        resourcesUsed: [],
        sideEffects: [],
        learnings: []
      }
    } catch (error) {
      return {
        success: false,
        output: { error: error instanceof Error ? error.message : String(error) },
        artifacts: [],
        confidence: 0,
        executionTime: Date.now() - startTime,
        resourcesUsed: [],
        sideEffects: [],
        learnings: []
      }
    }
  }

  private async executeMakeDecision(action: Action, context: Context): Promise<ActionResult> {
    const startTime = Date.now()

    try {
      const decisionData = action.input.requiredData

      // Simulate decision making
      await new Promise(resolve => setTimeout(resolve, 300))

      const decision = {
        question: decisionData.question,
        options: decisionData.options,
        chosen: decisionData.options[0]?.id || 'default',
        reasoning: 'Based on context analysis and confidence scores',
        confidence: action.confidence
      }

      return {
        success: true,
        output: { decision },
        artifacts: [{
          type: 'data',
          name: 'decision_result',
          content: decision,
          metadata: { decisionType: 'autonomous' }
        }],
        confidence: action.confidence,
        executionTime: Date.now() - startTime,
        resourcesUsed: [],
        sideEffects: [],
        learnings: []
      }
    } catch (error) {
      return {
        success: false,
        output: { error: error instanceof Error ? error.message : String(error) },
        artifacts: [],
        confidence: 0,
        executionTime: Date.now() - startTime,
        resourcesUsed: [],
        sideEffects: [],
        learnings: []
      }
    }
  }

  getMetrics() {
    return { ...this.metrics }
  }
}

// Supporting interfaces
interface ActionHandler {
  name: string
  initialize: () => Promise<void>
  execute: (action: Action, context: Context) => Promise<ActionResult>
}

interface ActionExecution {
  id: string
  action: Action
  context: Context
  startTime: number
  status: 'running' | 'completed' | 'failed'
  attempts: number
  maxAttempts: number
}
