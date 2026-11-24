// A tiny server with a planted bug, a loop that calls it, and the log monitor finding the bug. Local mode: no account, no key,
// nothing leaves this machine. The only sockets are the ones between the loop and the server, on 127.0.0.1.
import { createServer } from "node:http";
import { createLogMonitor } from "@codmir/sdk/logs";
import { captureConsole } from "@codmir/sdk/logs/node";

const SECRET = "sk-live_51Hexample0123456789abcdefXYZ";

// In a real app this goes to a file or to stderr; here it is dropped, so the run prints only what the monitor kept.
console.error = () => {};

const findings = [];
const logs = createLogMonitor({
  service: "example-shop",
  release: "1.0.0",
  onBatch: (batch) => findings.push(...batch.findings),
});
captureConsole(logs, ["error"]);

const server = createServer((req, res) => {
  const user = Math.floor(Math.random() * 9000) + 1000;
  if (req.url === "/report") {
    // The planted bug: the handler fails and logs the key it was calling the upstream with.
    console.error(`report failed for user ${user}: upstream rejected api_key=${SECRET}`);
    res.writeHead(500).end("report failed");
  } else {
    res.writeHead(200).end("ok");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
for (let i = 0; i < 10; i++) {
  const res = await fetch(`${base}${i % 2 ? "/report" : "/health"}`);
  if (res.status >= 500) failed++;
  await res.arrayBuffer();
}
server.close();

await logs.flush(); // a batch is every 15 minutes; flush() ends the open one now
await logs.stop();

console.log(`served 10 requests, ${failed} failed`);
console.log(`findings: ${findings.length}`);
for (const f of findings) console.log(`  [${f.judgement}] ${f.hits} hits: ${f.title}\n  sample: ${f.sample}`);

if (JSON.stringify(findings).includes(SECRET) || findings.length !== 1) {
  console.error("the example is broken: expected one finding with the key masked");
  process.exit(1);
}
