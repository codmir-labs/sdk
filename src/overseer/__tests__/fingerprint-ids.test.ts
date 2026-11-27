import { describe, expect, it } from "vitest";
import { sdkFingerprint } from "../transport";

const base = { id: "x", type: "error", timestamp: "t", level: "error" };
const fp = (value: string) => sdkFingerprint({ ...base, exception: { type: "Error", value } });

describe("fingerprint masks ids before digits", () => {
  it("gives one fingerprint to messages that differ only by a UUID", () => {
    const a = fp("User 3f2a9c1e-8b7d-4e6f-a5b4-c3d2e1f0a9b8 not found");
    const b = fp("User 0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d not found");
    expect(a).toEqual(b);
    expect(a[1]).toBe("User <UUID> not found");
  });

  it("treats an upper-case UUID the same", () => {
    const lower = fp("User 3f2a9c1e-8b7d-4e6f-a5b4-c3d2e1f0a9b8 not found");
    const upper = fp("User 3F2A9C1E-8B7D-4E6F-A5B4-C3D2E1F0A9B8 not found");
    expect(upper).toEqual(lower);
  });

  it("masks a 24-hex ObjectId to <ID>", () => {
    const a = fp("Doc 507f1f77bcf86cd799439011 missing");
    const b = fp("Doc 65a1b2c3d4e5f60718293a4b missing");
    expect(a[1]).toBe("Doc <ID> missing");
    expect(a).toEqual(b);
  });

  it("masks deadbeef12 as one <ID>", () => {
    expect(fp("user deadbeef12 got 404")[1]).toBe("user <ID> got <N>");
  });

  it("masks plain numbers to <N> and leaves short hex words alone", () => {
    expect(fp("order 1001 not found")[1]).toBe("order <N> not found");
    expect(fp("cafe added")[1]).toBe("cafe added");
  });

  it("still cuts to 100 characters after masking", () => {
    const out = fp("id 3f2a9c1e-8b7d-4e6f-a5b4-c3d2e1f0a9b8 " + "z".repeat(200))[1];
    expect(out.startsWith("id <UUID> zzz")).toBe(true);
    expect(out).toHaveLength(100);
  });

  it("groups a digit-only number the same whatever its length", () => {
    const a = fp("Order 1234567 failed");
    const b = fp("Order 12345678 failed");
    expect(a).toEqual(b);
    expect(a[1]).toBe("Order <N> failed");
    expect(fp("file too large: 1048576 bytes")).toEqual(fp("file too large: 10485760 bytes"));
  });

  it("masks a 10-digit timestamp to <N>", () => {
    expect(fp("expired at 1764115200")[1]).toBe("expired at <N>");
  });
});
