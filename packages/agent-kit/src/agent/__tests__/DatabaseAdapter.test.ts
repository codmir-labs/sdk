/**
 * DatabaseAdapter Test Suite
 *
 * Exercises the public API of DatabaseAdapter against a fake Prisma client.
 * The Prisma client is the only mocked boundary; the clock is faked for cache expiry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseAdapter } from '../integrations/adapters/DatabaseAdapter'
import type { Context } from '../types'

function makePrisma() {
  return {
    chatConversation: { findUnique: vi.fn() },
    project: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    task: { findUnique: vi.fn() },
    agentDecision: { create: vi.fn(), findMany: vi.fn() },
    agentLearning: { create: vi.fn(), findMany: vi.fn() }
  }
}

type FakePrisma = ReturnType<typeof makePrisma>

function makeAdapter(prisma: FakePrisma, opts: { enableCaching?: boolean; cacheTimeout?: number } = {}) {
  return new DatabaseAdapter({ prisma: prisma as any, ...opts })
}

const conversationRow = {
  id: 'conv-1',
  messages: [
    { id: 'm1', role: 'user', content: 'hello', createdAt: new Date('2025-01-01T00:00:00Z'), metadata: { a: 1 } },
    { id: 'm2', role: 'assistant', content: 'hi', createdAt: new Date('2025-01-01T00:00:05Z'), metadata: null }
  ]
}

describe('DatabaseAdapter', () => {
  let prisma: FakePrisma
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    prisma = makePrisma()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('getConversationContext', () => {
    it('maps messages into the conversation context and queries the last 50 oldest-first', async () => {
      prisma.chatConversation.findUnique.mockResolvedValue(conversationRow)
      const ctx = await makeAdapter(prisma).getConversationContext('conv-1')

      expect(prisma.chatConversation.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'conv-1' },
          include: expect.objectContaining({ messages: { orderBy: { createdAt: 'asc' }, take: 50 } })
        })
      )
      expect(ctx?.id).toBe('conv-1')
      expect(ctx?.messages).toHaveLength(2)
      expect(ctx?.messages[0]).toMatchObject({
        id: 'm1',
        role: 'user',
        content: 'hello',
        timestamp: '2025-01-01T00:00:00.000Z',
        metadata: { a: 1 }
      })
      expect(ctx?.sentiment).toBe('neutral')
    })

    it('returns undefined when the conversation does not exist', async () => {
      prisma.chatConversation.findUnique.mockResolvedValue(null)
      expect(await makeAdapter(prisma).getConversationContext('nope')).toBeUndefined()
    })

    it('swallows database errors, logs them and returns undefined', async () => {
      prisma.chatConversation.findUnique.mockRejectedValue(new Error('db down'))
      expect(await makeAdapter(prisma).getConversationContext('conv-1')).toBeUndefined()
      expect(errorSpy).toHaveBeenCalledWith('Failed to get conversation context:', expect.any(Error))
    })
  })

  describe('getProjectContext', () => {
    it('maps a full project row', async () => {
      prisma.project.findUnique.mockResolvedValue({
        id: 'p1',
        name: 'Proj',
        type: 'web',
        description: 'desc',
        techStack: ['ts'],
        recentChanges: ['c1'],
        tickets: ['t1'],
        tasks: ['k1']
      })
      const ctx = await makeAdapter(prisma).getProjectContext('p1')

      expect(prisma.project.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p1' } }))
      expect(ctx).toMatchObject({
        id: 'p1',
        name: 'Proj',
        type: 'web',
        description: 'desc',
        techStack: ['ts'],
        recentChanges: ['c1'],
        activeTickets: ['t1'],
        activeTasks: ['k1']
      })
    })

    it('fills defaults for a sparse project row', async () => {
      prisma.project.findUnique.mockResolvedValue({ id: 'p2', name: 'Bare' })
      const ctx = await makeAdapter(prisma).getProjectContext('p2')

      expect(ctx).toMatchObject({
        type: 'general',
        description: '',
        techStack: [],
        recentChanges: [],
        activeTickets: [],
        activeTasks: []
      })
      expect(ctx?.codebaseAnalysis.totalFiles).toBe(0)
    })

    it('returns undefined for a missing project and for a database error', async () => {
      const adapter = makeAdapter(prisma)
      prisma.project.findUnique.mockResolvedValueOnce(null)
      expect(await adapter.getProjectContext('x')).toBeUndefined()

      prisma.project.findUnique.mockRejectedValueOnce(new Error('boom'))
      expect(await adapter.getProjectContext('x')).toBeUndefined()
      expect(errorSpy).toHaveBeenCalledWith('Failed to get project context:', expect.any(Error))
    })
  })

  describe('getUserContext', () => {
    it('maps user fields and preferences', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        name: 'Ada',
        role: 'lead',
        expertise: ['ts'],
        preferences: { communicationStyle: 'detailed', workingStyle: 'collaborative' },
        currentFocus: ['auth']
      })
      const ctx = await makeAdapter(prisma).getUserContext('u1')

      expect(ctx).toMatchObject({
        id: 'u1',
        name: 'Ada',
        role: 'lead',
        expertise: ['ts'],
        currentFocus: ['auth']
      })
      expect(ctx?.preferences).toMatchObject({
        communicationStyle: 'detailed',
        workingStyle: 'collaborative',
        notificationPrefs: [],
        toolPreferences: []
      })
    })

    it('defaults name, role and preferences', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u2', name: null })
      const ctx = await makeAdapter(prisma).getUserContext('u2')

      expect(ctx).toMatchObject({ name: 'Unknown', role: 'developer', expertise: [] })
      expect(ctx?.preferences).toMatchObject({ communicationStyle: 'concise', workingStyle: 'autonomous' })
    })

    it('returns undefined for a missing user and for a database error', async () => {
      const adapter = makeAdapter(prisma)
      prisma.user.findUnique.mockResolvedValueOnce(null)
      expect(await adapter.getUserContext('x')).toBeUndefined()

      prisma.user.findUnique.mockRejectedValueOnce(new Error('boom'))
      expect(await adapter.getUserContext('x')).toBeUndefined()
      expect(errorSpy).toHaveBeenCalledWith('Failed to get user context:', expect.any(Error))
    })
  })

  describe('getTaskContext', () => {
    it('maps task fields, assignee name, dependency ids and due date', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: 't1',
        title: 'Do it',
        description: 'details',
        status: 'IN_PROGRESS',
        progress: 40,
        assignee: { id: 'u1', name: 'Ada' },
        dependencies: [{ id: 'd1' }, { id: 'd2' }],
        dueDate: new Date('2025-03-01T00:00:00Z')
      })
      const ctx = await makeAdapter(prisma).getTaskContext('t1')

      expect(ctx).toEqual({
        id: 't1',
        title: 'Do it',
        description: 'details',
        status: 'IN_PROGRESS',
        progress: 40,
        assignee: 'Ada',
        dependencies: ['d1', 'd2'],
        estimatedCompletion: '2025-03-01T00:00:00.000Z'
      })
    })

    it('falls back to the assignee id and to empty defaults', async () => {
      prisma.task.findUnique.mockResolvedValueOnce({ id: 't2', title: 'x', status: 'TODO', assignee: { id: 'u9' } })
      const ctx = await makeAdapter(prisma).getTaskContext('t2')
      expect(ctx).toMatchObject({ assignee: 'u9', description: '', progress: 0, dependencies: [] })
      expect(ctx?.estimatedCompletion).toBeUndefined()
    })

    it('returns undefined for a missing task and for a database error', async () => {
      const adapter = makeAdapter(prisma)
      prisma.task.findUnique.mockResolvedValueOnce(null)
      expect(await adapter.getTaskContext('x')).toBeUndefined()

      prisma.task.findUnique.mockRejectedValueOnce(new Error('boom'))
      expect(await adapter.getTaskContext('x')).toBeUndefined()
      expect(errorSpy).toHaveBeenCalledWith('Failed to get task context:', expect.any(Error))
    })
  })

  describe('getCodebaseContext', () => {
    it('uses the latest analysis and repository language', async () => {
      prisma.project.findUnique.mockResolvedValue({
        id: 'p1',
        repository: { primaryLanguage: 'rust' },
        codeAnalysis: [{ fileCount: 12, lineCount: 3400, createdAt: new Date('2025-02-02T00:00:00Z') }]
      })
      const ctx = await makeAdapter(prisma).getCodebaseContext('p1')

      expect(ctx).toMatchObject({
        totalFiles: 12,
        totalLines: 3400,
        languages: { rust: 100 },
        lastAnalyzed: '2025-02-02T00:00:00.000Z'
      })
    })

    it('defaults to typescript with zero counts when there is no analysis', async () => {
      prisma.project.findUnique.mockResolvedValue({ id: 'p1' })
      const ctx = await makeAdapter(prisma).getCodebaseContext('p1')
      expect(ctx).toMatchObject({ totalFiles: 0, totalLines: 0, languages: { typescript: 100 }, lastAnalyzed: '' })
    })

    it('returns undefined for a missing project and for a database error', async () => {
      const adapter = makeAdapter(prisma)
      prisma.project.findUnique.mockResolvedValueOnce(null)
      expect(await adapter.getCodebaseContext('x')).toBeUndefined()

      prisma.project.findUnique.mockRejectedValueOnce(new Error('boom'))
      expect(await adapter.getCodebaseContext('x')).toBeUndefined()
      expect(errorSpy).toHaveBeenCalledWith('Failed to get codebase context:', expect.any(Error))
    })
  })

  describe('buildContextFromDatabase', () => {
    it('returns an empty context and queries nothing when given no ids', async () => {
      const ctx = await makeAdapter(prisma).buildContextFromDatabase({})
      expect(ctx).toEqual({})
      expect(prisma.project.findUnique).not.toHaveBeenCalled()
      expect(prisma.user.findUnique).not.toHaveBeenCalled()
    })

    it('assembles every section from the ids it is given', async () => {
      prisma.chatConversation.findUnique.mockResolvedValue(conversationRow)
      prisma.project.findUnique.mockResolvedValue({ id: 'p1', name: 'Proj' })
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', name: 'Ada' })
      prisma.task.findUnique.mockResolvedValue({ id: 't1', title: 'T', status: 'TODO' })

      const ctx = await makeAdapter(prisma).buildContextFromDatabase({
        conversationId: 'conv-1',
        projectId: 'p1',
        userId: 'u1',
        taskId: 't1'
      })

      expect(ctx.conversation?.id).toBe('conv-1')
      expect(ctx.project?.name).toBe('Proj')
      expect(ctx.user?.name).toBe('Ada')
      expect(ctx.task?.id).toBe('t1')
      expect(ctx.codebase).toBeDefined()
    })

    it('only builds the sections whose ids were supplied', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', name: 'Ada' })
      const ctx = await makeAdapter(prisma).buildContextFromDatabase({ userId: 'u1' })
      expect(Object.keys(ctx)).toEqual(['user'])
    })
  })

  describe('saveDecision', () => {
    const context = { project: { id: 'p1' }, user: { id: 'u1' } } as unknown as Context

    it('persists the decision with its project, user and metadata', async () => {
      prisma.agentDecision.create.mockResolvedValue({})
      await makeAdapter(prisma).saveDecision(
        {
          id: 'd1',
          question: 'Q?',
          choice: 'A',
          confidence: 0.9,
          factors: ['f'],
          reasoning: 'because',
          constraints: ['c'],
          tradeoffs: ['t'],
          expectedOutcome: 'ok'
        },
        context
      )

      expect(prisma.agentDecision.create).toHaveBeenCalledTimes(1)
      const { data } = prisma.agentDecision.create.mock.calls[0][0]
      expect(data).toMatchObject({
        id: 'd1',
        question: 'Q?',
        choice: 'A',
        confidence: 0.9,
        projectId: 'p1',
        userId: 'u1',
        metadata: { constraints: ['c'], tradeoffs: ['t'], expectedOutcome: 'ok' }
      })
    })

    it('does not throw when the write fails, and logs it', async () => {
      prisma.agentDecision.create.mockRejectedValue(new Error('write failed'))
      await expect(makeAdapter(prisma).saveDecision({ id: 'd1' }, context)).resolves.toBeUndefined()
      expect(errorSpy).toHaveBeenCalledWith('Failed to save decision:', expect.any(Error))
    })
  })

  describe('saveLearning', () => {
    const context = { project: { id: 'p1' }, user: { id: 'u1' } } as unknown as Context

    it('persists the learning with its project and user', async () => {
      prisma.agentLearning.create.mockResolvedValue({})
      await makeAdapter(prisma).saveLearning(
        { id: 'l1', type: 'success', description: 'd', confidence: 0.7, actionableInsights: ['i'] },
        context
      )

      const { data } = prisma.agentLearning.create.mock.calls[0][0]
      expect(data).toMatchObject({
        id: 'l1',
        type: 'success',
        description: 'd',
        confidence: 0.7,
        actionableInsights: ['i'],
        projectId: 'p1',
        userId: 'u1'
      })
    })

    it('leaves project and user ids undefined when the context has none', async () => {
      prisma.agentLearning.create.mockResolvedValue({})
      await makeAdapter(prisma).saveLearning({ id: 'l2' }, {} as Context)
      const { data } = prisma.agentLearning.create.mock.calls[0][0]
      expect(data.projectId).toBeUndefined()
      expect(data.userId).toBeUndefined()
    })

    it('does not throw when the write fails, and logs it', async () => {
      prisma.agentLearning.create.mockRejectedValue(new Error('write failed'))
      await expect(makeAdapter(prisma).saveLearning({ id: 'l1' }, context)).resolves.toBeUndefined()
      expect(errorSpy).toHaveBeenCalledWith('Failed to save learning:', expect.any(Error))
    })
  })

  describe('getRecentDecisions', () => {
    it('returns the rows, newest first, with a default limit of 10', async () => {
      const rows = [{ id: 'd2' }, { id: 'd1' }]
      prisma.agentDecision.findMany.mockResolvedValue(rows)
      const result = await makeAdapter(prisma).getRecentDecisions('p1')

      expect(result).toBe(rows)
      expect(prisma.agentDecision.findMany).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
        orderBy: { createdAt: 'desc' },
        take: 10
      })
    })

    it('honours an explicit limit', async () => {
      prisma.agentDecision.findMany.mockResolvedValue([])
      await makeAdapter(prisma).getRecentDecisions('p1', 3)
      expect(prisma.agentDecision.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }))
    })

    it('returns an empty list on a database error', async () => {
      prisma.agentDecision.findMany.mockRejectedValue(new Error('boom'))
      expect(await makeAdapter(prisma).getRecentDecisions('p1')).toEqual([])
      expect(errorSpy).toHaveBeenCalledWith('Failed to get recent decisions:', expect.any(Error))
    })
  })

  describe('getLearnings', () => {
    it('filters by project, type and minimum confidence, highest confidence first', async () => {
      const rows = [{ id: 'l1' }]
      prisma.agentLearning.findMany.mockResolvedValue(rows)
      const result = await makeAdapter(prisma).getLearnings({
        projectId: 'p1',
        type: 'failure',
        minConfidence: 0.6,
        limit: 5
      })

      expect(result).toBe(rows)
      expect(prisma.agentLearning.findMany).toHaveBeenCalledWith({
        where: { projectId: 'p1', type: 'failure', confidence: { gte: 0.6 } },
        orderBy: { confidence: 'desc' },
        take: 5
      })
    })

    it('keeps a minConfidence of 0 as a filter (CSL-5553)', async () => {
      prisma.agentLearning.findMany.mockResolvedValue([])
      await makeAdapter(prisma).getLearnings({ minConfidence: 0 })
      expect(prisma.agentLearning.findMany.mock.calls[0][0].where.confidence).toEqual({ gte: 0 })
    })

    it('defaults to a limit of 20 and no confidence filter', async () => {
      prisma.agentLearning.findMany.mockResolvedValue([])
      await makeAdapter(prisma).getLearnings({})
      const arg = prisma.agentLearning.findMany.mock.calls[0][0]
      expect(arg.take).toBe(20)
      expect(arg.where.confidence).toBeUndefined()
    })

    it('returns an empty list on a database error', async () => {
      prisma.agentLearning.findMany.mockRejectedValue(new Error('boom'))
      expect(await makeAdapter(prisma).getLearnings({ projectId: 'p1' })).toEqual([])
      expect(errorSpy).toHaveBeenCalledWith('Failed to get learnings:', expect.any(Error))
    })
  })

  describe('caching and clearCache', () => {
    it('serves a repeat read from the cache when caching is enabled', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', name: 'Ada' })
      const adapter = makeAdapter(prisma, { enableCaching: true })

      const first = await adapter.getUserContext('u1')
      const second = await adapter.getUserContext('u1')

      expect(second).toBe(first)
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1)
    })

    it('hits the database every time when caching is not enabled', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', name: 'Ada' })
      const adapter = makeAdapter(prisma)

      await adapter.getUserContext('u1')
      await adapter.getUserContext('u1')
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2)
    })

    it('does not cache a missing entity', async () => {
      prisma.user.findUnique.mockResolvedValue(null)
      const adapter = makeAdapter(prisma, { enableCaching: true })

      await adapter.getUserContext('u1')
      await adapter.getUserContext('u1')
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2)
    })

    it('keeps separate cache entries per entity type and id', async () => {
      prisma.user.findUnique.mockImplementation(async ({ where }: any) => ({ id: where.id, name: where.id }))
      const adapter = makeAdapter(prisma, { enableCaching: true })

      expect((await adapter.getUserContext('a'))?.name).toBe('a')
      expect((await adapter.getUserContext('b'))?.name).toBe('b')
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2)
    })

    it('expires entries after the cache timeout', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', name: 'Ada' })
      const adapter = makeAdapter(prisma, { enableCaching: true, cacheTimeout: 1000 })

      await adapter.getUserContext('u1')
      vi.setSystemTime(new Date('2025-01-01T00:00:00.500Z'))
      await adapter.getUserContext('u1')
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1)

      vi.setSystemTime(new Date('2025-01-01T00:00:01.500Z'))
      await adapter.getUserContext('u1')
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2)
    })

    it('a cacheTimeout of 0 expires entries immediately instead of falling back to five minutes (CSL-5553)', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', name: 'Ada' })
      const adapter = makeAdapter(prisma, { enableCaching: true, cacheTimeout: 0 })

      await adapter.getUserContext('u1')
      vi.setSystemTime(new Date('2025-01-01T00:00:00.001Z'))
      await adapter.getUserContext('u1')
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2)
    })

    it('uses a five minute default timeout', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', name: 'Ada' })
      const adapter = makeAdapter(prisma, { enableCaching: true })

      await adapter.getUserContext('u1')
      vi.setSystemTime(new Date('2025-01-01T00:04:59Z'))
      await adapter.getUserContext('u1')
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1)

      vi.setSystemTime(new Date('2025-01-01T00:05:01Z'))
      await adapter.getUserContext('u1')
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2)
    })

    it('clearCache forces the next read back to the database', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', name: 'Ada' })
      const adapter = makeAdapter(prisma, { enableCaching: true })

      await adapter.getUserContext('u1')
      adapter.clearCache()
      await adapter.getUserContext('u1')
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2)
    })
  })
})
