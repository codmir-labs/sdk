/**
 * CSL-5640: a URL as an event field keeps its origin and path and nothing after them. A query string or fragment can hold
 * `access_token=`, a reset code or an OAuth `#access_token=`, and a breadcrumb or transaction would carry it with every error.
 * Browser-safe: no Node import. Same rule as the request scope's `requestScopeFrom` (CSL-5637).
 */

/**
 * Origin and path of an absolute URL (credentials dropped with the query and fragment). A relative URL keeps its path;
 * with `base` (the page's own address) it is resolved first, so `?page=2` or `../x` still names a path. Input that cannot
 * be parsed is cut at the first `?` or `#`. A non-string (a `URL` object, `null`, `undefined`) is stringified or becomes "".
 */
export function scrubUrl(raw: unknown, base?: string): string {
  if (raw === null || raw === undefined) return "";
  const text = typeof raw === "string" ? raw : String(raw);
  const cut = (s: string): string => s.split(/[?#]/)[0] ?? "";
  try {
    const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(text);
    if (absolute || base) {
      const u = new URL(text, absolute ? undefined : base);
      return `${u.origin === "null" ? `${u.protocol}//` : u.origin}${u.pathname}`;
    }
  } catch {
    // fall through to the cut
  }
  return cut(text);
}
