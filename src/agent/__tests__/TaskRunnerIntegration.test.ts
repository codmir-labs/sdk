/**
 * TaskRunnerIntegration Test Suite
 * 
 * Tests for the enhanced task runner with autonomous capabilities
 */

import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals'
import { TaskRunnerIntegration } from '../integrations/TaskRunnerIntegration'
import type { EnhancedTask, TaskProgress, SubtaskDependency } from '../integrations/TaskRunnerIntegration'

// Mock fetch
global.fetch = jest.fn()

describe('TaskRunnerIntegration', () => {
  let taskRunner: TaskRunnerIntegration
  let mockFetch: jest.MockedFunction<typeof fetch>

  beforeEach(() => {
    mockFetch = global.fetch as jest.MockedFunction<typeof fetch>
    mockFetch.mockClear()

    taskRunner = new TaskRunnerIntegration({
      autonomyMode: 'balanced',
      confidenceThreshold: 0.7,
      learningEnabled: true,
      contextDepth: 'deep',
      planningHorizon: 'tactical',
      runnerUrl: 'http://localhost:8080',
      runnerToken: 'test-token',
      workspaceRoot: '/test/workspace'
    })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ready', version: '1.0.0' })
      } as Response)

      await taskRunner.initialize()
      
      expect(taskRunner.isInitialized()).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8080/health', expect.any(Object))
    })

    it('should throw error if runner is not accessible', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503
      } as Response)

      await expect(taskRunner.initialize()).rejects.toThrow('Task runner not accessible')
    })

    it('should set up event listeners', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ready' })
      } as Response)

      const eventSpy = jest.spyOn(taskRunner, 'on')
      
      await taskRunner.initialize()
      
      expect(eventSpy).toHaveBeenCalled()
    })
  })

  describe('task submission', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ready' })
      } as Response)
      await taskRunner.initialize()
    })

    it('should submit task with autonomous breakdown', async () => {
      const mockTask: EnhancedTask = {
        id: 'task-123',
        goal: 'Implement authentication system',
        status: 'submitted',
        submittedAt: new Date(),
        autonomousBreakdown: true,
        subtasks: [],
        dependencies: []
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockTask
      } as Response)

      const task = await taskRunner.submitTask({
        goal: 'Implement authentication system',
        enableAutonomousBreakdown: true
      })

      expect(task).toEqual(mockTask)
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/tasks',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token'
          }),
          body: expect.stringContaining('Implement authentication system')
        })
      )
    })

    it('should break down complex tasks into subtasks', async () => {
      const complexTask = {
        goal: 'Build a full-stack web application with user authentication, real-time chat, and payment processing'
      }

      const mockResponse: EnhancedTask = {
        id: 'task-456',
        goal: complexTask.goal,
        status: 'planning',
        submittedAt: new Date(),
        autonomousBreakdown: true,
        subtasks: [
          {
            id: 'subtask-1',
            title: 'Set up project structure',
            description: 'Initialize React app with TypeScript and configure build tools',
            status: 'pending',
            priority: 'high',
            estimatedEffort: 30,
            dependencies: []
          },
          {
            id: 'subtask-2',
            title: 'Implement user authentication',
            description: 'Create JWT-based auth system with login/register',
            status: 'pending',
            priority: 'high',
            estimatedEffort: 120,
            dependencies: ['subtask-1']
          },
          {
            id: 'subtask-3',
            title: 'Build real-time chat',
            description: 'WebSocket-based chat with message history',
            status: 'pending',
            priority: 'medium',
            estimatedEffort: 180,
            dependencies: ['subtask-2']
          }
        ],
        dependencies: []
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      } as Response)

      const task = await taskRunner.submitTask(complexTask)

      expect(task.subtasks).toHaveLength(3)
      expect(task.subtasks![0].dependencies).toEqual([])
      expect(task.subtasks![1].dependencies).toContain('subtask-1')
      expect(task.subtasks![2].dependencies).toContain('subtask-2')
    })

    it('should validate task dependencies', async () => {
      const taskWithCircularDeps = {
        goal: 'Test circular dependencies',
        subtasks: [
          {
            id: 'a',
            title: 'Task A',
            dependencies: ['b'] as string[]
          },
          {
            id: 'b',
            title: 'Task B', 
            dependencies: ['a'] as string[]
          }
        ]
      }

      await expect(
        taskRunner.submitTask(taskWithCircularDeps as any)
      ).rejects.toThrow('Circular dependency detected')
    })
  })

  describe('progress monitoring', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ready' })
      } as Response)
      await taskRunner.initialize()
    })

    it('should track progress across subtasks', async () => {
      const mockProgress: TaskProgress = {
        overall: 65,
        phase: 'executing',
        subtasksCompleted: 2,
        subtasksTotal: 3,
        currentSubtask: {
          id: 'subtask-3',
          title: 'Final implementation',
          progress: 30
        },
        insights: [
          'Authentication system implemented successfully',
          'Database schema optimized for performance'
        ],
        confidence: 0.85,
        estimatedTimeRemaining: 1800000 // 30 minutes
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockProgress
      } as Response)

      const progress = await taskRunner.getProgress('task-123')

      expect(progress).toEqual(mockProgress)
      expect(progress.overall).toBe(65)
      expect(progress.subtasksCompleted).toBe(2)
      expect(progress.confidence).toBe(0.85)
    })

    it('should emit progress events', async () => {
      const progressSpy = jest.fn()
      taskRunner.on('progress', progressSpy)

      // Simulate progress update
      taskRunner.emit('progress', {
        taskId: 'task-123',
        progress: {
          overall: 50,
          phase: 'executing',
          subtasksCompleted: 1,
          subtasksTotal: 3
        }
      })

      expect(progressSpy).toHaveBeenCalledWith({
        taskId: 'task-123',
        progress: expect.objectContaining({
          overall: 50,
          phase: 'executing'
        })
      })
    })

    it('should calculate accurate completion percentage', () => {
      const subtasks = [
        { id: '1', status: 'completed', estimatedEffort: 60 },
        { id: '2', status: 'completed', estimatedEffort: 30 },
        { id: '3', status: 'running', estimatedEffort: 40, progress: 50 },
        { id: '4', status: 'pending', estimatedEffort: 20 }
      ]

      const totalEffort = 150
      const completedEffort = 60 + 30 + (40 * 0.5) // 110
      const expectedPercentage = Math.round((completedEffort / totalEffort) * 100) // 73%

      const percentage = (taskRunner as any).calculateProgress(subtasks)
      
      expect(percentage).toBe(expectedPercentage)
    })
  })

  describe('error recovery', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ready' })
      } as Response)
      await taskRunner.initialize()
    })

    it('should implement intelligent retry strategies', async () => {
      const failedTask: EnhancedTask = {
        id: 'task-789',
        goal: 'Deploy application',
        status: 'failed',
        submittedAt: new Date(),
        error: 'Network timeout during deployment',
        recoveryAttempts: []
      }

      // Mock retry attempt
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...failedTask,
          status: 'retrying',
          recoveryAttempts: [
            {
              attemptNumber: 1,
              strategy: 'exponential_backoff',
              timestamp: new Date(),
              success: false,
              error: 'Network timeout during deployment'
            }
          ]
        })
      } as Response)

      const result = await taskRunner.retryTask('task-789')

      expect(result.status).toBe('retrying')
      expect(result.recoveryAttempts).toHaveLength(1)
      expect(result.recoveryAttempts![0].strategy).toBe('exponential_backoff')
    })

    it('should analyze error patterns for recovery strategies', () => {
      const errors = [
        'Network timeout',
        'Connection refused',
        'DNS resolution failed',
        'Service unavailable'
      ]

      const strategy = (taskRunner as any).selectRecoveryStrategy(errors)
      
      expect(strategy).toBe('network_retry')
    })

    it('should respect maximum retry limits', async () => {
      const taskWithManyAttempts: EnhancedTask = {
        id: 'task-retry',
        goal: 'Problematic task',
        status: 'failed',
        submittedAt: new Date(),
        recoveryAttempts: Array(5).fill(0).map((_, i) => ({
          attemptNumber: i + 1,
          strategy: 'basic_retry',
          timestamp: new Date(),
          success: false,
          error: 'Persistent error'
        }))
      }

      await expect(
        taskRunner.retryTask('task-retry')
      ).rejects.toThrow('Maximum retry attempts exceeded')
    })
  })

  describe('insights generation', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ready' })
      } as Response)
      await taskRunner.initialize()
    })

    it('should generate performance insights', () => {
      const mockTasks: EnhancedTask[] = [
        {
          id: 'task-1',
          goal: 'Build API',
          status: 'completed',
          submittedAt: new Date(Date.now() - 3600000),
          completedAt: new Date(),
          subtasks: [
            { id: 'sub-1', status: 'completed', estimatedEffort: 60, actualEffort: 45 }
          ]
        },
        {
          id: 'task-2', 
          goal: 'Add tests',
          status: 'completed',
          submittedAt: new Date(Date.now() - 1800000),
          completedAt: new Date(),
          subtasks: [
            { id: 'sub-2', status: 'completed', estimatedEffort: 30, actualEffort: 35 }
          ]
        }
      ]

      const insights = taskRunner.getInsights()

      expect(insights).toHaveProperty('totalTasks')
      expect(insights).toHaveProperty('averageSubtasks')
      expect(insights).toHaveProperty('performanceMetrics')
      expect(insights.performanceMetrics).toHaveProperty('successRate')
      expect(insights.performanceMetrics).toHaveProperty('averageConfidence')
    })

    it('should identify common failure patterns', () => {
      const failedTasks = [
        { error: 'Build failed: missing dependency' },
        { error: 'Build failed: syntax error' },
        { error: 'Network timeout' },
        { error: 'Build failed: missing dependency' }
      ]

      const insights = (taskRunner as any).analyzeFailures(failedTasks)
      
      expect(insights.commonFailureReasons).toContain('Build failures')
      expect(insights.recommendedImprovements).toContain('Dependency management')
    })

    it('should provide actionable recommendations', () => {
      const insights = taskRunner.getInsights()
      
      expect(insights).toHaveProperty('recommendedActions')
      expect(Array.isArray(insights.recommendedActions)).toBe(true)
    })
  })

  describe('task stopping and cleanup', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ready' })
      } as Response)
      await taskRunner.initialize()
    })

    it('should gracefully stop running tasks', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'stopped', message: 'Task stopped successfully' })
      } as Response)

      const result = await taskRunner.stopTask('task-123')

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/tasks/task-123/stop',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token'
          })
        })
      )
    })

    it('should handle stop failures gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404
      } as Response)

      const result = await taskRunner.stopTask('non-existent-task')

      expect(result).toBe(false)
    })
  })

  describe('configuration management', () => {
    it('should validate configuration on creation', () => {
      expect(() => {
        new TaskRunnerIntegration({
          autonomyMode: 'invalid' as any,
          confidenceThreshold: -0.5, // Invalid
          runnerUrl: 'http://localhost:8080'
        })
      }).toThrow('Invalid configuration')
    })

    it('should allow runtime configuration updates', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ready' })
      } as Response)

      await taskRunner.initialize()

      taskRunner.updateConfig({
        confidenceThreshold: 0.8,
        enableIntelligentRecovery: false
      })

      expect(taskRunner.getConfig().confidenceThreshold).toBe(0.8)
      expect(taskRunner.getConfig().enableIntelligentRecovery).toBe(false)
    })
  })

  describe('event handling', () => {
    it('should emit task lifecycle events', () => {
      const events = ['task:created', 'task:started', 'task:completed', 'task:failed']
      const eventSpy = jest.fn()

      events.forEach(event => {
        taskRunner.on(event, eventSpy)
      })

      // Simulate events
      events.forEach(event => {
        taskRunner.emit(event, { taskId: 'test-task', data: {} })
      })

      expect(eventSpy).toHaveBeenCalledTimes(4)
    })

    it('should handle event listener errors gracefully', () => {
      const errorHandler = jest.fn(() => {
        throw new Error('Event handler error')
      })

      taskRunner.on('test:event', errorHandler)

      expect(() => {
        taskRunner.emit('test:event', {})
      }).not.toThrow()
    })
  })
})
