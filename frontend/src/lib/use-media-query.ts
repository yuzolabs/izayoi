import { useEffect, useState } from "react";

/**
 * Tracks a CSS media query for layout-branching React state.
 *
 * Returns false outside the browser (static render / node tests) so components
 * can safely branch on it during server-style rendering. Listeners follow the
 * window so React state stays in sync when the viewport crosses the query.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches
  );

  useEffect(() => {
    const mediaQueryList = window.matchMedia(query);
    const handleChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(mediaQueryList.matches);
    mediaQueryList.addEventListener("change", handleChange);
    return () => mediaQueryList.removeEventListener("change", handleChange);
  }, [query]);

  return matches;
}
