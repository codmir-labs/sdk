/**
 * AgentEngine Test Suite
 *
 * Exercises the public API of AgentEngine with its real collaborators (ContextManager,
 * PlanningEngine, ActionExecutor, LearningSystem). Only the boundaries are faked:
 *   - the filesystem the LearningSystem persists to (HOME points at a throw-away directory),
 *   - the clock (the executors simulate work with setTimeout),
 *   - the network (global `fetch` throws, so an accidental call fails loudly).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentEngine } from '../core/AgentEngine'
import type { AgentConfig, Decision } from '../types'

// LearningSystem persists under os.homedir(). Worker threads do not pass process.env changes to libuv,
// so stubbing HOME is not enough: redirect homedir() itself to the per-test directory.
const fakeHome = vi.hoisted(() => ({ dir: undefined as string | undefined }))
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>()
  const homedir = () => {
    if (!fakeHome.dir) throw new Error('os.homedir() called outside a test with an isolated HOME')
    return fakeHome.dir
  }
  return { ...actual, homedir, default: { ...actual, homedir } }
})

const BUG_REPORT = 'There is a bug: login is broken, please fix it'
const BUILD_REQUEST = 'Please build and implement a new reporting dashboard with exports and permissions'
const GREETING = 'hello there'

function conversation(...contents: string[]) {
  return {
    type: 'conversation' as const,
    content: { messages: contents.map(content => ({ role: 'user', content })) }
  }
}

describe('AgentEngine', () => {
  let home: string
  let engines: AgentEngine[]
  let networkCalls: string[]

  /** Build an engine that is torn down after the test. */
  function make(config: Partial<AgentConfig> = {}) {
    const engine = new AgentEngine({ learningEnabled: false, ...config })
    engines.push(engine)
    return engine
  }

  /** Run processInput while the simulated-work timers are driven by the fake clock. */
  async function run(engine: AgentEngine, input: Parameters<AgentEngine['processInput']>[0]) {
    const promise = engine.processInput(input)
    // Attach a handler right away so a rejection is never reported as unhandled while timers are advanced
    promise.catch(() => {})
    await vi.runAllTimersAsync()
    return promise
  }

  /** Make the real ContextManager's context advertise the capabilities the engine's own actions require. */
  function grantCapabilities(engine: AgentEngine, ...names: string[]) {
    const contextManager = (engine as any).contextManager
    const real = contextManager.buildContext.bind(contextManager)
    vi.spyOn(contextManager, 'buildContext').mockImplementation(async (params: any) => {
      const ctx = await real(params)
      for (const name of names) {
        ctx.system.capabilities.push({ name, available: true, performance: 1, lastChecked: new Date().toISOString() })
      }
      return ctx
    })
  }

  /** Drop capabilities from the real ContextManager's system context, so the executor refuses on them. */
  function withholdCapabilities(engine: AgentEngine, ...names: string[]) {
    const contextManager = (engine as any).contextManager
    const real = contextManager.buildContext.bind(contextManager)
    vi.spyOn(contextManager, 'buildContext').mockImplementation(async (params: any) => {
      const ctx = await real(params)
      ctx.system.capabilities = ctx.system.capabilities.filter((c: any) => !names.includes(c.name))
      return ctx
    })
  }

  /** Make the real ContextManager's project context carry code issues. */
  function withProjectIssues(engine: AgentEngine, issues: any[]) {
    const contextManager = (engine as any).contextManager
    const real = contextManager.buildContext.bind(contextManager)
    vi.spyOn(contextManager, 'buildContext').mockImplementation(async (params: any) => {
      const ctx = await real(params)
      ctx.project.codebaseAnalysis.issues = issues
      return ctx
    })
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agent-engine-'))
    fakeHome.dir = home
    networkCalls = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        networkCalls.push(String(url))
        throw new Error(`unexpected network call: ${url}`)
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    engines = []
  })

  afterEach(async () => {
    expect(networkCalls).toEqual([])
    vi.useRealTimers()
    for (const engine of engines) engine.removeAllListeners()
    fakeHome.dir = undefined
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  describe('getCapabilities', () => {
    it('lists the base capabilities plus one per enabled feature', () => {
      expect(make({ learningEnabled: true }).getCapabilities()).toEqual([
        'conversation_intelligence',
        'decision_making',
        'action_execution',
        'codebase_analysis',
        'task_creation',
        'ticket_generation',
        'strategic_planning',
        'learning_system'
      ])
    })

    it('drops capabilities whose feature flag or learning is switched off', () => {
      const engine = make({
        learningEnabled: false,
        features: {
          conversationIntelligence: true,
          codebaseAnalysis: false,
          automaticTaskCreation: false,
          proactiveTicketGeneration: true,
          strategicPlanning: false,
          learningFromFailures: false
        }
      })
      expect(engine.getCapabilities()).toEqual([
        'conversation_intelligence',
        'decision_making',
        'action_execution',
        'ticket_generation'
      ])
    })
  })

  // -------------------------------------------------------------------------
  describe('initialize', () => {
    it('emits "initialized" with the session id, config and capabilities', async () => {
      const engine = make({ autonomyMode: 'aggressive' })
      const events: any[] = []
      engine.on('initialized', e => events.push(e))
      await engine.initialize()

      expect(events).toHaveLength(1)
      expect(events[0].sessionId).toMatch(/^[0-9a-f-]{36}$/)
      expect(events[0].config.autonomyMode).toBe('aggressive')
      expect(events[0].capabilities).toEqual(engine.getCapabilities())
    })

    it('is idempotent: a second call does not initialise again', async () => {
      const engine = make()
      const events: any[] = []
      engine.on('initialized', e => events.push(e))
      await engine.initialize()
      await engine.initialize()
      expect(events).toHaveLength(1)
    })

    it('creates the learning directory under HOME when learning is enabled', async () => {
      await make({ learningEnabled: true }).initialize()
      expect(existsSync(join(home, '.codmir', 'autonomus-sdk'))).toBe(true)
    })

    it('starts cleanly when there is no saved learning memory yet', async () => {
      await expect(make({ learningEnabled: true }).initialize()).resolves.toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  describe('processInput', () => {
    it('decides to create a ticket for a bug report and runs the action when capable', async () => {
      const engine = make()
      grantCapabilities(engine, 'ticket_creation')
      await engine.initialize()

      const result = await run(engine, conversation(BUG_REPORT))

      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0]).toMatchObject({
        question: 'Should I create a ticket for this issue?',
        chosen: 'create_ticket',
        confidence: 0.85,
        madeBy: 'agent_engine'
      })
      expect(result.actions).toHaveLength(1)
      const action = result.actions[0]
      expect(action).toMatchObject({ type: 'create_ticket', status: 'completed' })
      expect(action.result!.success).toBe(true)
      expect(action.result!.output.ticket).toMatchObject({ title: BUG_REPORT, status: 'open', priority: 'high' })
      expect(action.executedAt).toBeDefined()
      expect(result.confidence).toBeCloseTo(0.85)
    })

    it('builds the ticket from the last message and labels it from the conversation intent', async () => {
      const engine = make()
      grantCapabilities(engine, 'ticket_creation')
      await engine.initialize()

      const result = await run(engine, conversation('hi', BUG_REPORT))
      const data = result.actions[0].input.requiredData

      expect(data.title).toBe(BUG_REPORT)
      expect(data.description).toContain(`user: ${BUG_REPORT}`)
      expect(data.labels).toContain('bug')
    })

    it('makes no decisions and takes no action for a message with no ticket-worthy content', async () => {
      const engine = make()
      await engine.initialize()
      const result = await run(engine, conversation(GREETING))

      expect(result.decisions).toEqual([])
      expect(result.actions).toEqual([])
      expect(result.confidence).toBe(0)
    })

    it('also decides to create a development task for a complex build request', async () => {
      const engine = make()
      await engine.initialize()
      const result = await run(engine, conversation(BUILD_REQUEST))

      expect(result.decisions.map(d => d.chosen)).toEqual(expect.arrayContaining(['create_task']))
      const task = result.actions.find(a => a.type === 'create_task')!
      expect(task.input.requiredData.subtasks.length).toBeGreaterThan(1)
      expect(task.input.requiredData.estimatedHours).toBeGreaterThan(0)
    })

    it('emits context_built, decisions_made and processing_complete', async () => {
      const engine = make()
      await engine.initialize()
      const seen: string[] = []
      engine.on('context_built', () => seen.push('context_built'))
      engine.on('decisions_made', e => seen.push(`decisions_made:${e.decisions.length}/${e.totalConsidered}`))
      engine.on('processing_complete', e => seen.push(`processing_complete:${e.decisions.length}`))

      await run(engine, conversation(BUG_REPORT))
      expect(seen).toEqual(['context_built', 'decisions_made:1/1', 'processing_complete:1'])
    })

    it('emits decision_made for each decision it keeps (CSL-5552)', async () => {
      const engine = make()
      await engine.initialize()
      const seen: Decision[] = []
      engine.on('decision_made', d => seen.push(d))

      const result = await run(engine, conversation(BUG_REPORT))
      expect(result.decisions).toHaveLength(1)
      expect(seen).toEqual(result.decisions)
    })

    it('emits learning_generated for each learning it extracts (CSL-5552)', async () => {
      const engine = make({ learningEnabled: true })
      await engine.initialize()
      const extracted = [{ id: 'l1', description: 'a' }, { id: 'l2', description: 'b' }]
      vi.spyOn((engine as any).learningSystem, 'extractLearnings').mockResolvedValue(extracted)
      const seen: unknown[] = []
      engine.on('learning_generated', l => seen.push(l))

      const result = await run(engine, conversation(BUG_REPORT))
      expect(result.learnings).toEqual(extracted)
      expect(seen).toEqual(extracted)
    })

    it('emits no learning_generated when learning is disabled (CSL-5552)', async () => {
      const engine = make({ learningEnabled: false })
      await engine.initialize()
      const seen: unknown[] = []
      engine.on('learning_generated', l => seen.push(l))
      await run(engine, conversation(BUG_REPORT))
      expect(seen).toEqual([])
    })

    it('creates a strategic plan and tracks it as active', async () => {
      const engine = make()
      await engine.initialize()
      const result = await run(engine, conversation(BUG_REPORT))

      expect(result.plans).toHaveLength(1)
      expect(engine.getActivePlans()).toEqual([result.plans[0]])
    })

    it('skips the plan when the horizon is not strategic and the situation is simple', async () => {
      const engine = make({ planningHorizon: 'tactical' })
      await engine.initialize()
      const result = await run(engine, conversation(BUG_REPORT))

      expect(result.plans).toEqual([])
      expect(engine.getActivePlans()).toEqual([])
    })

    it('extracts and returns learnings when learning is enabled, none when disabled', async () => {
      const learning = make({ learningEnabled: true })
      await learning.initialize()
      const withLearning = await run(learning, conversation(BUG_REPORT))
      expect(Array.isArray(withLearning.learnings)).toBe(true)

      const noLearning = make({ learningEnabled: false })
      await noLearning.initialize()
      expect((await run(noLearning, conversation(BUG_REPORT))).learnings).toEqual([])
    })

    describe('confidence handling', () => {
      it('lowers decision confidence for low urgency and still passes a 0.7 threshold', async () => {
        const engine = make()
        await engine.initialize()
        const result = await run(engine, { ...conversation(BUG_REPORT), urgency: 'low' })
        expect(result.decisions[0].confidence).toBeCloseTo(0.75)
      })

      it('raises decision confidence for high and critical urgency, capped at 1', async () => {
        const engine = make()
        await engine.initialize()
        const high = await run(engine, { ...conversation(BUG_REPORT), urgency: 'high' })
        expect(high.decisions[0].confidence).toBeCloseTo(0.95)
        const critical = await run(engine, { ...conversation(BUG_REPORT), urgency: 'critical' })
        expect(critical.decisions[0].confidence).toBeCloseTo(1)
      })

      it('drops decisions below the confidence threshold', async () => {
        const engine = make({ confidenceThreshold: 0.9 })
        await engine.initialize()
        const events: any[] = []
        engine.on('decisions_made', e => events.push(e))
        const result = await run(engine, conversation(BUG_REPORT))

        expect(result.decisions).toEqual([])
        expect(events[0]).toMatchObject({ totalConsidered: 1, decisions: [] })
      })

      it('reads the "medium" level of an object threshold', async () => {
        const engine = make({ confidenceThreshold: { low: 0.1, medium: 0.95, high: 0.99 } })
        await engine.initialize()
        expect((await run(engine, conversation(BUG_REPORT))).decisions).toEqual([])

        const lenient = make({ confidenceThreshold: { low: 0.1, medium: 0.5, high: 0.99 } })
        await lenient.initialize()
        expect((await run(lenient, conversation(BUG_REPORT))).decisions).toHaveLength(1)
      })

      it('keeps below-threshold decisions when the input is critical', async () => {
        const engine = make({ confidenceThreshold: 0.99 })
        await engine.initialize()
        const result = await run(engine, { ...conversation(BUG_REPORT), urgency: 'critical' })
        expect(result.decisions).toHaveLength(1)
      })
    })

    describe('autonomy and approval', () => {
      it('executes autonomously only when the required capability is present', async () => {
        const engine = make()
        withholdCapabilities(engine, 'ticket_creation')
        await engine.initialize()
        const executed: any[] = []
        const failed: any[] = []
        engine.on('action_executed', e => executed.push(e))

        const result = await run(engine, conversation(BUG_REPORT))
        failed.push(...result.actions.filter(a => a.status === 'failed'))

        // the engine reaches the executor, which refuses on capability validation
        expect(executed).toHaveLength(1)
        expect(failed).toHaveLength(1)
        expect(result.actions[0].result!.output.error).toContain('Missing required capabilities: ticket_creation')
      })

      it('completes the ticket action it creates from a bug report (CSL-5546)', async () => {
        const engine = make()
        await engine.initialize()
        const result = await run(engine, conversation(BUG_REPORT))
        expect(result.actions[0].status).toBe('completed')
      })

      it('holds actions whose type needs human approval and emits approval_required', async () => {
        const engine = make({ humanApprovalRequired: ['create_ticket'] })
        grantCapabilities(engine, 'ticket_creation')
        await engine.initialize()
        const approvals: any[] = []
        const executed: any[] = []
        engine.on('approval_required', e => approvals.push(e))
        engine.on('action_executed', e => executed.push(e))

        const result = await run(engine, conversation(BUG_REPORT))

        expect(result.actions[0].status).toBe('pending_approval')
        expect(result.actions[0].result).toBeUndefined()
        expect(approvals).toHaveLength(1)
        expect(approvals[0].action).toBe(result.actions[0])
        expect(executed).toEqual([])
      })

      it('conservative mode holds an action below 0.9 confidence', async () => {
        const engine = make({ autonomyMode: 'conservative' })
        grantCapabilities(engine, 'ticket_creation')
        await engine.initialize()
        const result = await run(engine, conversation(BUG_REPORT))
        expect(result.actions[0].status).toBe('pending_approval')
      })

      it('conservative mode runs a ticket action at 0.9 confidence or more (high urgency)', async () => {
        const engine = make({ autonomyMode: 'conservative' })
        grantCapabilities(engine, 'ticket_creation')
        await engine.initialize()
        const result = await run(engine, { ...conversation(BUG_REPORT), urgency: 'high' })
        expect(result.actions[0].status).toBe('completed')
      })

      it('conservative mode never runs a non-ticket action, however confident', async () => {
        const engine = make({ autonomyMode: 'conservative' })
        grantCapabilities(engine, 'task_creation', 'project_planning')
        await engine.initialize()
        const result = await run(engine, { ...conversation(BUILD_REQUEST), urgency: 'critical' })
        const task = result.actions.find(a => a.type === 'create_task')!
        expect(task.status).toBe('pending_approval')
      })

      it('aggressive and autonomus modes run actions that conservative would hold', async () => {
        for (const autonomyMode of ['aggressive', 'autonomus'] as const) {
          const engine = make({ autonomyMode })
          grantCapabilities(engine, 'ticket_creation')
          await engine.initialize()
          const result = await run(engine, conversation(BUG_REPORT))
          expect(result.actions[0].status).toBe('completed')
        }
      })

      it('auto-assigns the ticket only in autonomus mode', async () => {
        const autonomus = make({ autonomyMode: 'autonomus' })
        await autonomus.initialize()
        expect((await run(autonomus, conversation(BUG_REPORT))).actions[0].parameters.autoAssign).toBe(true)

        const balanced = make({ autonomyMode: 'balanced' })
        await balanced.initialize()
        expect((await run(balanced, conversation(BUG_REPORT))).actions[0].parameters.autoAssign).toBe(false)
      })

      it('holds everything for an unknown autonomy mode', async () => {
        const engine = make({ autonomyMode: 'reckless' as any })
        grantCapabilities(engine, 'ticket_creation')
        await engine.initialize()
        const result = await run(engine, conversation(BUG_REPORT))
        expect(result.actions[0].status).toBe('pending_approval')
      })
    })

    describe('proactive project decisions', () => {
      const issue = (severity: string, type: string) => ({
        type,
        severity,
        file: `src/${type}.ts`,
        line: 12,
        description: `${type} problem`,
        suggestion: 'fix it'
      })

      it('creates a ticket action for each critical code issue and ignores the rest', async () => {
        const engine = make()
        grantCapabilities(engine, 'ticket_creation', 'code_analysis')
        withProjectIssues(engine, [issue('critical', 'security'), issue('minor', 'style'), issue('critical', 'performance')])
        await engine.initialize()

        const result = await run(engine, conversation(GREETING))

        expect(result.decisions.map(d => d.chosen)).toEqual(['create_issue_tickets'])
        expect(result.actions.map(a => a.title)).toEqual([
          'Create Ticket for security Issue',
          'Create Ticket for performance Issue'
        ])
        expect(result.actions[0].input.requiredData).toMatchObject({
          title: 'Fix security: security problem',
          priority: 'high',
          labels: ['bug', 'critical', 'security']
        })
        expect(result.actions[0].input.requiredData.description).toContain('File: src/security.ts')
        expect(result.actions.every(a => a.status === 'completed')).toBe(true)
      })

      it('makes no proactive decision when there are issues but none are critical', async () => {
        const engine = make()
        withProjectIssues(engine, [issue('minor', 'style')])
        await engine.initialize()
        expect((await run(engine, conversation(GREETING))).decisions).toEqual([])
      })
    })

    it('rejects and learns from the failure when context building throws', async () => {
      const engine = make({ learningEnabled: true })
      await engine.initialize()
      vi.spyOn((engine as any).contextManager, 'buildContext').mockRejectedValue(new Error('context exploded'))
      const learn = vi.spyOn((engine as any).learningSystem, 'learnFromFailure')

      await expect(run(engine, conversation(BUG_REPORT))).rejects.toThrow('context exploded')
      expect(learn).toHaveBeenCalledWith(expect.objectContaining({ error: 'context exploded' }))
    })

    it('rejects without recording a learning when learning is disabled', async () => {
      const engine = make({ learningEnabled: false })
      await engine.initialize()
      vi.spyOn((engine as any).contextManager, 'buildContext').mockRejectedValue(new Error('nope'))
      const learn = vi.spyOn((engine as any).learningSystem, 'learnFromFailure')

      await expect(run(engine, conversation(BUG_REPORT))).rejects.toThrow('nope')
      expect(learn).not.toHaveBeenCalled()
    })

    it('records a failed action when the executor throws, and emits action_failed', async () => {
      const engine = make({ autonomyMode: 'autonomus' })
      await engine.initialize()
      vi.spyOn((engine as any).actionExecutor, 'execute').mockRejectedValue(new Error('executor crashed'))
      const failures: any[] = []
      engine.on('action_failed', e => failures.push(e))

      const result = await run(engine, conversation(BUG_REPORT))

      expect(result.actions[0].status).toBe('failed')
      expect(result.actions[0].result).toMatchObject({ success: false, confidence: 0 })
      expect(result.actions[0].result!.learnings[0].whatHappened).toBe('Failed to execute action: executor crashed')
      expect(failures).toHaveLength(1)
      expect(failures[0].error.message).toBe('executor crashed')
    })
  })

  // -------------------------------------------------------------------------
  describe('makeAutonomousDecision', () => {
    it('returns the first decision with its confidence and reasoning', async () => {
      const engine = make()
      await engine.initialize()
      const promise = engine.makeAutonomousDecision({} as any, BUG_REPORT)
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result.success).toBe(true)
      expect(result.decision.chosen).toBe('create_ticket')
      expect(result.confidence).toBeGreaterThan(0)
      expect(result.reasoning).toBe(result.decision.reasoning)
    })

    it('reports failure when nothing could be decided', async () => {
      const engine = make()
      await engine.initialize()
      const promise = engine.makeAutonomousDecision({} as any, GREETING)
      await vi.runAllTimersAsync()

      expect(await promise).toEqual({
        success: false,
        decision: undefined,
        confidence: 0,
        reasoning: 'No decision could be made'
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('createExecutionPlan', () => {
    it('returns the generated plan', async () => {
      const engine = make()
      await engine.initialize()
      const promise = engine.createExecutionPlan(BUG_REPORT, {} as any)
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result.success).toBe(true)
      expect(result.plan).toBe(engine.getActivePlans()[0])
      expect(result.reasoning).toBe(result.plan.description)
    })

    it('reports failure when no plan is produced', async () => {
      const engine = make({ planningHorizon: 'tactical' })
      await engine.initialize()
      const promise = engine.createExecutionPlan(GREETING, {} as any)
      await vi.runAllTimersAsync()

      expect(await promise).toMatchObject({ success: false, plan: undefined, reasoning: 'No plan could be generated' })
    })
  })

  // -------------------------------------------------------------------------
  describe('getMetrics', () => {
    it('starts at zero', () => {
      expect(make().getMetrics()).toEqual({
        decisionsPerMinute: 0,
        actionsExecuted: 0,
        successRate: 0,
        averageConfidence: 0,
        learningEventsGenerated: 0
      })
    })

    it('counts actions and the share that completed', async () => {
      const engine = make()
      grantCapabilities(engine, 'ticket_creation')
      await engine.initialize()
      await run(engine, conversation(BUG_REPORT))

      const metrics = engine.getMetrics()
      expect(metrics.actionsExecuted).toBe(1)
      expect(metrics.successRate).toBe(1)
      expect(metrics.averageConfidence).toBeCloseTo(0.425)
    })

    it('reports a zero success rate when the only action failed', async () => {
      const engine = make()
      withholdCapabilities(engine, 'ticket_creation')
      await engine.initialize()
      await run(engine, conversation(BUG_REPORT))
      expect(engine.getMetrics()).toMatchObject({ actionsExecuted: 1, successRate: 0 })
    })

    it('returns a copy, so callers cannot change the engine metrics', async () => {
      const engine = make()
      const metrics = engine.getMetrics()
      metrics.actionsExecuted = 99
      expect(engine.getMetrics().actionsExecuted).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  describe('getRecentDecisions', () => {
    it('is empty before any input', () => {
      expect(make().getRecentDecisions()).toEqual([])
    })

    it('returns the last N decisions, oldest first', async () => {
      const engine = make()
      await engine.initialize()
      for (let i = 0; i < 3; i++) await run(engine, conversation(BUG_REPORT + ` #${i}`))

      const all = engine.getRecentDecisions()
      expect(all).toHaveLength(3)
      const lastTwo = engine.getRecentDecisions(2)
      expect(lastTwo.map((d: Decision) => d.id)).toEqual(all.slice(-2).map((d: Decision) => d.id))
    })

    it('trims the history to the latest 50 once it passes 100', async () => {
      const engine = make()
      await engine.initialize()
      for (let i = 0; i < 100; i++) await run(engine, conversation(BUG_REPORT + ` #${i}`))
      expect(engine.getRecentDecisions(1000)).toHaveLength(100)

      await run(engine, conversation(BUG_REPORT + ' #100'))
      expect(engine.getRecentDecisions(1000)).toHaveLength(50)
    })
  })

  // -------------------------------------------------------------------------
  describe('updateConfig', () => {
    it('emits config_updated with the merged config', () => {
      const engine = make({ autonomyMode: 'balanced' })
      const events: any[] = []
      engine.on('config_updated', c => events.push(c))
      engine.updateConfig({ autonomyMode: 'aggressive' })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ autonomyMode: 'aggressive', learningEnabled: false })
    })

    it('changes how later input is handled', async () => {
      const engine = make({ autonomyMode: 'conservative' })
      grantCapabilities(engine, 'ticket_creation')
      await engine.initialize()
      expect((await run(engine, conversation(BUG_REPORT))).actions[0].status).toBe('pending_approval')

      engine.updateConfig({ autonomyMode: 'aggressive' })
      expect((await run(engine, conversation(BUG_REPORT + ' again'))).actions[0].status).toBe('completed')
    })

    it('changes the reported capabilities when learning is switched on', () => {
      const engine = make({ learningEnabled: false })
      expect(engine.getCapabilities()).not.toContain('learning_system')
      engine.updateConfig({ learningEnabled: true })
      expect(engine.getCapabilities()).toContain('learning_system')
    })
  })

  // -------------------------------------------------------------------------
  describe('collaborator events', () => {
    it('re-emits learning_applied from the learning system', () => {
      const engine = make()
      const seen: any[] = []
      engine.on('learning_applied', l => seen.push(l))
      ;(engine as any).learningSystem.emit('learning_applied', { id: 'l1', description: 'd' })
      expect(seen).toEqual([{ id: 'l1', description: 'd' }])
    })

    it('re-emits action_completed from the action executor', () => {
      const engine = make()
      const seen: any[] = []
      engine.on('action_completed', a => seen.push(a))
      ;(engine as any).actionExecutor.emit('action_completed', { id: 'a1' })
      expect(seen).toEqual([{ id: 'a1' }])
    })
  })

  // -------------------------------------------------------------------------
  describe('cleanup', () => {
    it('persists learning memory under HOME and removes all listeners', async () => {
      const engine = make({ learningEnabled: true })
      await engine.initialize()
      engine.on('config_updated', () => {})

      await engine.cleanup()

      const file = join(home, '.codmir', 'autonomus-sdk', 'learning-memory.json')
      expect(existsSync(file)).toBe(true)
      expect(JSON.parse(readFileSync(file, 'utf-8'))).toHaveProperty('savedAt')
      expect(engine.listenerCount('config_updated')).toBe(0)
    })

    it('a new engine loads what the previous one saved', async () => {
      const first = make({ learningEnabled: true })
      await first.initialize()
      await run(first, conversation(BUG_REPORT))
      await first.cleanup()
      const saved = JSON.parse(readFileSync(join(home, '.codmir', 'autonomus-sdk', 'learning-memory.json'), 'utf-8'))

      const second = make({ learningEnabled: true })
      await second.initialize()
      expect(saved.learnings.length).toBeGreaterThan(0)
      const loaded = (second as any).learningSystem.learnings as Map<string, unknown>
      expect(loaded.size).toBe(saved.learnings.length)
    })

    it('writes nothing when learning is disabled', async () => {
      const engine = make({ learningEnabled: false })
      await engine.initialize()
      await engine.cleanup()
      expect(existsSync(join(home, '.codmir', 'autonomus-sdk', 'learning-memory.json'))).toBe(false)
    })
  })
})
