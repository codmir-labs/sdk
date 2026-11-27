/**
 * The words that name a secret, written once. The log redactor (`src/logs/redact.ts`) reads `name=value` pairs in a text
 * with {@link SECRET_WORDS}; the context scrubber (`sanitize-extra.ts`) judges the keys of an object with them and adds a
 * few of its own. No import, so any entry can take it.
 */

/**
 * Regular expression source, one alternation: a name that holds one of these words is a secret's. `auth` is not `author`
 * or `authority` (`authorization` and `authorize` stay secrets). Matched without case.
 */
export const SECRET_WORDS = "token|secret|password|passwd|pwd|api[-_]?key|auth(?!or(?!i[sz]))|signature|session|credential";

/** Words only a key can be judged by: a cookie, a private key, a card number or its code, a JWT. */
const KEY_ONLY_WORDS = "cookie|private[-_]?key|card[-_]?number|cvv|cvc|jwt";

const SECRET_KEY = new RegExp(`${SECRET_WORDS}|${KEY_ONLY_WORDS}`, "i");

/** `sid` and `sig` count only as the whole key or a whole part of it (split by `-`, `_` or a lower-to-upper change): `side` and `signal` are no secrets. */
const SHORT_PARTS = new Set(["sid", "sig"]);

/** True when a key of an object names a secret. */
export function isSecretKey(key: string): boolean {
  if (SECRET_KEY.test(key)) return true;
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/)
    .some((part) => SHORT_PARTS.has(part.toLowerCase()));
}
