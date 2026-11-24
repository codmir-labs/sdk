/**
 * Links and sources in a recording keep the page's address without its query. rrweb stores a URL attribute resolved
 * against the page's address of the moment it serialises the node, so `href="#top"`, `src="#"` or a `srcset` entry
 * `#a 1x` would otherwise upload the page's whole query, a token in it included, in a full snapshot or a mutation.
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
  attributes?: Record<string, unknown>;
  childNodes?: SerializedNode[];
}

interface MutationData {
  source?: number;
  adds?: Array<{ node: SerializedNode }>;
  attributes?: Array<{ attributes: Record<string, unknown> }>;
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
      if (typeof value !== "string") continue;
      const key = name.toLowerCase();
      const fixed = key === "srcset" ? cutSrcset(value) : URL_ATTRIBUTES.has(key) ? cut(value) : value;
      if (fixed !== value) (copy ??= { ...attributes })[name] = fixed;
    }
    return copy ?? attributes;
  };
  const fixNode = (node: SerializedNode): SerializedNode => {
    const attributes = node.attributes && fixAttributes(node.attributes);
    const childNodes = node.childNodes && mapChanged(node.childNodes, fixNode);
    if (attributes === node.attributes && childNodes === node.childNodes) return node;
    return { ...node, ...(attributes && { attributes }), ...(childNodes && { childNodes }) };
  };

  if (event.type === FULL_SNAPSHOT) {
    const data = event.data as { node?: SerializedNode } | undefined;
    if (!data?.node) return event;
    const node = fixNode(data.node);
    return node === data.node ? event : { ...event, data: { ...data, node } };
  }
  const data = event.data as MutationData | undefined;
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
