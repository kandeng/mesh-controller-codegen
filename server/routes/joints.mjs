// Joint routes — list discovered joints and publish the renderer-registry contract
// (the render ids the frontend must implement). The per-joint slot graph lives in
// project.mjs (/api/joints/:id/slots); this module is the read-only catalog.
import { KNOWN_RENDERS } from '../slots.mjs';
import { jointSummary } from './project.mjs';

export function jointRoutes(app, kernel) {
  app.get('/api/joints', async () => ({
    ok: true,
    joints: (kernel.current.joints || []).map(jointSummary),
  }));

  // The render-id -> component/control contract, so the frontend renderer registry
  // and the backend slot graph cannot drift apart.
  app.get('/api/renders', async () => ({ ok: true, renders: KNOWN_RENDERS }));
}
