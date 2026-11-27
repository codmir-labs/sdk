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
 *   as rrweb masks it in a snapshot (the text of a `<style>` or `<script>` is not text and stays).
 *
 * Fail closed: a node the mirror does not know is kept as rrweb sent it, and nothing here throws into the page. An event
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

interface MutationData {
  source?: number;
  adds?: Add[];
  texts?: Array<{ id: number; value: string | null }>;
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
  private readonly limit: number;

  constructor(private readonly options: ComposedPrivacyOptions) {
    this.limit = options.limit ?? BLOCKED_ID_LIMIT;
  }

  /** `event` with the text under a mask masked and what is under a block taken out, or `null` for an event that is only that. */
  apply(event: RrwebEvent): RrwebEvent | null {
    try {
      if (event.type === FULL_SNAPSHOT) {
        this.blocked = new Set();
        this.learn((event.data as { node?: SerializedNode } | undefined)?.node);
        return event;
      }
      const data = event.data as MutationData | undefined;
      if (event.type !== INCREMENTAL_SNAPSHOT || data?.source !== MUTATION) return event;
      return this.mutation(event, data);
    } catch {
      // never into the page
      return event;
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
    if (!changed) return event;
    // An event that only carried what was dropped says nothing any more.
    const empty = !adds?.length && !texts?.length;
    const rest = event.data as { removes?: unknown[]; attributes?: unknown[] };
    if (empty && !rest.removes?.length && !rest.attributes?.length) return null;
    return { ...event, data: { ...data, adds, texts } };
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
    let result = node;
    if (node.type === SERIALIZED_TEXT && here === "masked" && node.textContent && !this.isStyleOrScript(node, parent)) {
      const textContent = mask(node.textContent);
      if (textContent !== node.textContent) result = { ...node, textContent };
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
      let masked = false;
      for (let node: Node | null = live; node; node = composedParent(node)) {
        if (node.nodeType !== ELEMENT_NODE) continue;
        const element = node as Element;
        if (blockSelector && element.matches(blockSelector)) return "blocked";
        if (maskSelector && element.matches(maskSelector)) masked = true;
      }
      return masked ? "masked" : "open";
    } catch {
      return "open";
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
