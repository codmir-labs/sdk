/**
 * TaskRunnerIntegration Test Suite
 *
 * Drives the public API of TaskRunnerIntegration. The collaborating agents (TaskAgent,
 * PlannerAgent, ...) are the real modules. The external boundaries are faked:
 *   - the task runner HTTP API, by stubbing global `fetch` (the real TaskRunnerHttpClient
 *     and its SSE parser run on top of it; any request nobody scripted fails the test),
 *   - the clock, where a test needs predictable generated ids.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TaskRunnerIntegration } from '../integrations/TaskRunnerIntegration'
import type { EnhancedTask, TaskRunnerConfig } from '../integrations/TaskRunnerIntegration'
import { eventEngine } from '../core/EventEngine'

// The integration imports the runner client through the package's public subpath, which resolves
// to dist/ (not built when the tests run). Point that specifier at the real source module.
vi.mock('@codmir/sdk/runtime/protocol', async () => await import('../../runtime/protocol'))

// ---------------------------------------------------------------------------
// Fake runner HTTP API (global fetch)
// ---------------------------------------------------------------------------

type RunnerEvents = Array<Record<string, unknown>>

interface RunnerRequest {
  method: string
  path: string
  headers: Record<string, string>
  body?: any
}

class FakeRunner {
  requests: RunnerRequest[] = []
  unexpected: string[] = []
  created: Array<{ taskId: string; goal: string; body: any }> = []
  private counter = 0

  /** Decide the SSE events for a created task. Default: completes immediately. */
  eventsFor: (created: { taskId: string; goal: string }) => RunnerEvents | Error = () => [
    { type: 'state_change', payload: { state: 'completed', result: { ok: true } } }
  ]
  /** Make POST /v1/tasks fail with this HTTP status / network error. */
  createFailure?: (goal: string, attempt: number) => { status: number; text: string } | Error | undefined

  fetch = vi.fn(async (input: any, init: any = {}): Promise<Response> => {
    const url = new URL(String(input))
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    this.requests.push({ method, path: url.pathname, headers: init.headers || {}, body })

    if (method === 'POST' && url.pathname === '/v1/tasks') {
      const failure = this.createFailure?.(body.goal, this.requests.filter(r => r.method === 'POST').length)
      if (failure instanceof Error) throw failure
      if (failure) return new Response(failure.text, { status: failure.status })
      const taskId = `run-${++this.counter}`
      this.created.push({ taskId, goal: body.goal, body })
      return json({ taskId, state: 'queued', executionTarget: 'local_runner' })
    }

    const events = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/events$/)
    if (method === 'GET' && events) {
      const created = this.created.find(c => c.taskId === events[1])
      if (!created) return new Response('unknown task', { status: 404 })
      const result = this.eventsFor(created)
      if (result instanceof Error) throw result
      const text = result.map(e => `event: message\ndata: ${JSON.stringify(e)}\n\n`).join('')
      return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }

    this.unexpected.push(`${method} ${url.pathname}`)
    throw new Error(`unexpected fetch: ${method} ${url}`)
  })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const completed = (result: unknown = { ok: true }) => ({ type: 'state_change', payload: { state: 'completed', result } })
const failed = (error?: string) => ({ type: 'state_change', payload: { state: 'failed', error } })

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2025-01-01T00:00:00.000Z')
const SUBTASK_ID = (i: number) => `subtask_${FIXED_NOW.getTime()}_${i}`

function makeIntegration(overrides: Partial<TaskRunnerConfig> = {}) {
  return new TaskRunnerIntegration({
    runnerUrl: 'http://runner.test/',
    runnerToken: 'tok-123',
    workspaceRoot: '/work/root',
    ...overrides
  } as TaskRunnerConfig)
}

/** Make the real TaskAgent return a given breakdown (the real one cannot be fed a project, see bug test below). */
function stubBreakdown(integration: TaskRunnerIntegration, subtasks: any[]) {
  return vi
    .spyOn((integration as any).taskAgent, 'breakdownTask')
    .mockResolvedValue({ success: true, breakdown: { subtasks }, confidence: 0.9 })
}

/** Make the breakdown decline, so the task is submitted whole (the real TaskAgent now breaks everything down). */
function stubBreakdownDeclined(integration: TaskRunnerIntegration) {
  return vi
    .spyOn((integration as any).taskAgent, 'breakdownTask')
    .mockResolvedValue({ success: false, reason: 'declined', confidence: 0 })
}

describe('TaskRunnerIntegration', () => {
  let runner: FakeRunner
  let integration: TaskRunnerIntegration
  let emitted: Array<{ event: string; payload: any }>

  function record(i: TaskRunnerIntegration) {
    for (const event of ['task:failed', 'task:cancelled', 'subtask:progress', 'decision:made', 'learning:generated', 'event']) {
      i.on(event, payload => emitted.push({ event, payload }))
    }
  }

  beforeEach(() => {
    runner = new FakeRunner()
    emitted = []
    vi.stubGlobal('fetch', runner.fetch)
    // The agents narrate with emoji logs; keep test output readable.
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    integration = makeIntegration()
    record(integration)
  })

  afterEach(() => {
    expect(runner.unexpected).toEqual([])
    // initialize() subscribes to the process-wide EventEngine and never unsubscribes; do not let tests pile up listeners
    eventEngine.removeAllListeners('task:*')
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  describe('initialize', () => {
    it('resolves once every collaborator is initialised', async () => {
      await expect(integration.initialize()).resolves.toBeUndefined()
    })

    it('forwards engine decisions and learnings as decision:made / learning:generated', async () => {
      await integration.initialize()
      const engine = (integration as any).engine
      engine.emit('decision_made', { id: 'd1' })
      engine.emit('learning_generated', { id: 'l1' })

      expect(emitted).toEqual([
        { event: 'decision:made', payload: { id: 'd1' } },
        { event: 'learning:generated', payload: { id: 'l1' } }
      ])
    })

    it('does not forward engine events before initialize has run', () => {
      ;(integration as any).engine.emit('decision_made', { id: 'd1' })
      expect(emitted).toEqual([])
    })

    // Fixed (CSL-5539), was: setupEventHandlers subscribes to the literal event name
    // 'task:*', but EventEngine emits 'task:started', 'task:progress', ... and the literal '*'.
    // EventEmitter has no wildcard support, so the integration's 'event' is never emitted.
    it('re-emits EventEngine task events as "event" (BUG: listens on literal "task:*")', async () => {
      await integration.initialize()
      // Count this integration's own events: integrations from earlier tests stay subscribed to the
      // shared eventEngine and push into the current `emitted`, so it cannot be asserted on directly.
      const seen: unknown[] = []
      integration.on('event', e => seen.push(e))
      const event = { type: 'task', subtype: 'started', taskId: 't1' }
      eventEngine.emit('task:started', event)
      expect(seen).toEqual([event])
    })
  })

  // -------------------------------------------------------------------------
  describe('submitTask (direct runner submission)', () => {
    beforeEach(async () => {
      await integration.initialize()
    })

    it('creates the task on the runner with the goal, defaults and bearer token', async () => {
      const task = await integration.submitTask({
        goal: 'Fix the login bug',
        projectId: 'proj-1',
        requiredCapabilities: ['git'],
        metadata: { source: 'test' }
      })

      expect(runner.requests[0]).toMatchObject({
        method: 'POST',
        path: '/v1/tasks',
        headers: { Authorization: 'Bearer tok-123', 'Content-Type': 'application/json' }
      })
      expect(runner.created[0].body).toMatchObject({
        goal: 'Fix the login bug',
        projectId: 'proj-1',
        workspace: '/work/root',
        executionTarget: 'auto',
        requiredCapabilities: ['git']
      })
      expect(task.id).toMatch(/^task_\d+_[a-z0-9]+$/)
      expect(task.workspace).toBe('/work/root')
      expect(task.metadata).toMatchObject({ source: 'test', runnerTaskId: 'run-1' })
    })

    it('uses an explicit workspace and execution target instead of the defaults', async () => {
      await integration.submitTask({ goal: 'g', workspace: '/other', executionTarget: 'remote_worker' })
      expect(runner.created[0].body).toMatchObject({ workspace: '/other', executionTarget: 'remote_worker' })
    })

    it('omits the Authorization header when no runner token is configured', async () => {
      const noToken = makeIntegration({ runnerToken: undefined })
      await noToken.initialize()
      await noToken.submitTask({ goal: 'g' })
      expect(runner.requests[0].headers.Authorization).toBeUndefined()
    })

    it('starts the task in the initializing phase with empty progress and registers it', async () => {
      const task = await integration.submitTask({ goal: 'g' })

      expect(task.progress).toEqual({
        overall: 0,
        phase: 'initializing',
        subtasksCompleted: 0,
        subtasksTotal: 0,
        insights: [],
        confidence: 0
      })
      expect(integration.getTask(task.id)).toBe(task)
      expect(integration.getActiveTasks()).toEqual([task])
    })

    it('gives every submission a distinct id', async () => {
      const a = await integration.submitTask({ goal: 'a' })
      const b = await integration.submitTask({ goal: 'b' })
      expect(a.id).not.toBe(b.id)
      expect(integration.getActiveTasks()).toHaveLength(2)
    })

    it('announces the task on the EventEngine', async () => {
      const spy = vi.spyOn(eventEngine, 'emitEvent')
      const task = await integration.submitTask({ goal: 'announce me', metadata: { k: 'v' } })

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task',
          subtype: 'started',
          taskId: task.id,
          description: 'announce me',
          data: { k: 'v' }
        })
      )
    })

    it('streams the runner events for the created task id', async () => {
      await integration.submitTask({ goal: 'g' })
      expect(runner.requests.map(r => `${r.method} ${r.path}`)).toEqual(['POST /v1/tasks', 'GET /v1/tasks/run-1/events'])
    })

    it('rejects with the runner error message when the task fails', async () => {
      runner.eventsFor = () => [failed('compile error')]
      await expect(integration.submitTask({ goal: 'g' })).rejects.toThrow('compile error')
    })

    it('rejects with a generic message when the runner fails without an error text', async () => {
      runner.eventsFor = () => [failed()]
      await expect(integration.submitTask({ goal: 'g' })).rejects.toThrow('Task failed')
    })

    it('rejects with the HTTP status and body when the runner refuses the task', async () => {
      runner.createFailure = () => ({ status: 503, text: 'overloaded' })
      await expect(integration.submitTask({ goal: 'g' })).rejects.toThrow(
        'Runner HTTP 503 (POST /v1/tasks): overloaded'
      )
    })

    it('emits subtask:progress for progress events and keeps reading until completion', async () => {
      runner.eventsFor = () => [
        { type: 'progress', payload: { pct: 10 } },
        { type: 'progress', payload: { pct: 60 } },
        completed()
      ]
      await integration.submitTask({ goal: 'g' })

      const progress = emitted.filter(e => e.event === 'subtask:progress')
      expect(progress.map(p => p.payload.event.payload.pct)).toEqual([10, 60])
      expect(progress[0].payload.subtask.title).toBe('g')
    })

    it('ignores state changes that are not terminal', async () => {
      runner.eventsFor = () => [
        { type: 'state_change', payload: { state: 'running' } },
        { type: 'state_change', payload: { state: 'awaiting_approval' } },
        completed()
      ]
      await expect(integration.submitTask({ goal: 'g' })).resolves.toBeDefined()
    })

    // Fixed (CSL-5544), was: monitorRunnerTask just leaves its for-await loop when the SSE
    // stream ends. A stream that closes before any terminal state_change is treated as success
    // instead of an error, so a dropped connection reads as a finished task.
    it('rejects when the event stream ends without a terminal state (BUG: treated as success)', async () => {
      runner.eventsFor = () => [{ type: 'state_change', payload: { state: 'running' } }]
      await expect(integration.submitTask({ goal: 'g' })).rejects.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  describe('submitTask (autonomous breakdown)', () => {
    let auto: TaskRunnerIntegration

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(FIXED_NOW)
      auto = makeIntegration({ enableAutonomousBreakdown: true })
      record(auto)
      await auto.initialize()
    })

    it('produces subtasks from the real TaskAgent (CSL-5540)', async () => {
      const task = await auto.submitTask({ goal: 'Build the thing', projectId: 'proj-1' })
      expect(task.subtasks!.length).toBeGreaterThan(0)
    })

    it('TaskAgent breaks a task down when the context has no project at all', async () => {
      const agent = (auto as any).taskAgent
      const context = { conversation: { entities: [] }, system: { capabilities: [] } }
      const result = await agent.breakdownTask({ taskId: 't1', context })
      expect(result.success).toBe(true)
      expect(result.breakdown.subtasks.length).toBeGreaterThan(0)
    })

    it('stores the strategic plan produced by the PlannerAgent on the task', async () => {
      const task = await auto.submitTask({ goal: 'Plan me' })
      expect(task.plan).toBeDefined()
      expect((task.plan as any).objective).toMatchObject({ description: 'Plan me', type: 'delivery', priority: 'high' })
    })

    it('records no execution decisions when the engine reaches none', async () => {
      const task = await auto.submitTask({ goal: 'g' })
      expect(task.decisions).toEqual([])
    })

    it('stores the decision the engine reaches', async () => {
      const decision = { id: 'dec-1', question: 'parallel?', choice: 'parallel' }
      vi.spyOn((auto as any).engine, 'makeAutonomousDecision').mockResolvedValue({ success: true, decision })
      const task = await auto.submitTask({ goal: 'g' })
      expect(task.decisions).toEqual([decision])
    })

    it('runs the subtasks through the runner and completes the task', async () => {
      stubBreakdown(auto, [
        { title: 'Write code', description: 'impl' },
        { title: 'Write tests', description: 'cover' }
      ])
      const spy = vi.spyOn(eventEngine, 'emitEvent')
      const task = await auto.submitTask({ goal: 'Feature', projectId: 'p1', metadata: { m: 1 } })

      expect(task.subtasks!.map(s => [s.title, s.status])).toEqual([
        ['Write code', 'completed'],
        ['Write tests', 'completed']
      ])
      expect(task.subtasks![0].id).toBe(SUBTASK_ID(0))
      expect(runner.created.map(c => c.goal).sort()).toEqual(['Write code: impl', 'Write tests: cover'])
      expect(runner.created[0].body).toMatchObject({
        projectId: 'p1',
        workspace: '/work/root',
        metadata: { m: 1, parentTaskId: task.id, subtaskId: expect.stringMatching(/^subtask_/) }
      })
      expect(task.progress).toMatchObject({
        phase: 'completed',
        overall: 100,
        subtasksTotal: 2,
        subtasksCompleted: 2,
        confidence: 1
      })
      expect(spy.mock.calls.map(c => (c[0] as any).subtype)).toEqual(['started', 'progress', 'completed'])
      expect(spy.mock.calls[2][0]).toMatchObject({ taskId: task.id, summary: 'Task completed: Feature' })
    })

    it('records the runner result on a completed subtask path via the event stream', async () => {
      stubBreakdown(auto, [{ title: 'Only', description: 'one' }])
      runner.eventsFor = () => [completed({ files: 3 })]
      const task = await auto.submitTask({ goal: 'g' })
      expect(task.subtasks![0].status).toBe('completed')
      expect(task.subtasks![0].actualEffort).toBe(0)
    })

    it('runs dependent subtasks only after the ones they depend on have finished', async () => {
      stubBreakdown(auto, [
        { title: 'A', description: 'first' },
        { title: 'C', description: 'third', dependencies: [SUBTASK_ID(2)] },
        { title: 'B', description: 'second', dependencies: [SUBTASK_ID(0)] }
      ])
      await auto.submitTask({ goal: 'g' })

      // A first, then B (depends on A), then C (depends on B)
      expect(runner.created.map(c => c.goal)).toEqual(['A: first', 'B: second', 'C: third'])
    })

    it('reports progress after each dependency group', async () => {
      stubBreakdown(auto, [
        { title: 'A', description: 'a' },
        { title: 'B', description: 'b', dependencies: [SUBTASK_ID(0)] }
      ])
      const spy = vi.spyOn(eventEngine, 'emitEvent')
      await auto.submitTask({ goal: 'g' })

      const progress = spy.mock.calls.map(c => c[0] as any).filter(e => e.subtype === 'progress')
      expect(progress.map(p => p.summary)).toEqual(['Completed 1/2 subtasks', 'Completed 2/2 subtasks'])
    })

    it('leaves subtasks whose dependencies can never be met unexecuted', async () => {
      stubBreakdown(auto, [
        { title: 'Runs', description: 'ok' },
        { title: 'Stuck', description: 'never', dependencies: ['subtask_does_not_exist'] }
      ])
      const task = await auto.submitTask({ goal: 'g' })

      expect(runner.created.map(c => c.goal)).toEqual(['Runs: ok'])
      expect(task.subtasks!.map(s => s.status)).toEqual(['completed', 'pending'])
    })

    it('marks a failed subtask with the runner error and counts only the successes', async () => {
      stubBreakdown(auto, [
        { title: 'Good', description: 'ok' },
        { title: 'Bad', description: 'boom' }
      ])
      runner.eventsFor = c => (c.goal.startsWith('Bad') ? [failed('disk full')] : [completed()])
      const task = await auto.submitTask({ goal: 'g' })

      expect(task.subtasks![0].status).toBe('completed')
      expect(task.subtasks![1]).toMatchObject({ status: 'failed', error: 'disk full' })
      expect(task.progress!.subtasksCompleted).toBe(1)
      expect(task.progress!.confidence).toBe(0.5)
      expect(task.progress!.insights).toEqual(
        expect.arrayContaining(['✅ 1 subtasks completed successfully', '⚠️ 1 subtasks failed and may need recovery'])
      )
    })

    // Fixed (CSL-5541), was: after the groups run, executeSubtasks unconditionally sets
    // phase = 'completed' and overall = 100, even when subtasks failed and no recovery is enabled.
    it('does not report a task completed while one of its subtasks failed (BUG: always completed)', async () => {
      stubBreakdown(auto, [{ title: 'Bad', description: 'boom' }])
      runner.eventsFor = () => [failed('nope')]
      const task = await auto.submitTask({ goal: 'g' })
      expect(task.progress!.phase).not.toBe('completed')
    })

    it('reports a common failure pattern when several subtasks fail for the same reason', async () => {
      stubBreakdown(auto, [
        { title: 'A', description: 'a' },
        { title: 'B', description: 'b' },
        { title: 'C', description: 'c' }
      ])
      runner.eventsFor = () => [failed('out of quota')]
      const task = await auto.submitTask({ goal: 'g' })

      expect(task.progress!.insights).toContain('🔍 Common failure pattern: out of quota')
      expect(task.progress!.insights).toContain('⚠️ Low success rate - consider adjusting approach')
    })

    it('does not report a common pattern when every failure has a different reason', async () => {
      stubBreakdown(auto, [
        { title: 'A', description: 'a' },
        { title: 'B', description: 'b' }
      ])
      runner.eventsFor = c => [failed(`reason for ${c.goal}`)]
      const task = await auto.submitTask({ goal: 'g' })
      expect(task.progress!.insights.some(i => i.startsWith('🔍'))).toBe(false)
    })

    it('says execution is on track when nearly everything succeeds', async () => {
      stubBreakdown(auto, [{ title: 'A', description: 'a' }])
      const task = await auto.submitTask({ goal: 'g' })
      expect(task.progress!.insights).toContain('🎯 High success rate - execution on track')
    })

    it('estimates the time remaining from the completed subtasks', async () => {
      stubBreakdown(auto, [
        { title: 'A', description: 'a' },
        { title: 'B', description: 'b', dependencies: [SUBTASK_ID(0)] }
      ])
      // Each runner call takes 1s of wall clock
      runner.eventsFor = () => {
        vi.setSystemTime(Date.now() + 1000)
        return [completed()]
      }
      const task = await auto.submitTask({ goal: 'g' })

      expect(task.progress!.insights).toContain('⏱️ Estimated time remaining: 1s')
      expect(task.progress!.estimatedTimeRemaining).toBe(0)
    })

    describe('error recovery', () => {
      let recovering: TaskRunnerIntegration

      beforeEach(async () => {
        recovering = makeIntegration({ enableAutonomousBreakdown: true, enableIntelligentRecovery: true, maxRetries: 3 })
        record(recovering)
        await recovering.initialize()
        // these cases exercise whole-task submission, so the breakdown must decline
        stubBreakdownDeclined(auto)
        stubBreakdownDeclined(recovering)
      })

      it('without recovery, a runner failure on a whole-task submission emits task:failed', async () => {
        runner.createFailure = () => ({ status: 500, text: 'down' })
        const task = await auto.submitTask({ goal: 'g' })

        expect(task.progress!.phase).toBe('failed')
        const failure = emitted.find(e => e.event === 'task:failed')!
        expect(failure.payload.task).toBe(task)
        expect(failure.payload.error.message).toContain('Runner HTTP 500')
        expect(task.recoveryAttempts).toBeUndefined()
      })

      it('retries up to maxRetries, then fails the task with the attempts attached', async () => {
        runner.createFailure = () => ({ status: 500, text: 'down' })
        const task = await recovering.submitTask({ goal: 'g' })

        expect(task.recoveryAttempts!.map(a => a.attemptNumber)).toEqual([1, 2, 3])
        expect(task.progress!.phase).toBe('failed')
        const failures = emitted.filter(e => e.event === 'task:failed')
        expect(failures).toHaveLength(1)
        expect(failures[0].payload.attempts).toHaveLength(3)
        // initial try + 3 recovery retries
        expect(runner.requests.filter(r => r.method === 'POST')).toHaveLength(4)
      })

      it('defaults to three retries when maxRetries is not configured', async () => {
        const dflt = makeIntegration({ enableAutonomousBreakdown: true, enableIntelligentRecovery: true })
        await dflt.initialize()
        stubBreakdownDeclined(dflt)
        runner.createFailure = () => ({ status: 500, text: 'down' })
        const task = await dflt.submitTask({ goal: 'g' })
        expect(task.recoveryAttempts).toHaveLength(3)
      })

      it('uses the configured maxRetries', async () => {
        const once = makeIntegration({ enableAutonomousBreakdown: true, enableIntelligentRecovery: true, maxRetries: 1 })
        await once.initialize()
        stubBreakdownDeclined(once)
        runner.createFailure = () => ({ status: 500, text: 'down' })
        const task = await once.submitTask({ goal: 'g' })
        expect(task.recoveryAttempts).toHaveLength(1)
      })

      it('doubles the timeout once for a timeout error, then falls back to simplify_retry', async () => {
        runner.createFailure = () => new Error('request timeout')
        const task = await recovering.submitTask({ goal: 'g', metadata: { timeout: 5000 } })

        expect(task.recoveryAttempts!.map(a => a.strategy)).toEqual(['increase_timeout', 'simplify_retry', 'simplify_retry'])
        expect(task.recoveryAttempts![0].modifications).toMatchObject({ timeout: 10000, reduceComplexity: true })
        expect(task.metadata!.timeout).toBe(10000)
      })

      it('defaults the doubled timeout from 30s when the task has none', async () => {
        runner.createFailure = () => new Error('deadline exceeded')
        const task = await recovering.submitTask({ goal: 'g' })
        expect(task.recoveryAttempts![0]).toMatchObject({ strategy: 'increase_timeout' })
        expect(task.recoveryAttempts![0].modifications.timeout).toBe(60000)
      })

      it('adds elevated_access and pins the local runner for a permission error', async () => {
        runner.createFailure = () => new Error('permission denied')
        const task = await recovering.submitTask({ goal: 'g', requiredCapabilities: ['git'] })

        expect(task.recoveryAttempts![0].strategy).toBe('adjust_permissions')
        expect(task.requiredCapabilities).toEqual(['git', 'elevated_access'])
        expect(task.executionTarget).toBe('local_runner')
        // the retry carries the adjusted request
        const retry = runner.requests.filter(r => r.method === 'POST')[1]
        expect(retry.body).toMatchObject({ requiredCapabilities: ['git', 'elevated_access'], executionTarget: 'local_runner' })
      })

      it('chooses reduce_scope for a memory/resource error', async () => {
        runner.createFailure = () => new Error('out of memory')
        const task = await recovering.submitTask({ goal: 'g' })
        expect(task.recoveryAttempts![0]).toMatchObject({
          strategy: 'reduce_scope',
          modifications: { breakdownFurther: true, parallelism: 1, resourceLimits: { memory: '512Mi', cpu: '0.5' } }
        })
      })

      it('chooses simplify_retry for an unrecognised error', async () => {
        runner.createFailure = () => new Error('something odd')
        const task = await recovering.submitTask({ goal: 'g' })
        expect(task.recoveryAttempts![0]).toMatchObject({
          strategy: 'simplify_retry',
          modifications: { simplifyGoal: true, addContext: true, increaseLogging: true }
        })
      })

      it('recovers when a later attempt succeeds', async () => {
        runner.createFailure = (_g, n) => (n === 1 ? { status: 500, text: 'blip' } : undefined)
        const task = await recovering.submitTask({ goal: 'g' })

        expect(task.recoveryAttempts).toHaveLength(1)
        expect(emitted.some(e => e.event === 'task:failed')).toBe(false)
        expect(runner.created).toHaveLength(1)
      })

      // Fixed (CSL-5543), was: attemptRecovery sets `attempt.success = true` after awaiting
      // processTaskAutonomously, which swallows its own errors. So every attempt is marked successful
      // even when the retry failed and the task ended up in the 'failed' phase.
      it('marks a recovery attempt unsuccessful when the retry failed (BUG: always success)', async () => {
        runner.createFailure = () => ({ status: 500, text: 'down' })
        const task = await recovering.submitTask({ goal: 'g' })
        expect(task.progress!.phase).toBe('failed')
        expect(task.recoveryAttempts!.every(a => a.success === false)).toBe(true)
      })

      it('retries a failed subtask once and completes it when the retry succeeds', async () => {
        stubBreakdown(recovering, [{ title: 'Flaky', description: 'x' }])
        let calls = 0
        runner.eventsFor = () => [++calls === 1 ? failed('flaked') : completed()]
        const task = await recovering.submitTask({ goal: 'g' })

        expect(runner.created.map(c => c.goal)).toEqual(['Flaky: x', 'Flaky: x'])
        expect(task.subtasks![0].status).toBe('completed')
      })

      it('gives up quietly when the subtask retry fails too', async () => {
        stubBreakdown(recovering, [{ title: 'Doomed', description: 'x' }])
        runner.eventsFor = () => [failed('still broken')]
        const task = await recovering.submitTask({ goal: 'g' })

        expect(runner.created).toHaveLength(2)
        expect(task.subtasks![0]).toMatchObject({ status: 'failed', error: 'still broken' })
      })

      // Fixed (CSL-5542), was: executeSubtasks pairs `failures[i]` with `group[i]`, but
      // `failures` is the filtered list of rejected results, so index i is not the i-th subtask of the
      // group. When the second subtask is the one that failed, the first (healthy) one is retried.
      it('retries the subtask that failed, not the first of its group (BUG: index mismatch)', async () => {
        stubBreakdown(recovering, [
          { title: 'Healthy', description: 'ok' },
          { title: 'Broken', description: 'bad' }
        ])
        let broken = 0
        runner.eventsFor = c => (c.goal.startsWith('Broken') && ++broken === 1 ? [failed('once')] : [completed()])
        const task = await recovering.submitTask({ goal: 'g' })

        expect(task.subtasks!.find(s => s.title === 'Broken')!.status).toBe('completed')
      })

      it('further breaks down subtasks above effort 2 when applying a reduce_scope recovery', async () => {
        const task: EnhancedTask = {
          id: 'task_1_x',
          goal: 'g',
          subtasks: [
            { id: 's0', parentId: '', title: 'Small', description: '', status: 'pending', dependencies: [], estimatedEffort: 1 },
            { id: 's1', parentId: '', title: 'Huge', description: '', status: 'pending', dependencies: [], estimatedEffort: 5 }
          ]
        }
        const breakdown = vi
          .spyOn((recovering as any).taskAgent, 'breakdownTask')
          .mockResolvedValue({ success: true, breakdown: { subtasks: [{ title: 'Huge-1', description: 'p1' }, { title: 'Huge-2', description: 'p2' }] } })

        await (recovering as any).applyRecoveryModifications(task, { type: 'reduce_scope', modifications: { breakdownFurther: true } })

        expect(breakdown).toHaveBeenCalledWith(expect.objectContaining({ taskId: 's1' }))
        expect(task.subtasks!.map(s => s.title)).toEqual(['Small', 'Huge-1', 'Huge-2'])
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('stopTask', () => {
    beforeEach(async () => {
      await integration.initialize()
    })

    it('cancels a tracked task: phase, event and removal', async () => {
      const task = await integration.submitTask({ goal: 'g' })
      integration.stopTask(task.id)

      expect(task.progress!.phase).toBe('cancelled')
      expect(emitted.filter(e => e.event === 'task:cancelled')).toEqual([{ event: 'task:cancelled', payload: { task } }])
      expect(integration.getTask(task.id)).toBeUndefined()
      expect(integration.getActiveTasks()).toEqual([])
    })

    it('does nothing for an unknown task id', () => {
      integration.stopTask('nope')
      expect(emitted).toEqual([])
    })

    it('leaves other tasks alone', async () => {
      const a = await integration.submitTask({ goal: 'a' })
      const b = await integration.submitTask({ goal: 'b' })
      integration.stopTask(a.id)
      expect(integration.getActiveTasks()).toEqual([b])
    })
  })

  // -------------------------------------------------------------------------
  describe('getTask / getActiveTasks', () => {
    it('return undefined and an empty list when nothing was submitted', () => {
      expect(integration.getTask('x')).toBeUndefined()
      expect(integration.getActiveTasks()).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('getInsights', () => {
    it('counts tasks by phase and averages subtasks and recovery attempts', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(FIXED_NOW)
      const auto = makeIntegration({ enableAutonomousBreakdown: true })
      await auto.initialize()

      stubBreakdown(auto, [
        { title: 'A', description: 'a' },
        { title: 'B', description: 'b' }
      ])
      const done = await auto.submitTask({ goal: 'finishes' })
      vi.spyOn((auto as any).taskAgent, 'breakdownTask').mockResolvedValue({ success: true, breakdown: { subtasks: [] } })
      runner.createFailure = () => ({ status: 500, text: 'down' })
      const broken = await auto.submitTask({ goal: 'breaks' })
      broken.recoveryAttempts = [
        { attemptNumber: 1, timestamp: '', strategy: 's', modifications: {}, success: false, error: 'E1' },
        { attemptNumber: 2, timestamp: '', strategy: 's', modifications: {}, success: false, error: 'E1' },
        { attemptNumber: 3, timestamp: '', strategy: 's', modifications: {}, success: false, error: 'E2' },
        { attemptNumber: 4, timestamp: '', strategy: 's', modifications: {}, success: false, error: 'E3' },
        { attemptNumber: 5, timestamp: '', strategy: 's', modifications: {}, success: false, error: 'E4' }
      ]
      expect(done.progress!.phase).toBe('completed')
      expect(broken.progress!.phase).toBe('failed')

      const insights = auto.getInsights()
      expect(insights.totalTasks).toBe(2)
      expect(insights.completedTasks).toBe(1)
      expect(insights.failedTasks).toBe(1)
      expect(insights.averageSubtasks).toBe(1)
      expect(insights.averageRecoveryAttempts).toBe(2.5)
      // top three failure reasons, most common first
      expect(insights.commonFailureReasons).toHaveLength(3)
      expect(insights.commonFailureReasons[0]).toBe('E1')
      expect(insights.performanceMetrics).toMatchObject({ successRate: 0.5, averageConfidence: 1 })
    })

    it('reports zero completion time and success rate when nothing has completed', async () => {
      await integration.initialize()
      await integration.submitTask({ goal: 'still initializing' })
      expect(integration.getInsights().performanceMetrics).toEqual({ averageCompletionTime: 0, successRate: 0 })
    })

    it('measures the average completion time from the task id timestamp', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(FIXED_NOW)
      const auto = makeIntegration({ enableAutonomousBreakdown: true })
      await auto.initialize()
      stubBreakdown(auto, [{ title: 'A', description: 'a' }])
      await auto.submitTask({ goal: 'g' })

      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 4000))
      expect(auto.getInsights().performanceMetrics.averageCompletionTime).toBe(4000)
    })

    // Fixed (CSL-5545), was: with no tasks, averageSubtasks and averageRecoveryAttempts are
    // 0 / 0 = NaN instead of 0.
    it('reports 0 for the averages when there are no tasks (BUG: NaN)', () => {
      const insights = integration.getInsights()
      expect(insights.totalTasks).toBe(0)
      expect(insights.averageSubtasks).toBe(0)
      expect(insights.averageRecoveryAttempts).toBe(0)
    })
  })
})
