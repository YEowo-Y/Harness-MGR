import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils";

/*
 * cn() = clsx (conditional join) piped through tailwind-merge (conflict resolution).
 * The two behaviours are tested separately: clsx drops falsy + supports objects;
 * twMerge dedupes CONFLICTING standard-Tailwind utilities (last wins). twMerge only
 * knows the standard scale, so the conflict cases use px-/text-size utilities, not the
 * project's custom tokens (text-ink etc.), which it cannot know conflict.
 */
describe("cn", () => {
  it("joins truthy class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("drops falsy values (clsx)", () => {
    expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
  });

  it("supports clsx object + array syntax", () => {
    expect(cn("base", { active: true, hidden: false }, ["x", "y"])).toBe("base active x y");
  });

  it("resolves conflicting standard Tailwind utilities — last wins (twMerge)", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
    expect(cn("text-sm", "text-lg")).toBe("text-lg");
  });

  it("returns an empty string for no/empty input", () => {
    expect(cn()).toBe("");
    expect(cn(false, null, undefined)).toBe("");
  });
});
