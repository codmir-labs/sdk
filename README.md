# @codmir/sdk

Official TypeScript/JavaScript SDK for the Codmir platform.

[![npm version](https://img.shields.io/npm/v/@codmir/sdk.svg)](https://www.npmjs.com/package/@codmir/sdk)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## Installation

```bash
npm install @codmir/sdk
```

## Platform Imports

| Use case | Import |
|----------|--------|
| AI monitoring | `@codmir/sdk/ai` |
| Error tracking | `@codmir/sdk/overseer` |
| Next.js | `@codmir/sdk/nextjs` |
| Express | `@codmir/sdk/express` |
| React Native | `@codmir/sdk/react-native` |
| Browser (vanilla) | `@codmir/sdk/browser` |
| Remix | `@codmir/sdk/remix` |
| Serverless | `@codmir/sdk/serverless` |
| API client | `@codmir/sdk` |
| Setup verification | `@codmir/sdk/verify` |

## AI Monitoring

Track every LLM call across providers with two lines of setup. Token usage, cost, latency, and errors are captured automatically.

### Wrap OpenAI

```typescript
import * as Codmir from '@codmir/sdk/ai';
import OpenAI from 'openai';

Codmir.init({
  dsn: process.env.CODMIR_DSN,
});

const openai = Codmir.wrapOpenAI(new OpenAI());

// Every call is now tracked — tokens, cost, latency
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### Wrap Anthropic

```typescript
import * as Codmir from '@codmir/sdk/ai';
import Anthropic from '@anthropic-ai/sdk';

Codmir.init({ dsn: process.env.CODMIR_DSN });

const anthropic = Codmir.wrapAnthropic(new Anthropic());

const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### Generic provider

```typescript
import { trackAICall } from '@codmir/sdk/ai';

const result = await trackAICall('custom', { model: 'llama-3' }, async () => {
  return await myProvider.generate('Hello');
});
```

### Usage summary

```typescript
const summary = Codmir.getAIUsageSummary();
console.log(`Total cost: $${summary.totalCost.toFixed(4)}`);
console.log(`Calls: ${summary.totalCalls}`);
console.log(`Avg latency: ${summary.avgLatencyMs}ms`);
```

## Agent Session Tracing

Correlate LLM calls into replayable agent sessions. Every tool call, decision, and error is captured in a timeline you can debug like a video.

```typescript
import * as Codmir from '@codmir/sdk/ai';

Codmir.init({ dsn: process.env.CODMIR_DSN });

// Start a session
const session = Codmir.startSession({
  agent: 'support-bot',
  metadata: { userId: 'u_123', ticket: 'T-456' },
});

// All LLM calls are automatically correlated
await openai.chat.completions.create({ ... });

// Add custom decision events
Codmir.addSessionEvent('decision', {
  action: 'escalate_to_human',
  reason: 'confidence_below_threshold',
  confidence: 0.42,
});

// Group related work into spans
Codmir.startSessionSpan('tool_execution');
// ... tool work ...
Codmir.endSessionSpan();

// End and flush to your dashboard
const completed = Codmir.endSession();
await Codmir.flushSession(completed);
```

## Error Tracking

### Next.js

```typescript
// instrumentation-client.ts
import * as Codmir from '@codmir/sdk/nextjs';

Codmir.init({
  dsn: process.env.NEXT_PUBLIC_OVERSEER_DSN,
  environment: process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_APP_VERSION,
});
```

### React Native

```typescript
import * as Codmir from '@codmir/sdk/react-native';

Codmir.init({
  dsn: 'https://your-project.codmir.com/api/overseer',
});

Codmir.trackScreenView('HomeScreen');
```

### Browser

```typescript
import { init, captureException } from '@codmir/sdk/browser';

init({
  dsn: 'https://your-project.codmir.com/api/overseer',
  trackClicks: true,
  trackRequests: true,
});
```

## Verify Your Setup

After installing, confirm the SDK can reach your project:

```typescript
import { verify, printVerifyResult } from '@codmir/sdk/verify';

const result = await verify({
  dsn: process.env.CODMIR_DSN,
  onProgress: (step) => console.log(`[${step.status}] ${step.message}`),
});

console.log(printVerifyResult(result));
```

Or the one-liner:

```typescript
import { quickVerify } from '@codmir/sdk/verify';

const ok = await quickVerify(process.env.CODMIR_DSN);
```

## API Client

```typescript
import { CodmirClient } from '@codmir/sdk';

const client = new CodmirClient({
  apiKey: process.env.CODMIR_API_KEY,
});

// Projects
const projects = await client.listProjects();

// Tickets
const ticket = await client.createTicket({
  title: 'Fix login bug',
  type: 'bug',
  priority: 'high',
  projectId: 'project-123',
});

// AI chat
const response = await client.chat('How is auth implemented?', {
  projectId: 'project-123',
});

// Agent tasks
const task = await client.createAgentTask({
  type: 'code_review',
  prompt: 'Review this PR for security issues',
  projectId: 'project-123',
});
```

## Configuration

```typescript
Codmir.init({
  dsn: process.env.CODMIR_DSN,
  environment: 'production',
  release: '1.2.0',
  sampleRate: 1.0,

  // AI monitoring options
  trackTokenUsage: true,
  trackCosts: true,
  trackLatency: true,
  capturePrompts: false,       // privacy-sensitive
  captureResponses: false,     // privacy-sensitive
  redactPatterns: [/sk-[a-zA-Z0-9]+/g],
});
```

## Error Handling

```typescript
import { CodmirClient, CodmirApiError } from '@codmir/sdk';

try {
  await client.getTicket('project-id', 'invalid-id');
} catch (error) {
  if (error instanceof CodmirApiError) {
    console.error(`${error.code}: ${error.message} (${error.statusCode})`);
  }
}
```

## TypeScript

Full type exports:

```typescript
import type {
  AIMonitorConfig,
  AIUsageSummary,
  AgentSession,
  SessionEvent,
  SessionSpan,
  Ticket,
  AgentTask,
} from '@codmir/sdk';
```

## Requirements

- Node.js >= 18.0.0
- TypeScript >= 5.0 (optional)

## License

[Apache-2.0](LICENSE)
