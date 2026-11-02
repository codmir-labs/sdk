/**
 * Task Runner Integration for Codmir Agent SDK
 * 
 * Enhances task runner with autonomous task breakdown, intelligent error recovery,
 * and progress monitoring with insights.
 */

import { EventEmitter } from 'events'
import type { 
  AgentConfig,
  Context,
  Plan,
  Action,
  ActionResult,
  Decision,
  PlanPhase,
  Learning
} from '../types'

import { AgentEngine } from '../core/AgentEngine'
import { TaskAgent } from '../agents/TaskAgent'
import { PlannerAgent } from '../agents/PlannerAgent'
import { CodeAgent } from '../agents/CodeAgent'
import { TaskIntelligence } from '../intelligence/TaskIntelligence'
import { eventEngine, emitTaskStarted, emitTaskProgress, emitTaskCompleted } from '../core/EventEngine'

export interface TaskRunnerConfig extends AgentConfig {
  runnerUrl: string
  runnerToken?: string
  workspaceRoot: string
  enableAutonomousBreakdown?: boolean
  enableIntelligentRecovery?: boolean
  maxRetries?: number
  progressInterval?: number
}

export interface EnhancedTask {
  id: string
  goal: string
  projectId?: string
  workspace?: string
  executionTarget?: 'auto' | 'local_runner' | 'remote_worker'
  requiredCapabilities?: string[]
  metadata?: Record<string, any>
  
  // Enhanced properties
  subtasks?: SubTask[]
  plan?: Plan
  decisions?: Decision[]
  learnings?: Learning[]
  progress?: TaskProgress
  recoveryAttempts?: RecoveryAttempt[]
}

export interface SubTask {
  id: string
  parentId: string
  title: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  dependencies: string[]
  estimatedEffort: number
  actualEffort?: number
  result?: any
  error?: string
}

export interface TaskProgress {
  overall: number
  phase: string
  subtasksCompleted: number
  subtasksTotal: number
  insights: string[]
  estimatedTimeRemaining?: number
  confidence: number
}

export interface RecoveryAttempt {
  attemptNumber: number
  timestamp: string
  strategy: string
  modifications: any
  success: boolean
  error?: string
}

export class TaskRunnerIntegration extends EventEmitter {
  private engine: AgentEngine
  private taskAgent: TaskAgent
  private plannerAgent: PlannerAgent
  private codeAgent: CodeAgent
  private taskIntelligence: TaskIntelligence
  
  private activeTasks = new Map<string, EnhancedTask>()
  private taskClients = new Map<string, any>() // TaskRunnerHttpClient instances
  
  constructor(private config: TaskRunnerConfig) {
    super()
    
    // Initialize components
    this.engine = new AgentEngine(config)
    this.taskAgent = new TaskAgent(config)
    this.plannerAgent = new PlannerAgent(config)
    this.codeAgent = new CodeAgent(config)
    this.taskIntelligence = new TaskIntelligence(config)
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.engine.initialize(),
      this.taskAgent.initialize(),
      this.plannerAgent.initialize(),
      this.codeAgent.initialize(),
      this.taskIntelligence.initialize()
    ])
    
    this.setupEventHandlers()
  }

  /**
   * Submit an enhanced task with autonomous capabilities
   */
  async submitTask(task: {
    goal: string
    projectId?: string
    workspace?: string
    executionTarget?: 'auto' | 'local_runner' | 'remote_worker'
    requiredCapabilities?: string[]
    metadata?: Record<string, any>
  }): Promise<EnhancedTask> {
    const enhancedTask: EnhancedTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      ...task,
      workspace: task.workspace || this.config.workspaceRoot,
      subtasks: [],
      progress: {
        overall: 0,
        phase: 'initializing',
        subtasksCompleted: 0,
        subtasksTotal: 0,
        insights: [],
        confidence: 0
      }
    }
    
    this.activeTasks.set(enhancedTask.id, enhancedTask)
    
    // Emit task started event
    emitTaskStarted({
      taskId: enhancedTask.id,
      description: enhancedTask.goal,
      metadata: enhancedTask.metadata
    })
    
    // Process task autonomously if enabled
    if (this.config.enableAutonomousBreakdown) {
      await this.processTaskAutonomously(enhancedTask)
    } else {
      await this.submitToRunner(enhancedTask)
    }
    
    return enhancedTask
  }

  /**
   * Process task with autonomous breakdown and planning
   */
  private async processTaskAutonomously(task: EnhancedTask): Promise<void> {
    try {
      // Build context
      const context = await this.buildTaskContext(task)
      
      // 1. Analyze and break down task
      console.log(`🔍 Analyzing task: ${task.goal}`)
      const breakdown = await this.taskAgent.breakdownTask({
        taskId: task.id,
        context,
      })
      
      // Convert to subtasks
      task.subtasks = this.convertToSubtasks(breakdown.breakdown?.subtasks || [])
      task.progress!.subtasksTotal = task.subtasks.length
      
      // 2. Create strategic plan
      console.log(`📋 Creating execution plan...`)
      const planResult = await this.plannerAgent.createStrategicPlan({
        objective: {
          id: task.id,
          type: 'delivery',
          description: task.goal,
          priority: 'high',
          successCriteria: ['task_completed', 'tests_passing'],
          stakeholders: ['developer']
        },
        context,
        timeHorizon: 'short',
        riskTolerance: 'medium'
      })
      
      if (planResult.plan) {
        task.plan = planResult.plan as unknown as Plan
      }
      
      // 3. Make decisions about execution
      const decisions = await this.makeExecutionDecisions(task, context)
      task.decisions = decisions
      
      // 4. Execute subtasks with monitoring
      await this.executeSubtasks(task, context)
      
    } catch (error) {
      console.error('❌ Autonomous task processing failed:', error)
      
      if (this.config.enableIntelligentRecovery) {
        await this.attemptRecovery(task, error)
      } else {
        task.progress!.phase = 'failed'
        this.emit('task:failed', { task, error })
      }
    }
  }

  /**
   * Execute subtasks with progress monitoring
   */
  private async executeSubtasks(task: EnhancedTask, context: Context): Promise<void> {
    if (!task.subtasks || task.subtasks.length === 0) {
      await this.submitToRunner(task)
      return
    }
    
    task.progress!.phase = 'executing'
    
    // Group subtasks by dependencies
    const groups = this.groupSubtasksByDependencies(task.subtasks)
    
    for (const group of groups) {
      // Execute group in parallel
      const promises = group.map(subtask => this.executeSubtask(task, subtask, context))
      const results = await Promise.allSettled(promises)
      
      // Update progress
      const completed = results.filter(r => r.status === 'fulfilled').length
      task.progress!.subtasksCompleted += completed
      task.progress!.overall = (task.progress!.subtasksCompleted / task.progress!.subtasksTotal) * 100
      
      // Generate insights
      const insights = await this.generateProgressInsights(task, results)
      task.progress!.insights.push(...insights)
      
      // Emit progress event
      emitTaskProgress({
        taskId: task.id,
        progress: {
          totalTokens: 0, // Would be tracked from actual execution
          toolUses: task.progress!.subtasksCompleted,
          durationMs: Date.now() - parseInt(task.id.split('_')[1])
        },
        summary: `Completed ${task.progress!.subtasksCompleted}/${task.progress!.subtasksTotal} subtasks`,
        metadata: { insights }
      })
      
      // Handle failures
      const failures = results.filter(r => r.status === 'rejected')
      if (failures.length > 0 && this.config.enableIntelligentRecovery) {
        for (let i = 0; i < failures.length; i++) {
          const failedSubtask = group[i]
          await this.attemptSubtaskRecovery(task, failedSubtask, failures[i].reason)
        }
      }
    }
    
    // Final completion
    task.progress!.phase = 'completed'
    task.progress!.overall = 100
    
    emitTaskCompleted({
      taskId: task.id,
      summary: `Task completed: ${task.goal}`,
      progress: {
        totalTokens: 0,
        toolUses: task.progress!.subtasksCompleted,
        durationMs: Date.now() - parseInt(task.id.split('_')[1])
      },
      metadata: { 
        subtasks: task.subtasks,
        insights: task.progress!.insights
      }
    })
  }

  /**
   * Execute a single subtask
   */
  private async executeSubtask(task: EnhancedTask, subtask: SubTask, context: Context): Promise<void> {
    subtask.status = 'running'
    
    try {
      // Create a runner task for this subtask
      const runnerTask = {
        goal: `${subtask.title}: ${subtask.description}`,
        projectId: task.projectId,
        workspace: task.workspace,
        executionTarget: task.executionTarget,
        requiredCapabilities: task.requiredCapabilities,
        metadata: {
          ...task.metadata,
          parentTaskId: task.id,
          subtaskId: subtask.id
        }
      }
      
      // Submit to runner
      const client = await this.getRunnerClient()
      const result = await client.createTask(runnerTask)
      
      // Monitor execution
      await this.monitorRunnerTask(result.taskId, subtask)
      
      subtask.status = 'completed'
      subtask.actualEffort = Date.now() - parseInt(subtask.id.split('_')[1])
      
    } catch (error) {
      subtask.status = 'failed'
      subtask.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  /**
   * Intelligent error recovery
   */
  private async attemptRecovery(task: EnhancedTask, error: any): Promise<void> {
    const maxRetries = this.config.maxRetries || 3
    const attempts = task.recoveryAttempts || []
    
    if (attempts.length >= maxRetries) {
      console.log('❌ Max recovery attempts reached')
      task.progress!.phase = 'failed'
      this.emit('task:failed', { task, error, attempts })
      return
    }
    
    console.log(`🔄 Attempting recovery (attempt ${attempts.length + 1}/${maxRetries})`)
    
    // Analyze failure and determine recovery strategy
    const strategy = await this.determineRecoveryStrategy(task, error, attempts)
    
    const attempt: RecoveryAttempt = {
      attemptNumber: attempts.length + 1,
      timestamp: new Date().toISOString(),
      strategy: strategy.type,
      modifications: strategy.modifications,
      success: false
    }
    
    task.recoveryAttempts = [...attempts, attempt]
    
    try {
      // Apply modifications
      await this.applyRecoveryModifications(task, strategy)
      
      // Retry execution
      await this.processTaskAutonomously(task)
      
      attempt.success = true
      
    } catch (retryError) {
      attempt.error = retryError instanceof Error ? retryError.message : String(retryError)
      
      // Try next recovery attempt
      await this.attemptRecovery(task, retryError)
    }
  }

  /**
   * Determine recovery strategy based on error analysis
   */
  private async determineRecoveryStrategy(
    task: EnhancedTask, 
    error: any,
    previousAttempts: RecoveryAttempt[]
  ): Promise<{ type: string; modifications: any }> {
    const errorMessage = error instanceof Error ? error.message : String(error)
    
    // Learn from previous attempts
    const failedStrategies = previousAttempts.map(a => a.strategy)
    
    // Analyze error type
    if (errorMessage.includes('timeout') || errorMessage.includes('deadline')) {
      if (!failedStrategies.includes('increase_timeout')) {
        return {
          type: 'increase_timeout',
          modifications: {
            timeout: (task.metadata?.timeout || 30000) * 2,
            reduceComplexity: true
          }
        }
      }
    }
    
    if (errorMessage.includes('permission') || errorMessage.includes('access')) {
      if (!failedStrategies.includes('adjust_permissions')) {
        return {
          type: 'adjust_permissions',
          modifications: {
            requiredCapabilities: [...(task.requiredCapabilities || []), 'elevated_access'],
            executionTarget: 'local_runner'
          }
        }
      }
    }
    
    if (errorMessage.includes('resource') || errorMessage.includes('memory')) {
      if (!failedStrategies.includes('reduce_scope')) {
        return {
          type: 'reduce_scope',
          modifications: {
            breakdownFurther: true,
            parallelism: 1,
            resourceLimits: { memory: '512Mi', cpu: '0.5' }
          }
        }
      }
    }
    
    // Default: simplify and retry
    return {
      type: 'simplify_retry',
      modifications: {
        simplifyGoal: true,
        addContext: true,
        increaseLogging: true
      }
    }
  }

  /**
   * Monitor runner task execution
   */
  private async monitorRunnerTask(taskId: string, subtask: SubTask): Promise<void> {
    const client = await this.getRunnerClient()
    const events = await client.streamTaskEvents(taskId)
    
    for await (const event of events) {
      if (event.type === 'state_change') {
        const state = event.payload.state as string
        
        if (state === 'completed') {
          subtask.result = event.payload.result
          break
        } else if (state === 'failed') {
          throw new Error(event.payload.error as string || 'Task failed')
        }
      }
      
      // Process other events for insights
      if (event.type === 'progress') {
        this.emit('subtask:progress', { subtask, event })
      }
    }
  }

  /**
   * Generate insights from task progress
   */
  private async generateProgressInsights(
    task: EnhancedTask,
    results: PromiseSettledResult<void>[]
  ): Promise<string[]> {
    const insights: string[] = []
    
    const successful = results.filter(r => r.status === 'fulfilled').length
    const failed = results.filter(r => r.status === 'rejected').length
    
    if (successful > 0) {
      insights.push(`✅ ${successful} subtasks completed successfully`)
    }
    
    if (failed > 0) {
      insights.push(`⚠️ ${failed} subtasks failed and may need recovery`)
      
      // Analyze failure patterns
      const reasons = results
        .filter(r => r.status === 'rejected')
        .map(r => (r as PromiseRejectedResult).reason)
      
      const commonReason = this.findCommonFailureReason(reasons)
      if (commonReason) {
        insights.push(`🔍 Common failure pattern: ${commonReason}`)
      }
    }
    
    // Performance insights
    if (task.progress!.subtasksCompleted > 0) {
      const avgTime = Date.now() - parseInt(task.id.split('_')[1])
      const estimatedRemaining = (avgTime / task.progress!.subtasksCompleted) * 
        (task.progress!.subtasksTotal - task.progress!.subtasksCompleted)
      
      task.progress!.estimatedTimeRemaining = estimatedRemaining
      insights.push(`⏱️ Estimated time remaining: ${Math.round(estimatedRemaining / 1000)}s`)
    }
    
    // Confidence assessment
    const confidence = successful / (successful + failed)
    task.progress!.confidence = confidence
    
    if (confidence < 0.5) {
      insights.push('⚠️ Low success rate - consider adjusting approach')
    } else if (confidence > 0.9) {
      insights.push('🎯 High success rate - execution on track')
    }
    
    return insights
  }

  // Helper methods

  private async buildTaskContext(task: EnhancedTask): Promise<Context> {
    return {
      project: task.projectId ? { id: task.projectId } as any : undefined,
      system: {
        platform: process.platform,
        environment: 'production',
        capabilities: task.requiredCapabilities || [],
        resources: {
          cpu: 100,
          memory: 100000,
          storage: 1000000
        }
      }
    } as unknown as Context
  }

  private convertToSubtasks(breakdownSubtasks: any[]): SubTask[] {
    return breakdownSubtasks.map((st, index) => ({
      id: `subtask_${Date.now()}_${index}`,
      parentId: '',
      title: st.title,
      description: st.description,
      status: 'pending' as const,
      dependencies: st.dependencies || [],
      estimatedEffort: st.estimatedEffort || 1
    }))
  }

  private groupSubtasksByDependencies(subtasks: SubTask[]): SubTask[][] {
    const groups: SubTask[][] = []
    const completed = new Set<string>()
    
    while (completed.size < subtasks.length) {
      const group = subtasks.filter(task => {
        if (completed.has(task.id)) return false
        return task.dependencies.every(dep => completed.has(dep))
      })
      
      if (group.length === 0) break
      
      groups.push(group)
      group.forEach(task => completed.add(task.id))
    }
    
    return groups
  }

  private async makeExecutionDecisions(task: EnhancedTask, context: Context): Promise<Decision[]> {
    const decisions: Decision[] = []
    
    // Decision: Parallel vs Sequential execution
    const parallelDecision = await this.engine.makeAutonomousDecision(context, {
      question: 'Should subtasks be executed in parallel?',
      options: ['parallel', 'sequential'],
      factors: ['dependencies', 'resource_constraints', 'risk']
    })

    if (parallelDecision.decision) {
      decisions.push(parallelDecision.decision)
    }
    
    return decisions
  }

  private async submitToRunner(task: EnhancedTask): Promise<void> {
    const client = await this.getRunnerClient()
    const result = await client.createTask({
      goal: task.goal,
      projectId: task.projectId,
      workspace: task.workspace,
      executionTarget: task.executionTarget || 'auto',
      requiredCapabilities: task.requiredCapabilities,
      metadata: task.metadata
    })
    
    task.metadata = { ...task.metadata, runnerTaskId: result.taskId }
    
    // Monitor the task
    await this.monitorRunnerTask(result.taskId, {
      id: task.id,
      parentId: '',
      title: task.goal,
      description: '',
      status: 'running',
      dependencies: [],
      estimatedEffort: 1
    } as SubTask)
  }

  private async getRunnerClient(): Promise<any> {
    const key = this.config.runnerUrl
    
    if (!this.taskClients.has(key)) {
      const { TaskRunnerHttpClient } = await import('@codmir/sdk/runtime/protocol')
      const client = new TaskRunnerHttpClient({
        baseUrl: this.config.runnerUrl,
        token: this.config.runnerToken
      })
      this.taskClients.set(key, client)
    }
    
    return this.taskClients.get(key)
  }

  private async attemptSubtaskRecovery(task: EnhancedTask, subtask: SubTask, error: any): Promise<void> {
    console.log(`🔄 Attempting recovery for subtask: ${subtask.title}`)
    
    // Simple retry for now
    try {
      await this.executeSubtask(task, subtask, await this.buildTaskContext(task))
    } catch (retryError) {
      console.error(`❌ Subtask recovery failed: ${subtask.title}`)
    }
  }

  private async applyRecoveryModifications(
    task: EnhancedTask,
    strategy: { type: string; modifications: any }
  ): Promise<void> {
    // Apply modifications based on strategy
    if (strategy.modifications.timeout) {
      task.metadata = { ...task.metadata, timeout: strategy.modifications.timeout }
    }
    
    if (strategy.modifications.requiredCapabilities) {
      task.requiredCapabilities = strategy.modifications.requiredCapabilities
    }
    
    if (strategy.modifications.executionTarget) {
      task.executionTarget = strategy.modifications.executionTarget
    }
    
    if (strategy.modifications.breakdownFurther && task.subtasks) {
      // Further break down complex subtasks
      const complexSubtasks = task.subtasks.filter(st => st.estimatedEffort > 2)
      for (const subtask of complexSubtasks) {
        const breakdown = await this.taskAgent.breakdownTask({
          taskId: subtask.id,
          context: await this.buildTaskContext(task),
        })
        
        // Replace with smaller subtasks
        const newSubtasks = this.convertToSubtasks(breakdown.breakdown?.subtasks || [])
        const index = task.subtasks.indexOf(subtask)
        task.subtasks.splice(index, 1, ...newSubtasks)
      }
    }
  }

  private findCommonFailureReason(reasons: any[]): string | null {
    const reasonCounts = new Map<string, number>()
    
    for (const reason of reasons) {
      const msg = reason instanceof Error ? reason.message : String(reason)
      reasonCounts.set(msg, (reasonCounts.get(msg) || 0) + 1)
    }
    
    let maxCount = 0
    let commonReason = null
    
    for (const [reason, count] of reasonCounts) {
      if (count > maxCount) {
        maxCount = count
        commonReason = reason
      }
    }
    
    return maxCount > 1 ? commonReason : null
  }

  private setupEventHandlers(): void {
    // Listen to engine events
    this.engine.on('decision_made', (decision) => {
      this.emit('decision:made', decision)
    })
    
    this.engine.on('learning_generated', (learning) => {
      this.emit('learning:generated', learning)
    })
    
    // Listen to event engine
    eventEngine.on('task:*', (event) => {
      this.emit('event', event)
    })
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): EnhancedTask | undefined {
    return this.activeTasks.get(taskId)
  }

  /**
   * Get all active tasks
   */
  getActiveTasks(): EnhancedTask[] {
    return Array.from(this.activeTasks.values())
  }

  /**
   * Stop watching a task
   */
  stopTask(taskId: string): void {
    const task = this.activeTasks.get(taskId)
    if (task) {
      task.progress!.phase = 'cancelled'
      this.emit('task:cancelled', { task })
      this.activeTasks.delete(taskId)
    }
  }

  /**
   * Get insights for all tasks
   */
  getInsights(): {
    totalTasks: number
    completedTasks: number
    failedTasks: number
    averageSubtasks: number
    averageRecoveryAttempts: number
    commonFailureReasons: string[]
    performanceMetrics: any
  } {
    const tasks = Array.from(this.activeTasks.values())
    
    return {
      totalTasks: tasks.length,
      completedTasks: tasks.filter(t => t.progress?.phase === 'completed').length,
      failedTasks: tasks.filter(t => t.progress?.phase === 'failed').length,
      averageSubtasks: tasks.reduce((sum, t) => sum + (t.subtasks?.length || 0), 0) / tasks.length,
      averageRecoveryAttempts: tasks.reduce((sum, t) => sum + (t.recoveryAttempts?.length || 0), 0) / tasks.length,
      commonFailureReasons: this.extractCommonFailures(tasks),
      performanceMetrics: this.calculatePerformanceMetrics(tasks)
    }
  }

  private extractCommonFailures(tasks: EnhancedTask[]): string[] {
    const failures: string[] = []
    
    for (const task of tasks) {
      if (task.recoveryAttempts) {
        for (const attempt of task.recoveryAttempts) {
          if (attempt.error) {
            failures.push(attempt.error)
          }
        }
      }
    }
    
    // Return top 3 most common
    const counts = new Map<string, number>()
    failures.forEach(f => counts.set(f, (counts.get(f) || 0) + 1))
    
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason]) => reason)
  }

  private calculatePerformanceMetrics(tasks: EnhancedTask[]): any {
    const completed = tasks.filter(t => t.progress?.phase === 'completed')
    
    if (completed.length === 0) {
      return { averageCompletionTime: 0, successRate: 0 }
    }
    
    const totalTime = completed.reduce((sum, t) => {
      const startTime = parseInt(t.id.split('_')[1])
      return sum + (Date.now() - startTime)
    }, 0)
    
    return {
      averageCompletionTime: totalTime / completed.length,
      successRate: completed.length / tasks.length,
      averageConfidence: completed.reduce((sum, t) => sum + (t.progress?.confidence || 0), 0) / completed.length
    }
  }
}
