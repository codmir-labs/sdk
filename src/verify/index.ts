/**
 * @codmir/sdk/verify - Connection Verification
 *
 * Verify your Codmir SDK setup by sending a test event
 * and reading the server's answer to it. Used during onboarding
 * after installing the SDK. It never touches the client your app made.
 *
 * @example
 * ```typescript
 * import { verify, printVerifyResult } from '@codmir/sdk/verify';
 *
 * const result = await verify({
 *   dsn: process.env.CODMIR_DSN,
 *   onProgress: (step) => console.log(step.message),
 * });
 *
 * console.log(printVerifyResult(result));
 * ```
 */

import { generateId } from "../id";
import { buildBody, readDroppedEvents } from "../overseer/transport";
import { SDK_INFO } from "../version";
import {
  init as coreInit,
  captureException as coreCaptureException,
  captureMessage as coreCaptureMessage,
  addBreadcrumb as coreAddBreadcrumb,
  flush as coreFlush,
  close as coreClose,
  getClient,
  OverseerClient,
  type OverseerConfig,
  type OverseerEvent,
  type UserContext,
  type Breadcrumb,
  type SeverityLevel,
} from "../overseer/index";

// =============================================================================
// Types
// =============================================================================

export interface VerifyConfig extends OverseerConfig {
  /** How long to wait for the server's answer, in milliseconds (default 10000) */
  timeout?: number;
  /** Optional callback for progress updates */
  onProgress?: (step: VerifyStep) => void;
}

export interface VerifyStep {
  step: "init" | "send" | "flush" | "confirm";
  status: "running" | "success" | "failed";
  message: string;
  duration?: number;
}

export interface VerifyResult {
  success: boolean;
  eventId?: string;
  steps: VerifyStep[];
  totalDuration: number;
  error?: string;
}

// =============================================================================
// Verification
// =============================================================================

/**
 * Verifies the setup: sends one message event to the server with a client of its own and reads the answer to that event.
 * The result is a success only when the server took it (a 2xx that did not refuse it); otherwise `error`, and the step
 * that failed, say why in one sentence. It never uses the app's client: not its tags, queue, breadcrumbs, user or replay,
 * and it leaves no client, timer or listener behind. `sampleRate` only matters at 0; `beforeSend` sees the message.
 *
 * @param config - Verification configuration extending OverseerConfig
 * @returns Result object with success status, event ID, step details, and timing
 *
 * @example
 * ```typescript
 * const result = await verify({
 *   clientKey: process.env.CODMIR_CLIENT_KEY,
 *   timeout: 5000,
 *   onProgress: (step) => console.log(`[${step.status}] ${step.message}`),
 * });
 *
 * if (result.success) {
 *   console.log('SDK is working! Event ID:', result.eventId);
 * } else {
 *   console.error('Verification failed:', result.error);
 * }
 * ```
 */
export async function verify(config: VerifyConfig): Promise<VerifyResult> {
  const { timeout, onProgress, ...overseerConfig } = config;
  const limit = timeout && timeout > 0 ? timeout : 10000;
  const steps: VerifyStep[] = [];
  const totalStart = Date.now();
  const failed = (step: VerifyStep, error: string): VerifyResult => {
    completeStep(onProgress, steps, step, "failed", error);
    return { success: false, steps, totalDuration: Date.now() - totalStart, error };
  };

  // Step 1: the config is complete. Nothing is sent without a key.
  const initStep = emitStep(onProgress, steps, "init", "running", "Initializing SDK...");
  const key = overseerConfig.clientKey || overseerConfig.apiKey || overseerConfig.overseerKey;
  if (!key) {
    return failed(initStep, "No client key: pass clientKey (the SDK reads no environment variable for it).");
  }
  const client = new OverseerClient({ ...overseerConfig, initialTags: { ...overseerConfig.initialTags, source: "sdk-verify" } });
  const where = originOf(client.getDsn());
  if (!where) return failed(initStep, "The dsn is not a web address.");
  completeStep(onProgress, steps, initStep, "success", "Initialize SDK", 0);

  // Step 2 and 3: what the config lets through, then one request and its answer.
  let phase = emitStep(onProgress, steps, "send", "running", "Sending test event...");
  const sendStart = Date.now();
  const sent = await probe(client, overseerConfig, where, limit, () => {
    completeStep(onProgress, steps, phase, "success", "Send test event", Date.now() - sendStart);
    phase = emitStep(onProgress, steps, "flush", "running", "Sending...");
  }).catch(() => "The event could not be sent.");
  if (typeof sent === "string") return failed(phase, sent);
  completeStep(onProgress, steps, phase, "success", "Server took the event", Date.now() - sendStart);
  const confirmStep = emitStep(onProgress, steps, "confirm", "running", "Confirming connection...");
  completeStep(onProgress, steps, confirmStep, "success", "Connection verified");
  return { success: true, eventId: sent.id, steps, totalDuration: Date.now() - totalStart };
}

/** One message event on its own request, never queued or retried: `{ id }` when the server took it, else a sentence saying why not. */
async function probe(client: OverseerClient, config: OverseerConfig, where: string, timeoutMs: number, sending: () => void): Promise<string | { id: string }> {
  const why = (what: string): string => `The event was not sent: ${what}.`;
  if (config.enabled === false) return why("enabled is false");
  if (!((config.sampleRate ?? 1) > 0)) return why("sampleRate is 0");
  const meta = { environment: client.getEnvironment(), release: client.getRelease() };
  const draft: OverseerEvent = {
    id: generateId(),
    type: "message",
    timestamp: new Date().toISOString(),
    level: "info",
    message: "Codmir SDK setup verified",
    tags: client.getTags(),
    ...meta,
    sdk: { ...SDK_INFO },
  };
  const event = config.beforeSend ? config.beforeSend(draft) : draft; // a throw is caught by the caller
  if (!event) return why("beforeSend returned null");
  sending();

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(resolve, timeoutMs, `No answer from ${where} within ${timeoutMs}ms.`);
  });
  const ask = async (): Promise<string | { id: string }> => {
    const res = await fetch(client.getIngestUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-overseer-key": client.getOverseerKey() },
      body: buildBody([event], { service: config.service, ...meta }),
      signal: controller.signal,
    }).catch(() => null);
    if (!res) return `Could not reach ${where}.`;
    if (!res.ok) return refusal(where, res.status);
    const [dropped] = await readDroppedEvents(res);
    if (!dropped) return { id: event.id };
    return `${where} answered ${res.status} but dropped the event${/^[a-z_]{1,40}$/.test(String(dropped.reason)) ? ` (${dropped.reason})` : ""}.`;
  };
  try {
    return await Promise.race([ask(), late]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** The scheme, host and port of a web address, or "" for anything else. Never a path, query or credentials. */
function originOf(dsn: string): string {
  try {
    const { protocol, origin } = new URL(dsn);
    return /^https?:$/.test(protocol) ? origin : "";
  } catch {
    return "";
  }
}

const REFUSED: Record<number, string> = {
  401: "refused the client key",
  402: "has no balance",
  404: "has nothing at the ingest address",
  429: "is limiting requests",
};

/** One sentence for a status that is not a success: the origin and the status, never the key, a query or a body. */
function refusal(where: string, status: number): string {
  const what = REFUSED[status === 403 ? 401 : status] ?? (status >= 500 ? "failed to take the event" : status >= 400 ? "refused the event" : "did not take the event");
  return `${where} ${what} (status ${status}).`;
}

// =============================================================================
// Quick Verify
// =============================================================================

/**
 * Simplified one-liner to verify SDK connectivity.
 *
 * @param clientKeyOrDsn - Your Codmir client key, or a DSN (a DSN alone carries no key, so it fails: give the key in `config`)
 * @param config - More of {@link VerifyConfig}, such as `dsn` or `timeout`
 * @returns true only when the server took the test event
 *
 * @example
 * ```typescript
 * const ok = await quickVerify(process.env.NEXT_PUBLIC_CODMIR_CLIENT_KEY);
 * console.log(ok ? 'Connected!' : 'Failed to connect');
 * ```
 */
export async function quickVerify(clientKeyOrDsn: string, config: VerifyConfig = {}): Promise<boolean> {
  const isKey = clientKeyOrDsn.startsWith("osk_") || clientKeyOrDsn.startsWith("csk_");
  const result = await verify({ ...(isKey ? { clientKey: clientKeyOrDsn } : { dsn: clientKeyOrDsn }), ...config });
  return result.success;
}

// =============================================================================
// Print Result
// =============================================================================

/**
 * Format a verification result as a human-readable string
 * suitable for CLI output.
 *
 * @param result - The result from verify()
 * @returns Formatted multi-line string
 *
 * @example
 * ```typescript
 * const result = await verify({ dsn });
 * console.log(printVerifyResult(result));
 * ```
 */
export function printVerifyResult(result: VerifyResult): string {
  const lines: string[] = [];

  lines.push("Codmir SDK Verification");
  lines.push("=======================");

  for (const step of result.steps) {
    if (step.status === "failed") lines.push(`[FAIL] ${step.message}`);
    else if (step.status === "success") lines.push(`[OK]   ${step.message}${step.duration === undefined ? "" : ` ${padDots(step.message, 35)} ${step.duration}ms`}`);
  }

  lines.push("");

  if (result.success) {
    if (result.eventId) {
      lines.push(`Event ID: ${result.eventId}`);
    }
    lines.push(`Total: ${result.totalDuration}ms`);
    lines.push("");
    lines.push("Your Codmir SDK is working! Events will appear in your dashboard shortly.");
  } else if (result.error && !result.steps.some((step) => step.status === "failed")) {
    // A failed step already says it.
    lines.push(`Error: ${result.error}`);
  }

  return lines.join("\n");
}

// =============================================================================
// Internal Helpers
// =============================================================================

function emitStep(
  onProgress: ((step: VerifyStep) => void) | undefined,
  steps: VerifyStep[],
  step: VerifyStep["step"],
  status: VerifyStep["status"],
  message: string,
): VerifyStep {
  const entry: VerifyStep = { step, status, message };
  steps.push(entry);
  onProgress?.(entry);
  return entry;
}

function completeStep(
  onProgress: ((step: VerifyStep) => void) | undefined,
  steps: VerifyStep[],
  existing: VerifyStep,
  status: VerifyStep["status"],
  message: string,
  duration?: number,
): void {
  existing.status = status;
  existing.message = message;
  if (duration !== undefined) {
    existing.duration = duration;
  }
  onProgress?.(existing);
}

function padDots(text: string, width: number): string {
  const dotsNeeded = Math.max(2, width - text.length);
  return ".".repeat(dotsNeeded);
}

// =============================================================================
// Re-exports
// =============================================================================

export {
  coreInit as init,
  coreCaptureException as captureException,
  coreCaptureMessage as captureMessage,
  coreAddBreadcrumb as addBreadcrumb,
  coreFlush as flush,
  coreClose as close,
  getClient,
  type OverseerConfig,
  type UserContext,
  type Breadcrumb,
  type SeverityLevel,
};
