# Next.js build smoke

A small Next.js 15 app that imports `@codmir/sdk/nextjs` everywhere Next.js bundles code for the browser or the Edge
runtime, so `next build` fails if the SDK ever reaches a Node built-in there (`Module not found: Can't resolve 'fs'`):

- [`app/reporter.tsx`](app/reporter.tsx): a client component;
- [`app/error.tsx`](app/error.tsx): the App Router error boundary, also a client component;
- [`pages/_app.tsx`](pages/_app.tsx): the Pages Router app, which runs in the browser too;
- [`instrumentation.ts`](instrumentation.ts), with the SDK imported at the top: [`middleware.ts`](middleware.ts) makes
  Next.js build it for the Edge runtime as well as for Node.js.

[`check.mjs`](check.mjs) then reads `.next/` and checks that the SDK really is in each of those bundles, so a passing
build cannot be an empty one. CI runs this on Node 20 after building the SDK.

## Run

```bash
npm ci && npm run build                          # repo root: the app installs the built SDK from file:../..
cd examples/nextjs-build
npm install --no-audit --no-fund                 # no lockfile is committed: `file:` links do not round-trip through `npm ci`
npm run smoke
```

Expected output, after the `next build` report:

```
PASS  the client component (app/reporter.tsx) has the SDK in its browser chunks  (6 chunks for /page)
PASS  app/error.tsx has the SDK in its browser chunks  (6 chunks for /error)
PASS  pages/_app.tsx has the SDK in its browser chunks  (4 chunks for /_app)
PASS  middleware.ts was built
PASS  instrumentation.ts was built for the Edge runtime with the SDK
PASS  instrumentation.ts was built for Node.js with the SDK
ALL PASS: 6 checks
```

Nothing is sent anywhere: the app is built, never started.
