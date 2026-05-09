<p align="center">
  <a href="https://codmir.com">
    <img src="https://codmir.com/logo-dark.svg" alt="Codmir" width="200" />
  </a>
</p>

<h3 align="center">The SDK for developers who vibe code — and need someone to maintain it.</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@codmir/sdk"><img src="https://img.shields.io/npm/v/@codmir/sdk?style=flat-square&color=blue" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@codmir/sdk"><img src="https://img.shields.io/npm/dm/@codmir/sdk?style=flat-square&color=green" alt="npm downloads" /></a>
  <a href="https://github.com/codmir-labs/sdk/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-orange?style=flat-square" alt="license" /></a>
  <a href="https://codmir.com/docs/sdk"><img src="https://img.shields.io/badge/docs-codmir.com-purple?style=flat-square" alt="docs" /></a>
</p>

<p align="center">
  <a href="https://codmir.com/docs/sdk">Documentation</a> &middot;
  <a href="https://codmir.com/get-started">Get Started</a> &middot;
  <a href="https://github.com/codmir-labs/sdk/issues">Issues</a> &middot;
  <a href="https://codmir.com/discord">Discord</a>
</p>

---

## What is this?

`@codmir/sdk` is the open-source client library for the [Codmir](https://codmir.com) platform. It captures errors, tracks performance, records sessions, and connects your app to Codmir's AI-powered maintenance layer.

**You write the code. Codmir keeps it alive.**

```bash
npm install @codmir/sdk
```

## Quick Start

```typescript
import { Codmir } from '@codmir/sdk'

const codmir = new Codmir({
  projectId: 'your-project-id',
  apiKey: 'your-api-key',
})

// Capture errors automatically
codmir.captureException(new Error('Something broke'))

// Track custom events
codmir.captureEvent({
  type: 'deployment',
  data: { version: '1.2.0', environment: 'production' },
})
```

## Platform-Specific Setup

| Platform | Package | Install |
|----------|---------|---------|
| **Node.js** | `@codmir/sdk` | `npm i @codmir/sdk` |
| **Next.js** | `@codmir/sdk/nextjs` | `npm i @codmir/sdk` |
| **Express** | `@codmir/sdk/express` | `npm i @codmir/sdk` |
| **Remix** | `@codmir/sdk/remix` | `npm i @codmir/sdk` |
| **React Native** | `@codmir/sdk/react-native` | `npm i @codmir/sdk` |
| **Browser** | `@codmir/sdk/browser` | `npm i @codmir/sdk` |
| **Serverless** | `@codmir/sdk/serverless` | `npm i @codmir/sdk` |
| **AI Monitoring** | `@codmir/sdk/ai` | `npm i @codmir/sdk` |

### Next.js

```typescript
// app/layout.tsx
import { CodmirProvider } from '@codmir/sdk/nextjs'

export default function RootLayout({ children }) {
  return (
    <CosmirProvider projectId="your-project-id">
      {children}
    </CosmirProvider>
  )
}
```

### React Native

```typescript
import { CosmirNative } from '@codmir/sdk/react-native'

CosmirNative.init({
  projectId: 'your-project-id',
  enableCrashReporting: true,
  enablePerformanceTracking: true,
})
```

### Browser

```typescript
import { CosmirBrowser } from '@codmir/sdk/browser'

CosmirBrowser.init({
  projectId: 'your-project-id',
  enableSessionReplay: true,
  enableWebVitals: true,
})
```

### Express

```typescript
import express from 'express'
import * as Codmir from '@codmir/sdk/express'

Codmir.init({ dsn: process.env.CODMIR_DSN })

const app = express()

app.use(Codmir.requestHandler())   // track every request
app.use(Codmir.tracingHandler())   // measure performance

app.get('/api/users', (req, res) => {
  res.json({ users: [] })
})

app.use(Codmir.errorHandler())     // catch + report errors
```

### Remix

```typescript
// entry.server.tsx
import * as Codmir from '@codmir/sdk/remix'

Codmir.init({ dsn: process.env.CODMIR_DSN })

export const handleError = Codmir.handleError

// In routes — wrap loaders and actions
import { wrapLoader, wrapAction } from '@codmir/sdk/remix'

export const loader = wrapLoader(async ({ request }) => {
  return json({ data: await getData() })
})
```

### Serverless (AWS Lambda, Cloudflare Workers, etc.)

```typescript
import { wrapHandler } from '@codmir/sdk/serverless'

export const handler = wrapHandler(async (event) => {
  // Your function logic
  return { statusCode: 200, body: 'OK' }
})
```

## AI Tracking — Track Your AI, Not Just Your Users

This is what makes Codmir different. Every team using AI (OpenAI, Claude, custom agents) has zero visibility into what the AI is doing, how much it costs, and whether it's working correctly.

```typescript
import { init, wrapOpenAI, wrapAnthropic, getAIUsageSummary } from '@codmir/sdk/ai'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

init({
  dsn: process.env.CODMIR_DSN,
  trackTokenUsage: true,
  trackCosts: true,
  trackLatency: true,
})

// Wrap your AI clients — zero code changes needed
const openai = wrapOpenAI(new OpenAI())
const anthropic = wrapAnthropic(new Anthropic())

// Use them exactly as before — Codmir tracks everything
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
})

// See accumulated stats
const stats = getAIUsageSummary()
// { totalCalls: 42, totalCost: 1.23, avgLatency: 850, byModel: { ... } }
```

**What gets tracked:**
- Token usage (input/output) per call
- Cost estimation per model with built-in pricing tables
- Latency per call
- Errors with full context (model, params, failure reason)
- Usage summaries broken down by provider and model
- Optional prompt/response capture with automatic redaction

## Features

### Error Tracking
Capture exceptions with full stack traces, breadcrumbs, and context. Codmir's AI automatically triages errors and suggests fixes.

### Session Replay
Record and replay user sessions to see exactly what happened before an error. Privacy-safe — sensitive data is automatically scrubbed.

### Performance Monitoring
Track Core Web Vitals, custom metrics, and transaction traces. Get alerted when performance degrades.

### AI Agent API
Run automated tasks and workflows through Codmir's AI agent system.

```typescript
import { Agent } from '@codmir/sdk/agent'

const agent = new Agent({ projectId: 'your-project-id' })

const result = await agent.run({
  task: 'Review this pull request for security issues',
  context: { repo: 'my-app', pr: 42 },
})
```

### MCP Integration
Use Codmir as an MCP server in Claude, Cursor, or any MCP-compatible tool.

```typescript
import { CosmirMCPServer } from '@codmir/sdk/mcp'

const server = new CosmirMCPServer({
  projectId: 'your-project-id',
  tools: ['search-errors', 'get-metrics', 'run-agent'],
})

server.start()
```

## Why Open Source?

The SDK runs inside **your** application. You should be able to:

- **Audit** exactly what data is captured and sent
- **Extend** the SDK for your specific needs
- **Trust** that nothing happens without your knowledge
- **Contribute** fixes and improvements back

The SDK is Apache 2.0 licensed. The Codmir platform (AI agents, dashboards, error triage) is a hosted service at [codmir.com](https://codmir.com).

## Architecture

```
Your App
  |
  +-- @codmir/sdk (this repo)
  |     |
  |     +-- Captures errors, events, performance data
  |     +-- Records session replays
  |     +-- Sends to Codmir API
  |
  +-- codmir.com (hosted platform)
        |
        +-- AI-powered error triage
        +-- Context capsules (errors + code + deploys linked)
        +-- Agent system for automated fixes
        +-- Dashboards & alerting
```

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
# Clone the repo
git clone https://github.com/codmir-labs/sdk.git
cd sdk

# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build
```

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <b>Built by <a href="https://codmir.com">Codmir Labs</a></b>
  <br />
  <sub>You vibe code. We maintain it.</sub>
</p>
