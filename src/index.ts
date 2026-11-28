/**
 * @codmir/sdk - Official Codmir SDK
 *
 * TypeScript/JavaScript SDK for the Codmir API.
 * Use this package for programmatic access to Codmir services.
 *
 * @example
 * ```typescript
 * // API Client
 * import { CodmirClient } from '@codmir/sdk';
 *
 * const client = new CodmirClient({
 *   apiKey: process.env.CODMIR_API_KEY,
 * });
 *
 * // Error Tracking (Next.js)
 * import * as CodmirNext from '@codmir/sdk/nextjs';
 *
 * CodmirNext.init({ clientKey: process.env.NEXT_PUBLIC_CODMIR_CLIENT_KEY });
 *
 * // Error Tracking (React Native)
 * import * as CodmirNative from '@codmir/sdk/react-native';
 *
 * CodmirNative.init({ clientKey: process.env.EXPO_PUBLIC_CODMIR_CLIENT_KEY });
 * ```
 *
 * @packageDocumentation
 */

// Client
export { CodmirClient, default } from "./client";

// Overseer (Error Tracking)
export * as Overseer from "./overseer/index";
import { init as coreInit, close as coreClose, type OverseerConfig } from "./overseer/index";
import { Stops } from "./overseer/lifecycle";
import { installPageErrors, hasPageEvents } from "./overseer/page-errors";

// The error SDK at the root: `import { init, captureException } from "@codmir/sdk"`.
// Same functions and the same singleton client as `@codmir/sdk/overseer`.
export {
  getClient,
  captureException,
  captureMessage,
  setUser,
  setTag,
  setTags,
  addBreadcrumb,
  flush,
  setConversationId,
  getConversationId,
  setSessionId,
  getSessionId,
  getDsn,
  getEnvironment,
  getClientKey,
  getOverseerKey,
  OverseerClient,
  PatchRuntime,
} from "./overseer/index";
export type {
  OverseerConfig,
  OverseerEvent,
  ExceptionData,
  StackFrame,
  UserContext,
  Breadcrumb,
  RequestData,
  SeverityLevel,
  CaptureContext,
  TracesSamplerContext,
  SelfHealingConfig,
  PatchManifest,
  PatchEntry,
  PatchOp,
} from "./overseer/index";

/** What the root `init` started in a browser, ended by `close`. */
const pageStops = new Stops();
/** The debug line is for the page, once: a second `init`, or one after `close`, does not repeat it. */
let browserNoted = false;

/** What the root `init` takes: the error SDK's options and the two page-error switches of `@codmir/sdk/browser`. */
export type RootConfig = OverseerConfig & {
  /** Automatically capture global errors */
  captureGlobalErrors?: boolean;
  /** Automatically capture unhandled promise rejections */
  captureUnhandledRejections?: boolean;
};

/**
 * Starts the error SDK. In a browser (a `window` with `addEventListener`) it also captures uncaught errors and unhandled
 * rejections, the two listeners `@codmir/sdk/browser` installs; a second `init` adds none, and neither does one after
 * `@codmir/sdk/browser` has. It adds no breadcrumbs, request or navigation tracking, or tracing: those are
 * `@codmir/sdk/browser`. Node, workers and React Native install nothing. `captureGlobalErrors: false` and
 * `captureUnhandledRejections: false` leave out one listener each, as in `@codmir/sdk/browser`.
 */
export function init(config: RootConfig = {}): void {
  const { captureGlobalErrors = true, captureUnhandledRejections = true, ...coreConfig } = config;
  coreInit(coreConfig);
  if (!hasPageEvents()) return;
  installPageErrors(pageStops, { errors: captureGlobalErrors, rejections: captureUnhandledRejections });
  if (config.debug && !browserNoted) {
    browserNoted = true;
    console.log("[Overseer]", "@codmir/sdk/browser adds breadcrumbs, request and navigation tracking, and tracing; this entry captures page errors only");
  }
}

/** Ends the SDK as `@codmir/sdk/overseer`'s `close` does, and removes the page listeners `init` installed. */
export function close(timeoutMs?: number): Promise<boolean> {
  pageStops.run();
  return coreClose(timeoutMs);
}

// Types
export type {
  // Config
  CodmirClientConfig,
  CodmirError,
  // Common
  User,
  ApiResponse,
  PaginatedResponse,
  // Project
  Project,
  CreateProjectInput,
  // Ticket
  Ticket,
  CreateTicketInput,
  UpdateTicketInput,
  TicketStatus,
  TicketPriority,
  TicketType,
  // Test Case
  TestCase,
  CreateTestCaseInput,
  UpdateTestCaseInput,
  TestCaseStep,
  TestCasePriority,
  TestCaseStatus,
  TestCaseTemplate,
  // Test Run
  TestRunSummaryInput,
  TestRunRecord,
  TestRunArtifact,
  // Coverage
  CoverageInsightRequest,
  CoverageInsight,
  CoverageFeatureBreakdown,
  CoverageSuggestedTest,
  // Agent
  AgentTask,
  AgentTaskType,
  AgentTaskStatus,
  AgentTaskResult,
  CreateAgentTaskInput,
  RunTaskInput,
  TaskExecution,
  // Framework
  ExecutionEnvironment,
  TaskComplexity,
  TaskPriority,
  FrameworkTaskRequest,
  FrameworkTaskResponse,
  FrameworkTaskStatus,
  FrameworkResourceStatus,
  FrameworkMetrics,
} from "./types";

// Error class
export { CodmirApiError } from "./types";

// Schemas for validation
export { CreateTicketSchema, CreateAgentTaskSchema } from "./types";
