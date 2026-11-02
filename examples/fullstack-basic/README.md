# fullstack-basic: an error, a trace and a replay

A small Express app plus one page that use `@codmir/sdk` the way a customer would, and a local capture server that
checks every payload against the platform's real schemas. One `npm run smoke` proves that the SDK reports

- an **error** from the server (`GET /api/boom`) and one from the browser (the Throw button),
- a **trace**: one transaction with 3 linked spans (`GET /api/demo` is the `http.server` root, and its two calls to
  `/api/a` and `/api/b` are `http.client` children that carry a W3C `traceparent`),
- a **session replay** of the page, with every input masked, uploaded when the browser error fires.

Public entry points only: `@codmir/sdk/express`, `@codmir/sdk/browser`, `@codmir/sdk/replay`.

## Run it

From the repo root, build the SDK first. The example installs it from the repo (`file:../..`), so it gets the built
`dist`, and you reinstall after rebuilding the SDK.

```bash
npm ci && npm run build
cd examples/fullstack-basic
npm install
```

**Smoke (one command, headed Chrome under Xvfb, exit 0 or 1):**

```bash
npm run smoke
```

It needs Chrome (`google-chrome` or `chromium` on PATH, or `CHROME_PATH`) and `xvfb-run`. The browser is never
headless. It runs the app on port 3111 (`APP_PORT`) and the capture server on 8787 (`CAPTURE_PORT`).

**By hand, in three terminals:**

```bash
npm run capture-server                      # 1. http://localhost:8787/api/overseer, writes captures/*.json
CODMIR_CLIENT_KEY=any-value npm start       # 2. http://localhost:3000
curl localhost:3000/api/demo; curl localhost:3000/api/boom
# 3. open http://localhost:3000, type in the fields, press Throw
```

## Config (env only, no key in the repo)

| Variable | Default | |
| --- | --- | --- |
| `CODMIR_DSN` | `http://localhost:8787/api/overseer` | where events go; the SDK adds `/ingest` and `/replay` |
| `CODMIR_CLIENT_KEY` | none, required | the project key; any value works against the capture server |
| `CODMIR_TRACES_SAMPLE_RATE` | `1` | `0` sends no transaction |
| `PORT` | `3000` | |

## Expected output

The real output of `npm run smoke`:

```
Phase 1: tracesSampleRate=1
  [sampled] capture: 001-transaction.json transaction "GET /api/demo" with 2 child spans
  [sampled] capture: 002-error.json error "Server demo error: /api/boom"
  [sampled] capture: 003-replay.json replay 80ba21eb-852d-4d5e-846e-c2a92afe8adc segment 0 (42 events)
  [sampled] capture: 004-error.json error "Browser demo error: Throw button" (replay 80ba21eb-852d-4d5e-846e-c2a92afe8adc)
  [sampled] capture: 005-replay.json replay 80ba21eb-852d-4d5e-846e-c2a92afe8adc segment 1 (1 events)
Phase 2: tracesSampleRate=0
  [unsampled] capture: 001-error.json error "Server demo error: /api/boom"

Checks
PASS  no payload was rejected by the platform schemas
PASS  exactly 1 transaction  (1)
PASS  transaction has 3 spans: the root and 2 http.client children  (http.server "GET /api/demo" + http.client "GET /api/a", http.client "GET /api/b")
PASS  children are linked to the root by parent_span_id
PASS  all 3 span ids are distinct
PASS  both outbound calls carried a traceparent of this trace, naming their own span  (00-ffd8d3e7ade65465c1182391be347f3d-424fadc82f001677-01 / 00-ffd8d3e7ade65465c1182391be347f3d-cca409184ff537f0-01)
PASS  exactly 2 errors, one from the server and one from the browser  (2)
PASS  the browser error carries tags.replay_id  (80ba21eb-852d-4d5e-846e-c2a92afe8adc)
PASS  the server error has no replay_id
PASS  at least 1 replay segment matches that replay_id  (2 segment(s), 43 events)
PASS  the segment links the browser error (error_event_ids)
PASS  the replay recorded the typing, as asterisks only  (31 input event(s))
PASS  the typed password appears nowhere in any capture
PASS  the typed text field value appears nowhere in any capture
PASS  tracesSampleRate=0: no transaction  (0)
PASS  tracesSampleRate=0: the error still arrived  (1)

16/16 checks passed
```

`captures/sampled/` and `captures/unsampled/` hold every payload as JSON (`001-transaction.json`, `002-error.json`,
`003-replay.json`, ...). The `x-overseer-key` value is never written to them.

What the smoke asserts: exactly 1 transaction whose root and two `http.client` children are linked by `trace_id` and
parent ids; the two outbound requests carried a `traceparent` of that trace; exactly 2 errors, only the browser one
tagged `replay_id`; a replay segment with that id that lists the browser error; the text typed into the password
field and the name field appears nowhere in any capture, while the replay does contain the typing, as asterisks (so
the absence is masking and not missing input); with `CODMIR_TRACES_SAMPLE_RATE=0` no transaction, and the error
still arrives.

`schemas.mjs` is a copy of the platform's Zod schemas (source commit in its header). If the platform's wire format
changes, the smoke fails here first.

## Point it at testing

Nothing in the code changes, only the env:

1. In the Codmir project on testing, open **Settings > Codmir SDK** and copy the client key.
2. Run the app against it:

   ```bash
   CODMIR_DSN=https://testing.codmir.com/api/overseer CODMIR_CLIENT_KEY=<the key> npm start
   ```

3. Open http://localhost:3000, type something, press Throw, and call `/api/demo` and `/api/boom`.

What will show in that project once CSL-5614 (the private replay bucket) and CSL-5615 (the Overseer views) land:

- **Issues:** two new issues, `Server demo error: /api/boom` and `Browser demo error: Throw button`. The browser one
  links to its replay (`tags.replay_id`).
- **Traces:** one `GET /api/demo` transaction with its two `GET /api/a` and `GET /api/b` spans.
- **Replays:** one replay of the page where the typed text is asterisks.

Until then the data is accepted by ingest but not yet viewable. Each stored replay segment and each transaction is a
billed Overseer event, so the project needs a card on file and credits.

## Files

| | |
| --- | --- |
| `server.mjs` | Express app, SDK express entry, serves the page and bundles `client.js` with esbuild |
| `client.js`, `public/index.html` | the page: browser entry, `startReplay()`, the Throw button, a password field |
| `capture-server.mjs`, `schemas.mjs` | the local platform stand-in and the schemas it validates with |
| `smoke.mjs` | the end-to-end check |
| `browser-shims.js` | works around `@codmir/sdk` 2.2.0 bundling nanoid's Node build into its browser chunks (imports `crypto`, uses `Buffer`); delete it, and the `alias` and `inject` lines in `server.mjs`, when the SDK is fixed |
