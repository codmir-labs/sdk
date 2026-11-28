/**
 * The Remix server `@example` in `dist/remix/server.d.ts`: `withCodmirRequestHandler` around a fetch-style handler, the
 * shape `createRequestHandler` of `@remix-run/node` returns. One request is answered as the handler answers it.
 * Skips without a build; CI runs this file after one.
 */
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const hasDist = existsSync(`${root}dist/remix/server.js`);

describe.skipIf(!hasDist)("dist/remix/server: the @example's request handler", () => {
  it("answers a request with the handler's own response", async () => {
    const { withCodmirRequestHandler } = (await import(pathToFileURL(`${root}dist/remix/server.js`).href)) as typeof import("../server");
    // What `createRequestHandler(build)` of `@remix-run/node` is: a `Request` in, a `Response` out.
    const handler = async (request: Request) => new Response(`hello ${new URL(request.url).pathname}`, { status: 200, headers: { "content-type": "text/plain" } });
    const handle = withCodmirRequestHandler(handler);
    const response = await handle(new Request("https://shop.example/products", { headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" } }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello /products");
  });

  it("answers through a route wrapped with withCodmirTracing", async () => {
    const { withCodmirTracing } = (await import(pathToFileURL(`${root}dist/remix/server.js`).href)) as typeof import("../server");
    const loader = withCodmirTracing(async ({ params }: { request: Request; params: Record<string, string> }) => Response.json({ id: params.id }), { route: "/users/:id" });
    const response = await loader({ request: new Request("https://shop.example/users/7"), params: { id: "7" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "7" });
  });
});
