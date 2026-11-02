/** W3C Trace Context `traceparent`: `00-<trace-id 32 hex>-<parent-id 16 hex>-<flags 2 hex>`. */

export interface TraceparentData {
  traceId: string;
  /** The caller's span id: the parent of whatever this process opens. */
  spanId: string;
  sampled: boolean;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

type RandomFill = (buf: Uint8Array) => void;
let nodeFill: RandomFill | undefined;

/**
 * Registers a random source for runtimes without `globalThis.crypto` (Node 18). `@codmir/sdk/express` passes
 * `crypto.randomFillSync`; a static `node:crypto` import here would break browser bundles.
 */
export function setRandomFill(fill: RandomFill | undefined): void {
  nodeFill = fill;
}

export function fillRandom(buf: Uint8Array): void {
  const web = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => unknown } }).crypto;
  if (web?.getRandomValues) {
    web.getRandomValues(buf);
    return;
  }
  if (nodeFill) {
    nodeFill(buf);
    return;
  }
  // Node 20.16+/22.3+ without a global crypto still exposes its builtins this way.
  const getBuiltin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule;
  const nodeCrypto = getBuiltin?.("node:crypto") as { randomFillSync?: RandomFill } | undefined;
  if (nodeCrypto?.randomFillSync) {
    nodeCrypto.randomFillSync(buf);
    return;
  }
  // Last resort: ids stay well-formed and unique enough to correlate, but are not cryptographically random.
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  fillRandom(buf);
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
