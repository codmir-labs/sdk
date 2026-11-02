/**
 * ConversationIntelligence Test Suite
 *
 * ConversationIntelligence is pure in-process analysis (keyword heuristics, no I/O), so these tests
 * use the real module end to end and assert on what it returns, stores and emits.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ConversationIntelligence } from '../intelligence/ConversationIntelligence'
import type { Context } from '../types'

type Role = 'user' | 'assistant' | 'system'

function msg(content: string, role: Role = 'user', entities: any[] = []) {
  return {
    id: `m-${Math.abs(hash(content + role))}`,
    role,
    content,
    timestamp: '2025-01-01T00:00:00.000Z',
    intent: [],
    entities,
    metadata: {}
  }
}

function hash(s: string) {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0
  return h
}

/** A Context whose conversation carries the given messages and intent overrides. */
function ctx(
  messages: ReturnType<typeof msg>[],
  opts: { id?: string; intent?: Partial<Context['conversation']['intent']>; sentiment?: string } = {}
): Context {
  return {
    conversation: {
      id: opts.id ?? 'conv-1',
      messages,
      intent: { primary: 'general', secondary: [], confidence: 0.5, urgency: 'medium', complexity: 'simple', ...opts.intent },
      sentiment: opts.sentiment ?? 'neutral',
      topics: [],
      keywords: [],
      entities: []
    }
  } as unknown as Context
}

const config = {} as any

async function analyse(ci: ConversationIntelligence, context: Context) {
  return (await ci.analyzeConversation(context)) as any
}

describe('ConversationIntelligence', () => {
  let ci: ConversationIntelligence

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ci = new ConversationIntelligence(config)
    await ci.initialize()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  describe('initialize', () => {
    it('resolves', async () => {
      await expect(new ConversationIntelligence(config).initialize()).resolves.toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  describe('analyzeConversation', () => {
    it('returns the analysis together with recommendations and next actions', async () => {
      const result = await analyse(ci, ctx([msg('There is a bug in auth.ts, the login page shows an error')]))

      expect(Object.keys(result).sort()).toEqual(['analysis', 'nextActions', 'recommendations'])
      expect(result.analysis).toMatchObject({
        conversationId: 'conv-1',
        analysisVersion: '1.0.0',
        contextualRelevance: 0.8
      })
      expect(result.analysis.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(result.analysis.confidence).toBeGreaterThan(0)
      expect(result.analysis.confidence).toBeLessThanOrEqual(1)
    })

    it('emits conversation_analyzed with the stored analysis', async () => {
      const events: any[] = []
      ci.on('conversation_analyzed', e => events.push(e))
      const result = await analyse(ci, ctx([msg('there is a bug')]))

      expect(events).toHaveLength(1)
      expect(events[0].analysis).toBe(result.analysis)
      expect(events[0].processingTime).toBe(result.analysis.processingTime)
    })

    it('stores the analysis by conversation id, replacing an earlier one for the same id', async () => {
      const first = await analyse(ci, ctx([msg('a bug')], { id: 'c1' }))
      const second = await analyse(ci, ctx([msg('a feature request')], { id: 'c1' }))
      await analyse(ci, ctx([msg('how do I deploy?')], { id: 'c2' }))

      const history = ci.getAnalysisHistory()
      expect(history).toHaveLength(2)
      expect(history[0]).toBe(second.analysis)
      expect(history[0]).not.toBe(first.analysis)
    })

    it('rejects and logs when the conversation is malformed', async () => {
      await expect(ci.analyzeConversation({ conversation: { id: 'x' } } as any)).rejects.toThrow()
      expect(console.error).toHaveBeenCalledWith('❌ Conversation analysis failed:', expect.any(Error))
      expect(ci.getAnalysisHistory()).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('intent', () => {
    const primaryOf = async (text: string) => (await analyse(ci, ctx([msg(text)]))).analysis.intent.primary

    it.each([
      ['the build has a bug', 'problem'],
      ['we hit an error on save', 'problem'],
      ['please add a dark mode', 'request'],
      ['I want to implement caching', 'request'],
      ['how does the cache work', 'question'],
      ['can you help me', 'question'],
      ['lets agree on a strategy', 'planning'],
      ['good morning', 'general']
    ])('classifies "%s" as %s', async (text, expected) => {
      expect(await primaryOf(text)).toBe(expected)
    })

    it('checks problem keywords before request keywords', async () => {
      expect(await primaryOf('there is an issue, please add logging')).toBe('problem')
    })

    it('ignores assistant messages', async () => {
      const result = await analyse(ci, ctx([msg('hello'), msg('I found a bug and an error', 'assistant')]))
      expect(result.analysis.intent.primary).toBe('general')
    })

    it('collects secondary intents', async () => {
      const result = await analyse(ci, ctx([msg('urgent: please review and test the bug fix')]))
      expect(result.analysis.intent.secondary).toEqual(['urgent', 'review', 'validation'])
    })

    it('computes confidence from keyword matches and secondary intents', async () => {
      // problem keywords: bug, error, issue, broken, fail; one match => 0.5 + (1/5) * 0.4
      const one = await analyse(ci, ctx([msg('a bug')]))
      expect(one.analysis.intent.confidence).toBeCloseTo(0.58)
      // two secondary intents add 0.1 each
      const withSecondary = await analyse(ci, ctx([msg('a bug, please review and test')]))
      expect(withSecondary.analysis.intent.confidence).toBeCloseTo(0.78)
    })

    // Fixed (CSL-5548), was: calculateIntentConfidence looks the primary intent up in a table
    // that has no 'general' entry, so `keywordMatches / keywords.length` is 0 / 0 and the intent
    // confidence of every unclassified conversation is NaN (ConversationIntelligence.ts:533).
    it('has a base confidence of 0.5 for an unclassified conversation (BUG: NaN)', async () => {
      expect((await analyse(ci, ctx([msg('good morning')]))).analysis.intent.confidence).toBe(0.5)
    })

    it('caps confidence at 1', async () => {
      const text = 'bug error issue broken fail, urgent review test'
      expect((await analyse(ci, ctx([msg(text)]))).analysis.intent.confidence).toBe(1)
    })

    it.each([
      ['this is urgent', 'critical'],
      ['please do it asap', 'critical'],
      ['this is important', 'high'],
      ['soon please', 'high'],
      ['no rush on this', 'low'],
      ['when you can', 'low'],
      ['a normal message', 'medium']
    ])('assesses urgency of "%s" as %s', async (text, expected) => {
      expect((await analyse(ci, ctx([msg(text)]))).analysis.intent.urgency).toBe(expected)
    })

    it('assesses complexity from the vocabulary and the number of messages', async () => {
      const complexity = async (messages: string[]) =>
        (await analyse(ci, ctx(messages.map(m => msg(m))))).analysis.intent.complexity

      expect(await complexity(['hi'])).toBe('simple')
      expect(await complexity(['hi', 'there', 'friend'])).toBe('moderate') // > 2 messages
      expect(await complexity(['multiple things'])).toBe('moderate') // one moderate word
      expect(await complexity(['a system issue'])).toBe('complex') // one complex word
      expect(await complexity(['an architecture and integration project'])).toBe('expert') // two complex words
      expect(await complexity(Array.from({ length: 6 }, (_, i) => `m${i}`))).toBe('complex') // > 5 messages
      expect(await complexity(Array.from({ length: 9 }, (_, i) => `m${i}`))).toBe('expert') // > 8 messages
    })
  })

  // -------------------------------------------------------------------------
  describe('entities', () => {
    it('extracts file and technology entities with their confidence', async () => {
      const result = await analyse(ci, ctx([msg('Fix auth.ts and styles.css, we use React and Docker')]))
      const entities = result.analysis.entities

      expect(entities).toEqual(
        expect.arrayContaining([
          { type: 'file', value: 'auth.ts', confidence: 0.9, metadata: { extension: 'ts' } },
          { type: 'file', value: 'styles.css', confidence: 0.9, metadata: { extension: 'css' } },
          { type: 'technology', value: 'React', confidence: 0.8, metadata: { category: 'framework_or_language' } },
          { type: 'technology', value: 'Docker', confidence: 0.8, metadata: { category: 'framework_or_language' } }
        ])
      )
      expect(entities).toHaveLength(4)
    })

    it('deduplicates entities case-insensitively across messages', async () => {
      const result = await analyse(ci, ctx([msg('open auth.ts in React'), msg('then AUTH.TS again, react too')]))
      const values = result.analysis.entities.map((e: any) => e.value.toLowerCase()).sort()
      expect(values).toEqual(['auth.ts', 'react'])
    })

    it('finds no entities in plain text', async () => {
      expect((await analyse(ci, ctx([msg('nothing technical here')]))).analysis.entities).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('sentiment', () => {
    const sentimentOf = async (...texts: string[]) =>
      (await analyse(ci, ctx(texts.map(t => msg(t))))).analysis.sentiment

    it('is positive when positive words outnumber negative ones', async () => {
      const s = await sentimentOf('this is great, thanks')
      expect(s.overall).toBe('positive')
      expect(s.scores.positive).toBe(1)
      expect(s.scores.negative).toBe(0)
    })

    it('is negative for one or two negative words', async () => {
      expect((await sentimentOf('this is bad and terrible')).overall).toBe('negative')
    })

    it('is frustrated for more than two negative words', async () => {
      expect((await sentimentOf('bad, terrible, awful, I hate it')).overall).toBe('frustrated')
    })

    it('is neutral with no sentiment words, with full neutral score', async () => {
      const s = await sentimentOf('please update the page')
      expect(s).toMatchObject({ overall: 'neutral', confidence: 1, scores: { positive: 0, negative: 0, neutral: 1 } })
    })

    it('is stable for fewer than three messages', async () => {
      expect((await sentimentOf('bad', 'good')).trend).toBe('stable')
    })

    it('detects an improving trend', async () => {
      expect((await sentimentOf('terrible', 'bad', 'great', 'thanks, perfect')).trend).toBe('improving')
    })

    it('detects a declining trend', async () => {
      expect((await sentimentOf('great', 'thanks', 'bad', 'terrible')).trend).toBe('declining')
    })
  })

  // -------------------------------------------------------------------------
  describe('urgency', () => {
    const urgencyOf = async (...texts: string[]) => (await analyse(ci, ctx(texts.map(t => msg(t))))).analysis.urgency

    it('is critical with a critical indicator and records it', async () => {
      const u = await urgencyOf('this is urgent')
      expect(u).toMatchObject({ level: 'critical', score: 4, indicators: ['urgent'], confidence: 0.8 })
    })

    it('is high with a high indicator', async () => {
      expect(await urgencyOf('this is important')).toMatchObject({ level: 'high', score: 2, indicators: ['important'] })
    })

    it('adds up across messages', async () => {
      expect((await urgencyOf('quickly please', 'and soon')).level).toBe('critical')
    })

    it('is low when only low-priority phrases appear', async () => {
      expect(await urgencyOf('no rush, whenever')).toMatchObject({ level: 'low', score: -2, confidence: 0.3 })
    })

    it('is medium with no indicators', async () => {
      expect(await urgencyOf('a plain message')).toMatchObject({ level: 'medium', score: 0, indicators: [], confidence: 0.3 })
    })
  })

  // -------------------------------------------------------------------------
  describe('extractActionableInsights', () => {
    const insightsFor = (...texts: string[]) => ci.extractActionableInsights(ctx(texts.map(t => msg(t))))

    it('finds referenced files', async () => {
      const insights = await insightsFor('look at app.ts and util.py')
      expect(insights).toContainEqual(
        expect.objectContaining({ category: 'file_reference', insight: 'Files mentioned: app.ts, util.py', confidence: 0.9, actionable: true })
      )
    })

    it('finds errors, crashes and exceptions', async () => {
      for (const word of ['error', 'exception', 'crash']) {
        expect((await insightsFor(`we saw a ${word}`)).map(i => i.category)).toContain('error_detection')
      }
    })

    it('finds performance concerns', async () => {
      for (const word of ['slow', 'performance', 'timeout']) {
        expect((await insightsFor(`it is ${word}`)).map(i => i.category)).toContain('performance')
      }
    })

    it('flags more than two user questions as needing guidance', async () => {
      expect((await insightsFor('why?', 'how?', 'when?')).map(i => i.category)).toContain('guidance_needed')
      expect((await insightsFor('why?', 'how?')).map(i => i.category)).not.toContain('guidance_needed')
    })

    it('flags repeated messages as unclear communication', async () => {
      const repeated = await insightsFor('same thing', 'same thing', 'same thing')
      expect(repeated.map(i => i.category)).toContain('communication_clarity')
      expect((await insightsFor('one', 'two', 'three')).map(i => i.category)).not.toContain('communication_clarity')
    })

    it('only looks for per-message insights in user messages', async () => {
      const insights = await ci.extractActionableInsights(ctx([msg('hello'), msg('error in app.ts', 'assistant')]))
      expect(insights).toEqual([])
    })

    it('returns nothing for an unremarkable conversation', async () => {
      expect(await insightsFor('hello there')).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('predictUserNeeds', () => {
    const needs = (messages: string[], intent: any = {}, sentiment?: string) =>
      ci.predictUserNeeds(ctx(messages.map(m => msg(m)), { intent, sentiment }))

    it('predicts a ticket need from problem wording', async () => {
      const result = await needs(['the app is broken'])
      expect(result.find(n => n.type === 'create_ticket')).toMatchObject({ confidence: 0.8, priority: 0.6 })
    })

    it('predicts a task need only for non-simple work', async () => {
      expect((await needs(['please build the project'], { complexity: 'simple' })).map(n => n.type)).not.toContain('create_task')
      expect((await needs(['please build the project'], { complexity: 'moderate' })).map(n => n.type)).toContain('create_task')
    })

    it('predicts an information need from a question or several question marks', async () => {
      expect((await needs(['what is this'], { primary: 'question' })).map(n => n.type)).toContain('gather_information')
      expect((await needs(['why?', 'how?'])).map(n => n.type)).toContain('gather_information')
      expect((await needs(['why?'])).map(n => n.type)).not.toContain('gather_information')
    })

    it('predicts nothing about tickets, tasks or information for small talk', async () => {
      const types = (await needs(['good morning'])).map(n => n.type)
      expect(types).not.toContain('create_ticket')
      expect(types).not.toContain('create_task')
      expect(types).not.toContain('gather_information')
    })

    // BUG (not fixed here, CSL-5522): indicatesCodeAnalysisNeed's keyword list contains an empty
    // string (ConversationIntelligence.ts:510), and `text.includes('')` is always true, so an
    // 'analyze_code' need is predicted for every conversation, including small talk.
    it.fails('does not predict a code-analysis need for small talk (BUG: empty keyword matches everything)', async () => {
      expect((await needs(['good morning'])).map(n => n.type)).not.toContain('analyze_code')
    })

    it('predicts a code-analysis need when code is mentioned', async () => {
      expect((await needs(['the function is slow'])).map(n => n.type)).toContain('analyze_code')
    })

    it('boosts priority with urgency, complexity and frustration', async () => {
      const base = await needs(['the app is broken'], { urgency: 'low', complexity: 'simple' })
      expect(base.find(n => n.type === 'create_ticket')!.priority).toBeCloseTo(0.5)

      const critical = await needs(['the app is broken'], { urgency: 'critical', complexity: 'expert' }, 'frustrated')
      // 0.5 + 0.4 (critical) + 0.2 (expert) + 0.2 (frustrated ticket) capped at 1
      expect(critical.find(n => n.type === 'create_ticket')!.priority).toBe(1)

      const question = await needs(['what now'], { primary: 'question', urgency: 'low' })
      expect(question.find(n => n.type === 'gather_information')!.priority).toBeCloseTo(0.8)
    })

    it('sorts by confidence times priority, highest first', async () => {
      const result = await needs(['the build is broken, what now?', 'why?'], { primary: 'question', urgency: 'high' })
      const scores = result.map(n => n.confidence * n.priority)
      expect(scores).toEqual([...scores].sort((a, b) => b - a))
      expect(result.length).toBeGreaterThan(1)
    })
  })

  // -------------------------------------------------------------------------
  describe('analyzeConversationFlow', () => {
    const flow = (messages: ReturnType<typeof msg>[]) => ci.analyzeConversationFlow(ctx(messages).conversation)

    it('counts messages by role and averages their length', async () => {
      const result = await flow([msg('abcd'), msg('abcdefgh', 'assistant'), msg('ab')])
      expect(result).toMatchObject({ totalMessages: 3, userMessages: 2, assistantMessages: 1 })
      expect(result.averageMessageLength).toBeCloseTo(14 / 3)
    })

    it('is initial for one or two messages', async () => {
      expect((await flow([msg('hi'), msg('hello', 'assistant')])).conversationStage).toBe('initial')
    })

    it('is concluded when the user thanks', async () => {
      expect((await flow([msg('a'), msg('b', 'assistant'), msg('thank you')])).conversationStage).toBe('concluded')
    })

    it('is resolving when the last user message asks for action', async () => {
      expect((await flow([msg('a'), msg('b', 'assistant'), msg('please implement it')])).conversationStage).toBe('resolving')
    })

    it('is defining for a long conversation and exploring for a short one without action words', async () => {
      const five = [msg('a'), msg('b', 'assistant'), msg('c'), msg('e', 'assistant'), msg('g')]
      expect((await flow(five)).conversationStage).toBe('defining')
      expect((await flow(five.slice(0, 3))).conversationStage).toBe('exploring')
    })

    it('rates engagement from message length and count', async () => {
      const long = 'x'.repeat(120)
      expect((await flow([msg(long), msg(long), msg(long), msg(long)])).engagementLevel).toBe('high')
      expect((await flow([msg('x'.repeat(60))])).engagementLevel).toBe('medium')
      expect((await flow([msg('a'), msg('b'), msg('c')])).engagementLevel).toBe('medium') // > 2 user messages
      expect((await flow([msg('short')])).engagementLevel).toBe('low')
    })

    it('derives depth from exchanges and content richness, capped at 10', async () => {
      // 2 messages: exchanges 1 * 0.3 + (avg 100 / 100) * 0.7 = 1.0
      expect((await flow([msg('x'.repeat(100)), msg('x'.repeat(100), 'assistant')])).conversationDepth).toBeCloseTo(1)
      expect((await flow([msg('x'.repeat(5000))])).conversationDepth).toBe(10)
    })

    it('lists up to three significant words per message as topics, skipping stop words', async () => {
      const result = await flow([msg('that database migration needs careful planning tomorrow')])
      expect(result.topicProgression).toEqual(['database', 'migration', 'needs'])
    })

    it('keeps at most ten topics', async () => {
      const messages = Array.from({ length: 6 }, (_, i) => msg(`alpha${i} bravo${i} charlie${i}`))
      expect((await flow(messages)).topicProgression).toHaveLength(10)
    })
  })

  // -------------------------------------------------------------------------
  describe('clarity and completeness', () => {
    const scores = async (...texts: string[]) => {
      const { analysis } = await analyse(ci, ctx(texts.map(t => msg(t))))
      return { clarity: analysis.clarity, completeness: analysis.completeness }
    }

    it('rewards specific, explained, detailed messages', async () => {
      const text = 'Specifically, the export fails exactly at the last page because the file is too large for the buffer'
      // +0.2 specifically/exactly, +0.1 > 50 chars, +0.15 because => 0.45 / 1 + 0.5
      expect((await scores(text)).clarity).toBeCloseTo(0.95)
    })

    it('penalises vague, brief or confused messages', async () => {
      expect((await scores('maybe')).clarity).toBeCloseTo(0.3) // -0.1 maybe, -0.1 brief
      expect((await scores('what???')).clarity).toBeCloseTo(0.2) // -0.1 brief, -0.2 confusion
    })

    it('clamps clarity into 0..1', async () => {
      const { clarity } = await scores('???', '???', '???')
      expect(clarity).toBeGreaterThanOrEqual(0)
      expect(clarity).toBeLessThanOrEqual(1)
    })

    it('starts completeness at 0.3 and adds for when/where/how, expected/should and environment/version', async () => {
      expect((await scores('hello')).completeness).toBeCloseTo(0.3)
      // +0.1 how, +0.1 should, +0.15 version
      expect((await scores('how it should work in version 2')).completeness).toBeCloseTo(0.65)
    })

    it('adds completeness for entity-rich messages', async () => {
      const entities = [{}, {}, {}]
      const { analysis } = await analyse(ci, ctx([msg('hello', 'user', entities)]))
      expect(analysis.completeness).toBeCloseTo(0.4)
    })

    // BUG (not fixed here, CSL-5522): assessClarity and assessCompleteness divide by the number of
    // user messages. A conversation with no user message gives 0 / 0 = NaN, which survives the
    // Math.max/Math.min clamp and ends up in the analysis.
    it.fails('gives a finite clarity when the conversation has no user message (BUG: NaN)', async () => {
      const { analysis } = await analyse(ci, ctx([msg('I can help with that', 'assistant')]))
      expect(Number.isFinite(analysis.clarity)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  describe('recommendations and next actions', () => {
    it('recommends a ticket and error details for a problem', async () => {
      const { recommendations } = await analyse(ci, ctx([msg('there is a bug in the export feature, it is quite detailed')]))
      expect(recommendations).toEqual(
        expect.arrayContaining(['Create a ticket to track this issue', 'Gather additional error details and logs'])
      )
    })

    it('recommends task breakdown and acceptance criteria for a request', async () => {
      const { recommendations } = await analyse(ci, ctx([msg('please add a dark mode')]))
      expect(recommendations).toEqual(
        expect.arrayContaining(['Break down the request into manageable tasks', 'Define acceptance criteria and success metrics'])
      )
    })

    it('recommends clarifying questions when clarity is low', async () => {
      const { recommendations } = await analyse(ci, ctx([msg('hmm')]))
      expect(recommendations).toContain('Ask clarifying questions to better understand requirements')
    })

    it('does not ask for clarification when the request is clear', async () => {
      const text = 'Specifically, the export fails exactly at the last page because the file is too large for the buffer'
      const { recommendations } = await analyse(ci, ctx([msg(text)]))
      expect(recommendations).not.toContain('Ask clarifying questions to better understand requirements')
    })

    it('recommends escalation for a critical conversation', async () => {
      const { recommendations } = await analyse(ci, ctx([msg('this is urgent')]))
      expect(recommendations).toEqual(
        expect.arrayContaining(['Prioritize this conversation for immediate action', 'Consider escalating to appropriate team members'])
      )
    })

    it('returns unique next actions, at most five, drawn from needs and insights', async () => {
      const { nextActions } = await analyse(
        ci,
        ctx([msg('the build is broken, error in app.ts, it is slow'), msg('why?'), msg('how?'), msg('when?')])
      )
      expect(nextActions.length).toBeLessThanOrEqual(5)
      expect(new Set(nextActions).size).toBe(nextActions.length)
      expect(nextActions[0]).toBe('Extract issue details from conversation')
    })
  })

  // -------------------------------------------------------------------------
  describe('stored insights', () => {
    it('getInsights is null before any analysis and the latest analysis afterwards', async () => {
      expect(ci.getInsights()).toBeNull()
      await analyse(ci, ctx([msg('first bug')], { id: 'c1' }))
      const second = await analyse(ci, ctx([msg('second feature')], { id: 'c2' }))
      expect(ci.getInsights()).toBe(second.analysis)
    })

    it('getConversationInsights is null for an unknown conversation', () => {
      expect(ci.getConversationInsights('nope')).toBeNull()
    })

    it('summarises a stored analysis for decision making', async () => {
      const { analysis } = await analyse(
        ci,
        ctx([msg('urgent bug in auth.ts, the React app crashed because of an error')], { id: 'c1' })
      )
      const insights = ci.getConversationInsights('c1')!

      expect(insights).toMatchObject({
        primaryIntent: 'problem',
        urgencyLevel: 'critical',
        sentimentTrend: 'stable',
        confidence: analysis.confidence
      })
      expect(insights.keyTopics).toEqual(['auth.ts'])
      expect(insights.actionableItems).toEqual(
        expect.arrayContaining(['Files mentioned: auth.ts', 'Error or exception mentioned - investigation needed'])
      )
      expect(insights.recommendations).toEqual(analysis.predictedNeeds.map((n: any) => n.description))
    })

    it('only lists entities above 0.8 confidence as key topics', async () => {
      await analyse(ci, ctx([msg('auth.ts uses React')], { id: 'c1' }))
      // files are 0.9, technologies exactly 0.8 (not above)
      expect(ci.getConversationInsights('c1')!.keyTopics).toEqual(['auth.ts'])
    })

    it('counts intent patterns by primary intent, urgency and complexity', async () => {
      await analyse(ci, ctx([msg('a bug')], { id: 'c1' }))
      await analyse(ci, ctx([msg('another bug')], { id: 'c2' }))
      await analyse(ci, ctx([msg('please add a thing')], { id: 'c3' }))

      const patterns = ci.getIntentPatterns()
      const bug = patterns.find(p => p.pattern === 'problem_medium_simple')!
      expect(bug.frequency).toBe(2)
      expect(bug.firstSeen <= bug.lastSeen).toBe(true)
      expect(patterns.find(p => p.pattern === 'request_medium_simple')!.frequency).toBe(1)
      expect(patterns).toHaveLength(2)
    })

    it('has no history or patterns before the first analysis', () => {
      expect(ci.getAnalysisHistory()).toEqual([])
      expect(ci.getIntentPatterns()).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('extraction wrappers', () => {
    const context = () => ctx([msg('there is a bug in auth.ts')], { id: 'wrap' })

    it('extractTicketRequirements returns the full analysis and records it', async () => {
      const result = await ci.extractTicketRequirements({ messages: [], context: context() })
      expect(result.conversationId).toBe('wrap')
      expect(result.intent.primary).toBe('problem')
      expect(ci.getConversationInsights('wrap')).not.toBeNull()
    })

    it('extractTaskDescription returns a description with the analysis confidence', async () => {
      const result = await ci.extractTaskDescription({ messages: [], context: context() })
      expect(typeof result.description).toBe('string')
      expect(result.confidence).toBe(ci.getInsights().confidence)
    })

    // BUG (not fixed here, CSL-5522): extractTaskDescription (and extractCodeRequirements) read
    // `analysis.summary`, which ConversationAnalysis never sets, so the description is always the
    // fixed placeholder and never reflects the conversation.
    it.fails('extractTaskDescription reflects the conversation (BUG: always the placeholder)', async () => {
      const result = await ci.extractTaskDescription({ messages: [], context: context() })
      expect(result.description).not.toBe('Task described in conversation')
    })

    it('extractCodeRequirements returns the TypeScript defaults with the analysis confidence', async () => {
      const result = await ci.extractCodeRequirements({ messages: [], context: context() })
      expect(result).toMatchObject({ language: 'typescript', examples: [], constraints: [] })
      expect(result.confidence).toBe(ci.getInsights().confidence)
    })
  })
})
