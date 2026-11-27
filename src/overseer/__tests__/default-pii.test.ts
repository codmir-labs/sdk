/**
 * What an event sends of a user, and of the client's IP, unless `sendDefaultPii` is on. The server keeps the user's id and
 * counts affected users by the id, else the email, else the username; the rest is personal data sent for nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as express from "../../express/index";
import * as overseer from "../index";
import { userForWire } from "../user-pii";

type Wire = { type: string; message?: string; user?: Record<string, unknown>; extra?: Record<string, unknown>; event?: Wire };
let events: Wire[];
let bodies: string[];

beforeEach(() => {
  events = [];
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      for (const wire of (JSON.parse(String(init?.body)) as { events: Wire[] }).events) events.push(wire.event ?? wire);
      return new Response("{}", { status: 200 });
    }),
  );
});
afterEach(() => {
  void overseer.close();
  vi.unstubAllGlobals();
});

const base = { dsn: "https://ingest.example.test/api/overseer", clientKey: "osk_test", environment: "test", includeSourceContext: false };
const start = (config: Partial<overseer.OverseerConfig> = {}): void => overseer.init({ ...base, ...config });
const allBodies = (): string => bodies.join("\n");

const full = {
  id: "u_1",
  email: "ann.private@example.com",
  username: "ann",
  ip_address: "203.0.113.7",
  passwordHash: "SECRET_PWHASH",
  sessionToken: "SECRET_SESS",
  plan: "pro-plan-7",
};

describe("sendDefaultPii off (the default)", () => {
  it("(a) setUser then captureException sends exactly the id and username", async () => {
    start();
    overseer.setUser({ ...full, username: undefined });
    overseer.captureException(new Error("boom"));
    await overseer.flush();
    expect(events).toHaveLength(1);
    expect(events[0]!.user).toEqual({ id: "u_1" });
    for (const value of ["ann.private@example.com", "203.0.113.7", "SECRET_PWHASH", "SECRET_SESS", "pro-plan-7"]) {
      expect(allBodies()).not.toContain(value);
    }
  });

  it("keeps the username next to the id", async () => {
    start();
    overseer.setUser(full);
    overseer.captureException(new Error("boom"));
    await overseer.flush();
    expect(events[0]!.user).toEqual({ id: "u_1", username: "ann" });
  });

  it("(c) a user with only an email and a username sends both", async () => {
    start();
    overseer.setUser({ email: "ann.private@example.com", username: "ann", plan: "pro-plan-7" });
    overseer.captureException(new Error("boom"));
    await overseer.flush();
    expect(events[0]!.user).toEqual({ email: "ann.private@example.com", username: "ann" });
  });

  it("an empty result is no user at all, and the app's own object is not changed", async () => {
    start();
    const mine = { ip_address: "203.0.113.7", plan: "pro-plan-7" };
    overseer.setUser(mine);
    overseer.captureException(new Error("boom"));
    await overseer.flush();
    expect("user" in events[0]!).toBe(false);
    expect(mine).toEqual({ ip_address: "203.0.113.7", plan: "pro-plan-7" });
  });

  it("(d) initialUser gets the same treatment", async () => {
    start({ initialUser: { ...full } });
    overseer.captureException(new Error("boom"));
    await overseer.flush();
    expect(events[0]!.user).toEqual({ id: "u_1", username: "ann" });
    expect(allBodies()).not.toContain("SECRET_PWHASH");
  });

  it("(d) captureMessage gets the same treatment", async () => {
    start();
    overseer.setUser({ ...full });
    overseer.captureMessage("hello");
    await overseer.flush();
    expect(events[0]!.type).toBe("message");
    expect(events[0]!.user).toEqual({ id: "u_1", username: "ann" });
    expect(allBodies()).not.toContain("203.0.113.7");
  });

  it("(d) a request-scope user gets the same treatment", async () => {
    start();
    express.requestHandler()(
      { method: "GET", url: "/b", originalUrl: "/b", path: "/b", headers: { host: "app.example.test" }, protocol: "https" } as never,
      {} as never,
      () => {
        overseer.setUser({ ...full });
        overseer.captureException(new Error("scoped"));
      },
    );
    await overseer.flush();
    expect(events[0]!.user).toEqual({ id: "u_1", username: "ann" });
    expect(allBodies()).not.toContain("SECRET_SESS");
    expect(allBodies()).not.toContain("203.0.113.7");
  });

  it("(f) beforeSend sees the reduced user", async () => {
    const seen: unknown[] = [];
    start({
      beforeSend: (e) => {
        seen.push(e.user);
        return e;
      },
    });
    overseer.setUser({ ...full });
    overseer.captureException(new Error("boom"));
    await overseer.flush();
    expect(seen).toEqual([{ id: "u_1", username: "ann" }]);
  });

  it("(g) a user the hook sets is what is sent", async () => {
    start({ beforeSend: (e) => ({ ...e, user: { id: "from_hook", plan: "hook-plan" } }) });
    overseer.setUser({ ...full });
    overseer.captureException(new Error("boom"));
    await overseer.flush();
    expect(events[0]!.user).toEqual({ id: "from_hook", plan: "hook-plan" });
  });
});

describe("sendDefaultPii on", () => {
  it("(b) sends id, email, ip_address and plan, and never a key that names a secret", async () => {
    start({ sendDefaultPii: true });
    overseer.setUser({ ...full });
    overseer.captureException(new Error("boom"));
    await overseer.flush();
    expect(events[0]!.user).toEqual({
      id: "u_1",
      email: "ann.private@example.com",
      username: "ann",
      ip_address: "203.0.113.7",
      plan: "pro-plan-7",
    });
    expect(allBodies()).not.toContain("SECRET_PWHASH");
    expect(allBodies()).not.toContain("SECRET_SESS");
  });

  it("(d) initialUser and captureMessage follow the option too", async () => {
    start({ sendDefaultPii: true, initialUser: { ...full } });
    overseer.captureMessage("hello");
    await overseer.flush();
    expect(events[0]!.user).toMatchObject({ id: "u_1", ip_address: "203.0.113.7" });
    expect(allBodies()).not.toContain("SECRET_PWHASH");
  });

  it("(f) beforeSend sees the user without its secret keys", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    start({
      sendDefaultPii: true,
      beforeSend: (e) => {
        seen.push(e.user);
        return e;
      },
    });
    overseer.setUser({ ...full });
    overseer.captureException(new Error("boom"));
    await overseer.flush();
    expect(Object.keys(seen[0]!).sort()).toEqual(["email", "id", "ip_address", "plan", "username"]);
  });
});

describe("userForWire", () => {
  it("is no user for nothing, and never changes its argument", () => {
    expect(userForWire(null, false)).toBeUndefined();
    expect(userForWire(undefined, true)).toBeUndefined();
    expect(userForWire({ passwordHash: "x" }, true)).toBeUndefined();
    const mine = { id: "u_1", plan: "p" };
    userForWire(mine, true);
    userForWire(mine, false);
    expect(mine).toEqual({ id: "u_1", plan: "p" });
  });
});

describe("express errorHandler", () => {
  const req = (over: Record<string, unknown> = {}): never =>
    ({
      method: "GET", url: "/orders/1", originalUrl: "/orders/1", path: "/orders/1", baseUrl: "", route: { path: "/orders/:id" },
      protocol: "https", headers: { host: "shop.example.test" }, ip: "203.0.113.7", user: { ...full }, ...over,
    }) as never;
  const extractUser = (r: { user?: Record<string, unknown> }): Record<string, unknown> | null => (r.user ? { ...r.user } : null);

  afterEach(() => {
    void express.close();
  });

  it("(e) sends no clientIp by default, and extra.user and event.user are the reduced user", async () => {
    express.init({ ...base, extractUser: extractUser as never });
    express.errorHandler()(new Error("boom"), req(), {} as never, () => undefined);
    await overseer.flush();
    expect(events[0]!.extra).not.toHaveProperty("clientIp");
    expect(events[0]!.extra!.user).toEqual({ id: "u_1", username: "ann" });
    expect(events[0]!.user).toEqual({ id: "u_1", username: "ann" });
    expect(allBodies()).not.toContain("203.0.113.7");
    expect(allBodies()).not.toContain("SECRET_SESS");
  });

  it("(e) sends clientIp with sendDefaultPii: true, and extra.user keeps the same keys as event.user", async () => {
    express.init({ ...base, sendDefaultPii: true, extractUser: extractUser as never });
    express.errorHandler()(new Error("boom"), req(), {} as never, () => undefined);
    await overseer.flush();
    expect(events[0]!.extra!.clientIp).toBe("203.0.113.7");
    expect(Object.keys(events[0]!.extra!.user as object).sort()).toEqual(["email", "id", "ip_address", "plan", "username"]);
    expect(Object.keys(events[0]!.user!).sort()).toEqual(["email", "id", "ip_address", "plan", "username"]);
    expect(allBodies()).not.toContain("SECRET_PWHASH");
  });
});
