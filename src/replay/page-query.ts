/**
 * Links, sources and CSS in a recording keep the page's address without its query. rrweb stores a URL attribute
 * resolved against the page's address of the moment it serialises the node, so `href="#top"`, `src="#"` or a `srcset`
 * entry `#a 1x` would otherwise upload the page's whole query, a token in it included, in a full snapshot or a mutation.
 *
 * CSS is resolved by another function (rrweb-snapshot `absolutifyURLs`, called with `getHref(doc)` for a style attribute
 * and the text of a `<style>`, and with the sheet's `href` or its owner's `baseURI` for a rule): it splits the address
 * (fragment dropped) at every `/`, drops the last part, appends the parts of the written path (`.` skipped, `..` drops
 * one more part) and joins them again. A query without a `/` sits in the last part, which is dropped: nothing leaks. In
 * `/a/b?next=/x/y&token=abc/def` the last part is `y&token=abc`, so `url(#bg)` becomes `/a/b?next=/x/y&token=abc/#bg`,
 * and `url(../i.png)` becomes `/a/b?next=/x/i.png`. So what rrweb writes into CSS is the page's path, `?`, and a
 * prefix of the query that ends before a `/` and keeps that `/`. A `<base href>` changes the base of the style attribute
 * and of a `<style>`, so the address then holds the base's path and query, never the page's, and nothing matches. A
 * `<link>` sheet resolves against its own address. Rules inserted by script (`insertRule`, `replace`, a style
 * declaration) are recorded as written; they match only when the script wrote the page's address into them.
 * What is cut: the page's path followed by `?` and a prefix of the page's query that ends in `/`, or the whole query.
 * A `?` and that prefix go, the `/` stays, so the written path survives: `/a/b/#bg`, `/a/b/i.png`. Anything else,
 * an absolute URL of the author with a query of its own included, stays. A page without a `?` costs nothing.
 */

import { scrubUrl } from "../overseer/url-scrub";
import type { RrwebEvent } from "./upload";

/** rrweb's full snapshot and incremental snapshot event types, and the incremental source of a DOM mutation. */
const FULL_SNAPSHOT = 2;
const INCREMENTAL_SNAPSHOT = 3;
const MUTATION = 0;

/**
 * The attributes rrweb resolves as one URL (`transformAttribute`), besides `srcset`. They are matched by name on every
 * element: rrweb resolves `background` only on table cells and `data` only on `object`, so elsewhere their values are
 * as written, and one of those can only match by being the page's own address, which is cut the same way.
 */
const URL_ATTRIBUTES = new Set(["href", "src", "xlink:href", "background", "data"]);

interface SerializedNode {
  type?: number;
  isStyle?: boolean;
  textContent?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SerializedNode[];
}

interface MutationData {
  source?: number;
  adds?: Array<{ node: SerializedNode }>;
  attributes?: Array<{ attributes: Record<string, unknown> }>;
}

/** rrweb's incremental sources that carry CSS text. */
const STYLE_SHEET_RULE = 8;
const STYLE_DECLARATION = 13;
const ADOPTED_STYLE_SHEET = 15;

/** The node type of a text node, which rrweb marks `isStyle` inside a `<style>`. */
const TEXT_NODE = 3;

type Rewrite = (css: string) => string;

/**
 * `css` with its escapes decoded (`\2f `, `\/`, a backslash before a line break), and for each decoded unit where it
 * starts in `css`, so a match in the decoded text can be cut out of the original.
 */
function decodeEscapes(css: string): { text: string; at: number[] } {
  const at: number[] = [];
  let text = "";
  for (const m of css.matchAll(/\\(?:([\da-f]{1,6})(?:\r\n|[ \t\n\r\f])?|([^]))|[^\\]+/gi)) {
    const unit = m[1] ? String.fromCodePoint(Math.min(parseInt(m[1], 16), 0x10ffff) || 0xfffd) : m[2] === "\n" ? "" : (m[2] ?? m[0]);
    for (let i = 0; i < unit.length; i++) at.push(m.index + (m[2] === undefined && !m[1] ? i : 0));
    text += unit;
  }
  at.push(css.length);
  return { text, at };
}

/** `items` with `fix` applied to each, or `items` itself when `fix` changed none of them. */
function mapChanged<T>(items: T[], fix: (item: T) => T): T[] {
  let out: T[] | undefined;
  items.forEach((item, i) => {
    const fixed = fix(item);
    if (fixed !== item) (out ??= items.slice())[i] = fixed;
  });
  return out ?? items;
}

/**
 * `event` with every URL attribute that is the page's address, alone or with a fragment, cut to origin, path and that
 * fragment. `pageHref` is `window.location.href` when rrweb emits the event: rrweb serialises a full snapshot or a
 * mutation and emits it in the same task, so that is the address the values were resolved against, also after a
 * `history.pushState` that rrweb records no Meta event for. A value with a query of its own, any other value and CSS
 * text stay as they are. Only the changed paths are copied; rrweb's own objects are never mutated.
 */
export function dropPageQuery(event: RrwebEvent, pageHref: string): RrwebEvent {
  if (event.type !== FULL_SNAPSHOT && event.type !== INCREMENTAL_SNAPSHOT) return event;
  const hash = pageHref.indexOf("#");
  const page = hash === -1 ? pageHref : pageHref.slice(0, hash);
  if (!page.includes("?")) return event;
  const bare = scrubUrl(page);
  const rewrite = cssCutter(page);

  const cut = (url: string): string => {
    if (!url.startsWith(page)) return url;
    const rest = url.slice(page.length);
    return rest === "" || rest.startsWith("#") ? bare + rest : url;
  };
  // rrweb writes a srcset back as "url descriptors, url descriptors"; each entry's URL is its first word.
  const cutSrcset = (srcset: string): string =>
    srcset
      .split(", ")
      .map((entry) => entry.replace(/^\S+/, cut))
      .join(", ");
  const fixAttributes = (attributes: Record<string, unknown>): Record<string, unknown> => {
    let copy: Record<string, unknown> | undefined;
    for (const [name, value] of Object.entries(attributes)) {
      const key = name.toLowerCase();
      let fixed: unknown = value;
      if (key === "style" && value !== null && typeof value === "object") fixed = deep(value, rewrite);
      else if (typeof value !== "string") continue;
      else if (key === "srcset") fixed = cutSrcset(value);
      else if (URL_ATTRIBUTES.has(key)) fixed = cut(value);
      else if (key === "style" || key === "_csstext") fixed = rewrite(value);
      if (fixed !== value) (copy ??= { ...attributes })[name] = fixed;
    }
    return copy ?? attributes;
  };
  const fixNode = (node: SerializedNode): SerializedNode => {
    const attributes = node.attributes && fixAttributes(node.attributes);
    const childNodes = node.childNodes && mapChanged(node.childNodes, fixNode);
    const text = node.type === TEXT_NODE && node.isStyle === true && typeof node.textContent === "string" ? rewrite(node.textContent) : undefined;
    if (attributes === node.attributes && childNodes === node.childNodes && (text === undefined || text === node.textContent)) return node;
    return { ...node, ...(attributes && { attributes }), ...(childNodes && { childNodes }), ...(text !== undefined && { textContent: text }) };
  };

  if (event.type === FULL_SNAPSHOT) {
    const data = event.data as { node?: SerializedNode } | undefined;
    if (!data?.node) return event;
    const node = fixNode(data.node);
    return node === data.node ? event : { ...event, data: { ...data, node } };
  }
  const data = event.data as MutationData | undefined;
  if (data?.source === STYLE_SHEET_RULE || data?.source === STYLE_DECLARATION || data?.source === ADOPTED_STYLE_SHEET) {
    // Every string in these events is CSS (a rule, a value) or a name that holds no URL.
    const fixed = deep(data, rewrite);
    return fixed === data ? event : { ...event, data: fixed };
  }
  if (data?.source !== MUTATION) return event;
  const adds =
    data.adds &&
    mapChanged(data.adds, (add) => {
      const node = add.node && fixNode(add.node);
      return node === add.node ? add : { ...add, node };
    });
  const attributes =
    data.attributes &&
    mapChanged(data.attributes, (item) => {
      const fixed = item.attributes && fixAttributes(item.attributes);
      return fixed === item.attributes ? item : { ...item, attributes: fixed };
    });
  if (adds === data.adds && attributes === data.attributes) return event;
  return { ...event, data: { ...data, ...(adds && { adds }), ...(attributes && { attributes }) } };
}

/** `value` with `rewrite` applied to every string in it, in arrays and objects as deep as they go; copies what changed. */
function deep<T>(value: T, rewrite: Rewrite): T {
  if (typeof value === "string") return rewrite(value) as T;
  if (Array.isArray(value)) return mapChanged(value, (item) => deep(item, rewrite)) as T;
  if (value === null || typeof value !== "object") return value;
  let copy: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value)) {
    const fixed = deep(item, rewrite);
    if (fixed !== item) (copy ??= { ...(value as object) })[key] = fixed;
  }
  return (copy ?? value) as T;
}

/**
 * A function that cuts the page's query out of CSS text, and returns the same string object when there is nothing to
 * cut. It looks for the page's path followed by `?` and a prefix of the page's query that ends in `/` (or all of it), in
 * the text with its CSS escapes decoded, one linear pass; the match is cut out of the original text.
 */
function cssCutter(page: string): Rewrite {
  const question = page.indexOf("?");
  const head = page.slice(0, question + 1);
  const query = page.slice(question + 1);
  return (css) => {
    // The address may be written with escapes; a text without any backslash is not.
    const escaped = css.includes("\\") ? decodeEscapes(css) : undefined;
    const text = escaped ? escaped.text : css;
    const raw = (i: number): number => (escaped ? (escaped.at[i] as number) : i);
    let out = "";
    let done = 0;
    for (let found = query ? text.indexOf(head) : -1; found !== -1; found = text.indexOf(head, found + head.length)) {
      const start = found + head.length;
      let matched = 0;
      while (matched < query.length && text[start + matched] === query[matched]) matched++;
      const length = matched === query.length ? matched : matched && query.lastIndexOf("/", matched - 1) + 1;
      if (length) {
        out += css.slice(done, raw(start - 1)) + (query[length - 1] === "/" ? "/" : "");
        done = raw(start + length);
      }
    }
    return done ? out + css.slice(done) : css;
  };
}
