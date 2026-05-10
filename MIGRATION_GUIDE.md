# Codmir Agent SDK Migration Guide

This guide helps you migrate from the previous Agent SDK to the enhanced version with autonomous capabilities, improved error handling, and production-ready features.

## Breaking Changes

### 1. Package Structure Changes

**Before:**
```typescript
import { autonomusAgent } from '@codmir/sdk/autonomus'
import { OverseerSystem } from '@codmir/sdk/autonomus/overseer'
```

**After:**
```typescript
import { AgentEngine, createAgentSDK } from '@codmir/sdk/agent'
import { TaskRunnerIntegration } from '@codmir/sdk/agent/integrations'
```

### 2. Configuration API

**Before:**
```typescript
const agent = new autonomusAgent({
  mode: 'balanced',
  confidence: 0.7
})
```

**After:**
```typescript
const sdk = await createAgentSDK({
  autonomyMode: 'balanced',
  confidenceThreshold: {
    low: 0.6,
    medium: 0.75,
    high: 0.85
  },
  enableAutonomousActions: true,
  learningEnabled: true
})
```

### 3. Task Execution

**Before:**
```typescript
const result = await agent.executeTask(prompt)
```

**After:**
```typescript
const taskRunner = new TaskRunnerIntegration(config)
await taskRunner.initialize()
const task = await taskRunner.submitTask({ goal: prompt })
```

## Step-by-Step Migration

### Step 1: Update Dependencies

```bash
# Remove old packages
npm uninstall @codmir/autonomus-sdk

# Install new SDK
npm install @codmir/sdk@latest
```

### Step 2: Update Imports

Create a migration script or manually update imports:

```typescript
// migration-helper.ts
export function migrateImports() {
  // Old imports to new imports mapping
  const importMappings = {
    '@codmir/sdk/autonomus': '@codmir/sdk/agent',
    '@codmir/sdk/autonomus/overseer': '@codmir/sdk/agent/core',
    '@codmir/sdk/autonomus/intelligence': '@codmir/sdk/agent/intelligence'
  }
  
  // Helper function to update your files
  // Implementation depends on your build system
}
```

### Step 3: Update Configuration

**Old Configuration:**
```typescript
const config = {
  mode: 'aggressive',
  confidence: 0.8,
  enableLearning: true
}
```

**New Configuration:**
```typescript
const config: AgentConfig = {
  autonomyMode: 'aggressive',
  confidenceThreshold: {
    low: 0.6,
    medium: 0.75,
    high: 0.85
  },
  enableAutonomousActions: true,
  learningEnabled: true,
  contextDepth: 'deep',
  planningHorizon: 'tactical'
}
```

### Step 4: Update Task Handling

**Before:**
```typescript
class MyService {
  async processTask(prompt: string) {
    const agent = new autonomusAgent(config)
    const result = await agent.executeTask(prompt)
    return result
  }
}
```

**After:**
```typescript
class MyService {
  private taskRunner: TaskRunnerIntegration
  
  constructor() {
    this.taskRunner = new TaskRunnerIntegration({
      ...config,
      runnerUrl: process.env.TASK_RUNNER_URL,
      runnerToken: process.env.TASK_RUNNER_TOKEN
    })
  }
  
  async initialize() {
    await this.taskRunner.initialize()
  }
  
  async processTask(prompt: string) {
    const task = await this.taskRunner.submitTask({
      goal: prompt,
      enableAutonomousBreakdown: true
    })
    
    // Monitor progress
    const progress = await this.taskRunner.getProgress(task.id)
    return { task, progress }
  }
}
```

### Step 5: Add Error Handling

```typescript
import { globalErrorBoundary } from '@codmir/sdk/agent/production'

class MyService {
  async processTask(prompt: string) {
    return await globalErrorBoundary.withErrorBoundary(
      async () => {
        return await this.taskRunner.submitTask({ goal: prompt })
      },
      {
        component: 'task_service',
        operation: 'submit_task',
        projectId: this.projectId,
        timestamp: new Date(),
        environment: process.env.NODE_ENV as any
      },
      'task_execution' // Recovery strategy key
    )
  }
}
```

### Step 6: Add Rate Limiting

```typescript
import { rateLimiters } from '@codmir/sdk/agent/production'

class MyService {
  async processTask(prompt: string, userId: string) {
    // Check rate limits
    await rateLimiters.tasks.enforceLimit('task_submission', userId)
    
    return await this.taskRunner.submitTask({ goal: prompt })
  }
}
```

### Step 7: Add Telemetry

```typescript
import { telemetry } from '@codmir/sdk/agent/production'

class MyService {
  async processTask(prompt: string) {
    return await telemetry.trackOperation(
      'task_processing',
      async (trace) => {
        const spanId = telemetry.addSpan(trace.id, 'task_submission')
        
        try {
          const result = await this.taskRunner.submitTask({ goal: prompt })
          telemetry.recordMetric('tasks_processed', 1, 'count')
          telemetry.endSpan(trace.id, spanId)
          return result
        } catch (error) {
          telemetry.addSpanLog(trace.id, spanId, `Error: ${error.message}`, 'error')
          throw error
        }
      }
    )
  }
}
```

## Feature Migration

### 1. Decision Making

**Before:**
```typescript
const decision = await agent.makeDecision(question, options)
```

**After:**
```typescript
const sdk = await createAgentSDK(config)
const result = await sdk.engine.makeDecision(context, {
  question,
  options,
  factors: ['complexity', 'risk', 'resources']
})
const decision = result.decision
```

### 2. Learning System

**Before:**
```typescript
agent.learn(outcome)
```

**After:**
```typescript
const learning = await sdk.engine.learn({
  context,
  outcome: {
    success: true,
    userSatisfaction: 'high',
    actionTaken: 'code_generated'
  }
})
```

### 3. Context Analysis

**Before:**
```typescript
const analysis = await agent.analyzeContext(data)
```

**After:**
```typescript
const analysis = await sdk.engine.analyzeContext(context)
// More detailed analysis with insights and recommendations
```

## Database Integration

### Update Database Schema

Run the migration for agent swarm permissions:

```bash
npx prisma migrate dev --name add_agent_swarm_permissions
```

### Update Database Adapter Usage

**Before:**
```typescript
// Direct database queries
const project = await prisma.project.findUnique({ where: { id } })
```

**After:**
```typescript
import { DatabaseAdapter } from '@codmir/sdk/agent/integrations/adapters'

const dbAdapter = new DatabaseAdapter({ prisma })
const context = await dbAdapter.buildContextFromDatabase({
  projectId: id,
  includeMembers: true,
  includeIntegrations: true
})
```

## Web Application Integration

### Update React Hooks

**Before:**
```typescript
const useAgent = () => {
  const [result, setResult] = useState()
  
  const executeTask = async (prompt) => {
    const agent = new autonomusAgent(config)
    const result = await agent.executeTask(prompt)
    setResult(result)
  }
  
  return { executeTask, result }
}
```

**After:**
```typescript
import { useEnhancedTaskRunner } from '@/hooks/useEnhancedTaskRunner'

const useAgent = () => {
  const {
    submitTask,
    activeTasks,
    isLoading
  } = useEnhancedTaskRunner({
    enableAutonomousBreakdown: true,
    enableIntelligentRecovery: true
  })
  
  return { submitTask, activeTasks, isLoading }
}
```

### Update UI Components

Replace old task execution UI with the new v0.dev-style interface:

```typescript
import { TaskPageV2 } from '@/components/task/TaskPageV2'

// Replace old task pages
<TaskPageV2 projectId={projectId} taskId={taskId} />
```

## CLI Integration

### Update CLI Commands

**Before:**
```typescript
import { createCodingAgent } from '@codmir/sdk/autonomus'

const agent = createCodingAgent(config)
await agent.chatStream(prompt)
```

**After:**
```typescript
import { TaskRunnerIntegration } from '@codmir/sdk/agent/integrations'

const taskRunner = new TaskRunnerIntegration(config)
await taskRunner.initialize()
const task = await taskRunner.submitTask({ goal: prompt })
```

### Enhanced CLI Command

Use the new enhanced CLI command:

```bash
# Old command
codmir task "Implement authentication"

# New enhanced command  
codmir task-enhanced "Implement authentication" --autonomous --recovery
```

## VS Code Extension Integration

### Update Extension

The VS Code extension now includes local LLM chat capabilities:

1. **Chat Interface**: New chat panel with local AI models
2. **Task Status Panel**: Real-time task execution monitoring
3. **Local LLM Support**: Connect to MLX, Ollama, or dev-kit

### Configuration

Add to VS Code settings:

```json
{
  "codmir.localLLM.provider": "dev-kit",
  "codmir.localLLM.baseUrl": "http://localhost:8808",
  "codmir.workstation.autoConnect": true
}
```

## Environment Variables

Update your environment variables:

```bash
# Old variables
autonomus_API_KEY=your-key
autonomus_MODE=balanced

# New variables  
CODMIR_AGENT_MODE=balanced
TASK_RUNNER_URL=http://localhost:8080
TASK_RUNNER_SECRET=your-secret

# Production features
CODMIR_ENABLE_TELEMETRY=true
CODMIR_TELEMETRY_ENDPOINT=https://telemetry.codmir.com
CODMIR_ENABLE_RATE_LIMITING=true

# Local AI support
LOCAL_AI_URL=http://localhost:8808
DEV_KIT_ENABLED=true
MLX_URL=http://localhost:8800
```

## Testing Migration

### Update Tests

**Before:**
```typescript
describe('Agent Tests', () => {
  it('should execute task', async () => {
    const agent = new autonomusAgent(testConfig)
    const result = await agent.executeTask('test prompt')
    expect(result).toBeDefined()
  })
})
```

**After:**
```typescript
import { TaskRunnerIntegration } from '@codmir/sdk/agent/integrations'

describe('Enhanced Agent Tests', () => {
  let taskRunner: TaskRunnerIntegration
  
  beforeEach(async () => {
    taskRunner = new TaskRunnerIntegration(testConfig)
    await taskRunner.initialize()
  })
  
  it('should execute task with autonomous breakdown', async () => {
    const task = await taskRunner.submitTask({
      goal: 'test prompt',
      enableAutonomousBreakdown: true
    })
    
    expect(task).toHaveProperty('id')
    expect(task).toHaveProperty('subtasks')
  })
})
```

## Performance Considerations

### Memory Usage

The new SDK uses more memory due to:
- Enhanced context tracking
- Telemetry data buffering
- Error history storage

**Optimization:**
```typescript
// Configure telemetry for production
const telemetry = new AgentTelemetrySystem({
  batchSize: 50,           // Smaller batches
  flushInterval: 15000,    // More frequent flushes
  sampleRate: 0.1          // Sample 10% of events
})

// Configure error boundary
const errorBoundary = new AgentErrorBoundary({
  maxErrorHistory: 100     // Limit error history
})
```

### Network Usage

Monitor rate limits and configure appropriately:

```typescript
// Conservative rate limits for production
rateLimiters.api.setLimit('chat_completion', {
  windowMs: 60000,
  maxRequests: 30    // Reduced from 60
})
```

## Troubleshooting

### Common Issues

1. **Import Errors**
   ```
   Error: Cannot find module '@codmir/sdk/autonomus'
   ```
   **Solution**: Update imports to `@codmir/sdk/agent`

2. **Configuration Errors**
   ```
   Error: Invalid autonomy mode
   ```
   **Solution**: Use new configuration format with proper enum values

3. **Task Runner Connection**
   ```
   Error: Task runner not accessible
   ```
   **Solution**: Ensure TASK_RUNNER_URL and TASK_RUNNER_SECRET are set

4. **Rate Limiting**
   ```
   Error: Rate limit exceeded
   ```
   **Solution**: Configure appropriate limits or implement backoff

### Debug Mode

Enable debug logging:

```bash
DEBUG=codmir:* npm start
```

Or in code:
```typescript
const sdk = await createAgentSDK({
  ...config,
  debug: true,
  logLevel: 'verbose'
})
```

## Rollback Plan

If you need to rollback:

1. **Keep Old Version**: Don't uninstall immediately
   ```bash
   npm install @codmir/sdk@2.0.0 @codmir/autonomus-sdk@1.0.0
   ```

2. **Feature Flags**: Use environment variables to switch
   ```typescript
   const useNewSDK = process.env.USE_NEW_AGENT_SDK === 'true'
   ```

3. **Gradual Migration**: Migrate one component at a time
   ```typescript
   // Migrate task execution first, keep old decision making
   if (operation === 'task_execution') {
     return newTaskRunner.submitTask(prompt)
   } else {
     return oldAgent.execute(prompt)
   }
   ```

## Support

If you encounter issues during migration:

1. Check the [GitHub Issues](https://github.com/codmir/platform/issues)
2. Review the [API Documentation](./README.md)
3. Run the migration validator:
   ```bash
   npx @codmir/sdk validate-migration
   ```

## Migration Checklist

- [ ] Update package dependencies
- [ ] Update import statements
- [ ] Migrate configuration objects
- [ ] Update task execution code
- [ ] Add error handling
- [ ] Configure rate limiting
- [ ] Set up telemetry
- [ ] Update database schema
- [ ] Update environment variables
- [ ] Update tests
- [ ] Performance testing
- [ ] Deploy to staging
- [ ] Monitor production metrics

---

For more detailed information, see the [Agent SDK Documentation](./README.md) and [Production Guide](./PRODUCTION.md).
