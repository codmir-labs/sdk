// @vitest-environment jsdom
/**
 * rrweb recording with masking on by default, on-error buffering, sampling and segment upload.
 * The wire shape is checked against the mirrored `ReplaySegmentUploadSchema` (helpers.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SDK_INFO } from "../../version";
import { CONTRACT_EXAMPLE, MAX_BODY_BYTES, ReplaySegmentUploadSchema, ReplayUploadResponseSchema } from "./helpers";

const DSN = "https://ingest.example.test/api/overseer";
const REPLAY_URL = `${DSN}/replay`;

type Call = { url: string; init: RequestInit; body: any; raw: string };
let calls: Call[];
let respond: () => Response | Promise<Response>;

const replayCalls = () => calls.filter((c) => c.url === REPLAY_URL);
const ingestCalls = () => calls.filter((c) => c.url === `${DSN}/ingest`);
const allReplayText = () => replayCalls().map((c) => c.raw).join("\n");

type SnapshotNode = { id: number; attributes?: Record<string, string>; childNodes?: SnapshotNode[] };
type SentEvent = {
  type: number;
  data: {
    href?: string;
    source?: number;
    id?: number;
    text?: string;
    node?: SnapshotNode;
    adds?: Array<{ node: SnapshotNode }>;
    attributes?: Array<{ id: number; attributes: Record<string, unknown> }>;
  };
};
/** Every rrweb event uploaded so far, in order. */
const sentEvents = (): SentEvent[] => replayCalls().flatMap((c) => c.body.events as SentEvent[]);

beforeEach(() => {
  calls = [];
  respond = () => new Response(JSON.stringify({ stored: true }), { status: 202 });
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init, raw: String(init.body), body: JSON.parse(String(init.body)) });
      return respond();
    }),
  );
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

async function load(config: Record<string, unknown> = {}) {
  const overseer = await import("../../overseer/index");
  const replay = await import("../index");
  overseer.init({ dsn: DSN, clientKey: "osk_test", environment: "production", release: "1.2.3", ...config });
  return { overseer, replay };
}

/** rrweb loads through a dynamic import; let it settle and take its first snapshot. */
/** rrweb stamps events from `performance`, and checks for a checkout only when an event arrives. */
const useFakeClock = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });

const settle = async () => {
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
};

function click() {
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function type(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("masking (default config)", () => {
  it("never puts a typed password, or any typed input, in an uploaded segment", async () => {
    useFakeClock();
    document.body.innerHTML = `<form><input id="pw" type="password"><input id="name" type="text"></form>`;
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    expect(replay.startReplay()).toBeTruthy();
    await settle();

    type(document.getElementById("pw") as HTMLInputElement, "hunter2-secret");
    type(document.getElementById("name") as HTMLInputElement, "ordinary-typed-text");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(replayCalls().length).toBeGreaterThan(0);
    const text = allReplayText();
    expect(text).not.toContain("hunter2-secret");
    expect(text).not.toContain("ordinary-typed-text");
  });

  it("still masks a password with maskAllInputs off and no masked types; other inputs then record (negative control)", async () => {
    useFakeClock();
    document.body.innerHTML = `<form><input id="pw" type="password"><input id="name" type="text"></form>`;
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    replay.startReplay({ privacy: { maskAllInputs: false, maskInputTypes: [] } });
    await settle();

    type(document.getElementById("pw") as HTMLInputElement, "hunter2-secret");
    type(document.getElementById("name") as HTMLInputElement, "ordinary-typed-text");
    await vi.advanceTimersByTimeAsync(30_000);

    const text = allReplayText();
    expect(text).not.toContain("hunter2-secret");
    // Proves the grep can fail: with masking off the ordinary field is in the payload.
    expect(text).toContain("ordinary-typed-text");
  });

  it("masks data-private text, blocks data-codmir-block subtrees, and records everything else", async () => {
    useFakeClock();
    document.body.innerHTML = `
      <p data-private>ssn-123-45-6789</p>
      <p class="private">card-4242-4242</p>
      <div data-codmir-block><span>block-secret-subtree</span></div>
      <p>public-visible-text</p>`;
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    replay.startReplay();
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);

    const text = allReplayText();
    expect(text).not.toContain("ssn-123-45-6789");
    expect(text).not.toContain("card-4242-4242");
    expect(text).not.toContain("block-secret-subtree");
    expect(text).toContain("public-visible-text");
  });
});

describe("input mask length", () => {
  const LENGTHS = [1, 3, 16, 17, 40];

  const fixedMask = async () => {
    const { DEFAULT_PRIVACY, toRrwebPrivacy } = await import("../privacy");
    return toRrwebPrivacy(DEFAULT_PRIVACY).maskInputFn("s");
  };

  /** The text of every uploaded input event, by the `id` attribute of the field it was typed into. */
  function typedTexts(): Record<string, string[]> {
    const fields = new Map<number, string>();
    const walk = (node: SnapshotNode) => {
      if (node.attributes?.id) fields.set(node.id, node.attributes.id);
      node.childNodes?.forEach(walk);
    };
    const events = sentEvents();
    for (const e of events) if (e.type === 2 && e.data.node) walk(e.data.node);
    const texts: Record<string, string[]> = {};
    for (const e of events) {
      if (e.type !== 3 || e.data.source !== 5) continue;
      (texts[fields.get(e.data.id as number) ?? "unknown"] ??= []).push(e.data.text as string);
    }
    return texts;
  }

  it("masks every non-empty value to one length, whatever its own, and keeps an empty value empty", async () => {
    const { DEFAULT_PRIVACY, toRrwebPrivacy } = await import("../privacy");
    const { maskInputFn } = toRrwebPrivacy(DEFAULT_PRIVACY);
    const masks = LENGTHS.map((n) => maskInputFn("s".repeat(n)));
    expect(masks).toEqual(LENGTHS.map(() => masks[0]));
    expect(masks[0]).toMatch(/^\*+$/);
    expect(maskInputFn("")).toBe("");
  });

  it("uploads that one mask for a typed value of any length and for a password, and an emptied field as empty", async () => {
    useFakeClock();
    document.body.innerHTML = `${LENGTHS.map((n) => `<input id="text-${n}" type="text">`).join("")}<input id="pw" type="password">`;
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    replay.startReplay();
    await settle();

    for (const n of LENGTHS) type(document.getElementById(`text-${n}`) as HTMLInputElement, "s".repeat(n));
    const pw = document.getElementById("pw") as HTMLInputElement;
    type(pw, "hunter2-secret");
    type(pw, "");
    await vi.advanceTimersByTimeAsync(30_000);

    const mask = await fixedMask();
    expect(typedTexts()).toEqual({ ...Object.fromEntries(LENGTHS.map((n) => [`text-${n}`, [mask]])), pw: [mask, ""] });
  });

  it("masks a password to the same mask with maskAllInputs off, while an unmasked field records as typed", async () => {
    useFakeClock();
    document.body.innerHTML = `<input id="pw-1" type="password"><input id="pw-40" type="password"><input id="name" type="text">`;
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    replay.startReplay({ privacy: { maskAllInputs: false, maskInputTypes: [] } });
    await settle();

    type(document.getElementById("pw-1") as HTMLInputElement, "s");
    type(document.getElementById("pw-40") as HTMLInputElement, "s".repeat(40));
    type(document.getElementById("name") as HTMLInputElement, "ordinary-typed-text");
    await vi.advanceTimersByTimeAsync(30_000);

    const mask = await fixedMask();
    expect(typedTexts()).toEqual({ "pw-1": [mask], "pw-40": [mask], name: ["ordinary-typed-text"] });
  });
});

describe("hidden and file inputs", () => {
  const configs: Array<[string, Record<string, unknown>]> = [
    ["the default config", {}],
    ["maskAllInputs: true with no masked types", { maskAllInputs: true, maskInputTypes: [] }],
  ];

  /** Every value an input was recorded with: its `value` attribute in snapshots, added nodes and changes, and input events. */
  function inputValues(): string[] {
    const nodes = (n: SnapshotNode): SnapshotNode[] => [n, ...(n.childNodes ?? []).flatMap(nodes)];
    const values: string[] = [];
    const take = (attributes?: Record<string, unknown>) => {
      if (attributes && typeof attributes.value === "string") values.push(attributes.value);
    };
    for (const e of sentEvents()) {
      if (e.type === 2 && e.data.node) nodes(e.data.node).forEach((n) => take(n.attributes));
      if (e.type !== 3) continue;
      if (e.data.source === 0) {
        e.data.adds?.forEach((add) => nodes(add.node).forEach((n) => take(n.attributes)));
        e.data.attributes?.forEach((change) => take(change.attributes));
      }
      if (e.data.source === 5) values.push(e.data.text as string);
    }
    return values;
  }

  it("hands rrweb every input type, hidden and file included, with rrweb's own maskAllInputs off", async () => {
    const { DEFAULT_PRIVACY, toRrwebPrivacy } = await import("../privacy");
    // rrweb 2.2.0's list for its own maskAllInputs: true, which ignores maskInputOptions and has no hidden or file.
    const rrwebList = ["color", "date", "datetime-local", "email", "month", "number", "range", "search", "tel", "text"];
    rrwebList.push("time", "url", "week", "textarea", "select", "password");
    const on = toRrwebPrivacy(DEFAULT_PRIVACY);
    expect(on.maskAllInputs).toBe(false);
    expect(Object.keys(on.maskInputOptions).sort()).toEqual([...rrwebList, "hidden", "file", "credit-card"].sort());
    const off = toRrwebPrivacy({ ...DEFAULT_PRIVACY, maskAllInputs: false, maskInputTypes: ["email"] });
    expect(off.maskAllInputs).toBe(false);
    expect(off.maskInputOptions).toEqual({ email: true, password: true });
  });

  it.each(configs)("no part of a hidden input's value leaves the page under %s", async (_config, privacy) => {
    useFakeClock();
    document.body.innerHTML = `<input id="csrf" type="hidden" value="csrf-abc123"><input type="HIDDEN" value="upper-777"><input id="was-text" type="text">`;
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    expect(replay.startReplay({ privacy })).toBeTruthy();
    await settle();

    const added = document.createElement("input");
    added.type = "hidden";
    added.value = "added-456";
    document.body.appendChild(added);
    await vi.advanceTimersByTimeAsync(0);
    const csrf = document.getElementById("csrf") as HTMLInputElement;
    csrf.setAttribute("value", "attr-789");
    await vi.advanceTimersByTimeAsync(0);
    // A script setting the property: rrweb hears its hooked setter and the value attribute the property reflects to.
    csrf.value = "prop-321";
    await vi.advanceTimersByTimeAsync(0);
    // A typed field turned hidden: the browser moves the typed value into its value attribute.
    const wasText = document.getElementById("was-text") as HTMLInputElement;
    type(wasText, "typed-654");
    await vi.advanceTimersByTimeAsync(0);
    wasText.type = "hidden";
    await vi.advanceTimersByTimeAsync(30_000);

    const text = allReplayText();
    expect(["csrf-abc123", "upper-777", "added-456", "attr-789", "prop-321", "typed-654"].filter((v) => text.includes(v))).toEqual([]);
    const values = inputValues();
    // The two in the snapshot, the added one, its input event, two changes on csrf and its input event, the typed field's
    // input event, and that field's change to hidden.
    expect(values).toHaveLength(9);
    expect(new Set(values)).toEqual(new Set(["********"]));
  });

  it.each(configs)("a picked file's name never leaves the page under %s", async (_config, privacy) => {
    useFakeClock();
    document.body.innerHTML = `<input id="upload" type="file">`;
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    expect(replay.startReplay({ privacy })).toBeTruthy();
    await settle();

    // jsdom cannot pick a file. A browser reports one as C:\fakepath\<name>, which rrweb reads from `value` on change.
    const upload = document.getElementById("upload") as HTMLInputElement;
    Object.defineProperty(upload, "value", { configurable: true, get: () => "C:\\fakepath\\tax-return-2025.pdf" });
    upload.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(allReplayText()).not.toContain("tax-return");
    expect(inputValues()).toEqual(["********"]);
  });
});

describe("an invalid privacy selector", () => {
  // `p:has-text(x)` is a test-runner pseudo-class, not CSS: no DOM parses it. `[data-x` parses alone (the DOM closes the
  // bracket at the end of the string) but breaks the list it is joined into. rrweb gets each list as one selector and
  // swallows the error, so either one used to switch its whole list off, the defaults with it.
  const INVALID = ["p:has-text(x)", "[data-x"];

  it.each(INVALID)("%s in maskSelectors costs only itself: the defaults and a custom selector still mask", async (invalid) => {
    useFakeClock();
    document.body.innerHTML = `
      <p data-private>ssn-123-45-6789</p>
      <p class="private">card-4242-4242</p>
      <p class="customer-name">customer-jane-doe</p>
      <p>public-visible-text</p>`;
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    expect(replay.startReplay({ privacy: { maskSelectors: ["[data-private]", ".private", invalid, ".customer-name"] } })).toBeTruthy();
    await settle();
    // Added after the full snapshot, so these go out in a mutation.
    document.body.insertAdjacentHTML("beforeend", `<p class="customer-name">customer-added-later</p><p>public-added-later</p>`);
    await vi.advanceTimersByTimeAsync(30_000);

    const text = allReplayText();
    expect(["ssn-123-45-6789", "card-4242-4242", "customer-jane-doe", "customer-added-later"].filter((t) => text.includes(t))).toEqual([]);
    expect(text).toContain("public-visible-text");
    expect(text).toContain("public-added-later");
  });

  it.each(INVALID)("%s in blockSelectors costs only itself: the defaults and a custom selector still block", async (invalid) => {
    useFakeClock();
    document.body.innerHTML = `
      <div data-codmir-block><span>block-secret-subtree</span></div>
      <div data-block-replay><span>legacy-block-secret</span></div>
      <section id="card-form"><span>card-form-secret</span></section>
      <p>public-visible-text</p>`;
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    const blockSelectors = ["[data-codmir-block]", "[data-block-replay]", invalid, "#card-form"];
    expect(replay.startReplay({ privacy: { blockSelectors } })).toBeTruthy();
    await settle();
    document.getElementById("card-form")?.insertAdjacentHTML("beforeend", "<span>card-form-added-later</span>");
    document.body.insertAdjacentHTML("beforeend", "<p>public-added-later</p>");
    await vi.advanceTimersByTimeAsync(30_000);

    const text = allReplayText();
    expect(["block-secret-subtree", "legacy-block-secret", "card-form-secret", "card-form-added-later"].filter((t) => text.includes(t))).toEqual([]);
    // A blocked element records as a same-size placeholder: one for each of the three.
    expect(text.match(/"rr_width"/g)).toHaveLength(3);
    expect(text).toContain("public-visible-text");
    expect(text).toContain("public-added-later");
  });

  it.each(INVALID)("%s in ignoreSelectors costs only itself: a custom selector still ignores, and other inputs record", async (invalid) => {
    useFakeClock();
    document.body.innerHTML = `<input id="search" type="text" data-no-record><input id="name" type="text">`;
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    // Inputs unmasked, so a typed value reaches the upload unless its input events are ignored.
    const privacy = { maskAllInputs: false, maskInputTypes: [], ignoreSelectors: [invalid, "[data-no-record]"] };
    expect(replay.startReplay({ privacy })).toBeTruthy();
    await settle();

    type(document.getElementById("search") as HTMLInputElement, "ignored-typed-text");
    type(document.getElementById("name") as HTMLInputElement, "recorded-typed-text");
    await vi.advanceTimersByTimeAsync(30_000);

    const text = allReplayText();
    expect(text).not.toContain("ignored-typed-text");
    // With the list broken, rrweb's input handler threw on every event, so nothing typed recorded at all.
    expect(text).toContain("recorded-typed-text");
  });

  it("hands rrweb the valid selectors in their order and reports each one it leaves out, with its list", async () => {
    const { DEFAULT_PRIVACY, toRrwebPrivacy } = await import("../privacy");
    const dropped: string[][] = [];
    const out = toRrwebPrivacy(
      {
        ...DEFAULT_PRIVACY,
        maskSelectors: [" [data-private] ", "p:has-text(x)", ".private", "", "[data-x", ".customer-name"],
        blockSelectors: ["[data-codmir-block]", '[title="a', "[data-block-replay]", "#card-form"],
        ignoreSelectors: ["div:has-text(x)", "  "],
      },
      (selector, list) => dropped.push([list, selector]),
    );
    expect(out.maskTextSelector).toBe("[data-private], .private, .customer-name");
    expect(out.blockSelector).toBe("[data-codmir-block], [data-block-replay], #card-form");
    expect(out.ignoreSelector).toBeUndefined();
    expect(dropped).toEqual([
      ["maskSelectors", "p:has-text(x)"],
      ["maskSelectors", "[data-x"],
      ["blockSelectors", '[title="a'],
      ["ignoreSelectors", "div:has-text(x)"],
    ]);
  });

  it("keeps lists of valid selectors as they are and empty lists undefined, reporting nothing", async () => {
    const { DEFAULT_PRIVACY, toRrwebPrivacy } = await import("../privacy");
    const dropped: string[] = [];
    const report = (selector: string) => dropped.push(selector);
    const defaults = toRrwebPrivacy(DEFAULT_PRIVACY, report);
    expect([defaults.maskTextSelector, defaults.blockSelector, defaults.ignoreSelector]).toEqual([
      "[data-private], .private",
      "[data-codmir-block], [data-block-replay]",
      undefined,
    ]);
    // Brackets, quotes, parentheses and escapes, each closed again before the selector ends.
    const closed = ['input[type="password"]', '[data-x="a)b"]', '[data-x="]"]', ".a\\)", ":is(.a, .b)", "div:not([data-x])", "li:nth-child(2n+1)", "p, .q"];
    expect(toRrwebPrivacy({ ...DEFAULT_PRIVACY, maskSelectors: closed }, report).maskTextSelector).toBe(closed.join(", "));
    const empty = toRrwebPrivacy({ ...DEFAULT_PRIVACY, maskSelectors: [], blockSelectors: ["", "  "], ignoreSelectors: [] }, report);
    expect([empty.maskTextSelector, empty.blockSelector, empty.ignoreSelector]).toEqual([undefined, undefined, undefined]);
    expect(dropped).toEqual([]);
  });

  it("leaves out a selector that parses alone but ends open, which broke or swallowed the selectors after it", async () => {
    const { DEFAULT_PRIVACY, toRrwebPrivacy } = await import("../privacy");
    const open = ["[data-x", '[title="a', "p\\", ":not(.a", "p:nth-child(2", ":not([data-x"];
    const el = document.createElement("p");
    el.className = "private";
    const matches = (selector: string) => {
      try {
        return el.matches(selector);
      } catch {
        return "throws";
      }
    };
    // The precondition: alone each one parses here; joined, the list throws or `.private` stops matching.
    expect(open.filter((s) => matches(s) === "throws")).toEqual([]);
    expect(open.filter((s) => matches(`[data-private], ${s}, .private`) === true)).toEqual([]);

    const dropped: string[] = [];
    const out = toRrwebPrivacy({ ...DEFAULT_PRIVACY, maskSelectors: ["[data-private]", ...open, ".private"] }, (s) => dropped.push(s));
    expect(out.maskTextSelector).toBe("[data-private], .private");
    expect(dropped).toEqual(open);
    expect(el.matches(out.maskTextSelector as string)).toBe(true);
  });

  it("joins the lists as they are where there is no DOM to check them against", async () => {
    const { DEFAULT_PRIVACY, toRrwebPrivacy } = await import("../privacy");
    vi.stubGlobal("document", undefined);
    const dropped: string[] = [];
    const out = toRrwebPrivacy({ ...DEFAULT_PRIVACY, maskSelectors: ["[data-private]", "p:has-text(x)"] }, (s) => dropped.push(s));
    vi.unstubAllGlobals();
    expect(out.maskTextSelector).toBe("[data-private], p:has-text(x)");
    expect(dropped).toEqual([]);
  });

  it("logs each skipped selector once, with its list, and only with upload.debug on", async () => {
    useFakeClock();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { replay } = await load();
    const privacy = {
      maskSelectors: ["[data-private]", "p:has-text(x)"],
      blockSelectors: ["[data-x", "[data-codmir-block]"],
      ignoreSelectors: ["div:has-text(x)"],
    };
    const run = async (debug: boolean) => {
      const recorder = replay.createReplayRecorder({ sessionSampleRate: 1, privacy, upload: { url: REPLAY_URL, key: "osk_test", debug } });
      expect(recorder.start()).toBeTruthy();
      await settle();
      recorder.stop();
      await vi.advanceTimersByTimeAsync(0);
    };

    await run(false);
    expect(log).not.toHaveBeenCalled();
    await run(true);
    expect(log.mock.calls).toEqual([
      ['[Overseer replay] privacy.maskSelectors: skipped invalid selector "p:has-text(x)"'],
      ['[Overseer replay] privacy.blockSelectors: skipped invalid selector "[data-x"'],
      ['[Overseer replay] privacy.ignoreSelectors: skipped invalid selector "div:has-text(x)"'],
    ]);
    expect(replayCalls()).toHaveLength(2);
  });
});

describe("sampling", () => {
  it("records and uploads nothing, and never loads rrweb, when both rates are 0", async () => {
    useFakeClock();
    let loaded = 0;
    vi.doMock("@rrweb/record", async (importOriginal) => {
      loaded++;
      return importOriginal();
    });
    const { replay } = await load({ replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0 });
    expect(replay.startReplay()).toBeNull();
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(replayCalls()).toHaveLength(0);
    expect(loaded).toBe(0);
    vi.doUnmock("@rrweb/record");
  });

  it("returns null without a client key, since nothing could upload", async () => {
    const overseer = await import("../../overseer/index");
    const replay = await import("../index");
    overseer.init({ dsn: DSN, replaysSessionSampleRate: 1 });
    expect(replay.startReplay()).toBeNull();
  });

  it("uploads a segment after 5,000 events without waiting for the timer", async () => {
    useFakeClock();
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    replay.startReplay();
    await settle();
    expect(replayCalls()).toHaveLength(0);

    const { record } = await import("@rrweb/record");
    for (let i = 0; i < 5000; i++) record.addCustomEvent("tick", { i });
    await vi.advanceTimersByTimeAsync(0);

    expect(replayCalls().length).toBeGreaterThanOrEqual(1);
    const first = replayCalls()[0].body;
    expect(first.events.length).toBeGreaterThanOrEqual(5000 - 1);
    expect(first.segment).toBe(0);
  });

  it("numbers segments upward per replay_id and keeps the same replay_id", async () => {
    useFakeClock();
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    const id = replay.startReplay();
    await settle();
    const { record } = await import("@rrweb/record");
    record.addCustomEvent("a", 1);
    await vi.advanceTimersByTimeAsync(30_000);
    record.addCustomEvent("b", 2);
    await vi.advanceTimersByTimeAsync(30_000);

    const bodies = replayCalls().map((c) => c.body);
    expect(bodies.map((b) => b.segment)).toEqual([0, 1]);
    expect(new Set(bodies.map((b) => b.replay_id))).toEqual(new Set([id]));
  });
});

describe("on-error buffer", () => {
  it("uploads nothing before an error, then the buffered events once captureException runs", async () => {
    useFakeClock();
    document.body.innerHTML = `<p>before-the-error</p>`;
    const { overseer, replay } = await load({ replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 1 });
    const id = replay.startReplay();
    expect(id).toBeTruthy();
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(replayCalls()).toHaveLength(0);

    const eventId = overseer.captureException(new Error("boom"));
    await vi.advanceTimersByTimeAsync(0);

    expect(replayCalls()).toHaveLength(1);
    const body = replayCalls()[0].body;
    expect(body.replay_id).toBe(id);
    expect(body.segment).toBe(0);
    expect(body.error_event_ids).toEqual([eventId]);
    expect(body.events[0].type).toBe(4); // Meta, immediately followed by the full snapshot
    expect(body.events.some((e: { type: number }) => e.type === 2)).toBe(true);
    expect(replayCalls()[0].raw).toContain("before-the-error");
  });

  it("keeps recording for 30 s after the error and uploads that as the next segment", async () => {
    useFakeClock();
    const { overseer, replay } = await load({ replaysOnErrorSampleRate: 1 });
    const id = replay.startReplay();
    await settle();
    overseer.captureException(new Error("boom"));
    const { record } = await import("@rrweb/record");
    record.addCustomEvent("after-the-error", 1);
    await vi.advanceTimersByTimeAsync(30_000);

    const bodies = replayCalls().map((c) => c.body);
    expect(bodies.map((b) => b.segment)).toEqual([0, 1]);
    expect(bodies.every((b) => b.replay_id === id)).toBe(true);
    expect(replayCalls()[1].raw).toContain("after-the-error");

    // Afterwards the recorder buffers again under a fresh id, and nothing more uploads on its own.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(replayCalls()).toHaveLength(2);
    expect(replay.startReplay()).not.toBe(id);
  });

  it("keeps the buffer to about the last 60 s, starting at a full snapshot", async () => {
    useFakeClock();
    const { overseer, replay } = await load({ replaysOnErrorSampleRate: 1 });
    replay.startReplay();
    await settle();
    const { record } = await import("@rrweb/record");
    record.addCustomEvent("ancient", 1);
    // rrweb checks for a checkout when an interaction arrives; each rotation keeps one older generation, no more.
    await vi.advanceTimersByTimeAsync(40_000);
    click();
    record.addCustomEvent("middle", 1);
    await vi.advanceTimersByTimeAsync(40_000);
    click();
    record.addCustomEvent("recent", 1);
    overseer.captureException(new Error("late"));

    const text = allReplayText();
    expect(text).not.toContain("ancient");
    expect(text).toContain("recent");
    expect(replayCalls()[0].body.events[0].type).toBe(4);
    expect(replayCalls()[0].body.events.some((e: { type: number }) => e.type === 2)).toBe(true);
  });
});

describe("error linking and wire shape", () => {
  it("tags every error event with the replay_id while recording, and the body validates against the schema", async () => {
    useFakeClock();
    const { overseer, replay } = await load({ replaysOnErrorSampleRate: 1 });
    const id = replay.startReplay();
    await settle();
    const eventId = overseer.captureException(new Error("boom"));
    await vi.advanceTimersByTimeAsync(2000);

    const ingested = ingestCalls().flatMap((c) => c.body.events).find((e: any) => e.type === "error");
    expect(ingested.event.id).toBe(eventId);
    expect(ingested.event.tags.replay_id).toBe(id);
    expect(ingested.event.contexts.replay.replay_id).toBe(id);

    expect(replayCalls()).toHaveLength(1);
    const call = replayCalls()[0];
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>)["x-overseer-key"]).toBe("osk_test");
    expect((call.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const parsed = ReplaySegmentUploadSchema.parse(call.body);
    expect(parsed.sdk).toEqual({ ...SDK_INFO });
    expect(parsed.environment).toBe("production");
    expect(parsed.release).toBe("1.2.3");
    expect(call.raw.length).toBeLessThan(MAX_BODY_BYTES);
  });

  it("does not tag errors, or upload, after stopReplay", async () => {
    useFakeClock();
    const { overseer, replay } = await load({ replaysOnErrorSampleRate: 1 });
    replay.startReplay();
    await settle();
    replay.stopReplay();
    overseer.captureException(new Error("after-stop"));
    await vi.advanceTimersByTimeAsync(2000);
    const ingested = ingestCalls().flatMap((c) => c.body.events).find((e: any) => e.type === "error");
    expect(ingested.event.tags?.replay_id).toBeUndefined();
    expect(replayCalls()).toHaveLength(0);
  });

  it("accepts the contract's example payload, and rejects a broken one (negative control)", () => {
    expect(ReplaySegmentUploadSchema.safeParse(CONTRACT_EXAMPLE).success).toBe(true);
    expect(ReplaySegmentUploadSchema.safeParse({ ...CONTRACT_EXAMPLE, replay_id: "nope" }).success).toBe(false);
    expect(ReplaySegmentUploadSchema.safeParse({ ...CONTRACT_EXAMPLE, segment: -1 }).success).toBe(false);
  });
});

describe("upload helpers", () => {
  it("builds `<dsn>/replay`, swapping a trailing /ingest", async () => {
    const { replayEndpoint } = await import("../upload");
    expect(replayEndpoint("https://codmir.com/api/overseer")).toBe("https://codmir.com/api/overseer/replay");
    expect(replayEndpoint("https://codmir.com/api/overseer/")).toBe("https://codmir.com/api/overseer/replay");
    expect(replayEndpoint("https://codmir.com/api/overseer/ingest")).toBe("https://codmir.com/api/overseer/replay");
  });

  it("splits events so every body is under 2 MB and 10,000 events, dropping a single event that cannot fit", async () => {
    const { chunkEvents, buildSegmentBody, MAX_EVENTS_PER_SEGMENT } = await import("../upload");
    const big = (i: number) => ({ type: 3, timestamp: 1000 + i, data: { blob: "x".repeat(300_000) } });
    const many = Array.from({ length: 20 }, (_, i) => big(i));
    const { chunks, dropped } = chunkEvents(many);
    expect(dropped).toBe(0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const [n, chunk] of chunks.entries()) {
      const body = JSON.stringify(buildSegmentBody({}, { replayId: "r", sequenceNumber: n, events: chunk, errorIds: [] }));
      expect(body.length).toBeLessThan(MAX_BODY_BYTES);
    }
    expect(chunks.flat()).toHaveLength(20);

    const small = Array.from({ length: MAX_EVENTS_PER_SEGMENT + 1 }, (_, i) => ({ type: 3, timestamp: i }));
    expect(chunkEvents(small).chunks.map((c) => c.length)).toEqual([MAX_EVENTS_PER_SEGMENT, 1]);

    const huge = [{ type: 2, timestamp: 1, data: { blob: "x".repeat(2_000_000) } }, { type: 3, timestamp: 2 }];
    const out = chunkEvents(huge);
    expect(out.dropped).toBe(1);
    expect(out.chunks.flat()).toHaveLength(1);
  });

  it("retries a failed upload once and then drops it, never throwing", async () => {
    useFakeClock();
    respond = () => new Response("{}", { status: 503 });
    const { postSegment, buildSegmentBody } = await import("../upload");
    const target = { url: REPLAY_URL, key: "osk_test" };
    const body = buildSegmentBody(target, { replayId: CONTRACT_EXAMPLE.replay_id, sequenceNumber: 0, events: [{ type: 2, timestamp: 1 }], errorIds: [] });
    const result = postSegment(target, body);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe("failed");
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 4xx, and a thrown fetch resolves false", async () => {
    const { postSegment, buildSegmentBody } = await import("../upload");
    const target = { url: REPLAY_URL, key: "osk_test" };
    const body = buildSegmentBody(target, { replayId: CONTRACT_EXAMPLE.replay_id, sequenceNumber: 0, events: [{ type: 2, timestamp: 1 }], errorIds: [] });
    respond = () => new Response("{}", { status: 400 });
    expect(await postSegment(target, body)).toBe("failed");
    expect(calls).toHaveLength(1);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    useFakeClock();
    const result = postSegment(target, body, true); // hiding: no retry wait
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe("failed");
  });

  it("treats 202 {stored:false} as a refusal: no retry, and no more uploads this session", async () => {
    useFakeClock();
    respond = () => new Response(JSON.stringify({ stored: false, reason: "payment_required" }), { status: 202 });
    const { overseer, replay } = await load({ replaysSessionSampleRate: 1 });
    replay.startReplay();
    await settle();
    const { record } = await import("@rrweb/record");
    record.addCustomEvent("a", 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(replayCalls()).toHaveLength(1);
    expect(ReplayUploadResponseSchema.parse({ stored: false, reason: "payment_required" }).stored).toBe(false);
    record.addCustomEvent("b", 1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(replayCalls()).toHaveLength(1);
    // The recorder stopped, so errors are no longer linked to a replay.
    overseer.captureException(new Error("after-refusal"));
    await vi.advanceTimersByTimeAsync(2000);
    const err = ingestCalls().flatMap((c) => c.body.events).find((e: any) => e.type === "error");
    expect(err.event.tags?.replay_id).toBeUndefined();
  });

  it("keeps the newest 500 error ids per segment", async () => {
    const { buildSegmentBody } = await import("../upload");
    const ids = Array.from({ length: 600 }, (_, i) => `e${i}`);
    const body = buildSegmentBody({}, { replayId: CONTRACT_EXAMPLE.replay_id, sequenceNumber: 0, events: [{ type: 2, timestamp: 1 }], errorIds: ids });
    expect(body.error_event_ids).toHaveLength(500);
    expect(body.error_event_ids[0]).toBe("e100");
    expect(body.error_event_ids[499]).toBe("e599");
    expect(ReplaySegmentUploadSchema.safeParse(body).success).toBe(true);
  });

  it("a 503 is retried once, then dropped (replay storage not configured)", async () => {
    useFakeClock();
    respond = () => new Response("{}", { status: 503 });
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    replay.startReplay();
    await settle();
    const { record } = await import("@rrweb/record");
    record.addCustomEvent("a", 1);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(replayCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(replayCalls()).toHaveLength(2);
  });

  it("flushes the current segment on pagehide with keepalive when the body fits 64 KB", async () => {
    useFakeClock();
    const { replay } = await load({ replaysSessionSampleRate: 1 });
    replay.startReplay();
    await settle();
    const { record } = await import("@rrweb/record");
    record.addCustomEvent("last-words", 1);
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);

    expect(replayCalls()).toHaveLength(1);
    expect(replayCalls()[0].raw).toContain("last-words");
    // The full snapshot of this tiny page is well under 60 KB.
    expect((replayCalls()[0].init as { keepalive?: boolean }).keepalive).toBe(
      replayCalls()[0].raw.length <= 60_000 ? true : undefined,
    );
  });
});

describe("the page's address in uploads", () => {
  const PAGE = "https://app.example.com/a/b?access_token=QRY123&x=1#id_token=FRAG456";
  const SCRUBBED = "https://app.example.com/a/b";
  /** vitest's jsdom environment exposes its JSDOM; `reconfigure` moves the page to another address without navigating. */
  const jsdom = () => (globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom;
  /** The page's tokens found anywhere in `text`. */
  const leaked = (text: string) => ["QRY123", "FRAG456"].filter((token) => text.includes(token));
  const metaHrefs = () => sentEvents().filter((e) => e.type === 4).map((e) => e.data.href);

  let original: string;
  beforeEach(() => {
    original = window.location.href;
    jsdom().reconfigure({ url: PAGE });
  });
  afterEach(() => jsdom().reconfigure({ url: original }));

  it("a Meta event uploads with origin and path only, credentials dropped, width and height kept", async () => {
    const { buildSegmentBody } = await import("../upload");
    const events = [
      { type: 4, timestamp: 1, data: { href: PAGE, width: 1024, height: 768 } },
      { type: 4, timestamp: 2, data: { href: "https://user:pw@app.example.com/a/b?access_token=QRY123#id_token=FRAG456", width: 1, height: 2 } },
    ];
    const body = buildSegmentBody({}, { replayId: CONTRACT_EXAMPLE.replay_id, sequenceNumber: 0, events, errorIds: [] });
    expect(body.events.map((e) => e.data)).toEqual([
      { href: SCRUBBED, width: 1024, height: 768 },
      { href: SCRUBBED, width: 1, height: 2 },
    ]);
    expect(leaked(JSON.stringify(body))).toEqual([]);
    expect(ReplaySegmentUploadSchema.safeParse(body).success).toBe(true);
    expect(events.map((e) => e.data.href)).toEqual([PAGE, "https://user:pw@app.example.com/a/b?access_token=QRY123#id_token=FRAG456"]);
  });

  // Every path that sends a segment; `metas` is how many Meta events (the page's address) it uploads. The page holds a
  // fragment-only link, which rrweb records resolved against the page's full address, query included, until it is cut.
  const paths: Array<[string, Record<string, unknown>, number, (m: Awaited<ReturnType<typeof load>>) => Promise<void>]> = [
    ["the 30 s timer", { replaysSessionSampleRate: 1 }, 1, async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    }],
    ["the 5,000-event cap", { replaysSessionSampleRate: 1 }, 1, async () => {
      const { record } = await import("@rrweb/record");
      for (let i = 0; i < 5000; i++) record.addCustomEvent("tick", { i });
      await vi.advanceTimersByTimeAsync(0);
    }],
    ["pagehide (keepalive)", { replaysSessionSampleRate: 1 }, 1, async () => {
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(0);
      expect(replayCalls().map((c) => (c.init as { keepalive?: boolean }).keepalive)).toEqual([true]);
    }],
    ["visibilitychange to hidden (keepalive)", { replaysSessionSampleRate: 1 }, 1, async () => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(replayCalls().map((c) => (c.init as { keepalive?: boolean }).keepalive)).toEqual([true]);
    }],
    ["stopReplay", { replaysSessionSampleRate: 1 }, 1, async ({ replay }) => {
      replay.stopReplay();
      await vi.advanceTimersByTimeAsync(0);
    }],
    ["an error in on-error mode", { replaysOnErrorSampleRate: 1 }, 1, async ({ overseer }) => {
      overseer.captureException(new Error("boom"));
      await vi.advanceTimersByTimeAsync(0);
    }],
    ["the post-error window and the next buffer's error", { replaysOnErrorSampleRate: 1 }, 2, async ({ overseer }) => {
      overseer.captureException(new Error("first"));
      await vi.advanceTimersByTimeAsync(30_000); // the follow-up segment, then a new buffer with its own full snapshot
      overseer.captureException(new Error("second"));
      await vi.advanceTimersByTimeAsync(0);
    }],
  ];

  it.each(paths)("no token anywhere in the uploads from %s", async (_path, config, metas, act) => {
    useFakeClock();
    document.body.innerHTML = `<h1>Account</h1><a href="#top">Top</a><a href="/settings">Settings</a><p>signed-in-page</p>`;
    const loaded = await load(config);
    expect(loaded.replay.startReplay()).toBeTruthy();
    await settle();
    click();
    await act(loaded);

    expect(replayCalls().length).toBeGreaterThan(0);
    expect(leaked(allReplayText())).toEqual([]);
    expect(metaHrefs()).toEqual(Array.from({ length: metas }, () => SCRUBBED));
    expect(allReplayText()).toContain("signed-in-page");
  });

  const modes: Array<[string, Record<string, number>, (recorder: { markError(id: string): void }) => Promise<void>]> = [
    ["session", { sessionSampleRate: 1 }, async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    }],
    ["on-error", { sessionSampleRate: 0, errorSampleRate: 1 }, async (recorder) => recorder.markError("e1")],
  ];

  it.each(modes)("leaves the events the recorder holds as they were in %s mode: only the uploaded copy is scrubbed", async (_mode, rates, flush) => {
    useFakeClock();
    const { replay } = await load();
    const recorder = replay.createReplayRecorder({ ...rates, upload: { url: REPLAY_URL, key: "osk_test" } });
    // onSegment gets the very event objects the upload is then built from, before it is built.
    const held: Array<{ events: unknown[]; before: string }> = [];
    recorder.onSegment((segment) => held.push({ events: segment.events, before: JSON.stringify(segment.events) }));
    try {
      expect(recorder.start()).toBeTruthy();
      await settle();
      click();
      await flush(recorder);
      await vi.advanceTimersByTimeAsync(0);

      expect(held).toHaveLength(1);
      expect(replayCalls()).toHaveLength(1);
      expect(JSON.stringify(held[0].events)).toBe(held[0].before);
      const heldHrefs = (held[0].events as SentEvent[]).filter((e) => e.type === 4).map((e) => e.data.href);
      expect(heldHrefs).toEqual([PAGE]);
      expect(metaHrefs()).toEqual([SCRUBBED]);
    } finally {
      recorder.stop();
    }
  });

  describe("links and sources that point at the page", () => {
    /** Origin and path of the addresses `history` moves the page to below; each query holds a token too. */
    const NAV = "https://app.example.com/a/c";
    const LATE = "https://app.example.com/d";
    const tokens = (text: string) => ["QRY123", "FRAG456", "NAV789", "REPL321", "LATE555"].filter((t) => text.includes(t));

    /** Every uploaded value of attribute `name`: in full snapshots, in added nodes, and in attribute changes. */
    function recorded(name: string) {
      const nodes = (n: SnapshotNode): SnapshotNode[] => [n, ...(n.childNodes ?? []).flatMap(nodes)];
      const values = (tree: SnapshotNode) => nodes(tree).flatMap((n) => (n.attributes && name in n.attributes ? [n.attributes[name]] : []));
      const events = sentEvents();
      const mutations = events.filter((e) => e.type === 3 && e.data.source === 0);
      return {
        snapshot: events.flatMap((e) => (e.type === 2 && e.data.node ? values(e.data.node) : [])),
        added: mutations.flatMap((e) => (e.data.adds ?? []).flatMap((add) => values(add.node))),
        changed: mutations.flatMap((e) => (e.data.attributes ?? []).flatMap((c) => (name in c.attributes ? [c.attributes[name]] : []))),
      };
    }

    // Each fragment-only case: the element, its attribute, the value written, and what it must upload as.
    const cases: Array<[string, string, string, string]> = [
      ["a", "href", "#top", `${SCRUBBED}#top`],
      ["a", "href", "#", `${SCRUBBED}#`],
      ["img", "src", "#", `${SCRUBBED}#`],
      ["img", "srcset", "#a 1x, ?w=2 2x", `${SCRUBBED}#a 1x, ${SCRUBBED}?w=2 2x`],
      ["table", "background", "#", `${SCRUBBED}#`],
      ["object", "data", "#", `${SCRUBBED}#`],
    ];

    it.each(cases)("<%s %s=%j> uploads without the page's query from the full snapshot, an added node and a change", async (tag, name, value, expected) => {
      useFakeClock();
      document.body.innerHTML = `<${tag} id="snap" ${name}="${value}"></${tag}><${tag} id="change" ${name}="/start"></${tag}>`;
      const { replay } = await load({ replaysSessionSampleRate: 1 });
      expect(replay.startReplay()).toBeTruthy();
      await settle();
      const added = document.createElement(tag);
      added.setAttribute(name, value);
      document.body.appendChild(added);
      document.getElementById("change")?.setAttribute(name, value);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(recorded(name)).toEqual({ snapshot: [expected, "https://app.example.com/start"], added: [expected], changed: [expected] });
      expect(tokens(allReplayText())).toEqual([]);
    });

    it("leaves every other value as rrweb recorded it: its own query, another path or site, a form action, CSS", async () => {
      useFakeClock();
      document.body.innerHTML = [
        `<a id="empty" href="">empty</a><a id="own-query" href="?tab=2">tab</a><a id="other-path" href="next">next</a>`,
        `<a id="other-site" href="https://other.example.com/a/b?x=1#top">other</a><form id="form" action="#done"></form>`,
        `<svg><use id="use" href="#icon"></use></svg><div id="inline" style="background: url(#bg)"></div>`,
        `<style id="css">.x { background: url(#css) }</style>`,
      ].join("");
      const { replay } = await load({ replaysSessionSampleRate: 1 });
      expect(replay.startReplay()).toBeTruthy();
      await settle();
      document.getElementById("own-query")?.setAttribute("href", "?tab=3");
      await vi.advanceTimersByTimeAsync(30_000);

      const byId = new Map<string, Record<string, string>>();
      const walk = (n: SnapshotNode) => {
        if (n.attributes?.id) byId.set(n.attributes.id, n.attributes);
        n.childNodes?.forEach(walk);
      };
      sentEvents().forEach((e) => e.type === 2 && e.data.node && walk(e.data.node));
      expect(byId.get("empty")?.href).toBe("");
      expect(byId.get("own-query")?.href).toBe(`${SCRUBBED}?tab=2`);
      expect(byId.get("other-path")?.href).toBe("https://app.example.com/a/next");
      expect(byId.get("other-site")?.href).toBe("https://other.example.com/a/b?x=1#top");
      expect(byId.get("form")?.action).toBe("#done");
      expect(byId.get("use")?.href).toBe("#icon");
      expect(byId.get("inline")?.style).toBe("background: url(https://app.example.com/a/#bg)");
      expect(byId.get("css")?._cssText).toContain("url(#css)");
      expect(recorded("href").changed).toEqual([`${SCRUBBED}?tab=3`]);
      expect(tokens(allReplayText())).toEqual([]);
    });

    it("cuts a link in a later segment, which has no Meta event of its own", async () => {
      useFakeClock();
      document.body.innerHTML = `<a href="#top">Top</a>`;
      const { replay } = await load({ replaysSessionSampleRate: 1 });
      expect(replay.startReplay()).toBeTruthy();
      await settle();
      await vi.advanceTimersByTimeAsync(30_000);
      const later = document.createElement("a");
      later.setAttribute("href", "#later");
      document.body.appendChild(later);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(replayCalls().map((c) => (c.body.events as SentEvent[]).filter((e) => e.type === 4).length)).toEqual([1, 0]);
      expect(recorded("href")).toEqual({ snapshot: [`${SCRUBBED}#top`], added: [`${SCRUBBED}#later`], changed: [] });
      expect(tokens(allReplayText())).toEqual([]);
    });

    it("cuts the query of the address the page has when each event records, after pushState and replaceState", async () => {
      useFakeClock();
      document.body.innerHTML = `<a id="top" href="#top">Top</a><img id="img" srcset="#a 1x">`;
      const { replay } = await load({ replaysSessionSampleRate: 1 });
      expect(replay.startReplay()).toBeTruthy();
      await settle();
      history.pushState({}, "", "/a/c?session=NAV789&y=2");
      const after = document.createElement("a");
      after.setAttribute("href", "#after");
      document.body.appendChild(after);
      document.getElementById("top")?.setAttribute("href", "#changed");
      await vi.advanceTimersByTimeAsync(0);
      history.replaceState({}, "", "?other=REPL321");
      document.getElementById("img")?.setAttribute("srcset", "#z 1x, ?w=2 2x");
      await vi.advanceTimersByTimeAsync(30_000);

      expect(metaHrefs()).toEqual([SCRUBBED]);
      expect(recorded("href")).toEqual({ snapshot: [`${SCRUBBED}#top`], added: [`${NAV}#after`], changed: [`${NAV}#changed`] });
      expect(recorded("srcset")).toEqual({ snapshot: [`${SCRUBBED}#a 1x`], added: [], changed: [`${NAV}#z 1x, ${NAV}?w=2 2x`] });
      expect(tokens(allReplayText())).toEqual([]);
    });

    it("cuts the query in the on-error buffer, across a checkout taken after a navigation and a navigation after it", async () => {
      useFakeClock();
      document.body.innerHTML = `<a id="top" href="#top">Top</a>`;
      const { overseer, replay } = await load({ replaysOnErrorSampleRate: 1 });
      expect(replay.startReplay()).toBeTruthy();
      await settle();
      history.pushState({}, "", "/a/c?session=NAV789&y=2");
      await vi.advanceTimersByTimeAsync(31_000);
      click(); // rrweb checks for a checkout when an event arrives: a Meta and a full snapshot, at the new address
      await vi.advanceTimersByTimeAsync(0);
      history.pushState({}, "", "/d?late=LATE555");
      const late = document.createElement("a");
      late.setAttribute("href", "#late");
      document.body.appendChild(late);
      await vi.advanceTimersByTimeAsync(0);
      overseer.captureException(new Error("boom"));
      await vi.advanceTimersByTimeAsync(0);

      expect(replayCalls()).toHaveLength(1);
      expect(metaHrefs()).toEqual([SCRUBBED, NAV]);
      expect(recorded("href")).toEqual({ snapshot: [`${SCRUBBED}#top`, `${NAV}#top`], added: [`${LATE}#late`], changed: [] });
      expect(tokens(allReplayText())).toEqual([]);
    });

    it("cuts only a value that is the page's address, alone or with a fragment, and copies instead of mutating", async () => {
      const { dropPageQuery } = await import("../page-query");
      const page = "https://app.example.com/a/b?access_token=QRY123&x=1";
      const el = (attributes: Record<string, string>, id: number) => ({ type: 2, tagName: "a", attributes, childNodes: [], id });
      const kept = el({ href: `${page}&tab=2`, title: `${page}#top` }, 3);
      const snapshot = {
        type: 2,
        timestamp: 1,
        data: {
          node: {
            type: 0,
            id: 1,
            childNodes: [
              el({ href: `${page}#top`, "xlink:href": page, srcset: `${page}#a 1x, ${page} 2x, ${page}&w=2 3x`, HREF: `${page}#up` }, 2),
              kept,
              el({ href: `${page}2`, src: `https://other.example.com/?access_token=QRY123` }, 4),
            ],
          },
        },
      };
      const mutation = {
        type: 3,
        timestamp: 2,
        data: {
          source: 0,
          texts: [],
          removes: [],
          adds: [{ parentId: 1, nextId: null, node: el({ src: `${page}#` }, 5) }],
          attributes: [{ id: 2, attributes: { href: `${page}#x`, style: { color: "red" }, title: null } }],
        },
      };
      const before = JSON.stringify([snapshot, mutation]);

      const out = dropPageQuery(snapshot, `${page}#id_token=FRAG456`) as typeof snapshot;
      expect(out.data.node.childNodes.map((n) => n.attributes)).toEqual([
        { href: `${SCRUBBED}#top`, "xlink:href": SCRUBBED, srcset: `${SCRUBBED}#a 1x, ${SCRUBBED} 2x, ${page}&w=2 3x`, HREF: `${SCRUBBED}#up` },
        { href: `${page}&tab=2`, title: `${page}#top` },
        { href: `${page}2`, src: "https://other.example.com/?access_token=QRY123" },
      ]);
      expect(out.data.node.childNodes[1]).toBe(kept);
      const changed = dropPageQuery(mutation, page) as typeof mutation;
      expect(changed.data.adds[0].node.attributes).toEqual({ src: `${SCRUBBED}#` });
      expect(changed.data.attributes[0].attributes).toEqual({ href: `${SCRUBBED}#x`, style: { color: "red" }, title: null });
      expect(JSON.stringify([snapshot, mutation])).toBe(before);
      // Nothing to cut: no query in the page's address, or an event that holds no attributes.
      expect(dropPageQuery(snapshot, SCRUBBED)).toBe(snapshot);
      const meta = { type: 4, timestamp: 3, data: { href: page } };
      expect(dropPageQuery(meta, page)).toBe(meta);
    });
  });
});
