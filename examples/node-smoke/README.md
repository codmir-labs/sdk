# Node smoke

Sends one error, one trace (a transaction with one child span) and one replay segment into a Codmir project, then
checks that each was accepted (CSL-5628). It is the Node half of the "SDK in a sample app reports an error, a trace
and a session replay" check; the browser recorder is covered by [`../fullstack-basic`](../fullstack-basic).

## Run

```bash
npm run build                                   # repo root: the example uses the built dist
cd examples/node-smoke && npm install
CODMIR_DSN=https://<your host>/api/overseer CODMIR_KEY=<project key> npm run smoke
```

- `CODMIR_DSN` (alias `CODMIR_ENDPOINT`): the same base the browser snippet uses; the SDK adds `/ingest` and `/replay`.
- `CODMIR_KEY` (alias `CODMIR_CLIENT_KEY`): the project key, **Settings > Codmir SDK**. Only its last 4 characters are printed.

One line per item: kind, HTTP status, the id sent (event id, trace id, replay id) and the server's answer. Exit code 0
when all three are accepted, 1 when any is not (non-2xx, reported as dropped, or never sent).

```
error  HTTP 200 id=ETj5bJEFQ8yc0x10z0RVZ accepted
trace  HTTP 200 id=66ba83fbf46f5ba7fa241b0d82af75c8 accepted
replay HTTP 202 id=080d633f-2249-4a53-a8df-a1c4502ab7a1 accepted
```

## Where to look afterwards

- **Issues:** an issue "codmir smoke: deliberate error", tagged `smoke=<run id>`.
- **Performance:** the transaction "codmir smoke transaction" with its `smoke.step` span; the trace id is printed.
- **The issue's replay:** the error carries `tags.replay_id`, so the issue detail links the replay (a snapshot and one event, not a real page).

## What it does and does not cover

The error and the transaction use the SDK's public API (`init`, `setTag`, `captureException`, `startTransaction`, `flush`).
The replay segment is built with the SDK's own `buildSegmentBody` and `replayEndpoint` from a small rrweb fixture and
POSTed with the same `x-overseer-key` header. Recording needs a browser, so the recorder itself is not exercised here.

Never run it against anything but a project you mean to write to. The test (`npm test -- examples/node-smoke` from the
root) runs the same code against a local stub on 127.0.0.1 only.
