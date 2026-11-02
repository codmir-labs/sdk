// The page's script. Bundled by server.mjs (esbuild) into public/build/client.js.
import { init } from "@codmir/sdk/browser";
import { startReplay } from "@codmir/sdk/replay";

const config = await (await fetch("/config.json")).json();

init({
  dsn: config.dsn,
  clientKey: config.clientKey,
  environment: "example",
  service: "fullstack-basic-web",
  // Pageload transactions off: this example's one transaction is the server's /api/demo.
  browserTracing: false,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1,
});

// Buffers the last seconds in memory; an error uploads them to <dsn>/replay and links the error by tags.replay_id.
const replayId = startReplay();
document.querySelector("#status").textContent = replayId ? `recording replay ${replayId}` : "replay off";

document.querySelector("#throw").addEventListener("click", () => {
  // Uncaught on purpose: the SDK's window error handler reports it.
  throw new Error("Browser demo error: Throw button");
});

window.codmirReady = true;
