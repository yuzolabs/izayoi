import { useEffect, useState } from "react";

/**
 * Tracks which page section is currently at the decision line (30% down the
 * viewport), for step-rail navigation with aria-current="step". Sections that
 * do not exist in the DOM (e.g. a conditional step) are ignored. Two edge
 * cases are handled explicitly: above everything → first step; scrolled to
 * the bottom → last step (a very tall section can otherwise never reach the
 * line before the page runs out of scroll).
 */
export function useActiveStepSection(sectionIds: string[]): string {
  const [activeId, setActiveId] = useState(sectionIds[0] ?? "");

  useEffect(() => {
    const ids = sectionIds;
    const firstId = ids.find((id) => document.getElementById(id) !== null) ?? ids[0] ?? "";

    const update = () => {
      const line = window.innerHeight * 0.3;
      let current = firstId;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) current = id;
      }
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom) {
        const lastId = [...ids].reverse().find((id) => document.getElementById(id) !== null);
        if (lastId) current = lastId;
      }
      setActiveId(current);
    };

    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        update();
        ticking = false;
      });
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
    // sectionIds identity changes when steps appear/disappear; the joined key
    // is the stable dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionIds.join(",")]);

  return activeId;
}

/** Scrolls a step section into view, honoring prefers-reduced-motion. */
export function scrollStepSectionIntoView(id: string): void {
  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;
  document.getElementById(id)?.scrollIntoView({
    behavior: prefersReducedMotion ? "auto" : "smooth",
    block: "start",
  });
}
