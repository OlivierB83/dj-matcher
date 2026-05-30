import { useState, useEffect } from "react";

/**
 * Returns true when the viewport is at or below `breakpoint` px.
 * Initialised synchronously to avoid a layout flash on first paint.
 */
export function useIsMobile(breakpoint = 600) {
  const query = `(max-width: ${breakpoint}px)`;

  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return isMobile;
}
