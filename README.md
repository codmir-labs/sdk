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
| Error tracking | `@codmir/sdk/overseer` |
| Next.js | `@codmir/sdk/nextjs` |
| Express | `@codmir/sdk/express` |
| React Native | `@codmir/sdk/react-native` |
| Browser (vanilla) | `@codmir/sdk/browser` |
| Remix | `@codmir/sdk/remix` |
| Bug reporting | `@codmir/sdk/report` |
| API client | `@codmir/sdk` |
| Setup verification | `@codmir/sdk/verify` |

## What is in this package

`@codmir/sdk` is the error, tracing and replay SDK: error capture (`overseer`), tracing, session replay, the
framework integrations (Next.js, Express, Hono, Remix, React Native, browser), bug reporting, setup verification
and the API client.

The agent runtime, council, serverless, task-runner protocol, AI-call monitoring (`/ai`), MCP client (`/mcp`)
and the framework task helpers were removed from the published package in CSL-5590. They live in the private,
unpublished workspace `packages/agent-kit` (`@codmir/agent-kit`) in this repo. Importing `@codmir/sdk/agent`,
`/council`, `/serverless`, `/runtime`, `/ai` or `/mcp` no longer works.

## Session Replay

`@codmir/sdk/replay` records the page with [rrweb](https://github.com/rrweb-io/rrweb) (loaded lazily, only by this
entry) and uploads segments to Codmir. Call `startReplay()` after `init()`:

```typescript
import { init } from '@codmir/sdk/browser';
import { startReplay } from '@codmir/sdk/replay';

init({
  clientKey: 'osk_...',
  replaysSessionSampleRate: 0.1, // default 0: share of sessions recorded and uploaded every 30 s / 5,000 events
  replaysOnErrorSampleRate: 1.0, // default 1: keep the last 30-60 s, upload them plus the next 30 s on an error
});
startReplay();
```

Both rates at 0 record nothing. While a replay records, every error event carries `tags.replay_id`.

Privacy is on by default: every input is masked, `[data-private]` and `.private` text is masked, `[data-codmir-block]`
subtrees are not recorded, and password fields are masked whatever the config says. Pass
`startReplay({ privacy: { maskSelectors: [...], blockSelectors: [...] } })` to change the selectors.

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

## Bug Reporting

Report bugs against any software vendor programmatically. Auto-deduplicates, upvotes existing reports, and captures exceptions like Sentry. Also available as a standalone package: [`@codmir/report`](https://www.npmjs.com/package/@codmir/report).

```typescript
import { Codmir } from '@codmir/sdk/report';

Codmir.init({ projectKey: 'your-project-key' });

// File a structured bug report
await Codmir.reportBug({
  vendor: 'stripe',
  title: 'Webhook retries on 202',
  description: 'Duplicate events sent when endpoint returns 202 instead of 200.',
  severity: 'HIGH',
  reproSteps: '1. Set up webhook endpoint returning 202\n2. Send test event',
});

// Auto-capture exceptions
try {
  await thirdPartySDK.doSomething();
} catch (error) {
  await Codmir.captureException(error, {
    vendor: 'some-sdk',
    product: 'their-node-client',
    severity: 'HIGH',
  });
}

// Search existing reports
const results = await Codmir.searchBugs({
  vendor: 'stripe',
  query: 'webhook retry',
});

// Upvote
await Codmir.upvote('report-id');
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
