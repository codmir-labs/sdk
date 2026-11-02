# Codmir Agent SDK

> Make confident, context-aware autonomous decisions

The Codmir Agent SDK is a powerful framework for building autonomous AI systems that can make intelligent decisions, analyze complex contexts, and execute actions with confidence. Built on the principle of decisive action with comprehensive understanding, it provides a complete toolkit for autonomous agents, intelligent analysis, and seamless integrations.

## 🚀 Features

### Core Capabilities
- **Autonomous Decision Making** - Confident, context-aware decisions with configurable autonomy levels
- **Intelligent Planning** - Strategic execution plans with risk assessment and rollback strategies
- **Continuous Learning** - Learn from interactions and improve over time
- **Rich Context Management** - Multi-layered context building from various sources

### Intelligence Modules
- **Conversation Intelligence** - Advanced NLU, intent detection, sentiment analysis
- **Codebase Intelligence** - Code analysis, pattern detection, security scanning
- **Task Intelligence** - Task breakdown, effort estimation, dependency analysis
- **Project Intelligence** - Project health monitoring, trend analysis, optimization

### Autonomous Agents
- **Ticket Agent** - Intelligent ticket creation, prioritization, and lifecycle management
- **Task Agent** - Task breakdown, estimation, monitoring, and execution
- **Code Agent** - Code generation, analysis, refactoring, and optimization
- **Planner Agent** - Strategic planning, resource optimization, risk management

### Integrations
- **Chat Integration** - Enhanced chat interfaces with autonomous ticket/task creation
- **CLI Integration** - Intelligent command processing, workflows, and autocomplete

## 📦 Installation

```bash
npm install @codmir/sdk
# or
yarn add @codmir/sdk
# or
pnpm add @codmir/sdk
```

## 🎯 Quick Start

### Basic Usage

```typescript
import { createAgentSDK, AgentConfig } from '@codmir/sdk/agent'

// Configure the SDK
const config: AgentConfig = {
  autonomyMode: 'balanced',
  enableAutonomousActions: true,
  confidenceThreshold: {
    low: 0.6,
    medium: 0.75,
    high: 0.85
  }
}

// Initialize the SDK
const sdk = await createAgentSDK(config)

// Make an autonomous decision
const decision = await sdk.makeDecision(context, {
  requireConfirmation: false
})

// Create an execution plan
const plan = await sdk.createPlan(objective, context)
```

### Chat Integration

```typescript
import { createChatAgent } from '@codmir/sdk/agent'

const chatSDK = await createChatAgent(config)

// Process a chat message
const result = await chatSDK.processMessage(
  conversationId,
  message,
  context
)

// Create a ticket from conversation
const ticket = await chatSDK.createTicket(conversationId, context)
```

### CLI Integration

```typescript
const cliIntegration = sdk.integrations.cli

// Process a command
const result = await cliIntegration.processCommand({
  sessionId,
  command: {
    type: 'create',
    args: ['task', 'implement-feature'],
    options: { priority: 'high' }
  },
  context
})

// Get autocomplete suggestions
const suggestions = await cliIntegration.getAutocompleteSuggestions({
  sessionId,
  partialCommand: 'deploy ',
  context
})
```

## 🏗️ Architecture

### Core Components

```
Codmir Agent SDK
├── Core Engine
│   ├── AgentEngine        # Main orchestrator
│   ├── ContextManager     # Context building and management
│   ├── PlanningEngine     # Strategic planning
│   ├── ActionExecutor     # Action execution with retry
│   └── LearningSystem     # Continuous learning
│
├── Intelligence Modules
│   ├── ConversationIntelligence
│   ├── CodebaseIntelligence
│   ├── TaskIntelligence
│   └── ProjectIntelligence
│
├── Autonomous Agents
│   ├── TicketAgent
│   ├── TaskAgent
│   ├── CodeAgent
│   └── PlannerAgent
│
└── Integrations
    ├── ChatIntegration
    └── CLIIntegration
```

### Autonomy Modes

- **Conservative** - High confidence thresholds, manual confirmations
- **Balanced** - Moderate autonomy with intelligent decision making
- **Aggressive** - High autonomy for experienced users

## 🔧 Configuration

### Basic Configuration

```typescript
const config: AgentConfig = {
  // Autonomy settings
  autonomyMode: 'balanced',
  enableAutonomousActions: true,
  
  // Confidence thresholds
  confidenceThreshold: {
    low: 0.6,
    medium: 0.75,
    high: 0.85
  },
  
  // Learning settings
  enableLearning: true,
  learningRate: 0.1,
  
  // Timeouts
  actionTimeout: 30000,
  planningTimeout: 10000,
  
  // Features
  enableExperimentalFeatures: false,
  verbosityLevel: 'normal'
}
```

### Using Presets

```typescript
import { AgentPresets, IntegrationPresets } from '@codmir/sdk/autonomus'

// Use agent presets
const conservativeConfig = {
  ...AgentPresets.conservative,
  enableLearning: true
}

// Use integration presets
const fullIntegrationConfig = {
  ...IntegrationPresets.full,
  customSetting: 'value'
}
```

## 🤖 Autonomous Agents

### Ticket Agent

```typescript
const ticketAgent = sdk.agents.ticketAgent

// Create ticket autonomously
const result = await ticketAgent.createTicketAutonomously({
  context,
  conversationAnalysis,
  confidence: 0.85,
  urgency: 'high'
})

// Analyze existing ticket
const analysis = await ticketAgent.analyzeTicket({
  ticketId: 'TICKET-123',
  context,
  includeRecommendations: true
})
```

### Task Agent

```typescript
const taskAgent = sdk.agents.taskAgent

// Break down complex task
const breakdown = await taskAgent.breakdownTask({
  taskId: 'TASK-456',
  description: 'Implement new feature',
  context,
  maxDepth: 3,
  targetGranularity: 'detailed'
})

// Monitor task execution
const monitoring = await taskAgent.monitorTaskExecution({
  taskId: 'TASK-456',
  context,
  realTime: true
})
```

### Code Agent

```typescript
const codeAgent = sdk.agents.codeAgent

// Generate code
const codeResult = await codeAgent.generateCodeAutonomously({
  requirements: {
    description: 'REST API endpoint',
    targetLanguage: 'typescript',
    constraints: ['express', 'validation']
  },
  context,
  style: 'standard'
})

// Analyze code quality
const quality = await codeAgent.assessCodeQuality({
  code: sourceCode,
  language: 'typescript',
  context
})
```

### Planner Agent

```typescript
const plannerAgent = sdk.agents.plannerAgent

// Create strategic plan
const plan = await plannerAgent.createStrategicPlan({
  objective: {
    type: 'technical',
    description: 'Modernize architecture',
    priority: 'high',
    successCriteria: ['scalability', 'maintainability']
  },
  context,
  timeHorizon: 'medium',
  riskTolerance: 'medium'
})

// Make autonomous decision
const decision = await plannerAgent.makeAutonomousDecision({
  situation: 'deployment-failure',
  context,
  constraints: ['no-downtime', 'data-integrity'],
  urgency: 'critical'
})
```

## 🧠 Intelligence Modules

### Conversation Intelligence

```typescript
const conversationIntel = sdk.intelligence.conversation

// Comprehensive analysis
const analysis = await conversationIntel.analyzeConversation({
  messages,
  context,
  analysisDepth: 'comprehensive'
})

// Extract actionable insights
const insights = await conversationIntel.extractActionableInsights({
  messages,
  context
})
```

### Codebase Intelligence

```typescript
const codebaseIntel = sdk.intelligence.codebase

// Analyze entire codebase
const analysis = await codebaseIntel.analyzeCodebase({
  path: '/src',
  context,
  analysisType: 'comprehensive',
  depth: 'deep'
})

// Detect patterns
const patterns = await codebaseIntel.detectPatterns({
  path: '/src',
  context,
  patternTypes: ['architectural', 'anti-patterns']
})
```

### Task Intelligence

```typescript
const taskIntel = sdk.intelligence.task

// Analyze task complexity
const analysis = await taskIntel.analyzeTask({
  taskId: 'TASK-789',
  description: taskDescription,
  context,
  includeSubtasks: true
})

// Estimate effort
const estimation = await taskIntel.estimateEffort({
  taskAnalysis: analysis,
  context,
  confidenceLevel: 'detailed'
})
```

### Project Intelligence

```typescript
const projectIntel = sdk.intelligence.project

// Get project overview
const overview = await projectIntel.getProjectOverview({
  projectId: 'PROJ-123',
  context,
  includeMetrics: true
})

// Analyze project health
const health = await projectIntel.analyzeProjectHealth({
  projectId: 'PROJ-123',
  context,
  depth: 'comprehensive'
})
```

## 📊 Events and Monitoring

### Event Handling

```typescript
// Listen to engine events
sdk.engine.on('decision_made', (event) => {
  console.log('Decision:', event.decision)
})

// Listen to agent events
sdk.agents.ticketAgent.on('ticket_created_autonomously', (event) => {
  console.log('Ticket created:', event.ticket)
})

// Listen to integration events
sdk.integrations.chat.on('chat_processed', (event) => {
  console.log('Chat processed:', event.result)
})
```

### Metrics and Insights

```typescript
// Get comprehensive SDK insights
const insights = await sdk.getSDKInsights()

// Get specific component metrics
const engineMetrics = sdk.engine.getEngineInsights()
const chatMetrics = sdk.integrations.chat.getIntegrationMetrics()
const agentInsights = sdk.agents.taskAgent.getAgentInsights()
```

## 🔐 Security and Permissions

### Confidence-Based Security

```typescript
// Actions are gated by confidence thresholds
const config = {
  confidenceThreshold: {
    low: 0.6,    // Information gathering
    medium: 0.75, // Suggestions and analysis
    high: 0.85    // Autonomous actions
  }
}
```

### Action Confirmation

```typescript
// Require confirmation for critical actions
const decision = await sdk.makeDecision(context, {
  requireConfirmation: true,
  confirmationTimeout: 30000
})
```

## 🧪 Testing

### Unit Testing

```typescript
import { createautonomusSDK } from '@codmir/sdk/autonomus'
import { mockContext } from '@codmir/sdk/autonomus/testing'

describe('autonomus SDK', () => {
  it('should make autonomous decisions', async () => {
    const sdk = await createautonomusSDK(testConfig)
    const decision = await sdk.makeDecision(mockContext, {})
    
    expect(decision.success).toBe(true)
    expect(decision.decision).toBeDefined()
  })
})
```

### Integration Testing

```typescript
// Test chat integration
const chatResult = await sdk.integrations.chat.processChatMessage({
  conversationId: 'test-conv',
  message: testMessage,
  context: mockContext
})

expect(chatResult.executedActions).toHaveLength(1)
expect(chatResult.executedActions[0].success).toBe(true)
```

## 📚 Advanced Usage

### Custom Agents

```typescript
// Extend existing agents
class CustomTicketAgent extends TicketAgent {
  async createTicketWithCustomLogic(params: any) {
    // Add custom logic
    const customAnalysis = await this.performCustomAnalysis(params)
    
    // Call parent method
    return super.createTicketAutonomously({
      ...params,
      customData: customAnalysis
    })
  }
}
```

### Plugin System

```typescript
// Register custom plugins
sdk.engine.registerPlugin({
  name: 'custom-analyzer',
  initialize: async () => { /* ... */ },
  process: async (context) => { /* ... */ }
})
```

### Workflow Automation

```typescript
// Define complex workflows
const workflow = {
  name: 'bug-fix-workflow',
  steps: [
    { action: 'analyze_bug', agent: 'codeAgent' },
    { action: 'create_ticket', agent: 'ticketAgent' },
    { action: 'generate_fix', agent: 'codeAgent' },
    { action: 'create_pr', agent: 'codeAgent' }
  ]
}

// Execute workflow
const result = await sdk.engine.executeWorkflow(workflow, context)
```

## 🌟 Best Practices

1. **Start Conservative** - Begin with conservative autonomy settings and increase as you gain confidence
2. **Monitor Decisions** - Always monitor autonomous decisions initially
3. **Provide Context** - The more context you provide, the better the decisions
4. **Use Appropriate Agents** - Each agent is specialized; use the right one for the task
5. **Handle Errors Gracefully** - Always handle potential failures in autonomous actions
6. **Learn from Feedback** - Enable learning to improve performance over time

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🔗 Links

- [Documentation](https://docs.codmir.com/sdk/autonomus)
- [API Reference](https://api.codmir.com/sdk/autonomus)
- [Examples](./examples)
- [Changelog](CHANGELOG.md)

---

Built with ❤️ by the Codmir Team
