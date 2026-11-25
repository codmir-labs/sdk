/**
 * What a visitor picked is not in a recording. rrweb masks the text of an input, but a radio button or a checkbox has no
 * text: rrweb 2.2 stores `checked` in a snapshot or an added node (the property, and the attribute as written), sends
 * `isChecked` and the input's own `value` in an input event, and records a `checked` attribute change as it is. A `maskInputFn`
 * can not hide that, so the events are changed here, after rrweb and before they are kept:
 *
 * - `checked` is taken off every radio button and checkbox (`type` read as rrweb's `getInputType` does: case-blind),
 *   `selected` off every `<option>` when selects are masked, in a snapshot, an added node and an attribute change;
 * - a mouse interaction (click, focus, touch) with such a node is dropped, since it names the pick as well as its state;
 * - an input event of such a node is dropped whole: its `text` is the input's `value`, and a radio group sends one
 *   event for each member, so even an unchecked member names the group's state.
 *
 * Its `value`, `name` and label are page content and stay. The type of a node is known by its id, from the snapshot and
 * the adds, which carry iframes (an attach event) and shadow roots (their nodes are children in the tree) as well. Ids
 * are kept with their parent in a map of at most `limit` elements; at the limit the ones of removed subtrees are
 * dropped (rrweb names only the root of a removal, so the rest is found by its parents), and if it is still full every input is treated as hidden: no
 * `checked`, no input event, until the next full snapshot starts the map again.
 */

import type { RrwebEvent } from "./upload";

const FULL_SNAPSHOT = 2;
const INCREMENTAL_SNAPSHOT = 3;
const MUTATION = 0;
const MOUSE_INTERACTION = 2;
const INPUT = 5;
const DOCUMENT = 0;
const ELEMENT = 2;

/** What a node's state is called: `checked` for a radio button or checkbox, `selected` for an option; 0 for neither. */
const CHECKED = 1;
const SELECTED = 2;

/** How many ids the filter keeps, parents included. */
export const CHOICE_ID_LIMIT = 50_000;

/** Which controls the privacy config hides. */
export interface HiddenChoices {
  radio: boolean;
  checkbox: boolean;
  /** `<option selected>`: on when selects are masked. */
  select: boolean;
}

/** What `privacy` hides: `maskAllInputs`, or the type named in `maskInputTypes` (any case). */
export function hiddenChoices(privacy: { maskAllInputs: boolean; maskInputTypes: string[] }): HiddenChoices {
  const named = privacy.maskInputTypes.map((type) => type.trim().toLowerCase());
  const hidden = (type: string): boolean => privacy.maskAllInputs || named.includes(type);
  return { radio: hidden("radio"), checkbox: hidden("checkbox"), select: hidden("select") };
}

interface Node {
  id?: number;
  type?: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: Node[];
}

interface Entry {
  /** The id of its parent, or -1 for the document of a snapshot. */
  parent: number;
  /** An `<input>`, whose `type` an attribute change can alter. */
  input: boolean;
  kind: number;
  /** Its node was removed: the entry waits for the next sweep. */
  removed?: boolean;
}

/** `attributes` without the state of a choice: `checked` for kind CHECKED, `selected` for kind SELECTED. */
function strip(attributes: Record<string, unknown>, kind: number): Record<string, unknown> {
  const name = kind === CHECKED ? "checked" : "selected";
  if (!kind || !(name in attributes)) return attributes;
  const { [name]: _state, ...rest } = attributes;
  return rest;
}

export class ChoiceFilter {
  private entries = new Map<number, Entry>();
  /** Set when `limit` ids could not be made room for: every input is then treated as hidden. */
  private overflow = false;
  private readonly any: boolean;

  constructor(
    private readonly hide: HiddenChoices,
    private readonly limit: number = CHOICE_ID_LIMIT,
  ) {
    this.any = hide.radio || hide.checkbox || hide.select;
  }

  /** `event` without any choice, or `null` for an event that is only a choice. */
  apply(event: RrwebEvent): RrwebEvent | null {
    if (!this.any || (event.type !== FULL_SNAPSHOT && event.type !== INCREMENTAL_SNAPSHOT)) return event;
    const data = event.data as {
      node?: Node;
      source?: number;
      id: number;
      isChecked?: boolean;
      adds?: Array<{ parentId: number; node: Node }>;
      removes?: Array<{ id: number }>;
      attributes?: Array<{ id: number; attributes: Record<string, unknown> }>;
    };
    if (event.type === FULL_SNAPSHOT) {
      this.entries = new Map();
      this.overflow = false;
      return { ...event, data: { ...data, node: this.visit(data.node as Node, -1) } };
    }
    const entry = this.entries.get(data.id);
    // An id this filter never saw sends `isChecked: true` only as a radio button or a checkbox does.
    if (data.source === INPUT) return this.overflow || (entry ? entry.kind === CHECKED : data.isChecked) ? null : event;
    // A click, focus or touch on a choice names it as well as its state does; at the limit no node is known.
    if (data.source === MOUSE_INTERACTION) return this.overflow || entry?.kind === CHECKED ? null : event;
    if (data.source !== MUTATION) return event;

    for (const { id } of data.removes ?? []) {
      const gone = this.entries.get(id);
      if (gone) gone.removed = true;
    }
    const adds = data.adds?.map((add) => ({ ...add, node: this.visit(add.node, add.parentId) }));
    const attributes = data.attributes
      ?.map((item) => ({ ...item, attributes: this.change(item.id, item.attributes) }))
      .filter((item) => Object.keys(item.attributes).length > 0);
    return { ...event, data: { ...data, adds, attributes } };
  }

  /** The attributes of an attribute change of node `id` without its choice. */
  private change(id: number, attributes: Record<string, unknown>): Record<string, unknown> {
    const entry = this.entries.get(id);
    if (entry?.input && "type" in attributes) entry.kind = this.kindOf("input", attributes.type);
    // A node this filter never saw, or any node at the limit, is taken for a choice if its attribute is one.
    const unknown = !entry || this.overflow;
    const checked = entry?.kind === CHECKED || (unknown && (this.hide.radio || this.hide.checkbox));
    const selected = entry?.kind === SELECTED || (unknown && this.hide.select);
    return strip(strip(attributes, checked ? CHECKED : 0), selected ? SELECTED : 0);
  }

  private kindOf(tag: string, type: unknown): number {
    const lower = String(type).toLowerCase();
    if (tag === "option") return this.hide.select ? SELECTED : 0;
    return tag === "input" && (lower === "radio" ? this.hide.radio : lower === "checkbox" && this.hide.checkbox) ? CHECKED : 0;
  }

  /** `node` and its subtree without a choice, learning the ids on the way. Only documents and elements are kept. */
  private visit(node: Node, parent: number): Node {
    if (node.type !== ELEMENT && node.type !== DOCUMENT) return node;
    const tag = (node.tagName ?? "").toLowerCase();
    // At the limit no type is known: every input and option is treated as a choice.
    const kind = this.overflow ? (tag === "input" ? CHECKED : tag === "option" ? SELECTED : 0) : this.kindOf(tag, node.attributes?.type);
    this.remember(node.id as number, { parent, input: tag === "input", kind });
    return {
      ...node,
      ...(node.attributes && { attributes: strip(node.attributes, kind) }),
      ...(node.childNodes && { childNodes: node.childNodes.map((child) => this.visit(child, node.id as number)) }),
    };
  }

  private remember(id: number, entry: Entry): void {
    if (!this.overflow && this.entries.size >= this.limit && !this.entries.has(id)) {
      this.sweep();
      if (this.entries.size >= this.limit) {
        this.overflow = true;
        this.entries = new Map();
      }
    }
    if (!this.overflow) this.entries.set(id, entry);
  }

  /** Drops the ids that are removed or sit below one that is: the subtrees of removed nodes. */
  private sweep(): void {
    const dead = new Map<number, boolean>();
    const isDead = (id: number): boolean => {
      const entry = this.entries.get(id);
      // A parent this filter never saw is taken for a root that is still there.
      if (!entry) return false;
      // Set false first: a loop of parents ends here.
      if (!dead.has(id)) dead.set(id, false).set(id, !!entry.removed || isDead(entry.parent));
      return dead.get(id) as boolean;
    };
    // Decided first, deleted after: a deleted parent would read as one that was never seen.
    for (const id of Array.from(this.entries.keys()).filter(isDead)) this.entries.delete(id);
  }
}
