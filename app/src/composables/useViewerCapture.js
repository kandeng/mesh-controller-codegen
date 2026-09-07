// Viewer capture registry — a module-level singleton so any component (the chat
// composer, the render farm) can grab a PNG of the live 3D viewer without
// prop-drilling through App.vue. MeshViewer registers its render-and-read
// functions on mount and clears them on unmount; at most one viewer is mounted at
// a time.
//
// Four separate registrations, because four callers need four different things:
//   capture()       the live view, exactly as the user sees it (chat attachment)
//   captureAt()     a POSE-DRIVEN frame in one of the vision modes (render farm)
//   captureMotion() a POSE-DRIVEN FAN of one joint through several angles, plus a
//                   swept composite (render farm, task 18 motion semantics)
//   model()         whether a mesh is loaded at all, so the farm can tell the
//                   server "pick me" or "not me" without either side guessing
let captureFn = null;
let captureAtFn = null;
let captureMotionFn = null;
let modelInfo = null;

export function registerViewerCapture(fn) { captureFn = fn || null; }
export function registerViewerCaptureAt(fn) { captureAtFn = fn || null; }
export function registerViewerCaptureMotion(fn) { captureMotionFn = fn || null; }
export function registerViewerModel(info) { modelInfo = info || null; }

export function useViewerCapture() {
  return {
    register: registerViewerCapture,
    registerAt: registerViewerCaptureAt,
    registerMotion: registerViewerCaptureMotion,
    registerModel: registerViewerModel,
    // -> 'data:image/png;base64,...' or null when no viewer is mounted.
    capture: () => (captureFn ? captureFn() : null),
    // -> { dataUrl, width, height, mode, colorMap } or null. `view` carries the
    // planner's absolute-world pose; opts are { mode, focusNodes, viewport }.
    captureAt: (view, opts) => (captureAtFn ? captureAtFn(view, opts) : null),
    // -> { frames:[{index, angle, tag, dataUrl, width, height}], composite, ... }
    // or null. `joint` carries { id, type, nodes, anchor, tests } so the viewer can
    // rebuild the preview pivot for it; opts are { view, angles, mode, focusNodes,
    // viewport }.
    captureMotion: (joint, opts) => (captureMotionFn ? captureMotionFn(joint, opts) : null),
    available: () => !!captureFn,
    // -> { hasModel, glb } or null.
    model: () => modelInfo,
  };
}
