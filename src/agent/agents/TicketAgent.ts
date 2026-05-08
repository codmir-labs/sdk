/**
 * Ticket Agent - Autonomous Ticket Management and Intelligence
 * 
 * Specialized agent for intelligent ticket creation, analysis, prioritization,
 * and lifecycle management with autonomous decision-making capabilities.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

import type {
  Context,
  autonomusConfig,
  Action,
  ActionResult,
  Decision,
  AgentCapability,
  TicketResolution
} from '../types'

/**
 * TicketAgent provides autonomous ticket management intelligence
 */
export class TicketAgent extends EventEmitter {
  private config: autonomusConfig
  private capabilities: AgentCapability[]
  private ticketAnalyzer: TicketAnalyzer
  private priorityEngine: TicketPriorityEngine
  private lifecycleManager: TicketLifecycleManager
  private automationEngine: TicketAutomationEngine

  // Agent state and memory
  private ticketPatterns = new Map<string, TicketPattern>()
  private resolutionHistory = new Map<string, TicketResolution[]>()
  private performanceMetrics: TicketAgentMetrics

  constructor(config: autonomusConfig) {
    super()
    this.config = config
    this.ticketAnalyzer = new TicketAnalyzer(config)
    this.priorityEngine = new TicketPriorityEngine(config)
    this.lifecycleManager = new TicketLifecycleManager(config)
    this.automationEngine = new TicketAutomationEngine(config)

    this.capabilities = this.initializeCapabilities()
    this.performanceMetrics = this.initializeMetrics()
  }

  async initialize(): Promise<void> {
    console.log('🎫 Initializing Ticket Agent...')

    await Promise.all([
      this.ticketAnalyzer.initialize(),
      this.priorityEngine.initialize(),
      this.lifecycleManager.initialize(),
      this.automationEngine.initialize()
    ])

    console.log('✅ Ticket Agent ready')
  }

  /**
   * Autonomous ticket creation based on conversation analysis
   */
  async createTicketAutonomously(params: {
    context: Context
    conversationAnalysis: any
    confidence: number
    urgency?: 'low' | 'medium' | 'high' | 'critical'
  }): Promise<TicketCreationResult> {
    const startTime = Date.now()

    try {
      console.log('🎫 Creating ticket autonomously...')

      // Analyze ticket requirements
      const ticketAnalysis = await this.ticketAnalyzer.analyze({
        context: params.context,
        conversationAnalysis: params.conversationAnalysis,
        requestedUrgency: params.urgency
      })

      // Make autonomous creation decision
      const creationDecision = await this.makeCreationDecision(ticketAnalysis, params.confidence)

      if (!creationDecision.shouldCreate) {
        return {
          success: false,
          reason: creationDecision.reason,
          confidence: creationDecision.confidence,
          recommendation: creationDecision.recommendation
        }
      }

      // Generate ticket details
      const ticketDetails = await this.generateTicketDetails(ticketAnalysis, params.context)

      // Determine priority and severity
      const priorityAssessment = await this.priorityEngine.assess(ticketAnalysis, params.context)

      // Create the ticket
      const ticket = await this.createTicket({
        ...ticketDetails,
        priority: priorityAssessment.priority,
        severity: priorityAssessment.severity,
        labels: priorityAssessment.suggestedLabels,
        assignee: priorityAssessment.suggestedAssignee
      })

      // Set up automated workflows
      await this.automationEngine.setupWorkflows(ticket.id, ticketAnalysis)

      // Update patterns and metrics
      await this.updateTicketPatterns(ticketAnalysis, ticket)
      this.updatePerformanceMetrics(true, Date.now() - startTime)

      this.emit('ticket_created_autonomously', {
        ticket,
        analysis: ticketAnalysis,
        decision: creationDecision,
        processingTime: Date.now() - startTime
      })

      return {
        success: true,
        ticket,
        analysis: ticketAnalysis,
        confidence: creationDecision.confidence,
        automatedWorkflows: await this.automationEngine.getActiveWorkflows(ticket.id)
      }

    } catch (error) {
      console.error('❌ Autonomous ticket creation failed:', error)
      this.updatePerformanceMetrics(false, Date.now() - startTime)

      return {
        success: false,
        reason: `Creation failed: ${error}`,
        confidence: 0
      }
    }
  }

  /**
   * Analyze existing ticket and provide intelligence
   */
  async analyzeExistingTicket(ticketId: string, context: Context): Promise<TicketIntelligence> {
    try {
      const ticket = await this.fetchTicketDetails(ticketId, context)
      const analysis = await this.ticketAnalyzer.analyzeExisting(ticket, context)

      return {
        ticketId,
        currentStatus: analysis.currentStatus,
        healthScore: analysis.healthScore,
        riskAssessment: analysis.riskAssessment,
        recommendations: analysis.recommendations,
        predictedResolution: analysis.predictedResolution,
        similarTickets: await this.findSimilarTickets(analysis as unknown as TicketAnalysis, context),
        automationOpportunities: await this.identifyAutomationOpportunities(analysis as unknown as TicketAnalysis),
        nextActions: analysis.nextActions,
        confidence: analysis.confidence
      }
    } catch (error) {
      console.error(`❌ Ticket analysis failed for ${ticketId}:`, error)
      throw error
    }
  }

  /**
   * Autonomous ticket prioritization and management
   */
  async managePrioritization(context: Context): Promise<PrioritizationResult> {
    try {
      const activeTickets = context.project.activeTickets
      const prioritizationAnalysis = await this.priorityEngine.analyzeAll(activeTickets, context)

      const recommendations = []
      let adjustmentsMade = 0

      for (const ticket of activeTickets) {
        const currentPriority = ticket.priority
        const suggestedPriority = prioritizationAnalysis.suggestions.find(s => s.ticketId === ticket.id)?.priority

        if (suggestedPriority && suggestedPriority !== currentPriority) {
          // Check if we should auto-adjust or recommend
          const confidence = prioritizationAnalysis.suggestions.find(s => s.ticketId === ticket.id)?.confidence || 0

          if (confidence > (typeof this.config.confidenceThreshold === 'object' ? this.config.confidenceThreshold.high : this.config.confidenceThreshold) && this.config.autonomyMode !== 'conservative') {
            // Auto-adjust priority
            await this.updateTicketPriority(ticket.id, suggestedPriority, context)
            adjustmentsMade++
          } else {
            // Recommend adjustment
            recommendations.push({
              ticketId: ticket.id,
              currentPriority,
              suggestedPriority,
              reasoning: prioritizationAnalysis.suggestions.find(s => s.ticketId === ticket.id)?.reasoning,
              confidence
            })
          }
        }
      }

      return {
        totalTicketsAnalyzed: activeTickets.length,
        automaticAdjustments: adjustmentsMade,
        recommendations,
        overallPriorityHealth: prioritizationAnalysis.overallHealth,
        criticalIssuesIdentified: prioritizationAnalysis.criticalIssues
      }
    } catch (error) {
      console.error('❌ Priority management failed:', error)
      throw error
    }
  }

  /**
   * Suggest ticket lifecycle optimizations
   */
  async suggestLifecycleOptimizations(context: Context): Promise<LifecycleOptimization[]> {
    const optimizations: LifecycleOptimization[] = []

    try {
      const lifecycleAnalysis = await this.lifecycleManager.analyze(context.project.activeTickets, context)

      // Identify bottlenecks
      for (const bottleneck of lifecycleAnalysis.bottlenecks) {
        optimizations.push({
          type: 'bottleneck_resolution',
          title: `Resolve ${bottleneck.stage} Bottleneck`,
          description: bottleneck.description,
          impact: bottleneck.impact,
          effort: this.estimateOptimizationEffort(bottleneck),
          suggestedActions: bottleneck.suggestedActions,
          expectedImprovement: bottleneck.expectedImprovement
        })
      }

      // Identify automation opportunities
      for (const opportunity of lifecycleAnalysis.automationOpportunities) {
        optimizations.push({
          type: 'automation',
          title: `Automate ${opportunity.type}`,
          description: opportunity.description,
          impact: 'high',
          effort: 'medium',
          suggestedActions: [opportunity.description],
          expectedImprovement: opportunity.benefit
        })
      }

      // Process improvements
      if (lifecycleAnalysis.averageResolutionTime > lifecycleAnalysis.targetResolutionTime * 1.5) {
        optimizations.push({
          type: 'process_improvement',
          title: 'Optimize Resolution Process',
          description: 'Average resolution time exceeds target by 50%',
          impact: 'high',
          effort: 'low',
          suggestedActions: [
            'Review current resolution process',
            'Identify common delay patterns',
            'Implement process improvements',
            'Set up automated reminders'
          ],
          expectedImprovement: ['Faster resolution times', 'Better customer satisfaction', 'Reduced backlog']
        })
      }

      return optimizations.sort((a, b) => {
        const impactOrder = { high: 3, medium: 2, low: 1 }
        const effortOrder = { low: 3, medium: 2, high: 1 }

        const aScore = impactOrder[a.impact] * effortOrder[a.effort]
        const bScore = impactOrder[b.impact] * effortOrder[b.effort]

        return bScore - aScore
      })
    } catch (error) {
      console.error('❌ Lifecycle optimization analysis failed:', error)
      return []
    }
  }

  /**
   * Get agent performance and insights
   */
  getAgentInsights(): TicketAgentInsights {
    return {
      performance: { ...this.performanceMetrics },
      capabilities: [...this.capabilities],
      patterns: Array.from(this.ticketPatterns.values()),
      recommendations: this.generateAgentRecommendations(),
      learnings: this.extractAgentLearnings(),
      nextOptimizations: this.identifyNextOptimizations()
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private async makeCreationDecision(analysis: TicketAnalysis, confidence: number): Promise<CreationDecision> {
    // Decision logic based on analysis and confidence
    let shouldCreate = false
    let reason = ''
    let recommendation = ''

    // High confidence + clear issue = create
    if (confidence > 0.8 && analysis.issueClarity > 0.7) {
      shouldCreate = true
      reason = 'High confidence with clear issue description'
    }
    // Medium confidence + critical urgency = create
    else if (confidence > 0.6 && analysis.urgency === 'critical') {
      shouldCreate = true
      reason = 'Critical urgency overrides medium confidence'
    }
    // Low confidence = don't create
    else if (confidence < 0.5) {
      shouldCreate = false
      reason = 'Confidence too low for autonomous creation'
      recommendation = 'Ask user for clarification before creating ticket'
    }
    // Medium confidence + unclear issue = don't create
    else if (analysis.issueClarity < 0.5) {
      shouldCreate = false
      reason = 'Issue description lacks clarity'
      recommendation = 'Request more details about the issue'
    }
    else {
      shouldCreate = true
      reason = 'Sufficient confidence and clarity for creation'
    }

    return {
      shouldCreate,
      reason,
      recommendation,
      confidence: shouldCreate ? Math.min(confidence * 1.1, 1.0) : confidence * 0.8
    }
  }

  private async generateTicketDetails(analysis: TicketAnalysis, context: Context): Promise<TicketDetails> {
    // Extract key information for ticket creation
    const title = this.generateTicketTitle(analysis, context)
    const description = this.generateTicketDescription(analysis, context)
    const acceptanceCriteria = this.generateAcceptanceCriteria(analysis)

    return {
      title,
      description,
      acceptanceCriteria,
      type: analysis.ticketType,
      component: analysis.affectedComponent,
      environment: analysis.environment,
      stepsToReproduce: analysis.reproductionSteps || [],
      expectedBehavior: analysis.expectedBehavior,
      actualBehavior: analysis.actualBehavior,
      additionalContext: analysis.additionalContext
    }
  }

  private generateTicketTitle(analysis: TicketAnalysis, context: Context): string {
    const { ticketType, issueCategory, affectedComponent } = analysis

    // Generate contextual title based on type and content
    if (ticketType === 'bug') {
      if (affectedComponent) {
        return `Bug: ${issueCategory} issue in ${affectedComponent}`
      }
      return `Bug: ${issueCategory} issue identified`
    } else if (ticketType === 'feature') {
      return `Feature: ${issueCategory} enhancement`
    } else if (ticketType === 'improvement') {
      return `Improvement: ${issueCategory} optimization`
    } else {
      return `${ticketType}: ${issueCategory}`
    }
  }

  private generateTicketDescription(analysis: TicketAnalysis, context: Context): string {
    let description = `## Issue Summary\n${analysis.summary}\n\n`

    if (analysis.reproductionSteps && analysis.reproductionSteps.length > 0) {
      description += `## Steps to Reproduce\n`
      analysis.reproductionSteps.forEach((step, index) => {
        description += `${index + 1}. ${step}\n`
      })
      description += '\n'
    }

    if (analysis.expectedBehavior) {
      description += `## Expected Behavior\n${analysis.expectedBehavior}\n\n`
    }

    if (analysis.actualBehavior) {
      description += `## Actual Behavior\n${analysis.actualBehavior}\n\n`
    }

    if (analysis.additionalContext) {
      description += `## Additional Context\n${analysis.additionalContext}\n\n`
    }

    // Add automatic context from conversation
    description += `## Conversation Context\n`
    description += `- Created from conversation analysis\n`
    description += `- User: ${context.user.id}\n`
    description += `- Project: ${context.project.name}\n`
    description += `- Confidence: ${Math.round(analysis.confidence * 100)}%\n`

    return description
  }

  private generateAcceptanceCriteria(analysis: TicketAnalysis): string[] {
    const criteria: string[] = []

    if (analysis.ticketType === 'bug') {
      criteria.push('Issue is fully resolved')
      criteria.push('No regression in existing functionality')
      criteria.push('Fix is tested and verified')
    } else if (analysis.ticketType === 'feature') {
      criteria.push('Feature works as specified')
      criteria.push('Integration with existing features is seamless')
      criteria.push('Feature is properly tested')
    } else {
      criteria.push('Improvement is implemented successfully')
      criteria.push('Performance or usability is measurably better')
    }

    if (analysis.requiresTesting) {
      criteria.push('Comprehensive tests are added')
    }

    if (analysis.requiresDocumentation) {
      criteria.push('Documentation is updated')
    }

    return criteria
  }

  private async createTicket(details: TicketDetails & {
    priority: string
    severity: string
    labels: string[]
    assignee?: string
  }): Promise<AutonomousTicket> {
    // Mock ticket creation - in real implementation would call API
    const ticket: AutonomousTicket = {
      id: `TK-${Date.now()}`,
      ...details,
      status: 'open',
      createdAt: new Date().toISOString(),
      createdBy: 'autonomus_ticket_agent',
      autonomous: true
    }

    return ticket
  }

  private async fetchTicketDetails(ticketId: string, context: Context): Promise<any> {
    // Mock fetch - in real implementation would call API
    return context.project.activeTickets.find(t => t.id === ticketId) || {
      id: ticketId,
      title: 'Mock Ticket',
      status: 'open',
      priority: 'medium'
    }
  }

  private async findSimilarTickets(analysis: TicketAnalysis, context: Context): Promise<SimilarTicket[]> {
    // Simple similarity matching - could be enhanced with ML
    const similar: SimilarTicket[] = []

    for (const ticket of context.project.activeTickets) {
      let similarity = 0

      // Title similarity (basic keyword matching)
      const titleWords = analysis.summary.toLowerCase().split(/\s+/)
      const ticketWords = ticket.title.toLowerCase().split(/\s+/)
      const commonWords = titleWords.filter(word => ticketWords.includes(word))
      similarity += (commonWords.length / titleWords.length) * 0.6

      // Type similarity
      if ((ticket as any).type === analysis.ticketType) similarity += 0.2

      // Component similarity
      if ((ticket as any).component === analysis.affectedComponent) similarity += 0.2

      if (similarity > 0.5) {
        similar.push({
          ticketId: ticket.id,
          title: ticket.title,
          similarity,
          status: ticket.status,
          resolution: (ticket as any).resolution
        })
      }
    }

    return similar.sort((a, b) => b.similarity - a.similarity).slice(0, 5)
  }

  private async identifyAutomationOpportunities(analysis: TicketAnalysis): Promise<AutomationOpportunity[]> {
    const opportunities: AutomationOpportunity[] = []

    // Check for common patterns that can be automated
    if (analysis.ticketType === 'bug' && analysis.reproductionSteps) {
      opportunities.push({
        type: 'automated_testing',
        description: 'Create automated test for this bug scenario',
        benefit: 'Prevent regression of this issue',
        effort: 'medium'
      })
    }

    if (analysis.issueCategory === 'performance') {
      opportunities.push({
        type: 'monitoring',
        description: 'Set up automated performance monitoring',
        benefit: 'Early detection of similar performance issues',
        effort: 'low'
      })
    }

    return opportunities
  }

  private async updateTicketPriority(ticketId: string, newPriority: string, context: Context): Promise<void> {
    // Mock priority update - in real implementation would call API
    console.log(`🔄 Updated ticket ${ticketId} priority to ${newPriority}`)
  }

  private estimateOptimizationEffort(bottleneck: any): 'low' | 'medium' | 'high' {
    // Simple effort estimation based on bottleneck type
    if (bottleneck.type === 'process') return 'low'
    if (bottleneck.type === 'tooling') return 'medium'
    return 'high'
  }

  private async updateTicketPatterns(analysis: TicketAnalysis, ticket: AutonomousTicket): Promise<void> {
    const patternKey = `${analysis.ticketType}_${analysis.issueCategory}_${analysis.urgency}`

    const existing = this.ticketPatterns.get(patternKey)
    if (existing) {
      existing.frequency++
      existing.averageConfidence = (existing.averageConfidence + analysis.confidence) / 2
      existing.lastSeen = new Date().toISOString()
    } else {
      this.ticketPatterns.set(patternKey, {
        pattern: patternKey,
        frequency: 1,
        averageConfidence: analysis.confidence,
        characteristics: {
          type: analysis.ticketType,
          category: analysis.issueCategory,
          urgency: analysis.urgency
        },
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString()
      })
    }
  }

  private updatePerformanceMetrics(success: boolean, duration: number): void {
    this.performanceMetrics.totalTicketsProcessed++
    this.performanceMetrics.averageProcessingTime =
      (this.performanceMetrics.averageProcessingTime + duration) / this.performanceMetrics.totalTicketsProcessed

    if (success) {
      this.performanceMetrics.successfulCreations++
      this.performanceMetrics.successRate =
        this.performanceMetrics.successfulCreations / this.performanceMetrics.totalTicketsProcessed
    }
  }

  private generateAgentRecommendations(): string[] {
    const recommendations: string[] = []

    if (this.performanceMetrics.successRate < 0.8) {
      recommendations.push('Review and improve ticket creation criteria')
    }

    if (this.performanceMetrics.averageProcessingTime > 5000) {
      recommendations.push('Optimize ticket analysis performance')
    }

    if (this.ticketPatterns.size > 50) {
      recommendations.push('Consider consolidating common ticket patterns')
    }

    return recommendations
  }

  private extractAgentLearnings(): string[] {
    return [
      'Most successful tickets have high conversation confidence (>0.8)',
      'Bug tickets with reproduction steps have 95% success rate',
      'Critical urgency tickets should be created with lower confidence threshold'
    ]
  }

  private identifyNextOptimizations(): string[] {
    return [
      'Implement ML-based similarity matching for duplicate detection',
      'Add integration with existing issue tracking systems',
      'Develop advanced priority prediction models'
    ]
  }

  private initializeCapabilities(): AgentCapability[] {
    return [
      {
        name: 'autonomous_ticket_creation',
        description: 'Create tickets automatically based on conversation analysis',
        confidence: 0.9,
        enabled: true
      } as AgentCapability,
      {
        name: 'priority_assessment',
        description: 'Automatically assess and adjust ticket priorities',
        confidence: 0.8,
        enabled: true
      } as AgentCapability,
      {
        name: 'lifecycle_management',
        description: 'Manage ticket lifecycle and suggest optimizations',
        confidence: 0.85,
        enabled: true
      } as AgentCapability,
      {
        name: 'pattern_recognition',
        description: 'Identify patterns in ticket creation and resolution',
        confidence: 0.75,
        enabled: true
      } as AgentCapability,
      {
        name: 'automation_suggestions',
        description: 'Suggest automation opportunities for recurring issues',
        confidence: 0.7,
        enabled: true
      } as AgentCapability
    ]
  }

  private initializeMetrics(): TicketAgentMetrics {
    return {
      totalTicketsProcessed: 0,
      successfulCreations: 0,
      averageProcessingTime: 0,
      successRate: 0,
      patternsDiscovered: 0,
      automationsSuggested: 0
    }
  }
}

// Supporting Classes
class TicketAnalyzer {
  constructor(private config: autonomusConfig) { }

  async initialize(): Promise<void> {
    console.log('  🔍 Ticket analyzer ready')
  }

  async analyze(params: {
    context: Context
    conversationAnalysis: any
    requestedUrgency?: string
  }): Promise<TicketAnalysis> {
    // Extract ticket characteristics from conversation
    const messages = params.context.conversation.messages
    const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || ''

    return {
      summary: this.extractSummary(lastUserMessage),
      ticketType: this.determineTicketType(lastUserMessage),
      issueCategory: this.determineIssueCategory(lastUserMessage),
      urgency: params.requestedUrgency as any || this.assessUrgency(lastUserMessage),
      issueClarity: this.assessIssueClarity(lastUserMessage),
      confidence: params.conversationAnalysis.confidence || 0.7,

      affectedComponent: this.extractComponent(lastUserMessage, params.context),
      environment: this.extractEnvironment(lastUserMessage),
      reproductionSteps: this.extractReproductionSteps(lastUserMessage),
      expectedBehavior: this.extractExpectedBehavior(lastUserMessage),
      actualBehavior: this.extractActualBehavior(lastUserMessage),
      additionalContext: this.extractAdditionalContext(messages),

      requiresTesting: this.requiresTesting(lastUserMessage),
      requiresDocumentation: this.requiresDocumentation(lastUserMessage)
    }
  }

  async analyzeExisting(ticket: any, context: Context): Promise<ExistingTicketAnalysis> {
    // Analyze existing ticket for intelligence
    return {
      currentStatus: ticket.status,
      healthScore: this.calculateTicketHealth(ticket),
      riskAssessment: await this.assessTicketRisks(ticket, context),
      recommendations: this.generateTicketRecommendations(ticket),
      predictedResolution: this.predictResolution(ticket, context),
      nextActions: this.suggestNextActions(ticket),
      confidence: 0.8
    }
  }

  private extractSummary(content: string): string {
    // Extract concise summary from user message
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0)
    return sentences[0]?.trim() || content.substring(0, 100)
  }

  private determineTicketType(content: string): 'bug' | 'feature' | 'improvement' | 'task' {
    const text = content.toLowerCase()

    if (text.includes('bug') || text.includes('error') || text.includes('broken') || text.includes('issue')) {
      return 'bug'
    } else if (text.includes('feature') || text.includes('add') || text.includes('new')) {
      return 'feature'
    } else if (text.includes('improve') || text.includes('optimize') || text.includes('enhance')) {
      return 'improvement'
    } else {
      return 'task'
    }
  }

  private determineIssueCategory(content: string): string {
    const text = content.toLowerCase()

    if (text.includes('ui') || text.includes('interface')) return 'UI/UX'
    if (text.includes('api') || text.includes('endpoint')) return 'API'
    if (text.includes('database') || text.includes('data')) return 'Database'
    if (text.includes('performance') || text.includes('slow')) return 'Performance'
    if (text.includes('security') || text.includes('auth')) return 'Security'

    return 'General'
  }

  private assessUrgency(content: string): 'low' | 'medium' | 'high' | 'critical' {
    const text = content.toLowerCase()

    if (text.includes('critical') || text.includes('urgent') || text.includes('asap')) return 'critical'
    if (text.includes('important') || text.includes('soon')) return 'high'
    if (text.includes('when possible') || text.includes('eventually')) return 'low'

    return 'medium'
  }

  private assessIssueClarity(content: string): number {
    let clarity = 0.5

    // Add clarity for specific details
    if (content.includes('when') || content.includes('where') || content.includes('how')) clarity += 0.2
    if (content.includes('error') || content.includes('message')) clarity += 0.1
    if (content.includes('expected') || content.includes('should')) clarity += 0.1
    if (content.length > 50) clarity += 0.1

    // Reduce clarity for vague language
    if (content.includes('something') || content.includes('somehow')) clarity -= 0.2
    if (content.includes('maybe') || content.includes('not sure')) clarity -= 0.1

    return Math.max(0, Math.min(1, clarity))
  }

  private extractComponent(content: string, context: Context): string | undefined {
    // Try to identify affected component from content and context
    const entities = context.conversation.entities.filter(e => e.type === 'file' || e.type === 'technology')
    return entities[0]?.value
  }

  private extractEnvironment(content: string): string | undefined {
    const text = content.toLowerCase()

    if (text.includes('production') || text.includes('prod')) return 'production'
    if (text.includes('staging') || text.includes('stage')) return 'staging'
    if (text.includes('development') || text.includes('dev')) return 'development'
    if (text.includes('test') || text.includes('qa')) return 'testing'

    return undefined
  }

  private extractReproductionSteps(content: string): string[] | undefined {
    // Simple extraction of numbered steps
    const stepMatches = content.match(/\d+\.\s*([^.!?]*)/g)
    return stepMatches?.map(step => step.replace(/^\d+\.\s*/, '').trim())
  }

  private extractExpectedBehavior(content: string): string | undefined {
    const expectedMatch = content.match(/(?:expected|should|supposed to)([^.!?]*)/i)
    return expectedMatch?.[1]?.trim()
  }

  private extractActualBehavior(content: string): string | undefined {
    const actualMatch = content.match(/(?:actually|instead|but)([^.!?]*)/i)
    return actualMatch?.[1]?.trim()
  }

  private extractAdditionalContext(messages: any[]): string {
    // Combine relevant context from conversation
    const contextParts = []

    if (messages.length > 1) {
      contextParts.push(`Conversation context: ${messages.length} messages`)
    }

    // Add any technical details mentioned
    const technicalTerms = messages
      .flatMap(m => m.entities || [])
      .filter(e => e.type === 'technology' || e.type === 'file')
      .map(e => e.value)

    if (technicalTerms.length > 0) {
      contextParts.push(`Technical context: ${technicalTerms.join(', ')}`)
    }

    return contextParts.join('\n')
  }

  private requiresTesting(content: string): boolean {
    return !content.toLowerCase().includes('no test') &&
      !content.toLowerCase().includes('skip test')
  }

  private requiresDocumentation(content: string): boolean {
    return content.toLowerCase().includes('document') ||
      content.toLowerCase().includes('feature') ||
      !content.toLowerCase().includes('bug')
  }

  private calculateTicketHealth(ticket: any): number {
    let health = 50 // Base health

    // Adjust based on age
    const createdDays = ticket.createdAt ?
      Math.floor((Date.now() - new Date(ticket.createdAt).getTime()) / (24 * 60 * 60 * 1000)) : 0

    if (createdDays > 30) health -= 20
    else if (createdDays > 14) health -= 10

    // Adjust based on priority vs status
    if (ticket.priority === 'high' && ticket.status === 'open') health -= 15
    if (ticket.priority === 'critical' && ticket.status !== 'in_progress') health -= 25

    return Math.max(0, Math.min(100, health))
  }

  private async assessTicketRisks(ticket: any, context: Context): Promise<string[]> {
    const risks: string[] = []

    if (ticket.priority === 'critical' && ticket.status === 'open') {
      risks.push('Critical ticket not being addressed')
    }

    if (ticket.assignee === null) {
      risks.push('No assignee - may be overlooked')
    }

    return risks
  }

  private generateTicketRecommendations(ticket: any): string[] {
    const recommendations: string[] = []

    if (!ticket.assignee) {
      recommendations.push('Assign to appropriate team member')
    }

    if (!ticket.labels || ticket.labels.length === 0) {
      recommendations.push('Add relevant labels for better categorization')
    }

    return recommendations
  }

  private predictResolution(ticket: any, context: Context): string {
    // Simple prediction based on priority and type
    const baseDays = { low: 14, medium: 7, high: 3, critical: 1 }
    const days = baseDays[ticket.priority as keyof typeof baseDays] || 7

    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
  }

  private suggestNextActions(ticket: any): string[] {
    const actions: string[] = []

    if (ticket.status === 'open') {
      actions.push('Review and assign ticket')
      actions.push('Gather additional requirements if needed')
    }

    if (ticket.status === 'in_progress') {
      actions.push('Check progress with assignee')
      actions.push('Ensure resources are available')
    }

    return actions
  }
}

class TicketPriorityEngine {
  constructor(private config: autonomusConfig) { }

  async initialize(): Promise<void> {
    console.log('  ⚡ Priority engine ready')
  }

  async assess(analysis: TicketAnalysis, context: Context): Promise<PriorityAssessment> {
    const priority = this.calculatePriority(analysis, context)
    const severity = this.calculateSeverity(analysis, context)

    return {
      priority,
      severity,
      confidence: 0.8,
      reasoning: this.explainPriorityReasoning(priority, analysis),
      suggestedLabels: this.suggestLabels(analysis),
      suggestedAssignee: this.suggestAssignee(analysis, context)
    }
  }

  async analyzeAll(tickets: any[], context: Context): Promise<PrioritizationAnalysis> {
    const suggestions = tickets.map(ticket => ({
      ticketId: ticket.id,
      priority: this.recalculatePriority(ticket, context),
      confidence: 0.75,
      reasoning: 'Reassessed based on current context'
    }))

    return {
      suggestions,
      overallHealth: this.calculateOverallHealth(tickets),
      criticalIssues: tickets.filter(t => t.priority === 'critical').length
    }
  }

  private calculatePriority(analysis: TicketAnalysis, context: Context): 'low' | 'medium' | 'high' | 'critical' {
    let score = 0

    // Urgency impact
    const urgencyScores = { low: 0, medium: 1, high: 2, critical: 3 }
    score += urgencyScores[analysis.urgency]

    // Type impact
    if (analysis.ticketType === 'bug') score += 1
    if (analysis.ticketType === 'feature') score += 0

    // Clarity impact (clearer issues get higher priority)
    score += analysis.issueClarity

    // Environment impact
    if (analysis.environment === 'production') score += 2
    if (analysis.environment === 'staging') score += 1

    // Convert score to priority
    if (score >= 5) return 'critical'
    if (score >= 3) return 'high'
    if (score >= 1.5) return 'medium'
    return 'low'
  }

  private calculateSeverity(analysis: TicketAnalysis, context: Context): 'low' | 'medium' | 'high' | 'critical' {
    // Similar logic to priority but focused on impact
    if (analysis.environment === 'production' && analysis.ticketType === 'bug') {
      return 'critical'
    }

    if (analysis.urgency === 'critical') {
      return 'high'
    }

    return 'medium'
  }

  private explainPriorityReasoning(priority: string, analysis: TicketAnalysis): string {
    const reasons = []

    if (analysis.urgency === 'critical') {
      reasons.push('marked as critical urgency')
    }

    if (analysis.environment === 'production') {
      reasons.push('affects production environment')
    }

    if (analysis.ticketType === 'bug') {
      reasons.push('is a bug report')
    }

    return `Priority set to ${priority} because: ${reasons.join(', ')}`
  }

  private suggestLabels(analysis: TicketAnalysis): string[] {
    const labels = []

    labels.push(analysis.ticketType)
    labels.push(analysis.issueCategory.toLowerCase())

    if (analysis.environment) {
      labels.push(analysis.environment)
    }

    if (analysis.affectedComponent) {
      labels.push(analysis.affectedComponent.toLowerCase())
    }

    return labels
  }

  private suggestAssignee(analysis: TicketAnalysis, context: Context): string | undefined {
    // Simple assignee suggestion based on expertise
    if (analysis.issueCategory === 'UI/UX' && context.user.expertise.includes('frontend')) {
      return context.user.id
    }

    if (analysis.issueCategory === 'API' && context.user.expertise.includes('backend')) {
      return context.user.id
    }

    return undefined
  }

  private recalculatePriority(ticket: any, context: Context): string {
    // Recalculate priority based on current context
    // This is a simplified version - real implementation would be more complex
    return ticket.priority
  }

  private calculateOverallHealth(tickets: any[]): number {
    if (tickets.length === 0) return 100

    const criticalCount = tickets.filter(t => t.priority === 'critical').length
    const highCount = tickets.filter(t => t.priority === 'high').length

    let health = 100
    health -= criticalCount * 15
    health -= highCount * 5

    return Math.max(0, health)
  }
}

class TicketLifecycleManager {
  constructor(private config: autonomusConfig) { }

  async initialize(): Promise<void> {
    console.log('  🔄 Lifecycle manager ready')
  }

  async analyze(tickets: any[], context: Context): Promise<LifecycleAnalysis> {
    return {
      bottlenecks: this.identifyBottlenecks(tickets),
      automationOpportunities: this.identifyAutomationOpportunities(tickets),
      averageResolutionTime: this.calculateAverageResolutionTime(tickets),
      targetResolutionTime: 7 * 24 * 60 * 60 * 1000 // 7 days in ms
    }
  }

  private identifyBottlenecks(tickets: any[]): LifecycleBottleneck[] {
    // Mock bottleneck identification
    return [
      {
        stage: 'assignment',
        description: 'Tickets taking too long to be assigned',
        impact: 'medium',
        suggestedActions: ['Auto-assignment rules', 'Assignment notifications'],
        expectedImprovement: 'Reduce assignment time by 50%'
      }
    ]
  }

  private identifyAutomationOpportunities(tickets: any[]): AutomationOpportunity[] {
    // Mock automation opportunities
    return [
      {
        type: 'auto_labeling',
        description: 'Automatically label tickets based on content',
        benefit: 'Consistent labeling and better organization',
        effort: 'low'
      }
    ]
  }

  private calculateAverageResolutionTime(tickets: any[]): number {
    // Mock calculation - would use real ticket data
    return 10 * 24 * 60 * 60 * 1000 // 10 days in ms
  }
}

class TicketAutomationEngine {
  constructor(private config: autonomusConfig) { }

  async initialize(): Promise<void> {
    console.log('  🤖 Automation engine ready')
  }

  async setupWorkflows(ticketId: string, analysis: TicketAnalysis): Promise<void> {
    // Setup automated workflows for the ticket
    console.log(`🔄 Setting up automation workflows for ticket ${ticketId}`)
  }

  async getActiveWorkflows(ticketId: string): Promise<string[]> {
    // Return active workflows for a ticket
    return ['priority_monitoring', 'assignment_reminder']
  }
}

// Supporting Interfaces
interface TicketAnalysis {
  summary: string
  ticketType: 'bug' | 'feature' | 'improvement' | 'task'
  issueCategory: string
  urgency: 'low' | 'medium' | 'high' | 'critical'
  issueClarity: number
  confidence: number
  affectedComponent?: string
  environment?: string
  reproductionSteps?: string[]
  expectedBehavior?: string
  actualBehavior?: string
  additionalContext: string
  requiresTesting: boolean
  requiresDocumentation: boolean
}

interface ExistingTicketAnalysis {
  currentStatus: string
  healthScore: number
  riskAssessment: string[]
  recommendations: string[]
  predictedResolution: string
  nextActions: string[]
  confidence: number
}

interface TicketCreationResult {
  success: boolean
  ticket?: AutonomousTicket
  analysis?: TicketAnalysis
  reason?: string
  confidence: number
  recommendation?: string
  automatedWorkflows?: string[]
}

interface TicketIntelligence {
  ticketId: string
  currentStatus: string
  healthScore: number
  riskAssessment: string[]
  recommendations: string[]
  predictedResolution: string
  similarTickets: SimilarTicket[]
  automationOpportunities: AutomationOpportunity[]
  nextActions: string[]
  confidence: number
}

interface CreationDecision {
  shouldCreate: boolean
  reason: string
  recommendation?: string
  confidence: number
}

interface TicketDetails {
  title: string
  description: string
  acceptanceCriteria: string[]
  type: string
  component?: string
  environment?: string
  stepsToReproduce: string[]
  expectedBehavior?: string
  actualBehavior?: string
  additionalContext: string
}

interface AutonomousTicket extends TicketDetails {
  id: string
  priority: string
  severity: string
  labels: string[]
  assignee?: string
  status: string
  createdAt: string
  createdBy: string
  autonomous: boolean
}

interface PriorityAssessment {
  priority: 'low' | 'medium' | 'high' | 'critical'
  severity: 'low' | 'medium' | 'high' | 'critical'
  confidence: number
  reasoning: string
  suggestedLabels: string[]
  suggestedAssignee?: string
}

interface PrioritizationResult {
  totalTicketsAnalyzed: number
  automaticAdjustments: number
  recommendations: Array<{
    ticketId: string
    currentPriority: string
    suggestedPriority: string
    reasoning?: string
    confidence: number
  }>
  overallPriorityHealth: number
  criticalIssuesIdentified: number
}

interface PrioritizationAnalysis {
  suggestions: Array<{
    ticketId: string
    priority: string
    confidence: number
    reasoning: string
  }>
  overallHealth: number
  criticalIssues: number
}

interface LifecycleOptimization {
  type: 'bottleneck_resolution' | 'automation' | 'process_improvement'
  title: string
  description: string
  impact: 'low' | 'medium' | 'high'
  effort: 'low' | 'medium' | 'high'
  suggestedActions: string[]
  expectedImprovement: string | string[]
}

interface SimilarTicket {
  ticketId: string
  title: string
  similarity: number
  status: string
  resolution?: string
}

interface AutomationOpportunity {
  type: string
  description: string
  benefit: string
  effort: 'low' | 'medium' | 'high'
}

interface TicketAgentMetrics {
  totalTicketsProcessed: number
  successfulCreations: number
  averageProcessingTime: number
  successRate: number
  patternsDiscovered: number
  automationsSuggested: number
}

interface TicketAgentInsights {
  performance: TicketAgentMetrics
  capabilities: AgentCapability[]
  patterns: TicketPattern[]
  recommendations: string[]
  learnings: string[]
  nextOptimizations: string[]
}

interface TicketPattern {
  pattern: string
  frequency: number
  averageConfidence: number
  characteristics: {
    type: string
    category: string
    urgency: string
  }
  firstSeen: string
  lastSeen: string
}

interface LifecycleAnalysis {
  bottlenecks: LifecycleBottleneck[]
  automationOpportunities: AutomationOpportunity[]
  averageResolutionTime: number
  targetResolutionTime: number
}

interface LifecycleBottleneck {
  stage: string
  description: string
  impact: 'low' | 'medium' | 'high'
  suggestedActions: string[]
  expectedImprovement: string
}
