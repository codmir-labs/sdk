// @vitest-environment jsdom
/**
 * The CommonJS build has no shared chunks: `dist/index.cjs` and `dist/browser/index.cjs` each hold their own copy of the
 * modules, so only the `globalThis` flags can keep a page that calls both `init`s at one event per page error. Loads the
 * two built files together in a page. Skips without a build; CI runs this file after one.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom replaces `URL`, which then refuses a `file:` address: the path comes from the test file's directory.
const root = `${resolve(__dirname, "../../..")}/`;
const FILES = ["dist/index.cjs", "dist/browser/index.cjs", "dist/overseer/index.cjs"];
const hasDist = FILES.every((file) => existsSync(`${root}${file}`));

interface Entry {
  init(config: Record<string, unknown>): void;
  close(): unknown;
  flush(): Promise<boolean>;
}

const FLAGS = [Symbol.for("codmir.page-errors.error"), Symbol.for("codmir.page-errors.unhandledrejection")];
const slots = globalThis as Record<symbol, unknown>;
let bodies: Array<{ events: Array<{ type: string; event: { message: string } }> }>;

/** Every built file loaded afresh, as a page that bundles each entry on its own gets them. */
function loadBuilt(): { root: Entry; browser: Entry; overseer: Entry } {
  const require = createRequire(`${root}package.json`);
  const load = (file: string): Entry => {
    delete require.cache[require.resolve(`${root}${file}`)];
    return require(`${root}${file}`);
  };
  return { root: load(FILES[0]), browser: load(FILES[1]), overseer: load(FILES[2]) };
}

const messages = () => bodies.flatMap((b) => b.events).filter((e) => e.type === "error").map((e) => e.event.message);
const throwError = (message: string) => window.dispatchEvent(new ErrorEvent("error", { error: new Error(message), message }));
const reject = (message: string) => {
  const event = new Event("unhandledrejection") as Event & { reason?: unknown };
  event.reason = new Error(message);
  window.dispatchEvent(event);
};
/** A page listener of its own, so jsdom does not report the error nobody captures. */
const absorb = (e: Event) => e.preventDefault();
const config = { clientKey: "osk_test", release: "1.0.0" };

describe.skipIf(!hasDist)("the built root and browser files on one page", () => {
  beforeEach(() => {
    bodies = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ received: true }), { status: 200 });
      }),
    );
    window.addEventListener("error", absorb);
  });
  afterEach(() => {
    window.removeEventListener("error", absorb);
    for (const flag of FLAGS) delete slots[flag];
    vi.unstubAllGlobals();
  });

  for (const order of ["root first", "browser first"]) {
    it(`${order}: one event per uncaught error and per unhandled rejection, and none after the close`, async () => {
      const built = loadBuilt();
      // two separate copies of the code: nothing but the flags on `globalThis` joins them
      expect(built.root).not.toBe(built.browser);
      const [first, second] = order === "root first" ? [built.root, built.browser] : [built.browser, built.root];
      first.init(config);
      second.init(config);
      throwError("uncaught");
      reject("rejected");
      await first.flush();
      expect(messages().sort()).toEqual(["rejected", "uncaught"]);

      await first.close();
      await second.close();
      for (const flag of FLAGS) expect(slots[flag]).toBeUndefined();
      bodies = [];
      throwError("after the close");
      reject("after the close");
      await first.flush();
      expect(messages()).toEqual([]);
    });
  }

  it("a close of the core file ends the root's listeners, and the browser file installs its own after it, once", async () => {
    const built = loadBuilt();
    built.root.init(config);
    await built.overseer.close();
    for (const flag of FLAGS) expect(slots[flag]).toBeUndefined();
    throwError("after the core close");
    await built.root.flush();
    expect(messages()).toEqual([]);

    built.browser.init(config);
    throwError("browser error");
    reject("browser rejection");
    await built.browser.flush();
    expect(messages().sort()).toEqual(["browser error", "browser rejection"]);
    await built.browser.close();
  });
});
