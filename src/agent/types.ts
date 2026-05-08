/**
 * Codmir Agent SDK Type Definitions
 * 
 * Comprehensive type system for the Codmir Agent SDK
 */

// ═══════════════════════════════════════════════════════════════════════════
// Core Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Agent SDK Configuration
 */
export interface AgentConfig {
  // Autonomy Settings
  autonomyMode: 'conservative' | 'balanced' | 'aggressive' | 'autonomus'
  confidenceThreshold: number | { low: number; medium: number; high: number }
  learningEnabled: boolean

  // Intelligence Levels
  contextDepth: 'shallow' | 'medium' | 'deep' | 'omniscient'
  planningHorizon: 'immediate' | 'tactical' | 'strategic' | 'visionary'

  // System Integration
  apiEndpoint?: string
  apiKey?: string
  projectId?: string
  userId?: string

  // Feature Toggles
  features: {
    conversationIntelligence: boolean
    codebaseAnalysis: boolean
    automaticTaskCreation: boolean
    proactiveTicketGeneration: boolean
    strategicPlanning: boolean
    learningFromFailures: boolean
  }

  // Task Management
  taskBreakdown?: {
    maxSubtasks: number
    autoEstimate: boolean
  }
  enableAutonomousActions?: boolean

  // Limits and Safety
  maxActionsPerMinute: number
  maxConcurrentTasks: number
  safetyChecksEnabled: boolean
  humanApprovalRequired: string[] // Action types requiring approval

  // Learning Configuration
  learning: {
    memoryRetentionDays: number
    patternRecognitionEnabled: boolean
    successMetricsTracking: boolean
    failureAnalysisEnabled: boolean
  }
}

/**
 * Alias for AgentConfig used across the SDK
 */
export type autonomusConfig = AgentConfig;

// ═══════════════════════════════════════════════════════════════════════════
// Context System
// ═══════════════════════════════════════════════════════════════════════════

export interface Context {
  // Conversation Context
  conversation: {
    id: string
    messages: ContextMessage[]
    intent: ConversationIntent
    sentiment: 'positive' | 'neutral' | 'frustrated' | 'urgent'
    topics: string[]
    keywords: string[]
    entities: ContextEntity[]
  }

  // Project Context
  project: {
    id: string
    name: string
    description: string
    techStack: string[]
    codebaseAnalysis: CodebaseSnapshot
    recentChanges: CodeChange[]
    activeTickets: TicketContext[]
    activeTasks: TaskContext[]
    type: string
  }

  // User Context
  user: {
    id: string
    role: string
    expertise: string[]
    preferences: UserPreferences
    workingHours: TimeRange[]
    currentFocus: string[]
    recentActivity: UserActivity[]
  }

  // System Context
  system: {
    timestamp: string
    sessionId: string
    capabilities: SystemCapability[]
    performance: PerformanceMetrics
    environment: 'development' | 'staging' | 'production'
  }
  workflow?: any
  metadata?: Record<string, any>
}

export interface ContextMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  intent: string[]
  entities: ContextEntity[]
  metadata: Record<string, any>
}

export interface ContextEntity {
  type: 'person' | 'technology' | 'file' | 'ticket' | 'task' | 'feature' | 'bug' | 'endpoint'
  value: string
  confidence: number
  metadata: Record<string, any>
}

export interface ConversationIntent {
  primary: string // 'question' | 'request' | 'problem' | 'planning' | 'debug' | 'feature'
  secondary: string[]
  confidence: number
  urgency: 'low' | 'medium' | 'high' | 'critical'
  complexity: 'simple' | 'moderate' | 'complex' | 'expert'
}

// ═══════════════════════════════════════════════════════════════════════════
// Planning System
// ═══════════════════════════════════════════════════════════════════════════

export interface Plan {
  id: string
  title: string
  description: string
  context: Context

  // Plan Structure
  objectives: Objective[]
  phases: Phase[]
  dependencies: Dependency[]
  risks: Risk[]

  // Execution Details
  estimatedDuration: number // minutes
  confidence: number
  priority: 'low' | 'medium' | 'high' | 'critical'
  status: 'draft' | 'approved' | 'executing' | 'paused' | 'completed' | 'failed'

  // Metadata
  createdAt: string
  updatedAt: string
  createdBy: string
  approvedBy?: string
}

export interface Objective {
  id: string
  description: string
  successCriteria: string[]
  priority: number
  estimatedEffort: number
  dependencies: string[] // Other objective IDs
}

export interface Phase {
  id: string
  name: string
  description: string
  actions: Action[]
  duration: number
  dependencies: string[] // Phase IDs
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
}

export interface Dependency {
  type: 'internal' | 'external' | 'resource' | 'approval'
  description: string
  required: boolean
  estimatedResolutionTime: number
}

export interface Risk {
  type: 'technical' | 'resource' | 'timeline' | 'dependency' | 'quality'
  description: string
  impact: 'low' | 'medium' | 'high' | 'critical'
  probability: number
  mitigation: string
}

// ═══════════════════════════════════════════════════════════════════════════
// Action System
// ═══════════════════════════════════════════════════════════════════════════

export interface Action {
  id: string
  type: ActionType
  title: string
  description: string

  // Input and Configuration
  input: ActionInput
  parameters: Record<string, any>

  // Execution
  status: ActionStatus
  result?: ActionResult
  confidence: number
  requiredCapabilities: string[]

  // Context
  reasoning: string
  alternatives: Alternative[]
  risks: string[]

  // Metadata
  createdAt: string
  executedAt?: string
  duration?: number
  retryCount: number
  maxRetries: number
}

export type ActionType =
  | 'create_ticket'
  | 'create_task'
  | 'update_ticket'
  | 'analyze_code'
  | 'generate_code'
  | 'run_command'
  | 'ask_question'
  | 'make_decision'
  | 'gather_information'
  | 'notify_user'
  | 'escalate'
  | 'learn'
  | 'optimize'
  | 'execute'

export type ActionStatus =
  | 'planned'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'pending_approval'

export interface ActionInput {
  contextId: string
  requiredData: Record<string, any>
  optionalData?: Record<string, any>
  constraints: Constraint[]
}

export interface ActionResult {
  success: boolean
  output: any
  artifacts: Artifact[]
  confidence: number
  executionTime: number
  resourcesUsed: Resource[]
  sideEffects: SideEffect[]
  learnings: Learning[]
}

export interface Alternative {
  description: string
  confidence: number
  tradeoffs: string[]
  estimatedOutcome: string
}

// ═══════════════════════════════════════════════════════════════════════════
// Decision System
// ═══════════════════════════════════════════════════════════════════════════

export interface Decision {
  id: string
  question: string
  options: DecisionOption[]
  chosen: string // Option ID
  reasoning: string
  confidence: number
  context: Context

  // Decision Factors
  factors: DecisionFactor[]
  constraints: Constraint[]
  tradeoffs: Tradeoff[]

  // Outcomes
  expectedOutcome: string
  actualOutcome?: string
  satisfaction?: number // 0-1, how well it worked

  // Metadata
  madeAt: string
  madeBy: string
  reviewedAt?: string
  reviewedBy?: string
}

export interface DecisionOption {
  id: string
  title: string
  description: string
  pros: string[]
  cons: string[]
  effort: number
  risk: number
  confidence: number
  estimatedOutcome: string
}

export interface DecisionFactor {
  name: string
  importance: number
  value: number
  reasoning: string
}

export interface Tradeoff {
  giving_up: string
  getting: string
  worthIt: boolean
  reasoning: string
}

export interface DecisionOptions {
  description: string
  options?: string[]
  context?: any
}

export interface DecisionResult {
  success: boolean
  decision: Decision
  confidence: number
  reasoning: string
}

export interface PlanResult {
  success: boolean
  plan: Plan
  confidence: number
  reasoning: string
}

export interface PlanObjective {
  description: string
  requirements?: string[]
  constraints?: string[]
}

// ═══════════════════════════════════════════════════════════════════════════
// Learning System
// ═══════════════════════════════════════════════════════════════════════════

export interface Learning {
  id: string
  type: 'success' | 'failure' | 'pattern' | 'insight' | 'optimization'
  description: string
  context: LearningContext

  // Learning Content
  whatHappened: string
  whyItHappened: string
  whatToDoNext: string
  confidence: number

  // Application
  applicableContexts: string[]
  actionableInsights: string[]
  preventionMeasures?: string[]
  optimizationOpportunities?: string[]

  // Metadata
  learnedAt: string
  importance: number
  verified: boolean
  timesApplied: number
  successRate: number
}

export interface LearningContext {
  situation: string
  factors: Record<string, any>
  environment: Record<string, any>
  actors: string[]
  timeframe: string
}

// ═══════════════════════════════════════════════════════════════════════════
// Agent Capabilities
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentCapability {
  name: string
  version: string
  description: string
  enabled?: boolean

  // Capability Definition
  inputs: CapabilityInput[]
  outputs: CapabilityOutput[]
  prerequisites: string[]

  // Performance
  averageExecutionTime: number
  successRate: number
  confidence: number

  // Constraints
  rateLimits: RateLimit[]
  resourceRequirements: ResourceRequirement[]
  safetyChecks: string[]
}

export interface CapabilityInput {
  name: string
  type: string
  required: boolean
  description: string
  validation: string
}

export interface CapabilityOutput {
  name: string
  type: string
  description: string
  schema: Record<string, any>
}

// ═══════════════════════════════════════════════════════════════════════════
// Intelligence Levels
// ═══════════════════════════════════════════════════════════════════════════

export type IntelligenceLevel = 'basic' | 'intermediate' | 'advanced' | 'expert' | 'superhuman'

export type AutonomyMode = 'conservative' | 'balanced' | 'aggressive' | 'autonomus'

// ═══════════════════════════════════════════════════════════════════════════
// Supporting Types
// ═══════════════════════════════════════════════════════════════════════════

export interface CodebaseSnapshot {
  totalFiles: number
  totalLines: number
  languages: Record<string, number>
  complexity: 'simple' | 'moderate' | 'complex' | 'expert'
  architecture: string[]
  patterns: string[]
  issues: CodeIssue[]
  hotspots: string[]
  lastAnalyzed: string
}

export interface CodeChange {
  id: string
  type: 'feature' | 'bugfix' | 'refactor' | 'docs' | 'chore' | 'test' | 'build' | 'ci' | 'other' | 'performance' | 'security' | 'maintainability' | 'complexity' | 'other' | 'maintenance'
  files: string[]
  description: string
  author: string
  timestamp: string
  impact: 'low' | 'medium' | 'high' | 'critical'
}

export interface CodeIssue {
  type: 'bug' | 'security' | 'performance' | 'maintainability' | 'complexity'
  severity: 'low' | 'medium' | 'high' | 'critical'
  file: string
  line?: number
  description: string
  suggestion?: string
}

export interface TicketContext {
  id: string
  title: string
  status: string
  priority: string
  assignee?: string
  description: string
  labels: string[]
  createdAt: string
  updatedAt: string
}

export interface TaskContext {
  id: string
  title: string
  status: string
  progress: number
  estimatedCompletion?: string
  assignee?: string
  dependencies: string[]
}

export interface UserPreferences {
  communicationStyle: 'concise' | 'detailed' | 'technical' | 'friendly'
  workingStyle: 'autonomous' | 'collaborative' | 'guided'
  notificationPrefs: string[]
  toolPreferences: string[]
}

export interface UserActivity {
  type: 'code' | 'review' | 'meeting' | 'planning' | 'learning'
  description: string
  timestamp: string
  duration: number
  outcome: string
}

export interface TimeRange {
  start: string
  end: string
  timezone: string
}

export interface SystemCapability {
  name: string
  available: boolean
  performance: number
  lastChecked: string
}

export interface PerformanceMetrics {
  responseTime: number
  throughput: number
  errorRate: number
  resourceUtilization: number
}

export interface Constraint {
  type: 'time' | 'resource' | 'dependency' | 'approval' | 'technical' | 'business'
  description: string
  severity: 'soft' | 'hard'
  impact: string
}

export interface Artifact {
  type: 'file' | 'data' | 'report' | 'code' | 'documentation' | 'plan'
  name: string
  path?: string
  content: any
  metadata: Record<string, any>
}

export interface Resource {
  type: 'cpu' | 'memory' | 'storage' | 'network' | 'api_calls' | 'time'
  amount: number
  unit: string
  cost?: number
}

export interface SideEffect {
  type: 'created' | 'modified' | 'deleted' | 'triggered' | 'notified'
  target: string
  description: string
  reversible: boolean
}

export interface RateLimit {
  operation: string
  maxRequests: number
  timeWindow: number // seconds
  currentUsage: number
}

export interface ResourceRequirement {
  type: string
  amount: number
  unit: string
  critical: boolean
}

// ═══════════════════════════════════════════════════════════════════════════
// Integration Results
// ═══════════════════════════════════════════════════════════════════════════

export interface TicketCreationResult {
  success: boolean
  ticketId?: string
  ticketUrl?: string
  ticket?: TicketContext
  confidence: number
  reasoning?: string
}

export interface TaskCreationResult {
  success: boolean
  taskId?: string
  task?: TaskContext
  confidence: number
  reasoning?: string
}

export interface CodeGenerationResult {
  success: boolean
  files?: Array<{
    path: string
    content: string
    language: string
  }>
  generatedCode?: string
  confidence: number
  reasoning?: string
}

// ═══════════════════════════════════════════════════════════════════════════
// Type Aliases for Context Sub-types
// ═══════════════════════════════════════════════════════════════════════════

export type ConversationContext = Context['conversation']
export type ProjectContext = Context['project']
export type UserContext = Context['user']
export type CodebaseContext = CodebaseSnapshot

export type PlanPhase = Phase

// ═══════════════════════════════════════════════════════════════════════════
// Agent Intelligence & Metrics
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentInsights {
  patterns: string[]
  recommendations: string[]
  risks: string[]
  opportunities: string[]
  confidence: number
}

export interface AgentMetrics {
  decisionsMade: number
  actionsExecuted: number
  successRate: number
  averageConfidence: number
  learningsGained: number
  uptime: number
}

export interface TicketResolution {
  ticketId: string
  resolution: string
  resolvedAt: string
  resolvedBy: string
  timeToResolve: number
  satisfaction?: number
}
