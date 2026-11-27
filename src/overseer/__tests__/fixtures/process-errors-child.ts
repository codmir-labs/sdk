/**
 * A small server for process-errors.test.ts. The test bundles this file and runs it in a child process; `SCENARIO`
 * picks what the child does and `INGEST` is where it sends. It prints `CAPTURED` once an error is queued.
 */
import { init, captureException } from "@codmir/sdk";

const scenario = process.env.SCENARIO ?? "";
init({ dsn: `${process.env.INGEST}/p1`, clientKey: "osk_child", captureProcessErrors: true });

// Keeps the process alive, as a server does.
setInterval(() => {}, 1000);

if (scenario.endsWith("-listener")) {
  process.on("uncaughtException", () => console.log("APP_UNCAUGHT"));
  process.on("unhandledRejection", () => console.log("APP_REJECTION"));
  process.on("SIGTERM", () => console.log("APP_SIGTERM"));
}

switch (scenario.replace("-listener", "")) {
  case "throw":
    setTimeout(() => {
      throw new Error("child boom");
    }, 50);
    break;
  case "reject":
    setTimeout(() => {
      void Promise.reject(new Error("child rejected"));
    }, 50);
    break;
  case "sigterm":
    captureException(new Error("queued before sigterm"));
    console.log("CAPTURED");
    break;
}
