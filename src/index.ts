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
 * import * as Codmir from '@codmir/sdk/nextjs';
 *
 * Codmir.init({ dsn: process.env.NEXT_PUBLIC_CODMIR_DSN });
 *
 * // Error Tracking (React Native)
 * import * as Codmir from '@codmir/sdk/react-native';
 *
 * Codmir.init({ dsn: 'https://your-project.codmir.com/api/overseer' });
 * ```
 *
 * @packageDocumentation
 */

// Client
export { CodmirClient, default } from "./client";

// Overseer (Error Tracking)
export * as Overseer from "./overseer/index";

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

// Framework Helpers
export { FrameworkTaskBuilder, FrameworkHelpers } from "./framework";

// AI Instructions (for system prompts and MCP)
export {
  SDK_QUICK_REFERENCE,
  SDK_SYSTEM_INSTRUCTIONS,
  SDK_MCP_TOOLS_DESCRIPTION,
  SDK_TOPICS,
  getSDKInstructions,
} from "./ai-instructions";
export type { SDKMethod, SDKTopic } from "./ai-instructions";
