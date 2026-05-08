/**
 * Planning Engine - Strategic Task Planning and Execution Orchestration
 * 
 * Creates intelligent, multi-phase plans based on context analysis and
 * manages plan execution with adaptive replanning capabilities.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

import type {
  autonomusConfig,
  Context,
  Plan,
  Phase,
  Objective,
  Action,
  Risk,
  Dependency
} from '../types'

/**
 * PlanningEngine creates and manages strategic execution plans
 */
export class PlanningEngine extends EventEmitter {
  private config: autonomusConfig
  private activePlans = new Map<string, Plan>()
  private planTemplates = new Map<string, PlanTemplate>()

  // Planning strategies
  private strategies = new Map<string, PlanningStrategy>()

  // Metrics
  private metrics = {
    plansCreated: 0,
    plansCompleted: 0,
    averagePlanDuration: 0,
    successRate: 0,
    replansRequired: 0
  }

  constructor(config: autonomusConfig) {
    super()
    this.config = config
    this.initializeStrategies()
    this.initializePlanTemplates()
  }

  async initialize(): Promise<void> {
    console.log('📋 Initializing Planning Engine...')

    // Load existing plans if any
    await this.loadActivePlans()

    console.log('✅ Planning Engine ready')
  }

  /**
   * Create a strategic plan based on context and decisions
   */
  async createPlan(params: {
    context: Context
    decisions: any[]
    horizon: 'immediate' | 'tactical' | 'strategic' | 'visionary'
    objectives?: string[]
    constraints?: string[]
  }): Promise<Plan> {
    const startTime = Date.now()

    try {
      console.log(`📊 Creating ${params.horizon} plan...`)

      // Analyze context to determine plan type
      const planType = this.determinePlanType(params.context, params.decisions)

      // Get appropriate strategy
      const strategy = this.strategies.get(planType) || this.strategies.get('default')!

      // Create plan structure
      const plan = await strategy.createPlan({
        context: params.context,
        decisions: params.decisions,
        horizon: params.horizon,
        constraints: params.constraints || []
      })

      // Enrich with dependencies and risks
      await this.enrichPlanWithAnalysis(plan, params.context)

      // Validate plan feasibility
      const validation = await this.validatePlan(plan)
      if (!validation.valid) {
        console.warn('⚠️  Plan validation issues:', validation.issues)
        plan.risks.push(...validation.issues.map(issue => ({
          type: 'technical' as const,
          description: issue,
          impact: 'medium' as const,
          probability: 0.6,
          mitigation: 'Review and adjust plan objectives'
        })))
      }

      // Store plan
      this.activePlans.set(plan.id, plan)
      this.metrics.plansCreated++

      const duration = Date.now() - startTime
      this.emit('plan_created', { plan, duration, strategy: planType })

      console.log(`✅ Plan created: "${plan.title}" (${plan.phases.length} phases, ${plan.objectives.length} objectives)`)

      return plan

    } catch (error) {
      console.error('❌ Plan creation failed:', error)
      throw error
    }
  }

  /**
   * Execute a plan with monitoring and adaptive replanning
   */
  async executePlan(planId: string): Promise<{
    success: boolean
    completedPhases: number
    remainingPhases: number
    adaptations: string[]
  }> {
    const plan = this.activePlans.get(planId)
    if (!plan) {
      throw new Error(`Plan not found: ${planId}`)
    }

    console.log(`🚀 Executing plan: "${plan.title}"`)
    plan.status = 'executing'

    const adaptations: string[] = []
    let completedPhases = 0

    try {
      for (const phase of plan.phases) {
        if (phase.status === 'completed') {
          completedPhases++
          continue
        }

        console.log(`⚡ Executing phase: ${phase.name}`)
        phase.status = 'in_progress'

        // Check dependencies
        const dependenciesReady = await this.checkPhaseDependencies(phase, plan)
        if (!dependenciesReady.ready) {
          console.warn(`⏳ Phase dependencies not ready: ${dependenciesReady.missing.join(', ')}`)
          // Could implement waiting or replanning logic here
          continue
        }

        // Execute phase actions
        const phaseResult = await this.executePhase(phase, plan)

        if (phaseResult.success) {
          phase.status = 'completed'
          completedPhases++

          // Check if we need to adapt the plan based on results
          const adaptationNeeded = await this.assessAdaptationNeed(phaseResult, plan)
          if (adaptationNeeded.needed) {
            console.log(`🔄 Adapting plan: ${adaptationNeeded.reason}`)
            await this.adaptPlan(plan, adaptationNeeded.changes ?? [])
            adaptations.push(adaptationNeeded.reason ?? '')
          }
        } else {
          phase.status = 'failed'
          console.error(`❌ Phase failed: ${phase.name}`)

          // Implement failure recovery
          const recovery = await this.planFailureRecovery(phase, plan)
          if (recovery.canRecover) {
            console.log(`🔧 Recovering from failure: ${recovery.strategy}`)
            adaptations.push(`Recovery: ${recovery.strategy}`)
            // Apply recovery actions
          } else {
            plan.status = 'failed'
            break
          }
        }

        this.emit('phase_completed', { plan, phase, result: phaseResult })
      }

      // Update plan status
      if (completedPhases === plan.phases.length) {
        plan.status = 'completed'
        this.metrics.plansCompleted++
        this.metrics.successRate = this.metrics.plansCompleted / this.metrics.plansCreated
      }

      this.emit('plan_executed', {
        plan,
        completedPhases,
        remainingPhases: plan.phases.length - completedPhases,
        adaptations
      })

      return {
        success: plan.status === 'completed',
        completedPhases,
        remainingPhases: plan.phases.length - completedPhases,
        adaptations
      }

    } catch (error) {
      plan.status = 'failed'
      console.error('❌ Plan execution failed:', error)
      throw error
    }
  }

  /**
   * Get plan progress and status
   */
  getPlanStatus(planId: string): {
    plan: Plan
    progress: number
    currentPhase?: Phase
    estimatedCompletion?: string
    risks: Risk[]
  } | null {
    const plan = this.activePlans.get(planId)
    if (!plan) return null

    const completedPhases = plan.phases.filter(p => p.status === 'completed').length
    const progress = completedPhases / plan.phases.length

    const currentPhase = plan.phases.find(p => p.status === 'in_progress')

    // Estimate completion time
    const remainingDuration = plan.phases
      .filter(p => p.status === 'pending')
      .reduce((sum, p) => sum + p.duration, 0)

    const estimatedCompletion = remainingDuration > 0
      ? new Date(Date.now() + remainingDuration * 60 * 1000).toISOString()
      : undefined

    return {
      plan,
      progress,
      currentPhase,
      estimatedCompletion,
      risks: plan.risks
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private determinePlanType(context: Context, decisions: any[]): string {
    // Analyze context to determine the most appropriate planning strategy

    if (context.conversation.intent.complexity === 'expert') {
      return 'complex_development'
    }

    if (decisions.some(d => d.chosen === 'create_task')) {
      return 'task_development'
    }

    if (decisions.some(d => d.chosen === 'create_ticket')) {
      return 'issue_resolution'
    }

    if (context.project.codebaseAnalysis.issues.length > 0) {
      return 'technical_debt'
    }

    return 'general_development'
  }

  private async enrichPlanWithAnalysis(plan: Plan, context: Context): Promise<void> {
    // Add dependencies between phases
    this.analyzePhaseDependencies(plan)

    // Identify risks
    this.identifyPlanRisks(plan, context)

    // Estimate effort and duration
    this.estimatePlanEffort(plan, context)
  }

  private analyzePhaseDependencies(plan: Plan): void {
    // Simple dependency analysis - later phases depend on earlier ones
    for (let i = 1; i < plan.phases.length; i++) {
      plan.phases[i].dependencies.push(plan.phases[i - 1].id)
    }

    // Add specific dependencies based on phase types
    const designPhase = plan.phases.find(p => p.name.toLowerCase().includes('design'))
    const implementationPhases = plan.phases.filter(p => p.name.toLowerCase().includes('implement'))

    if (designPhase && implementationPhases.length > 0) {
      implementationPhases.forEach(phase => {
        if (!phase.dependencies.includes(designPhase.id)) {
          phase.dependencies.push(designPhase.id)
        }
      })
    }
  }

  private identifyPlanRisks(plan: Plan, context: Context): void {
    const risks: Risk[] = []

    // Technical risks
    if (context.project.codebaseAnalysis.complexity === 'expert') {
      risks.push({
        type: 'technical',
        description: 'High codebase complexity may cause unexpected issues',
        impact: 'high',
        probability: 0.6,
        mitigation: 'Add extra buffer time and thorough testing phases'
      })
    }

    // Resource risks
    if (plan.phases.length > 5) {
      risks.push({
        type: 'resource',
        description: 'Long plan may face resource availability issues',
        impact: 'medium',
        probability: 0.4,
        mitigation: 'Regular progress reviews and resource planning'
      })
    }

    // Timeline risks
    const totalDuration = plan.phases.reduce((sum, p) => sum + p.duration, 0)
    if (totalDuration > 480) { // 8 hours
      risks.push({
        type: 'timeline',
        description: 'Extended timeline increases risk of scope changes',
        impact: 'medium',
        probability: 0.5,
        mitigation: 'Break into smaller milestones with regular reviews'
      })
    }

    plan.risks.push(...risks)
  }

  private estimatePlanEffort(plan: Plan, context: Context): void {
    let totalDuration = 0

    plan.phases.forEach(phase => {
      // Base duration from phase actions
      const actionDuration = phase.actions.reduce((sum, action) => {
        return sum + this.estimateActionDuration(action, context)
      }, 0)

      // Add complexity multiplier
      const complexityMultiplier = this.getComplexityMultiplier(context)
      phase.duration = Math.round(actionDuration * complexityMultiplier)

      totalDuration += phase.duration
    })

    plan.estimatedDuration = totalDuration
  }

  private estimateActionDuration(action: Action, context: Context): number {
    // Base estimates in minutes
    const baseDurations: Record<string, number> = {
      create_ticket: 10,
      create_task: 15,
      analyze_code: 30,
      generate_code: 60,
      run_command: 5,
      ask_question: 2,
      gather_information: 20
    }

    return baseDurations[action.type] || 15
  }

  private getComplexityMultiplier(context: Context): number {
    switch (context.conversation.intent.complexity) {
      case 'simple': return 1.0
      case 'moderate': return 1.5
      case 'complex': return 2.0
      case 'expert': return 3.0
      default: return 1.5
    }
  }

  private async validatePlan(plan: Plan): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = []

    // Check if objectives are achievable
    if (plan.objectives.length === 0) {
      issues.push('Plan has no clear objectives')
    }

    // Check phase structure
    if (plan.phases.length === 0) {
      issues.push('Plan has no execution phases')
    }

    // Check for circular dependencies
    const hasCycles = this.detectCircularDependencies(plan.phases)
    if (hasCycles) {
      issues.push('Plan has circular dependencies between phases')
    }

    // Check effort estimates
    if (plan.estimatedDuration > 2400) { // 40 hours
      issues.push('Plan duration exceeds reasonable limits')
    }

    return {
      valid: issues.length === 0,
      issues
    }
  }

  private detectCircularDependencies(phases: Phase[]): boolean {
    // Simple cycle detection - could be enhanced with proper graph algorithms
    const visited = new Set<string>()
    const recursionStack = new Set<string>()

    const hasCycle = (phaseId: string): boolean => {
      if (recursionStack.has(phaseId)) return true
      if (visited.has(phaseId)) return false

      visited.add(phaseId)
      recursionStack.add(phaseId)

      const phase = phases.find(p => p.id === phaseId)
      if (phase) {
        for (const depId of phase.dependencies) {
          if (hasCycle(depId)) return true
        }
      }

      recursionStack.delete(phaseId)
      return false
    }

    for (const phase of phases) {
      if (hasCycle(phase.id)) return true
    }

    return false
  }

  private async executePhase(phase: Phase, plan: Plan): Promise<{ success: boolean; results: any[] }> {
    const results: any[] = []

    try {
      for (const action of phase.actions) {
        console.log(`  ⚡ Executing action: ${action.title}`)

        // Mock action execution
        const result = await this.executeAction(action, plan)
        results.push(result)

        if (!result.success) {
          return { success: false, results }
        }
      }

      return { success: true, results }
    } catch (error) {
      console.error(`Phase execution error: ${error}`)
      return { success: false, results }
    }
  }

  private async executeAction(action: Action, plan: Plan): Promise<any> {
    // Mock action execution - in real implementation, this would delegate to ActionExecutor
    await new Promise(resolve => setTimeout(resolve, 100)) // Simulate work

    return {
      success: Math.random() > 0.1, // 90% success rate
      output: `Action ${action.title} completed`,
      duration: Math.random() * 1000
    }
  }

  private async checkPhaseDependencies(phase: Phase, plan: Plan): Promise<{ ready: boolean; missing: string[] }> {
    const missing: string[] = []

    for (const depId of phase.dependencies) {
      const depPhase = plan.phases.find(p => p.id === depId)
      if (!depPhase || depPhase.status !== 'completed') {
        missing.push(depPhase?.name || depId)
      }
    }

    return {
      ready: missing.length === 0,
      missing
    }
  }

  private async assessAdaptationNeed(phaseResult: any, plan: Plan): Promise<{
    needed: boolean
    reason?: string
    changes?: string[]
  }> {
    // Simple adaptation logic - could be much more sophisticated
    if (phaseResult.results.some((r: any) => r.duration > 2000)) {
      return {
        needed: true,
        reason: 'Phase took longer than expected',
        changes: ['Adjust remaining phase estimates', 'Consider parallel execution']
      }
    }

    return { needed: false }
  }

  private async adaptPlan(plan: Plan, changes: string[]): Promise<void> {
    console.log(`🔄 Adapting plan with changes: ${changes.join(', ')}`)

    // Simple adaptation implementation
    if (changes.includes('Adjust remaining phase estimates')) {
      plan.phases.forEach(phase => {
        if (phase.status === 'pending') {
          phase.duration = Math.round(phase.duration * 1.2) // Add 20% buffer
        }
      })
    }

    // Recalculate total duration
    plan.estimatedDuration = plan.phases.reduce((sum, p) => sum + p.duration, 0)
  }

  private async planFailureRecovery(phase: Phase, plan: Plan): Promise<{
    canRecover: boolean
    strategy?: string
    actions?: string[]
  }> {
    // Simple recovery strategy
    if (phase.actions.length > 1) {
      return {
        canRecover: true,
        strategy: 'Skip failed action and continue',
        actions: ['Mark failed action as skipped', 'Continue with remaining actions']
      }
    }

    return {
      canRecover: false
    }
  }

  private initializeStrategies(): void {
    // Task Development Strategy
    this.strategies.set('task_development', {
      name: 'Task Development',
      createPlan: async (params) => {
        const plan = this.createBasePlan(params)
        plan.title = 'Development Task Plan'

        plan.phases = [
          this.createPhase('Analysis', 'Analyze requirements and technical approach', 30),
          this.createPhase('Design', 'Design solution architecture and approach', 60),
          this.createPhase('Implementation', 'Implement the solution', 180),
          this.createPhase('Testing', 'Test the implementation', 60),
          this.createPhase('Documentation', 'Update documentation', 30),
          this.createPhase('Review', 'Code review and feedback', 45)
        ]

        return plan
      }
    })

    // Issue Resolution Strategy
    this.strategies.set('issue_resolution', {
      name: 'Issue Resolution',
      createPlan: async (params) => {
        const plan = this.createBasePlan(params)
        plan.title = 'Issue Resolution Plan'

        plan.phases = [
          this.createPhase('Investigation', 'Investigate the issue and root cause', 45),
          this.createPhase('Diagnosis', 'Diagnose the problem and identify solution', 30),
          this.createPhase('Fix Implementation', 'Implement the fix', 90),
          this.createPhase('Verification', 'Verify the fix works correctly', 30),
          this.createPhase('Testing', 'Test for regression and side effects', 45)
        ]

        return plan
      }
    })

    // Default Strategy
    this.strategies.set('default', {
      name: 'General Development',
      createPlan: async (params) => {
        const plan = this.createBasePlan(params)
        plan.title = 'General Development Plan'

        plan.phases = [
          this.createPhase('Planning', 'Plan the approach and gather requirements', 20),
          this.createPhase('Execution', 'Execute the main work', 120),
          this.createPhase('Review', 'Review and validate results', 30)
        ]

        return plan
      }
    })
  }

  private initializePlanTemplates(): void {
    // Initialize reusable plan templates
    // This could be expanded with more sophisticated templates
  }

  private createBasePlan(params: any): Plan {
    return {
      id: randomUUID(),
      title: 'Development Plan',
      description: 'Automated plan generated from conversation analysis',
      context: params.context,
      objectives: [],
      phases: [],
      dependencies: [],
      risks: [],
      estimatedDuration: 0,
      confidence: 0.8,
      priority: 'medium',
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: 'autonomus_planning_engine'
    }
  }

  private createPhase(name: string, description: string, duration: number): Phase {
    return {
      id: randomUUID(),
      name,
      description,
      actions: [],
      duration,
      dependencies: [],
      status: 'pending'
    }
  }

  private async loadActivePlans(): Promise<void> {
    // In a real implementation, this would load plans from storage
    console.log('📂 Loading active plans...')
  }

  getMetrics() {
    return { ...this.metrics }
  }

  getActivePlans(): Plan[] {
    return Array.from(this.activePlans.values())
  }
}

// Supporting interfaces
interface PlanTemplate {
  name: string
  description: string
  phases: Omit<Phase, 'id'>[]
  defaultObjectives: string[]
}

interface PlanningStrategy {
  name: string
  createPlan: (params: {
    context: Context
    decisions: any[]
    horizon: string
    constraints: string[]
  }) => Promise<Plan>
}
