import { describe, expect, it } from "vitest";
import { MAX_LINE, parseLogLine, parseLogLines } from "../parse";
import type { LogFormat, ParsedLine } from "../types";

// [group, case, format, line, exactly what is read]. The times are 2026-11-24 10:00:00 UTC unless the line says otherwise.
const TABLE: Array<[string, string, LogFormat, string, ParsedLine[]]> = [
  ["json", "level word + msg", "json", "{\"level\":\"error\",\"msg\":\"boom\",\"time\":\"2026-11-24T10:00:00Z\",\"service\":\"api\",\"release\":\"1.2.3\"}", [{"record":{"level":"error","message":"boom","time":1795514400000,"release":"1.2.3","service":"api"}}]],
  ["json", "severity, message, ts seconds", "json", "{\"severity\":\"WARNING\",\"message\":\"slow disk\",\"ts\":1795514400,\"logger\":\"disk\"}", [{"record":{"level":"warning","message":"slow disk","time":1795514400000,"service":"disk"}}]],
  ["json", "lvl + event, ms time, dd.version", "json", "{\"lvl\":\"critical\",\"event\":\"queue stuck\",\"timestamp\":1795514400123,\"dd\":{\"version\":\"9.9\"}}", [{"record":{"level":"fatal","message":"queue stuck","time":1795514400123,"release":"9.9"}}]],
  ["json", "log.level + @timestamp microseconds", "json", "{\"log\":{\"level\":\"error\"},\"message\":\"m\",\"@timestamp\":1795514400123456}", [{"record":{"level":"error","message":"m","time":1795514400123}}]],
  ["json", "nanoseconds", "json", "{\"level\":\"error\",\"msg\":\"m\",\"time\":1795514400123456789}", [{"record":{"level":"error","message":"m","time":1795514400123}}]],
  ["json", "pino numbers", "json", "{\"level\":60,\"msg\":\"dead\"}", [{"record":{"level":"fatal","message":"dead"}}]],
  ["json", "error object with type", "json", "{\"level\":\"error\",\"msg\":\"save failed\",\"error\":{\"type\":\"DbError\",\"message\":\"deadlock\"}}", [{"record":{"level":"error","message":"save failed: DbError: deadlock"}}]],
  ["json", "error object only gives level error", "json", "{\"err\":{\"message\":\"only the error\"}}", [{"record":{"level":"error","message":"only the error"}}]],
  ["json", "no message is nothing", "json", "{\"level\":\"error\",\"a\":1}", []],
  ["json", "method/path/status", "json", "{\"method\":\"get\",\"path\":\"/users/42?x=1\",\"status\":500,\"durationMs\":31.5,\"userAgent\":\"curl/8.0\",\"time\":1795514400000}", [{"request":{"method":"GET","path":"/users/42","status":500,"durationMs":31.5,"userAgent":"curl/8.0","time":1795514400000}}]],
  ["json", "req/res", "json", "{\"level\":30,\"req\":{\"method\":\"POST\",\"url\":\"/a\",\"headers\":{\"user-agent\":\"Mozilla/5.0\"}},\"res\":{\"statusCode\":502},\"responseTime\":12}", [{"request":{"method":"POST","path":"/a","status":502,"durationMs":12,"userAgent":"Mozilla/5.0"}}]],
  ["json", "httpRequest", "json", "{\"severity\":\"ERROR\",\"httpRequest\":{\"requestMethod\":\"GET\",\"requestUrl\":\"https://h.example/x/y?q=1#f\",\"status\":503,\"userAgent\":\"bot\"}}", [{"request":{"method":"GET","path":"/x/y","status":503,"userAgent":"bot"}}]],
  ["json", "request/response", "json", "{\"request\":{\"method\":\"PUT\",\"url\":\"/p\"},\"response\":{\"status\":404},\"elapsed\":4}", [{"request":{"method":"PUT","path":"/p","status":404,"durationMs":4}}]],
  ["json", "request at error level under 400 stays a record", "json", "{\"level\":\"error\",\"method\":\"GET\",\"path\":\"/x\",\"status\":200,\"msg\":\"handler threw after reply\"}", [{"record":{"level":"error","message":"handler threw after reply","path":"/x"}}]],
  ["json", "deeper than 20 is text", "json", "{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":1}}}}}}}}}}}}}}}}}}}}}", [{"record":{"level":"info","message":"{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":{\"a\":1}}}}}}}}}}}}}}}}}}}}}"}}]],
  ["json", "not JSON is text", "json", "{\"level\":\"error\", broken", [{"record":{"level":"info","message":"{\"level\":\"error\", broken"}}]],
  ["json", "array of objects", "json", "[{\"level\":\"error\",\"msg\":\"one\"},{\"level\":\"warn\",\"msg\":\"two\"}]", [{"record":{"level":"error","message":"one"}},{"record":{"level":"warning","message":"two"}}]],
  ["vercel", "cli request", "vercel", "{\"type\":\"request\",\"data\":{\"timestamp\":1795514400000,\"requestMethod\":\"GET\",\"requestPath\":\"/api/x\",\"httpStatus\":500,\"clientUserAgent\":\"Mozilla/5.0\",\"requestHostname\":\"h.example\",\"environment\":\"production\",\"deploymentId\":\"dpl_abc123\"}}", [{"request":{"method":"GET","path":"/api/x","status":500,"userAgent":"Mozilla/5.0","time":1795514400000,"release":"dpl_abc123","service":"production"}}]],
  ["vercel", "cli log", "vercel", "{\"type\":\"log\",\"data\":{\"timestamp\":1795514400000,\"level\":\"error\",\"source\":\"lambda\",\"message\":\"db down\",\"requestMethod\":\"GET\",\"requestPath\":\"/api/x\",\"domain\":\"h.example\",\"environment\":\"production\",\"deploymentId\":\"dpl_abc123\"}}", [{"record":{"level":"error","message":"db down","time":1795514400000,"path":"/api/x","release":"dpl_abc123","service":"production lambda"}}]],
  ["vercel", "cli summary is nothing", "vercel", "{\"type\":\"summary\",\"data\":{\"total\":3}}", []],
  ["vercel", "cli error status is nothing", "vercel", "{\"status\":\"error\",\"message\":\"not logged in\"}", []],
  ["vercel", "drain, request only", "vercel", "{\"id\":\"1\",\"timestamp\":1795514400000,\"source\":\"edge\",\"deploymentId\":\"dpl_1\",\"environment\":\"preview\",\"host\":\"h.example\",\"path\":\"/a\",\"statusCode\":404,\"proxy\":{\"method\":\"GET\",\"path\":\"/a\",\"statusCode\":404,\"userAgent\":[\"Googlebot\"],\"timestamp\":1795514400000}}", [{"request":{"method":"GET","path":"/a","status":404,"userAgent":"Googlebot","time":1795514400000,"release":"dpl_1","service":"preview edge"}}]],
  ["vercel", "drain, message only", "vercel", "{\"id\":\"2\",\"timestamp\":1795514400000,\"level\":\"warning\",\"message\":\"retrying\",\"source\":\"lambda\",\"environment\":\"production\",\"path\":\"/a\"}", [{"record":{"level":"warning","message":"retrying","time":1795514400000,"path":"/a","service":"production lambda"}}]],
  ["vercel", "drain, response 500 and message gives the request", "vercel", "{\"id\":\"3\",\"timestamp\":1795514400000,\"level\":\"error\",\"message\":\"oops\",\"source\":\"lambda\",\"environment\":\"production\",\"statusCode\":500,\"proxy\":{\"method\":\"POST\",\"path\":\"/pay\",\"statusCode\":500,\"userAgent\":[\"x\"]}}", [{"request":{"method":"POST","path":"/pay","status":500,"userAgent":"x","time":1795514400000,"service":"production lambda"}}]],
  ["vercel", "drain, response 200 and a warning message gives the record", "vercel", "{\"id\":\"4\",\"timestamp\":1795514400000,\"level\":\"warning\",\"message\":\"slow\",\"source\":\"lambda\",\"environment\":\"production\",\"statusCode\":200,\"proxy\":{\"method\":\"GET\",\"path\":\"/s\",\"statusCode\":200}}", [{"record":{"level":"warning","message":"slow","time":1795514400000,"path":"/s","service":"production lambda"}}]],
  ["vercel", "drain, response 200 and an info message gives the request", "vercel", "{\"id\":\"5\",\"timestamp\":1795514400000,\"level\":\"info\",\"message\":\"done\",\"source\":\"lambda\",\"environment\":\"production\",\"statusCode\":200,\"proxy\":{\"method\":\"GET\",\"path\":\"/s\",\"statusCode\":200}}", [{"request":{"method":"GET","path":"/s","status":200,"time":1795514400000,"service":"production lambda"}}]],
  ["vercel", "older CLI flat line", "vercel", "{\"timestampInMs\":1795514400000,\"level\":\"error\",\"message\":\"boom\",\"source\":\"lambda\",\"requestMethod\":\"GET\",\"requestPath\":\"/old\",\"responseStatusCode\":500}", [{"request":{"method":"GET","path":"/old","status":500,"time":1795514400000,"service":"lambda"}}]],
  ["vercel", "drain array", "vercel", "[{\"id\":\"6\",\"timestamp\":1795514400000,\"level\":\"error\",\"message\":\"a\",\"source\":\"lambda\"},{\"id\":\"7\",\"timestamp\":1795514400000,\"source\":\"edge\",\"proxy\":{\"method\":\"GET\",\"path\":\"/b\",\"statusCode\":502}}]", [{"record":{"level":"error","message":"a","time":1795514400000,"service":"lambda"}},{"request":{"method":"GET","path":"/b","status":502,"time":1795514400000,"service":"edge"}}]],
  ["railway", "attributes carry level and request", "railway", "{\"timestamp\":\"2026-11-24T10:00:00.000000000Z\",\"severity\":\"info\",\"message\":\"GET /x\",\"attributes\":{\"level\":\"error\",\"method\":\"GET\",\"path\":\"/x\",\"status\":500}}", [{"request":{"method":"GET","path":"/x","status":500,"time":1795514400000}}]],
  ["railway", "stderr severity", "railway", "{\"timestamp\":\"2026-11-24T10:00:00Z\",\"severity\":\"error\",\"message\":\"it broke\",\"attributes\":{}}", [{"record":{"level":"error","message":"it broke","time":1795514400000}}]],
  ["journald", "priority 3 string message", "journald", "{\"PRIORITY\":\"3\",\"MESSAGE\":\"disk full\",\"__REALTIME_TIMESTAMP\":\"1795514400123456\",\"_SYSTEMD_UNIT\":\"backup.service\",\"SYSLOG_IDENTIFIER\":\"bk\"}", [{"record":{"level":"error","message":"disk full","time":1795514400123,"service":"backup"}}]],
  ["journald", "priority 4 is warning", "journald", "{\"PRIORITY\":\"4\",\"MESSAGE\":\"low memory\",\"SYSLOG_IDENTIFIER\":\"kernel\"}", [{"record":{"level":"warning","message":"low memory","service":"kernel"}}]],
  ["journald", "priority 0-2 fatal, 5-6 info, 7 debug", "journald", "{\"PRIORITY\":\"2\",\"MESSAGE\":\"panic\",\"_COMM\":\"init\"}", [{"record":{"level":"fatal","message":"panic","service":"init"}}]],
  ["journald", "byte array message", "journald", "{\"PRIORITY\":\"3\",\"MESSAGE\":[104,105,226,130,172],\"_COMM\":\"x\"}", [{"record":{"level":"error","message":"hi€","service":"x"}}]],
  ["journald", "null message is nothing", "journald", "{\"PRIORITY\":\"6\",\"MESSAGE\":null}", []],
  ["journald", "json message keeps the journal's service and time", "journald", "{\"PRIORITY\":\"6\",\"MESSAGE\":\"{\\\"level\\\":\\\"error\\\",\\\"msg\\\":\\\"inner\\\",\\\"time\\\":1}\",\"__REALTIME_TIMESTAMP\":\"1795514400000000\",\"_SYSTEMD_UNIT\":\"web.service\"}", [{"record":{"level":"error","message":"inner","time":1795514400000,"service":"web"}}]],
  ["pino", "err.type and err.message", "pino", "{\"level\":50,\"time\":1795514400000,\"pid\":1,\"hostname\":\"h\",\"name\":\"svc\",\"err\":{\"type\":\"TypeError\",\"message\":\"x is undefined\",\"stack\":\"TypeError: ...\"},\"msg\":\"request failed\"}", [{"record":{"level":"error","message":"request failed: TypeError: x is undefined","time":1795514400000,"service":"svc"}}]],
  ["pino", "warn 40", "pino", "{\"level\":40,\"time\":1795514400000,\"msg\":\"careful\"}", [{"record":{"level":"warning","message":"careful","time":1795514400000}}]],
  ["pino", "error 50", "pino", "{\"level\":50,\"time\":1795514400000,\"msg\":\"bad\"}", [{"record":{"level":"error","message":"bad","time":1795514400000}}]],
  ["pino", "pino-http", "pino", "{\"level\":50,\"time\":1795514400000,\"req\":{\"id\":1,\"method\":\"GET\",\"url\":\"/q?a=b\",\"headers\":{\"user-agent\":\"curl/8\"}},\"res\":{\"statusCode\":500},\"err\":{\"type\":\"Error\",\"message\":\"x\"},\"responseTime\":7,\"msg\":\"request errored\"}", [{"request":{"method":"GET","path":"/q","status":500,"durationMs":7,"userAgent":"curl/8","time":1795514400000}}]],
  ["clf", "common", "clf", "203.0.113.9 - frank [10/Oct/2000:13:55:36 -0700] \"GET /apache_pb.gif?x=1 HTTP/1.0\" 200 2326", [{"request":{"method":"GET","path":"/apache_pb.gif","status":200,"time":971211336000}}]],
  ["clf", "combined", "clf", "203.0.113.9 - - [24/Nov/2026:10:00:00 +0000] \"POST /login HTTP/1.1\" 401 12 \"https://ref.example/\" \"Mozilla/5.0 (X11)\"", [{"request":{"method":"POST","path":"/login","status":401,"userAgent":"Mozilla/5.0 (X11)","time":1795514400000}}]],
  ["clf", "not a clf line is text", "clf", "something else entirely", [{"record":{"level":"info","message":"something else entirely"}}]],
  ["text", "iso time and level", "text", "2026-11-24T10:00:00.250Z ERROR payment failed order 55", [{"record":{"level":"error","message":"payment failed order 55","time":1795514400250}}]],
  ["text", "space time without a zone is UTC", "text", "2026-11-24 10:00:01 WARN slow query", [{"record":{"level":"warning","message":"slow query","time":1795514401000}}]],
  ["text", "bracket level", "text", "[error] connect() failed (111: Connection refused)", [{"record":{"level":"error","message":"connect() failed (111: Connection refused)"}}]],
  ["text", "bracket time", "text", "[24/Nov/2026:10:00:00 +0000] [warn] upstream slow", [{"record":{"level":"warning","message":"upstream slow","time":1795514400000}}]],
  ["text", "android", "text", "E/AndroidRuntime(1234): FATAL EXCEPTION: main", [{"record":{"level":"error","message":"AndroidRuntime(1234): FATAL EXCEPTION: main"}}]],
  ["text", "glog", "text", "E1124 10:00:00.123456 1 main.go:12] bad thing", [{"record":{"level":"error","message":"bad thing"}}]],
  ["text", "logfmt", "text", "time=\"2026-11-24T10:00:00Z\" level=error msg=\"db down: \\\"x\\\"\" svc=api", [{"record":{"level":"error","message":"db down: \"x\"","time":1795514400000}}]],
  ["text", "colon level", "text", "Error: cannot open file", [{"record":{"level":"error","message":"cannot open file"}}]],
  ["text", "no level is info", "text", "listening on port 3000", [{"record":{"level":"info","message":"listening on port 3000"}}]],
  ["text", "level word far away is not a level", "text", "this line has a long start that goes on and on for sixty characters and then the word ERROR at the end", [{"record":{"level":"info","message":"this line has a long start that goes on and on for sixty characters and then the word ERROR at the end"}}]],
  ["text", "stack frame is nothing", "text", "    at Object.<anonymous> (/srv/app.js:1:2)", []],
  ["text", "caused by is nothing", "text", "Caused by: java.io.IOException: closed", []],
  ["text", "python frame is nothing", "text", "  File \"/srv/app.py\", line 12, in handler", []],
  ["text", "a prompt is nothing", "text", "user@host:~$", []],
  ["text", "empty is nothing", "text", "   ", []],
  ["text", "ansi colours are stripped", "text", "\u001b[31mERROR\u001b[0m something failed", [{"record":{"level":"error","message":"something failed"}}]],
  ["text", "docker timestamp in front of json", "text", "2026-11-24T10:00:00.5Z {\"level\":\"error\",\"msg\":\"in a container\"}", [{"record":{"level":"error","message":"in a container","time":1795514400500}}]],
  ["auto", "json line", "auto", "{\"level\":\"error\",\"msg\":\"auto json\"}", [{"record":{"level":"error","message":"auto json"}}]],
  ["auto", "vercel by keys", "auto", "{\"type\":\"request\",\"data\":{\"requestMethod\":\"GET\",\"requestPath\":\"/z\",\"httpStatus\":503}}", [{"request":{"method":"GET","path":"/z","status":503}}]],
  ["auto", "journald by keys", "auto", "{\"PRIORITY\":\"3\",\"MESSAGE\":\"auto journal\"}", [{"record":{"level":"error","message":"auto journal"}}]],
  ["auto", "railway by keys", "auto", "{\"message\":\"m\",\"attributes\":{\"level\":\"warn\"}}", [{"record":{"level":"warning","message":"m"}}]],
  ["auto", "clf by shape", "auto", "1.2.3.4 - - [24/Nov/2026:10:00:00 +0000] \"GET /a HTTP/1.1\" 500 5", [{"request":{"method":"GET","path":"/a","status":500,"time":1795514400000}}]],
  ["auto", "text otherwise", "auto", "2026-11-24T10:00:00Z FATAL out of memory", [{"record":{"level":"fatal","message":"out of memory","time":1795514400000}}]],
];

describe("parseLogLine: the fixture table", () => {
  for (const [group, name, format, line, expected] of TABLE) {
    it(`${group}: ${name}`, () => {
      expect(parseLogLines(line, format)).toEqual(expected);
      expect(parseLogLine(line, format)).toEqual(expected[0] ?? null);
    });
  }

  it("covers every format", () => {
    expect(new Set(TABLE.map((r) => r[0]))).toEqual(new Set(["json", "vercel", "railway", "journald", "pino", "clf", "text", "auto"]));
  });
});

describe("parseLogLine: the rules that matter", () => {
  it("reads journald PRIORITY 0 to 7 as fatal, fatal, fatal, error, warning, info, info, debug", () => {
    const levels = [0, 1, 2, 3, 4, 5, 6, 7].map((p) => (parseLogLine(JSON.stringify({ PRIORITY: String(p), MESSAGE: "m" }), "journald") as { record: { level: string } }).record.level);
    expect(levels).toEqual(["fatal", "fatal", "fatal", "error", "warning", "info", "info", "debug"]);
  });

  it("reads pino 10 to 60 as debug (trace, debug), info, warning, error, fatal", () => {
    const levels = [10, 20, 30, 40, 50, 60].map((n) => (parseLogLine(JSON.stringify({ level: n, msg: "m" }), "pino") as { record: { level: string } }).record.level);
    expect(levels).toEqual(["debug", "debug", "info", "warning", "error", "fatal"]);
  });

  it("decides the time unit by size: seconds, milliseconds, microseconds, nanoseconds", () => {
    const at = (t: number | string): unknown => (parseLogLine(JSON.stringify({ msg: "m", time: t })) as { record: { time?: number } }).record.time;
    const ms = Date.UTC(2026, 10, 24, 10, 0, 0);
    expect([at(ms / 1000), at(ms), at(ms * 1000), at(ms * 1_000_000), at(String(ms * 1000))]).toEqual([ms, ms, ms, ms, ms]);
    expect(at(-5)).toBeUndefined();
    expect(at("not a time")).toBeUndefined();
  });

  it("keeps no client address, user or referer of an access log, and no query or fragment of a path", () => {
    const r = JSON.stringify(parseLogLine('198.51.100.7 - jdoe [24/Nov/2026:10:00:00 +0000] "GET /a/b?token=zzz#frag HTTP/1.1" 200 5 "https://ref.example/?k=1" "UA/1"', "clf"));
    expect(r).not.toMatch(/198\.51|jdoe|ref\.example|zzz|frag/);
  });

  it("drops the origin (and a user and password in it), the query and the fragment of a request path", () => {
    const r = parseLogLine('{"method":"GET","url":"https://user:pw0rd@h.example/a/b?token=zzz#frag","status":500}') as { request: { path: string } };
    expect(r.request.path).toBe("/a/b");
  });

  it("redacts what a path segment holds: an address, a token, a long id", () => {
    const at = (url: string): string => (parseLogLine(JSON.stringify({ method: "GET", url, status: 500 })) as { request: { path: string } }).request.path;
    expect(at("/hosts/10.1.2.3/status")).toBe("/hosts/[ip]/status");
    expect(at("/hosts/2001:db8::7/status")).toBe("/hosts/[ip]/status");
    expect(at("/reset/abcDEF123456ghiJKL789mnopqrst/x")).not.toContain("abcDEF");
    expect(at("/u/jane.doe@example.com")).toBe("/u/[email]");
  });

  it("is text for JSON nested 21 levels deep and JSON for 20", () => {
    const nest = (n: number): string => `{"msg":"x","d":${'{"a":'.repeat(n - 1)}1${"}".repeat(n - 1)}}`;
    expect(parseLogLine(nest(20))).toEqual({ record: { level: "info", message: "x" } });
    expect(JSON.stringify(parseLogLine(nest(21)))).toContain('{\\"msg\\"');
  });

  it("never throws on what is not a line", () => {
    for (const bad of [undefined, null, 42, {}, [], Symbol("x"), () => 1] as unknown[]) expect(parseLogLine(bad as string)).toBeNull();
    expect(parseLogLine("x", "nonsense" as LogFormat)).toEqual({ record: { level: "info", message: "x" } });
  });

  it("is not fooled by __proto__ or constructor keys", () => {
    expect(parseLogLine('{"__proto__":{"level":"fatal"},"constructor":{"name":"x"},"msg":"m"}')).toEqual({ record: { level: "info", message: "m" } });
    expect(({} as Record<string, unknown>).level).toBeUndefined();
  });

  it("cuts a line to 64 KB before anything", () => {
    const r = parseLogLine(`ERROR ${"x".repeat(MAX_LINE * 2)}`) as { record: { message: string } };
    expect(r.record.message.length).toBeLessThanOrEqual(2000);
  });
});

// A small seeded generator, so a failing case can be replayed.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const FORMATS: LogFormat[] = ["auto", "json", "vercel", "railway", "journald", "pino", "clf", "text"];
const ATOMS = [
  "{", "}", "[", "]", '"', "'", ":", ",", "\\", " ", "\t", "\n", "\r", "\u001b[31m", "\u0000", "é", "日本", "😀", "\ud800", "ERROR", "warn", "level=", "msg=", "E/", "at ", "    at ", "Caused by:", '"level":', '"msg":', '"message":', '"status":', '"method":"GET"', '"path":"/x"',
  '"PRIORITY":"3"', '"MESSAGE":', '"proxy":{', '"attributes":{', '"err":{', '"type":"request"', '"data":{', "null", "true", "123", "1795514400000", "-", "/", "?", "#", "=", "10/Oct/2000:13:55:36 -0700", "2026-11-24T10:00:00Z", "GET", "HTTP/1.1", "200", "[24/Nov/2026:10:00:00 +0000]", "$", "%", "__proto__",
];
const randomLine = (r: () => number): string => Array.from({ length: Math.floor(r() * 40) }, () => ATOMS[Math.floor(r() * ATOMS.length)]).join(r() < 0.5 ? "" : " ");

describe("parseLogLine: random lines", () => {
  for (const format of FORMATS) {
    it(`${format}: 2,000 random lines never throw and always answer with a record or a request`, () => {
      const r = rng(format.length * 7919);
      for (let i = 0; i < 2000; i++) {
        const line = randomLine(r);
        const out = parseLogLines(line, format);
        expect(Array.isArray(out)).toBe(true);
        for (const p of out) {
          if ("record" in p) {
            expect(typeof p.record.message).toBe("string");
            expect(p.record.message.length).toBeLessThanOrEqual(2000);
          } else {
            expect(typeof p.request.path).toBe("string");
            expect(p.request.status).toBeGreaterThanOrEqual(100);
          }
        }
      }
    });

    it(`${format}: takes linear time in the number of lines`, () => {
      const r = rng(31 + format.length);
      const lines = Array.from({ length: 8000 }, () => randomLine(r));
      const time = (n: number): number => {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) parseLogLines(lines[i], format);
        return performance.now() - t0;
      };
      time(1000); // warm up
      const small = Math.min(time(2000), time(2000), time(2000));
      const large = Math.min(time(8000), time(8000));
      // 4 times the lines: linear is 4 times the time; a cost that grows with the count would be far above 16.
      expect(large / Math.max(small, 0.5)).toBeLessThan(14);
    });
  }
});

// The worst case of each pattern: a long run of what it can match many ways. A line is cut to 64 KB, so 64 KB is the
// largest input there is. Linear means 8 times the input takes about 8 times the time; a pattern that backtracks without
// bound takes 64 times (or more), so the ratio is the proof, not a clock.
const rep = (s: string, n: number): string => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const HOSTILE: Array<[string, (n: number) => string, LogFormat]> = [
  ["spaces", (n) => rep(" ", n), "auto"],
  ["spaces then x", (n) => `${rep(" ", n)}x`, "text"],
  ["open brackets", (n) => rep("[", n), "auto"],
  ["open braces", (n) => rep("{", n), "json"],
  ["array of open braces", (n) => `[${rep("{", n)}`, "vercel"],
  ["nested arrays", (n) => rep("[{", n), "auto"],
  ["quotes", (n) => rep('"', n), "auto"],
  ["backslashes in a string", (n) => `{"a":"${rep("\\", n)}`, "json"],
  ["escaped quotes", (n) => `{"msg":"${rep('\\"', n)}`, "json"],
  ["json key run", (n) => `{${rep('"a":1,', n)}`, "auto"],
  ["digits", (n) => rep("1", n), "auto"],
  ["digits with a dot", (n) => rep("1.", n), "json"],
  ["time prefix without an end", (n) => `2026-11-24T10:00:00${rep("1", n)}`, "text"],
  ["bracket time without an end", (n) => `[${rep("1", n)}`, "text"],
  ["bracket time with colons", (n) => `[${rep("12:", n)}`, "text"],
  ["time then spaces", (n) => `2026-11-24 10:00:00${rep(" ", n)}`, "text"],
  ["level kv", (n) => rep("level=", n), "text"],
  ["msg kv with quotes", (n) => `level=error msg="${rep('\\"', n)}`, "text"],
  ["msg kv unterminated", (n) => `level=error msg="${rep("a", n)}`, "text"],
  ["msg kv spaces", (n) => `level=error ${rep("msg=", n)}`, "text"],
  ["level words", (n) => rep("ERROR ", n), "text"],
  ["lowercase level words", (n) => rep("error ", n), "text"],
  ["brackets and words", (n) => rep("[error", n), "text"],
  ["colon words", (n) => rep("error ", n) + ":", "text"],
  ["underscore words", (n) => rep("A_ERROR", n), "text"],
  ["escape sequences", (n) => rep("\u001b[3;", n), "text"],
  ["escape without an end", (n) => `\u001b[${rep("1;", n)}`, "text"],
  ["stack lines", (n) => `${rep(" ", n)}at`, "text"],
  ["python frames", (n) => `  File "${rep("a", n)}`, "text"],
  ["prompt", (n) => `${rep("a", n)}$`, "text"],
  ["prompt with spaces", (n) => `${rep("a ", n)}$`, "text"],
  ["clf start", (n) => rep("a ", n), "auto"],
  ["clf tokens", (n) => rep("a", n), "clf"],
  ["clf bracket", (n) => `a b c [${rep("1", n)}`, "clf"],
  ["clf request", (n) => `a b c [10/Oct/2000:13:55:36 -0700] "GET ${rep("a", n)}`, "clf"],
  ["clf request spaces", (n) => `a b c [10/Oct/2000:13:55:36 -0700] "GET /${rep(" ", n)}`, "clf"],
  ["clf quotes", (n) => `a b c [10/Oct/2000:13:55:36 -0700] "GET / HTTP/1.1" 200 5 ${rep('" "', n)}`, "clf"],
  ["urls", (n) => `{"method":"GET","status":500,"url":"http://${rep("a", n)}"}`, "json"],
  ["urls with slashes", (n) => `{"method":"GET","status":500,"url":"${rep("/?", n)}"}`, "json"],
  ["journal bytes", (n) => `{"MESSAGE":[${rep("1,", n)}]}`, "journald"],
  ["journal message", (n) => `{"MESSAGE":"${rep("{", n)}"}`, "journald"],
  ["digit strings", (n) => `{"time":"${rep("1", n)}"}`, "json"],
  ["date strings", (n) => `{"time":"${rep("1-", n)}","msg":"m"}`, "json"],
];

describe("parseLogLine: 64 KB of each pattern's worst case, as a ratio", () => {
  const best = (line: string, format: LogFormat, runs: number): number => {
    let min = Infinity;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      parseLogLines(line, format);
      min = Math.min(min, performance.now() - t0);
    }
    return min;
  };
  for (const [name, make, format] of HOSTILE) {
    it(name, () => {
      const small = make(8 * 1024);
      const large = make(MAX_LINE);
      best(large, format, 2); // warm up
      const t8 = Math.max(best(small, format, 5), 0.05);
      const t64 = best(large, format, 5);
      // 8 times the input: linear is about 8, quadratic 64. The slack is for timer noise and the garbage collector.
      expect(t64 / t8, `${name}: ${t8.toFixed(2)} ms for 8 KB, ${t64.toFixed(2)} ms for 64 KB`).toBeLessThan(24);
    });
  }

  it("a megabyte costs what 64 KB costs: the line is cut first", () => {
    const t64 = Math.max(best(rep("a ", MAX_LINE), "auto", 5), 0.05);
    const t1m = best(rep("a ", 1 << 20), "auto", 5);
    expect(t1m / t64).toBeLessThan(6);
  });
});
