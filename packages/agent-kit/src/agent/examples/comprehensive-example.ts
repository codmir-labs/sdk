/**
 * autonomus SDK Comprehensive Example
 *
 * This example demonstrates the full capabilities of the autonomus SDK,
 * including autonomous decision-making, intelligent analysis, and
 * seamless integration with chat and CLI interfaces.
 */

import {
  createAgentSDK,
  createChatAgent,
  AgentPresets,
  IntegrationPresets
} from '../index'
import type {
  autonomusConfig,
  Context
} from '../index'

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

const config: autonomusConfig = {
  // Use balanced autonomy mode for intelligent decision-making
  autonomyMode: 'balanced',

  // Enable autonomous actions with reasonable confidence thresholds
  enableAutonomousActions: true,
  confidenceThreshold: AgentPresets.balanced.confidenceThreshold,

  // Enable learning from interactions
  learningEnabled: true,

  // Context and planning defaults
  contextDepth: 'medium',
  planningHorizon: 'tactical',

  // Feature toggles
  features: {
    conversationIntelligence: true,
    codebaseAnalysis: true,
    automaticTaskCreation: true,
    proactiveTicketGeneration: true,
    strategicPlanning: true,
    learningFromFailures: true
  },

  // Limits and safety
  maxActionsPerMinute: 30,
  maxConcurrentTasks: 5,
  safetyChecksEnabled: true,
  humanApprovalRequired: ['deploy', 'delete'],

  // Learning configuration
  learning: {
    memoryRetentionDays: 90,
    patternRecognitionEnabled: true,
    successMetricsTracking: true,
    failureAnalysisEnabled: true
  },

  // Set reasonable timeouts
  actionTimeout: 30000,
  planningTimeout: 10000,

  // Enable experimental features for advanced capabilities
  enableExperimentalFeatures: true,

  // Configure verbosity for debugging
  verbosityLevel: 'normal'
} as autonomusConfig

// ═══════════════════════════════════════════════════════════════════════════
// Example 1: Basic SDK Usage
// ═══════════════════════════════════════════════════════════════════════════

async function basicSDKExample() {
  console.log('\n Example 1: Basic SDK Usage\n')

  // Create and initialize the SDK
  const sdk = await createAgentSDK(config)

  // Create a sample context
  const context: Context = {
    conversation: {
      id: 'conv-123',
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          content: 'I need to fix a bug in the authentication system',
          timestamp: new Date().toISOString(),
          intent: ['bug_report'],
          entities: [],
          metadata: {}
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'I can help you with that. Let me analyze the issue.',
          timestamp: new Date().toISOString(),
          intent: ['acknowledge'],
          entities: [],
          metadata: {}
        }
      ],
      intent: {
        primary: 'bug_report',
        secondary: ['urgent'],
        confidence: 0.9,
        urgency: 'high',
        complexity: 'moderate'
      },
      sentiment: 'neutral',
      topics: ['authentication', 'bug'],
      keywords: ['fix', 'bug', 'authentication'],
      entities: []
    },
    project: {
      id: 'proj-456',
      name: 'MyApp',
      type: 'web',
      description: 'A web application with authentication issues',
      techStack: ['Next.js', 'TypeScript'],
      codebaseAnalysis: {
        totalFiles: 100,
        totalLines: 10000,
        languages: { typescript: 8000, css: 2000 },
        complexity: 'moderate',
        architecture: ['monorepo'],
        patterns: ['mvc'],
        issues: [],
        hotspots: [],
        lastAnalyzed: new Date().toISOString()
      },
      recentChanges: [],
      activeTickets: [],
      activeTasks: []
    },
    user: {
      id: 'user-789',
      name: 'Developer',
      role: 'engineer',
      expertise: ['javascript', 'typescript'],
      preferences: {
        communicationStyle: 'technical',
        workingStyle: 'autonomous',
        notificationPrefs: [],
        toolPreferences: []
      },
      workingHours: [],
      currentFocus: [],
      recentActivity: []
    },
    system: {
      timestamp: new Date().toISOString(),
      sessionId: 'session-001',
      platform: 'darwin',
      environment: 'development',
      capabilities: [
        { name: 'file_access', available: true, performance: 1, lastChecked: new Date().toISOString() },
        { name: 'code_execution', available: true, performance: 1, lastChecked: new Date().toISOString() }
      ],
      performance: {
        responseTime: 100,
        throughput: 50,
        errorRate: 0.01,
        resourceUtilization: 0.5
      },
      resources: {
        cpu: 8,
        memory: 16384,
        storage: 512000
      }
    }
  } as Context

  // Make an autonomous decision
  const decision = await sdk.makeDecision(context, {
    requireConfirmation: false,
    maxAlternatives: 3
  })

  console.log('Autonomous Decision:')
  console.log(`  Action: ${decision.decision?.action.type}`)
  console.log(`  Confidence: ${decision.decision?.confidence}`)
  console.log(`  Reasoning: ${decision.decision?.reasoning}`)

  // Create an execution plan
  const plan = await sdk.createPlan(
    {
      description: 'Fix authentication bug',
      requirements: ['analyze_code', 'identify_issue', 'implement_fix', 'test_solution'],
      constraints: ['maintain_backward_compatibility', 'no_breaking_changes']
    },
    context
  )

  console.log('\nExecution Plan:')
  if (plan.success && plan.plan) {
    console.log(`  Phases: ${plan.plan.phases.length}`)
    console.log(`  Estimated Duration: ${plan.plan.estimatedDuration}ms`)
    console.log(`  Risk Level: ${plan.plan.riskAssessment.overallRisk}`)
  }

  // Get SDK insights
  const insights = await sdk.getSDKInsights()
  console.log('\nSDK Insights:')
  console.log(`  Engine Health: ${insights.engine.performanceMetrics.averageDecisionTime}ms avg decision time`)
  console.log(`  Active Agents: ${Object.keys(insights.agents).length}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// Example 2: Chat Integration
// ═══════════════════════════════════════════════════════════════════════════

async function chatIntegrationExample() {
  console.log('\nExample 2: Chat Integration\n')

  const sdk = await createAgentSDK(config)
  const chatIntegration = sdk.integrations.chat

  // Process a chat message
  const result = await chatIntegration.processChatMessage({
    conversationId: 'chat-001',
    message: {
      id: 'msg-123',
      content: 'Create a ticket for the login bug where users get stuck on the loading screen',
      role: 'user',
      timestamp: new Date().toISOString()
    },
    context: createSampleContext(),
    userPreferences: {
      autonomyLevel: 'balanced',
      preferredConfidenceThreshold: 0.75
    }
  })

  console.log('Chat Processing Result:')
  console.log(`  Intent: ${result.analysis.intent.primary}`)
  console.log(`  Confidence: ${result.analysis.confidence}`)
  console.log(`  Urgency: ${result.analysis.urgency}`)
  console.log(`  Actions Executed: ${result.executedActions.length}`)

  // Display executed actions
  if (result.executedActions.length > 0) {
    console.log('\nExecuted Actions:')
    result.executedActions.forEach((action: any) => {
      console.log(`  - ${action.type}: ${action.success ? 'Success' : 'Failed'}`)
    })
  }

  // Display response suggestions
  console.log('\nResponse Suggestions:')
  result.responseSuggestions.forEach((suggestion: any) => {
    console.log(`  - ${suggestion.type}: "${suggestion.content.substring(0, 50)}..."`)
  })

  // Get conversation insights
  const insights = await chatIntegration.getConversationInsights('chat-001')
  console.log('\nConversation Insights:')
  console.log(`  Actionable Items: ${insights.actionableItems.length}`)
  console.log(`  Next Steps: ${insights.nextSteps.join(', ')}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// Example 3: CLI Integration
// ═══════════════════════════════════════════════════════════════════════════

async function cliIntegrationExample() {
  console.log('\nExample 3: CLI Integration\n')

  const sdk = await createAgentSDK(config)
  const cliIntegration = sdk.integrations.cli

  // Process a CLI command
  const commandResult = await cliIntegration.processCommand({
    sessionId: 'cli-session-001',
    command: {
      type: 'create',
      args: ['task', 'implement-auth-fix'],
      options: {
        priority: 'high',
        assignee: '@me'
      }
    },
    context: createSampleContext(),
    options: {
      verbose: true,
      dryRun: false
    }
  })

  console.log('Command Processing Result:')
  console.log(`  Command: ${commandResult.command.type} ${commandResult.command.args.join(' ')}`)
  console.log(`  Success: ${commandResult.executionResult.success}`)
  console.log(`  Execution Time: ${commandResult.executionResult.totalDuration}ms`)

  // Get autocomplete suggestions
  const suggestions = await cliIntegration.getAutocompleteSuggestions({
    sessionId: 'cli-session-001',
    partialCommand: 'deploy ',
    context: createSampleContext(),
    cursorPosition: 7
  })

  console.log('\nAutocomplete Suggestions:')
  suggestions.slice(0, 5).forEach((suggestion: any) => {
    console.log(`  - ${suggestion.text}: ${suggestion.description}`)
  })

  // Execute a workflow
  const workflowResult = await cliIntegration.executeWorkflow({
    sessionId: 'cli-session-001',
    workflow: {
      name: 'fix-and-deploy',
      description: 'Fix authentication bug and deploy to staging',
      steps: [
        {
          id: 'step-1',
          command: 'test',
          args: ['auth'],
          description: 'Run authentication tests',
          critical: true
        },
        {
          id: 'step-2',
          command: 'fix',
          args: ['auth-bug'],
          description: 'Apply authentication fix',
          critical: true,
          dependencies: ['step-1']
        },
        {
          id: 'step-3',
          command: 'deploy',
          args: ['staging'],
          description: 'Deploy to staging',
          dependencies: ['step-2']
        }
      ]
    },
    context: createSampleContext(),
    interactive: false
  })

  console.log('\nWorkflow Execution:')
  console.log(`  Success: ${workflowResult.success}`)
  console.log(`  Steps Completed: ${workflowResult.summary.stepsCompleted}/${workflowResult.summary.totalSteps}`)
  console.log(`  Total Duration: ${workflowResult.summary.totalDuration}ms`)
}

// ═══════════════════════════════════════════════════════════════════════════
// Example 4: Autonomous Agents
// ═══════════════════════════════════════════════════════════════════════════

async function autonomousAgentsExample() {
  console.log('\nExample 4: Autonomous Agents\n')

  const sdk = await createAgentSDK(config)
  const { ticketAgent, taskAgent, codeAgent, plannerAgent } = sdk.agents

  const context = createSampleContext()

  // Create a ticket autonomously
  const ticketResult = await ticketAgent.createTicketAutonomously({
    context,
    conversationAnalysis: {
      intent: { primary: 'bug_report', secondary: ['urgent'] },
      entities: {
        issue: 'authentication bug',
        component: 'login system',
        severity: 'high'
      },
      sentiment: { score: -0.3, label: 'frustrated' },
      urgency: 'high',
      confidence: 0.85
    },
    confidence: 0.85,
    urgency: 'high'
  })

  console.log('Ticket Creation:')
  console.log(`  Success: ${ticketResult.success}`)
  if (ticketResult.ticket) {
    console.log(`  Ticket ID: ${ticketResult.ticket.id}`)
    console.log(`  Priority: ${ticketResult.ticket.priority}`)
  }

  // Break down a task
  const taskBreakdown = await taskAgent.breakdownTask({
    taskId: 'task-001',
    context,
    maxSubtasks: 5,
    focusArea: 'development'
  })

  console.log('\nTask Breakdown:')
  console.log(`  Success: ${taskBreakdown.success}`)
  console.log(`  Subtasks: ${taskBreakdown.breakdown?.subtasks?.length ?? 0}`)
  console.log(`  Confidence: ${taskBreakdown.confidence}`)

  // Generate code
  const codeResult = await codeAgent.generateCodeAutonomously({
    requirements: {
      id: 'req-001',
      description: 'Authentication middleware with rate limiting',
      targetLanguage: 'typescript',
      constraints: ['use-express', 'jwt-based', 'redis-for-rate-limiting']
    },
    context,
    style: 'standard'
  })

  console.log('\nCode Generation:')
  console.log(`  Success: ${codeResult.success}`)
  if (codeResult.generatedCode) {
    console.log(`  Code Length: ${codeResult.generatedCode.length} chars`)
    console.log(`  Confidence: ${codeResult.confidence}`)
  }

  // Create a strategic plan
  const strategicPlan = await plannerAgent.createStrategicPlan({
    objective: {
      id: 'obj-001',
      type: 'transformation',
      description: 'Modernize authentication system',
      priority: 'high',
      successCriteria: ['improved-security', 'better-performance', 'user-satisfaction'],
      stakeholders: ['engineering', 'security', 'product']
    },
    context,
    timeHorizon: 'medium',
    riskTolerance: 'medium'
  })

  console.log('\nStrategic Plan:')
  console.log(`  Success: ${strategicPlan.success}`)
  if (strategicPlan.plan) {
    console.log(`  Strategy: ${strategicPlan.plan.strategy}`)
    console.log(`  Milestones: ${strategicPlan.plan.milestones.length}`)
    console.log(`  Confidence: ${strategicPlan.plan.metadata.confidence}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Example 5: Intelligence Modules
// ═══════════════════════════════════════════════════════════════════════════

async function intelligenceModulesExample() {
  console.log('\nExample 5: Intelligence Modules\n')

  const sdk = await createAgentSDK(config)
  const { conversation, codebase, task, project } = sdk.intelligence

  const context = createSampleContext()

  // Analyze conversation (analyzeConversation takes a Context object)
  const conversationAnalysis = await conversation.analyzeConversation(context) as any

  console.log('Conversation Analysis:')
  console.log(`  Intent: ${conversationAnalysis.intent?.primary}`)
  console.log(`  Urgency: ${conversationAnalysis.urgency}`)
  console.log(`  Sentiment: ${conversationAnalysis.sentiment?.label}`)
  console.log(`  Key Topics: ${conversationAnalysis.topics?.join(', ')}`)

  // Analyze codebase
  const codebaseAnalysis = await codebase.analyzeCodebase({
    projectPath: '/src',
    depth: 'shallow'
  })

  console.log('\nCodebase Analysis:')
  console.log(`  Total Files: ${codebaseAnalysis.fileStructure.totalFiles}`)
  console.log(`  Issues Found: ${codebaseAnalysis.issues.length}`)
  console.log(`  Confidence: ${codebaseAnalysis.confidence}`)

  // Analyze task
  const taskAnalysis = await task.analyzeTask({
    taskDescription: 'Fix authentication system',
    context,
    priority: 'high'
  })

  console.log('\nTask Analysis:')
  console.log(`  Complexity: ${taskAnalysis.characteristics.complexity}`)
  console.log(`  Estimated Effort: ${taskAnalysis.estimation.totalHours} hours`)
  console.log(`  Risks: ${taskAnalysis.risks.length}`)

  // Analyze project
  const projectAnalysis = await project.analyzeProject({
    projectId: context.project.id,
    context,
    includeHistoricalData: true,
    analysisDepth: 'comprehensive'
  })

  console.log('\nProject Analysis:')
  console.log(`  Health Score: ${projectAnalysis.health.overallScore}/100`)
  console.log(`  Trends: ${projectAnalysis.trends.length} tracked`)
  console.log(`  Top Threat: ${projectAnalysis.threats[0]?.description || 'None identified'}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// Example 6: Simplified Chat Interface
// ═══════════════════════════════════════════════════════════════════════════

async function simplifiedChatExample() {
  console.log('\nExample 6: Simplified Chat Interface\n')

  // Use the simplified chat-focused SDK
  const chatAgent = await createChatAgent(config)

  const conversationId = 'simple-chat-001'
  const context = createSampleContext()

  // Process a message
  const result = await chatAgent.processMessage(
    conversationId,
    {
      id: 'msg-456',
      content: 'I need to create a high-priority ticket for the payment processing bug',
      role: 'user',
      timestamp: new Date().toISOString()
    },
    context
  )

  console.log('Message Processing:')
  console.log(`  Analysis Complete: ${result.analysis ? 'yes' : 'no'}`)
  console.log(`  Actions Taken: ${result.executedActions.length}`)
  console.log(`  Processing Time: ${result.processingTime}ms`)

  // Create a ticket directly
  const ticketResult = await chatAgent.createTicket(conversationId, context)
  console.log(`\nTicket Created: ${ticketResult.success}`)

  // Get insights
  const insights = await chatAgent.getInsights(conversationId)
  console.log('\nChat Insights:')
  console.log(`  Actionable Items: ${insights.actionableItems.length}`)
  console.log(`  Recommendations: ${insights.recommendedActions.length}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

function createSampleContext(): Context {
  return {
    conversation: {
      id: 'conv-sample',
      messages: [],
      intent: {
        primary: 'general',
        secondary: [],
        confidence: 0.5,
        urgency: 'low',
        complexity: 'simple'
      },
      sentiment: 'neutral',
      topics: [],
      keywords: [],
      entities: []
    },
    project: {
      id: 'proj-sample',
      name: 'SampleProject',
      type: 'web',
      description: 'A sample web project',
      techStack: ['typescript'],
      codebaseAnalysis: {
        totalFiles: 50,
        totalLines: 5000,
        languages: { typescript: 5000 },
        complexity: 'simple',
        architecture: [],
        patterns: [],
        issues: [],
        hotspots: [],
        lastAnalyzed: new Date().toISOString()
      },
      recentChanges: [],
      activeTickets: [],
      activeTasks: []
    },
    user: {
      id: 'user-sample',
      name: 'SampleUser',
      role: 'developer',
      expertise: ['typescript'],
      preferences: {
        communicationStyle: 'technical',
        workingStyle: 'autonomous',
        notificationPrefs: [],
        toolPreferences: []
      },
      workingHours: [],
      currentFocus: [],
      recentActivity: []
    },
    system: {
      timestamp: new Date().toISOString(),
      sessionId: 'session-sample',
      platform: 'darwin',
      environment: 'development',
      capabilities: [
        { name: 'file_access', available: true, performance: 1, lastChecked: new Date().toISOString() },
        { name: 'code_execution', available: true, performance: 1, lastChecked: new Date().toISOString() }
      ],
      performance: {
        responseTime: 100,
        throughput: 50,
        errorRate: 0.01,
        resourceUtilization: 0.5
      },
      resources: {
        cpu: 8,
        memory: 16384,
        storage: 512000
      }
    }
  } as Context
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Execution
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════')
  console.log('                        autonomus SDK Comprehensive Example                      ')
  console.log('═══════════════════════════════════════════════════════════════════════════')

  try {
    // Run all examples
    await basicSDKExample()
    await chatIntegrationExample()
    await cliIntegrationExample()
    await autonomousAgentsExample()
    await intelligenceModulesExample()
    await simplifiedChatExample()

    console.log('\nAll examples completed successfully!')
    console.log('\n═══════════════════════════════════════════════════════════════════════════')

  } catch (error) {
    console.error('\nError running examples:', error)
  }
}

// Run the examples if this file is executed directly
if (require.main === module) {
  main()
}

// Export for use in other examples
export {
  basicSDKExample,
  chatIntegrationExample,
  cliIntegrationExample,
  autonomousAgentsExample,
  intelligenceModulesExample,
  simplifiedChatExample,
  createSampleContext
}
