/**
 * @codmir/sdk/verify - Connection Verification
 *
 * Verify your Codmir SDK setup by sending a test event
 * and confirming it was received. Used during onboarding
 * after installing the SDK.
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

import {
  init as coreInit,
  captureException as coreCaptureException,
  captureMessage as coreCaptureMessage,
  setTag as coreSetTag,
  setTags as coreSetTags,
  addBreadcrumb as coreAddBreadcrumb,
  flush as coreFlush,
  close as coreClose,
  getClient,
  type OverseerConfig,
  type UserContext,
  type Breadcrumb,
  type SeverityLevel,
} from "../overseer/index";

// =============================================================================
// Types
// =============================================================================

export interface VerifyConfig extends OverseerConfig {
  /** Optional timeout for connection test in milliseconds (default 10000) */
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
 * Verify SDK connection by initializing, sending a test event,
 * flushing, and confirming the round-trip.
 *
 * @param config - Verification configuration extending OverseerConfig
 * @returns Result object with success status, event ID, step details, and timing
 *
 * @example
 * ```typescript
 * const result = await verify({
 *   dsn: 'https://your-project.codmir.com/api/overseer',
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
  const { timeout = 10000, onProgress, ...overseerConfig } = config;
  const steps: VerifyStep[] = [];
  const totalStart = Date.now();

  // -------------------------------------------------------------------------
  // Step 1: Init
  // -------------------------------------------------------------------------
  const initStep = emitStep(onProgress, steps, "init", "running", "Initializing SDK...");

  try {
    const initStart = Date.now();
    coreInit(overseerConfig);
    completeStep(onProgress, steps, initStep, "success", "Initialize SDK", Date.now() - initStart);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    completeStep(onProgress, steps, initStep, "failed", `Initialize SDK failed: ${message}`);
    return {
      success: false,
      steps,
      totalDuration: Date.now() - totalStart,
      error: message,
    };
  }

  // -------------------------------------------------------------------------
  // Step 2: Send test event
  // -------------------------------------------------------------------------
  const sendStep = emitStep(onProgress, steps, "send", "running", "Sending test event...");
  let eventId: string;

  try {
    const sendStart = Date.now();

    coreSetTags({
      source: "sdk-verify",
      sdk_version: "1.0.1",
    });

    eventId = coreCaptureMessage("Codmir SDK setup verified", "info");

    if (!eventId) {
      completeStep(onProgress, steps, sendStep, "failed", "Send test event failed: no event ID returned");
      return {
        success: false,
        steps,
        totalDuration: Date.now() - totalStart,
        error: "Failed to capture test event — SDK may be disabled or sampling excluded it",
      };
    }

    completeStep(onProgress, steps, sendStep, "success", "Send test event", Date.now() - sendStart);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    completeStep(onProgress, steps, sendStep, "failed", `Send test event failed: ${message}`);
    return {
      success: false,
      steps,
      totalDuration: Date.now() - totalStart,
      error: message,
    };
  }

  // -------------------------------------------------------------------------
  // Step 3: Flush
  // -------------------------------------------------------------------------
  const flushStep = emitStep(onProgress, steps, "flush", "running", "Flushing events...");

  try {
    const flushStart = Date.now();
    const flushed = await coreFlush(timeout);
    const flushDuration = Date.now() - flushStart;

    if (flushed) {
      completeStep(onProgress, steps, flushStep, "success", "Flush events", flushDuration);
    } else {
      // Warn but don't fail — events may still arrive
      completeStep(
        onProgress,
        steps,
        flushStep,
        "success",
        "Flush events (timed out, events may still be in transit)",
        flushDuration,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Flush failure is non-fatal
    completeStep(onProgress, steps, flushStep, "success", `Flush events (warning: ${message})`);
  }

  // -------------------------------------------------------------------------
  // Step 4: Confirm
  // -------------------------------------------------------------------------
  const confirmStep = emitStep(onProgress, steps, "confirm", "running", "Confirming connection...");
  completeStep(onProgress, steps, confirmStep, "success", "Connection verified");

  return {
    success: true,
    eventId,
    steps,
    totalDuration: Date.now() - totalStart,
  };
}

// =============================================================================
// Quick Verify
// =============================================================================

/**
 * Simplified one-liner to verify SDK connectivity.
 *
 * @param dsn - Your Codmir DSN string
 * @returns true if the connection was verified successfully
 *
 * @example
 * ```typescript
 * const ok = await quickVerify('https://your-project.codmir.com/api/overseer');
 * console.log(ok ? 'Connected!' : 'Failed to connect');
 * ```
 */
export async function quickVerify(dsn: string): Promise<boolean> {
  const result = await verify({ dsn });
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
    if (step.status === "failed") {
      lines.push(`[FAIL] ${step.message}`);
    } else if (step.status === "success") {
      const durationStr =
        step.duration !== undefined ? ` ${padDots(step.message, 35)} ${step.duration}ms` : "";
      if (durationStr) {
        lines.push(`[OK]   ${step.message} ${padDots(step.message, 35)} ${step.duration}ms`);
      } else {
        lines.push(`[OK]   ${step.message}`);
      }
    }
  }

  lines.push("");

  if (result.success) {
    if (result.eventId) {
      lines.push(`Event ID: ${result.eventId}`);
    }
    lines.push(`Total: ${result.totalDuration}ms`);
    lines.push("");
    lines.push("Your Codmir SDK is working! Events will appear in your dashboard shortly.");
  } else {
    if (result.error) {
      lines.push(`Error: ${result.error}`);
    }
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
