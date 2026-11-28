// @vitest-environment jsdom
/** `beforeSendTransaction` renames, edits or drops a transaction before it is queued, and a browser rename moves `data.url`. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close, flush, init, captureException, type OverseerConfig } from "../../overseer/index";
import { startTransaction, type TransactionEvent } from "../index";
import { startBrowserTracing } from "../browser";
import { sentTransactions, type FetchCall } from "./helpers";

const INGEST = "https://ingest.example.test/api/overseer";
let calls: FetchCall[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init });
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  close();
  vi.unstubAllGlobals();
});

function start(config: OverseerConfig = {}): void {
  init({ dsn: INGEST, clientKey: "osk_test", tracesSampleRate: 1, ...config });
}

/** A server-style transaction named by its raw path, with one `http.client` span that carries the path too. */
function finishRequest(): void {
  const tx = startTransaction({ op: "http.server", name: "GET /reset/abc123token" });
  const child = tx.startChild({ op: "http.client", name: "GET /reset/abc123token", data: { url: "https://api.example.test/reset/abc123token" } });
  child.end();
  tx.end();
}

const wire = (): string => calls.map((c) => String(c.init?.body ?? "")).join("\n");

describe("beforeSendTransaction", () => {
  it("renames a transaction, and the raw path appears nowhere in the body", async () => {
    start({ beforeSendTransaction: (t) => ({ ...t, name: "GET /reset/:token", spans: t.spans.map((s) => ({ ...s, description: "GET /reset/:token", data: { ...s.data, url: "https://api.example.test/reset/:token" } })) }) });
    finishRequest();
    await flush();
    const [tx] = sentTransactions(calls);
    expect(tx.name).toBe("GET /reset/:token");
    expect(wire()).not.toContain("abc123token");
  });

  it("drops a transaction when it returns null, sends nothing and, like beforeSend's null, does not call onDropped", async () => {
    const onDropped = vi.fn();
    start({ beforeSendTransaction: () => null, onDropped });
    finishRequest();
    await flush();
    expect(sentTransactions(calls)).toEqual([]);
    expect(onDropped).not.toHaveBeenCalled();
  });

  it("flush() waits for an async hook", async () => {
    start({
      beforeSendTransaction: async (t) => {
        await new Promise((r) => setTimeout(r, 20));
        return { ...t, name: "GET /reset/:token" };
      },
    });
    finishRequest();
    expect(sentTransactions(calls)).toEqual([]);
    await flush();
    expect(sentTransactions(calls).map((t) => t.name)).toEqual(["GET /reset/:token"]);
  });

  it("a throw drops the transaction, reports before_send, and never reaches the app", async () => {
    const onDropped = vi.fn();
    start({
      beforeSendTransaction: () => {
        throw new Error("hook broke");
      },
      onDropped,
    });
    expect(() => finishRequest()).not.toThrow();
    await flush();
    expect(sentTransactions(calls)).toEqual([]);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped).toHaveBeenCalledWith(expect.objectContaining({ events: 1, status: 0, reason: "before_send", eventIds: [expect.any(String)] }));
  });

  it("a rejected Promise drops it the same way", async () => {
    const onDropped = vi.fn();
    start({ beforeSendTransaction: () => Promise.reject(new Error("no")), onDropped });
    finishRequest();
    await flush();
    expect(sentTransactions(calls)).toEqual([]);
    expect(onDropped).toHaveBeenCalledWith(expect.objectContaining({ reason: "before_send" }));
  });

  it("a result that is not a transaction drops it and reports before_send", async () => {
    for (const bad of ["oops", 42, true]) {
      calls = [];
      const onDropped = vi.fn();
      start({ beforeSendTransaction: (() => bad) as unknown as OverseerConfig["beforeSendTransaction"], onDropped });
      expect(() => finishRequest()).not.toThrow();
      await flush();
      expect(sentTransactions(calls)).toEqual([]);
      expect(onDropped).toHaveBeenCalledWith(expect.objectContaining({ reason: "before_send" }));
      close();
    }
  });

  it("the hook can edit a span's name and data.url, and the edits reach the wire", async () => {
    start({
      beforeSendTransaction: (t) => {
        for (const s of t.spans) {
          s.description = "GET /reset/:token";
          s.data = { ...s.data, url: "https://api.example.test/reset/:token" };
        }
        return t;
      },
    });
    finishRequest();
    await flush();
    const [tx] = sentTransactions(calls);
    expect(tx.spans[0].description).toBe("GET /reset/:token");
    expect(tx.spans[0].data.url).toBe("https://api.example.test/reset/:token");
  });

  it("edits a copy: the transaction the app holds keeps its spans", async () => {
    let seen: TransactionEvent | undefined;
    start({
      beforeSendTransaction: (t) => {
        seen = t;
        t.spans[0].data!.url = "gone";
        t.tags = { ...t.tags, edited: "yes" };
        return t;
      },
    });
    const tx = startTransaction({ op: "http.server", name: "GET /x" });
    const child = tx.startChild({ op: "db", name: "q", data: { url: "kept" } });
    child.end();
    const original = tx.toTransactionEvent();
    tx.end();
    await flush();
    expect(seen).toBeDefined();
    expect(original.spans[0].data!.url).toBe("kept");
  });

  it("beforeSend is still not called for transactions, and beforeSendTransaction not for errors", async () => {
    const beforeSend = vi.fn((e) => e);
    const beforeSendTransaction = vi.fn((t) => t);
    start({ beforeSend, beforeSendTransaction });
    finishRequest();
    await flush();
    expect(beforeSend).not.toHaveBeenCalled();
    expect(beforeSendTransaction).toHaveBeenCalledTimes(1);

    captureException(new Error("boom"));
    await flush();
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(beforeSendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("a secret in the transaction name", () => {
  const finishReset = (): void => {
    startTransaction({ op: "http.server", name: "GET /reset?token=qzkvwjxmprth" }).end();
  };

  it("is masked when there is no hook", async () => {
    start();
    finishReset();
    await flush();
    const [tx] = sentTransactions(calls);
    expect(tx.name).not.toContain("qzkvwjxmprth");
    expect(wire()).not.toContain("qzkvwjxmprth");
  });

  it("is masked before the hook sees it, and a hook that returns it unchanged sends it masked", async () => {
    const seen: string[] = [];
    start({
      beforeSendTransaction: (t) => {
        seen.push(t.name);
        return t;
      },
    });
    finishReset();
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("qzkvwjxmprth");
    const [tx] = sentTransactions(calls);
    expect(tx.name).toBe(seen[0]);
    expect(wire()).not.toContain("qzkvwjxmprth");
  });
});

describe("a renamed browser transaction's data.url", () => {
  it("takes the origin and the new route, never the raw path", async () => {
    window.history.replaceState(null, "", "/orders/42?token=secret");
    start();
    const urls: unknown[] = [];
    const stop = startBrowserTracing({
      routeName: (path) => path.replace(/\d+/, ":id"),
      onPageloadEnd: (tx) => urls.push(tx.data.url),
    });
    try {
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      stop();
    }
    expect(urls).toEqual([`${window.location.origin}/orders/:id`]);
    expect(String(urls[0])).not.toContain("42");
    expect(String(urls[0])).not.toContain("secret");
  });

  it("keeps the scrubbed page URL when routeName names nothing", async () => {
    window.history.replaceState(null, "", "/orders/42?token=secret");
    start();
    const urls: unknown[] = [];
    const stop = startBrowserTracing({ routeName: () => undefined, onPageloadEnd: (tx) => urls.push(tx.data.url) });
    try {
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      stop();
    }
    expect(urls).toEqual([`${window.location.origin}/orders/42`]);
  });

  it("puts a slash after the origin when the route has none", async () => {
    window.history.replaceState(null, "", "/users/7");
    start();
    const urls: unknown[] = [];
    const stop = startBrowserTracing({ routeName: () => "users/:id", onPageloadEnd: (tx) => urls.push(tx.data.url) });
    try {
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      stop();
    }
    expect(urls).toEqual([`${window.location.origin}/users/:id`]);
  });
});
