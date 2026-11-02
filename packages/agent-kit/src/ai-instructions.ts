/**
 * SDK AI Instructions
 * 
 * Instructions and knowledge about the Codmir SDK for AI assistants.
 * Can be injected into system prompts or retrieved via MCP.
 */

export const SDK_QUICK_REFERENCE = `
## Codmir SDK Quick Reference

### Installation
\`\`\`bash
npm install @codmir/sdk
\`\`\`

### Setup
\`\`\`typescript
import { CodmirClient } from '@codmir/sdk';
const client = new CodmirClient({ apiKey: process.env.CODMIR_API_KEY });
\`\`\`

### Common Operations
| Action | Method |
|--------|--------|
| Create ticket | \`client.createTicket({ title, projectId, ... })\` |
| List tickets | \`client.listTickets(projectId, options)\` |
| Create project | \`client.createProject({ name, ... })\` |
| List projects | \`client.listProjects()\` |
| AI chat | \`client.chat(message)\` |
| Stream chat | \`client.streamChat(msg, { onChunk })\` |
| Run agent | \`client.runAgentTask({ taskId })\` |
`;

export const SDK_SYSTEM_INSTRUCTIONS = `
## Codmir SDK Knowledge

You have access to the Codmir SDK for managing projects, tickets, and AI tasks.

### Key Concepts
1. **Organizations** - Workspaces that contain projects (required first)
2. **Projects** - Containers for tickets, boards, and collaboration
3. **Tickets** - Tasks, bugs, features to track
4. **Agent Tasks** - AI-powered automated coding tasks

### Hierarchy
Organization → Project → Tickets/Boards/Tasks

### SDK Methods
- \`CodmirClient({ apiKey })\` - Initialize client
- \`client.listProjects()\` - Get all projects
- \`client.createProject({ name, description })\` - Create project
- \`client.listTickets(projectId)\` - Get project tickets
- \`client.createTicket({ title, projectId, priority, type })\` - Create ticket
- \`client.chat(message)\` - AI chat
- \`client.createAgentTask({ type, prompt, projectId })\` - Create agent task
- \`client.runAgentTask({ taskId })\` - Execute agent task

### Error Handling
- \`ORG_MEMBERSHIP_REQUIRED\` - User needs organization first
- \`PROJECT_REQUIRED\` - User needs project first
- \`NOT_FOUND\` - Resource doesn't exist
- \`UNAUTHORIZED\` - Invalid/missing API key

### When to Use SDK
- Creating tickets programmatically
- Integrating Codmir into other apps
- Building automation scripts
- CLI tool development
`;

export const SDK_MCP_TOOLS_DESCRIPTION = `
### Available MCP Tools (IDE Integration)

**SDK Knowledge:**
- \`get_sdk_reference\` - Get API documentation for a topic
- \`generate_sdk_code\` - Generate code for a use case

**Actions:**
- \`create_ticket\` - Create a ticket
- \`create_project\` - Create a project
- \`create_organization\` - Create an organization
- \`get_workspace_status\` - Check org/project setup
- \`get_sprint_tasks\` - Get sprint tasks
- \`execute_task\` - Run AI agent task
- \`store_conversation\` - Save conversation as docs
`;

/**
 * Get SDK instructions for a specific context
 */
export function getSDKInstructions(context: {
  includeQuickRef?: boolean;
  includeFullDocs?: boolean;
  includeMCPTools?: boolean;
}): string {
  let instructions = SDK_SYSTEM_INSTRUCTIONS;

  if (context.includeQuickRef) {
    instructions += '\n\n' + SDK_QUICK_REFERENCE;
  }

  if (context.includeMCPTools) {
    instructions += '\n\n' + SDK_MCP_TOOLS_DESCRIPTION;
  }

  return instructions;
}

/**
 * SDK topic documentation for AI reference
 */
export const SDK_TOPICS = {
  tickets: {
    title: 'Tickets API',
    methods: [
      { name: 'createTicket', signature: '(input: CreateTicketInput) => Promise<Ticket>', description: 'Create a new ticket' },
      { name: 'listTickets', signature: '(projectId: string, options?) => Promise<PaginatedResponse<Ticket>>', description: 'List tickets with filters' },
      { name: 'getTicket', signature: '(projectId: string, ticketId: string) => Promise<Ticket>', description: 'Get ticket details' },
      { name: 'updateTicket', signature: '(projectId: string, ticketId: string, input) => Promise<Ticket>', description: 'Update a ticket' },
      { name: 'deleteTicket', signature: '(projectId: string, ticketId: string) => Promise<void>', description: 'Delete a ticket' },
    ],
  },
  projects: {
    title: 'Projects API',
    methods: [
      { name: 'listProjects', signature: '() => Promise<Project[]>', description: 'List all projects' },
      { name: 'getProject', signature: '(projectId: string) => Promise<Project>', description: 'Get project details' },
      { name: 'createProject', signature: '(input: CreateProjectInput) => Promise<Project>', description: 'Create a new project' },
    ],
  },
  chat: {
    title: 'AI Chat API',
    methods: [
      { name: 'chat', signature: '(message: string, options?) => Promise<string>', description: 'Simple AI chat' },
      { name: 'streamChat', signature: '(message: string, options: { onChunk }) => Promise<string>', description: 'Streaming AI chat' },
    ],
  },
  agents: {
    title: 'AI Agent API',
    methods: [
      { name: 'createAgentTask', signature: '(input: CreateAgentTaskInput) => Promise<AgentTask>', description: 'Create an agent task' },
      { name: 'runAgentTask', signature: '(input: RunTaskInput) => Promise<TaskExecution>', description: 'Execute an agent task' },
      { name: 'getAgentTask', signature: '(taskId: string) => Promise<AgentTask>', description: 'Get task status' },
    ],
  },
} as const;

/**
 * Export types for the SDK
 */
export interface SDKMethod {
  name: string;
  signature: string;
  description: string;
}

export interface SDKTopic {
  title: string;
  methods: SDKMethod[];
}
