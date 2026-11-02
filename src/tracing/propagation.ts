/** W3C Trace Context `traceparent`: `00-<trace-id 32 hex>-<parent-id 16 hex>-<flags 2 hex>`. */

export interface TraceparentData {
  traceId: string;
  /** The caller's span id: the parent of whatever this process opens. */
  spanId: string;
  sampled: boolean;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

/** 32 lowercase hex characters from crypto random bytes; never all zero. */
export function generateTraceId(): string {
  let id = randomHex(16);
  while (/^0+$/.test(id)) id = randomHex(16);
  return id;
}

/** 16 lowercase hex characters from crypto random bytes; never all zero. */
export function generateSpanId(): string {
  let id = randomHex(8);
  while (/^0+$/.test(id)) id = randomHex(8);
  return id;
}

/** Parses a header value; null when it is absent or not a valid version-00-shaped traceparent. */
export function parseTraceparent(header: string | null | undefined): TraceparentData | null {
  if (!header) return null;
  const m = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!m) return null;
  const [, version, traceId, spanId, flags] = m;
  if (version === "ff") return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}
