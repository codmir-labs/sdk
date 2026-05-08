import { z } from "zod";

// ============================================
// Configuration
// ============================================

export interface CodmirClientConfig {
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  headers?: Record<string, string>;
}

// ============================================
// Agent Framework Types
// ============================================

export type ExecutionEnvironment = 'main_agent' | 'worker_minion' | 'hybrid';

export type TaskComplexity = 'simple' | 'medium' | 'complex' | 'enterprise';

export type TaskPriority = 'low' | 'medium' | 'high' | 'critical' | 'emergency';

export interface FrameworkTaskRequest {
  title: string;
  description: string;
  type: 'code_analysis' | 'file_processing' | 'code_generation' | 'full_feature_development' | 'api_integration' | 'documentation';
  complexity?: TaskComplexity;
  priority?: TaskPriority;
  context: {
    projectId: string;
    userId: string;
    files?: string[];
    repository?: {
      url: string;
      branch?: string;
    };
    environment?: Record<string, any>;
  };
  preferences?: {
    executionEnvironment?: ExecutionEnvironment;
    maxDuration?: number;
    costLimit?: number;
    requireApproval?: boolean;
  };
}

export interface FrameworkTaskResponse {
  taskId: string;
  status: 'queued' | 'planning' | 'executing' | 'completed' | 'failed';
  executionPlan?: {
    totalSteps: number;
    estimatedDuration: number;
    resourcesRequired: {
      agents: number;
      minions: number;
    };
    estimatedCost: number;
  };
  streamUrl?: string;
  webhookUrl?: string;
}

export interface FrameworkTaskStatus {
  taskId: string;
  status: 'queued' | 'planning' | 'executing' | 'completed' | 'failed' | 'cancelled';
  progress: {
    completedSteps: number;
    totalSteps: number;
    currentStep?: string;
    percentage: number;
  };
  execution: {
    startedAt?: string;
    estimatedCompletion?: string;
    actualCompletion?: string;
    duration?: number;
  };
  resources: {
    agentsUsed: number;
    minionsUsed: number;
    currentCost: number;
  };
  results?: {
    success: boolean;
    summary: {
      totalSteps: number;
      successfulSteps: number;
      failedSteps: number;
      totalExecutionTime: number;
      filesChanged: string[];
      errors: string[];
      warnings: string[];
    };
  };
  error?: string;
}

export interface FrameworkResourceStatus {
  agents: {
    total: number;
    available: number;
    busy: number;
    offline: number;
  };
  minions: {
    total: number;
    available: number;
    busy: number;
    offline: number;
    regions: string[];
  };
  capacity: {
    currentLoad: number;
    maxConcurrentTasks: number;
    queuedTasks: number;
  };
}

export interface FrameworkMetrics {
  tasks: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    averageExecutionTime: number;
    successRate: number;
  };
  performance: {
    agentUtilization: number;
    minionUtilization: number;
    parallelizationEfficiency: number;
    costPerTask: number;
  };
  resources: {
    agents: {
      count: number;
      averageLoad: number;
      healthScore: number;
    };
    minions: {
      count: number;
      averageLatency: number;
      healthScore: number;
      globalDistribution: Record<string, number>;
    };
  };
}

// ============================================
// Error Handling
// ============================================

export interface CodmirError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  statusCode?: number;
}

export class CodmirApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode?: number,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CodmirApiError";
  }
}

// ============================================
// Common Types
// ============================================

export interface User {
  id: string;
  email: string;
  name?: string;
  avatar?: string;
  createdAt: string;
}

export interface ApiResponse<T> {
  data: T;
  success: boolean;
  error?: CodmirError;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
}

// ============================================
// Project Types
// ============================================

export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  description?: string;
  organizationId: string;
}

// ============================================
// Ticket Types
// ============================================

export type TicketStatus = "open" | "in_progress" | "review" | "done" | "closed";
export type TicketPriority = "low" | "medium" | "high" | "critical";
export type TicketType = "bug" | "feature" | "task" | "improvement" | "epic";

export interface Ticket {
  id: string;
  title: string;
  description?: string;
  status: TicketStatus;
  priority: TicketPriority;
  type: TicketType;
  projectId: string;
  assigneeId?: string;
  reporterId: string;
  labels?: string[];
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTicketInput {
  title: string;
  description?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  type?: TicketType;
  projectId: string;
  assigneeId?: string;
  labels?: string[];
  dueDate?: string;
}

export interface UpdateTicketInput {
  title?: string;
  description?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  type?: TicketType;
  assigneeId?: string;
  labels?: string[];
  dueDate?: string;
}

// ============================================
// Test Case Types
// ============================================

export type TestCasePriority = "low" | "medium" | "high" | "critical";
export type TestCaseStatus = "draft" | "active" | "deprecated";

export interface TestCaseStep {
  order: number;
  action: string;
  expectedResult: string;
}

export interface TestCase {
  id: string;
  title: string;
  description?: string;
  steps: TestCaseStep[];
  priority: TestCasePriority;
  status: TestCaseStatus;
  projectId: string;
  ticketId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTestCaseInput {
  title: string;
  description?: string;
  steps: TestCaseStep[];
  priority?: TestCasePriority;
  projectId: string;
  ticketId?: string;
}

export interface UpdateTestCaseInput {
  title?: string;
  description?: string;
  steps?: TestCaseStep[];
  priority?: TestCasePriority;
  status?: TestCaseStatus;
}

export interface TestCaseTemplate {
  id: string;
  name: string;
  description?: string;
  steps: TestCaseStep[];
}

// ============================================
// Test Run Types
// ============================================

export interface TestRunSummaryInput {
  projectId: string;
  testRunId: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  coverage?: number;
  failedTests?: TestRunRecord[];
  artifacts?: TestRunArtifact[];
}

export interface TestRunRecord {
  name: string;
  error?: string;
  duration?: number;
}

export interface TestRunArtifact {
  name: string;
  url: string;
  type: "screenshot" | "video" | "log" | "report";
}

// ============================================
// Coverage Types
// ============================================

export interface CoverageInsightRequest {
  projectId: string;
  coverage: number;
  uncoveredLines?: number;
  uncoveredBranches?: number;
  files?: Array<{
    path: string;
    coverage: number;
    uncoveredLines?: number[];
  }>;
}

export interface CoverageInsight {
  summary: string;
  riskAreas: string[];
  suggestions: CoverageSuggestedTest[];
  featureBreakdown?: CoverageFeatureBreakdown[];
}

export interface CoverageFeatureBreakdown {
  feature: string;
  coverage: number;
  risk: "low" | "medium" | "high";
}

export interface CoverageSuggestedTest {
  title: string;
  description: string;
  priority: TestCasePriority;
  targetFile?: string;
}

// ============================================
// Agent Types
// ============================================

export type AgentTaskType = 
  | "code_review"
  | "bug_fix"
  | "feature_implementation"
  | "refactor"
  | "documentation"
  | "test_generation"
  | "analysis"
  | "custom";

export type AgentTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentTask {
  id: string;
  type: AgentTaskType;
  status: AgentTaskStatus;
  prompt: string;
  context?: Record<string, unknown>;
  result?: AgentTaskResult;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentTaskResult {
  success: boolean;
  output?: string;
  artifacts?: Array<{
    type: "file" | "diff" | "suggestion";
    path?: string;
    content: string;
  }>;
  error?: string;
  tokensUsed?: number;
  duration?: number;
}

export interface CreateAgentTaskInput {
  type: AgentTaskType;
  prompt: string;
  context?: Record<string, unknown>;
  projectId?: string;
}

export interface RunTaskInput {
  taskId: string;
  options?: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
  };
}

export interface TaskExecution {
  taskId: string;
  status: AgentTaskStatus;
  progress?: number;
  currentStep?: string;
  logs?: string[];
}

// ============================================
// Zod Schemas (for validation)
// ============================================

export const CreateTicketSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  status: z.enum(["open", "in_progress", "review", "done", "closed"]).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  type: z.enum(["bug", "feature", "task", "improvement", "epic"]).optional(),
  projectId: z.string().uuid(),
  assigneeId: z.string().uuid().optional(),
  labels: z.array(z.string()).optional(),
  dueDate: z.string().datetime().optional(),
});

export const CreateAgentTaskSchema = z.object({
  type: z.enum([
    "code_review",
    "bug_fix",
    "feature_implementation",
    "refactor",
    "documentation",
    "test_generation",
    "analysis",
    "custom",
  ]),
  prompt: z.string().min(1),
  context: z.record(z.unknown()).optional(),
  projectId: z.string().uuid().optional(),
});
