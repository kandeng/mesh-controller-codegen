// Viewer capture registry — a module-level singleton so any component (the chat
// composer, the render farm) can grab a PNG of the live 3D viewer without
// prop-drilling through App.vue. MeshViewer registers its render-and-read
// functions on mount and clears them on unmount; at most one viewer is mounted at
// a time.
//
// Three separate registrations, because three callers need three different things:
//   capture()    the live view, exactly as the user sees it (chat attachment)
//   captureAt()  a POSE-DRIVEN frame in one of the vision modes (render farm)
//   model()      whether a mesh is loaded at all, so the farm can tell the server
//                "pick me" or "not me" without either side guessing
let captureFn = null;
let captureAtFn = null;
let modelInfo = null;

export function registerViewerCapture(fn) { captureFn = fn || null; }
export function registerViewerCaptureAt(fn) { captureAtFn = fn || null; }
export function registerViewerModel(info) { modelInfo = info || null; }

export function useViewerCapture() {
  return {
    register: registerViewerCapture,
    registerAt: registerViewerCaptureAt,
    registerModel: registerViewerModel,
    // -> 'data:image/png;base64,...' or null when no viewer is mounted.
    capture: () => (captureFn ? captureFn() : null),
    // -> { dataUrl, width, height, mode, colorMap } or null. `view` carries the
    // planner's absolute-world pose; opts are { mode, focusNodes, viewport }.
    captureAt: (view, opts) => (captureAtFn ? captureAtFn(view, opts) : null),
    available: () => !!captureFn,
    // -> { hasModel, glb } or null.
    model: () => modelInfo,
  };
}
