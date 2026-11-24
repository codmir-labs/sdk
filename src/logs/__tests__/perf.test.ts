import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { describe, expect, it } from "vitest";
import { createLogMonitor } from "../monitor";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const SHAPES = 1000;
const RECORDS = 100_000;

describe("speed and memory", () => {
  it(`takes ${RECORDS.toLocaleString("en")} records of ${SHAPES} shapes in under 2 s and under 60 MB of growth, about 10 us each`, () => {
    const m = createLogMonitor();
    gc();
    const before = process.memoryUsage().heapUsed;
    const times = new Float64Array(RECORDS);
    const t0 = performance.now();
    for (let i = 0; i < RECORDS; i++) {
      const shape = i % SHAPES;
      const a = performance.now();
      if (i % 3 === 0) {
        m.request({ method: "GET", path: `/api/shape${shape}/${i}/items/${(i * 7919).toString(16)}?token=abc${i}`, status: shape % 2 ? 500 : 404, durationMs: i % 90, userAgent: "Mozilla/5.0 Chrome/120" });
      } else {
        m.record({ level: shape % 5 ? "error" : "warning", message: `shape${shape} failed for user ${i}@example.com from 10.0.${i % 255}.${i % 200} in ${i % 900}ms id=${(i * 2654435761).toString(16)}` });
      }
      times[i] = performance.now() - a;
    }
    const ms = performance.now() - t0;
    const sorted = Array.from(times).sort((x, y) => x - y);
    const worst = sorted[RECORDS - 1];
    const p999 = sorted[Math.floor(RECORDS * 0.999)];
    const over = sorted.filter((t) => t > 5).length;
    gc();
    const grown = (process.memoryUsage().heapUsed - before) / 1_048_576;
    console.log(`perf: ${RECORDS} records, ${SHAPES} shapes: ${ms.toFixed(0)} ms (${((ms * 1000) / RECORDS).toFixed(1)} us each), slowest ${worst.toFixed(2)} ms, p99.9 ${p999.toFixed(3)} ms, over 5 ms: ${over}, heap growth ${grown.toFixed(1)} MB, groups ${m.stats().groups}, dropped ${m.stats().dropped}`);
    expect(ms).toBeLessThan(2000);
    expect(grown).toBeLessThan(60);
    // The work is ~10 us a call. A stall (a collection, another process taking the CPU) can stretch a few calls, so the
    // limit is on the 99.9th percentile; the hostile-input test below holds the worst case for the work itself.
    expect(p999).toBeLessThan(5);
    void m.stop();
  });

  it("takes no more than 5 ms for the worst texts a log line can hold", () => {
    const hostile = [
      `${"a:".repeat(500)}`, `${"1.".repeat(500)}`, `${"?".repeat(500)}${"=".repeat(500)}`, `token=${"x".repeat(990)}`, `${"[secret]".repeat(125)}`,
      `${"Bearer ".repeat(140)}`, `${"é@é.".repeat(250)}`, `${"0123456789abcdef".repeat(62)}`, `${"/12345".repeat(160)}`, `${'"a" '.repeat(250)}`,
      `${"::1 ".repeat(250)}`, `${"a-".repeat(500)}`, "x".repeat(5_000_000),
    ];
    const m = createLogMonitor();
    for (const text of hostile) {
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const a = performance.now();
        m.record({ level: "error", message: `${text}${i}` });
        m.request({ method: "GET", path: text, status: 500, userAgent: text });
        runs.push(performance.now() - a);
      }
      runs.sort((x, y) => x - y);
      expect(runs[2], `${text.slice(0, 20)}...`).toBeLessThan(5);
    }
    void m.stop();
  });

  it("holds when every record is a new shape, with the group limit doing its work", () => {
    const m = createLogMonitor();
    const t0 = performance.now();
    for (let i = 0; i < 20_000; i++) m.record({ level: "error", message: `word${i.toString(36)} broke` });
    const ms = performance.now() - t0;
    console.log(`perf: 20000 all-new shapes: ${ms.toFixed(0)} ms, dropped ${m.stats().dropped}`);
    expect(ms).toBeLessThan(2000);
    void m.stop();
  });
});
