// @vitest-environment jsdom
/**
 * Mask and block hold inside open shadow roots and same-origin iframes, later changes included. The recorder, the upload
 * and the filter are the real ones; only `fetch` is stubbed and the clock is fake. Each secret must be in no upload and
 * in no event the filter passes on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DSN = "https://ingest.example.test/api/overseer";
const REPLAY_URL = `${DSN}/replay`;

type Call = { url: string; raw: string; body: any };
let calls: Call[];

const replayCalls = () => calls.filter((c) => c.url === REPLAY_URL);
const uploaded = () => replayCalls().map((c) => c.raw).join("\n");
const sentEvents = () => replayCalls().flatMap((c) => c.body.events as Array<{ type: number; data: any }>);

beforeEach(() => {
  calls = [];
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const raw = String(init.body);
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      calls.push({ url, raw, body });
      return new Response(JSON.stringify({ stored: true }), { status: 202 });
    }),
  );
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

afterEach(async () => {
  const replay = await import("../index");
  replay.stopReplay();
  const overseer = await import("../../overseer/index");
  overseer.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const useFakeClock = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });

const settle = async () => {
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
};

const click = () => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));

/** Records a session: `setup` runs before the recorder starts, `act` after its first snapshot; returns what was uploaded and what the filter passed on. */
async function record(setup: () => void | Promise<void>, act: () => void | Promise<void> = () => {}) {
  useFakeClock();
  await setup();
  const composed = await import("../composed-privacy");
  const spy = vi.spyOn(composed.ComposedPrivacyFilter.prototype, "apply");
  const overseer = await import("../../overseer/index");
  const replay = await import("../index");
  overseer.init({ dsn: DSN, clientKey: "osk_test", environment: "production", release: "1.2.3", replaysSessionSampleRate: 1 });
  replay.startReplay();
  await settle();
  await act();
  await vi.advanceTimersByTimeAsync(0);
  click();
  await vi.advanceTimersByTimeAsync(30_000);
  const passed = spy.mock.results.map((r) => JSON.stringify(r.value ?? null)).join("\n");
  return { text: uploaded(), passed };
}

describe("shadow roots", () => {
  it("K4: text added or changed later in a shadow root under [data-private] is masked", async () => {
    let root!: ShadowRoot;
    const { text, passed } = await record(
      () => {
        document.body.innerHTML = `<div data-private><x-name id="host"></x-name></div><p>public</p>`;
        root = (document.getElementById("host") as HTMLElement).attachShadow({ mode: "open" });
        root.innerHTML = `<b>snapshot-secret-name</b>`;
      },
      async () => {
        const i = document.createElement("i");
        i.textContent = "added-secret-name";
        root.appendChild(i);
        await vi.advanceTimersByTimeAsync(0);
        (root.querySelector("b")!.firstChild as Text).data = "changed-secret-name";
      },
    );
    for (const secret of ["snapshot-secret-name", "added-secret-name", "changed-secret-name"]) {
      expect(text).not.toContain(secret);
      expect(passed).not.toContain(secret);
    }
    // Masked, not dropped: the same length, and the rest of the page is untouched.
    expect(text).toContain("*".repeat("added-secret-name".length));
    expect(text).toContain("*".repeat("changed-secret-name".length));
    expect(text).toContain("public");
  });

  it("K5: what a blocked web component renders after the snapshot is not recorded", async () => {
    let root!: ShadowRoot;
    const { text, passed } = await record(
      () => {
        document.body.innerHTML = `<div><pay-widget id="w" data-codmir-block></pay-widget></div><p>public</p>`;
        root = (document.getElementById("w") as HTMLElement).attachShadow({ mode: "open" });
        root.innerHTML = `<p>card-on-file-4242-snapshot</p>`;
      },
      async () => {
        const p = document.createElement("p");
        p.textContent = "card-on-file-4242-rendered-later";
        root.appendChild(p);
        await vi.advanceTimersByTimeAsync(0);
        const q = document.createElement("p");
        q.textContent = "card-on-file-4242-nested";
        p.appendChild(q);
      },
    );
    for (const secret of ["card-on-file-4242-snapshot", "card-on-file-4242-rendered-later", "card-on-file-4242-nested"]) {
      expect(text).not.toContain(secret);
      expect(passed).not.toContain(secret);
    }
    expect(text).toContain("public");
    expect(text).toContain("rr_width");
  });

  it("a node outside any mask or block, inside a shadow root, keeps its text", async () => {
    let root!: ShadowRoot;
    const { text } = await record(
      () => {
        document.body.innerHTML = `<div><x-card id="host"></x-card></div><div data-private><x-name id="secret"></x-name></div>`;
        root = (document.getElementById("host") as HTMLElement).attachShadow({ mode: "open" });
        root.innerHTML = `<b>shadow-snapshot-text</b>`;
      },
      async () => {
        const i = document.createElement("i");
        i.textContent = "shadow-added-text";
        root.appendChild(i);
        await vi.advanceTimersByTimeAsync(0);
        (root.querySelector("b")!.firstChild as Text).data = "shadow-changed-text";
      },
    );
    expect(text).toContain("shadow-added-text");
    expect(text).toContain("shadow-changed-text");
  });
});

describe("same-origin iframes", () => {
  it("K6: text added later in an iframe under [data-private] is masked", async () => {
    let frame!: HTMLIFrameElement;
    const { text, passed } = await record(
      () => {
        document.body.innerHTML = `<div data-private><iframe id="f"></iframe></div><p>public</p>`;
        frame = document.getElementById("f") as HTMLIFrameElement;
        frame.contentDocument!.body.innerHTML = `<p>iframe-snapshot-secret</p>`;
      },
      async () => {
        await vi.advanceTimersByTimeAsync(100);
        const p = frame.contentDocument!.createElement("p");
        p.textContent = "iframe-added-secret";
        frame.contentDocument!.body.appendChild(p);
        await vi.advanceTimersByTimeAsync(0);
        (p.firstChild as Text).data = "iframe-changed-secret";
      },
    );
    for (const secret of ["iframe-snapshot-secret", "iframe-added-secret", "iframe-changed-secret"]) {
      expect(text).not.toContain(secret);
      expect(passed).not.toContain(secret);
    }
    expect(text).toContain("public");
  });

  it("K8: the document of an <iframe data-codmir-block> is not recorded", async () => {
    const { text, passed } = await record(
      () => {
        document.body.innerHTML = `<iframe id="f2" data-codmir-block></iframe><div data-codmir-block><iframe id="f3"></iframe></div><p>public</p>`;
        (document.getElementById("f2") as HTMLIFrameElement).contentDocument!.body.innerHTML = `<p>blocked-iframe-snapshot-secret</p>`;
        (document.getElementById("f3") as HTMLIFrameElement).contentDocument!.body.innerHTML = `<p>iframe-in-blocked-div-secret</p>`;
      },
      async () => {
        await vi.advanceTimersByTimeAsync(200);
        const doc = (document.getElementById("f2") as HTMLIFrameElement).contentDocument!;
        const p = doc.createElement("p");
        p.textContent = "blocked-iframe-added-secret";
        doc.body.appendChild(p);
      },
    );
    for (const secret of ["blocked-iframe-snapshot-secret", "blocked-iframe-added-secret", "iframe-in-blocked-div-secret"]) {
      expect(text).not.toContain(secret);
      expect(passed).not.toContain(secret);
    }
    expect(text).toContain("public");
    expect(sentEvents().some((e) => e.data?.isAttachIframe)).toBe(false);
  });
});

describe("the filter on its own", () => {
  it("a page with no shadow root or iframe: every event passes on as it is, the same object", async () => {
    useFakeClock();
    document.body.innerHTML = `<main data-private><p>plain-private-text</p></main><ul><li>one</li></ul><input value="x"><p>public</p>`;
    const { record: rrweb } = await import("@rrweb/record");
    const { ComposedPrivacyFilter } = await import("../composed-privacy");
    const { toRrwebPrivacy, DEFAULT_PRIVACY } = await import("../privacy");
    const options = toRrwebPrivacy(DEFAULT_PRIVACY);
    const events: any[] = [];
    const stop = rrweb({ emit: (e) => events.push(e), ...options, maskAllInputs: true });
    document.querySelector("ul")!.appendChild(document.createElement("li")).textContent = "two";
    document.querySelector("main p")!.firstChild!.textContent = "plain-private-changed";
    await vi.advanceTimersByTimeAsync(0);
    stop?.();
    const filter = new ComposedPrivacyFilter({
      maskSelector: options.maskTextSelector,
      blockSelector: options.blockSelector,
      getNode: (id) => rrweb.mirror.getNode(id),
    });
    expect(events.some((e) => e.type === 2)).toBe(true);
    expect(events.some((e) => e.type === 3 && e.data.source === 0)).toBe(true);
    for (const event of events) expect(filter.apply(event)).toBe(event);
  });

  it("an id the mirror does not know is kept as the recorder sent it, and nothing throws", async () => {
    const { ComposedPrivacyFilter } = await import("../composed-privacy");
    const event = {
      type: 3,
      timestamp: 1,
      data: { source: 0, texts: [{ id: 999, value: "unknown-node-text" }], adds: [{ parentId: 998, node: { type: 3, id: 997, textContent: "unknown-add-text" } }] },
    };
    expect(new ComposedPrivacyFilter({ maskSelector: "[data-private]", blockSelector: "[data-codmir-block]", getNode: () => null }).apply(event)).toBe(event);
    const throwing = new ComposedPrivacyFilter({
      maskSelector: "[data-private]",
      blockSelector: "[data-codmir-block]",
      getNode: () => {
        throw new Error("mirror gone");
      },
    });
    expect(throwing.apply(event)).toBe(event);
    expect(throwing.apply({ type: 2, timestamp: 1, data: null })).toEqual({ type: 2, timestamp: 1, data: null });
  });
});
