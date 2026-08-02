import { useState, useEffect } from "react";

const MOBILE_BREAKPOINT = 768;
// "Mobile" = narrow viewport OR a touch-primary device (coarse pointer). The
// coarse-pointer clause keeps the touch experience (tap-to-tooltip, stacked
// layout, native selects) when a phone is rotated to landscape and its width
// exceeds the breakpoint. Kept in sync with the @media query in styles.css and
// isDesktopZoomed() in utils/desktopZoom.js.
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px), (pointer: coarse)`;

export default function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    setIsMobile(mq.matches);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return isMobile;
}
