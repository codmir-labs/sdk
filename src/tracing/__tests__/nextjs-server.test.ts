/** CSL-5586: Next.js App Router wrappers open an http.server transaction. */
import { describe, expect, it } from "vitest";
import { withCodmirMiddleware, withCodmirTracing } from "../../nextjs/server";
import { flush } from "../../overseer/index";
import { TransactionEventSchema, sentTransactions } from "./helpers";
import { runBehaviour, serverTracingSuite, startTracing, useTracingHarness, type Behaviour } from "./server-suite";

const ROUTE = "/api/users/[id]";

async function viaHandler(path: string, headers: Record<string, string>, behaviour: Behaviour) {
  const GET = withCodmirTracing(
    (_req: Request, _ctx: { params: { id: string } }) =>
      runBehaviour(behaviour, () => Response.json({ ok: true }), () => new Response("nope", { status: 500 })),
    { route: ROUTE },
  );
  try {
    const res = await GET(new Request(`http://localhost${path}`, { headers }), { params: { id: "42" } });
    return { status: res.status };
  } catch (thrown) {
    return { thrown };
  }
}

serverTracingSuite("next route handler", {
  path: "/api/users/42?x=1",
  call: ({ path, headers, behaviour }) => viaHandler(path, headers, behaviour),
  nameFor: () => `GET ${ROUTE}`,
});

describe("next route handler specifics", () => {
  const harness = useTracingHarness();

  it("rethrows a thrown error unchanged", async () => {
    startTracing(1);
    const out = await viaHandler("/api/users/42", {}, "throw");
    expect((out.thrown as Error).message).toBe("boom");
  });

  it("names the root after the URL path, without the query, when no route is given", async () => {
    startTracing(1);
    await withCodmirTracing(() => new Response("ok"))(new Request("http://localhost/api/ping?a=1", { method: "POST" }));
    await flush();
    const [tx] = sentTransactions(harness.calls());
    expect(tx.name).toBe("POST /api/ping");
  });
});

serverTracingSuite("next middleware", {
  path: "/dashboard?tab=1",
  call: async ({ path, headers, behaviour }) => {
    const mw = withCodmirMiddleware((_req: Request) =>
      runBehaviour(behaviour, () => new Response(null, { status: 200 }), () => new Response(null, { status: 500 })),
    );
    try {
      const res = await mw(new Request(`http://localhost${path}`, { headers }));
      return { status: res.status };
    } catch (thrown) {
      return { thrown };
    }
  },
  nameFor: () => "GET /dashboard",
});

describe("next middleware specifics", () => {
  const harness = useTracingHarness();

  it("accepts a middleware that returns nothing", async () => {
    startTracing(1);
    const out = await withCodmirMiddleware((_req: Request) => undefined)(new Request("http://localhost/x"));
    expect(out).toBeUndefined();
    await flush();
    const [tx] = sentTransactions(harness.calls());
    expect(TransactionEventSchema.safeParse(tx).success).toBe(true);
    expect(tx.status).toBe("ok");
  });
});
