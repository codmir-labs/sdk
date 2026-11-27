/**
 * Route breadcrumbs for the Next.js and Remix browser setups: the page that loaded, `pushState`, `replaceState` and
 * `popstate`. A page without `location`, `history` or `document` (React Native, a worker) gets no breadcrumb, no throw.
 */

import { addBreadcrumb } from "./index";
import { listen, patch, type Stop } from "./lifecycle";
import { routeFragment, scrubUrl } from "./url-scrub";

/** The page's address, or `undefined` where there is no `location`. */
const here = (): string | undefined => (typeof window === "undefined" ? undefined : window.location?.href);

/** The page's path and its route fragment (`/app#/settings`): what a message names. A hash that is no route is left out. */
const page = (): string => `${window.location.pathname}${routeFragment(window.location.hash)}`;

/** Starts the route breadcrumbs; the returned function ends them. */
export function trackNavigation(): Stop {
  const href = here();
  if (href !== undefined) {
    const referrer = typeof document === "undefined" ? "" : document.referrer;
    addBreadcrumb({
      category: "navigation",
      message: page(),
      data: { from: referrer ? scrubUrl(referrer) : undefined, to: scrubUrl(href) },
    });
  }
  const history = typeof window === "undefined" ? undefined : window.history;
  const move = (message: "pushState" | "replaceState") => (original: History["pushState"]): History["pushState"] =>
    function (this: History, ...args) {
      const result = original.apply(this, args);
      const now = here();
      if (now !== undefined) addBreadcrumb({ category: "navigation", message: `${message} ${page()}`, data: { to: scrubUrl(args[2], now) } });
      return result;
    };
  const stops = [
    patch(history, "pushState", move("pushState")),
    patch(history, "replaceState", move("replaceState")),
    listen(typeof window === "undefined" ? undefined : window, "popstate", () => {
      const now = here();
      if (now !== undefined) addBreadcrumb({ category: "navigation", message: `popstate ${page()}`, data: { to: scrubUrl(now) } });
    }),
  ];
  return () => stops.forEach((stop) => stop());
}
