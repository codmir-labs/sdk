/** The rejection snippet of the README's Node.js section, as the test runs it. */
import { init, captureException, flush } from "@codmir/sdk";

init({ dsn: `${process.env.INGEST}/p1`, clientKey: "osk_child" });

process.on("unhandledRejection", async (reason) => {
  captureException(reason);
  await flush(2000);
  process.exit(1);
});

setInterval(() => {}, 1000);
setTimeout(() => {
  void Promise.reject(new Error("readme rejected"));
}, 50);
