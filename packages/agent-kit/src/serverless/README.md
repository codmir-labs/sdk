# @codmir/sdk/serverless

Serverless AI execution SDK - Alternative to Modal.com with Grace Foundation governance.

## Overview

Run code in the cloud without managing infrastructure. Codmir Serverless provides:

- **Modal-like API** - Familiar decorator syntax
- **Hybrid execution** - Auto-routes to Modal, Fargate, GitHub, or Community nodes
- **Grace governance** - Ethical AI execution with audit trails
- **Carbon awareness** - Track and minimize environmental impact

## Installation

```bash
npm install @codmir/sdk
```

## Quick Start

```typescript
import { codmir, fn, logs, progress } from '@codmir/sdk/serverless';

// Create an app
const app = codmir.App({ name: 'my-app' });

// Define a function
const processData = fn(app, { cpu: 2, memory: '4GB', timeout: 300 })(
  async (data: string[]) => {
    logs.info('Processing started', { count: data.length });
    progress.start(data.length);
    
    const results = [];
    for (let i = 0; i < data.length; i++) {
      results.push(data[i].toUpperCase());
      progress.increment();
    }
    
    logs.info('Processing completed');
    return results;
  }
);

// Execute locally (development)
const localResult = await processData.local(['hello', 'world']);

// Execute in the cloud
const cloudResult = await processData.remote(['hello', 'world']);

// Auto-select based on environment
const result = await processData.call(['hello', 'world']);
```

## Execution Pools

| Pool | Best For | Cold Start | Cost | Max Duration |
|------|----------|------------|------|--------------|
| `modal` | Fast tasks, GPU | 300ms | 2 credits/min | 1 hour |
| `fargate` | Long-running | 60s | 1 credit/min | 24 hours |
| `github` | Batch, free tier | 30s | Free | 6 hours |
| `community` | Distributed | 5s | 0.5 credits/min | 1 hour |
| `local` | Development | 0 | Free | Unlimited |

## API Reference

### App

```typescript
const app = codmir.App({
  name: 'my-app',
  image: 'python:3.11',  // Default image
  secrets: ['API_KEY'],   // Secrets to inject
  grace: {
    enabled: true,
    preferGreen: true,    // Prefer low-carbon nodes
    maxBudget: 100,       // Credit limit
  },
});
```

### Functions

```typescript
// Basic function
const myFn = fn(app, { cpu: 2, memory: '4GB' })(async (x) => x * 2);

// GPU function
const inference = fn(app, { gpu: 'A100', pool: 'modal' })(
  async (prompt) => runModel(prompt)
);

// Long-running function
const longTask = fn(app, { timeout: 7200, pool: 'fargate' })(
  async (data) => processLargeDataset(data)
);

// Scheduled function (cron)
const daily = app.cron('0 9 * * *')(async () => {
  await generateReport();
});
```

### Sandbox

```typescript
const sandbox = app.sandbox({ 
  image: 'python:3.11',
  webAccess: true,
});

await sandbox.spawn();
await sandbox.exec('pip install numpy');
const result = await sandbox.exec('python -c "import numpy; print(numpy.__version__)"');
const tunnelUrl = await sandbox.tunnel(8000);
await sandbox.terminate();
```

### Images

```typescript
import { CodmirImage, Images } from '@codmir/sdk/serverless';

// Build custom image
const image = new CodmirImage({ base: 'python:3.11-slim' })
  .pip('numpy', 'pandas', 'scikit-learn')
  .apt('libgomp1')
  .run('python -m pip install --upgrade pip')
  .copy('./models', '/app/models')
  .env({ MODEL_PATH: '/app/models' });

// Use pre-built images
const app = codmir.App({ 
  name: 'ml-app',
  image: Images.pythonScientific(),
});
```

### Utilities

```typescript
import { logs, progress, checkpoint, retry } from '@codmir/sdk/serverless';

// Structured logging
logs.info('Processing started', { itemCount: 100 });
logs.error('Failed to process', { error: err.message });

// Progress tracking
progress.start(100);
progress.increment('Processing item 1');
progress.complete();

// Checkpointing for long tasks
await checkpoint.save({ processed: 50, results });
const state = await checkpoint.restore();

// Retry with backoff
const result = await retry(fetchData, { maxAttempts: 3 });
```

### Batch Processing

```typescript
const results = await myFn.map(
  ['item1', 'item2', 'item3', ...],
  { 
    maxConcurrency: 10,
    continueOnError: true,
    onProgress: (done, total) => console.log(`${done}/${total}`),
  }
);
```

## Grace Governance

All executions follow Grace Foundation principles:

```typescript
const app = codmir.App({
  name: 'my-app',
  grace: {
    enabled: true,
    requireApproval: false,   // Require human approval
    maxBudget: 100,           // Credit limit
    preferGreen: true,        // Low-carbon compute
    impactCategory: 'low',    // Ethical impact level
  },
});
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CODMIR_API_KEY` | API key for cloud execution |
| `CODMIR_API_URL` | API endpoint (default: https://codmir.com) |
| `CODMIR_FORCE_LOCAL` | Force local execution |
| `CODMIR_FORCE_REMOTE` | Force remote execution |
| `NODE_ENV` | Environment (development = local by default) |

## Comparison with Modal

| Feature | Modal | Codmir |
|---------|-------|--------|
| Serverless functions | ✅ | ✅ |
| GPU support | ✅ | ✅ (via Modal) |
| Sandbox | ✅ | ✅ |
| Long-running (>1hr) | ❌ | ✅ (Fargate) |
| Free tier | ❌ | ✅ (GitHub) |
| Ethical governance | ❌ | ✅ |
| Carbon tracking | ❌ | ✅ |
| Audit trails | ❌ | ✅ |
| Hybrid execution | ❌ | ✅ |

## Roadmap

- [ ] Direct Modal integration (current: via API)
- [ ] Community compute network
- [ ] GPU on Fargate
- [ ] Local GPU support
- [ ] WebGPU execution
- [ ] Full Modal feature parity

---

**Codmir** — Social contract between AI and humanity
