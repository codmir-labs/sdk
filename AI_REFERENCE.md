# Codmir SDK - AI Reference

This document is optimized for AI assistants to understand and use the Codmir SDK.

## Quick Reference

| Action | SDK Method | Example |
|--------|------------|---------|
| Create ticket | `client.createTicket(input)` | `client.createTicket({ title: 'Bug', projectId: 'p1' })` |
| List tickets | `client.listTickets(projectId)` | `client.listTickets('p1', { status: 'open' })` |
| Create project | `client.createProject(input)` | `client.createProject({ name: 'My App', organizationId: 'org1' })` |
| List projects | `client.listProjects()` | `const projects = await client.listProjects()` |
| Chat with AI | `client.chat(message)` | `await client.chat('How do I...?')` |
| Stream chat | `client.streamChat(msg, opts)` | `await client.streamChat('...', { onChunk: fn })` |
| Run agent task | `client.runAgentTask(input)` | `await client.runAgentTask({ taskId: 't1' })` |
| Get user | `client.whoami()` | `const user = await client.whoami()` |

## Installation

```bash
npm install @codmir/sdk
```

## Initialization

```typescript
import { CodmirClient } from '@codmir/sdk';

const client = new CodmirClient({
  apiKey: process.env.CODMIR_API_KEY,
  // Optional:
  baseUrl: 'https://codmir.com/api',
  timeout: 30000,
});
```

## API Schema

### Organizations

```typescript
// Create organization (requires auth)
POST /api/organizations
Body: { name: string, description?: string, slug?: string }
Response: { id, name, slug, ownerId }

// List user's organizations
GET /api/user/organizations
Response: Organization[]
```

### Projects

```typescript
// Create project
client.createProject({
  name: string,              // Required
  organizationId?: string,   // Uses default org if omitted
  description?: string,
  key?: string,              // Auto-generated if omitted (e.g., "MOB" from "Mobile App")
  projectType?: 'software' | 'marketing' | 'operations' | 'design' | 'other'
}) => Project

// List projects
client.listProjects() => Project[]

// Get project
client.getProject(projectId: string) => Project
```

### Tickets

```typescript
// Create ticket
client.createTicket({
  title: string,             // Required
  projectId: string,         // Required
  description?: string,
  type?: 'BUG' | 'FEATURE' | 'TASK' | 'IMPROVEMENT',
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
  assigneeId?: string,
  labels?: string[],
}) => Ticket

// List tickets
client.listTickets(projectId: string, {
  page?: number,
  pageSize?: number,
  status?: 'BACKLOG' | 'TODO' | 'IN_PROGRESS' | 'DONE',
}) => PaginatedResponse<Ticket>

// Update ticket
client.updateTicket(projectId: string, ticketId: string, {
  status?: TicketStatus,
  priority?: TicketPriority,
  assigneeId?: string,
  title?: string,
  description?: string,
}) => Ticket

// Delete ticket
client.deleteTicket(projectId: string, ticketId: string) => void
```

### Test Cases

```typescript
// Create test case
client.createTestCase({
  title: string,
  projectId: string,
  description?: string,
  steps?: Array<{
    order: number,
    action: string,
    expectedResult: string,
  }>,
}) => TestCase

// List test cases
client.listTestCases(projectId: string) => TestCase[]
```

### AI Agent Tasks

```typescript
// Create agent task
client.createAgentTask({
  type: 'code_review' | 'bug_fix' | 'feature' | 'refactor' | 'test',
  prompt: string,
  projectId: string,
}) => AgentTask

// Run task
client.runAgentTask({
  taskId: string,
  options?: {
    model?: string,
    autoApprove?: boolean,
  },
}) => TaskExecution

// Check task status
client.getAgentTask(taskId: string) => AgentTask
```

### AI Chat

```typescript
// Simple chat
client.chat(message: string, options?: {
  projectId?: string,    // Include project context
}) => string

// Streaming chat
client.streamChat(message: string, {
  projectId?: string,
  onChunk: (chunk: string) => void,
}) => Promise<string>  // Returns full response
```

## Error Handling

```typescript
import { CodmirApiError } from '@codmir/sdk';

try {
  await client.createTicket({ ... });
} catch (error) {
  if (error instanceof CodmirApiError) {
    // error.code - Error code (e.g., 'NOT_FOUND', 'UNAUTHORIZED')
    // error.message - Human-readable message
    // error.statusCode - HTTP status (e.g., 404, 401)
    // error.details - Additional error details
  }
}
```

### Common Error Codes

| Code | Status | Meaning |
|------|--------|---------|
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `FORBIDDEN` | 403 | No permission for this action |
| `NOT_FOUND` | 404 | Resource doesn't exist |
| `VALIDATION_ERROR` | 400 | Invalid input data |
| `ORG_MEMBERSHIP_REQUIRED` | 428 | User needs an organization first |
| `PROJECT_REQUIRED` | 428 | User needs a project first |

## Platform-Specific Imports

| Platform | Import | Use Case |
|----------|--------|----------|
| API Client | `@codmir/sdk` | Server-side, CLI, scripts |
| Next.js | `@codmir/sdk/nextjs` | Error tracking, instrumentation |
| React Native | `@codmir/sdk/react-native` | Mobile error tracking |
| Browser | `@codmir/sdk/browser` | Vanilla JS error tracking |
| Node.js | `@codmir/sdk/overseer` | Server error tracking |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CODMIR_API_KEY` | Yes | API key for authentication |
| `CODMIR_BASE_URL` | No | Custom API URL (default: codmir.com/api) |
| `CODMIR_PROJECT_ID` | No | Default project for operations |
| `CODMIR_ORG_ID` | No | Default organization |

## TypeScript Types

```typescript
import type {
  // Core types
  Project,
  Ticket,
  TestCase,
  AgentTask,
  User,
  Organization,
  
  // Input types
  CreateProjectInput,
  CreateTicketInput,
  UpdateTicketInput,
  CreateTestCaseInput,
  CreateAgentTaskInput,
  
  // Enums
  TicketStatus,
  TicketPriority,
  TicketType,
  AgentTaskType,
  
  // Errors
  CodmirApiError,
} from '@codmir/sdk';
```

## Common Patterns

### Create organization then project then ticket

```typescript
// 1. Create organization (if user doesn't have one)
const org = await client.createOrganization({ name: 'My Team' });

// 2. Create project
const project = await client.createProject({
  name: 'Mobile App',
  organizationId: org.id,
});

// 3. Create ticket
const ticket = await client.createTicket({
  title: 'Add login screen',
  projectId: project.id,
  type: 'FEATURE',
  priority: 'HIGH',
});
```

### Iterate through paginated results

```typescript
let page = 1;
let hasMore = true;

while (hasMore) {
  const result = await client.listTickets(projectId, { page, pageSize: 50 });
  
  for (const ticket of result.data) {
    console.log(ticket.title);
  }
  
  hasMore = result.hasNextPage;
  page++;
}
```

### AI-assisted development

```typescript
// Create a task for AI to work on
const task = await client.createAgentTask({
  type: 'feature',
  prompt: 'Add user authentication with OAuth2',
  projectId: 'my-project',
});

// Execute it
const execution = await client.runAgentTask({ taskId: task.id });

// Check status
const status = await client.getAgentTask(task.id);
console.log(status.state); // 'running' | 'completed' | 'failed'
```

## MCP Integration

For IDE/AI assistant integration, use the Codmir MCP server:

```json
// .windsurf/mcp.json or Claude desktop config
{
  "mcpServers": {
    "codmir": {
      "command": "npx",
      "args": ["codmir-mcp"]
    }
  }
}
```

Available MCP tools:
- `create_ticket` - Create tickets from conversation
- `get_sprint_tasks` - Get current sprint tasks
- `execute_task` - Run AI agent on a task
- `store_conversation` - Save context as documentation
- `get_project_context` - Get project overview
