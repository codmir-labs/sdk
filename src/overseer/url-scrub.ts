/**
 * A URL as an event field keeps its origin and path and nothing after them. A query string or fragment can hold
 * `access_token=`, a reset code or an OAuth `#access_token=`, and a breadcrumb or transaction would carry it with every error.
 * The one exception is a route fragment (`#/settings`, `#!/users/42`): a hash router keeps its page there, so it stays, cut
 * at its own `?`. Every other fragment goes. Browser-safe: no Node import. Same rule as the request scope's `requestScopeFrom`.
 */

/** The longest string `scrubUrl` returns; a longer result is cut here. */
export const MAX_URL_LENGTH = 1024;

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

const TRAILING = ".,;:!)]}";

const clip = (s: string): string => (s.length > MAX_URL_LENGTH ? s.slice(0, MAX_URL_LENGTH) : s);

/**
 * The route a fragment holds: `#/a/b` or `#!/a/b` without its own query (or a second `#`), else "". Anything else
 * (`#access_token=…`, `#id_token=…`, `#section-2`) is not a route and is dropped. Path segments are kept as they are, as in a path.
 */
export function routeFragment(hash: string): string {
  if (!/^#!?\//.test(hash)) return "";
  const end = hash.slice(1).search(/[?#]/);
  return end < 0 ? hash : hash.slice(0, end + 1);
}

/** The text from the first `#` on, or "". */
const fragmentOf = (s: string): string => {
  const i = s.indexOf("#");
  return i < 0 ? "" : s.slice(i);
};

/** The text up to the first `?` or `#`, without a `userinfo@` after a leading `//` (or `scheme://`). */
function cut(s: string): string {
  const head = s.split(/[?#]/)[0] ?? "";
  return head.replace(/^((?:[A-Za-z][A-Za-z0-9+.-]*:)?[/\\]{2})[^/\\]*@/, "$1");
}

/**
 * What a URL is: origin and path of a hierarchical one (credentials and query dropped; a fragment dropped unless it is a route, see `routeFragment`), a relative URL keeps
 * its path. A `data:` URL keeps its media type and the size of its payload, `blob:` the scrubbed URL inside it, `about:`
 * its path, and any other scheme without `//` (`javascript:`, `mailto:`) only the scheme, since the rest can be code or an address.
 * With `base` (the page's own address) a relative or protocol-relative URL is resolved first, so `?page=2` or `../x` still
 * names a path. Input that cannot be parsed is cut at the first `?` or `#`, and loses a `userinfo@` after `//`. Surrounding
 * whitespace is ignored, the result is at most `MAX_URL_LENGTH` characters, and a non-string (a `URL` object, `null`,
 * `undefined`) is stringified or becomes "".
 */
export function scrubUrl(raw: unknown, base?: string): string {
  if (raw === null || raw === undefined) return "";
  const text = (typeof raw === "string" ? raw : String(raw)).trim();
  const scheme = SCHEME.exec(text)?.[1];
  if (scheme === undefined) return clip(relative(text, base));
  const name = scheme.toLowerCase();
  const rest = text.slice(scheme.length + 1);
  if (name === "data") {
    const comma = rest.indexOf(",");
    return clip(comma < 0 ? `data:[${rest.length} bytes]` : `data:${rest.slice(0, comma)},[${rest.length - comma - 1} bytes]`);
  }
  if (name === "blob") return clip(`blob:${/^blob:/i.test(rest) ? "" : scrubUrl(rest)}`);
  if (name === "about") return clip(`about:${cut(rest)}`);
  if (!rest.startsWith("//")) return `${name}:`;
  try {
    const u = new URL(text);
    return clip(`${u.origin === "null" ? `${u.protocol}//` : u.origin}${u.pathname}${routeFragment(u.hash)}`);
  } catch {
    return clip(cut(text) + routeFragment(fragmentOf(text)));
  }
}

function relative(text: string, base: string | undefined): string {
  if (base) {
    try {
      const u = new URL(text, base);
      return `${u.origin === "null" ? `${u.protocol}//` : u.origin}${u.pathname}${routeFragment(u.hash)}`;
    } catch {
      // fall through to the cut
    }
  }
  return cut(text) + routeFragment(fragmentOf(text));
}

/**
 * Replaces every URL in free text (an error message, say) by its `scrubUrl` form: the run of characters from `//`, with
 * the scheme before it when there is one. The rest of the text stays. One pass, linear in the text.
 */
export function scrubUrlsIn(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/\/\/[^\s"'<>]*/g)) {
    let start = m.index;
    if (text[start - 1] === ":") {
      let i = start - 1;
      while (i > last && /[A-Za-z0-9+.-]/.test(text[i - 1]!)) i--;
      while (i < start - 1 && !/[A-Za-z]/.test(text[i]!)) i++;
      if (i < start - 1) start = i;
    }
    const url = text.slice(start, m.index + m[0].length);
    // Trailing punctuation belongs to the sentence, not the URL; a backward loop, since a regex here backtracks quadratically.
    let end = url.length;
    while (end > 0 && TRAILING.includes(url[end - 1]!)) end--;
    out += text.slice(last, start) + scrubUrl(url.slice(0, end)) + url.slice(end);
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}
