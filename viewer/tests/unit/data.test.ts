import { describe, expect, it, vi } from "vitest";
import { createResolver, decodePackSlice, parsePackRef } from "../../src/data";

describe("thumbnail packs", () => {
  it("decodes unaligned byte slices without decoding the whole pack", () => {
    const bytes = Uint8Array.from({ length: 31 }, (_, i) => i * 7);
    const b64 = btoa(String.fromCharCode(...bytes));
    for (let offset = 0; offset < 8; offset++) {
      for (let length = 1; length < 9; length++) {
        expect([...decodePackSlice(b64, offset, length)]).toEqual([...bytes.slice(offset, offset + length)]);
      }
    }
    expect(parsePackRef("#pack:thumbs:4:6")).toEqual({ pack: "thumbs", offset: 4, length: 6 });
    expect(parsePackRef("#pack:thumbs:-1:6")).toBeNull();
  });

  it("caches each blob URL and revokes it on disposal", () => {
    const makeUrl = vi.fn(() => "blob:test");
    const revoke = vi.fn();
    const pack = btoa("abcdefghij");
    const resolver = createResolver(() => ({ text: pack, mime: "image/jpeg" }), makeUrl, revoke);
    expect(resolver.resolve("#pack:thumbs:2:3")).toBe("blob:test");
    expect(resolver.resolve("#pack:thumbs:2:3")).toBe("blob:test");
    expect(makeUrl).toHaveBeenCalledTimes(1);
    resolver.dispose();
    expect(revoke).toHaveBeenCalledWith("blob:test");
  });
});
