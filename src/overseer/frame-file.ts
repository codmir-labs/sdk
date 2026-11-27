/**
 * The file of a stack frame as the fingerprint reads it. The frames that are sent keep the file as it is; only the
 * group key uses this, so one bug is one group wherever and however the code was served or installed.
 *
 * Steps, in order:
 * - Backslashes become `/`; Hermes' `address at ` prefix and `file://` are dropped.
 * - An http(s) URL keeps its path only: no scheme, host, query or fragment.
 * - An install prefix becomes `app:///`: the iOS app container (`/Bundle/Application/<id>/<Name>.app/`), an Android
 *   app-data directory (`/data/user/0/<package>/`, `/data/data/<package>/`) and an `app.asar/` prefix.
 * - A path inside the app root (`process.cwd()` when `init()` ran) is made relative to it.
 * - A `/releases/<id>/` directory segment becomes `/releases/<release>/`.
 * - A content hash in the file name is removed, just before the extension. `.chunk`, `.bundle` and `.min` before `.js`,
 *   `.mjs` or `.cjs` are part of the extension (`main.3f2a9c1e.chunk.js` gives `main.chunk.js`). A hash is either
 *   a `.` or `-` segment of 8 or more characters made of hex digits or of base36 with at least one digit and one
 *   letter (`main.3f2a9c1e.js` gives `main.js`), or Rollup's: exactly the last 8 characters of the name, preceded by
 *   `-` or `.`, made of `A-Z a-z 0-9 _ -` and holding at least one digit or one upper-case letter
 *   (`index-Dx_9lC-p.js` gives `index.js`). A plain word (`index-header.js`, `app-settings.js`) is never removed.
 */

let appRoot: string | undefined;

/** The app root a Node absolute path is made relative to; undefined (or `/`) means none. */
export function setAppRoot(root: string | undefined): void {
  const r = root?.replace(/\\/g, "/").replace(/\/+$/, "");
  appRoot = r || undefined;
}

const INSTALL_PREFIXES: readonly RegExp[] = [
  /^.*?\/(?:Bundle|Data)\/Application\/[^/]+\/(?:[^/]+\.app\/)?/,
  /^\/data\/(?:user\/\d+|data)\/[^/]+\//,
  /^.*?\/app\.asar(?:\.unpacked)?\//,
];

const EXTENSION = /((?:\.(?:chunk|bundle|min))*\.[cm]?js|\.[A-Za-z0-9]+)$/;
const HASH_SEGMENT = /^(.+)[.-]([A-Za-z0-9]{8,})$/;
const ROLLUP_HASH = /^(.+)[.-]([A-Za-z0-9_-]{8})$/;

const isHash = (s: string): boolean => /^[0-9a-f]+$/i.test(s) || (/\d/.test(s) && /[a-z]/i.test(s));
const isRollupHash = (s: string): boolean => /[\dA-Z]/.test(s);

function dropHash(path: string): string {
  const at = path.lastIndexOf("/") + 1;
  const name = path.slice(at);
  const ext = EXTENSION.exec(name);
  if (!ext) return path;
  const stem = name.slice(0, ext.index);
  const m = HASH_SEGMENT.exec(stem);
  if (m && isHash(m[2]!)) return path.slice(0, at) + m[1]! + ext[1]!;
  const r = ROLLUP_HASH.exec(stem);
  return r && isRollupHash(r[2]!) ? path.slice(0, at) + r[1]! + ext[1]! : path;
}

export function normalizeFrameFile(filename: string): string {
  let f = filename.replace(/\\/g, "/").replace(/^address at /, "");
  const http = /^https?:\/\/[^/?#]*/i.exec(f);
  if (http) {
    f = f.slice(http[0].length).split(/[?#]/)[0]!;
    if (!f.startsWith("/")) f = `/${f}`;
  } else {
    f = f.replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:\/)/, "$1");
    const prefix = INSTALL_PREFIXES.find((p) => p.test(f));
    if (prefix) f = `app:///${f.replace(prefix, "")}`;
    else if (appRoot && f.startsWith(`${appRoot}/`)) f = f.slice(appRoot.length + 1);
  }
  return dropHash(f.replace(/(^|\/)releases\/[^/]+\//, "$1releases/<release>/"));
}
