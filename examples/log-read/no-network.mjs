// Preloaded with `node --import ./no-network.mjs`: any attempt to open a socket, resolve a name or call fetch is a failure.
import dns from "node:dns";
import net from "node:net";

const refuse = (what) => () => {
  process.stderr.write(`NETWORK ATTEMPT: ${what}\n`);
  process.exitCode = 99;
  throw new Error(`network is off: ${what}`);
};
net.Socket.prototype.connect = refuse("socket connect");
dns.lookup = refuse("dns lookup");
globalThis.fetch = refuse("fetch");
