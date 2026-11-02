/**
 * Web vitals for the pageload transaction (CSL-5587): LCP, CLS and INP from `PerformanceObserver`, no dependency.
 *
 * Values are a snapshot. The pageload transaction ends when the page goes idle, usually before the browser
 * finalizes INP and CLS (both settle when the page is hidden), so `read()` returns what is known at that moment.
 * A later worst interaction or layout shift is not reported; a better design (a follow-up) is a separate
 * `web-vitals` transaction sent on hide. Units follow the server schema: milliseconds, `cls` unitless.
 */

export interface WebVitals {
  lcp?: number;
  inp?: number;
  cls?: number;
}

export interface WebVitalsObserver {
  /** What has been observed so far. Keys with no data are absent. */
  read(): WebVitals;
  stop(): void;
}

interface VitalsEntry {
  entryType: string;
  startTime: number;
  duration: number;
  interactionId?: number;
  value?: number;
  hadRecentInput?: boolean;
}

/** A layout-shift session window ends after a 1 s gap or 5 s total, per the standard CLS definition. */
const CLS_GAP_MS = 1000;
const CLS_WINDOW_MS = 5000;
const INP_DURATION_THRESHOLD = 40;

export function observeWebVitals(): WebVitalsObserver {
  const none: WebVitalsObserver = { read: () => ({}), stop: () => {} };
  if (typeof PerformanceObserver === "undefined" || typeof document === "undefined") return none;

  let supported: readonly string[] = [];
  try {
    supported = PerformanceObserver.supportedEntryTypes ?? [];
  } catch {
    return none;
  }

  let lcp: number | undefined;
  let lcpFinal = false;

  let cls: number | undefined;
  let windowValue = 0;
  let windowStart = 0;
  let windowLast = 0;

  const interactions = new Map<number | string, number>();

  const onEntry = (entry: VitalsEntry): void => {
    switch (entry.entryType) {
      case "largest-contentful-paint":
        if (!lcpFinal) lcp = entry.startTime;
        break;
      case "layout-shift": {
        if (entry.hadRecentInput || typeof entry.value !== "number") break;
        if (windowValue > 0 && (entry.startTime - windowLast > CLS_GAP_MS || entry.startTime - windowStart > CLS_WINDOW_MS)) {
          windowValue = 0;
        }
        if (windowValue === 0) windowStart = entry.startTime;
        windowValue += entry.value;
        windowLast = entry.startTime;
        cls = Math.max(cls ?? 0, windowValue);
        break;
      }
      case "event":
      case "first-input": {
        const id = entry.interactionId ? entry.interactionId : entry.entryType === "first-input" ? `first-input` : undefined;
        if (id === undefined) break;
        if (entry.entryType === "event" && entry.duration < INP_DURATION_THRESHOLD) break;
        interactions.set(id, Math.max(interactions.get(id) ?? 0, entry.duration));
        break;
      }
    }
  };

  const observers: PerformanceObserver[] = [];
  const watch = (type: string, extra: Record<string, unknown> = {}): void => {
    if (!supported.includes(type)) return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) onEntry(entry as unknown as VitalsEntry);
      });
      observer.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      observers.push(observer);
    } catch {
      // An entry type the browser lists but refuses (or an unexpected option): skip that vital only.
    }
  };

  watch("largest-contentful-paint");
  watch("layout-shift");
  watch("event", { durationThreshold: INP_DURATION_THRESHOLD });
  watch("first-input");

  // LCP stops counting at the first input or when the page is hidden.
  const finalizeLcp = (): void => {
    lcpFinal = true;
  };
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") finalizeLcp();
  };
  const inputEvents = ["keydown", "click", "pointerdown"] as const;
  for (const name of inputEvents) document.addEventListener(name, finalizeLcp, { once: true, capture: true });
  document.addEventListener("visibilitychange", onVisibility);

  return {
    read(): WebVitals {
      // Drain what the observers have queued but not yet delivered.
      for (const observer of observers) {
        try {
          for (const entry of observer.takeRecords()) onEntry(entry as unknown as VitalsEntry);
        } catch {
          // takeRecords is optional in stubs and old engines.
        }
      }
      const out: WebVitals = {};
      if (lcp !== undefined) out.lcp = lcp;
      if (cls !== undefined) out.cls = cls;
      if (interactions.size > 0) {
        const sorted = [...interactions.values()].sort((a, b) => b - a);
        // p98: the worst interaction for under 50 interactions, then one further down per 50.
        out.inp = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 50))];
      }
      return out;
    },
    stop(): void {
      for (const observer of observers) {
        try {
          observer.disconnect();
        } catch {
          // already gone
        }
      }
      observers.length = 0;
      for (const name of inputEvents) document.removeEventListener(name, finalizeLcp, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
