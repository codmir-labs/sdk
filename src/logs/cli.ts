#!/usr/bin/env node
import { main } from "./cli-main";

// A closed pipe (`codmir-logs … | head`) ends quietly.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`codmir-logs: ${err instanceof Error ? err.message.replace(/[\x00-\x1f\x7f-\x9f]/g, "") : "failed"}\n`); // eslint-disable-line no-control-regex
    process.exitCode = 2;
  },
);
