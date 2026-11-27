import { isSecretKey } from "./secret-keys";

/**
 * The one place that decides what of a user an event sends. The server keeps the user's `id` and counts affected users
 * by the id, else the email, else the username; it never reads `ip_address`.
 *
 * Off (`sendDefaultPii` false): `id` and `username`, and `email` only when there is no `id`. Every other key is dropped.
 * On: every key except one that names a secret ({@link isSecretKey}).
 * Either way the result is a new object, the app's own is never changed, and `undefined` stands for "no user".
 */
export function userForWire(user: unknown, sendDefaultPii: boolean): Record<string, unknown> | undefined {
  if (!user || typeof user !== "object" || Array.isArray(user)) return undefined;
  const out: Record<string, unknown> = {};
  try {
    const own = user as Record<string, unknown>;
    if (sendDefaultPii) {
      for (const key of Object.keys(own)) {
        if (!isSecretKey(key) && own[key] !== undefined) out[key] = own[key];
      }
    } else {
      const has = (v: unknown): boolean => v !== undefined && v !== null && v !== "";
      if (has(own.id)) out.id = own.id;
      if (has(own.username)) out.username = own.username;
      if (!has(own.id) && has(own.email)) out.email = own.email;
    }
  } catch {
    // a user object with a throwing getter has no user to send
    return undefined;
  }
  return Object.keys(out).length ? out : undefined;
}
