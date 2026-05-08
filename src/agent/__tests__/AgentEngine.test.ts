/**
 * AgentEngine Test Suite
 * 
 * Comprehensive tests for the core Agent SDK engine
 */

import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals'
import { AgentEngine } from '../core/AgentEngine'
import { EventEngine } from '../core/EventEngine'
import type { AgentConfig, Context, Decision, Action, ActionResult } from '../types'

// Mock dependencies
jest.mock('../core/EventEngine')
jest.mock('../intelligence/TaskIntelligence')
jest.mock('../intelligence/ConversationIntelligence')
jest.mock('../intelligence/CodeIntelligence')
jest.mock('../intelligence/PlanningIntelligence')

describe('AgentEngine', () => {
  let engine: AgentEngine
  let mockEventEngine: jest.Mocked<EventEngine>
  let mockConfig: AgentConfig

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks()
    
    // Setup mock config
    mockConfig = {
      autonomyMode: 'balanced',
      enableAutonomousActions: true,
      confidenceThreshold: {
        low: 0.6,
        medium: 0.75,
        high: 0.85
      },
      learningEnabled: true,
      contextDepth: 'deep',
      planningHorizon: 'tactical'
    }

    // Setup mock event engine
    mockEventEngine = {
      emit: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
      removeAllListeners: jest.fn(),
      getHistory: jest.fn().mockReturnValue([]),
      clearHistory: jest.fn()
    } as any

    // Create engine instance
    engine = new AgentEngine(mockConfig)
    
    // Inject mock event engine
    ;(engine as any).eventEngine = mockEventEngine
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('initialization', () => {
    it('should initialize with correct config', () => {
      expect(engine.getConfig()).toEqual(mockConfig)
    })

    it('should set up event listeners', async () => {
      await engine.initialize()
      expect(mockEventEngine.on).toHaveBeenCalledWith('decision_made', expect.any(Function))
      expect(mockEventEngine.on).toHaveBeenCalledWith('action_completed', expect.any(Function))
      expect(mockEventEngine.on).toHaveBeenCalledWith('learning_generated', expect.any(Function))
    })

    it('should initialize intelligence modules', async () => {
      await engine.initialize()
      expect(engine.isInitialized()).toBe(true)
    })
  })

  describe('decision making', () => {
    beforeEach(async () => {
      await engine.initialize()
    })

    it('should make decisions with context', async () => {
      const context: Context = {
        project: { id: 'test-project', name: 'Test Project' },
        conversation: { id: 'test-conv', messages: [] }
      }

      const decisionRequest = {
        question: 'Should we proceed with the implementation?',
        options: ['proceed', 'wait', 'abort'],
        factors: ['complexity', 'risk', 'resources']
      }

      const result = await engine.makeDecision(context, decisionRequest)

      expect(result).toHaveProperty('decision')
      expect(result.decision).toHaveProperty('id')
      expect(result.decision).toHaveProperty('question', decisionRequest.question)
      expect(result.decision).toHaveProperty('selectedOption')
      expect(result.decision).toHaveProperty('confidence')
      expect(result.decision).toHaveProperty('reasoning')
      expect(result.decision.selectedOption).toBeOneOf(decisionRequest.options)
      expect(result.decision.confidence).toBeGreaterThanOrEqual(0)
      expect(result.decision.confidence).toBeLessThanOrEqual(1)
    })

    it('should respect confidence thresholds', async () => {
      const context: Context = {
        project: { id: 'test-project', name: 'Test Project' }
      }

      const decisionRequest = {
        question: 'Test decision',
        options: ['option1', 'option2'],
        requireConfirmation: true,
        minConfidence: 0.8
      }

      const result = await engine.makeDecision(context, decisionRequest)
      
      if (result.decision.confidence < 0.8) {
        expect(result.decision.requiresConfirmation).toBe(true)
      }
    })

    it('should emit decision events', async () => {
      const context: Context = {
        project: { id: 'test-project', name: 'Test Project' }
      }

      await engine.makeDecision(context, {
        question: 'Test',
        options: ['yes', 'no']
      })

      expect(mockEventEngine.emit).toHaveBeenCalledWith('decision_made', expect.objectContaining({
        decision: expect.any(Object),
        context: expect.any(Object),
        timestamp: expect.any(String)
      }))
    })
  })

  describe('action execution', () => {
    beforeEach(async () => {
      await engine.initialize()
    })

    it('should execute actions with proper validation', async () => {
      const context: Context = {
        project: { id: 'test-project', name: 'Test Project' }
      }

      const action: Action = {
        id: 'test-action',
        type: 'code_analysis',
        payload: { files: ['test.ts'] },
        priority: 'medium',
        metadata: { source: 'test' }
      }

      const result = await engine.executeAction(context, action)

      expect(result).toHaveProperty('success')
      expect(result).toHaveProperty('result')
      expect(result).toHaveProperty('duration')
      expect(result).toHaveProperty('metadata')
      expect(typeof result.duration).toBe('number')
      expect(result.duration).toBeGreaterThan(0)
    })

    it('should handle action failures gracefully', async () => {
      const context: Context = {
        project: { id: 'test-project', name: 'Test Project' }
      }

      const invalidAction: Action = {
        id: 'invalid-action',
        type: 'invalid_type' as any,
        payload: {},
        priority: 'high'
      }

      const result = await engine.executeAction(context, invalidAction)

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error).toContain('Unsupported action type')
    })

    it('should respect autonomy mode settings', async () => {
      const restrictedEngine = new AgentEngine({
        ...mockConfig,
        autonomyMode: 'conservative',
        enableAutonomousActions: false
      })
      
      await restrictedEngine.initialize()
      
      const context: Context = {
        project: { id: 'test-project', name: 'Test Project' }
      }

      const action: Action = {
        id: 'autonomous-action',
        type: 'file_modification',
        payload: { file: 'test.ts', content: 'new content' },
        priority: 'high',
        requiresApproval: false
      }

      const result = await restrictedEngine.executeAction(context, action)

      expect(result.requiresApproval).toBe(true)
    })
  })

  describe('learning', () => {
    beforeEach(async () => {
      await engine.initialize()
    })

    it('should generate learnings from outcomes', async () => {
      const context: Context = {
        project: { id: 'test-project', name: 'Test Project' }
      }

      const outcome = {
        success: true,
        userSatisfaction: 'high' as const,
        actionTaken: 'code_generated',
        metrics: {
          executionTime: 5000,
          linesOfCode: 150,
          testsAdded: 5
        }
      }

      const learning = await engine.learn({ context, outcome })

      expect(learning).toHaveProperty('id')
      expect(learning).toHaveProperty('type')
      expect(learning).toHaveProperty('description')
      expect(learning).toHaveProperty('confidence')
      expect(learning).toHaveProperty('actionableInsights')
      expect(learning.confidence).toBeGreaterThan(0)
      expect(learning.confidence).toBeLessThanOrEqual(1)
      expect(Array.isArray(learning.actionableInsights)).toBe(true)
    })

    it('should not learn when learning is disabled', async () => {
      const noLearningEngine = new AgentEngine({
        ...mockConfig,
        learningEnabled: false
      })
      
      await noLearningEngine.initialize()

      const context: Context = {
        project: { id: 'test-project', name: 'Test Project' }
      }

      const outcome = {
        success: true,
        userSatisfaction: 'high' as const,
        actionTaken: 'test'
      }

      const learning = await noLearningEngine.learn({ context, outcome })

      expect(learning).toBeNull()
    })

    it('should emit learning events', async () => {
      const context: Context = {
        project: { id: 'test-project', name: 'Test Project' }
      }

      await engine.learn({
        context,
        outcome: { success: true, userSatisfaction: 'high', actionTaken: 'test' }
      })

      expect(mockEventEngine.emit).toHaveBeenCalledWith('learning_generated', expect.objectContaining({
        learning: expect.any(Object),
        context: expect.any(Object),
        timestamp: expect.any(String)
      }))
    })
  })

  describe('context analysis', () => {
    beforeEach(async () => {
      await engine.initialize()
    })

    it('should analyze context depth correctly', async () => {
      const shallowContext: Context = {
        project: { id: 'test-project', name: 'Test Project' }
      }

      const deepContext: Context = {
        project: { 
          id: 'test-project', 
          name: 'Test Project',
          description: 'A test project',
          settings: { language: 'typescript' }
        },
        user: { id: 'user-1', role: 'developer' },
        conversation: { 
          id: 'conv-1', 
          messages: [
            { id: '1', role: 'user', content: 'Hello', timestamp: new Date().toISOString() }
          ]
        },
        codebase: {
          files: [{ path: 'test.ts', content: 'test content' }],
          structure: { directories: ['src'], files: ['test.ts'] }
        }
      }

      const shallowAnalysis = await engine.analyzeContext(shallowContext)
      const deepAnalysis = await engine.analyzeContext(deepContext)

      expect(shallowAnalysis.depth).toBe('shallow')
      expect(deepAnalysis.depth).toBe('deep')
      expect(deepAnalysis.insights.length).toBeGreaterThan(shallowAnalysis.insights.length)
    })

    it('should provide actionable insights', async () => {
      const context: Context = {
        project: { id: 'test-project', name: 'Test Project' },
        conversation: {
          id: 'conv-1',
          messages: [
            { id: '1', role: 'user', content: 'Add authentication', timestamp: new Date().toISOString() },
            { id: '2', role: 'assistant', content: 'I will implement JWT auth', timestamp: new Date().toISOString() }
          ]
        }
      }

      const analysis = await engine.analyzeContext(context)

      expect(analysis).toHaveProperty('insights')
      expect(analysis).toHaveProperty('recommendations')
      expect(analysis).toHaveProperty('riskFactors')
      expect(Array.isArray(analysis.insights)).toBe(true)
      expect(Array.isArray(analysis.recommendations)).toBe(true)
      expect(Array.isArray(analysis.riskFactors)).toBe(true)
    })
  })

  describe('error handling', () => {
    beforeEach(async () => {
      await engine.initialize()
    })

    it('should handle initialization failures', async () => {
      const invalidConfig = {
        ...mockConfig,
        confidenceThreshold: {
          low: 1.5, // Invalid - should be <= 1.0
          medium: 0.75,
          high: 0.85
        }
      }

      const failingEngine = new AgentEngine(invalidConfig)
      
      await expect(failingEngine.initialize()).rejects.toThrow()
    })

    it('should validate context before operations', async () => {
      const invalidContext = {} as Context // Empty context

      await expect(
        engine.makeDecision(invalidContext, {
          question: 'test',
          options: ['yes', 'no']
        })
      ).rejects.toThrow('Invalid context')
    })

    it('should handle execution timeouts', async () => {
      const context: Context = {
        project: { id: 'test-project', name: 'Test Project' }
      }

      const timeoutAction: Action = {
        id: 'timeout-action',
        type: 'long_running_task',
        payload: { duration: 10000 }, // 10 seconds
        priority: 'high',
        timeout: 1000 // 1 second timeout
      }

      const result = await engine.executeAction(context, timeoutAction)

      expect(result.success).toBe(false)
      expect(result.error).toContain('timeout')
    })
  })

  describe('performance', () => {
    beforeEach(async () => {
      await engine.initialize()
    })

    it('should execute decisions within reasonable time', async () => {
      const context: Context = {
        project: { id: 'test-project', name: 'Test Project' }
      }

      const startTime = Date.now()
      
      await engine.makeDecision(context, {
        question: 'Performance test',
        options: ['fast', 'slow']
      })

      const executionTime = Date.now() - startTime
      expect(executionTime).toBeLessThan(5000) // Should complete within 5 seconds
    })

    it('should handle concurrent operations', async () => {
      const context: Context = {
        project: { id: 'test-project', name: 'Test Project' }
      }

      const operations = Array(10).fill(0).map((_, i) => 
        engine.makeDecision(context, {
          question: `Concurrent test ${i}`,
          options: ['yes', 'no']
        })
      )

      const results = await Promise.all(operations)
      
      expect(results).toHaveLength(10)
      results.forEach(result => {
        expect(result.decision).toBeDefined()
        expect(result.decision.confidence).toBeGreaterThan(0)
      })
    })
  })

  describe('configuration', () => {
    it('should validate configuration on creation', () => {
      expect(() => {
        new AgentEngine({
          autonomyMode: 'invalid' as any,
          enableAutonomousActions: true,
          confidenceThreshold: {
            low: 0.6,
            medium: 0.75,
            high: 0.85
          }
        })
      }).toThrow('Invalid autonomy mode')
    })

    it('should allow configuration updates', async () => {
      await engine.initialize()

      const newConfig = {
        ...mockConfig,
        autonomyMode: 'aggressive' as const
      }

      engine.updateConfig(newConfig)
      
      expect(engine.getConfig().autonomyMode).toBe('aggressive')
    })

    it('should maintain consistency after config updates', async () => {
      await engine.initialize()

      engine.updateConfig({
        ...mockConfig,
        confidenceThreshold: {
          low: 0.5,
          medium: 0.7,
          high: 0.9
        }
      })

      const context: Context = {
        project: { id: 'test-project', name: 'Test Project' }
      }

      const result = await engine.makeDecision(context, {
        question: 'Config test',
        options: ['yes', 'no'],
        minConfidence: 0.8
      })

      expect(result.decision.confidence).toBeDefined()
    })
  })
})
