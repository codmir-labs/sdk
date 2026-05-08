/**
 * Conversation Intelligence - Advanced Conversation Analysis and Understanding
 * 
 * Provides deep insights into conversations, understands user intent,
 * extracts actionable information, and predicts user needs.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

import type {
  Context,
  ContextMessage,
  ConversationIntent,
  ContextEntity,
  autonomusConfig
} from '../types'

/**
 * ConversationIntelligence analyzes conversations for deep understanding
 */
export class ConversationIntelligence extends EventEmitter {
  private config: autonomusConfig
  private conversationHistory = new Map<string, ConversationAnalysis>()
  private intentPatterns = new Map<string, IntentPattern>()
  private entityRecognizer: EntityRecognizer
  private intentClassifier: IntentClassifier
  private sentimentAnalyzer: SentimentAnalyzer
  private urgencyDetector: UrgencyDetector

  constructor(config: autonomusConfig) {
    super()
    this.config = config
    this.entityRecognizer = new EntityRecognizer()
    this.intentClassifier = new IntentClassifier()
    this.sentimentAnalyzer = new SentimentAnalyzer()
    this.urgencyDetector = new UrgencyDetector()
    this.initializeIntentPatterns()
  }

  async initialize(): Promise<void> {
    console.log('🧠 Initializing Conversation Intelligence...')

    await Promise.all([
      this.entityRecognizer.initialize(),
      this.intentClassifier.initialize(),
      this.sentimentAnalyzer.initialize(),
      this.urgencyDetector.initialize()
    ])

    console.log('✅ Conversation Intelligence ready')
  }

  /**
   * Analyze a conversation for deep insights and actionable intelligence
   */
  async analyzeConversation(context: Context): Promise<ConversationIntelligence> {
    const conversationId = context.conversation.id
    const startTime = Date.now()

    try {
      console.log(`🔍 Analyzing conversation: ${conversationId}`)

      // Multi-layer analysis
      const analysis: ConversationAnalysis = {
        id: randomUUID(),
        conversationId,

        // Core Analysis
        intent: await this.analyzeIntent(context.conversation),
        entities: await this.extractEntities(context.conversation),
        sentiment: await this.analyzeSentiment(context.conversation),
        urgency: await this.detectUrgency(context.conversation),

        // Advanced Analysis  
        actionableInsights: await this.extractActionableInsights(context),
        predictedNeeds: await this.predictUserNeeds(context),
        conversationFlow: await this.analyzeConversationFlow(context.conversation),
        contextualRelevance: await this.assessContextualRelevance(context),

        // Quality Metrics
        clarity: this.assessClarity(context.conversation),
        completeness: this.assessCompleteness(context.conversation),
        confidence: 0,

        // Metadata
        analyzedAt: new Date().toISOString(),
        analysisVersion: '1.0.0',
        processingTime: 0
      }

      // Calculate overall confidence
      analysis.confidence = this.calculateAnalysisConfidence(analysis)
      analysis.processingTime = Date.now() - startTime

      // Store analysis
      this.conversationHistory.set(conversationId, analysis)

      // Update intent patterns
      await this.updateIntentPatterns(analysis)

      this.emit('conversation_analyzed', { analysis, processingTime: analysis.processingTime })

      return {
        analysis,
        recommendations: await this.generateRecommendations(analysis, context),
        nextActions: await this.suggestNextActions(analysis, context)
      } as any
    } catch (error) {
      console.error('❌ Conversation analysis failed:', error)
      throw error
    }
  }

  /**
   * Extract ticket requirements from conversation
   */
  async extractTicketRequirements(params: {
    messages: any[]
    context: Context
  }): Promise<any> {
    const result = await this.analyzeConversation(params.context)
    return (result as any).analysis
  }

  /**
   * Extract task description from conversation
   */
  async extractTaskDescription(params: {
    messages: any[]
    context: Context
  }): Promise<any> {
    const result = await this.analyzeConversation(params.context)
    const analysis = (result as any).analysis
    return {
      description: analysis.summary || 'Task described in conversation',
      confidence: analysis.confidence
    }
  }

  /**
   * Extract code requirements from conversation
   */
  async extractCodeRequirements(params: {
    messages: any[]
    context: Context
  }): Promise<any> {
    const result = await this.analyzeConversation(params.context)
    const analysis = (result as any).analysis
    return {
      description: analysis.summary || 'Code generation requested in conversation',
      language: 'typescript',
      confidence: analysis.confidence,
      examples: [],
      constraints: []
    }
  }


  /**
   * Assess contextual relevance of the conversation
   */
  private async assessContextualRelevance(context: Context): Promise<number> {
    return 0.8
  }

  /**
   * Get latest conversation insights
   */
  getInsights(): any {
    return Array.from(this.conversationHistory.values()).pop() || null
  }

  /**
   * Get conversation insights for decision making
   */
  getConversationInsights(conversationId: string): ConversationInsights | null {
    const analysis = this.conversationHistory.get(conversationId)
    if (!analysis) return null

    return {
      keyTopics: analysis.entities.filter(e => e.confidence > 0.8).map(e => e.value),
      primaryIntent: analysis.intent.primary,
      urgencyLevel: analysis.urgency.level,
      sentimentTrend: analysis.sentiment.trend,
      actionableItems: analysis.actionableInsights.filter(i => i.actionable).map(i => i.insight),
      confidence: analysis.confidence,
      recommendations: analysis.predictedNeeds.map(n => n.description)
    }
  }

  /**
   * Predict what the user needs based on conversation analysis
   */
  async predictUserNeeds(context: Context): Promise<PredictedNeed[]> {
    const needs: PredictedNeed[] = []
    const conversation = context.conversation

    // Need for ticket creation
    if (this.indicatesTicketNeed(conversation)) {
      needs.push({
        type: 'create_ticket',
        description: 'User needs to create a ticket to track this issue',
        confidence: 0.8,
        priority: this.calculateNeedPriority(conversation, 'create_ticket'),
        reasoning: 'Conversation contains problem description and request for tracking',
        suggestedActions: [
          'Extract issue details from conversation',
          'Determine appropriate priority level',
          'Suggest relevant labels and assignees'
        ]
      })
    }

    // Need for task creation
    if (this.indicatesTaskNeed(conversation)) {
      needs.push({
        type: 'create_task',
        description: 'User needs a structured task to manage this work',
        confidence: 0.75,
        priority: this.calculateNeedPriority(conversation, 'create_task'),
        reasoning: 'Conversation involves complex work that benefits from task breakdown',
        suggestedActions: [
          'Break down work into manageable subtasks',
          'Estimate effort and timeline',
          'Identify required resources and dependencies'
        ]
      })
    }

    // Need for information
    if (this.indicatesInformationNeed(conversation)) {
      needs.push({
        type: 'gather_information',
        description: 'User needs more information to proceed',
        confidence: 0.7,
        priority: this.calculateNeedPriority(conversation, 'gather_information'),
        reasoning: 'Questions and uncertainty indicators present in conversation',
        suggestedActions: [
          'Identify specific information gaps',
          'Suggest relevant documentation or resources',
          'Offer to research and provide details'
        ]
      })
    }

    // Need for code analysis
    if (this.indicatesCodeAnalysisNeed(conversation)) {
      needs.push({
        type: 'analyze_code',
        description: 'User would benefit from code analysis and insights',
        confidence: 0.8,
        priority: this.calculateNeedPriority(conversation, 'analyze_code'),
        reasoning: 'Conversation mentions code files, bugs, or performance issues',
        suggestedActions: [
          'Scan mentioned code files for issues',
          'Provide code quality assessment',
          'Suggest improvements and best practices'
        ]
      })
    }

    return needs.sort((a, b) => b.confidence * b.priority - a.confidence * a.priority)
  }

  /**
   * Extract actionable insights from conversation
   */
  async extractActionableInsights(context: Context): Promise<ActionableInsight[]> {
    const insights: ActionableInsight[] = []
    const conversation = context.conversation

    // Analyze each message for actionable content
    for (const message of conversation.messages) {
      if (message.role === 'user') {
        const messageInsights = await this.extractMessageInsights(message, context)
        insights.push(...messageInsights)
      }
    }

    // Analyze conversation patterns
    const patternInsights = await this.extractPatternInsights(conversation)
    insights.push(...patternInsights)

    return insights.filter(insight => insight.confidence > 0.6)
  }

  /**
   * Analyze conversation flow and structure
   */
  async analyzeConversationFlow(conversation: Context['conversation']): Promise<ConversationFlow> {
    const messages = conversation.messages

    return {
      totalMessages: messages.length,
      userMessages: messages.filter(m => m.role === 'user').length,
      assistantMessages: messages.filter(m => m.role === 'assistant').length,
      averageMessageLength: messages.reduce((sum, m) => sum + m.content.length, 0) / messages.length,
      conversationDepth: this.calculateConversationDepth(messages),
      topicProgression: this.analyzeTopicProgression(messages),
      engagementLevel: this.calculateEngagementLevel(messages),
      conversationStage: this.determineConversationStage(messages)
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Analysis Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private async analyzeIntent(conversation: Context['conversation']): Promise<ConversationIntent> {
    const messages = conversation.messages.filter(m => m.role === 'user')
    const allText = messages.map(m => m.content).join(' ').toLowerCase()

    // Primary intent classification
    let primary = 'general'
    if (allText.includes('bug') || allText.includes('error') || allText.includes('issue')) {
      primary = 'problem'
    } else if (allText.includes('feature') || allText.includes('add') || allText.includes('implement')) {
      primary = 'request'
    } else if (allText.includes('help') || allText.includes('how') || allText.includes('what')) {
      primary = 'question'
    } else if (allText.includes('plan') || allText.includes('strategy') || allText.includes('approach')) {
      primary = 'planning'
    }

    // Secondary intents
    const secondary: string[] = []
    if (allText.includes('urgent') || allText.includes('asap')) secondary.push('urgent')
    if (allText.includes('review') || allText.includes('feedback')) secondary.push('review')
    if (allText.includes('test') || allText.includes('verify')) secondary.push('validation')

    // Confidence calculation
    const confidence = this.calculateIntentConfidence(primary, secondary, allText)

    // Urgency assessment
    const urgency = this.assessUrgency(allText)

    // Complexity assessment
    const complexity = this.assessComplexity(allText, messages.length)

    return {
      primary,
      secondary,
      confidence,
      urgency,
      complexity
    }
  }

  private async extractEntities(conversation: Context['conversation']): Promise<ContextEntity[]> {
    return this.entityRecognizer.extractFromConversation(conversation)
  }

  private async analyzeSentiment(conversation: Context['conversation']): Promise<ConversationSentiment> {
    return this.sentimentAnalyzer.analyze(conversation)
  }

  private async detectUrgency(conversation: Context['conversation']): Promise<UrgencyAnalysis> {
    return this.urgencyDetector.detect(conversation)
  }

  private async extractMessageInsights(message: ContextMessage, context: Context): Promise<ActionableInsight[]> {
    const insights: ActionableInsight[] = []
    const content = message.content.toLowerCase()

    // File mention insights
    const fileMatches = content.match(/\b\w+\.(js|ts|tsx|jsx|py|java|cpp|h)\b/g)
    if (fileMatches) {
      insights.push({
        insight: `Files mentioned: ${fileMatches.join(', ')}`,
        actionable: true,
        confidence: 0.9,
        suggestedActions: ['Analyze mentioned files', 'Check file status and history'],
        category: 'file_reference'
      })
    }

    // Error mention insights
    if (content.includes('error') || content.includes('exception') || content.includes('crash')) {
      insights.push({
        insight: 'Error or exception mentioned - investigation needed',
        actionable: true,
        confidence: 0.85,
        suggestedActions: ['Gather error details', 'Check logs', 'Reproduce issue'],
        category: 'error_detection'
      })
    }

    // Performance concern insights
    if (content.includes('slow') || content.includes('performance') || content.includes('timeout')) {
      insights.push({
        insight: 'Performance concern identified',
        actionable: true,
        confidence: 0.8,
        suggestedActions: ['Performance analysis', 'Bottleneck identification', 'Optimization recommendations'],
        category: 'performance'
      })
    }

    return insights
  }

  private async extractPatternInsights(conversation: Context['conversation']): Promise<ActionableInsight[]> {
    const insights: ActionableInsight[] = []

    // Pattern: Multiple questions in sequence
    const questionMessages = conversation.messages.filter(m =>
      m.role === 'user' && m.content.includes('?')
    )

    if (questionMessages.length > 2) {
      insights.push({
        insight: 'Multiple questions indicate need for comprehensive guidance',
        actionable: true,
        confidence: 0.75,
        suggestedActions: ['Provide structured overview', 'Create documentation', 'Schedule follow-up'],
        category: 'guidance_needed'
      })
    }

    // Pattern: Repeated similar requests
    const messageContents = conversation.messages.map(m => m.content.toLowerCase())
    const uniqueContents = new Set(messageContents)

    if (messageContents.length > uniqueContents.size * 1.3) { // 30% duplication threshold
      insights.push({
        insight: 'Repeated requests suggest unclear communication or incomplete resolution',
        actionable: true,
        confidence: 0.8,
        suggestedActions: ['Clarify requirements', 'Provide detailed explanation', 'Confirm understanding'],
        category: 'communication_clarity'
      })
    }

    return insights
  }

  private calculateAnalysisConfidence(analysis: ConversationAnalysis): number {
    const factors = [
      analysis.intent.confidence * 0.3,
      (analysis.entities.reduce((sum, e) => sum + e.confidence, 0) / analysis.entities.length) * 0.2,
      analysis.sentiment.confidence * 0.2,
      analysis.clarity * 0.15,
      analysis.completeness * 0.15
    ]

    return factors.reduce((sum, factor) => sum + (factor || 0), 0)
  }

  private assessClarity(conversation: Context['conversation']): number {
    const userMessages = conversation.messages.filter(m => m.role === 'user')
    let clarityScore = 0

    for (const message of userMessages) {
      const content = message.content

      // Positive clarity indicators
      if (content.includes('specifically') || content.includes('exactly')) clarityScore += 0.2
      if (content.length > 50) clarityScore += 0.1 // Detailed messages
      if (content.includes('because') || content.includes('due to')) clarityScore += 0.15 // Explanations

      // Negative clarity indicators
      if (content.includes('maybe') || content.includes('perhaps') || content.includes('not sure')) clarityScore -= 0.1
      if (content.length < 20) clarityScore -= 0.1 // Too brief
      if (content.includes('???') || content.match(/\?{2,}/)) clarityScore -= 0.2 // Confusion
    }

    return Math.max(0, Math.min(1, clarityScore / userMessages.length + 0.5))
  }

  private assessCompleteness(conversation: Context['conversation']): number {
    const userMessages = conversation.messages.filter(m => m.role === 'user')
    let completenessScore = 0

    for (const message of userMessages) {
      const content = message.content.toLowerCase()

      // Completeness indicators
      if (content.includes('when') || content.includes('where') || content.includes('how')) completenessScore += 0.1
      if (content.includes('expected') || content.includes('should')) completenessScore += 0.1
      if (content.includes('environment') || content.includes('version')) completenessScore += 0.15
      if (message.entities.length > 2) completenessScore += 0.1 // Rich entity content
    }

    return Math.max(0, Math.min(1, completenessScore / userMessages.length + 0.3))
  }

  private indicatesTicketNeed(conversation: Context['conversation']): boolean {
    const keywords = ['bug', 'issue', 'problem', 'error', 'fix', 'broken', 'not working']
    const allText = conversation.messages.map(m => m.content).join(' ').toLowerCase()
    return keywords.some(keyword => allText.includes(keyword))
  }

  private indicatesTaskNeed(conversation: Context['conversation']): boolean {
    const keywords = ['implement', 'build', 'create', 'develop', 'add feature', 'make', 'project']
    const allText = conversation.messages.map(m => m.content).join(' ').toLowerCase()
    return keywords.some(keyword => allText.includes(keyword)) &&
      conversation.intent.complexity !== 'simple'
  }

  private indicatesInformationNeed(conversation: Context['conversation']): boolean {
    const questionCount = conversation.messages.filter(m =>
      m.role === 'user' && m.content.includes('?')
    ).length
    return questionCount > 1 || conversation.intent.primary === 'question'
  }

  private indicatesCodeAnalysisNeed(conversation: Context['conversation']): boolean {
    const allText = conversation.messages.map(m => m.content).join(' ').toLowerCase()
    const codeKeywords = ['file', '', '.ts', '.py', 'function', 'method', 'class', 'performance', 'optimize']
    return codeKeywords.some(keyword => allText.includes(keyword))
  }

  private calculateNeedPriority(conversation: Context['conversation'], needType: string): number {
    let priority = 0.5 // Base priority

    // Urgency boost
    if (conversation.intent.urgency === 'critical') priority += 0.4
    else if (conversation.intent.urgency === 'high') priority += 0.3
    else if (conversation.intent.urgency === 'medium') priority += 0.1

    // Complexity consideration
    if (conversation.intent.complexity === 'expert') priority += 0.2
    else if (conversation.intent.complexity === 'complex') priority += 0.1

    // Need-specific adjustments
    if (needType === 'create_ticket' && conversation.sentiment === 'frustrated') priority += 0.2
    if (needType === 'gather_information' && conversation.intent.primary === 'question') priority += 0.3

    return Math.min(1.0, priority)
  }

  private calculateIntentConfidence(primary: string, secondary: string[], text: string): number {
    let confidence = 0.5 // Base confidence

    // Strong keyword matches increase confidence
    const intentKeywords = {
      problem: ['bug', 'error', 'issue', 'broken', 'fail'],
      request: ['feature', 'add', 'implement', 'create', 'build'],
      question: ['help', 'how', 'what', 'why', 'when', '?'],
      planning: ['plan', 'strategy', 'approach', 'design']
    }

    const keywords = intentKeywords[primary as keyof typeof intentKeywords] || []
    const keywordMatches = keywords.filter(keyword => text.includes(keyword)).length
    confidence += (keywordMatches / keywords.length) * 0.4

    // Secondary intents add confidence
    confidence += secondary.length * 0.1

    return Math.min(1.0, confidence)
  }

  private assessUrgency(text: string): 'low' | 'medium' | 'high' | 'critical' {
    const urgentWords = ['urgent', 'asap', 'immediate', 'critical', 'emergency']
    const highWords = ['important', 'priority', 'soon', 'quickly']

    if (urgentWords.some(word => text.includes(word))) return 'critical'
    if (highWords.some(word => text.includes(word))) return 'high'
    if (text.includes('when you can') || text.includes('no rush')) return 'low'
    return 'medium'
  }

  private assessComplexity(text: string, messageCount: number): 'simple' | 'moderate' | 'complex' | 'expert' {
    const complexWords = ['architecture', 'system', 'integration', 'migration', 'scalability']
    const moderateWords = ['multiple', 'several', 'various', 'different', 'complex']

    const complexCount = complexWords.filter(word => text.includes(word)).length
    const moderateCount = moderateWords.filter(word => text.includes(word)).length

    if (complexCount > 1 || messageCount > 8) return 'expert'
    if (complexCount > 0 || moderateCount > 2 || messageCount > 5) return 'complex'
    if (moderateCount > 0 || messageCount > 2) return 'moderate'
    return 'simple'
  }

  private calculateConversationDepth(messages: ContextMessage[]): number {
    // Depth based on back-and-forth exchanges and content richness
    const exchanges = Math.floor(messages.length / 2)
    const avgContentLength = messages.reduce((sum, m) => sum + m.content.length, 0) / messages.length
    return Math.min(10, exchanges * 0.3 + (avgContentLength / 100) * 0.7)
  }

  private analyzeTopicProgression(messages: ContextMessage[]): string[] {
    // Simple topic extraction - could be enhanced with NLP
    const topics = new Set<string>()

    for (const message of messages) {
      const words = message.content.toLowerCase().split(/\s+/)
      const significantWords = words.filter(word =>
        word.length > 4 &&
        !['that', 'this', 'with', 'from', 'they', 'have', 'will', 'been'].includes(word)
      )
      significantWords.slice(0, 3).forEach(word => topics.add(word))
    }

    return Array.from(topics).slice(0, 10)
  }

  private calculateEngagementLevel(messages: ContextMessage[]): 'low' | 'medium' | 'high' {
    const userMessages = messages.filter(m => m.role === 'user')
    const avgLength = userMessages.reduce((sum, m) => sum + m.content.length, 0) / userMessages.length

    if (avgLength > 100 && userMessages.length > 3) return 'high'
    if (avgLength > 50 || userMessages.length > 2) return 'medium'
    return 'low'
  }

  private determineConversationStage(messages: ContextMessage[]): 'initial' | 'exploring' | 'defining' | 'resolving' | 'concluded' {
    const messageCount = messages.length
    const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content.toLowerCase() || ''

    if (messageCount <= 2) return 'initial'
    if (lastUserMessage.includes('thank') || lastUserMessage.includes('perfect')) return 'concluded'
    if (lastUserMessage.includes('do') || lastUserMessage.includes('create') || lastUserMessage.includes('implement')) return 'resolving'
    if (messageCount > 4) return 'defining'
    return 'exploring'
  }

  private async generateRecommendations(analysis: ConversationAnalysis, context: Context): Promise<string[]> {
    const recommendations: string[] = []

    // Based on intent
    if (analysis.intent.primary === 'problem') {
      recommendations.push('Create a ticket to track this issue')
      recommendations.push('Gather additional error details and logs')
    }

    if (analysis.intent.primary === 'request') {
      recommendations.push('Break down the request into manageable tasks')
      recommendations.push('Define acceptance criteria and success metrics')
    }

    // Based on clarity
    if (analysis.clarity < 0.6) {
      recommendations.push('Ask clarifying questions to better understand requirements')
    }

    // Based on urgency
    if (analysis.urgency.level === 'critical') {
      recommendations.push('Prioritize this conversation for immediate action')
      recommendations.push('Consider escalating to appropriate team members')
    }

    return recommendations
  }

  private async suggestNextActions(analysis: ConversationAnalysis, context: Context): Promise<string[]> {
    const actions: string[] = []

    // Based on predicted needs
    for (const need of analysis.predictedNeeds) {
      actions.push(...need.suggestedActions)
    }

    // Based on actionable insights
    for (const insight of analysis.actionableInsights.filter(i => i.actionable)) {
      actions.push(...insight.suggestedActions)
    }

    return [...new Set(actions)].slice(0, 5) // Unique actions, max 5
  }

  private async updateIntentPatterns(analysis: ConversationAnalysis): Promise<void> {
    const patternKey = `${analysis.intent.primary}_${analysis.intent.urgency}_${analysis.intent.complexity}`

    const existingPattern = this.intentPatterns.get(patternKey)
    if (existingPattern) {
      existingPattern.frequency++
      existingPattern.lastSeen = analysis.analyzedAt
      existingPattern.avgConfidence = (existingPattern.avgConfidence + analysis.confidence) / 2
    } else {
      this.intentPatterns.set(patternKey, {
        pattern: patternKey,
        frequency: 1,
        avgConfidence: analysis.confidence,
        firstSeen: analysis.analyzedAt,
        lastSeen: analysis.analyzedAt
      })
    }
  }

  private initializeIntentPatterns(): void {
    // Initialize with common patterns
    console.log('📊 Initializing intent patterns...')
  }

  getAnalysisHistory(): ConversationAnalysis[] {
    return Array.from(this.conversationHistory.values())
  }

  getIntentPatterns(): IntentPattern[] {
    return Array.from(this.intentPatterns.values())
  }
}

// Supporting Classes
class EntityRecognizer {
  async initialize(): Promise<void> {
    console.log('  🏷️  Entity recognizer ready')
  }

  async extractFromConversation(conversation: Context['conversation']): Promise<ContextEntity[]> {
    const entities: ContextEntity[] = []

    for (const message of conversation.messages) {
      const messageEntities = await this.extractFromText(message.content)
      entities.push(...messageEntities)
    }

    return this.deduplicateEntities(entities)
  }

  private async extractFromText(text: string): Promise<ContextEntity[]> {
    const entities: ContextEntity[] = []

    // File patterns
    const fileMatches = text.match(/\b\w+\.(js|ts|tsx|jsx|py|java|cpp|h|css|html|json)\b/gi)
    if (fileMatches) {
      fileMatches.forEach(match => {
        entities.push({
          type: 'file',
          value: match,
          confidence: 0.9,
          metadata: { extension: match.split('.').pop() }
        })
      })
    }

    // Technology mentions
    const techPattern = /\b(React|Vue|Angular|Node|Python|Java|TypeScript|JavaScript|Docker|Kubernetes)\b/gi
    const techMatches = text.match(techPattern)
    if (techMatches) {
      techMatches.forEach(match => {
        entities.push({
          type: 'technology',
          value: match,
          confidence: 0.8,
          metadata: { category: 'framework_or_language' }
        })
      })
    }

    return entities
  }

  private deduplicateEntities(entities: ContextEntity[]): ContextEntity[] {
    const seen = new Map<string, ContextEntity>()

    for (const entity of entities) {
      const key = `${entity.type}:${entity.value.toLowerCase()}`
      const existing = seen.get(key)

      if (!existing || entity.confidence > existing.confidence) {
        seen.set(key, entity)
      }
    }

    return Array.from(seen.values())
  }
}

class IntentClassifier {
  async initialize(): Promise<void> {
    console.log('  🎯 Intent classifier ready')
  }
}

class SentimentAnalyzer {
  async initialize(): Promise<void> {
    console.log('  😊 Sentiment analyzer ready')
  }

  async analyze(conversation: Context['conversation']): Promise<ConversationSentiment> {
    const userMessages = conversation.messages.filter(m => m.role === 'user')
    let positiveScore = 0
    let negativeScore = 0
    let neutralScore = 0

    const positiveWords = ['great', 'good', 'awesome', 'perfect', 'thanks', 'excellent', 'love', 'amazing']
    const negativeWords = ['bad', 'terrible', 'awful', 'hate', 'frustrated', 'angry', 'broken', 'useless']

    for (const message of userMessages) {
      const content = message.content.toLowerCase()

      positiveWords.forEach(word => {
        if (content.includes(word)) positiveScore++
      })

      negativeWords.forEach(word => {
        if (content.includes(word)) negativeScore++
      })

      if (positiveScore === 0 && negativeScore === 0) neutralScore++
    }

    const total = positiveScore + negativeScore + neutralScore

    let overall: 'positive' | 'neutral' | 'negative' | 'frustrated' = 'neutral'
    if (positiveScore > negativeScore) overall = 'positive'
    else if (negativeScore > positiveScore) overall = negativeScore > 2 ? 'frustrated' : 'negative'

    return {
      overall,
      confidence: Math.max(positiveScore, negativeScore, neutralScore) / total || 0.5,
      trend: this.calculateSentimentTrend(userMessages),
      scores: {
        positive: positiveScore / total || 0,
        negative: negativeScore / total || 0,
        neutral: neutralScore / total || 0
      }
    }
  }

  private calculateSentimentTrend(messages: ContextMessage[]): 'improving' | 'declining' | 'stable' {
    if (messages.length < 3) return 'stable'

    // Simple trend analysis - compare first half vs second half
    const midpoint = Math.floor(messages.length / 2)
    const firstHalf = messages.slice(0, midpoint)
    const secondHalf = messages.slice(midpoint)

    const firstHalfScore = this.calculateSimpleSentiment(firstHalf)
    const secondHalfScore = this.calculateSimpleSentiment(secondHalf)

    if (secondHalfScore > firstHalfScore + 0.2) return 'improving'
    if (secondHalfScore < firstHalfScore - 0.2) return 'declining'
    return 'stable'
  }

  private calculateSimpleSentiment(messages: ContextMessage[]): number {
    const positiveWords = ['great', 'good', 'thanks', 'perfect']
    const negativeWords = ['bad', 'terrible', 'frustrated', 'broken']

    let score = 0
    for (const message of messages) {
      const content = message.content.toLowerCase()
      positiveWords.forEach(word => {
        if (content.includes(word)) score += 1
      })
      negativeWords.forEach(word => {
        if (content.includes(word)) score -= 1
      })
    }

    return score / messages.length
  }
}

class UrgencyDetector {
  async initialize(): Promise<void> {
    console.log('  🚨 Urgency detector ready')
  }

  async detect(conversation: Context['conversation']): Promise<UrgencyAnalysis> {
    const userMessages = conversation.messages.filter(m => m.role === 'user')
    let urgencyScore = 0
    const indicators: string[] = []

    const urgencyIndicators = {
      critical: ['urgent', 'asap', 'immediate', 'emergency', 'critical', 'now'],
      high: ['important', 'priority', 'soon', 'quickly', 'fast'],
      medium: ['when possible', 'eventually', 'sometime'],
      low: ['no rush', 'whenever', 'low priority']
    }

    for (const message of userMessages) {
      const content = message.content.toLowerCase()

      urgencyIndicators.critical.forEach(word => {
        if (content.includes(word)) {
          urgencyScore += 4
          indicators.push(word)
        }
      })

      urgencyIndicators.high.forEach(word => {
        if (content.includes(word)) {
          urgencyScore += 2
          indicators.push(word)
        }
      })

      urgencyIndicators.low.forEach(word => {
        if (content.includes(word)) {
          urgencyScore -= 1
        }
      })
    }

    let level: 'low' | 'medium' | 'high' | 'critical' = 'medium'
    if (urgencyScore >= 4) level = 'critical'
    else if (urgencyScore >= 2) level = 'high'
    else if (urgencyScore < 0) level = 'low'

    return {
      level,
      score: urgencyScore,
      indicators,
      confidence: indicators.length > 0 ? 0.8 : 0.3
    }
  }
}

// Supporting Interfaces
interface ConversationAnalysis {
  id: string
  conversationId: string
  intent: ConversationIntent
  entities: ContextEntity[]
  sentiment: ConversationSentiment
  urgency: UrgencyAnalysis
  actionableInsights: ActionableInsight[]
  predictedNeeds: PredictedNeed[]
  conversationFlow: ConversationFlow
  contextualRelevance: number
  clarity: number
  completeness: number
  confidence: number
  analyzedAt: string
  analysisVersion: string
  processingTime: number
}

interface ConversationSentiment {
  overall: 'positive' | 'neutral' | 'negative' | 'frustrated'
  confidence: number
  trend: 'improving' | 'declining' | 'stable'
  scores: {
    positive: number
    negative: number
    neutral: number
  }
}

interface UrgencyAnalysis {
  level: 'low' | 'medium' | 'high' | 'critical'
  score: number
  indicators: string[]
  confidence: number
}

interface ActionableInsight {
  insight: string
  actionable: boolean
  confidence: number
  suggestedActions: string[]
  category: string
}

interface PredictedNeed {
  type: string
  description: string
  confidence: number
  priority: number
  reasoning: string
  suggestedActions: string[]
}

interface ConversationFlow {
  totalMessages: number
  userMessages: number
  assistantMessages: number
  averageMessageLength: number
  conversationDepth: number
  topicProgression: string[]
  engagementLevel: 'low' | 'medium' | 'high'
  conversationStage: 'initial' | 'exploring' | 'defining' | 'resolving' | 'concluded'
}

interface ConversationInsights {
  keyTopics: string[]
  primaryIntent: string
  urgencyLevel: string
  sentimentTrend: string
  actionableItems: string[]
  confidence: number
  recommendations: string[]
}

interface IntentPattern {
  pattern: string
  frequency: number
  avgConfidence: number
  firstSeen: string
  lastSeen: string
}
