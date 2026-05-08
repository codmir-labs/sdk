/**
 * Task Intelligence - Advanced Task Analysis and Management
 * 
 * Provides intelligent task breakdown, estimation, planning,
 * and execution monitoring with adaptive learning capabilities.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

import type {
  Context,
  autonomusConfig,
  Plan,
  Action,
  TaskContext
} from '../types'

/**
 * TaskIntelligence provides comprehensive task analysis and planning
 */
export class TaskIntelligence extends EventEmitter {
  private config: autonomusConfig
  private taskAnalysisCache = new Map<string, TaskAnalysis>()
  private taskBreakdownEngine: TaskBreakdownEngine
  private effortEstimator: EffortEstimator
  private dependencyAnalyzer: DependencyAnalyzer
  private riskAssessor: RiskAssessor

  // Task patterns and learning
  private taskPatterns = new Map<string, TaskPattern>()
  private estimationHistory = new Map<string, EstimationResult[]>()

  // Metrics
  private metrics = {
    tasksAnalyzed: 0,
    estimationAccuracy: 0,
    patternsDiscovered: 0,
    averageBreakdownTime: 0
  }

  constructor(config: autonomusConfig) {
    super()
    this.config = config
    this.taskBreakdownEngine = new TaskBreakdownEngine()
    this.effortEstimator = new EffortEstimator()
    this.dependencyAnalyzer = new DependencyAnalyzer()
    this.riskAssessor = new RiskAssessor()
  }

  async initialize(): Promise<void> {
    console.log('📋 Initializing Task Intelligence...')

    await Promise.all([
      this.taskBreakdownEngine.initialize(),
      this.effortEstimator.initialize(),
      this.dependencyAnalyzer.initialize(),
      this.riskAssessor.initialize()
    ])

    console.log('✅ Task Intelligence ready')
  }

  /**
   * Get latest task insights
   */
  getInsights(): any {
    return Array.from(this.taskAnalysisCache.values()).pop() || null
  }

  /**
   * Analyze a task request for intelligent breakdown and planning
   */
  async analyzeTask(params: {
    taskDescription: string
    context: Context
    constraints?: TaskConstraint[]
    parentTask?: string
    priority?: 'low' | 'medium' | 'high' | 'critical'
  }): Promise<TaskAnalysis> {
    const startTime = Date.now()

    try {
      console.log('📊 Analyzing task:', params.taskDescription.substring(0, 50) + '...')

      // Extract task characteristics
      const characteristics = await this.extractTaskCharacteristics(
        params.taskDescription,
        params.context
      )

      // Break down into subtasks
      const breakdown = await this.taskBreakdownEngine.breakdownTask({
        description: params.taskDescription,
        context: params.context,
        characteristics,
        constraints: params.constraints || []
      })

      // Estimate effort and duration
      const estimation = await this.effortEstimator.estimate({
        task: params.taskDescription,
        subtasks: breakdown.subtasks,
        complexity: characteristics.complexity,
        context: params.context
      })

      // Analyze dependencies
      const dependencies = await this.dependencyAnalyzer.analyze({
        subtasks: breakdown.subtasks,
        context: params.context,
        parentTask: params.parentTask
      })

      // Assess risks
      const risks = await this.riskAssessor.assess({
        task: params.taskDescription,
        subtasks: breakdown.subtasks,
        context: params.context,
        estimation
      })

      // Create comprehensive analysis
      const analysis: TaskAnalysis = {
        id: randomUUID(),
        taskDescription: params.taskDescription,
        characteristics,
        breakdown,
        estimation,
        dependencies,
        risks,

        // Planning recommendations
        recommendedApproach: await this.recommendApproach(characteristics, breakdown, estimation),
        milestones: await this.generateMilestones(breakdown, estimation),
        acceptanceCriteria: await this.generateAcceptanceCriteria(params.taskDescription, characteristics),

        // Execution guidance
        executionPlan: await this.createExecutionPlan(breakdown, dependencies, estimation),
        monitoringMetrics: this.defineMonitoringMetrics(characteristics, estimation),

        // Metadata
        priority: params.priority || this.calculatePriority(characteristics, params.context),
        confidence: this.calculateAnalysisConfidence(characteristics, breakdown, estimation),
        analyzedAt: new Date().toISOString(),
        processingTime: Date.now() - startTime
      }

      // Store analysis and update patterns
      this.taskAnalysisCache.set(analysis.id, analysis)
      await this.updateTaskPatterns(analysis)

      // Update metrics
      this.metrics.tasksAnalyzed++
      this.metrics.averageBreakdownTime = (this.metrics.averageBreakdownTime + analysis.processingTime) / this.metrics.tasksAnalyzed

      this.emit('task_analyzed', { analysis, processingTime: analysis.processingTime })

      return analysis

    } catch (error) {
      console.error('❌ Task analysis failed:', error)
      throw error
    }
  }

  /**
   * Generate intelligent task suggestions based on context
   */
  async suggestTasks(context: Context, options?: {
    focus?: 'bugs' | 'features' | 'technical_debt' | 'testing' | 'documentation'
    urgency?: 'low' | 'medium' | 'high' | 'critical'
    effort?: 'small' | 'medium' | 'large'
  }): Promise<TaskSuggestion[]> {
    const suggestions: TaskSuggestion[] = []

    try {
      // Analyze context for task opportunities
      const opportunities = await this.identifyTaskOpportunities(context, options)

      for (const opportunity of opportunities) {
        const suggestion: TaskSuggestion = {
          id: randomUUID(),
          title: opportunity.title,
          description: opportunity.description,
          reasoning: opportunity.reasoning,
          priority: opportunity.priority,
          estimatedEffort: opportunity.estimatedEffort,
          category: opportunity.category,
          benefits: opportunity.benefits,
          prerequisites: opportunity.prerequisites || [],
          suggestedAssignee: this.suggestAssignee(opportunity, context),
          confidence: opportunity.confidence
        }

        suggestions.push(suggestion)
      }

      // Sort by priority and confidence
      return suggestions.sort((a, b) => {
        const priorityWeight = { critical: 4, high: 3, medium: 2, low: 1 }
        const aScore = priorityWeight[a.priority] * a.confidence
        const bScore = priorityWeight[b.priority] * b.confidence
        return bScore - aScore
      })

    } catch (error) {
      console.error('❌ Task suggestion failed:', error)
      return []
    }
  }

  /**
   * Monitor task execution and provide intelligent updates
   */
  async monitorTaskExecution(taskId: string, executionData: {
    progress: number
    timeSpent: number
    issues?: string[]
    completedMilestones?: string[]
  }): Promise<TaskExecutionInsight> {
    const analysis = this.getTaskAnalysis(taskId)
    if (!analysis) {
      throw new Error(`Task analysis not found: ${taskId}`)
    }

    const insight: TaskExecutionInsight = {
      taskId,
      currentProgress: executionData.progress,
      estimatedCompletion: this.calculateEstimatedCompletion(analysis, executionData),
      isOnTrack: this.isTaskOnTrack(analysis, executionData),
      blockers: executionData.issues || [],
      recommendations: await this.generateExecutionRecommendations(analysis, executionData),
      riskAlerts: this.assessExecutionRisks(analysis, executionData),
      nextActions: this.suggestNextActions(analysis, executionData),
      confidenceLevel: this.calculateExecutionConfidence(analysis, executionData)
    }

    // Update estimation history for learning
    this.updateEstimationHistory(taskId, analysis, executionData)

    this.emit('task_monitored', { taskId, insight, executionData })

    return insight
  }

  /**
   * Learn from completed tasks to improve future analysis
   */
  async learnFromCompletedTask(taskId: string, completion: {
    actualEffort: number
    actualDuration: number
    actualComplexity: 'simple' | 'moderate' | 'complex' | 'expert'
    issues: string[]
    successFactors: string[]
    lessonsLearned: string[]
  }): Promise<void> {
    const analysis = this.getTaskAnalysis(taskId)
    if (!analysis) return

    // Calculate estimation accuracy
    const effortAccuracy = Math.abs(analysis.estimation.totalHours - completion.actualEffort) / analysis.estimation.totalHours
    const durationAccuracy = Math.abs(analysis.estimation.totalDays - completion.actualDuration) / analysis.estimation.totalDays

    // Update accuracy metrics
    this.metrics.estimationAccuracy = (this.metrics.estimationAccuracy + (1 - (effortAccuracy + durationAccuracy) / 2)) / 2

    // Store learning
    const learning: TaskLearning = {
      taskId,
      originalAnalysis: analysis,
      actualResults: completion,
      estimationAccuracy: {
        effort: 1 - effortAccuracy,
        duration: 1 - durationAccuracy
      },
      insights: await this.extractTaskInsights(analysis, completion),
      improvementSuggestions: await this.generateImprovementSuggestions(analysis, completion),
      learnedAt: new Date().toISOString()
    }

    this.emit('task_learning_extracted', learning)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Analysis Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private async extractTaskCharacteristics(description: string, context: Context): Promise<TaskCharacteristics> {
    const text = description.toLowerCase()

    // Analyze complexity
    const complexityIndicators = {
      simple: ['fix', 'update', 'change', 'small'],
      moderate: ['implement', 'add', 'create', 'modify'],
      complex: ['refactor', 'redesign', 'integrate', 'optimize'],
      expert: ['architecture', 'migration', 'performance', 'scalability']
    }

    let complexity: 'simple' | 'moderate' | 'complex' | 'expert' = 'moderate'
    for (const [level, indicators] of Object.entries(complexityIndicators)) {
      if (indicators.some(indicator => text.includes(indicator))) {
        complexity = level as any
        break
      }
    }

    // Analyze type
    let type: 'feature' | 'bug' | 'improvement' | 'maintenance' | 'research' = 'feature'
    if (text.includes('bug') || text.includes('fix') || text.includes('error')) type = 'bug'
    else if (text.includes('improve') || text.includes('optimize') || text.includes('enhance')) type = 'improvement'
    else if (text.includes('maintain') || text.includes('update') || text.includes('upgrade')) type = 'maintenance'
    else if (text.includes('research') || text.includes('investigate') || text.includes('explore')) type = 'research'

    // Analyze scope
    const scope = this.determineScope(text, context)

    // Analyze technical domains
    const domains = this.identifyTechnicalDomains(text, context)

    return {
      complexity,
      type,
      scope,
      domains,
      requiresUserInput: text.includes('user') || text.includes('ui') || text.includes('interface'),
      requiresBackendWork: text.includes('api') || text.includes('database') || text.includes('server'),
      requiresFrontendWork: text.includes('ui') || text.includes('component') || text.includes('interface'),
      requiresTesting: !text.includes('no test') && !text.includes('skip test'),
      requiresDocumentation: complexity !== 'simple' || text.includes('document'),
      hasExternalDependencies: this.hasExternalDependencies(text, context),
      estimatedRisk: this.estimateRisk(complexity, type, scope)
    }
  }

  private async recommendApproach(
    characteristics: TaskCharacteristics,
    breakdown: TaskBreakdown,
    estimation: TaskEstimation
  ): Promise<TaskApproach> {
    const approaches: TaskApproach[] = []

    // Recommend based on complexity
    if (characteristics.complexity === 'expert') {
      approaches.push({
        name: 'Phased Implementation',
        description: 'Break into phases with proof-of-concept first',
        advantages: ['Reduced risk', 'Early feedback', 'Incremental progress'],
        disadvantages: ['Longer overall timeline', 'More coordination'],
        suitability: 0.9
      })
    } else if (characteristics.complexity === 'complex') {
      approaches.push({
        name: 'Iterative Development',
        description: 'Implement in iterations with regular reviews',
        advantages: ['Continuous improvement', 'Risk mitigation', 'Stakeholder involvement'],
        disadvantages: ['Requires good planning', 'May need scope adjustments'],
        suitability: 0.8
      })
    } else {
      approaches.push({
        name: 'Direct Implementation',
        description: 'Straightforward implementation approach',
        advantages: ['Fast delivery', 'Simple coordination', 'Clear timeline'],
        disadvantages: ['Higher risk if requirements change', 'Less flexibility'],
        suitability: 0.9
      })
    }

    // Return the best approach
    return approaches.sort((a, b) => b.suitability - a.suitability)[0]
  }

  private async generateMilestones(breakdown: TaskBreakdown, estimation: TaskEstimation): Promise<TaskMilestone[]> {
    const milestones: TaskMilestone[] = []

    // Group subtasks into logical milestones
    const phases = this.groupSubtasksIntoPhases(breakdown.subtasks)

    let cumulativeDays = 0
    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i]
      const phaseDuration = phase.reduce((sum, subtask) => sum + subtask.estimatedDays, 0)
      cumulativeDays += phaseDuration

      milestones.push({
        id: randomUUID(),
        name: this.generateMilestoneName(phase, i + 1, phases.length),
        description: this.generateMilestoneDescription(phase),
        deliverables: phase.map(subtask => subtask.name),
        estimatedCompletion: cumulativeDays,
        dependencies: i > 0 ? [milestones[i - 1].id] : [],
        successCriteria: this.generateSuccessCriteria(phase)
      })
    }

    return milestones
  }

  private async generateAcceptanceCriteria(description: string, characteristics: TaskCharacteristics): Promise<string[]> {
    const criteria: string[] = []

    // Basic functionality criteria
    criteria.push('Task implementation matches the specified requirements')

    // Type-specific criteria
    if (characteristics.type === 'feature') {
      criteria.push('New functionality works as expected')
      criteria.push('Integration with existing features is seamless')
    } else if (characteristics.type === 'bug') {
      criteria.push('Bug is completely resolved')
      criteria.push('No regression in existing functionality')
    }

    // Quality criteria
    if (characteristics.requiresTesting) {
      criteria.push('Test coverage meets quality standards')
      criteria.push('All tests pass successfully')
    }

    if (characteristics.requiresDocumentation) {
      criteria.push('Documentation is updated and accurate')
    }

    // Performance criteria for complex tasks
    if (characteristics.complexity === 'complex' || characteristics.complexity === 'expert') {
      criteria.push('Performance meets or exceeds requirements')
      criteria.push('Code review approval received')
    }

    return criteria
  }

  private async createExecutionPlan(
    breakdown: TaskBreakdown,
    dependencies: TaskDependencies,
    estimation: TaskEstimation
  ): Promise<TaskExecutionPlan> {
    // Create execution phases
    const phases = this.createExecutionPhases(breakdown.subtasks, dependencies)

    // Calculate timeline
    const timeline = this.calculateExecutionTimeline(phases, estimation)

    // Identify critical path
    const criticalPath = this.identifyCriticalPath(phases, dependencies)

    return {
      phases,
      timeline,
      criticalPath,
      resourceRequirements: this.calculateResourceRequirements(breakdown, estimation),
      checkpoints: this.defineCheckpoints(phases),
      contingencyPlans: this.createContingencyPlans(breakdown, dependencies)
    }
  }

  private defineMonitoringMetrics(characteristics: TaskCharacteristics, estimation: TaskEstimation): TaskMonitoringMetric[] {
    const metrics: TaskMonitoringMetric[] = []

    // Standard metrics
    metrics.push({
      name: 'Progress',
      description: 'Percentage of task completion',
      target: 100,
      unit: '%',
      frequency: 'daily'
    })

    metrics.push({
      name: 'Effort Spent',
      description: 'Hours spent on the task',
      target: estimation.totalHours,
      unit: 'hours',
      frequency: 'daily'
    })

    // Complexity-specific metrics
    if (characteristics.complexity === 'complex' || characteristics.complexity === 'expert') {
      metrics.push({
        name: 'Code Quality',
        description: 'Code quality score from analysis',
        target: 80,
        unit: 'score',
        frequency: 'weekly'
      })
    }

    // Type-specific metrics
    if (characteristics.type === 'bug') {
      metrics.push({
        name: 'Bug Resolution',
        description: 'Bug completely resolved',
        target: 1,
        unit: 'boolean',
        frequency: 'on_completion'
      })
    }

    return metrics
  }

  private async identifyTaskOpportunities(context: Context, options?: any): Promise<TaskOpportunity[]> {
    const opportunities: TaskOpportunity[] = []

    // Code quality opportunities
    if (context.project.codebaseAnalysis.issues.length > 0) {
      const criticalIssues = context.project.codebaseAnalysis.issues.filter(i => i.severity === 'critical')
      if (criticalIssues.length > 0) {
        opportunities.push({
          title: 'Fix Critical Code Issues',
          description: `Address ${criticalIssues.length} critical issues in codebase`,
          reasoning: 'Critical issues pose significant risk and should be addressed urgently',
          priority: 'critical',
          estimatedEffort: 'medium',
          category: 'bug',
          benefits: ['Improved stability', 'Reduced risk', 'Better maintainability'],
          confidence: 0.9
        })
      }
    }

    // Testing opportunities
    const hasLowTestCoverage = context.project.codebaseAnalysis.issues.some(i =>
      i.description.includes('test') && i.severity !== 'low'
    )
    if (hasLowTestCoverage) {
      opportunities.push({
        title: 'Improve Test Coverage',
        description: 'Add comprehensive tests for critical components',
        reasoning: 'Low test coverage increases risk of regressions and bugs',
        priority: 'high',
        estimatedEffort: 'large',
        category: 'testing',
        benefits: ['Better reliability', 'Easier refactoring', 'Confidence in changes'],
        confidence: 0.8
      })
    }

    // Documentation opportunities
    if (context.conversation.intent.primary === 'question' && context.conversation.messages.length > 3) {
      opportunities.push({
        title: 'Create Documentation',
        description: 'Document frequently asked questions and common procedures',
        reasoning: 'Multiple questions indicate need for better documentation',
        priority: 'medium',
        estimatedEffort: 'small',
        category: 'documentation',
        benefits: ['Reduced support burden', 'Better onboarding', 'Knowledge sharing'],
        confidence: 0.7
      })
    }

    return opportunities
  }

  private calculatePriority(characteristics: TaskCharacteristics, context: Context): 'low' | 'medium' | 'high' | 'critical' {
    let priority: 'low' | 'medium' | 'high' | 'critical' = 'medium'

    // Type-based priority
    if (characteristics.type === 'bug' && characteristics.estimatedRisk === 'high') {
      priority = 'critical'
    } else if (characteristics.type === 'bug') {
      priority = 'high'
    }

    // Complexity consideration
    if (characteristics.complexity === 'expert' && characteristics.estimatedRisk === 'high') {
      priority = 'high'
    }

    // Context-based adjustments
    if (context.conversation.intent.urgency === 'critical') {
      priority = 'critical'
    } else if (context.conversation.intent.urgency === 'high') {
      priority = 'high'
    }

    return priority
  }

  private calculateAnalysisConfidence(
    characteristics: TaskCharacteristics,
    breakdown: TaskBreakdown,
    estimation: TaskEstimation
  ): number {
    let confidence = 0.5 // Base confidence

    // Characteristics clarity
    if (characteristics.complexity !== 'expert') confidence += 0.2
    if (characteristics.scope === 'small' || characteristics.scope === 'medium') confidence += 0.1

    // Breakdown quality
    if (breakdown.subtasks.length > 0) confidence += 0.15
    if (breakdown.confidence > 0.7) confidence += 0.05

    // Estimation confidence
    confidence += estimation.confidence * 0.1

    return Math.min(1.0, confidence)
  }

  // Helper methods
  private determineScope(text: string, context: Context): 'small' | 'medium' | 'large' | 'enterprise' {
    const largeIndicators = ['system', 'platform', 'architecture', 'migration', 'enterprise']
    const mediumIndicators = ['feature', 'service', 'component', 'integration', 'module']
    const smallIndicators = ['fix', 'update', 'change', 'tweak', 'adjust']

    if (largeIndicators.some(indicator => text.includes(indicator))) return 'enterprise'
    if (mediumIndicators.some(indicator => text.includes(indicator))) return 'large'
    if (smallIndicators.some(indicator => text.includes(indicator))) return 'small'
    return 'medium'
  }

  private identifyTechnicalDomains(text: string, context: Context): string[] {
    const domains: string[] = []

    const domainKeywords = {
      frontend: ['ui', 'interface', 'component', 'react', 'vue', 'angular'],
      backend: ['api', 'server', 'database', 'service', 'endpoint'],
      devops: ['deploy', 'ci/cd', 'docker', 'kubernetes', 'infrastructure'],
      security: ['auth', 'security', 'permission', 'encryption', 'vulnerability'],
      performance: ['optimize', 'performance', 'speed', 'memory', 'cpu'],
      testing: ['test', 'spec', 'qa', 'automation', 'coverage']
    }

    for (const [domain, keywords] of Object.entries(domainKeywords)) {
      if (keywords.some(keyword => text.includes(keyword))) {
        domains.push(domain)
      }
    }

    return domains
  }

  private hasExternalDependencies(text: string, context: Context): boolean {
    const externalIndicators = ['third-party', 'external', 'api', 'service', 'integration', 'vendor']
    return externalIndicators.some(indicator => text.includes(indicator))
  }

  private estimateRisk(complexity: string, type: string, scope: string): 'low' | 'medium' | 'high' {
    if (complexity === 'expert' || scope === 'enterprise') return 'high'
    if (complexity === 'complex' || scope === 'large' || type === 'bug') return 'medium'
    return 'low'
  }

  private groupSubtasksIntoPhases(subtasks: TaskSubtask[]): TaskSubtask[][] {
    // Simple grouping by dependency and logical order
    const phases: TaskSubtask[][] = []
    const remaining = [...subtasks]

    while (remaining.length > 0) {
      const phase = remaining.splice(0, Math.min(3, remaining.length))
      phases.push(phase)
    }

    return phases
  }

  private generateMilestoneName(phase: TaskSubtask[], index: number, total: number): string {
    if (index === 1) return 'Foundation Complete'
    if (index === total) return 'Implementation Complete'
    return `Phase ${index} Complete`
  }

  private generateMilestoneDescription(phase: TaskSubtask[]): string {
    return `Complete ${phase.map(t => t.name).join(', ')}`
  }

  private generateSuccessCriteria(phase: TaskSubtask[]): string[] {
    return phase.map(subtask => `${subtask.name} implemented and tested`)
  }

  private createExecutionPhases(subtasks: TaskSubtask[], dependencies: TaskDependencies): TaskExecutionPhase[] {
    const phases: TaskExecutionPhase[] = []
    const phaseGroups = this.groupSubtasksIntoPhases(subtasks)

    phaseGroups.forEach((group, index) => {
      phases.push({
        id: randomUUID(),
        name: `Phase ${index + 1}`,
        subtasks: group,
        estimatedDuration: group.reduce((sum, t) => sum + t.estimatedDays, 0),
        dependencies: index > 0 ? [phases[index - 1].id] : [],
        status: 'pending'
      })
    })

    return phases
  }

  private calculateExecutionTimeline(phases: TaskExecutionPhase[], estimation: TaskEstimation): TaskTimeline {
    let currentDate = new Date()
    const phaseTimelines = phases.map(phase => {
      const startDate = new Date(currentDate)
      currentDate = new Date(currentDate.getTime() + phase.estimatedDuration * 24 * 60 * 60 * 1000)

      return {
        phaseId: phase.id,
        startDate: startDate.toISOString(),
        endDate: currentDate.toISOString(),
        duration: phase.estimatedDuration
      }
    })

    return {
      totalDuration: estimation.totalDays,
      startDate: phaseTimelines[0]?.startDate || new Date().toISOString(),
      endDate: phaseTimelines[phaseTimelines.length - 1]?.endDate || new Date().toISOString(),
      phases: phaseTimelines
    }
  }

  private identifyCriticalPath(phases: TaskExecutionPhase[], dependencies: TaskDependencies): string[] {
    // Simplified critical path - longest sequence of dependent phases
    return phases.map(p => p.id)
  }

  private calculateResourceRequirements(breakdown: TaskBreakdown, estimation: TaskEstimation): TaskResourceRequirement[] {
    return [
      {
        type: 'developer',
        quantity: 1,
        duration: estimation.totalDays,
        skills: breakdown.requiredSkills
      }
    ]
  }

  private defineCheckpoints(phases: TaskExecutionPhase[]): TaskCheckpoint[] {
    return phases.map((phase, index) => ({
      id: randomUUID(),
      name: `${phase.name} Review`,
      description: `Review completion of ${phase.name}`,
      scheduledDate: new Date(Date.now() + (index + 1) * 7 * 24 * 60 * 60 * 1000).toISOString(),
      criteria: [`All ${phase.name} tasks completed`, 'Quality review passed']
    }))
  }

  private createContingencyPlans(breakdown: TaskBreakdown, dependencies: TaskDependencies): TaskContingencyPlan[] {
    return [
      {
        risk: 'Task takes longer than estimated',
        trigger: 'Progress < 50% at midpoint',
        actions: ['Re-evaluate scope', 'Add resources', 'Extend timeline'],
        owner: 'project_manager'
      },
      {
        risk: 'Technical blockers encountered',
        trigger: 'Blocker prevents progress for > 2 days',
        actions: ['Escalate to senior developer', 'Research alternative approaches', 'Seek external help'],
        owner: 'technical_lead'
      }
    ]
  }

  private getTaskAnalysis(taskId: string): TaskAnalysis | undefined {
    return this.taskAnalysisCache.get(taskId)
  }

  private calculateEstimatedCompletion(analysis: TaskAnalysis, execution: any): string {
    const progress = execution.progress / 100
    const timeSpent = execution.timeSpent
    const estimatedTotal = timeSpent / progress
    const remaining = estimatedTotal - timeSpent

    return new Date(Date.now() + remaining * 60 * 60 * 1000).toISOString()
  }

  private isTaskOnTrack(analysis: TaskAnalysis, execution: any): boolean {
    const expectedProgress = (execution.timeSpent / analysis.estimation.totalHours) * 100
    return execution.progress >= expectedProgress * 0.8 // 80% of expected progress
  }

  private async generateExecutionRecommendations(analysis: TaskAnalysis, execution: any): Promise<string[]> {
    const recommendations: string[] = []

    if (!this.isTaskOnTrack(analysis, execution)) {
      recommendations.push('Task is behind schedule - consider adding resources or reducing scope')
    }

    if (execution.issues && execution.issues.length > 0) {
      recommendations.push('Address current blockers before proceeding with new work')
    }

    return recommendations
  }

  private assessExecutionRisks(analysis: TaskAnalysis, execution: any): string[] {
    const risks: string[] = []

    if (execution.progress < 25 && execution.timeSpent > analysis.estimation.totalHours * 0.5) {
      risks.push('High risk of significant schedule overrun')
    }

    if (execution.issues && execution.issues.length > 2) {
      risks.push('Multiple blockers may indicate scope or technical issues')
    }

    return risks
  }

  private suggestNextActions(analysis: TaskAnalysis, execution: any): string[] {
    const actions: string[] = []

    if (execution.issues && execution.issues.length > 0) {
      actions.push('Resolve current blockers')
    } else {
      actions.push('Continue with next planned milestone')
    }

    if (execution.progress < 50) {
      actions.push('Review and validate approach')
    }

    return actions
  }

  private calculateExecutionConfidence(analysis: TaskAnalysis, execution: any): number {
    let confidence = analysis.confidence

    // Adjust based on execution performance
    if (this.isTaskOnTrack(analysis, execution)) {
      confidence = Math.min(1.0, confidence + 0.1)
    } else {
      confidence = Math.max(0.3, confidence - 0.2)
    }

    // Adjust based on issues
    if (execution.issues && execution.issues.length > 0) {
      confidence = Math.max(0.2, confidence - (execution.issues.length * 0.1))
    }

    return confidence
  }

  private updateEstimationHistory(taskId: string, analysis: TaskAnalysis, execution: any): void {
    if (!this.estimationHistory.has(taskId)) {
      this.estimationHistory.set(taskId, [])
    }

    const history = this.estimationHistory.get(taskId)!
    history.push({
      timestamp: new Date().toISOString(),
      estimatedHours: analysis.estimation.totalHours,
      actualHours: execution.timeSpent,
      estimatedProgress: (execution.timeSpent / analysis.estimation.totalHours) * 100,
      actualProgress: execution.progress
    })
  }

  private async updateTaskPatterns(analysis: TaskAnalysis): Promise<void> {
    const patternKey = `${analysis.characteristics.type}_${analysis.characteristics.complexity}_${analysis.characteristics.scope}`

    const existing = this.taskPatterns.get(patternKey)
    if (existing) {
      existing.frequency++
      existing.averageEstimation = (existing.averageEstimation + analysis.estimation.totalHours) / 2
      existing.averageConfidence = (existing.averageConfidence + analysis.confidence) / 2
    } else {
      this.taskPatterns.set(patternKey, {
        pattern: patternKey,
        frequency: 1,
        averageEstimation: analysis.estimation.totalHours,
        averageConfidence: analysis.confidence,
        characteristics: analysis.characteristics
      })

      this.metrics.patternsDiscovered++
    }
  }

  private async extractTaskInsights(analysis: TaskAnalysis, completion: any): Promise<string[]> {
    const insights: string[] = []

    const effortDiff = completion.actualEffort - analysis.estimation.totalHours
    if (effortDiff > analysis.estimation.totalHours * 0.5) {
      insights.push('Task required significantly more effort than estimated')
    }

    if (completion.actualComplexity !== analysis.characteristics.complexity) {
      insights.push(`Actual complexity (${completion.actualComplexity}) differed from estimated (${analysis.characteristics.complexity})`)
    }

    return insights
  }

  private async generateImprovementSuggestions(analysis: TaskAnalysis, completion: any): Promise<string[]> {
    const suggestions: string[] = []

    if (completion.actualEffort > analysis.estimation.totalHours * 1.5) {
      suggestions.push('Improve effort estimation for similar tasks by accounting for complexity factors')
    }

    if (completion.issues.length > 0) {
      suggestions.push('Add risk assessment for technical challenges in similar domains')
    }

    return suggestions
  }

  private suggestAssignee(opportunity: TaskOpportunity, context: Context): string | undefined {
    // Simple assignee suggestion based on task category and context
    if (opportunity.category === 'bug' && context.user.expertise.includes('debugging')) {
      return context.user.id
    }

    if (opportunity.category === 'frontend' && context.user.expertise.includes('react')) {
      return context.user.id
    }

    return undefined
  }

  getMetrics() {
    return { ...this.metrics }
  }

  getTaskPatterns(): TaskPattern[] {
    return Array.from(this.taskPatterns.values())
  }

  getCachedAnalyses(): TaskAnalysis[] {
    return Array.from(this.taskAnalysisCache.values())
  }
}

// Supporting Classes
class TaskBreakdownEngine {
  async initialize(): Promise<void> {
    console.log('  🔨 Task breakdown engine ready')
  }

  async breakdownTask(params: {
    description: string
    context: Context
    characteristics: TaskCharacteristics
    constraints: TaskConstraint[]
  }): Promise<TaskBreakdown> {
    const subtasks: TaskSubtask[] = []

    // Generate subtasks based on characteristics
    if (params.characteristics.requiresBackendWork) {
      subtasks.push({
        id: randomUUID(),
        name: 'Backend Implementation',
        description: 'Implement server-side logic and APIs',
        estimatedHours: 8,
        estimatedDays: 1,
        requiredSkills: ['backend', 'api_development'],
        dependencies: []
      })
    }

    if (params.characteristics.requiresFrontendWork) {
      subtasks.push({
        id: randomUUID(),
        name: 'Frontend Implementation',
        description: 'Implement user interface components',
        estimatedHours: 6,
        estimatedDays: 1,
        requiredSkills: ['frontend', 'ui_development'],
        dependencies: params.characteristics.requiresBackendWork ? [subtasks[0]?.id].filter(Boolean) : []
      })
    }

    if (params.characteristics.requiresTesting) {
      subtasks.push({
        id: randomUUID(),
        name: 'Testing Implementation',
        description: 'Create and execute comprehensive tests',
        estimatedHours: 4,
        estimatedDays: 0.5,
        requiredSkills: ['testing', 'qa'],
        dependencies: subtasks.map(t => t.id)
      })
    }

    if (params.characteristics.requiresDocumentation) {
      subtasks.push({
        id: randomUUID(),
        name: 'Documentation',
        description: 'Update relevant documentation',
        estimatedHours: 2,
        estimatedDays: 0.25,
        requiredSkills: ['documentation', 'technical_writing'],
        dependencies: []
      })
    }

    // Default subtask if none generated
    if (subtasks.length === 0) {
      subtasks.push({
        id: randomUUID(),
        name: 'Implementation',
        description: params.description,
        estimatedHours: 4,
        estimatedDays: 0.5,
        requiredSkills: ['development'],
        dependencies: []
      })
    }

    return {
      subtasks,
      totalSubtasks: subtasks.length,
      requiredSkills: [...new Set(subtasks.flatMap(t => t.requiredSkills))],
      confidence: 0.8,
      rationale: 'Generated based on task characteristics and requirements'
    }
  }
}

class EffortEstimator {
  async initialize(): Promise<void> {
    console.log('  ⏱️  Effort estimator ready')
  }

  async estimate(params: {
    task: string
    subtasks: TaskSubtask[]
    complexity: string
    context: Context
  }): Promise<TaskEstimation> {
    // Calculate base estimates from subtasks
    const totalHours = params.subtasks.reduce((sum, t) => sum + t.estimatedHours, 0)
    const totalDays = params.subtasks.reduce((sum, t) => sum + t.estimatedDays, 0)

    // Apply complexity multiplier
    const complexityMultiplier = {
      simple: 1.0,
      moderate: 1.3,
      complex: 1.8,
      expert: 2.5
    }[params.complexity] || 1.3

    const adjustedHours = totalHours * complexityMultiplier
    const adjustedDays = totalDays * complexityMultiplier

    return {
      totalHours: Math.round(adjustedHours),
      totalDays: Math.round(adjustedDays * 10) / 10, // Round to 1 decimal
      subtaskEstimates: params.subtasks.map(t => ({
        subtaskId: t.id,
        hours: Math.round(t.estimatedHours * complexityMultiplier),
        days: Math.round(t.estimatedDays * complexityMultiplier * 10) / 10
      })),
      confidence: this.calculateEstimationConfidence(params.complexity, params.subtasks.length),
      methodology: 'Bottom-up estimation with complexity adjustment',
      assumptions: [
        'Standard 8-hour work days',
        'No major blockers or external delays',
        'Resources available as needed'
      ]
    }
  }

  private calculateEstimationConfidence(complexity: string, subtaskCount: number): number {
    let confidence = 0.8 // Base confidence

    // Reduce confidence for higher complexity
    if (complexity === 'expert') confidence -= 0.2
    else if (complexity === 'complex') confidence -= 0.1

    // Increase confidence for well-broken-down tasks
    if (subtaskCount > 3) confidence += 0.1

    return Math.max(0.3, Math.min(1.0, confidence))
  }
}

class DependencyAnalyzer {
  async initialize(): Promise<void> {
    console.log('  🔗 Dependency analyzer ready')
  }

  async analyze(params: {
    subtasks: TaskSubtask[]
    context: Context
    parentTask?: string
  }): Promise<TaskDependencies> {
    const internal = params.subtasks.map(subtask => ({
      subtaskId: subtask.id,
      dependsOn: subtask.dependencies,
      type: 'internal' as const,
      description: `${subtask.name} depends on completion of prerequisite tasks`
    })).filter(dep => dep.dependsOn.length > 0)

    // Mock external dependencies
    const external = []
    if (params.context.project.activeTasks.length > 0) {
      external.push({
        name: 'Related Project Task',
        type: 'external' as const,
        description: 'Depends on completion of related project tasks',
        estimatedResolution: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
      })
    }

    return {
      internal,
      external,
      critical: internal.filter(dep => dep.dependsOn.length > 1),
      optional: []
    }
  }
}

class RiskAssessor {
  async initialize(): Promise<void> {
    console.log('  ⚠️  Risk assessor ready')
  }

  async assess(params: {
    task: string
    subtasks: TaskSubtask[]
    context: Context
    estimation: TaskEstimation
  }): Promise<TaskRisk[]> {
    const risks: TaskRisk[] = []

    // Estimation risk
    if (params.estimation.confidence < 0.7) {
      risks.push({
        id: randomUUID(),
        type: 'estimation',
        severity: 'medium',
        description: 'Low confidence in effort estimation',
        impact: 'Schedule delays and budget overruns',
        probability: 0.4,
        mitigation: 'Add buffer time and regular progress reviews',
        owner: 'project_manager'
      })
    }

    // Complexity risk
    if (params.subtasks.some(t => t.requiredSkills.includes('expert'))) {
      risks.push({
        id: randomUUID(),
        type: 'technical',
        severity: 'high',
        description: 'Task requires specialized expertise',
        impact: 'Technical blockers and quality issues',
        probability: 0.6,
        mitigation: 'Involve senior developers and conduct regular reviews',
        owner: 'technical_lead'
      })
    }

    // Resource risk
    if (params.subtasks.length > 5) {
      risks.push({
        id: randomUUID(),
        type: 'resource',
        severity: 'medium',
        description: 'Complex task with many components',
        impact: 'Coordination challenges and potential delays',
        probability: 0.3,
        mitigation: 'Clear task dependencies and regular coordination',
        owner: 'project_manager'
      })
    }

    return risks
  }
}

// Supporting Interfaces
interface TaskAnalysis {
  id: string
  taskDescription: string
  characteristics: TaskCharacteristics
  breakdown: TaskBreakdown
  estimation: TaskEstimation
  dependencies: TaskDependencies
  risks: TaskRisk[]
  recommendedApproach: TaskApproach
  milestones: TaskMilestone[]
  acceptanceCriteria: string[]
  executionPlan: TaskExecutionPlan
  monitoringMetrics: TaskMonitoringMetric[]
  priority: 'low' | 'medium' | 'high' | 'critical'
  confidence: number
  analyzedAt: string
  processingTime: number
}

interface TaskCharacteristics {
  complexity: 'simple' | 'moderate' | 'complex' | 'expert'
  type: 'feature' | 'bug' | 'improvement' | 'maintenance' | 'research'
  scope: 'small' | 'medium' | 'large' | 'enterprise'
  domains: string[]
  requiresUserInput: boolean
  requiresBackendWork: boolean
  requiresFrontendWork: boolean
  requiresTesting: boolean
  requiresDocumentation: boolean
  hasExternalDependencies: boolean
  estimatedRisk: 'low' | 'medium' | 'high'
}

interface TaskBreakdown {
  subtasks: TaskSubtask[]
  totalSubtasks: number
  requiredSkills: string[]
  confidence: number
  rationale: string
}

interface TaskSubtask {
  id: string
  name: string
  description: string
  estimatedHours: number
  estimatedDays: number
  requiredSkills: string[]
  dependencies: string[]
}

interface TaskEstimation {
  totalHours: number
  totalDays: number
  subtaskEstimates: Array<{
    subtaskId: string
    hours: number
    days: number
  }>
  confidence: number
  methodology: string
  assumptions: string[]
}

interface TaskDependencies {
  internal: Array<{
    subtaskId: string
    dependsOn: string[]
    type: 'internal'
    description: string
  }>
  external: Array<{
    name: string
    type: 'external'
    description: string
    estimatedResolution: string
  }>
  critical: any[]
  optional: any[]
}

interface TaskRisk {
  id: string
  type: 'technical' | 'resource' | 'estimation' | 'external'
  severity: 'low' | 'medium' | 'high' | 'critical'
  description: string
  impact: string
  probability: number
  mitigation: string
  owner: string
}

interface TaskApproach {
  name: string
  description: string
  advantages: string[]
  disadvantages: string[]
  suitability: number
}

interface TaskMilestone {
  id: string
  name: string
  description: string
  deliverables: string[]
  estimatedCompletion: number
  dependencies: string[]
  successCriteria: string[]
}

interface TaskExecutionPlan {
  phases: TaskExecutionPhase[]
  timeline: TaskTimeline
  criticalPath: string[]
  resourceRequirements: TaskResourceRequirement[]
  checkpoints: TaskCheckpoint[]
  contingencyPlans: TaskContingencyPlan[]
}

interface TaskExecutionPhase {
  id: string
  name: string
  subtasks: TaskSubtask[]
  estimatedDuration: number
  dependencies: string[]
  status: 'pending' | 'in_progress' | 'completed'
}

interface TaskTimeline {
  totalDuration: number
  startDate: string
  endDate: string
  phases: Array<{
    phaseId: string
    startDate: string
    endDate: string
    duration: number
  }>
}

interface TaskResourceRequirement {
  type: string
  quantity: number
  duration: number
  skills: string[]
}

interface TaskCheckpoint {
  id: string
  name: string
  description: string
  scheduledDate: string
  criteria: string[]
}

interface TaskContingencyPlan {
  risk: string
  trigger: string
  actions: string[]
  owner: string
}

interface TaskMonitoringMetric {
  name: string
  description: string
  target: number
  unit: string
  frequency: string
}

interface TaskSuggestion {
  id: string
  title: string
  description: string
  reasoning: string
  priority: 'low' | 'medium' | 'high' | 'critical'
  estimatedEffort: 'small' | 'medium' | 'large'
  category: string
  benefits: string[]
  prerequisites: string[]
  suggestedAssignee?: string
  confidence: number
}

interface TaskOpportunity {
  title: string
  description: string
  reasoning: string
  priority: 'low' | 'medium' | 'high' | 'critical'
  estimatedEffort: 'small' | 'medium' | 'large'
  category: string
  benefits: string[]
  prerequisites?: string[]
  confidence: number
}

interface TaskExecutionInsight {
  taskId: string
  currentProgress: number
  estimatedCompletion: string
  isOnTrack: boolean
  blockers: string[]
  recommendations: string[]
  riskAlerts: string[]
  nextActions: string[]
  confidenceLevel: number
}

interface TaskLearning {
  taskId: string
  originalAnalysis: TaskAnalysis
  actualResults: any
  estimationAccuracy: {
    effort: number
    duration: number
  }
  insights: string[]
  improvementSuggestions: string[]
  learnedAt: string
}

interface TaskPattern {
  pattern: string
  frequency: number
  averageEstimation: number
  averageConfidence: number
  characteristics: TaskCharacteristics
}

interface TaskConstraint {
  type: 'time' | 'resource' | 'budget' | 'technical' | 'business'
  description: string
  value?: any
  required: boolean
}

interface EstimationResult {
  timestamp: string
  estimatedHours: number
  actualHours: number
  estimatedProgress: number
  actualProgress: number
}
