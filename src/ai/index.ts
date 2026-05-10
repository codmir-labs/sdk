/**
 * @codmir/sdk/ai - AI Monitoring Integration
 *
 * Monitors AI/LLM API calls (OpenAI, Anthropic, etc.) for errors,
 * costs, and performance. Wraps the core overseer module to provide
 * error tracking + observability specifically for AI API usage.
 *
 * @example
 * ```typescript
 * import * as CosmirAI from '@codmir/sdk/ai';
 * import OpenAI from 'openai';
 * import Anthropic from '@anthropic-ai/sdk';
 *
 * CosmirAI.init({
 *   dsn: process.env.CODMIR_DSN,
 *   trackTokenUsage: true,
 *   trackCosts: true,
 * });
 *
 * // Wrap clients to auto-track all calls
 * const openai = CosmirAI.wrapOpenAI(new OpenAI());
 * const anthropic = CosmirAI.wrapAnthropic(new Anthropic());
 *
 * // Or use the generic tracker
 * const result = await CosmirAI.trackAICall('custom', { model: 'my-model' }, async () => {
 *   return await myCustomProvider.generate('Hello');
 * });
 *
 * // Get accumulated usage stats
 * console.log(CosmirAI.getAIUsageSummary());
 * ```
 */

import {
  init as coreInit,
  captureException as coreCaptureException,
  captureMessage as coreCaptureMessage,
  setUser as coreSetUser,
  setTag as coreSetTag,
  setTags as coreSetTags,
  addBreadcrumb as coreAddBreadcrumb,
  flush as coreFlush,
  close as coreClose,
  getClient,
  setSessionId as coreSetSessionId,
  getDsn as coreGetDsn,
  getEnvironment as coreGetEnvironment,
  getOverseerKey as coreGetOverseerKey,
  type OverseerConfig,
  type UserContext,
  type Breadcrumb,
  type SeverityLevel,
} from "../overseer/index";

import { nanoid } from "nanoid";

// =============================================================================
// Types
// =============================================================================

export interface AIMonitorConfig extends OverseerConfig {
  /** Track input/output token counts per call (default: true) */
  trackTokenUsage?: boolean;
  /** Estimate costs per call based on model pricing (default: true) */
  trackCosts?: boolean;
  /** Measure response latency per call (default: true) */
  trackLatency?: boolean;
  /** Capture prompts sent to AI providers — privacy-sensitive (default: false) */
  capturePrompts?: boolean;
  /** Capture responses from AI providers — privacy-sensitive (default: false) */
  captureResponses?: boolean;
  /** Regex patterns to redact from captured prompts/responses */
  redactPatterns?: RegExp[];
  /** Custom cost table per model (cost per 1K tokens) */
  costPerModel?: Record<string, { input: number; output: number }>;
}

/** Inline type representing an OpenAI-compatible client shape */
interface OpenAILikeClient {
  chat: {
    completions: {
      create: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
}

/** Inline type representing an Anthropic-compatible client shape */
interface AnthropicLikeClient {
  messages: {
    create: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
}

/** Parameters captured from an AI API call */
interface AICallParams {
  model?: string;
  messageCount?: number;
  temperature?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

/** Result of a tracked AI call with usage metadata */
interface AICallResult {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  latencyMs: number;
  model: string;
  provider: string;
}

/** Accumulated usage summary */
interface AIUsageSummary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  avgLatencyMs: number;
  byProvider: Record<string, ProviderStats>;
  byModel: Record<string, ModelStats>;
}

interface ProviderStats {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  avgLatencyMs: number;
  errors: number;
}

interface ModelStats {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  avgLatencyMs: number;
  errors: number;
}

// =============================================================================
// Default Cost Table (per 1K tokens)
// =============================================================================

const DEFAULT_COST_PER_MODEL: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 0.003, output: 0.015 },
  "claude-haiku-4-5-20251001": { input: 0.001, output: 0.005 },
  "gpt-4o": { input: 0.005, output: 0.015 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "gpt-4.1": { input: 0.002, output: 0.008 },
};

// =============================================================================
// Internal State
// =============================================================================

let isInitialized = false;
let resolvedConfig: Required<Pick<AIMonitorConfig, "trackTokenUsage" | "trackCosts" | "trackLatency" | "capturePrompts" | "captureResponses">> & {
  redactPatterns: RegExp[];
  costPerModel: Record<string, { input: number; output: number }>;
} = {
  trackTokenUsage: true,
  trackCosts: true,
  trackLatency: true,
  capturePrompts: false,
  captureResponses: false,
  redactPatterns: [],
  costPerModel: { ...DEFAULT_COST_PER_MODEL },
};

/** Accumulated stats for getAIUsageSummary() */
const stats = {
  totalCalls: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCost: 0,
  totalLatencyMs: 0,
  byProvider: {} as Record<string, ProviderStats>,
  byModel: {} as Record<string, ModelStats>,
};

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the AI monitoring integration.
 *
 * Calls the core overseer init with the base config, then stores
 * AI-specific tracking options for use by wrappers.
 */
export function init(config: AIMonitorConfig = {}): void {
  if (isInitialized) return;

  const {
    trackTokenUsage = true,
    trackCosts = true,
    trackLatency = true,
    capturePrompts = false,
    captureResponses = false,
    redactPatterns = [],
    costPerModel,
    ...coreConfig
  } = config;

  coreInit(coreConfig);
  isInitialized = true;

  resolvedConfig = {
    trackTokenUsage,
    trackCosts,
    trackLatency,
    capturePrompts,
    captureResponses,
    redactPatterns,
    costPerModel: { ...DEFAULT_COST_PER_MODEL, ...costPerModel },
  };
}

// =============================================================================
// Cost Calculation
// =============================================================================

/**
 * Estimate the cost of an AI call based on the model and token counts.
 * Returns 0 if the model is not in the cost table.
 */
function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = resolvedConfig.costPerModel[model];
  if (!pricing) return 0;

  const inputCost = (inputTokens / 1000) * pricing.input;
  const outputCost = (outputTokens / 1000) * pricing.output;
  return inputCost + outputCost;
}

// =============================================================================
// Content Redaction
// =============================================================================

/**
 * Redact sensitive patterns from captured content.
 */
function redactContent(content: string): string {
  let redacted = content;
  for (const pattern of resolvedConfig.redactPatterns) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

// =============================================================================
// Stats Accumulation
// =============================================================================

/**
 * Record a completed AI call in the accumulated stats.
 */
function recordStats(result: AICallResult): void {
  stats.totalCalls++;
  stats.totalInputTokens += result.inputTokens;
  stats.totalOutputTokens += result.outputTokens;
  stats.totalCost += result.cost;
  stats.totalLatencyMs += result.latencyMs;

  // Per-provider stats
  if (!stats.byProvider[result.provider]) {
    stats.byProvider[result.provider] = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      avgLatencyMs: 0,
      errors: 0,
    };
  }
  const providerStats = stats.byProvider[result.provider];
  providerStats.calls++;
  providerStats.inputTokens += result.inputTokens;
  providerStats.outputTokens += result.outputTokens;
  providerStats.cost += result.cost;
  providerStats.avgLatencyMs =
    (providerStats.avgLatencyMs * (providerStats.calls - 1) + result.latencyMs) / providerStats.calls;

  // Per-model stats
  if (!stats.byModel[result.model]) {
    stats.byModel[result.model] = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      avgLatencyMs: 0,
      errors: 0,
    };
  }
  const modelStats = stats.byModel[result.model];
  modelStats.calls++;
  modelStats.inputTokens += result.inputTokens;
  modelStats.outputTokens += result.outputTokens;
  modelStats.cost += result.cost;
  modelStats.avgLatencyMs =
    (modelStats.avgLatencyMs * (modelStats.calls - 1) + result.latencyMs) / modelStats.calls;
}

/**
 * Record a failed AI call in the accumulated stats.
 */
function recordError(provider: string, model: string): void {
  if (!stats.byProvider[provider]) {
    stats.byProvider[provider] = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      avgLatencyMs: 0,
      errors: 0,
    };
  }
  stats.byProvider[provider].errors++;

  if (model && !stats.byModel[model]) {
    stats.byModel[model] = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      avgLatencyMs: 0,
      errors: 0,
    };
  }
  if (model) {
    stats.byModel[model].errors++;
  }
}

// =============================================================================
// wrapOpenAI
// =============================================================================

/**
 * Wrap an OpenAI client to automatically track all chat completion calls.
 *
 * Monkey-patches `client.chat.completions.create` to intercept calls.
 * On success, adds a breadcrumb with model, tokens, cost, and latency.
 * On error, captures the exception with full context.
 *
 * @param client - An OpenAI client instance (or any object matching the shape)
 * @returns The same client, now instrumented
 *
 * @example
 * ```typescript
 * import OpenAI from 'openai';
 * import { wrapOpenAI } from '@codmir/sdk/ai';
 *
 * const openai = wrapOpenAI(new OpenAI());
 * const response = await openai.chat.completions.create({
 *   model: 'gpt-4o',
 *   messages: [{ role: 'user', content: 'Hello' }],
 * });
 * // Breadcrumb and stats are automatically recorded
 * ```
 */
export function wrapOpenAI<T extends OpenAILikeClient>(client: T): T {
  const originalCreate = client.chat.completions.create.bind(client.chat.completions);

  client.chat.completions.create = async function wrappedCreate(
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const model = (params.model as string) || "unknown";
    const messages = params.messages as unknown[] | undefined;
    const messageCount = Array.isArray(messages) ? messages.length : 0;

    const callParams: AICallParams = {
      model,
      messageCount,
      temperature: params.temperature as number | undefined,
      maxTokens: (params.max_tokens ?? params.max_completion_tokens) as number | undefined,
    };

    return trackAICall("openai", callParams, async () => {
      const response = await originalCreate(params);
      return response;
    });
  } as typeof client.chat.completions.create;

  return client;
}

// =============================================================================
// wrapAnthropic
// =============================================================================

/**
 * Wrap an Anthropic client to automatically track all message creation calls.
 *
 * Monkey-patches `client.messages.create` to intercept calls.
 * On success, adds a breadcrumb with model, tokens, cost, and latency.
 * On error, captures the exception with full context.
 *
 * @param client - An Anthropic client instance (or any object matching the shape)
 * @returns The same client, now instrumented
 *
 * @example
 * ```typescript
 * import Anthropic from '@anthropic-ai/sdk';
 * import { wrapAnthropic } from '@codmir/sdk/ai';
 *
 * const anthropic = wrapAnthropic(new Anthropic());
 * const response = await anthropic.messages.create({
 *   model: 'claude-sonnet-4-20250514',
 *   max_tokens: 1024,
 *   messages: [{ role: 'user', content: 'Hello' }],
 * });
 * // Breadcrumb and stats are automatically recorded
 * ```
 */
export function wrapAnthropic<T extends AnthropicLikeClient>(client: T): T {
  const originalCreate = client.messages.create.bind(client.messages);

  client.messages.create = async function wrappedCreate(
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const model = (params.model as string) || "unknown";
    const messages = params.messages as unknown[] | undefined;
    const messageCount = Array.isArray(messages) ? messages.length : 0;

    const callParams: AICallParams = {
      model,
      messageCount,
      temperature: params.temperature as number | undefined,
      maxTokens: params.max_tokens as number | undefined,
    };

    return trackAICall("anthropic", callParams, async () => {
      const response = await originalCreate(params);
      return response;
    });
  } as typeof client.messages.create;

  return client;
}

// =============================================================================
// trackAICall
// =============================================================================

/**
 * Generic wrapper for tracking any AI/LLM API call.
 *
 * Measures timing, captures errors, logs breadcrumbs, and accumulates
 * usage statistics. Works with any provider — OpenAI, Anthropic, or custom.
 *
 * @param provider - Provider identifier ('openai' | 'anthropic' | 'custom' | string)
 * @param params - Call parameters (model, message count, temperature, etc.)
 * @param execute - The async function that performs the actual API call
 * @returns The result from the execute function
 *
 * @example
 * ```typescript
 * const result = await trackAICall('custom', { model: 'llama-3' }, async () => {
 *   return await myProvider.chat({ prompt: 'Hello' });
 * });
 * ```
 */
export async function trackAICall<T extends object>(
  provider: string,
  params: AICallParams,
  execute: () => Promise<T>
): Promise<T> {
  const model = params.model || "unknown";
  const startTime = resolvedConfig.trackLatency ? performance.now() : 0;

  try {
    const response = await execute();
    const latencyMs = resolvedConfig.trackLatency ? Math.round(performance.now() - startTime) : 0;

    // Extract token usage from the response
    const usage = extractUsage(provider, response as Record<string, unknown>);
    const inputTokens = usage.inputTokens;
    const outputTokens = usage.outputTokens;
    const cost = resolvedConfig.trackCosts ? estimateCost(model, inputTokens, outputTokens) : 0;

    // Build breadcrumb data
    const breadcrumbData: Record<string, unknown> = {
      provider,
      model,
    };

    if (resolvedConfig.trackTokenUsage) {
      breadcrumbData.inputTokens = inputTokens;
      breadcrumbData.outputTokens = outputTokens;
      breadcrumbData.totalTokens = inputTokens + outputTokens;
    }

    if (resolvedConfig.trackCosts) {
      breadcrumbData.estimatedCost = `$${cost.toFixed(6)}`;
    }

    if (resolvedConfig.trackLatency) {
      breadcrumbData.latencyMs = latencyMs;
    }

    if (resolvedConfig.capturePrompts && params.messageCount !== undefined) {
      breadcrumbData.messageCount = params.messageCount;
    }

    if (params.temperature !== undefined) {
      breadcrumbData.temperature = params.temperature;
    }

    if (params.maxTokens !== undefined) {
      breadcrumbData.maxTokens = params.maxTokens;
    }

    // Capture prompt content if enabled
    if (resolvedConfig.capturePrompts) {
      const promptSummary = JSON.stringify(params);
      breadcrumbData.params = redactContent(promptSummary);
    }

    // Capture response content if enabled
    if (resolvedConfig.captureResponses) {
      const responseContent = extractResponseContent(provider, response as Record<string, unknown>);
      if (responseContent) {
        breadcrumbData.response = redactContent(responseContent);
      }
    }

    // Add breadcrumb
    coreAddBreadcrumb({
      type: "http",
      category: `ai.${provider}`,
      message: `${provider}/${model} — ${inputTokens + outputTokens} tokens`,
      data: breadcrumbData,
      level: "info",
    });

    const callResult: AICallResult = {
      inputTokens,
      outputTokens,
      cost,
      latencyMs,
      model,
      provider,
    };

    recordStats(callResult);
    recordSessionCall(callResult);

    return response;
  } catch (error) {
    const latencyMs = resolvedConfig.trackLatency ? Math.round(performance.now() - startTime) : 0;

    // Capture the exception with full AI context
    coreCaptureException(error, {
      ai: {
        provider,
        model,
        messageCount: params.messageCount,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        latencyMs,
      },
    });

    // Add error breadcrumb
    coreAddBreadcrumb({
      type: "error",
      category: `ai.${provider}`,
      message: `${provider}/${model} — error: ${error instanceof Error ? error.message : String(error)}`,
      data: {
        provider,
        model,
        latencyMs,
      },
      level: "error",
    });

    recordError(provider, model);
    recordSessionError(provider, model, error);

    throw error;
  }
}

// =============================================================================
// Usage Extraction Helpers
// =============================================================================

/**
 * Extract token usage from a provider response.
 * Handles both OpenAI and Anthropic response shapes.
 */
function extractUsage(
  provider: string,
  response: Record<string, unknown>
): { inputTokens: number; outputTokens: number } {
  if (provider === "openai") {
    // OpenAI shape: response.usage.prompt_tokens / completion_tokens
    const usage = response.usage as Record<string, unknown> | undefined;
    if (usage) {
      return {
        inputTokens: (usage.prompt_tokens as number) || 0,
        outputTokens: (usage.completion_tokens as number) || 0,
      };
    }
  }

  if (provider === "anthropic") {
    // Anthropic shape: response.usage.input_tokens / output_tokens
    const usage = response.usage as Record<string, unknown> | undefined;
    if (usage) {
      return {
        inputTokens: (usage.input_tokens as number) || 0,
        outputTokens: (usage.output_tokens as number) || 0,
      };
    }
  }

  // Generic fallback: try common field names
  const usage = response.usage as Record<string, unknown> | undefined;
  if (usage) {
    const inputTokens =
      (usage.input_tokens as number) ||
      (usage.prompt_tokens as number) ||
      0;
    const outputTokens =
      (usage.output_tokens as number) ||
      (usage.completion_tokens as number) ||
      0;
    return { inputTokens, outputTokens };
  }

  return { inputTokens: 0, outputTokens: 0 };
}

/**
 * Extract the primary text content from a provider response for capture.
 */
function extractResponseContent(
  provider: string,
  response: Record<string, unknown>
): string | null {
  if (provider === "openai") {
    // OpenAI shape: response.choices[0].message.content
    const choices = response.choices as Record<string, unknown>[] | undefined;
    if (choices && choices.length > 0) {
      const message = choices[0].message as Record<string, unknown> | undefined;
      if (message && typeof message.content === "string") {
        return message.content;
      }
    }
  }

  if (provider === "anthropic") {
    // Anthropic shape: response.content[0].text
    const content = response.content as Record<string, unknown>[] | undefined;
    if (content && content.length > 0) {
      if (typeof content[0].text === "string") {
        return content[0].text;
      }
    }
  }

  return null;
}

// =============================================================================
// getAIUsageSummary
// =============================================================================

/**
 * Get accumulated AI usage statistics.
 *
 * Returns total calls, tokens, estimated costs, and average latency,
 * broken down by provider and by model.
 *
 * @example
 * ```typescript
 * const summary = getAIUsageSummary();
 * console.log(`Total cost: $${summary.totalCost.toFixed(4)}`);
 * console.log(`Avg latency: ${summary.avgLatencyMs}ms`);
 * console.log(`OpenAI calls: ${summary.byProvider.openai?.calls ?? 0}`);
 * ```
 */
export function getAIUsageSummary(): AIUsageSummary {
  return {
    totalCalls: stats.totalCalls,
    totalInputTokens: stats.totalInputTokens,
    totalOutputTokens: stats.totalOutputTokens,
    totalCost: stats.totalCost,
    avgLatencyMs: stats.totalCalls > 0 ? Math.round(stats.totalLatencyMs / stats.totalCalls) : 0,
    byProvider: deepCopyStats(stats.byProvider),
    byModel: deepCopyStats(stats.byModel),
  };
}

/**
 * Deep copy a stats record to prevent external mutation.
 */
function deepCopyStats<T extends Record<string, ProviderStats | ModelStats>>(source: T): T {
  const copy = {} as Record<string, ProviderStats | ModelStats>;
  for (const key of Object.keys(source)) {
    copy[key] = { ...source[key] };
  }
  return copy as T;
}

// =============================================================================
// resetAIUsageStats
// =============================================================================

/**
 * Reset all accumulated AI usage statistics.
 * Useful for testing or when starting a new tracking period.
 */
export function resetAIUsageStats(): void {
  stats.totalCalls = 0;
  stats.totalInputTokens = 0;
  stats.totalOutputTokens = 0;
  stats.totalCost = 0;
  stats.totalLatencyMs = 0;
  stats.byProvider = {};
  stats.byModel = {};
}

// =============================================================================
// Session Tracing
// =============================================================================

export interface SessionConfig {
  agent: string;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
}

export interface SessionEvent {
  id: string;
  type: "llm_call" | "tool_call" | "decision" | "error" | "custom";
  timestamp: string;
  durationMs?: number;
  data: Record<string, unknown>;
}

export interface SessionSpan {
  name: string;
  startTime: number;
  endTime?: number;
  events: SessionEvent[];
  metadata?: Record<string, unknown>;
}

export interface AgentSession {
  id: string;
  agent: string;
  startedAt: string;
  endedAt?: string;
  metadata: Record<string, unknown>;
  tags: Record<string, string>;
  spans: SessionSpan[];
  events: SessionEvent[];
  usage: {
    totalCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    totalLatencyMs: number;
  };
}

const activeSessions = new Map<string, AgentSession>();
let currentSessionId: string | null = null;

function activeSession(): AgentSession | null {
  if (!currentSessionId) return null;
  return activeSessions.get(currentSessionId) ?? null;
}

/**
 * Start a new agent session for correlating LLM calls.
 *
 * All `trackAICall`, `wrapOpenAI`, and `wrapAnthropic` calls made while
 * a session is active are automatically attached to it. Sessions can be
 * retrieved later for replay and analysis.
 *
 * @example
 * ```typescript
 * const session = Codmir.startSession({
 *   agent: 'support-bot',
 *   metadata: { userId: 'u_123', ticket: 'T-456' },
 * });
 *
 * // All LLM calls are now correlated under this session
 * await openai.chat.completions.create({ ... });
 * await anthropic.messages.create({ ... });
 *
 * // Add custom events for decision tracing
 * Codmir.addSessionEvent('decision', {
 *   action: 'escalate_to_human',
 *   reason: 'confidence_below_threshold',
 *   confidence: 0.42,
 * });
 *
 * const completed = Codmir.endSession();
 * // completed.events contains the full replay timeline
 * ```
 */
export function startSession(config: SessionConfig): AgentSession {
  const id = nanoid(21);

  const session: AgentSession = {
    id,
    agent: config.agent,
    startedAt: new Date().toISOString(),
    metadata: config.metadata ?? {},
    tags: config.tags ?? {},
    spans: [],
    events: [],
    usage: {
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      totalLatencyMs: 0,
    },
  };

  activeSessions.set(id, session);
  currentSessionId = id;

  coreSetSessionId(id);
  coreSetTag("agent.name", config.agent);
  coreSetTag("session.id", id);

  coreAddBreadcrumb({
    type: "navigation",
    category: "session",
    message: `Session started: ${config.agent}`,
    data: { sessionId: id, agent: config.agent, ...config.metadata },
    level: "info",
  });

  return session;
}

/**
 * End the current agent session.
 * Returns the completed session with all correlated events and usage stats.
 */
export function endSession(sessionId?: string): AgentSession | null {
  const id = sessionId ?? currentSessionId;
  if (!id) return null;

  const session = activeSessions.get(id);
  if (!session) return null;

  session.endedAt = new Date().toISOString();

  for (const span of session.spans) {
    if (!span.endTime) {
      span.endTime = performance.now();
    }
  }

  coreAddBreadcrumb({
    type: "navigation",
    category: "session",
    message: `Session ended: ${session.agent} — ${session.usage.totalCalls} calls, $${session.usage.totalCost.toFixed(4)}`,
    data: {
      sessionId: id,
      agent: session.agent,
      durationMs: new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime(),
      usage: { ...session.usage },
    },
    level: "info",
  });

  if (currentSessionId === id) {
    currentSessionId = null;
  }

  return session;
}

/**
 * Flush a completed session to the configured DSN endpoint.
 *
 * Sends the full session payload (events, spans, usage) as an
 * `agent_session` event to the overseer ingest endpoint. Call this
 * after `endSession()` to persist the replay data.
 *
 * @returns true if the flush succeeded, false if it failed or no DSN is configured
 */
export async function flushSession(session: AgentSession): Promise<boolean> {
  const dsn = coreGetDsn();
  if (!dsn) return false;

  const endpoint = dsn.endsWith("/ingest") ? dsn : `${dsn}/ingest`;

  const payload = {
    sessionId: session.id,
    service: `agent:${session.agent}`,
    environment: coreGetEnvironment(),
    events: [
      {
        type: "agent_session" as const,
        session: {
          id: session.id,
          agent: session.agent,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          metadata: session.metadata,
          tags: session.tags,
          events: session.events,
          spans: session.spans.map((s) => ({
            name: s.name,
            durationMs: s.endTime && s.startTime
              ? Math.round(s.endTime - s.startTime)
              : undefined,
            eventCount: s.events.length,
            metadata: s.metadata,
          })),
          usage: session.usage,
          durationMs: session.endedAt && session.startedAt
            ? new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()
            : undefined,
        },
      },
    ],
  };

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const overseerKey = coreGetOverseerKey();
    if (overseerKey) {
      headers["x-overseer-key"] = overseerKey;
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) return false;

    activeSessions.delete(session.id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a session by ID, or the current active session.
 */
export function getSession(sessionId?: string): AgentSession | null {
  if (sessionId) return activeSessions.get(sessionId) ?? null;
  return activeSession();
}

/**
 * Add a custom event to the current session's timeline.
 * Use this for decision tracing — record why the agent chose an action.
 */
export function addSessionEvent(
  type: SessionEvent["type"],
  data: Record<string, unknown>,
  sessionId?: string,
): SessionEvent | null {
  const id = sessionId ?? currentSessionId;
  if (!id) return null;

  const session = activeSessions.get(id);
  if (!session) return null;

  const event: SessionEvent = {
    id: nanoid(12),
    type,
    timestamp: new Date().toISOString(),
    data,
  };

  session.events.push(event);

  const currentSpan = session.spans[session.spans.length - 1];
  if (currentSpan && !currentSpan.endTime) {
    currentSpan.events.push(event);
  }

  return event;
}

/**
 * Start a named span within the current session.
 * Spans group related events (e.g., "handle_user_message", "run_tool_chain").
 */
export function startSessionSpan(
  name: string,
  metadata?: Record<string, unknown>,
  sessionId?: string,
): SessionSpan | null {
  const id = sessionId ?? currentSessionId;
  if (!id) return null;

  const session = activeSessions.get(id);
  if (!session) return null;

  const span: SessionSpan = {
    name,
    startTime: performance.now(),
    events: [],
    metadata,
  };

  session.spans.push(span);
  return span;
}

/**
 * End the most recent open span in the current session.
 */
export function endSessionSpan(sessionId?: string): void {
  const id = sessionId ?? currentSessionId;
  if (!id) return;

  const session = activeSessions.get(id);
  if (!session) return;

  for (let i = session.spans.length - 1; i >= 0; i--) {
    if (!session.spans[i].endTime) {
      session.spans[i].endTime = performance.now();
      break;
    }
  }
}

/**
 * Record an LLM call result in the active session.
 * Called automatically by trackAICall — you don't need to call this directly.
 */
function recordSessionCall(result: AICallResult): void {
  const session = activeSession();
  if (!session) return;

  session.usage.totalCalls++;
  session.usage.totalInputTokens += result.inputTokens;
  session.usage.totalOutputTokens += result.outputTokens;
  session.usage.totalCost += result.cost;
  session.usage.totalLatencyMs += result.latencyMs;

  addSessionEvent("llm_call", {
    provider: result.provider,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cost: result.cost,
    latencyMs: result.latencyMs,
  });
}

/**
 * Record an LLM call error in the active session.
 */
function recordSessionError(provider: string, model: string, error: unknown): void {
  const session = activeSession();
  if (!session) return;

  addSessionEvent("error", {
    provider,
    model,
    error: error instanceof Error ? error.message : String(error),
  });
}

// =============================================================================
// Re-exports
// =============================================================================

export {
  getClient,
  type OverseerConfig,
  type OverseerEvent,
  type UserContext,
  type Breadcrumb,
  type SeverityLevel,
} from "../overseer/index";

export const captureException = coreCaptureException;
export const captureMessage = coreCaptureMessage;
export const setUser = coreSetUser;
export const setTag = coreSetTag;
export const setTags = coreSetTags;
export const addBreadcrumb = coreAddBreadcrumb;
export const flush = coreFlush;
export const close = coreClose;

/**
 * Check if the AI monitor is initialized.
 */
export function isAIMonitorInitialized(): boolean {
  return isInitialized && getClient() !== null;
}

// Export types for consumers
export type {
  AICallParams,
  AICallResult,
  AIUsageSummary,
  ProviderStats,
  ModelStats,
  OpenAILikeClient,
  AnthropicLikeClient,
};
