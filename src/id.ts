import { fillRandom } from "./tracing/propagation";

const ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/**
 * A 21-character URL-safe id from crypto random bytes: the same length and alphabet nanoid produced here before
 * this helper. The alphabet has 64 symbols, so `byte & 63` is uniform. Replaces nanoid because tsup inlined nanoid's
 * Node build (`import "crypto"`, `Buffer`) into the browser entries, which no browser bundler can resolve (CSL-5616).
 */
export function generateId(size = 21): string {
  const bytes = new Uint8Array(size);
  fillRandom(bytes);
  let id = "";
  for (let i = 0; i < size; i++) id += ALPHABET[bytes[i] & 63];
  return id;
}
