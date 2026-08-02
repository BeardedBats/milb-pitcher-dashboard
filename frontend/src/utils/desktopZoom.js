// Desktop body zoom compensation.
//
// The app applies `body { zoom: 1.25 }` on desktop (>= 769px) for a Chrome-
// 125%-equivalent scale-up. CSS `zoom` on body scales every descendant — but
// `position: fixed` children's `top`/`left` style values are then interpreted
// in the zoomed coordinate system, while `clientX` / `clientY` from mouse
// events and `window.innerWidth` / `window.innerHeight` stay in unzoomed
// viewport pixels.
//
// The helpers here convert viewport-coord values (mouse positions, etc.) into
// the zoomed-coord values that should be passed to inline `top` / `left` /
// `bottom` styles on fixed tooltips so they visually land at the intended
// viewport pixel.
//
// Keep DESKTOP_ZOOM and MOBILE_BREAKPOINT in sync with styles.css and
// hooks/useIsMobile.js.

export const DESKTOP_ZOOM = 1.25;
const MOBILE_BREAKPOINT = 768;

export function isDesktopZoomed() {
  // Must match the CSS condition that applies `body { zoom: 1.25 }`:
  // (min-width: 769px) AND (pointer: fine). Touch-primary devices (coarse
  // pointer) never get the zoom — even in landscape past the breakpoint — so
  // tooltip coordinate compensation must be skipped for them too.
  return (
    typeof window !== "undefined" &&
    window.innerWidth > MOBILE_BREAKPOINT &&
    window.matchMedia("(pointer: fine)").matches
  );
}

export function getDesktopZoom() {
  return isDesktopZoomed() ? DESKTOP_ZOOM : 1;
}

// Convert a viewport CSS pixel value into the inline-style coord that, when
// applied to a position:fixed element inside the zoomed body, renders at the
// requested viewport pixel.
export function vpToZoomCoord(viewportPx) {
  if (viewportPx == null) return viewportPx;
  return viewportPx / getDesktopZoom();
}
