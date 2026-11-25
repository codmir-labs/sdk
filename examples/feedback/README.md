# Feedback

One page with a plain form. It sends what a visitor says with `@codmir/sdk/feedback`, and shows every result of the call in
words. A small local server stands in for the real one (it checks the body as the real one does: an unknown key is
refused), so the example needs no account and no network beyond `127.0.0.1`. There is no UI component in the package: the
form is the page's own.

## Run

```bash
npm run build                                   # repo root: the example uses the built dist
cd examples/feedback && npm install
npm start                                       # http://127.0.0.1:3000/
```

On the page:

1. **Break something first** makes a request that fails (`/api/boom`, a 500) and captures an error. The next feedback
   then carries that error's id and the failed request.
2. **Send** sends the words. Under **What the server received last** is the body: the page's path (no query), the
   environment, the release, the time and the SDK, plus the error and the failed request from step 1. Never an
   address, an email or a name.
3. **Pretend the server says** picks the next answer: it took it, a wrong key, a plan that does not take feedback, too many
   calls, a refusal, an outage, a hotel Wi-Fi page. Each is shown in words, and the message you typed stays in the box when
   a retry makes sense.
4. **Take it back** deletes a message with the token kept on this device (`localStorage`, never the words).

## Check it

```bash
npm run smoke
```

Runs the SDK in Node against the stand-in once for every answer, checks that the page has words for every result, and sends
an empty and a too-long text (neither reaches the server). Exit 0 when all pass, 1 when any does not.

## What it shows

- `sendFeedback({ text, replyWhenFixed })`: never throws, so the form needs no `try`; read `result.ok`.
- `result.reason` is one of `not_configured`, `empty`, `too_long`, `unauthorized`, `payment_required`, `rate_limited`,
  `refused`, `unavailable`; `result.retryAfterMs` says how long a `rate_limited` answer asks to wait.
- `listFeedback()` and `deleteFeedback(id)`: what this device sent, and taking one back.
