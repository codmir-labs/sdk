/**
 * Database Integration Adapter for Codmir Agent SDK
 * 
 * Connects the Agent SDK intelligence modules with existing Prisma models
 * to enable database-backed context and decision making.
 */

import type { PrismaClient } from '@prisma/client'
import type {
  Context,
  ConversationContext,
  ProjectContext,
  UserContext,
  TaskContext,
  CodebaseContext
} from '../../types'

/**
 * Extended context type that includes optional task and codebase fields
 * not present on the base Context interface.
 */
type ExtendedContext = Partial<Context> & {
  task?: TaskContext
  codebase?: CodebaseContext
}

export interface DatabaseAdapterConfig {
  prisma: PrismaClient
  enableCaching?: boolean
  cacheTimeout?: number
}

export class DatabaseAdapter {
  private prisma: PrismaClient
  private cache = new Map<string, { data: any; timestamp: number }>()
  private cacheTimeout: number

  constructor(private config: DatabaseAdapterConfig) {
    this.prisma = config.prisma
    this.cacheTimeout = config.cacheTimeout || 300000 // 5 minutes default
  }

  /**
   * Build context from database entities
   */
  async buildContextFromDatabase(params: {
    conversationId?: string
    projectId?: string
    userId?: string
    taskId?: string
    ticketId?: string
  }): Promise<ExtendedContext> {
    const context: ExtendedContext = {}

    // Build conversation context
    if (params.conversationId) {
      context.conversation = await this.getConversationContext(params.conversationId)
    }

    // Build project context
    if (params.projectId) {
      context.project = await this.getProjectContext(params.projectId)
    }

    // Build user context
    if (params.userId) {
      context.user = await this.getUserContext(params.userId)
    }

    // Build task context
    if (params.taskId) {
      context.task = await this.getTaskContext(params.taskId)
    }

    // Build codebase context from project
    if (params.projectId) {
      context.codebase = await this.getCodebaseContext(params.projectId)
    }

    return context
  }

  /**
   * Get conversation context from database
   */
  async getConversationContext(conversationId: string): Promise<ConversationContext | undefined> {
    const cacheKey = `conversation:${conversationId}`
    const cached = this.getFromCache(cacheKey)
    if (cached) return cached

    try {
      const conversation = await (this.prisma as any).chatConversation.findUnique({
        where: { id: conversationId },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
            take: 50 // Last 50 messages
          },
          project: true,
          user: true
        }
      })

      if (!conversation) return undefined

      const context = {
        id: conversation.id,
        messages: conversation.messages.map((msg: any) => ({
          id: msg.id,
          role: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content,
          timestamp: msg.createdAt.toISOString(),
          intent: [],
          entities: [],
          metadata: msg.metadata as any
        })),
        intent: { primary: 'unknown', secondary: [], confidence: 0, urgency: 'low' as const, complexity: 'simple' as const },
        sentiment: 'neutral' as const,
        topics: [],
        keywords: [],
        entities: []
      } as ConversationContext

      this.setInCache(cacheKey, context)
      return context

    } catch (error) {
      console.error('Failed to get conversation context:', error)
      return undefined
    }
  }

  /**
   * Get project context from database
   */
  async getProjectContext(projectId: string): Promise<ProjectContext | undefined> {
    const cacheKey = `project:${projectId}`
    const cached = this.getFromCache(cacheKey)
    if (cached) return cached

    try {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        include: {
          members: {
            include: { user: true }
          }
        } as any
      })

      if (!project) return undefined

      const proj = project as any
      const context = {
        id: project.id,
        name: project.name,
        type: proj.type || 'general',
        description: proj.description || '',
        techStack: proj.techStack || [],
        codebaseAnalysis: proj.codebaseAnalysis || { totalFiles: 0, totalLines: 0, languages: {}, complexity: 'simple', architecture: [], patterns: [], issues: [], hotspots: [], lastAnalyzed: '' },
        recentChanges: proj.recentChanges || [],
        activeTickets: proj.tickets || [],
        activeTasks: proj.tasks || [],
      } as ProjectContext

      this.setInCache(cacheKey, context)
      return context

    } catch (error) {
      console.error('Failed to get project context:', error)
      return undefined
    }
  }

  /**
   * Get user context from database
   */
  async getUserContext(userId: string): Promise<UserContext | undefined> {
    const cacheKey = `user:${userId}`
    const cached = this.getFromCache(cacheKey)
    if (cached) return cached

    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          projects: {
            include: { project: true }
          }
        } as any
      })

      if (!user) return undefined

      const u = user as any
      const context = {
        id: user.id,
        name: user.name || 'Unknown',
        role: u.role || 'developer',
        expertise: u.expertise || [],
        preferences: {
          communicationStyle: u.preferences?.communicationStyle || 'concise',
          workingStyle: u.preferences?.workingStyle || 'autonomous',
          notificationPrefs: u.preferences?.notificationPrefs || [],
          toolPreferences: u.preferences?.toolPreferences || []
        },
        workingHours: u.workingHours || [],
        currentFocus: u.currentFocus || [],
        recentActivity: u.recentActivity || []
      } as UserContext

      this.setInCache(cacheKey, context)
      return context

    } catch (error) {
      console.error('Failed to get user context:', error)
      return undefined
    }
  }

  /**
   * Get task context from database
   */
  async getTaskContext(taskId: string): Promise<TaskContext | undefined> {
    const cacheKey = `task:${taskId}`
    const cached = this.getFromCache(cacheKey)
    if (cached) return cached

    try {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        include: {
          ticket: true,
          project: true,
          dependencies: true,
          dependents: true,
          comments: {
            orderBy: { createdAt: 'desc' },
            take: 10
          }
        } as any
      })

      if (!task) return undefined

      const t = task as any
      const context = {
        id: task.id,
        title: task.title,
        description: t.description || '',
        status: task.status,
        progress: t.progress || 0,
        assignee: t.assignee ? t.assignee.name || t.assignee.id : undefined,
        dependencies: (t.dependencies || []).map((dep: any) => dep.id),
        estimatedCompletion: t.dueDate?.toISOString()
      } as TaskContext

      this.setInCache(cacheKey, context)
      return context

    } catch (error) {
      console.error('Failed to get task context:', error)
      return undefined
    }
  }

  /**
   * Get codebase context from project
   */
  async getCodebaseContext(projectId: string): Promise<CodebaseContext | undefined> {
    const cacheKey = `codebase:${projectId}`
    const cached = this.getFromCache(cacheKey)
    if (cached) return cached

    try {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId }
      })

      if (!project) return undefined

      const proj = project as any
      const repository = proj.repository
      const latestAnalysis = proj.codeAnalysis?.[0]

      const context = {
        totalFiles: latestAnalysis?.fileCount || 0,
        totalLines: latestAnalysis?.lineCount || 0,
        languages: { [repository?.primaryLanguage || 'typescript']: 100 },
        complexity: 'moderate' as const,
        architecture: [],
        patterns: [],
        issues: [],
        hotspots: [],
        lastAnalyzed: latestAnalysis?.createdAt?.toISOString() || ''
      } as CodebaseContext

      this.setInCache(cacheKey, context)
      return context

    } catch (error) {
      console.error('Failed to get codebase context:', error)
      return undefined
    }
  }

  /**
   * Save decision to database
   */
  async saveDecision(decision: any, context: Context): Promise<void> {
    try {
      await (this.prisma as any).agentDecision.create({
        data: {
          id: decision.id,
          question: decision.question,
          choice: decision.choice,
          confidence: decision.confidence,
          factors: decision.factors,
          reasoning: decision.reasoning,
          context: context as any,
          projectId: context.project?.id,
          userId: context.user?.id,
          metadata: {
            constraints: decision.constraints,
            tradeoffs: decision.tradeoffs,
            expectedOutcome: decision.expectedOutcome
          }
        }
      })
    } catch (error) {
      console.error('Failed to save decision:', error)
    }
  }

  /**
   * Save learning to database
   */
  async saveLearning(learning: any, context: Context): Promise<void> {
    try {
      await (this.prisma as any).agentLearning.create({
        data: {
          id: learning.id,
          type: learning.type,
          description: learning.description,
          whatHappened: learning.whatHappened,
          whyItHappened: learning.whyItHappened,
          whatToDoNext: learning.whatToDoNext,
          confidence: learning.confidence,
          context: learning.context,
          applicableContexts: learning.applicableContexts,
          actionableInsights: learning.actionableInsights,
          preventionMeasures: learning.preventionMeasures,
          projectId: context.project?.id,
          userId: context.user?.id
        }
      })
    } catch (error) {
      console.error('Failed to save learning:', error)
    }
  }

  /**
   * Get recent decisions for a project
   */
  async getRecentDecisions(projectId: string, limit: number = 10): Promise<any[]> {
    try {
      const decisions = await (this.prisma as any).agentDecision.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        take: limit
      })
      return decisions
    } catch (error) {
      console.error('Failed to get recent decisions:', error)
      return []
    }
  }

  /**
   * Get learnings for a context
   */
  async getLearnings(params: {
    projectId?: string
    type?: string
    minConfidence?: number
    limit?: number
  }): Promise<any[]> {
    try {
      const learnings = await (this.prisma as any).agentLearning.findMany({
        where: {
          projectId: params.projectId,
          type: params.type,
          confidence: params.minConfidence ? { gte: params.minConfidence } : undefined
        },
        orderBy: { confidence: 'desc' },
        take: params.limit || 20
      })
      return learnings
    } catch (error) {
      console.error('Failed to get learnings:', error)
      return []
    }
  }

  // Cache helpers
  private getFromCache(key: string): any {
    if (!this.config.enableCaching) return null

    const cached = this.cache.get(key)
    if (!cached) return null

    if (Date.now() - cached.timestamp > this.cacheTimeout) {
      this.cache.delete(key)
      return null
    }

    return cached.data
  }

  private setInCache(key: string, data: any): void {
    if (!this.config.enableCaching) return

    this.cache.set(key, {
      data,
      timestamp: Date.now()
    })
  }

  clearCache(): void {
    this.cache.clear()
  }
}
