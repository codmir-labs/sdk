/**
 * Context Manager - Deep Context Understanding System
 * 
 * Builds rich, multi-layered context from conversations, code, projects,
 * and user behavior to enable intelligent decision-making.
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

import type {
  autonomusConfig,
  Context,
  ContextMessage,
  ContextEntity,
  ConversationIntent,
  CodebaseSnapshot,
  TicketContext,
  TaskContext,
  UserActivity
} from '../types'

/**
 * ContextManager builds comprehensive situational awareness
 */
export class ContextManager extends EventEmitter {
  private config: autonomusConfig
  private contextCache = new Map<string, Context>()
  private entityExtractor: EntityExtractor
  private intentAnalyzer: IntentAnalyzer
  private codebaseAnalyzer: CodebaseAnalyzer

  // Performance tracking
  private metrics = {
    contextsBuilt: 0,
    averageBuildTime: 0,
    cacheHitRate: 0,
    entitiesExtracted: 0
  }

  constructor(config: autonomusConfig) {
    super()
    this.config = config
    this.entityExtractor = new EntityExtractor()
    this.intentAnalyzer = new IntentAnalyzer()
    this.codebaseAnalyzer = new CodebaseAnalyzer()
  }

  async initialize(): Promise<void> {
    console.log('🔍 Initializing Context Manager...')

    await this.entityExtractor.initialize()
    await this.intentAnalyzer.initialize()
    await this.codebaseAnalyzer.initialize()

    console.log('✅ Context Manager ready')
  }

  /**
   * Build comprehensive context from input
   */
  async buildContext(params: {
    input: any
    existingContext?: Partial<Context>
    depth: 'shallow' | 'medium' | 'deep' | 'omniscient'
  }): Promise<Context> {
    const startTime = Date.now()
    const contextId = randomUUID()

    try {
      // Check cache first
      const cacheKey = this.buildCacheKey(params)
      if (this.contextCache.has(cacheKey)) {
        this.metrics.cacheHitRate = (this.metrics.cacheHitRate + 1) / (this.metrics.contextsBuilt + 1)
        return this.contextCache.get(cacheKey)!
      }

      console.log(`🧠 Building ${params.depth} context...`)

      // Build context layers
      const context: Context = {
        conversation: await this.buildConversationContext(params.input, params.depth),
        project: await this.buildProjectContext(params.input, params.depth),
        user: await this.buildUserContext(params.input, params.depth),
        system: await this.buildSystemContext(params.input, params.depth)
      }

      // Enrich with cross-references
      if (params.depth === 'deep' || params.depth === 'omniscient') {
        await this.enrichWithCrossReferences(context)
      }

      // Cache the context
      this.contextCache.set(cacheKey, context)
      this.limitCacheSize()

      // Update metrics
      const buildTime = Date.now() - startTime
      this.metrics.contextsBuilt++
      this.metrics.averageBuildTime = (this.metrics.averageBuildTime + buildTime) / this.metrics.contextsBuilt

      this.emit('context_built', { context, buildTime, depth: params.depth })

      return context

    } catch (error) {
      console.error('❌ Context building failed:', error)
      throw error
    }
  }

  /**
   * Build conversation context with intent and entity extraction
   */
  private async buildConversationContext(input: any, depth: string): Promise<Context['conversation']> {
    // Extract messages from input
    const messages = this.extractMessages(input)

    // Process each message
    const contextMessages: ContextMessage[] = []
    for (const msg of messages) {
      const entities = await this.entityExtractor.extract(msg.content)
      this.metrics.entitiesExtracted += entities.length

      contextMessages.push({
        id: msg.id || randomUUID(),
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp || new Date().toISOString(),
        intent: await this.extractMessageIntent(msg.content),
        entities,
        metadata: msg.metadata || {}
      })
    }

    // Analyze overall conversation intent
    const intent = await this.intentAnalyzer.analyzeConversation(contextMessages)

    // Extract topics and keywords
    const topics = this.extractTopics(contextMessages)
    const keywords = this.extractKeywords(contextMessages)

    // Determine sentiment
    const sentiment = this.analyzeSentiment(contextMessages)

    return {
      id: input.conversationId || randomUUID(),
      messages: contextMessages,
      intent,
      sentiment,
      topics,
      keywords,
      entities: contextMessages.flatMap(m => m.entities)
    }
  }

  /**
   * Build project context with codebase analysis
   */
  private async buildProjectContext(input: any, depth: string): Promise<Context['project']> {
    const projectId = input.projectId || input.context?.projectId
    if (!projectId) {
      // Return minimal project context
      return {
        id: 'unknown',
        name: 'Unknown Project',
        description: '',
        techStack: [],
        codebaseAnalysis: {
          totalFiles: 0,
          totalLines: 0,
          languages: {},
          complexity: 'simple',
          architecture: [],
          patterns: [],
          issues: [],
          hotspots: [],
          lastAnalyzed: new Date().toISOString()
        },
        recentChanges: [],
        activeTickets: [],
        activeTasks: [],
        type: ''
      }
    }

    // Get project details (would normally call API)
    const projectData = await this.fetchProjectData(projectId)

    // Analyze codebase if deep analysis requested
    let codebaseAnalysis: CodebaseSnapshot
    if (depth === 'deep' || depth === 'omniscient') {
      codebaseAnalysis = await this.codebaseAnalyzer.analyze(projectData.path)
    } else {
      codebaseAnalysis = projectData.codebaseAnalysis || {
        totalFiles: 0,
        totalLines: 0,
        languages: {},
        complexity: 'simple',
        architecture: [],
        patterns: [],
        issues: [],
        hotspots: [],
        lastAnalyzed: new Date().toISOString()
      }
    }

    return {
      id: projectId,
      name: projectData.name,
      description: projectData.description,
      techStack: projectData.techStack,
      codebaseAnalysis,
      recentChanges: await this.fetchRecentChanges(projectId),
      activeTickets: await this.fetchActiveTickets(projectId),
      activeTasks: await this.fetchActiveTasks(projectId),
      type: projectData.type || ''
    }
  }

  /**
   * Build user context with preferences and activity
   */
  private async buildUserContext(input: any, depth: string): Promise<Context['user']> {
    const userId = input.userId || input.context?.userId || 'anonymous'

    // Get user data (would normally call API)
    const userData = await this.fetchUserData(userId)

    return {
      id: userId,
      role: userData.role || 'developer',
      expertise: userData.expertise || [],
      preferences: userData.preferences || {
        communicationStyle: 'technical',
        workingStyle: 'autonomous',
        notificationPrefs: [],
        toolPreferences: []
      },
      workingHours: userData.workingHours || [],
      currentFocus: userData.currentFocus || [],
      recentActivity: depth === 'deep' || depth === 'omniscient'
        ? await this.fetchRecentActivity(userId)
        : []
    }
  }

  /**
   * Build system context
   */
  private async buildSystemContext(input: any, depth: string): Promise<Context['system']> {
    return {
      timestamp: new Date().toISOString(),
      sessionId: input.sessionId || randomUUID(),
      capabilities: [
        { name: 'entity_extraction', available: true, performance: 0.9, lastChecked: new Date().toISOString() },
        { name: 'intent_analysis', available: true, performance: 0.8, lastChecked: new Date().toISOString() },
        { name: 'codebase_analysis', available: true, performance: 0.85, lastChecked: new Date().toISOString() }
      ],
      performance: {
        responseTime: this.metrics.averageBuildTime,
        throughput: this.metrics.contextsBuilt,
        errorRate: 0.02,
        resourceUtilization: 0.6
      },
      environment: process.env.NODE_ENV as any || 'development'
    }
  }

  /**
   * Enrich context with cross-references and relationships
   */
  private async enrichWithCrossReferences(context: Context): Promise<void> {
    // Link entities to tickets/tasks
    for (const entity of context.conversation.entities) {
      if (entity.type === 'ticket') {
        const ticket = context.project.activeTickets.find(t => t.id === entity.value || t.title.includes(entity.value))
        if (ticket) {
          entity.metadata.linkedTicket = ticket
        }
      }

      if (entity.type === 'task') {
        const task = context.project.activeTasks.find(t => t.id === entity.value || t.title.includes(entity.value))
        if (task) {
          entity.metadata.linkedTask = task
        }
      }
    }

    // Find related code files
    const codeEntities = context.conversation.entities.filter(e => e.type === 'file')
    for (const entity of codeEntities) {
      const issues = context.project.codebaseAnalysis.issues.filter(i => i.file.includes(entity.value))
      if (issues.length > 0) {
        entity.metadata.codeIssues = issues
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helper Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private extractMessages(input: any): any[] {
    if (input.type === 'conversation' && input.content?.messages) {
      return input.content.messages
    }

    if (input.content && typeof input.content === 'string') {
      return [{
        role: 'user',
        content: input.content,
        timestamp: new Date().toISOString()
      }]
    }

    return []
  }

  private async extractMessageIntent(content: string): Promise<string[]> {
    const intents = []

    // Simple keyword-based intent detection
    if (content.toLowerCase().includes('bug') || content.toLowerCase().includes('error')) {
      intents.push('report_bug')
    }

    if (content.toLowerCase().includes('feature') || content.toLowerCase().includes('add')) {
      intents.push('request_feature')
    }

    if (content.toLowerCase().includes('help') || content.toLowerCase().includes('how')) {
      intents.push('ask_question')
    }

    if (content.toLowerCase().includes('create') || content.toLowerCase().includes('make')) {
      intents.push('create_something')
    }

    return intents.length > 0 ? intents : ['general']
  }

  private extractTopics(messages: ContextMessage[]): string[] {
    const topics = new Set<string>()

    for (const message of messages) {
      // Extract topics from entities
      message.entities.forEach(entity => {
        if (entity.type === 'technology' || entity.type === 'feature') {
          topics.add(entity.value)
        }
      })
    }

    return Array.from(topics).slice(0, 10)
  }

  private extractKeywords(messages: ContextMessage[]): string[] {
    const keywords = new Set<string>()
    const commonWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'up', 'about', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once'])

    for (const message of messages) {
      const words = message.content.toLowerCase().split(/\s+/)
      words.forEach(word => {
        const cleaned = word.replace(/[^\w]/g, '')
        if (cleaned.length > 3 && !commonWords.has(cleaned)) {
          keywords.add(cleaned)
        }
      })
    }

    return Array.from(keywords).slice(0, 20)
  }

  private analyzeSentiment(messages: ContextMessage[]): 'positive' | 'neutral' | 'frustrated' | 'urgent' {
    let frustrationScore = 0
    let urgencyScore = 0
    let positiveScore = 0

    const frustrationWords = ['broken', 'error', 'bug', 'issue', 'problem', 'fail', 'wrong', 'not working']
    const urgencyWords = ['urgent', 'asap', 'immediately', 'critical', 'important', 'quick', 'fast']
    const positiveWords = ['great', 'good', 'awesome', 'perfect', 'thanks', 'excellent']

    for (const message of messages) {
      const content = message.content.toLowerCase()

      frustrationWords.forEach(word => {
        if (content.includes(word)) frustrationScore++
      })

      urgencyWords.forEach(word => {
        if (content.includes(word)) urgencyScore++
      })

      positiveWords.forEach(word => {
        if (content.includes(word)) positiveScore++
      })
    }

    if (urgencyScore > 0) return 'urgent'
    if (frustrationScore > positiveScore) return 'frustrated'
    if (positiveScore > 0) return 'positive'
    return 'neutral'
  }

  private buildCacheKey(params: any): string {
    return `${params.input.type}_${params.depth}_${JSON.stringify(params.input).substring(0, 100)}`
  }

  private limitCacheSize(): void {
    if (this.contextCache.size > 100) {
      const keys = Array.from(this.contextCache.keys())
      const keysToDelete = keys.slice(0, 20)
      keysToDelete.forEach(key => this.contextCache.delete(key))
    }
  }

  // Mock data fetchers (would be replaced with actual API calls)
  private async fetchProjectData(projectId: string): Promise<any> {
    return {
      name: 'Example Project',
      description: 'A sample project for demonstration',
      techStack: ['TypeScript', 'React', 'Node'],
      path: '/example/project'
    }
  }

  private async fetchUserData(userId: string): Promise<any> {
    return {
      role: 'developer',
      expertise: ['typescript', 'react', 'backend'],
      preferences: {
        communicationStyle: 'technical',
        workingStyle: 'autonomous',
        notificationPrefs: ['email'],
        toolPreferences: ['vscode', 'git']
      }
    }
  }

  private async fetchRecentChanges(projectId: string): Promise<any[]> {
    return []
  }

  private async fetchActiveTickets(projectId: string): Promise<TicketContext[]> {
    return []
  }

  private async fetchActiveTasks(projectId: string): Promise<TaskContext[]> {
    return []
  }

  private async fetchRecentActivity(userId: string): Promise<UserActivity[]> {
    return []
  }

  getMetrics() {
    return { ...this.metrics }
  }
}

/**
 * Entity Extractor - Identifies entities in text
 */
class EntityExtractor {
  async initialize(): Promise<void> {
    // Initialize NLP models, load patterns, etc.
  }

  async extract(text: string): Promise<ContextEntity[]> {
    const entities: ContextEntity[] = []

    // Simple pattern-based extraction
    const patterns = [
      { type: 'file', regex: /\b\w+\.(js|ts|tsx|jsx|py|java|cpp|h)\b/g },
      { type: 'technology', regex: /\b(React|Vue|Angular|Node|Python|Java|TypeScript|JavaScript)\b/g },
      { type: 'endpoint', regex: /\/api\/[\w\/\-]+/g },
      { type: 'ticket', regex: /#\d+|ticket[\s\-#]\d+/gi }
    ]

    for (const pattern of patterns) {
      const matches = text.match(pattern.regex)
      if (matches) {
        matches.forEach(match => {
          entities.push({
            type: pattern.type as any,
            value: match.trim(),
            confidence: 0.8,
            metadata: {}
          })
        })
      }
    }

    return entities
  }
}

/**
 * Intent Analyzer - Understands conversation intent
 */
class IntentAnalyzer {
  async initialize(): Promise<void> {
    // Initialize intent models
  }

  async analyzeConversation(messages: ContextMessage[]): Promise<ConversationIntent> {
    let primaryIntent = 'general'
    let urgency: 'low' | 'medium' | 'high' | 'critical' = 'medium'
    let complexity: 'simple' | 'moderate' | 'complex' | 'expert' = 'moderate'

    const allText = messages.map(m => m.content).join(' ').toLowerCase()

    // Determine primary intent
    if (allText.includes('bug') || allText.includes('error')) {
      primaryIntent = 'problem'
    } else if (allText.includes('feature') || allText.includes('add')) {
      primaryIntent = 'request'
    } else if (allText.includes('help') || allText.includes('how')) {
      primaryIntent = 'question'
    } else if (allText.includes('plan') || allText.includes('strategy')) {
      primaryIntent = 'planning'
    }

    // Determine urgency
    if (allText.includes('urgent') || allText.includes('critical')) {
      urgency = 'critical'
    } else if (allText.includes('important') || allText.includes('asap')) {
      urgency = 'high'
    }

    // Determine complexity
    const complexityIndicators = allText.match(/\b(architecture|system|complex|integration|migration)\b/g)
    if (complexityIndicators && complexityIndicators.length > 2) {
      complexity = 'expert'
    } else if (complexityIndicators && complexityIndicators.length > 0) {
      complexity = 'complex'
    }

    return {
      primary: primaryIntent,
      secondary: [],
      confidence: 0.75,
      urgency,
      complexity
    }
  }
}

/**
 * Codebase Analyzer - Analyzes project codebase
 */
class CodebaseAnalyzer {
  async initialize(): Promise<void> {
    // Initialize code analysis tools
  }

  async analyze(projectPath: string): Promise<CodebaseSnapshot> {
    // Mock analysis - would use real tools like ESLint, SonarQube, etc.
    return {
      totalFiles: 150,
      totalLines: 25000,
      languages: {
        'TypeScript': 18000,
        'JavaScript': 5000,
        'CSS': 2000
      },
      complexity: 'moderate',
      architecture: ['MVC', 'Component-based'],
      patterns: ['Repository', 'Factory', 'Observer'],
      issues: [
        {
          type: 'security',
          severity: 'high',
          file: 'src/auth/auth.service.ts',
          line: 45,
          description: 'Potential SQL injection vulnerability',
          suggestion: 'Use parameterized queries'
        }
      ],
      hotspots: ['src/components/Chat.tsx', 'src/services/api.service.ts'],
      lastAnalyzed: new Date().toISOString()
    }
  }
}
