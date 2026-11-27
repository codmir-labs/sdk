// @vitest-environment jsdom
/**
 * What a replay masks stays masked: a custom selector list keeps the defaults, a contenteditable area is masked like an
 * input, `maskAllText` masks the page, and a mask covers the attributes that hold what a person wrote or picked.
 * Same harness as replay.test.ts: fetch stubbed, fake clock, rrweb loaded through the real dynamic import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DSN = "https://ingest.example.test/api/overseer";
const REPLAY_URL = `${DSN}/replay`;
const PIXEL = "SECRETPIXELSiVBORw0KGgo";

type Call = { url: string; init: RequestInit; body: any; raw: string };
let calls: Call[];

const replayCalls = () => calls.filter((c) => c.url === REPLAY_URL);
const allReplayText = () => replayCalls().map((c) => c.raw).join("\n");
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
      calls.push({ url, init, raw, body });
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

function click() {
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** Records a session: `setup` runs before the recorder starts, `act` after its first snapshot; returns what was uploaded. */
async function record(setup: () => void | Promise<void>, act: () => void | Promise<void> = () => {}, privacy: Record<string, unknown> = {}) {
  useFakeClock();
  await setup();
  const overseer = await import("../../overseer/index");
  const replay = await import("../index");
  overseer.init({ dsn: DSN, clientKey: "osk_test", environment: "production", release: "1.2.3", replaysSessionSampleRate: 1 });
  replay.startReplay({ privacy } as never);
  await settle();
  await act();
  await vi.advanceTimersByTimeAsync(0);
  click();
  await vi.advanceTimersByTimeAsync(30_000);
  return allReplayText();
}

const leaked = (text: string, secrets: string[]) => secrets.filter((s) => text.includes(s));

describe("attributes under a mask", () => {
  it("K2 inverted: title, aria-label, alt, mailto and placeholder of a [data-private] element are not uploaded", async () => {
    const text = await record(() => {
      document.body.innerHTML = `<div data-private title="Jane Q. Doe" aria-label="Jane-aria-label">
        <span>masked-body-text</span>
        <img alt="Passport photo of Jane-alt" src="/me.png">
        <a href="mailto:jane.doe@example.com">contact</a>
        <input placeholder="Jane-placeholder">
      </div>`;
    });
    expect(leaked(text, ["masked-body-text", "Jane Q. Doe", "Jane-aria-label", "Passport photo of Jane-alt", "jane.doe@example.com", "Jane-placeholder"])).toEqual([]);
    expect(text).toContain('"href":"mailto:"');
    // masked in place, as the text is: same length, spaces kept
    expect(text).toContain('"title":"**** ** ***"');
    // every other attribute is as written
    expect(text).toContain("/me.png");
  });

  it("K3 inverted: a data: image under [data-private] is recorded with the placeholder and none of its bytes", async () => {
    const text = await record(() => {
      document.body.innerHTML = `<div data-private><img id="pic" src="data:image/png;base64,${PIXEL}"></div>`;
    });
    expect(text).not.toContain(PIXEL);
    const { DATA_URL_PLACEHOLDER } = await import("../composed-privacy");
    expect(text).toContain(`"src":"${DATA_URL_PLACEHOLDER}"`);
    expect(text).toContain('"tagName":"img"');
  });

  it("covers a button's value, tel: links, any-case schemes, srcset, poster and xlink:href", async () => {
    const text = await record(() => {
      document.body.innerHTML = `<div data-private>
        <button value="button-secret-value">go</button>
        <input type="SUBMIT" value="submit-secret-value">
        <a href="  TEL:+15551230000">call</a>
        <a href="https://example.com/keep-this">plain</a>
        <img srcset="/a.png 1x, data:image/png;base64,${PIXEL} 2x">
        <video poster="data:image/png;base64,${PIXEL}"></video>
        <svg><use xlink:href="data:image/svg+xml;base64,${PIXEL}"></use></svg>
      </div>`;
    });
    expect(leaked(text, ["button-secret-value", "submit-secret-value", "5551230000", PIXEL])).toEqual([]);
    expect(text).toContain('"href":"tel:"');
    expect(text).toContain("https://example.com/keep-this");
  });

  it("a later title on a [data-private] element, and a later <img> with a data: src, are not uploaded", async () => {
    const text = await record(
      () => {
        document.body.innerHTML = `<div data-private id="box"><p id="p">inside</p></div><p>public</p>`;
      },
      async () => {
        document.getElementById("p")!.setAttribute("title", "late-title-secret");
        await vi.advanceTimersByTimeAsync(0);
        const img = document.createElement("img");
        img.setAttribute("src", `data:image/png;base64,${PIXEL}`);
        img.setAttribute("alt", "late-alt-secret");
        document.getElementById("box")!.appendChild(img);
      },
    );
    expect(leaked(text, ["late-title-secret", "late-alt-secret", PIXEL])).toEqual([]);
    expect(text).toContain("data:image/gif;base64,");
    expect(text).toContain("public");
  });

  it("covers an element in an open shadow root under a [data-private] host, in the snapshot and when added later", async () => {
    let root!: ShadowRoot;
    const text = await record(
      () => {
        document.body.innerHTML = `<div data-private><x-name id="host"></x-name></div><p>public</p>`;
        root = (document.getElementById("host") as HTMLElement).attachShadow({ mode: "open" });
        root.innerHTML = `<b title="shadow-snapshot-title" aria-label="shadow-snapshot-label">x</b>`;
      },
      async () => {
        const i = document.createElement("i");
        i.setAttribute("title", "shadow-added-title");
        i.setAttribute("aria-label", "shadow-added-label");
        root.appendChild(i);
        await vi.advanceTimersByTimeAsync(0);
        root.querySelector("b")!.setAttribute("title", "shadow-changed-title");
      },
    );
    expect(leaked(text, ["shadow-snapshot-title", "shadow-snapshot-label", "shadow-added-title", "shadow-added-label", "shadow-changed-title"])).toEqual([]);
    expect(text).toContain("public");
  });

  it("outside any mask a title, an alt and a mailto: link are uploaded unchanged", async () => {
    const text = await record(() => {
      document.body.innerHTML = `<p title="open-title">a</p><img alt="open-alt" src="/x.png"><a href="mailto:open@example.com">m</a>`;
    });
    for (const kept of ["open-title", "open-alt", "mailto:open@example.com"]) expect(text).toContain(kept);
  });
});

describe("selector lists keep the defaults", () => {
  it("maskSelectors: ['.card'] masks .card and still masks [data-private] and .private", async () => {
    const text = await record(
      () => {
        document.body.innerHTML = `<p class="card">card-secret</p><p data-private>data-private-secret</p><p class="private">private-class-secret</p><p>public-text</p>`;
      },
      () => {
        document.body.insertAdjacentHTML("beforeend", `<p class="card">card-added</p><p class="private">private-added</p>`);
      },
      { maskSelectors: [".card"] },
    );
    expect(leaked(text, ["card-secret", "data-private-secret", "private-class-secret", "card-added", "private-added"])).toEqual([]);
    expect(text).toContain("public-text");
  });

  it("blockSelectors: ['.ad'] still blocks [data-codmir-block] and [data-block-replay]", async () => {
    const text = await record(
      () => {
        document.body.innerHTML = `<div class="ad">ad-secret</div><div data-codmir-block>block-secret</div><div data-block-replay>legacy-secret</div><p>public-text</p>`;
      },
      () => {},
      { blockSelectors: [".ad"] },
    );
    expect(leaked(text, ["ad-secret", "block-secret", "legacy-secret"])).toEqual([]);
    expect(text.match(/"rr_width"/g)).toHaveLength(3);
  });

  it("dropDefaultSelectors: ['.private'] records .private text in clear, and [data-private] stays masked", async () => {
    const text = await record(
      () => {
        document.body.innerHTML = `<p class="private">own-css-class-text</p><p data-private>still-masked-text</p>`;
      },
      () => {},
      { dropDefaultSelectors: [".private"] },
    );
    expect(text).toContain("own-css-class-text");
    expect(text).not.toContain("still-masked-text");
  });

  it("resolves defaults first, then the caller's, without duplicates", async () => {
    const { resolvePrivacy } = await import("../privacy");
    const out = resolvePrivacy({ maskSelectors: [".card", ".private"], blockSelectors: [".ad"], ignoreSelectors: [".x", ".x"], dropDefaultSelectors: ["[data-block-replay]"] });
    expect(out.maskSelectors).toEqual(["[data-private]", ".private", ".card"]);
    expect(out.blockSelectors).toEqual(["[data-codmir-block]", ".ad"]);
    expect(out.ignoreSelectors).toEqual([".x"]);
    expect(resolvePrivacy().maskSelectors).toEqual(["[data-private]", ".private"]);
  });

  it("rrweb and the composed filter get the same mask selector", async () => {
    const { resolvePrivacy, toRrwebPrivacy } = await import("../privacy");
    const out = toRrwebPrivacy(resolvePrivacy({ maskSelectors: [".card"], maskAllText: true }));
    expect(out.maskTextSelector).toBe('[data-private], .private, .card, [contenteditable]:not([contenteditable="false"]), *');
    expect(toRrwebPrivacy(resolvePrivacy({ maskAllInputs: false })).maskTextSelector).toBe("[data-private], .private");
  });

  it("reports an unknown dropDefaultSelectors entry once, with upload.debug, and drops nothing", async () => {
    useFakeClock();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const overseer = await import("../../overseer/index");
    const replay = await import("../index");
    overseer.init({ dsn: DSN, clientKey: "osk_test", environment: "production" });
    document.body.innerHTML = `<p data-private>kept-masked</p>`;
    const recorder = replay.createReplayRecorder({
      sessionSampleRate: 1,
      privacy: { dropDefaultSelectors: [".nope", ".nope", ".private"] },
      upload: { url: REPLAY_URL, key: "osk_test", debug: true },
    });
    expect(recorder.start()).toBeTruthy();
    await settle();
    recorder.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.mock.calls).toEqual([['[Overseer replay] privacy.dropDefaultSelectors: ignored ".nope", it names no default selector']]);
    expect(allReplayText()).not.toContain("kept-masked");
  });
});

describe("contenteditable", () => {
  it("masks text present at the first snapshot and text typed after it, descendants included", async () => {
    const text = await record(
      () => {
        document.body.innerHTML = `<div id="ed" contenteditable><p>snapshot-typed-text</p></div><p>public-text</p>`;
      },
      async () => {
        const ed = document.getElementById("ed")!;
        ed.querySelector("p")!.firstChild!.textContent = "changed-typed-text";
        await vi.advanceTimersByTimeAsync(0);
        ed.insertAdjacentHTML("beforeend", `<p>added-typed-text</p>`);
      },
    );
    expect(leaked(text, ["snapshot-typed-text", "changed-typed-text", "added-typed-text"])).toEqual([]);
    expect(text).toContain("public-text");
  });

  it("masks it inside an open shadow root as well", async () => {
    let root!: ShadowRoot;
    const text = await record(
      () => {
        document.body.innerHTML = `<x-ed id="host"></x-ed>`;
        root = (document.getElementById("host") as HTMLElement).attachShadow({ mode: "open" });
        root.innerHTML = `<div contenteditable="true"><b>shadow-editor-snapshot</b></div>`;
      },
      () => {
        root.querySelector("div")!.insertAdjacentHTML("beforeend", `<i>shadow-editor-added</i>`);
      },
    );
    expect(leaked(text, ["shadow-editor-snapshot", "shadow-editor-added"])).toEqual([]);
  });

  it('does not mask contenteditable="false"', async () => {
    const text = await record(() => {
      document.body.innerHTML = `<div contenteditable="false">not-editable-text</div>`;
    });
    expect(text).toContain("not-editable-text");
  });

  it("is recorded as before with maskAllInputs: false", async () => {
    const text = await record(
      () => {
        document.body.innerHTML = `<div id="ed" contenteditable>unmasked-snapshot</div>`;
      },
      () => {
        document.getElementById("ed")!.insertAdjacentHTML("beforeend", `<p>unmasked-added</p>`);
      },
      { maskAllInputs: false },
    );
    expect(text).toContain("unmasked-snapshot");
    expect(text).toContain("unmasked-added");
  });
});

describe("maskAllText", () => {
  it("uploads no text from plain paragraphs, an open shadow root and a same-origin iframe, masks title, and leaves <style> alone", async () => {
    let root!: ShadowRoot;
    let frame!: HTMLIFrameElement;
    const text = await record(
      () => {
        document.head.innerHTML = `<style>.keep-style-rule { color: red; }</style>`;
        document.body.innerHTML = `<p title="all-text-title">plain-paragraph</p><x-w id="host"></x-w><iframe id="f"></iframe>`;
        root = (document.getElementById("host") as HTMLElement).attachShadow({ mode: "open" });
        root.innerHTML = `<b>shadow-paragraph</b>`;
        frame = document.getElementById("f") as HTMLIFrameElement;
        frame.contentDocument!.body.innerHTML = `<p>frame-paragraph</p>`;
      },
      async () => {
        await vi.advanceTimersByTimeAsync(100);
        const i = document.createElement("i");
        i.textContent = "shadow-added";
        root.appendChild(i);
        const p = frame.contentDocument!.createElement("p");
        p.textContent = "frame-added";
        frame.contentDocument!.body.appendChild(p);
        document.body.insertAdjacentHTML("beforeend", `<p title="added-title">plain-added</p>`);
      },
      { maskAllText: true },
    );
    expect(
      leaked(text, ["plain-paragraph", "shadow-paragraph", "frame-paragraph", "shadow-added", "frame-added", "plain-added", "all-text-title", "added-title"]),
    ).toEqual([]);
    expect(text).toContain(".keep-style-rule");
    expect(sentEvents().length).toBeGreaterThan(0);
  });

  it("is off by default", async () => {
    const text = await record(() => {
      document.body.innerHTML = `<p title="default-title">default-paragraph</p>`;
    });
    expect(text).toContain("default-paragraph");
    expect(text).toContain("default-title");
  });
});
