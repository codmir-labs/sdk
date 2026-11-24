/**
 * Privacy config for the rrweb recorder (CSL-5612). Inputs are masked by default, and a password field is masked
 * whatever the config says: `maskInputOptions.password` is forced on after the user's options are applied.
 */

export interface ReplayPrivacyConfig {
  /** Mask the value of every input, textarea and select. Default true. */
  maskAllInputs: boolean;
  /** Input types masked even when `maskAllInputs` is false. `password` is always masked. */
  maskInputTypes: string[];
  /** Text of matching elements (and their descendants) is replaced by `*`. Default `[data-private]`, `.private`. */
  maskSelectors: string[];
  /** Matching subtrees are not recorded at all, only a same-size placeholder. Default `[data-codmir-block]`. */
  blockSelectors: string[];
  /** Input events on matching elements are not recorded. */
  ignoreSelectors: string[];
}

export const DEFAULT_PRIVACY: ReplayPrivacyConfig = {
  maskAllInputs: true,
  maskInputTypes: ["password", "credit-card"],
  maskSelectors: ["[data-private]", ".private"],
  // `[data-block-replay]` is the pre-rrweb attribute; still honoured so existing markup stays private.
  blockSelectors: ["[data-codmir-block]", "[data-block-replay]"],
  ignoreSelectors: [],
};

/** The subset of rrweb's `recordOptions` this module sets. */
export interface RrwebPrivacyOptions {
  maskAllInputs: boolean;
  maskInputOptions: Record<string, boolean>;
  maskTextSelector?: string;
  blockSelector?: string;
  ignoreSelector?: string;
  maskInputFn: (text: string) => string;
}

/** What every masked, non-empty input value is recorded as, whatever its length. */
const INPUT_MASK = "*".repeat(8);

/**
 * What `maskAllInputs` masks: the list rrweb 2.2.0 masks for its own `maskAllInputs: true`, then `hidden` and `file`,
 * which that list leaves out, so a hidden field's value (a CSRF token, an id) and a picked file's name would record as
 * they are. rrweb ignores `maskInputOptions` while its own flag is on, so it gets this list with the flag off.
 */
const EVERY_INPUT = [
  "color", "date", "datetime-local", "email", "month", "number", "range", "search", "tel", "text", "time", "url",
  "week", "textarea", "select", "password",
  "hidden", "file",
];

const join = (selectors: string[]): string | undefined => {
  const parts = selectors.map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
};

/** Merges a partial privacy config over the defaults. Lists replace, they are not concatenated. */
export function resolvePrivacy(privacy?: Partial<ReplayPrivacyConfig>): ReplayPrivacyConfig {
  return { ...DEFAULT_PRIVACY, ...privacy };
}

export function toRrwebPrivacy(privacy: ReplayPrivacyConfig): RrwebPrivacyOptions {
  const maskInputOptions: Record<string, boolean> = {};
  for (const type of privacy.maskInputTypes) maskInputOptions[type] = true;
  if (privacy.maskAllInputs) for (const type of EVERY_INPUT) maskInputOptions[type] = true;
  // Never negotiable: a password is masked even with `maskAllInputs: false` and an empty `maskInputTypes`.
  maskInputOptions.password = true;

  return {
    // Off whatever the config says: `maskInputOptions` above already holds every input when `maskAllInputs` is on.
    maskAllInputs: false,
    maskInputOptions,
    maskTextSelector: join(privacy.maskSelectors),
    blockSelector: join(privacy.blockSelectors),
    ignoreSelector: join(privacy.ignoreSelectors),
    // rrweb calls this only for a value it has decided to mask; a fixed length leaks nothing about the secret, not even
    // its length. An empty value stays empty.
    maskInputFn: (text) => (text ? INPUT_MASK : ""),
  };
}
