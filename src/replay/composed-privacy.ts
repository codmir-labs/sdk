/**
 * Mask and block hold inside open shadow roots and same-origin iframes, later changes included. rrweb carries the mask
 * and the block into them only in a full snapshot: its mutation path re-checks with `closest()`, which stops at a shadow
 * root or a document, so text added or changed later under `[data-private]` is recorded in clear, what a blocked web
 * component renders later is recorded under its placeholder, and the document of a blocked `<iframe>` is attached whole.
 * The events are changed here, after rrweb and after `ChoiceFilter`, before they are kept:
 *
 * - a block placeholder (an element serialized with `rr_width` and `rr_height`) is remembered by id, in a full snapshot
 *   and in an add, and every add below one, or below an add that was dropped, is dropped, an `isAttachIframe` event of a
 *   blocked iframe included;
 * - each add and each `texts` entry is looked up as a live node in rrweb's mirror, and the mask and block selectors are
 *   tested on its composed ancestors: from a ShadowRoot on at its `host`, from a Document on at its `defaultView.frameElement`.
 *   Under a block the add or the text is dropped; under a mask the text becomes `*` for every character but a space,
 *   as rrweb masks it in a snapshot (the text of a `<style>` or `<script>` is not text and stays);
 * - under a mask, in a full snapshot, an add and an attribute change, the attributes that hold what a person wrote or
 *   picked are covered: `title`, `alt`, `aria-label`, `aria-description`, `placeholder` and the `value` of a button are
 *   masked like text, an `href` of `mailto:` or `tel:` is cut to its scheme, and a `data:` URL in `src`, `srcset`,
 *   `poster`, `href` or `xlink:href` becomes one fixed placeholder. Every other attribute stays as it is;
 * - each `attributes` entry of a mutation under a block is dropped, and so is any other incremental event (input, mouse
 *   interaction, scroll, media) whose `data.id` is under a block, as the recorder drops them itself for a light-DOM
 *   block. Under a mask, attributes and input values stay as the recorder sends them, its own light-DOM rule.
 *
 * - any other incremental event whose numeric `data.id` is negative, or names a node the mirror does not know, is dropped:
 *   the recorder sends id -1 for a node it never serialized (an input in a blocked shadow root at the first snapshot), and
 *   the player cannot apply an event to a node it does not know, so playback loses nothing.
 *
 * - a `<meta>` whose `name`, `property` or `http-equiv` names a token (a part, split on anything but letters, that is `csrf`,
 *   `xsrf`, `token`, `nonce`, `secret` or `key`) is recorded with `content` set to an empty string: in a full snapshot, in an
 *   add, and in an attribute change that sets `content` on one or sets the `name` that makes a meta one. rrweb's own
 *   `headMetaVerification` drops a few such tags; this covers the names it does not list.
 *
 * Mutations keep their rule: a node the mirror does not know is kept as rrweb sent it. Nothing here throws into the page. An event
 * with nothing to change is passed on as it is, the same object.
 */

import type { RrwebEvent } from "./upload";

const FULL_SNAPSHOT = 2;
const INCREMENTAL_SNAPSHOT = 3;
const MUTATION = 0;
const ELEMENT_NODE = 1;
const DOCUMENT_NODE = 9;
const FRAGMENT_NODE = 11;
/** rrweb's serialized node types. */
const SERIALIZED_ELEMENT = 2;
const SERIALIZED_TEXT = 3;

/** What a `data:` URL under a mask becomes: a 1x1 transparent GIF, none of the original. */
export const DATA_URL_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const MASKED_ATTRIBUTES = new Set(["title", "alt", "aria-label", "aria-description", "placeholder"]);
const DATA_URL_ATTRIBUTES = new Set(["src", "srcset", "poster", "href", "xlink:href"]);
const BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset"]);

/** A URL as a browser reads its start: without leading spaces and control characters. */
function urlStart(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/^[\u0000-\u0020]+/, "");
}

/**
 * `attributes` of an element as they may be kept under a mask: the same object when nothing changes. `type` is the
 * element's input type, which a change of another attribute does not carry.
 */
function coverAttributes(tag: string, type: string | undefined, attributes: Record<string, unknown>): Record<string, unknown> {
  let result: Record<string, unknown> | undefined;
  const button = tag === "button" || (tag === "input" && BUTTON_INPUT_TYPES.has((type ?? "").trim().toLowerCase()));
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value !== "string" || value === "") continue;
    let next = value;
    if (MASKED_ATTRIBUTES.has(name) || (name === "value" && button)) next = mask(value);
    else if (name === "href" && /^(mailto|tel):/i.test(urlStart(value))) next = urlStart(value).slice(0, urlStart(value).indexOf(":") + 1).toLowerCase();
    else if (DATA_URL_ATTRIBUTES.has(name) && (name === "srcset" ? /(^|[\s,])data:/i.test(value) : /^data:/i.test(urlStart(value)))) next = DATA_URL_PLACEHOLDER;
    if (next !== value) (result ??= { ...attributes })[name] = next;
  }
  return result ?? attributes;
}

/** How many ids of blocked subtrees the filter keeps; the oldest go first. The live mirror is the check that does not forget. */
export const BLOCKED_ID_LIMIT = 50_000;

interface SerializedNode {
  id?: number;
  type?: number;
  textContent?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SerializedNode[];
}

interface Add {
  parentId: number;
  node: SerializedNode;
}

/** The `<meta>` attributes that can name a token. */
const META_NAMING = ["name", "property", "http-equiv"];
const TOKEN_WORDS = new Set(["csrf", "xsrf", "token", "nonce", "secret", "key"]);

/** Whether `name` names a token: one of its parts, split on anything but letters, is a token word. */
export function namesToken(name: unknown): boolean {
  return typeof name === "string" && name.toLowerCase().split(/[^a-z]+/).some((part) => TOKEN_WORDS.has(part));
}

function isTokenMeta(node: SerializedNode): boolean {
  if (node.type !== SERIALIZED_ELEMENT || !node.attributes) return false;
  if ((node as { tagName?: string }).tagName?.toLowerCase() !== "meta") return false;
  return META_NAMING.some((key) => namesToken(node.attributes?.[key]));
}

/** `node` with its `content` blanked when it is a token meta, else itself. */
function blankMeta(node: SerializedNode): SerializedNode {
  if (!isTokenMeta(node) || node.attributes?.content === undefined || node.attributes.content === "") return node;
  return { ...node, attributes: { ...node.attributes, content: "" } };
}

interface MutationData {
  source?: number;
  adds?: Add[];
  texts?: Array<{ id: number; value: string | null }>;
  attributes?: Array<{ id: number; attributes?: Record<string, unknown> }>;
  removes?: unknown[];
}

/** What the filter needs of rrweb's mirror. */
export interface NodeLookup {
  getNode(id: number): Node | null;
}

export interface ComposedPrivacyOptions {
  /** The joined mask selector, as rrweb gets it; none means nothing is masked here. */
  maskSelector?: string;
  /** The joined block selector, as rrweb gets it. */
  blockSelector?: string;
  /** The live node of an id, or `null`: rrweb's `record.mirror`, read at the time of the event. */
  getNode: (id: number) => Node | null;
  limit?: number;
}

/** What is known of a live node: under a block, under a mask, or neither. */
type Scope = "blocked" | "masked" | "open";

/** The parent of `node` across a shadow root and a document, or `null` at the top of the composed tree. */
function composedParent(node: Node): Node | null {
  if (node.nodeType === FRAGMENT_NODE) return (node as ShadowRoot).host ?? null;
  if (node.nodeType === DOCUMENT_NODE) return (node as Document).defaultView?.frameElement ?? null;
  return node.parentNode;
}

export class ComposedPrivacyFilter {
  private blocked = new Set<number>();
  /** The scope of each live node seen while one event is applied; unset outside `apply`. */
  private memo: Map<Node, Scope> | null = null;
  private readonly limit: number;

  constructor(private readonly options: ComposedPrivacyOptions) {
    this.limit = options.limit ?? BLOCKED_ID_LIMIT;
  }

  /** `event` with the text under a mask masked and what is under a block taken out, or `null` for an event that is only that. */
  apply(event: RrwebEvent): RrwebEvent | null {
    this.memo = new Map();
    try {
      if (event.type === FULL_SNAPSHOT) {
        this.blocked = new Set();
        const root = (event.data as { node?: SerializedNode } | undefined)?.node;
        this.learn(root);
        const clean = root && this.coverMasked(this.blankMetas(root));
        return clean && clean !== root ? { ...event, data: { ...(event.data as object), node: clean } } : event;
      }
      const data = event.data as MutationData | undefined;
      if (event.type !== INCREMENTAL_SNAPSHOT) return event;
      if (data?.source === MUTATION) return this.mutation(event, data);
      // input, mouse interaction, scroll, media: the recorder drops these for a light-DOM block, not across a shadow root,
      // and sends one with id -1 for a node it never serialized, such as an input in a blocked shadow root
      const id = (data as { id?: unknown } | undefined)?.id;
      if (typeof id !== "number") return event;
      return id < 0 || this.isUnknown(id) || this.scopeOf(id) === "blocked" ? null : event;
    } catch {
      // never into the page
      return event;
    } finally {
      this.memo = null;
    }
  }

  private mutation(event: RrwebEvent, data: MutationData): RrwebEvent | null {
    let changed = false;
    let adds = data.adds;
    if (adds?.length) {
      const kept: Add[] = [];
      for (const add of adds) {
        const next = this.add(add);
        if (next !== add) changed = true;
        if (next) kept.push(next);
      }
      if (changed) adds = kept;
    }
    let texts = data.texts;
    if (texts?.length) {
      const kept: NonNullable<MutationData["texts"]> = [];
      let textsChanged = false;
      for (const entry of texts) {
        const scope = this.scopeOf(entry.id);
        if (scope === "blocked") {
          textsChanged = true;
        } else if (scope === "masked" && entry.value && !this.inStyleOrScript(entry.id)) {
          const value = mask(entry.value);
          if (value !== entry.value) textsChanged = true;
          kept.push({ ...entry, value });
        } else {
          kept.push(entry);
        }
      }
      if (textsChanged) {
        changed = true;
        texts = kept;
      }
    }
    let attributes = data.attributes;
    if (attributes?.length) {
      let kept = attributes.filter((entry) => this.scopeOf(entry.id) !== "blocked");
      const blanked = kept.map((entry) => this.coverChange(this.blankAttributes(entry)));
      if (blanked.some((entry, i) => entry !== kept[i])) kept = blanked;
      if (kept.length !== attributes.length || kept.some((entry, i) => entry !== attributes![i])) {
        changed = true;
        attributes = kept;
      }
    }
    if (!changed) return event;
    // An event that only carried what was dropped says nothing any more.
    if (!adds?.length && !texts?.length && !attributes?.length && !data.removes?.length) return null;
    return { ...event, data: { ...data, adds, texts, attributes } };
  }

  /** `add` as it may be kept: itself, a copy with its text masked, or `undefined` for a drop. */
  private add(add: Add): Add | undefined {
    const node = this.visit(add.node, this.scopeOf(add.parentId));
    if (!node) return undefined;
    return node === add.node ? add : { ...add, node };
  }

  /**
   * `node` and its subtree as they may be kept, or `undefined` for a drop. `scope` is what its parent is under. The
   * root of an add is looked up in the mirror (`parent` unset); the nodes below inherit, since rrweb checks a node
   * against the ancestors inside one tree. The ids of every dropped node are remembered for the adds that follow.
   */
  private visit(node: SerializedNode, scope: Scope, parent?: SerializedNode): SerializedNode | undefined {
    const own = parent || node.id === undefined ? "open" : this.scopeOf(node.id);
    const here: Scope = scope === "blocked" || own === "blocked" ? "blocked" : scope === "masked" || own === "masked" ? "masked" : "open";
    if (here === "blocked") {
      this.block(node);
      return undefined;
    }
    if (this.isPlaceholder(node)) this.remember(node.id);
    let result = blankMeta(node);
    if (here === "masked") result = this.coverNode(result);
    if (node.type === SERIALIZED_TEXT && here === "masked" && node.textContent && !this.isStyleOrScript(node, parent)) {
      const textContent = mask(node.textContent);
      if (textContent !== node.textContent) result = { ...result, textContent };
    }
    if (node.childNodes?.length) {
      const children: SerializedNode[] = [];
      let childrenChanged = false;
      for (const child of node.childNodes) {
        const next = this.visit(child, here, node);
        if (next !== child) childrenChanged = true;
        if (next) children.push(next);
      }
      if (childrenChanged) result = { ...result, childNodes: children };
    }
    return result;
  }

  /** `node` with its attributes covered when it is an element. */
  private coverNode(node: SerializedNode): SerializedNode {
    if (node.type !== SERIALIZED_ELEMENT || !node.attributes) return node;
    const tag = (node as { tagName?: string }).tagName?.toLowerCase() ?? "";
    const attributes = coverAttributes(tag, node.attributes.type as string | undefined, node.attributes);
    return attributes === node.attributes ? node : { ...node, attributes };
  }

  /** A full snapshot with the attributes of every element under a mask covered: the same object when there are none. */
  private coverMasked(node: SerializedNode): SerializedNode {
    let result = node;
    if (node.id !== undefined && node.type === SERIALIZED_ELEMENT && this.scopeOf(node.id) === "masked") result = this.coverNode(node);
    if (node.childNodes?.length) {
      let children: SerializedNode[] | undefined;
      node.childNodes.forEach((child, i) => {
        const next = this.coverMasked(child);
        if (next !== child) {
          children ??= node.childNodes!.slice();
          children[i] = next;
        }
      });
      if (children) result = { ...result, childNodes: children };
    }
    return result;
  }

  /** `node` with every token meta below it (itself included) blanked: the same object when there is none. */
  private blankMetas(node: SerializedNode): SerializedNode {
    let result = blankMeta(node);
    if (node.childNodes?.length) {
      let children: SerializedNode[] | undefined;
      node.childNodes.forEach((child, i) => {
        const next = this.blankMetas(child);
        if (next !== child) {
          children ??= node.childNodes!.slice();
          children[i] = next;
        }
      });
      if (children) result = { ...result, childNodes: children };
    }
    return result;
  }

  /** An attribute change of a live element under a mask, covered: the same entry when it is not under one. */
  private coverChange(entry: { id: number; attributes?: Record<string, unknown> }): typeof entry {
    try {
      if (!entry.attributes || this.scopeOf(entry.id) !== "masked") return entry;
      const live = this.options.getNode(entry.id) as Element | null;
      if (!live || live.nodeType !== ELEMENT_NODE) return entry;
      const type = live.getAttribute("type") ?? undefined;
      const attributes = coverAttributes(live.nodeName.toLowerCase(), type, entry.attributes);
      return attributes === entry.attributes ? entry : { ...entry, attributes };
    } catch {
      return entry;
    }
  }

  /**
   * An attribute change of a live `<meta>` that is, or becomes, a token meta, with `content` blanked: the same entry
   * when it is not one. A change of the name alone gets `content: ""` too, so the player's copy loses its value.
   */
  private blankAttributes(entry: { id: number; attributes?: Record<string, unknown> }): typeof entry {
    try {
      const changes = entry.attributes;
      const live = this.options.getNode(entry.id) as Element | null;
      if (!changes || !live || live.nodeType !== ELEMENT_NODE || live.nodeName.toLowerCase() !== "meta") return entry;
      const named = META_NAMING.some((key) => {
        const value = key in changes ? changes[key] : live.getAttribute(key);
        return namesToken(value);
      });
      if (!named) return entry;
      const hasContent = "content" in changes || live.hasAttribute("content");
      if (!hasContent || changes.content === "") return entry;
      return { ...entry, attributes: { ...changes, content: "" } };
    } catch {
      return entry;
    }
  }

  /** The placeholder ids of a full snapshot. */
  private learn(node: SerializedNode | undefined): void {
    if (!node) return;
    if (this.isPlaceholder(node)) this.remember(node.id);
    for (const child of node.childNodes ?? []) this.learn(child);
  }

  private isPlaceholder(node: SerializedNode): boolean {
    return node.type === SERIALIZED_ELEMENT && node.attributes?.rr_width !== undefined && node.attributes?.rr_height !== undefined;
  }

  /** Remembers `node` and everything below it, which are all dropped. */
  private block(node: SerializedNode): void {
    this.remember(node.id);
    for (const child of node.childNodes ?? []) this.block(child);
  }

  private remember(id: number | undefined): void {
    if (id === undefined) return;
    if (this.blocked.size >= this.limit) {
      const oldest = this.blocked.values().next().value as number | undefined;
      if (oldest !== undefined) this.blocked.delete(oldest);
    }
    this.blocked.add(id);
  }

  /** Whether the live node of `id` sits under a block or a mask, itself included, across shadow roots and iframes. */
  private scopeOf(id: number): Scope {
    if (this.blocked.has(id)) return "blocked";
    try {
      const live = this.options.getNode(id);
      if (!live) return "open";
      const { maskSelector, blockSelector } = this.options;
      const memo = this.memo;
      // up to the first node already known (or the top), then down again, so a chain is walked once per event
      const path: Node[] = [];
      let scope: Scope = "open";
      for (let node: Node | null = live; node; node = composedParent(node)) {
        const known = memo?.get(node);
        if (known) {
          scope = known;
          break;
        }
        path.push(node);
      }
      for (let i = path.length - 1; i >= 0; i--) {
        const node = path[i];
        if (scope !== "blocked" && node.nodeType === ELEMENT_NODE) {
          const element = node as Element;
          if (blockSelector && element.matches(blockSelector)) scope = "blocked";
          else if (maskSelector && element.matches(maskSelector)) scope = "masked";
        }
        memo?.set(node, scope);
      }
      return scope;
    } catch {
      return "open";
    }
  }

  /** Whether the mirror has no live node for `id`; a mirror that throws is not "unknown". */
  private isUnknown(id: number): boolean {
    try {
      return !this.options.getNode(id);
    } catch {
      return false;
    }
  }

  private inStyleOrScript(id: number): boolean {
    try {
      const tag = this.options.getNode(id)?.parentNode?.nodeName;
      return tag === "STYLE" || tag === "SCRIPT";
    } catch {
      return false;
    }
  }

  /** Whether a text node's parent is a `<style>` or `<script>`: the parent as serialized, else the live one. */
  private isStyleOrScript(node: SerializedNode, parent?: SerializedNode): boolean {
    const tag = (parent as { tagName?: string } | undefined)?.tagName;
    if (tag !== undefined) return /^(style|script)$/i.test(tag);
    return node.id !== undefined && this.inStyleOrScript(node.id);
  }
}

/** Every character but whitespace is `*`, as rrweb masks the text of a snapshot. */
function mask(text: string): string {
  return text.replace(/\S/g, "*");
}
