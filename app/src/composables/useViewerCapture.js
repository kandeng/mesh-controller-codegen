// Viewer capture registry — a module-level singleton so any component (the chat
// composer) can grab a PNG of the live 3D viewer without prop-drilling through
// App.vue. MeshViewer registers its render-and-read function on mount and clears
// it on unmount; at most one viewer is mounted at a time.
let captureFn = null;

export function registerViewerCapture(fn) { captureFn = fn || null; }

export function useViewerCapture() {
  return {
    register: registerViewerCapture,
    // -> 'data:image/png;base64,...' or null when no viewer is mounted.
    capture: () => (captureFn ? captureFn() : null),
    available: () => !!captureFn,
  };
}
