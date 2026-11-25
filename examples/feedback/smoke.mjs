// Runs the SDK in Node against the stand-in server, once for every answer it can give, and checks the page has words for
// each result. Exits 1 on the first thing that is not so. No browser, no network beyond 127.0.0.1.
import { readFileSync } from "node:fs";
import { init } from "@codmir/sdk/overseer";
import { deleteFeedback, listFeedback, sendFeedback } from "@codmir/sdk/feedback";
import { KEY, start } from "./server.mjs";

const server = await start(0);
const origin = `http://127.0.0.1:${server.address().port}`;
const setMode = (mode) => fetch(`${origin}/demo/mode`, { method: "POST", body: JSON.stringify({ mode }) });
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};

// What a page has and a server has not: one visitor, whose receipts are kept (here in memory, there is no localStorage).
globalThis.document = new EventTarget();

init({ dsn: `${origin}/api/overseer`, clientKey: KEY, environment: "example", release: "1.0.0" });

const expected = {
  ok: "ok",
  unauthorized: "unauthorized",
  payment: "payment_required",
  limited: "rate_limited",
  refused: "refused",
  down: "unavailable",
  html: "unavailable",
};
for (const [mode, reason] of Object.entries(expected)) {
  await setMode(mode);
  const result = await sendFeedback(`The save button does nothing (${mode})`);
  const got = result.ok ? "ok" : result.reason;
  check(`the server says ${mode}`, got === reason, `${got}${result.retryAfterMs ? ` after ${result.retryAfterMs} ms` : ""}`);
}

await setMode("ok");
check("nothing to send is not sent", (await sendFeedback("   ")).reason === "empty");
check("too long is not cut", (await sendFeedback("x".repeat(2001))).reason === "too_long");

const [kept] = listFeedback();
check("the receipt is kept", Boolean(kept), kept?.id);
check("a receipt is taken back", (await deleteFeedback(kept.id)).ok === true);
check("and is gone", listFeedback().length === 0);

const served = await fetch(`${origin}/?from=mail`);
check("the page is served as HTML", served.headers.get("content-type") === "text/html" && (await served.text()).startsWith("<!doctype html>"));
check("and the SDK beside it", (await (await fetch(`${origin}/sdk/feedback/index.js`)).text()).includes("sendFeedback"));

const page = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
for (const reason of ["not_configured", "empty", "too_long", "unauthorized", "payment_required", "rate_limited", "refused", "unavailable"]) {
  check(`the page has words for ${reason}`, page.includes(`${reason}:`));
}

server.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("feedback example: all checks passed");
