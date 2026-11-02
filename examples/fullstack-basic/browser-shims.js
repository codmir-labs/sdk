// Stand-ins for the two Node globals that @codmir/sdk 2.2.0's browser chunks still reference.
// `noExternal: ["nanoid"]` in the SDK's tsup.config.ts bundles nanoid's Node build, which does
// `import { webcrypto } from "crypto"` and `Buffer.allocUnsafe`. Real browsers have neither.
// Remove this file and the `alias`/`inject` in server.mjs once the SDK bundles nanoid's browser build.
export const webcrypto = globalThis.crypto;
export const Buffer = { allocUnsafe: (size) => new Uint8Array(size) };
