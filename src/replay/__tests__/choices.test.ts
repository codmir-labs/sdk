// @vitest-environment jsdom
/**
 * What a visitor picked is in no uploaded event: the real rrweb recorder in jsdom, and the bytes it uploads. Each test
 * asserts on state (a `checked` key, an input event of a choice's node), never on a word, since a choice's `value` and
 * label are page content and stay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DSN = "https://ingest.example.test/api/overseer";
const REPLAY_URL = `${DSN}/replay`;

type Node = { id: number; type?: number; tagName?: string; attributes?: Record<string, unknown>; childNodes?: Node[] };
type Ev = { type: number; data: any };
let uploads: string[];

const sent = (): Ev[] => uploads.flatMap((raw) => JSON.parse(raw).events as Ev[]);
const text = () => uploads.join("\n");

beforeEach(() => {
  uploads = [];
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      uploads.push(String(init.body));
      return new Response(JSON.stringify({ stored: true }), { status: 202 });
    }),
  );
  document.body.innerHTML = "";
});

afterEach(async () => {
  const replay = await import("../index");
  replay.stopReplay();
  (await import("../../overseer/index")).close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const settle = async () => {
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
};

/** Records `html` with `config` (privacy), runs `act`, and uploads everything. */
async function record(html: string, privacy: Record<string, unknown> | undefined, act: () => Promise<void> | void = () => {}, before: () => void = () => {}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  document.body.innerHTML = html;
  before();
  const overseer = await import("../../overseer/index");
  const replay = await import("../index");
  overseer.init({ dsn: DSN, clientKey: "osk_test", replaysSessionSampleRate: 1 });
  expect(replay.startReplay(privacy ? ({ privacy } as never) : undefined)).toBeTruthy();
  await settle();
  await act();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(uploads.length).toBeGreaterThan(0);
  void REPLAY_URL;
}

/** Every serialised node in the recording: the snapshots and the added nodes. */
function nodes(): Node[] {
  const walk = (n: Node): Node[] => [n, ...(n.childNodes ?? []).flatMap(walk)];
  return sent().flatMap((e) => {
    if (e.type === 2) return walk(e.data.node);
    if (e.type === 3 && e.data.source === 0) return (e.data.adds ?? []).flatMap((a: { node: Node }) => walk(a.node));
    return [];
  });
}
const hasKey = (o: Record<string, unknown> | undefined, key: string) => Object.keys(o ?? {}).some((k) => k.toLowerCase() === key);
/** Whether any recorded node, or any attribute change, carries a `checked`. */
const checkedKeys = () =>
  nodes().filter((n) => hasKey(n.attributes, "checked")).length +
  sent().flatMap((e) => (e.type === 3 && e.data.source === 0 ? e.data.attributes ?? [] : [])).filter((c: { attributes: Record<string, unknown> }) => hasKey(c.attributes, "checked")).length;
const inputEvents = () => sent().filter((e) => e.type === 3 && e.data.source === 5).map((e) => e.data);
const idOf = (selector: string) => nodes().find((n) => n.attributes?.id === selector)?.id;

const radios = (checked = "") => `<form id="f"><input id="r1" type="radio" name="g" value="diagnosis-yes" ${checked}><input id="r2" type="radio" name="g" value="diagnosis-no"></form>`;
const box = (extra = "") => `<label>Agree <input id="c" type="checkbox" name="agree" value="consent-given" ${extra}></label>`;
const el = (id: string) => document.getElementById(id) as HTMLInputElement;
/** Everything that tells a pick: a `checked` key, an input event or a click of a radio button or checkbox. */
const picks = (ids: string[]) => {
  const own = new Set(ids.map(idOf));
  return {
    checked: checkedKeys(),
    inputs: inputEvents().length,
    clicks: sent().filter((e) => e.type === 3 && e.data.source === 2 && own.has(e.data.id)).length,
    isChecked: /"isChecked":true/.test(text()),
  };
};
const NONE = { checked: 0, inputs: 0, clicks: 0, isChecked: false };

describe("a picked radio button or checkbox, with the default privacy", () => {
  it("is in no snapshot, whether checked in the markup, by script, by a click, by a key, or by a reset", async () => {
    await record(radios("checked") + box("checked"), undefined, async () => {
      el("r2").click();
      el("c").click();
      el("c").dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      el("c").click();
      el("r1").checked = true;
      el("c").checked = true;
      el("c").indeterminate = true;
      (document.getElementById("f") as HTMLFormElement).reset();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(picks(["r1", "r2", "c"])).toEqual(NONE);
    // The control itself, its value and its label are page content.
    expect(nodes().find((n) => n.attributes?.id === "r1")?.attributes).toMatchObject({ type: "radio", name: "g", value: "diagnosis-yes" });
    expect(text()).toContain("consent-given");
  });

  it("is in no added node and no attribute change, whatever the case of the tag and the type", async () => {
    await record("<div id=host></div>", undefined, async () => {
      const host = document.getElementById("host") as HTMLElement;
      host.innerHTML = `<INPUT TYPE="RaDiO" id="a" name="x" CHECKED value="v1"><input type="CHECKBOX" id="b" checked>`;
      el("a").checked = true;
      await vi.advanceTimersByTimeAsync(0);
      el("a").setAttribute("checked", "");
      el("b").removeAttribute("checked");
      el("b").setAttribute("checked", "checked");
      el("a").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(picks(["a", "b"])).toEqual(NONE);
    expect(nodes().find((n) => n.attributes?.id === "a")?.attributes).toMatchObject({ name: "x", value: "v1" });
  });

  it("is hidden when a script turns a text input into a checkbox, and shown again when it turns back", async () => {
    await record(`<input id="t" type="text">`, undefined, async () => {
      el("t").setAttribute("type", "checkbox");
      await vi.advanceTimersByTimeAsync(0);
      el("t").setAttribute("checked", "");
      el("t").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(picks(["t"])).toEqual(NONE);
  });

  it("is hidden inside an iframe, from its first snapshot and for what is added later", async () => {
    const frame = () => (document.getElementById("fr") as HTMLIFrameElement).contentDocument as Document;
    await record(
      `<iframe id="fr"></iframe>`,
      undefined,
      async () => {
        frame().body.insertAdjacentHTML("beforeend", `<input id="ir2" type="radio" name="q" value="inner-late" checked>`);
        await vi.advanceTimersByTimeAsync(10);
        (frame().getElementById("ir") as HTMLInputElement).click();
        (frame().getElementById("ir2") as HTMLInputElement).click();
        (frame().getElementById("ic") as HTMLInputElement).checked = true;
        await vi.advanceTimersByTimeAsync(10);
      },
      () => {
        frame().body.innerHTML = `<input id="ir" type="radio" name="q" value="inner-yes" checked><input id="ic" type="checkbox" checked>`;
      },
    );
    for (const id of ["ir", "ic", "ir2"]) expect(nodes().some((n) => n.attributes?.id === id)).toBe(true);
    expect(picks(["ir", "ic", "ir2"])).toEqual(NONE);
  });

  it("is hidden inside a shadow root", async () => {
    await record(`<div id="host"></div>`, undefined, async () => {
      const root = (document.getElementById("host") as HTMLElement).attachShadow({ mode: "open" });
      root.innerHTML = `<input id="sr" type="radio" name="s" value="shadow-yes" checked><input id="sc" type="checkbox" checked>`;
      await vi.advanceTimersByTimeAsync(10);
      (root.getElementById("sr") as HTMLInputElement).click();
      (root.getElementById("sc") as HTMLInputElement).checked = true;
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(nodes().some((n) => n.attributes?.id === "sr")).toBe(true);
    expect(picks(["sr", "sc"])).toEqual(NONE);
  });
});

describe("recorded as today when nothing masks them", () => {
  it("records a radio button and a checkbox with maskAllInputs off and the types not named", async () => {
    await record(radios("checked") + box(), { maskAllInputs: false, maskInputTypes: ["password"] }, async () => {
      el("r2").click();
      el("c").click();
    });
    expect(checkedKeys()).toBeGreaterThan(0);
    expect(inputEvents().filter((e) => e.isChecked).length).toBe(2);
    expect(sent().filter((e) => e.type === 3 && e.data.source === 2).length).toBe(2);
  });

  it("hides only the type that is named when maskAllInputs is off", async () => {
    await record(radios("checked") + box("checked"), { maskAllInputs: false, maskInputTypes: ["Radio"] }, async () => {
      el("r2").click();
      el("c").click();
    });
    const own = (id: string) => idOf(id);
    expect(nodes().find((n) => n.attributes?.id === "r1")?.attributes).not.toHaveProperty("checked");
    expect(nodes().find((n) => n.attributes?.id === "c")?.attributes).toHaveProperty("checked");
    expect(inputEvents().map((e) => e.id)).toEqual([own("c")]);
  });
});

const selectHtml = `<select id="s"><option id="o1" value="a" selected>A</option><option id="o2" value="b">B</option></select>`;
const selectedKeys = () =>
  nodes().filter((n) => hasKey(n.attributes, "selected")).length +
  sent().flatMap((e) => (e.type === 3 && e.data.source === 0 ? e.data.attributes ?? [] : [])).filter((c: { attributes: Record<string, unknown> }) => hasKey(c.attributes, "selected")).length;
const attributesOf = (id: string) => nodes().find((n) => n.attributes?.id === id)?.attributes;

describe("the other controls, with the default privacy", () => {
  it("a <select> and its <option selected> record no pick, by markup, by script or by an attribute", async () => {
    await record(selectHtml, undefined, async () => {
      el("s").value = "b";
      el("o1").removeAttribute("selected");
      el("o2").setAttribute("selected", "");
      (el("s") as unknown as HTMLSelectElement).selectedIndex = 0;
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(selectedKeys()).toBe(0);
    expect(attributesOf("s")?.value).toBe("********");
    expect(inputEvents().every((e) => e.text === "********")).toBe(true);
    // The options' own values are page content.
    expect(attributesOf("o2")).toMatchObject({ value: "b" });
  });

  it("a <select> option is recorded as selected when selects are not masked", async () => {
    await record(selectHtml, { maskAllInputs: false }, async () => {
      el("o2").setAttribute("selected", "");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(selectedKeys()).toBeGreaterThan(0);
  });

  it("range, color, date and file inputs record a mask, never the value picked", async () => {
    await record(
      `<input id="rg" type="range" value="70"><input id="co" type="color" value="#ff0000"><input id="da" type="date" value="2020-01-02"><input id="fi" type="file">`,
      undefined,
      async () => {
        for (const [id, value] of [["rg", "90"], ["co", "#00ff00"], ["da", "2021-03-04"]] as const) {
          el(id).value = value;
          el(id).dispatchEvent(new Event("input", { bubbles: true }));
        }
        el("fi").dispatchEvent(new Event("change", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(0);
      },
    );
    for (const id of ["rg", "co", "da"]) expect(attributesOf(id)?.value).toBe("********");
    expect(attributesOf("fi")).not.toHaveProperty("value");
    expect(inputEvents().length).toBeGreaterThan(0);
    expect(inputEvents().every((e) => e.text === "" || e.text === "********")).toBe(true);
    expect(text()).not.toMatch(/#ff0000|#00ff00|2020-01-02|2021-03-04|"(70|90)"/);
  });

  it("contenteditable text is recorded as the page's text (the README says so)", async () => {
    await record(`<div id="ce" contenteditable="true">hello</div>`, undefined, async () => {
      (document.getElementById("ce") as HTMLElement).firstChild!.nodeValue = "typed here";
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(text()).toContain("typed here");
  });

  it("a custom control is page markup and is recorded; data-codmir-block leaves it out", async () => {
    await record(
      `<div id="cr" role="radio" aria-checked="false" data-state="off">Yes</div><div data-codmir-block><div id="bl" role="radio" aria-checked="false" data-state="off">No</div></div>`,
      undefined,
      async () => {
        document.getElementById("cr")!.setAttribute("aria-checked", "true");
        document.getElementById("cr")!.setAttribute("data-state", "on");
        document.getElementById("bl")!.setAttribute("aria-checked", "true");
        await vi.advanceTimersByTimeAsync(0);
      },
    );
    expect(text()).toContain('"aria-checked":"true"');
    expect(text()).toContain('"data-state":"on"');
    expect(attributesOf("bl")).toBeUndefined();
  });
});

describe("the limit of ids", () => {
  /** A snapshot of `count` text inputs under the body, one id each. */
  const snapshot = (count: number): { type: number; timestamp: number; data: unknown } => ({
    type: 2,
    timestamp: 1,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          { type: 2, id: 2, tagName: "body", attributes: {}, childNodes: Array.from({ length: count }, (_, i) => ({ type: 2, id: 10 + i, tagName: "input", attributes: { type: "text" }, childNodes: [] })) },
        ],
      },
    },
  });
  const addRadio = (id: number, parentId: number) => ({
    type: 3,
    timestamp: 2,
    data: { source: 0, texts: [], attributes: [], removes: [], adds: [{ parentId, nextId: null, node: { type: 2, id, tagName: "input", attributes: { type: "radio", checked: true }, childNodes: [] } }] },
  });
  const input = (id: number) => ({ type: 3, timestamp: 3, data: { source: 5, id, text: "x", isChecked: false } });
  const attrs = (id: number, attributes: Record<string, unknown>) => ({ type: 3, timestamp: 4, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id, attributes }] } });
  const size = (f: object) => (f as unknown as { entries: Map<number, unknown> }).entries.size;
  const filter = async (limit?: number) => {
    const { ChoiceFilter, hiddenChoices, CHOICE_ID_LIMIT } = await import("../choices");
    expect(CHOICE_ID_LIMIT).toBe(50_000);
    return new ChoiceFilter(hiddenChoices({ maskAllInputs: true, maskInputTypes: [] }), limit);
  };

  it("keeps the ids of the page, and hides every input once 50,000 are known", async () => {
    const f = await filter();
    f.apply(snapshot(49_990) as never);
    expect(size(f)).toBe(49_992);
    // Room for the radio button and the checked change: they are known as choices.
    expect(f.apply(addRadio(900_000, 2) as never)?.data).toMatchObject({ adds: [{ node: { attributes: { type: "radio" } } }] });
    expect(f.apply(input(900_000) as never)).toBeNull();
    expect(f.apply(input(10) as never)).not.toBeNull();
    // Past the limit nothing is known: the next added radio, an old text input and an unknown id all count as hidden.
    for (let i = 0; i < 20; i++) f.apply(addRadio(910_000 + i, 2) as never);
    expect(size(f)).toBe(0);
    const added = f.apply(addRadio(920_000, 2) as never);
    expect(JSON.stringify(added)).not.toContain("checked");
    expect(f.apply(input(10) as never)).toBeNull();
    expect(f.apply(input(123_456_789) as never)).toBeNull();
    expect(f.apply(attrs(10, { checked: "", title: "t" }) as never)).toMatchObject({ data: { attributes: [{ id: 10, attributes: { title: "t" } }] } });
  });

  it("takes an event and an attribute of a node it never saw for a choice when only a choice has them", async () => {
    const f = await filter();
    f.apply(snapshot(3) as never);
    const event = (extra: object) => ({ type: 3, timestamp: 3, data: { source: 5, id: 777_777, text: "x", ...extra } });
    expect(f.apply(event({ isChecked: true }) as never)).toBeNull();
    expect(f.apply(event({ isChecked: false }) as never)).not.toBeNull();
    const changed = f.apply(attrs(777_777, { checked: "", selected: "", title: "t" }) as never);
    expect((changed?.data as { attributes: unknown }).attributes).toEqual([{ id: 777_777, attributes: { title: "t" } }]);
  });

  it("leaves no item behind for a change of nothing but the choice: the item would name the node", async () => {
    const f = await filter();
    f.apply(snapshot(3) as never);
    f.apply(addRadio(900_000, 2) as never);
    const changed = f.apply(attrs(900_000, { checked: "" }) as never);
    expect((changed?.data as { attributes: unknown }).attributes).toEqual([]);
  });

  it("forgets a removed subtree when the map is full, so a page that renders and removes forever never reaches the limit", async () => {
    const f = await filter(1000);
    f.apply(snapshot(10) as never);
    const tree = (round: number) => ({
      type: 3,
      timestamp: 5,
      data: {
        source: 0, texts: [], attributes: [], removes: [],
        adds: [{ parentId: 2, nextId: null, node: { type: 2, id: 100_000 + round, tagName: "div", attributes: {}, childNodes: Array.from({ length: 400 }, (_, i) => ({ type: 2, id: 1_000_000 + round * 1000 + i, tagName: "input", attributes: { type: "checkbox" }, childNodes: [] })) } }],
      },
    });
    for (let round = 0; round < 20; round++) {
      f.apply(tree(round) as never);
      f.apply({ type: 3, timestamp: 6, data: { source: 0, texts: [], attributes: [], adds: [], removes: [{ parentId: 2, id: 100_000 + round }] } } as never);
    }
    expect(size(f)).toBeLessThanOrEqual(1000);
    // Not at the limit: a new checkbox is still known by its id.
    f.apply(addRadio(77, 2) as never);
    expect(f.apply(input(77) as never)).toBeNull();
    expect(f.apply(input(10) as never)).not.toBeNull();
  });

  it("takes a removal of an id it never saw, such as a text node", async () => {
    const f = await filter();
    f.apply(snapshot(2) as never);
    expect(() => f.apply({ type: 3, timestamp: 6, data: { source: 0, texts: [], attributes: [], adds: [], removes: [{ parentId: 2, id: 4242 }] } } as never)).not.toThrow();
  });

  it("starts again at a full snapshot", async () => {
    const f = await filter(20);
    f.apply(snapshot(30) as never);
    expect(f.apply(input(10) as never)).toBeNull();
    f.apply(snapshot(5) as never);
    expect(f.apply(input(10) as never)).not.toBeNull();
  });

  it("holds in the real recorder: nodes past the limit, then a radio button and a text input", async () => {
    vi.doMock("../choices", async (original) => {
      const mod = await original<typeof import("../choices")>();
      return { ...mod, ChoiceFilter: class extends mod.ChoiceFilter { constructor(h: ConstructorParameters<typeof mod.ChoiceFilter>[0]) { super(h, 30); } } };
    });
    await record(`<input id="t" type="text">${"<i></i>".repeat(40)}<input id="r" type="radio" checked>`, undefined, async () => {
      el("r").click();
      el("t").value = "typed";
      el("t").dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(picks(["r"])).toEqual(NONE);
    vi.doUnmock("../choices");
  });
});
