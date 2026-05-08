/**
 * DatabaseAdapter Test Suite
 * 
 * Tests for database integration and context building
 */

import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals'
import { DatabaseAdapter } from '../integrations/adapters/DatabaseAdapter'
import type { Context, Decision, Learning } from '../types'

// Mock Prisma
const mockPrisma = {
  project: {
    findUnique: jest.fn(),
    findMany: jest.fn()
  },
  decision: {
    create: jest.fn(),
    findMany: jest.fn()
  },
  learning: {
    create: jest.fn(),
    findMany: jest.fn()
  },
  conversation: {
    findUnique: jest.fn()
  },
  user: {
    findUnique: jest.fn()
  }
}

describe('DatabaseAdapter', () => {
  let adapter: DatabaseAdapter

  beforeEach(() => {
    jest.clearAllMocks()
    
    adapter = new DatabaseAdapter({
      prisma: mockPrisma as any,
      enableCaching: true,
      cacheTimeout: 300000
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('context building', () => {
    it('should build context from database', async () => {
      const mockProject = {
        id: 'proj-123',
        name: 'Test Project',
        description: 'A test project',
        settings: { language: 'typescript' }
      }

      const mockConversation = {
        id: 'conv-123',
        messages: [
          { id: '1', role: 'user', content: 'Hello', timestamp: new Date() }
        ]
      }

      mockPrisma.project.findUnique.mockResolvedValue(mockProject)
      mockPrisma.conversation.findUnique.mockResolvedValue(mockConversation)

      const context = await adapter.buildContextFromDatabase({
        projectId: 'proj-123',
        conversationId: 'conv-123'
      })

      expect(context.project).toEqual(mockProject)
      expect(context.conversation).toEqual(mockConversation)
      expect(mockPrisma.project.findUnique).toHaveBeenCalledWith({
        where: { id: 'proj-123' },
        include: expect.any(Object)
      })
    })

    it('should handle missing project gracefully', async () => {
      mockPrisma.project.findUnique.mockResolvedValue(null)

      await expect(
        adapter.buildContextFromDatabase({ projectId: 'non-existent' })
      ).rejects.toThrow('Project not found: non-existent')
    })

    it('should cache context data', async () => {
      const mockProject = {
        id: 'proj-123',
        name: 'Test Project'
      }

      mockPrisma.project.findUnique.mockResolvedValue(mockProject)

      // First call
      await adapter.buildContextFromDatabase({ projectId: 'proj-123' })
      
      // Second call should use cache
      await adapter.buildContextFromDatabase({ projectId: 'proj-123' })

      expect(mockPrisma.project.findUnique).toHaveBeenCalledTimes(1)
    })

    it('should include related data in context', async () => {
      const mockProject = {
        id: 'proj-123',
        name: 'Test Project',
        ProjectMember: [
          { user: { id: 'user-1', name: 'John Doe', role: 'developer' } }
        ],
        Integration: [
          { provider: 'github', config: { repo: 'test/repo' } }
        ]
      }

      mockPrisma.project.findUnique.mockResolvedValue(mockProject)

      const context = await adapter.buildContextFromDatabase({
        projectId: 'proj-123',
        includeMembers: true,
        includeIntegrations: true
      })

      expect(context.project.ProjectMember).toBeDefined()
      expect(context.project.Integration).toBeDefined()
      expect(context.teamMembers).toHaveLength(1)
      expect(context.integrations).toHaveLength(1)
    })
  })

  describe('decision management', () => {
    it('should save decisions to database', async () => {
      const mockDecision: Decision = {
        id: 'dec-123',
        question: 'Should we proceed?',
        selectedOption: 'yes',
        confidence: 0.85,
        reasoning: 'All conditions are met',
        factors: ['readiness', 'resources'],
        timestamp: new Date(),
        metadata: { source: 'test' }
      }

      const mockContext: Context = {
        project: { id: 'proj-123', name: 'Test Project' }
      }

      mockPrisma.decision.create.mockResolvedValue({
        id: 'db-dec-123',
        ...mockDecision
      })

      const result = await adapter.saveDecision(mockDecision, mockContext)

      expect(result).toBe('db-dec-123')
      expect(mockPrisma.decision.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: mockDecision.id,
          question: mockDecision.question,
          selectedOption: mockDecision.selectedOption,
          confidence: mockDecision.confidence,
          reasoning: mockDecision.reasoning,
          projectId: 'proj-123'
        })
      })
    })

    it('should retrieve recent decisions', async () => {
      const mockDecisions = [
        {
          id: 'dec-1',
          question: 'Test 1',
          selectedOption: 'yes',
          confidence: 0.8,
          createdAt: new Date()
        },
        {
          id: 'dec-2', 
          question: 'Test 2',
          selectedOption: 'no',
          confidence: 0.7,
          createdAt: new Date()
        }
      ]

      mockPrisma.decision.findMany.mockResolvedValue(mockDecisions)

      const decisions = await adapter.getRecentDecisions('proj-123', 10)

      expect(decisions).toHaveLength(2)
      expect(mockPrisma.decision.findMany).toHaveBeenCalledWith({
        where: { projectId: 'proj-123' },
        orderBy: { createdAt: 'desc' },
        take: 10
      })
    })

    it('should filter decisions by confidence threshold', async () => {
      const highConfidenceDecisions = [
        { id: 'dec-1', confidence: 0.9 },
        { id: 'dec-2', confidence: 0.85 }
      ]

      mockPrisma.decision.findMany.mockResolvedValue(highConfidenceDecisions)

      const decisions = await adapter.getRecentDecisions('proj-123', 10, 0.8)

      expect(mockPrisma.decision.findMany).toHaveBeenCalledWith({
        where: { 
          projectId: 'proj-123',
          confidence: { gte: 0.8 }
        },
        orderBy: { createdAt: 'desc' },
        take: 10
      })
    })
  })

  describe('learning management', () => {
    it('should save learning to database', async () => {
      const mockLearning: Learning = {
        id: 'learn-123',
        type: 'performance_optimization',
        description: 'Database queries can be optimized',
        confidence: 0.9,
        actionableInsights: [
          'Add index on user_id column',
          'Use connection pooling'
        ],
        evidence: [
          'Query time reduced by 70%',
          'CPU usage decreased'
        ],
        applicableContexts: ['database_operations'],
        metadata: { source: 'performance_analysis' }
      }

      const mockContext: Context = {
        project: { id: 'proj-123', name: 'Test Project' }
      }

      mockPrisma.learning.create.mockResolvedValue({
        id: 'db-learn-123',
        ...mockLearning
      })

      const result = await adapter.saveLearning(mockLearning, mockContext)

      expect(result).toBe('db-learn-123')
      expect(mockPrisma.learning.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: mockLearning.id,
          type: mockLearning.type,
          description: mockLearning.description,
          confidence: mockLearning.confidence,
          projectId: 'proj-123'
        })
      })
    })

    it('should retrieve learnings by context', async () => {
      const mockLearnings = [
        {
          id: 'learn-1',
          type: 'code_quality',
          description: 'Use TypeScript for better type safety',
          confidence: 0.95
        }
      ]

      mockPrisma.learning.findMany.mockResolvedValue(mockLearnings)

      const learnings = await adapter.getLearnings({
        projectId: 'proj-123',
        type: 'code_quality',
        minConfidence: 0.9,
        limit: 5
      })

      expect(learnings).toHaveLength(1)
      expect(mockPrisma.learning.findMany).toHaveBeenCalledWith({
        where: {
          projectId: 'proj-123',
          type: 'code_quality',
          confidence: { gte: 0.9 }
        },
        orderBy: { confidence: 'desc' },
        take: 5
      })
    })

    it('should apply learning filters correctly', async () => {
      mockPrisma.learning.findMany.mockResolvedValue([])

      await adapter.getLearnings({
        projectId: 'proj-123',
        applicableContexts: ['authentication', 'security'],
        minConfidence: 0.8
      })

      expect(mockPrisma.learning.findMany).toHaveBeenCalledWith({
        where: {
          projectId: 'proj-123',
          confidence: { gte: 0.8 },
          applicableContexts: {
            hasSome: ['authentication', 'security']
          }
        },
        orderBy: { confidence: 'desc' },
        take: 20
      })
    })
  })

  describe('caching', () => {
    it('should cache database queries', async () => {
      const cacheAdapter = new DatabaseAdapter({
        prisma: mockPrisma as any,
        enableCaching: true,
        cacheTimeout: 1000
      })

      const mockProject = { id: 'proj-123', name: 'Test' }
      mockPrisma.project.findUnique.mockResolvedValue(mockProject)

      // First call
      await cacheAdapter.buildContextFromDatabase({ projectId: 'proj-123' })
      
      // Second call within cache timeout
      await cacheAdapter.buildContextFromDatabase({ projectId: 'proj-123' })

      expect(mockPrisma.project.findUnique).toHaveBeenCalledTimes(1)
    })

    it('should invalidate cache after timeout', async () => {
      const cacheAdapter = new DatabaseAdapter({
        prisma: mockPrisma as any,
        enableCaching: true,
        cacheTimeout: 10 // Very short timeout
      })

      const mockProject = { id: 'proj-123', name: 'Test' }
      mockPrisma.project.findUnique.mockResolvedValue(mockProject)

      // First call
      await cacheAdapter.buildContextFromDatabase({ projectId: 'proj-123' })
      
      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 20))
      
      // Second call after timeout
      await cacheAdapter.buildContextFromDatabase({ projectId: 'proj-123' })

      expect(mockPrisma.project.findUnique).toHaveBeenCalledTimes(2)
    })

    it('should allow cache disabling', async () => {
      const noCacheAdapter = new DatabaseAdapter({
        prisma: mockPrisma as any,
        enableCaching: false
      })

      const mockProject = { id: 'proj-123', name: 'Test' }
      mockPrisma.project.findUnique.mockResolvedValue(mockProject)

      // Multiple calls should not use cache
      await noCacheAdapter.buildContextFromDatabase({ projectId: 'proj-123' })
      await noCacheAdapter.buildContextFromDatabase({ projectId: 'proj-123' })

      expect(mockPrisma.project.findUnique).toHaveBeenCalledTimes(2)
    })
  })

  describe('error handling', () => {
    it('should handle database connection errors', async () => {
      mockPrisma.project.findUnique.mockRejectedValue(new Error('Connection failed'))

      await expect(
        adapter.buildContextFromDatabase({ projectId: 'proj-123' })
      ).rejects.toThrow('Database query failed: Connection failed')
    })

    it('should handle malformed data gracefully', async () => {
      // Return malformed project data
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'proj-123',
        // Missing required fields
      })

      const context = await adapter.buildContextFromDatabase({ projectId: 'proj-123' })
      
      expect(context.project.id).toBe('proj-123')
      expect(context.project.name).toBeUndefined()
    })

    it('should validate input parameters', async () => {
      await expect(
        adapter.buildContextFromDatabase({ projectId: '' })
      ).rejects.toThrow('Invalid projectId')

      await expect(
        adapter.buildContextFromDatabase({} as any)
      ).rejects.toThrow('ProjectId is required')
    })
  })

  describe('performance', () => {
    it('should optimize query performance with includes', async () => {
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'proj-123',
        name: 'Test Project'
      })

      await adapter.buildContextFromDatabase({
        projectId: 'proj-123',
        includeMembers: true,
        includeIntegrations: true,
        includeRecentActivity: true
      })

      // Should make single query with all includes
      expect(mockPrisma.project.findUnique).toHaveBeenCalledTimes(1)
      expect(mockPrisma.project.findUnique).toHaveBeenCalledWith({
        where: { id: 'proj-123' },
        include: expect.objectContaining({
          ProjectMember: expect.any(Object),
          Integration: expect.any(Object),
          Task: expect.any(Object)
        })
      })
    })

    it('should handle large result sets efficiently', async () => {
      const manyDecisions = Array(1000).fill(0).map((_, i) => ({
        id: `dec-${i}`,
        question: `Question ${i}`,
        selectedOption: 'yes',
        confidence: 0.8
      }))

      mockPrisma.decision.findMany.mockResolvedValue(manyDecisions)

      const decisions = await adapter.getRecentDecisions('proj-123', 1000)

      expect(decisions).toHaveLength(1000)
      expect(mockPrisma.decision.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1000 })
      )
    })
  })

  describe('data relationships', () => {
    it('should preserve data relationships in context', async () => {
      const mockProject = {
        id: 'proj-123',
        name: 'Test Project',
        ProjectMember: [
          {
            id: 'member-1',
            role: 'ADMIN',
            user: {
              id: 'user-1',
              name: 'John Doe',
              email: 'john@example.com'
            }
          }
        ],
        Task: [
          {
            id: 'task-1',
            title: 'Test Task',
            assigneeId: 'user-1'
          }
        ]
      }

      mockPrisma.project.findUnique.mockResolvedValue(mockProject)

      const context = await adapter.buildContextFromDatabase({
        projectId: 'proj-123',
        includeMembers: true,
        includeRecentActivity: true
      })

      expect(context.teamMembers).toHaveLength(1)
      expect(context.teamMembers![0].user.name).toBe('John Doe')
      expect(context.recentActivity).toHaveLength(1)
      expect(context.recentActivity![0].title).toBe('Test Task')
    })

    it('should handle nested relationship queries', async () => {
      const mockConversation = {
        id: 'conv-123',
        messages: [
          {
            id: 'msg-1',
            content: 'Hello',
            role: 'user',
            user: { id: 'user-1', name: 'John' }
          }
        ],
        project: {
          id: 'proj-123',
          name: 'Test Project'
        }
      }

      mockPrisma.conversation.findUnique.mockResolvedValue(mockConversation)

      const context = await adapter.buildContextFromDatabase({
        conversationId: 'conv-123'
      })

      expect(context.conversation.project).toBeDefined()
      expect(context.conversation.messages[0].user).toBeDefined()
    })
  })
})
