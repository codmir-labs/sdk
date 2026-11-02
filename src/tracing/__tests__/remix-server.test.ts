/** CSL-5586: Remix loader/action and request-handler wrappers open an http.server transaction. */
import { describe, expect, it } from "vitest";
import { withCodmirRequestHandler, withCodmirTracing } from "../../remix/server";
import { flush } from "../../overseer/index";
import { sentTransactions } from "./helpers";
import { runBehaviour, serverTracingSuite, startTracing, useTracingHarness } from "./server-suite";

const ROUTE = "/users/:id";

serverTracingSuite("remix loader", {
  path: "/users/42?x=1",
  call: async ({ path, headers, behaviour }) => {
    const loader = withCodmirTracing(
      (_args: { request: Request; params: Record<string, string> }) =>
        runBehaviour(behaviour, () => Response.json({ ok: true }), () => new Response("nope", { status: 500 })),
      { route: ROUTE },
    );
    try {
      const res = await loader({ request: new Request(`http://localhost${path}`, { headers }), params: { id: "42" } });
      return { status: res.status };
    } catch (thrown) {
      return { thrown };
    }
  },
  nameFor: () => `GET ${ROUTE}`,
});

serverTracingSuite("remix request handler", {
  path: "/users/42?x=1",
  call: async ({ path, headers, behaviour }) => {
    const handle = withCodmirRequestHandler(
      (_req: Request, _loadContext?: unknown) =>
        runBehaviour(behaviour, () => new Response("ok"), () => new Response("nope", { status: 500 })),
    );
    try {
      const res = await handle(new Request(`http://localhost${path}`, { headers }));
      return { status: res.status };
    } catch (thrown) {
      return { thrown };
    }
  },
  nameFor: () => "GET /users/42",
});

describe("remix specifics", () => {
  const harness = useTracingHarness();

  it("treats a thrown redirect or 404 Response as ok and a thrown 500 Response as error, rethrowing each", async () => {
    startTracing(1);
    for (const status of [302, 404, 500]) {
      const action = withCodmirTracing((_a: { request: Request }) => {
        throw new Response(null, { status });
      });
      await expect(action({ request: new Request("http://localhost/a", { method: "POST" }) })).rejects.toMatchObject({ status });
    }
    await flush();
    const txs = sentTransactions(harness.calls());
    expect(txs.map((t) => [t.name, t.status])).toEqual([
      ["POST /a", "ok"],
      ["POST /a", "ok"],
      ["POST /a", "error"],
    ]);
  });
});
