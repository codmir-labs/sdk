// @vitest-environment jsdom
/**
 * The page's query in CSS. rrweb resolves a relative `url(...)` against the page's address cut at its last slash, so on
 * `/a/b?next=/x/y&token=TOK123/DEF456` a `background: url(#bg)` is recorded with `?next=/x/y&token=TOK123/` inside it.
 * The unit cases hold each shape of text and each event; the recorder cases hold what rrweb itself writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropPageQuery } from "../page-query";
import type { RrwebEvent } from "../upload";

const PAGE = "https://app.example.com/a/b?next=/x/y&token=TOK123/DEF456";
const BARE = "https://app.example.com/a/b";
/** What rrweb writes for `url(#bg)` on PAGE: the address up to its last slash, then the fragment. */
const DIR = "https://app.example.com/a/b?next=/x/y&token=TOK123/";

const incremental = (data: Record<string, unknown>): RrwebEvent => ({ type: 3, timestamp: 1, data });
const mutation = (data: Record<string, unknown>) => incremental({ source: 0, texts: [], attributes: [], removes: [], adds: [], ...data });
const tokens = (value: unknown) => ["TOK123", "DEF456", "next=/x", "token="].filter((t) => JSON.stringify(value).includes(t));
const cut = (css: string, page = PAGE) => {
  const event = dropPageQuery(mutation({ attributes: [{ id: 1, attributes: { style: css } }] }), page);
  return ((event.data as { attributes: Array<{ attributes: { style: string } }> }).attributes[0] as { attributes: { style: string } }).attributes.style;
};

describe("a url() in CSS text", () => {
  it.each([
    ["unquoted", `background: url(${DIR}#bg)`, `background: url(${BARE}/#bg)`],
    ["double quoted", `background: url("${DIR}#bg")`, `background: url("${BARE}/#bg")`],
    ["single quoted", `background: url('${DIR}#bg')`, `background: url('${BARE}/#bg')`],
    ["with a path rrweb appended", `background: url(${DIR}img/a.png)`, `background: url(${BARE}/img/a.png)`],
    ["after a .. that dropped one part", `background: url(https://app.example.com/a/b?next=/x/i.png)`, `background: url(${BARE}/i.png)`],
    ["with spaces and quotes rrweb left in", `background: url(${DIR} "#bg" )`, `background: url(${BARE}/ "#bg" )`],
    ["an @import", `@import url("${DIR}a.css");`, `@import url("${BARE}/a.css");`],
    ["an @import with a string", `@import "${DIR}a.css";`, `@import "${BARE}/a.css";`],
    ["an image-set", `background: image-set(url(${DIR}a.png) 1x, "${DIR}b.png" 2x)`, `background: image-set(url(${BARE}/a.png) 1x, "${BARE}/b.png" 2x)`],
    ["several in one value", `background: url(${DIR}a), url(${DIR}b), url(data:image/png;base64,AAA)`, `background: url(${BARE}/a), url(${BARE}/b), url(data:image/png;base64,AAA)`],
    ["the whole address, as a script writes it", `background: url(${PAGE}#bg)`, `background: url(${BARE}#bg)`],
    ["the address with its slash escaped", `background: url(${DIR.replace("?next=/x", "?next=\\/x")}#bg)`, `background: url(${BARE}/#bg)`],
    ["the address with hex escapes", `background: url(${DIR.replace("/x/y", "\\2f x\\2f y")}#bg)`, `background: url(${BARE}/#bg)`],
    ["the address with escaped quotes around it", `background: url("\\68ttps://app.example.com/a/b?next=/x/y&token=TOK123/#bg")`, `background: url("\\68ttps://app.example.com/a/b/#bg")`],
  ])("%s is cut", (_name, css, expected) => {
    const out = cut(css);
    expect(out).toBe(expected);
    expect(tokens(out)).toEqual([]);
  });

  it("leaves what is not the page's own query: the author's absolute urls with a query, data urls, other sites", () => {
    for (const css of [
      `background: url(https://app.example.com/a/b?next=1)`,
      `background: url(https://app.example.com/a/b?theme=dark&x=/y/)`,
      `background: url(https://cdn.example.com/a/b?next=/x/y&token=TOK123/q)`,
      `background: url(data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>)`,
      `background: url(https://app.example.com/a/b/#bg)`,
      `background: url(/a/b?next=/x/y&token=TOK123/q)`,
      `background: url(#bg)`,
      "",
    ]) {
      expect(cut(css)).toBe(css);
    }
  });

  it("returns the same string object when nothing matches, and costs nothing on a page without a query", () => {
    const css = "a { background: url(#x) } b { color: red }";
    const event = mutation({ attributes: [{ id: 1, attributes: { style: css } }] });
    expect(dropPageQuery(event, PAGE)).toBe(event);
    const withMatch = mutation({ attributes: [{ id: 1, attributes: { style: `url(${DIR}#bg)` } }] });
    expect(dropPageQuery(withMatch, "https://app.example.com/a/b")).toBe(withMatch);
    expect(dropPageQuery(withMatch, "https://app.example.com/a/b?x=1")).toBe(withMatch);
    expect(dropPageQuery(withMatch, "https://app.example.com/a/b?")).toBe(withMatch);
  });

  it("does not cut a query that has no slash, which rrweb never writes: the last part of the address is dropped", () => {
    const page = "https://app.example.com/a/b?token=TOK123";
    // What rrweb writes for url(#bg) there is the path's directory.
    expect(cut("background: url(https://app.example.com/a/#bg)", page)).toBe("background: url(https://app.example.com/a/#bg)");
    // A script that writes the whole address is cut, as the same address is in a link.
    expect(cut(`background: url(${page}#bg)`, page)).toBe(`background: url(${page.split("?")[0]}#bg)`);
  });

  it("handles 1 MB of CSS in linear time, matching or not, and with escapes", () => {
    const rule = `.c { background: url(${DIR}img.png); color: red }\n`;
    const plain = ".c { background: url(#x); color: red; margin: 0 }\n".repeat(Math.ceil(1_000_000 / 50));
    const matching = rule.repeat(Math.ceil(1_000_000 / rule.length));
    const escaped = `.c { content: "\\2f \\2f"; background: url(${DIR}img.png) }\n`.repeat(Math.ceil(1_000_000 / 70));
    const hostile = "url(".repeat(250_000);
    const nearly = `${BARE}?next=/x/y&token=TOK123`.repeat(25_000);
    for (const css of [plain, matching, escaped, hostile, nearly]) {
      const start = performance.now();
      const out = cut(css);
      expect(performance.now() - start).toBeLessThan(100);
      expect(out.includes("TOK123/DEF456") || out.includes(`${DIR}img.png`)).toBe(false);
    }
    expect(cut(plain)).toBe(plain);
  });
});

describe("every place rrweb puts CSS", () => {
  const style = `background: url(${DIR}#bg)`;
  const fixed = `background: url(${BARE}/#bg)`;
  const fullNode = (extra: Record<string, unknown>, children: unknown[] = []) => ({
    type: 0,
    childNodes: [{ type: 2, tagName: "div", attributes: { id: "n", ...extra }, childNodes: children, id: 5 }],
  });
  const textOf = (event: RrwebEvent) => JSON.stringify(event);

  it("the style attribute and _cssText in a full snapshot, and the text of a <style>", () => {
    const event: RrwebEvent = {
      type: 2,
      timestamp: 1,
      data: {
        node: fullNode({ style }, [
          { type: 2, tagName: "style", attributes: { _cssText: `.x { background: url(${DIR}#css) }` }, childNodes: [{ type: 3, textContent: `.y { background: url(${DIR}#txt) }`, isStyle: true, id: 7 }], id: 6 },
          { type: 3, textContent: `plain text url(${DIR}#keep)`, id: 8 },
        ]),
      },
    };
    const out = dropPageQuery(event, PAGE);
    const node = (out.data as { node: { childNodes: Array<{ attributes: Record<string, string>; childNodes: Array<{ textContent: string }> }> } }).node.childNodes[0] as never as {
      attributes: Record<string, string>;
      childNodes: Array<{ attributes: Record<string, string>; childNodes: Array<{ textContent: string }>; textContent?: string }>;
    };
    expect(node.attributes.style).toBe(fixed);
    expect(node.childNodes[0]?.attributes._cssText).toBe(`.x { background: url(${BARE}/#css) }`);
    expect(node.childNodes[0]?.childNodes[0]?.textContent).toBe(`.y { background: url(${BARE}/#txt) }`);
    // A text node that is not a <style>'s is page text.
    expect(node.childNodes[1]?.textContent).toBe(`plain text url(${DIR}#keep)`);
    // The input is never changed.
    expect(textOf(event)).toContain("TOK123");
  });

  it("the style attribute and _cssText in an added node and a changed attribute, and the object form of a style change", () => {
    const out = dropPageQuery(
      mutation({
        adds: [{ parentId: 1, nextId: null, node: { type: 2, tagName: "div", attributes: { style, _cssText: style }, childNodes: [], id: 9 } }],
        attributes: [
          { id: 2, attributes: { style } },
          { id: 3, attributes: { style: { "background-image": `url(${DIR}#bg)`, color: ["red", "important"], margin: false, border: [`url(${DIR}#b)`, "important"] } } },
        ],
      }),
      PAGE,
    );
    expect(tokens(out)).toEqual([]);
    const data = out.data as { adds: Array<{ node: { attributes: Record<string, string> } }>; attributes: Array<{ attributes: { style: unknown } }> };
    expect(data.adds[0]?.node.attributes).toEqual({ style: fixed, _cssText: fixed });
    expect(data.attributes[0]?.attributes.style).toBe(fixed);
    expect(data.attributes[1]?.attributes.style).toEqual({ "background-image": `url(${BARE}/#bg)`, color: ["red", "important"], margin: false, border: [`url(${BARE}/#b)`, "important"] });
  });

  it("StyleSheetRule: adds[].rule, replace and replaceSync", () => {
    const out = dropPageQuery(incremental({ source: 8, id: 1, adds: [{ rule: `a { ${style} }`, index: [0] }, { rule: "b { color: red }" }], replace: `a { ${style} }`, replaceSync: `a { ${style} }`, removes: [{ index: 1 }] }), PAGE);
    expect(tokens(out)).toEqual([]);
    expect(out.data).toMatchObject({ adds: [{ rule: `a { ${fixed} }`, index: [0] }, { rule: "b { color: red }" }], replace: `a { ${fixed} }`, replaceSync: `a { ${fixed} }`, removes: [{ index: 1 }] });
  });

  it("AdoptedStyleSheet: styles[].rules[].rule", () => {
    const out = dropPageQuery(incremental({ source: 15, id: 1, styleIds: [1], styles: [{ styleId: 1, rules: [{ rule: `a { ${style} }`, index: 0 }, { rule: "b {}", index: 1 }] }] }), PAGE);
    expect(tokens(out)).toEqual([]);
    expect(out.data).toMatchObject({ styles: [{ styleId: 1, rules: [{ rule: `a { ${fixed} }`, index: 0 }, { rule: "b {}", index: 1 }] }] });
  });

  it("StyleDeclaration: set.value", () => {
    const out = dropPageQuery(incremental({ source: 13, id: 1, index: [0], set: { property: "background", value: `url(${DIR}#bg)`, priority: "important" } }), PAGE);
    expect(out.data).toMatchObject({ set: { property: "background", value: `url(${BARE}/#bg)`, priority: "important" } });
    const same = incremental({ source: 13, id: 1, index: [0], remove: { property: "background" } });
    expect(dropPageQuery(same, PAGE)).toBe(same);
  });

  it("copies only what changed and never changes the event it was given", () => {
    const untouched = { rule: "b {}", index: 1 };
    const event = incremental({ source: 15, id: 1, styles: [{ styleId: 1, rules: [{ rule: `a { ${style} }`, index: 0 }] }, { styleId: 2, rules: [untouched] }] });
    const before = JSON.stringify(event);
    const out = dropPageQuery(event, PAGE);
    expect(JSON.stringify(event)).toBe(before);
    expect(((out.data as { styles: Array<{ rules: unknown[] }> }).styles[1] as { rules: unknown[] }).rules[0]).toBe(untouched);
  });
});

describe("what rrweb records in a page whose address holds a query with slashes", () => {
  const jsdom = () => (globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom;
  const DSN = "https://ingest.example.test/api/overseer";
  let uploads: string[];
  let original: string;

  beforeEach(() => {
    uploads = [];
    original = window.location.href;
    jsdom().reconfigure({ url: PAGE });
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        uploads.push(String(init.body));
        return new Response(JSON.stringify({ stored: true }), { status: 202 });
      }),
    );
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });
  afterEach(async () => {
    (await import("../index")).stopReplay();
    (await import("../../overseer/index")).close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    jsdom().reconfigure({ url: original });
  });

  it("holds no part of the query anywhere in a whole session: style attributes, <style>, rules, declarations", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    document.head.innerHTML = `<style id="st">.x { background: url(#css) } .y { background-image: url("../img/a.png") }</style>`;
    document.body.innerHTML = `<div id="inline" style="background: url(#bg); color: red"></div>`;
    const overseer = await import("../../overseer/index");
    const replay = await import("../index");
    overseer.init({ dsn: DSN, clientKey: "osk_test", replaysSessionSampleRate: 1 });
    expect(replay.startReplay()).toBeTruthy();
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);

    const add = document.createElement("div");
    add.setAttribute("style", "background: url(#added)");
    document.body.appendChild(add);
    document.getElementById("inline")!.setAttribute("style", "background: url(#changed); color: blue");
    const sheet = (document.getElementById("st") as HTMLStyleElement).sheet as CSSStyleSheet;
    // jsdom's own stylesheet classes are not the ones rrweb patches, so these record no event here; a browser does.
    sheet.insertRule(`.z { background: url(${location.href}#script) }`, 0);
    (sheet.cssRules[0] as CSSStyleRule).style.setProperty("background", `url(${location.href}#decl)`);
    await vi.advanceTimersByTimeAsync(30_000);

    const bytes = uploads.join("\n");
    expect(uploads.length).toBeGreaterThan(0);
    expect(bytes).toContain("background: url(https://app.example.com/a/b/#bg)");
    expect(bytes).toContain("url(https://app.example.com/a/b/#added)");
    expect(bytes).toContain("url(#css)");
    expect(["TOK123", "DEF456", "next=/x", "token=TOK", "%2Fx"].filter((part) => bytes.includes(part))).toEqual([]);
  });
});
