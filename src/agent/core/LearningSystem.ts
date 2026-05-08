/**
 * Learning System - Adaptive Intelligence and Pattern Recognition
 * 
 * Continuously learns from every interaction, decision, and outcome to
 * improve future performance and decision-making capabilities.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import type {
  autonomusConfig,
  Context,
  Decision,
  Action,
  ActionResult,
  Plan,
  Learning,
  LearningContext
} from '../types'

/**
 * LearningSystem provides continuous improvement through experience
 */
export class LearningSystem extends EventEmitter {
  private config: autonomusConfig
  private learnings = new Map<string, Learning>()
  private patterns = new Map<string, LearningPattern>()
  private memoryPath: string

  // Learning analytics
  private analytics = {
    totalLearnings: 0,
    successLearnings: 0,
    failureLearnings: 0,
    patternsDiscovered: 0,
    learningsApplied: 0,
    improvementRate: 0
  }

  // Pattern recognition
  private patternDetectors = new Map<string, PatternDetector>()

  constructor(config: autonomusConfig) {
    super()
    this.config = config
    this.memoryPath = join(homedir(), '.codmir', 'autonomus-sdk', 'learning-memory.json')
    this.initializePatternDetectors()
  }

  async initialize(): Promise<void> {
    console.log('📚 Initializing Learning System...')

    // Ensure memory directory exists
    await fs.mkdir(join(homedir(), '.codmir', 'autonomus-sdk'), { recursive: true })

    // Load existing memory
    if (this.config.learning.patternRecognitionEnabled) {
      await this.loadMemory()
    }

    console.log(`✅ Learning System ready (${this.learnings.size} learnings, ${this.patterns.size} patterns)`)
  }

  /**
   * Extract learnings from execution results
   */
  async extractLearnings(params: {
    context: Context
    decisions: Decision[]
    actions: Action[]
    plans: Plan[]
  }): Promise<Learning[]> {
    const learnings: Learning[] = []

    try {
      // Learn from decision outcomes
      for (const decision of params.decisions) {
        const decisionLearnings = await this.learnFromDecision(decision, params.context)
        learnings.push(...decisionLearnings)
      }

      // Learn from action results
      for (const action of params.actions) {
        if (action.result) {
          const actionLearnings = await this.learnFromAction(action, action.result, params.context)
          learnings.push(...actionLearnings)
        }
      }

      // Learn from planning effectiveness
      for (const plan of params.plans) {
        const planLearnings = await this.learnFromPlan(plan, params.context)
        learnings.push(...planLearnings)
      }

      // Detect patterns across learnings
      if (this.config.learning.patternRecognitionEnabled) {
        const patternLearnings = await this.detectPatterns(learnings, params.context)
        learnings.push(...patternLearnings)
      }

      // Store learnings
      for (const learning of learnings) {
        this.learnings.set(learning.id, learning)
        this.analytics.totalLearnings++

        if (learning.type === 'success') {
          this.analytics.successLearnings++
        } else if (learning.type === 'failure') {
          this.analytics.failureLearnings++
        }
      }

      this.emit('learnings_extracted', {
        count: learnings.length,
        context: params.context.conversation.id
      })

      return learnings

    } catch (error) {
      console.error('❌ Learning extraction failed:', error)
      return []
    }
  }

  /**
   * Apply learnings to improve future decisions
   */
  async applyLearnings(learnings: Learning[]): Promise<void> {
    for (const learning of learnings) {
      try {
        await this.applyLearning(learning)
        this.analytics.learningsApplied++
        this.emit('learning_applied', learning)
      } catch (error) {
        console.warn(`⚠️  Failed to apply learning ${learning.id}:`, error)
      }
    }

    // Update improvement rate
    this.analytics.improvementRate = this.analytics.learningsApplied / this.analytics.totalLearnings
  }

  /**
   * Learn from failure scenarios
   */
  async learnFromFailure(params: {
    error: string
    context?: Context
    input: any
  }): Promise<Learning> {
    const learning: Learning = {
      id: randomUUID(),
      type: 'failure',
      description: `System failure: ${params.error}`,
      context: {
        situation: 'system_failure',
        factors: {
          error: params.error,
          inputType: params.input.type,
          hasContext: !!params.context
        },
        environment: { autonomyMode: this.config.autonomyMode },
        actors: ['autonomus_system'],
        timeframe: 'immediate'
      },
      whatHappened: `System encountered error: ${params.error}`,
      whyItHappened: 'Could be due to invalid input, missing dependencies, or system constraints',
      whatToDoNext: 'Implement better error handling and input validation',
      confidence: 0.8,
      applicableContexts: ['error_handling', 'system_resilience'],
      actionableInsights: [
        'Add comprehensive error handling',
        'Implement input validation',
        'Add system health checks',
        'Improve error recovery mechanisms'
      ],
      preventionMeasures: [
        'Pre-execution validation',
        'Timeout mechanisms',
        'Graceful degradation',
        'Better error reporting'
      ],
      learnedAt: new Date().toISOString(),
      importance: 0.9,
      verified: false,
      timesApplied: 0,
      successRate: 0
    }

    this.learnings.set(learning.id, learning)
    this.analytics.totalLearnings++
    this.analytics.failureLearnings++

    this.emit('failure_learned', learning)

    return learning
  }

  /**
   * Get relevant learnings for a given context
   */
  getRelevantLearnings(context: Context, limit = 10): Learning[] {
    const allLearnings = Array.from(this.learnings.values())

    // Score learnings by relevance
    const scored = allLearnings.map(learning => ({
      learning,
      score: this.calculateRelevanceScore(learning, context)
    }))

    // Sort by score and return top learnings
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(item => item.learning)
  }

  /**
   * Get learning analytics and insights
   */
  getAnalytics(): {
    overview: {
      totalLearnings: number
      successLearnings: number
      failureLearnings: number
      patternsDiscovered: number
      learningsApplied: number
      improvementRate: number
    }
    topPatterns: LearningPattern[]
    recentLearnings: Learning[]
    improvementTrends: {
      successRate: number
      failureRate: number
      patternGrowth: number
    }
  } {
    const topPatterns = Array.from(this.patterns.values())
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)

    const recentLearnings = Array.from(this.learnings.values())
      .sort((a, b) => new Date(b.learnedAt).getTime() - new Date(a.learnedAt).getTime())
      .slice(0, 10)

    return {
      overview: { ...this.analytics },
      topPatterns,
      recentLearnings,
      improvementTrends: {
        successRate: this.analytics.successLearnings / this.analytics.totalLearnings,
        failureRate: this.analytics.failureLearnings / this.analytics.totalLearnings,
        patternGrowth: this.analytics.patternsDiscovered
      }
    }
  }

  /**
   * Save learning memory to disk
   */
  async saveMemory(): Promise<void> {
    if (!this.config.learningEnabled) return

    try {
      const memoryData = {
        learnings: Array.from(this.learnings.entries()),
        patterns: Array.from(this.patterns.entries()),
        analytics: this.analytics,
        savedAt: new Date().toISOString()
      }

      await fs.writeFile(this.memoryPath, JSON.stringify(memoryData, null, 2))
      console.log(`💾 Learning memory saved (${this.learnings.size} learnings)`)
    } catch (error) {
      console.error('❌ Failed to save learning memory:', error)
    }
  }

  /**
   * Load learning memory from disk
   */
  async loadMemory(): Promise<void> {
    try {
      const data = await fs.readFile(this.memoryPath, 'utf-8')
      const memoryData = JSON.parse(data)

      // Load learnings
      this.learnings.clear()
      for (const [id, learning] of memoryData.learnings) {
        this.learnings.set(id, learning)
      }

      // Load patterns
      this.patterns.clear()
      for (const [id, pattern] of memoryData.patterns) {
        this.patterns.set(id, pattern)
      }

      // Load analytics
      this.analytics = { ...this.analytics, ...memoryData.analytics }

      console.log(`📚 Learning memory loaded (${this.learnings.size} learnings, ${this.patterns.size} patterns)`)
    } catch (error) {
      if ((error as any)?.code !== 'ENOENT') {
        console.warn('⚠️  Failed to load learning memory:', error)
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private async learnFromDecision(decision: Decision, context: Context): Promise<Learning[]> {
    const learnings: Learning[] = []

    // Learn from high-confidence decisions that worked well
    if (decision.confidence > 0.8 && decision.actualOutcome) {
      learnings.push({
        id: randomUUID(),
        type: 'success',
        description: `High-confidence decision: ${decision.question}`,
        context: this.buildLearningContext(decision, context),
        whatHappened: `Made decision with ${decision.confidence} confidence: ${decision.chosen}`,
        whyItHappened: `Strong factors and clear context supported this decision`,
        whatToDoNext: 'Apply similar decision-making patterns to comparable situations',
        confidence: 0.9,
        applicableContexts: [decision.question, ...decision.factors.map(f => f.name)],
        actionableInsights: [
          `High confidence decisions with ${decision.factors.length} factors work well`,
          `Factor combination: ${decision.factors.map(f => f.name).join(', ')}`
        ],
        learnedAt: new Date().toISOString(),
        importance: 0.8,
        verified: true,
        timesApplied: 0,
        successRate: 1.0
      })
    }

    // Learn from decisions with unexpected outcomes
    if (decision.actualOutcome && decision.actualOutcome !== decision.expectedOutcome) {
      learnings.push({
        id: randomUUID(),
        type: 'insight',
        description: `Decision outcome mismatch: ${decision.question}`,
        context: this.buildLearningContext(decision, context),
        whatHappened: `Expected "${decision.expectedOutcome}" but got "${decision.actualOutcome}"`,
        whyItHappened: 'Factors may have been weighted incorrectly or missing information',
        whatToDoNext: 'Adjust factor weights and gather more context for similar decisions',
        confidence: 0.7,
        applicableContexts: [decision.question],
        actionableInsights: [
          'Review factor importance weights',
          'Consider additional context factors',
          'Improve outcome prediction models'
        ],
        optimizationOpportunities: [
          'Better context gathering',
          'Factor weight calibration',
          'Outcome prediction improvement'
        ],
        learnedAt: new Date().toISOString(),
        importance: 0.8,
        verified: false,
        timesApplied: 0,
        successRate: 0
      })
    }

    return learnings
  }

  private async learnFromAction(action: Action, result: ActionResult, context: Context): Promise<Learning[]> {
    const learnings: Learning[] = []

    // Learn from successful actions
    if (result.success && result.confidence > 0.7) {
      learnings.push({
        id: randomUUID(),
        type: 'success',
        description: `Successful ${action.type}: ${action.title}`,
        context: this.buildLearningContext(action, context),
        whatHappened: `Successfully executed ${action.type} with ${result.confidence} confidence`,
        whyItHappened: 'Good action parameters and favorable execution environment',
        whatToDoNext: 'Reuse similar parameters and approach for comparable actions',
        confidence: result.confidence,
        applicableContexts: [action.type, ...action.requiredCapabilities],
        actionableInsights: [
          `${action.type} actions work well with confidence >= ${action.confidence}`,
          `Execution time: ${result.executionTime}ms is acceptable`
        ],
        learnedAt: new Date().toISOString(),
        importance: 0.7,
        verified: true,
        timesApplied: 0,
        successRate: 1.0
      })
    }

    // Learn from failed actions
    if (!result.success) {
      learnings.push({
        id: randomUUID(),
        type: 'failure',
        description: `Failed ${action.type}: ${action.title}`,
        context: this.buildLearningContext(action, context),
        whatHappened: `Failed to execute ${action.type}: ${result.output}`,
        whyItHappened: 'Could be due to invalid parameters, missing dependencies, or system constraints',
        whatToDoNext: 'Review action parameters and add better validation',
        confidence: 0.8,
        applicableContexts: [action.type],
        actionableInsights: [
          'Add pre-execution validation for this action type',
          'Consider alternative approaches',
          'Improve error handling'
        ],
        preventionMeasures: [
          'Parameter validation',
          'Dependency checks',
          'Timeout handling',
          'Rollback mechanisms'
        ],
        learnedAt: new Date().toISOString(),
        importance: 0.9,
        verified: false,
        timesApplied: 0,
        successRate: 0
      })
    }

    return learnings
  }

  private async learnFromPlan(plan: Plan, context: Context): Promise<Learning[]> {
    const learnings: Learning[] = []

    // Learn from completed plans
    if (plan.status === 'completed') {
      const completedPhases = plan.phases.filter(p => p.status === 'completed').length

      learnings.push({
        id: randomUUID(),
        type: 'success',
        description: `Completed plan: ${plan.title}`,
        context: this.buildLearningContext(plan, context),
        whatHappened: `Successfully completed plan with ${completedPhases}/${plan.phases.length} phases`,
        whyItHappened: 'Good phase structure and realistic estimates',
        whatToDoNext: 'Apply similar planning patterns to comparable projects',
        confidence: 0.8,
        applicableContexts: ['planning', plan.title],
        actionableInsights: [
          `Plans with ${plan.phases.length} phases can be completed successfully`,
          `Estimated duration: ${plan.estimatedDuration} minutes was accurate`
        ],
        learnedAt: new Date().toISOString(),
        importance: 0.8,
        verified: true,
        timesApplied: 0,
        successRate: 1.0
      })
    }

    return learnings
  }

  private async detectPatterns(learnings: Learning[], context: Context): Promise<Learning[]> {
    const patternLearnings: Learning[] = []

    // Group learnings by type and context
    const groupedLearnings = this.groupLearningsByPattern(learnings)

    for (const [patternKey, group] of groupedLearnings) {
      if (group.length >= 3) { // Need at least 3 instances to consider a pattern
        const pattern = this.analyzePattern(group, patternKey)

        if (pattern.confidence > 0.6) {
          this.patterns.set(pattern.id, pattern)
          this.analytics.patternsDiscovered++

          // Create learning about the discovered pattern
          patternLearnings.push({
            id: randomUUID(),
            type: 'pattern',
            description: `Discovered pattern: ${pattern.name}`,
            context: this.buildLearningContext(pattern, context),
            whatHappened: `Identified recurring pattern in ${group.length} similar situations`,
            whyItHappened: 'Consistent behavior across multiple contexts',
            whatToDoNext: 'Apply pattern recognition to improve future decisions',
            confidence: pattern.confidence,
            applicableContexts: pattern.applicableContexts,
            actionableInsights: pattern.insights,
            learnedAt: new Date().toISOString(),
            importance: 0.9,
            verified: false,
            timesApplied: 0,
            successRate: pattern.successRate
          })
        }
      }
    }

    return patternLearnings
  }

  private groupLearningsByPattern(learnings: Learning[]): Map<string, Learning[]> {
    const groups = new Map<string, Learning[]>()

    for (const learning of learnings) {
      // Create pattern keys based on similar contexts
      const patternKeys = this.generatePatternKeys(learning)

      for (const key of patternKeys) {
        if (!groups.has(key)) {
          groups.set(key, [])
        }
        groups.get(key)!.push(learning)
      }
    }

    return groups
  }

  private generatePatternKeys(learning: Learning): string[] {
    const keys: string[] = []

    // Pattern by type and situation
    keys.push(`${learning.type}_${learning.context.situation}`)

    // Pattern by applicable contexts
    for (const context of learning.applicableContexts) {
      keys.push(`context_${context}_${learning.type}`)
    }

    // Pattern by factors
    const factors = Object.keys(learning.context.factors)
    if (factors.length > 0) {
      keys.push(`factors_${factors.sort().join('_')}_${learning.type}`)
    }

    return keys
  }

  private analyzePattern(learnings: Learning[], patternKey: string): LearningPattern {
    const successCount = learnings.filter(l => l.type === 'success').length
    const failureCount = learnings.filter(l => l.type === 'failure').length
    const totalCount = learnings.length

    // Calculate pattern statistics
    const avgConfidence = learnings.reduce((sum, l) => sum + l.confidence, 0) / totalCount
    const successRate = successCount / totalCount
    const avgImportance = learnings.reduce((sum, l) => sum + l.importance, 0) / totalCount

    // Extract common insights
    const commonInsights = this.extractCommonInsights(learnings)
    const commonContexts = this.extractCommonContexts(learnings)

    return {
      id: randomUUID(),
      name: patternKey.replace(/_/g, ' ').toUpperCase(),
      description: `Pattern identified from ${totalCount} similar learnings`,
      patternKey,
      instances: learnings.length,
      confidence: Math.min(avgConfidence * (totalCount / 10), 1.0), // Scale by instance count
      successRate,
      insights: commonInsights,
      applicableContexts: commonContexts,
      discoveredAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      timesApplied: 0,
      importance: avgImportance
    }
  }

  private extractCommonInsights(learnings: Learning[]): string[] {
    const insightCounts = new Map<string, number>()

    for (const learning of learnings) {
      for (const insight of learning.actionableInsights) {
        insightCounts.set(insight, (insightCounts.get(insight) || 0) + 1)
      }
    }

    // Return insights that appear in at least 50% of learnings
    const threshold = Math.ceil(learnings.length * 0.5)
    return Array.from(insightCounts.entries())
      .filter(([, count]) => count >= threshold)
      .map(([insight]) => insight)
  }

  private extractCommonContexts(learnings: Learning[]): string[] {
    const contextCounts = new Map<string, number>()

    for (const learning of learnings) {
      for (const context of learning.applicableContexts) {
        contextCounts.set(context, (contextCounts.get(context) || 0) + 1)
      }
    }

    // Return contexts that appear in at least 30% of learnings
    const threshold = Math.ceil(learnings.length * 0.3)
    return Array.from(contextCounts.entries())
      .filter(([, count]) => count >= threshold)
      .map(([context]) => context)
  }

  private async applyLearning(learning: Learning): Promise<void> {
    // Apply learning to improve system behavior
    // In a real implementation, this would update decision weights,
    // action parameters, confidence thresholds, etc.

    learning.timesApplied++
    learning.verified = true

    // Update pattern applications if this learning is part of a pattern
    for (const pattern of this.patterns.values()) {
      if (pattern.applicableContexts.some(context =>
        learning.applicableContexts.includes(context)
      )) {
        pattern.timesApplied++
        pattern.lastSeen = new Date().toISOString()
      }
    }
  }

  private calculateRelevanceScore(learning: Learning, context: Context): number {
    let score = 0

    // Base score from learning importance
    score += learning.importance * 0.3

    // Context relevance
    const contextOverlap = learning.applicableContexts.filter(lc =>
      context.conversation.topics.includes(lc) ||
      context.conversation.keywords.includes(lc) ||
      context.conversation.intent.primary === lc
    ).length

    score += (contextOverlap / learning.applicableContexts.length) * 0.4

    // Recent learnings are more relevant
    const daysSinceLearned = (Date.now() - new Date(learning.learnedAt).getTime()) / (1000 * 60 * 60 * 24)
    const recencyScore = Math.max(0, 1 - (daysSinceLearned / 30)) // Decay over 30 days
    score += recencyScore * 0.2

    // Success rate bonus
    score += learning.successRate * 0.1

    return Math.min(score, 1.0)
  }

  private buildLearningContext(source: any, context: Context): LearningContext {
    return {
      situation: source.type || source.status || 'general',
      factors: {
        confidence: source.confidence || 0,
        complexity: context.conversation.intent.complexity,
        urgency: context.conversation.intent.urgency
      },
      environment: {
        autonomyMode: this.config.autonomyMode,
        projectId: context.project.id,
        userId: context.user.id
      },
      actors: ['autonomus_system', context.user.id],
      timeframe: 'immediate'
    }
  }

  private initializePatternDetectors(): void {
    // Success pattern detector
    this.patternDetectors.set('success_patterns', {
      name: 'Success Pattern Detector',
      detect: (learnings: Learning[]) => {
        return learnings.filter(l => l.type === 'success' && l.confidence > 0.8)
      }
    })

    // Failure pattern detector
    this.patternDetectors.set('failure_patterns', {
      name: 'Failure Pattern Detector',
      detect: (learnings: Learning[]) => {
        return learnings.filter(l => l.type === 'failure')
      }
    })

    // Context pattern detector
    this.patternDetectors.set('context_patterns', {
      name: 'Context Pattern Detector',
      detect: (learnings: Learning[]) => {
        return learnings.filter(l => l.applicableContexts.length > 2)
      }
    })
  }
}

// Supporting interfaces
interface LearningPattern {
  id: string
  name: string
  description: string
  patternKey: string
  instances: number
  confidence: number
  successRate: number
  insights: string[]
  applicableContexts: string[]
  discoveredAt: string
  lastSeen: string
  timesApplied: number
  importance: number
}

interface PatternDetector {
  name: string
  detect: (learnings: Learning[]) => Learning[]
}
