/*
 * GSAP motion layer (design §3 motion vocabulary).
 *
 * Two rules keep this safe + accessible:
 *  1. Every animation lives inside a `gsap.matchMedia("(prefers-reduced-motion:
 *     no-preference)")` block, so a reader who asks the OS for reduced motion gets
 *     NONE of it.
 *  2. We animate with `gsap.from()` (not set-then-to). `from()` tweens FROM a start
 *     state back to the element's natural CSS, so under reduced-motion — where the
 *     tween never runs — the element simply renders in its final, correct state.
 *     (set()+to() would risk leaving things stuck at the hidden start state.)
 */
import {
  useLayoutEffect,
  useRef,
  type DependencyList,
  type RefObject,
} from "react";
import gsap from "gsap";

// One-time global defaults — the house easing/duration for everything that does
// not override it (design §3: duration .25, power2.out).
gsap.defaults({ duration: 0.25, ease: "power2.out" });

/** True when the OS / browser asks for reduced motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Run a scoped GSAP setup, gated behind prefers-reduced-motion. Selector text
 * inside `setup` is scoped to the returned ref element (via matchMedia's scope
 * arg), and every tween is reverted on cleanup / dep-change. `setup` also receives
 * the scope element directly for whole-element tweens.
 *
 * deps drive re-runs — pass ONLY primitives (mirrors useApi's contract) so an
 * object literal can't change identity every render and re-animate in a loop.
 */
export function useGsap<T extends HTMLElement = HTMLDivElement>(
  setup: (self: T) => void,
  deps: DependencyList,
): RefObject<T | null> {
  const scope = useRef<T>(null);
  useLayoutEffect(() => {
    const el = scope.current;
    if (!el) return;
    const mm = gsap.matchMedia(el);
    mm.add("(prefers-reduced-motion: no-preference)", () => setup(el));
    return () => mm.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return scope;
}

/**
 * A number that counts up to `value` on change (design §3: expo.out .8s). Renders
 * the literal value as its children so it is correct before/without JS; the tween
 * (when allowed) overwrites the text each frame. Under reduced-motion it snaps.
 */
export function CountUp({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = prev.current;
    prev.current = value;

    if (prefersReducedMotion()) {
      el.textContent = String(value);
      return;
    }
    const obj = { v: from };
    const tween = gsap.to(obj, {
      v: value,
      duration: 0.8,
      ease: "expo.out",
      onUpdate: () => {
        el.textContent = String(Math.round(obj.v));
      },
    });
    return () => {
      tween.kill();
    };
  }, [value]);

  return (
    <span ref={ref} className={className}>
      {value}
    </span>
  );
}
