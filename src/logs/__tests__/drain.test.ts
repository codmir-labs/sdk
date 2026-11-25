import { describe, expect, it } from "vitest";
import { findingEvent } from "../cloud";
import { createLogMonitor } from "../monitor";
import { Seen, parseLogLines } from "../parse";
import { readLog } from "../read";
import type { LogState } from "../types";

/** A drain's record, built from the fields of Vercel's log drain reference. */
let n = 0;
const rec = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `${++n}`, deploymentId: "dpl_233NRGRjVZX1caZrXWtz5g1TAksD", source: "lambda", host: "my-app-abc123.vercel.app", timestamp: 1795514400000, projectId: "prj_1", level: "info", environment: "production", ...o,
});
const px = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ timestamp: 1795514399000, method: "GET", host: "my-app.vercel.app", path: "/p", ...o });

type Way = "lines" | "array" | "calls";
const WAYS: Way[] = ["lines", "array", "calls"];

/** What a monitor makes of the records fed one of three ways: one JSON line each, one array, one call each. */
async function feed(records: Array<Record<string, unknown>>, way: Way) {
  const m = createLogMonitor({ batchMinutes: 10_000 });
  if (way === "lines") await readLog((async function* () { yield records.map((r) => JSON.stringify(r)).join("\n"); })(), m);
  else if (way === "array") await readLog((async function* () { yield JSON.stringify(records); })(), m);
  else {
    const seen = new Seen();
    for (const r of records) for (const p of parseLogLines(JSON.stringify(r), "auto", seen)) {
      if ("request" in p) m.request(p.request);
      else m.record(p.record);
    }
  }
  const s = m.stats();
  const out = { finds: m.findings().map((f) => `${f.title}|${f.hits}`).sort(), records: s.records, ignored: s.ignored };
  await m.stop();
  return out;
}

const ERR = (message: string, o: Record<string, unknown> = {}): Record<string, unknown> => rec({ level: "error", message, ...o });
const ROWS: Array<{ name: string; records: Array<Record<string, unknown>>; finds: string[]; records_?: number; ignored?: number }> = [
  { name: "A1 statusCode -1 is 500", records: [rec({ statusCode: -1, requestId: "r1", proxy: px() })], finds: ["GET /p answers 500|1"] },
  { name: "A1 statusCode -1 and a real proxy status is that one", records: [rec({ statusCode: -1, requestId: "r1", proxy: px({ statusCode: 502 }) })], finds: ["GET /p answers 502|1"] },
  { name: "A1 statusCode -1 and a proxy status that is none is 500", records: [rec({ statusCode: -1, proxy: px({ statusCode: 700 }) }), rec({ statusCode: -1, proxy: px({ path: "/q", statusCode: 99 }) })], finds: ["GET /p answers 500|1", "GET /q answers 500|1"] },
  { name: "A2 proxy.statusCode -1 counts no request, its text stays", records: [ERR("revalidation failed badly", { statusCode: 500, proxy: px({ statusCode: -1 }), requestId: "r2" })], finds: ["revalidation failed badly|1"], records_: 1 },
  { name: "A3 one request once however many records, whichever first", records: [rec({ statusCode: 500, requestId: "r3", proxy: px() }), rec({ statusCode: 500, requestId: "r3", proxy: px() })], finds: ["GET /p answers 500|1"], records_: 1 },
  { name: "A3 a console line with its request and an id counts the request once", records: [ERR("stderr one line", { type: "stderr", statusCode: 500, requestId: "r4", proxy: px() }), rec({ statusCode: 500, requestId: "r4", proxy: px() })], finds: ["GET /p answers 500|1", "stderr one line|1"] },
  { name: "A3 a console line without an id counts no request", records: [ERR("stdout without id", { type: "stdout", statusCode: 500, proxy: px() })], finds: ["stdout without id|1"], records_: 1 },
  { name: "A3 a record that is no console line and has no id counts each time", records: [rec({ statusCode: 500, proxy: px() }), rec({ statusCode: 500, proxy: px() })], finds: ["GET /p answers 500|2"], records_: 2 },
  { name: "A3 an id over 128 characters is no id", records: [rec({ statusCode: 500, requestId: "x".repeat(129), proxy: px() }), rec({ statusCode: 500, requestId: "x".repeat(129), proxy: px() }), ERR("long id console", { type: "fatal", statusCode: 500, requestId: "y".repeat(129), proxy: px() })], finds: ["GET /p answers 500|2", "long id console|1"], records_: 3 },
  { name: "A3 an id of 128 characters is one", records: [rec({ statusCode: 500, requestId: "x".repeat(128), proxy: px() }), rec({ statusCode: 500, requestId: "x".repeat(128), proxy: px() })], finds: ["GET /p answers 500|1"], records_: 1 },
  { name: "A3 a worse status later is the request, once", records: [rec({ statusCode: 200, requestId: "r5", proxy: px() }), rec({ statusCode: 500, requestId: "r5", proxy: px() })], finds: ["GET /p answers 500|1"], records_: 1, ignored: 0 },
  { name: "A3 a 404 and then a crash is the crash, once", records: [rec({ statusCode: 404, requestId: "r6", proxy: px() }), rec({ statusCode: -1, requestId: "r6", proxy: px() })], finds: ["GET /p answers 500|1"], records_: 1 },
  { name: "A3 a lesser status later changes nothing", records: [rec({ statusCode: 500, requestId: "r7", proxy: px() }), rec({ statusCode: 200, requestId: "r7", proxy: px() })], finds: ["GET /p answers 500|1"], records_: 1 },
  { name: "A4 proxy.path before path, proxy.method first, no query", records: [rec({ statusCode: 500, path: "/api/index", requestId: "r8", proxy: px({ method: "post", path: "/pay/9?token=abc" }) }), rec({ statusCode: 500, path: "/[slug]", method: "PUT" })], finds: ["POST /pay/:n answers 500|1", "PUT /[slug] answers 500|1"], records_: 2 },
  { name: "A5 firewall counts nothing", records: [ERR("blocked by rule", { source: "firewall", statusCode: 403, proxy: px({ statusCode: 403 }) })], finds: [], records_: 0 },
  { name: "A5 challenge, deny and rate_limit count nothing", records: ["challenge", "deny", "rate_limit"].map((a) => ERR(`waf ${a} line`, { statusCode: 429, proxy: px({ statusCode: 429, wafAction: a }) })), finds: [], records_: 0 },
  { name: "A5 log and bypass are counted", records: ["log", "bypass"].map((a, i) => ERR(`waf ${a} line`, { statusCode: 500, proxy: px({ path: `/w${i}`, statusCode: 500, wafAction: a }) })), finds: ["GET /w0 answers 500|1", "GET /w1 answers 500|1", "waf bypass line|1", "waf log line|1"] },
  { name: "A5 a build counts nothing", records: [ERR("build failed hard", { source: "build", type: "stderr", buildId: "bld_1" })], finds: [], records_: 0 },
  { name: "A6 the platform's own types are no text, their request counts", records: ["report", "delimiter", "metrics", "middleware-invocation", "edge-function-invocation"].map((t, i) => ERR(`platform ${t} text`, { type: t, statusCode: 500, requestId: `p${i}`, proxy: px({ path: `/t${i}` }) })), finds: ["GET /t0 answers 500|1", "GET /t1 answers 500|1", "GET /t2 answers 500|1", "GET /t3 answers 500|1", "GET /t4 answers 500|1"], records_: 5 },
  { name: "A6 the platform's lines go, the rest is read", records: [ERR("START RequestId: abc Version: $LATEST\nError: the real failure\nEND RequestId: abc\nREPORT RequestId: abc Duration: 3 ms\nINIT_START Runtime Version: nodejs")], finds: ["the real failure|1"], records_: 1 },
  { name: "A6 a message that is only the platform's is no text", records: [ERR("START RequestId: abc\nEND RequestId: abc"), ERR("[GET] /some/path status=500"), ERR("[GET] /some/path status=500 and then more")], finds: ["[GET] /some/path status=# and then more|1"], records_: 1 },
  { name: "A6 only a line that begins with it goes", records: [ERR("see START RequestId: abc in the log")], finds: ["see START RequestId: abc in the log|1"] },
];

describe("a drain's records: every rule, fed three ways", () => {
  for (const row of ROWS) {
    it(row.name, async () => {
      for (const way of WAYS) {
        const got = await feed(row.records, way);
        expect(got.finds, way).toEqual([...row.finds].sort());
        if (row.records_ !== undefined) expect(got.records, way).toBe(row.records_);
        if (row.ignored !== undefined) expect(got.ignored, way).toBe(row.ignored);
      }
    });
  }

  it("three records of one request in any order are one request and two lines", async () => {
    const R = rec({ statusCode: 500, requestId: "r9", proxy: px() });
    const C1 = ERR("boom number one", { type: "stderr", requestId: "r9", proxy: px({ statusCode: 500 }), statusCode: 500 });
    const C2 = ERR("boom number two", { type: "stderr", requestId: "r9", proxy: px({ statusCode: 500 }), statusCode: 500 });
    const orders = [[R, C1, C2], [R, C2, C1], [C1, R, C2], [C1, C2, R], [C2, R, C1], [C2, C1, R]];
    for (const o of orders) for (const way of WAYS) expect((await feed(o, way)).finds, way).toEqual(["GET /p answers 500|1", "boom number one|1", "boom number two|1"].sort());
  });

  it("several reads into one monitor still count a request once", async () => {
    const m = createLogMonitor({ batchMinutes: 10_000 });
    const line = JSON.stringify(rec({ statusCode: 500, requestId: "r10", proxy: px() }));
    for (let i = 0; i < 3; i++) await readLog((async function* () { yield line; })(), m);
    expect(m.findings().map((f) => f.hits)).toEqual([1]);
    await m.stop();
  });

  it("the CLI's own lines read as before", () => {
    const req = { type: "request", data: { requestMethod: "GET", requestPath: "/cli", responseStatusCode: 500, requestId: "c1", proxy: { statusCode: -1 } } };
    expect(parseLogLines(JSON.stringify(req))).toHaveLength(1);
    expect(parseLogLines(JSON.stringify(req))).toHaveLength(1);
  });

  it("the reference's own examples read without an error", () => {
    const build = { id: "1573817187330377061717300000", deploymentId: "dpl_233NRGRjVZX1caZrXWtz5g1TAksD", source: "build", host: "my-app-abc123.vercel.app", timestamp: 1573817187330, projectId: "gdufoJxB6b9b1fEqr1jUtFkyavUU", level: "info", message: "Build completed successfully", buildId: "bld_cotnkcr76", type: "stdout", projectName: "my-app" };
    const lambda = { id: "1573817250283254651097202070", deploymentId: "dpl_233NRGRjVZX1caZrXWtz5g1TAksD", source: "lambda", host: "my-app-abc123.vercel.app", timestamp: 1573817250283, projectId: "gdufoJxB6b9b1fEqr1jUtFkyavUU", level: "info", message: "API request processed", entrypoint: "api/index.js", requestId: "643af4e3-975a-4cc7-9e7a-1eda11539d90", statusCode: 200, path: "/api/users", executionRegion: "sfo1", environment: "production", traceId: "1b02cd14bb8642fd092bc23f54c7ffcd", spanId: "f24e8631bd11faa7", proxy: { timestamp: 1573817250172, method: "GET", host: "my-app.vercel.app", path: "/api/users?page=1", userAgent: ["Mozilla/5.0..."], referer: "https://my-app.vercel.app", region: "sfo1", statusCode: 200, clientIp: "120.75.16.101", scheme: "https", vercelCache: "MISS" } };
    for (const text of [JSON.stringify([build, lambda]), `${JSON.stringify(build)}\n${JSON.stringify(lambda)}`]) {
      const got = text.split("\n").flatMap((l) => parseLogLines(l));
      expect(got).toHaveLength(2);
      expect(got[0]).toMatchObject({ request: { method: "GET", path: "/api/users", status: 200 } });
      expect(got[1]).toMatchObject({ record: { level: "info", message: "API request processed" } });
    }
  });

  it("6,000 different ids stay bounded: the last 5,000 are remembered, the earlier forgotten", () => {
    const seen = new Seen();
    const one = (id: string): number => parseLogLines(JSON.stringify(rec({ statusCode: 500, requestId: id, proxy: px() })), "auto", seen).length;
    for (let i = 0; i < 6000; i++) expect(one(`id-${i}`)).toBe(1);
    expect(one("id-5999")).toBe(0);
    expect(one("id-1000")).toBe(0);
    expect(one("id-0")).toBe(1);
  });

  it("a hostile record is cheap", () => {
    const t0 = performance.now();
    const seen = new Seen();
    const lines = [
      JSON.stringify(rec({ statusCode: 500, requestId: "a".repeat(60_000), proxy: px() })),
      JSON.stringify(rec({ statusCode: 500, requestId: "__proto__", proxy: px() })),
      JSON.stringify(rec({ statusCode: 500, requestId: "__proto__", proxy: px() })),
      `{"__proto__":{"requestId":"x"},"deploymentId":"d","statusCode":500,"requestId":"constructor","proxy":{"method":"GET","path":"/p"}}`,
      JSON.stringify(ERR("START RequestId: ".repeat(3500))),
      JSON.stringify(ERR("START RequestId: x\n".repeat(3000))),
      "{\"deploymentId\":\"d\",\"message\":\"" + "START RequestId: ".repeat(6000),
    ];
    const out = lines.map((l) => parseLogLines(l, "auto", seen));
    expect(performance.now() - t0).toBeLessThan(50);
    expect(out[0]).toHaveLength(1);
    expect(out[1]).toHaveLength(1);
    expect(out[2]).toHaveLength(0);
    expect(out[5]).toHaveLength(0);
  });

  it("no id, address, referer, host or query is kept, shown or sent", async () => {
    const secrets = ["SECRET-REQ-ID-77", "203.0.113.9", "https://ref.example/page", "secret-host.example.com", "token=hunter2", "ja3digestABC", "ja4digestDEF", "rule_SECRETRULE"];
    const states: LogState[] = [];
    const m = createLogMonitor({ store: { load: () => undefined, save: (s) => void states.push(s) } });
    const records = [
      rec({ statusCode: 500, requestId: secrets[0], host: secrets[3], ja3Digest: secrets[5], ja4Digest: secrets[6], proxy: px({ path: `/pay?${secrets[4]}`, clientIp: secrets[1], referer: secrets[2], host: secrets[3], wafRuleId: secrets[7], wafAction: "log" }) }),
      ERR("it failed here", { type: "stderr", requestId: secrets[0], host: secrets[3], statusCode: 500, proxy: px({ path: `/pay?${secrets[4]}`, clientIp: secrets[1], referer: secrets[2], statusCode: 200 }) }),
    ];
    await readLog((async function* () { yield records.map((r) => JSON.stringify(r)).join("\n"); })(), m);
    const found = m.findings();
    await m.flush();
    await m.stop();
    expect(found.length).toBeGreaterThan(1);
    const all = JSON.stringify([found, states, found.map((f) => findingEvent(f, {}))]);
    for (const s of secrets) expect(all).not.toContain(s);
  });
});
