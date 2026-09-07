// Vision provider — the transport seam between the prompt builder and whatever
// model actually looks at the frames.
//
// Why this is its own file rather than a call inside the loop: the loop must stay
// pure enough to test headless, and the transport is the one part that cannot be.
// Everything upstream (planning, prompt building, grounding, validation) takes and
// returns plain data; only this file knows how a turn is carried.
//
// Two implementations behind one interface:
//   dsh   the existing DSH supervisor, which already pushes one image part per
//         entry into a single turn (server/dsh-agent.mjs sendLive). This is the
//         default and the only working one.
//   http  a DIRECT call for models DSH does not front — SAM/DINOv2 for
//         segmentation, or a video endpoint for motion. Declared now so the seam
//         is real and a later swap is one config key, not a refactor.

export const VISION_PROVIDERS = ['dsh', 'http'];

const err = (message, code) => Object.assign(new Error(message), { code });

// The DSH transport.
//
// The guard in `available()` is load-bearing, not defensive decoration: a stub
// agent ANSWERS with fabricated text instead of throwing, so without this check a
// vision round would parse a stub reply into confident proposals and nothing
// anywhere would report an error. Refusing loudly is the only safe behaviour.
export function createDshVisionProvider(agent) {
  const info = () => { try { return agent?.status?.() || {}; } catch { return {}; } };
  const live = () => { try { return agent?.mode === 'live'; } catch { return false; } };
  // A distinct sentence per failure, because the operator action differs: start
  // the DSH host, or set a multimodal vision_model, or attach some frames.
  // A local rather than a method so `send` survives being destructured off the
  // provider (which is exactly how the loop injects it).
  const reason = () => (live()
    ? null
    : `the DSH agent is in "${agent?.mode || 'absent'}" mode — a vision round needs a live multimodal model`);

  return {
    kind: 'dsh',
    available: live,
    model: () => info().visionModel || info().model || null,
    reason,

    // images: [{ mediaType, dataBase64, name }] — exactly agent.send()'s contract.
    async send(text, images = []) {
      if (!agent) throw err('no agent is wired into the vision provider', 'NO_VISION_AGENT');
      if (!live()) throw err(reason(), 'NO_VISION_AGENT');
      if (!Array.isArray(images) || !images.length) {
        throw err('a vision turn needs at least one rendered frame; nothing was captured', 'NO_FRAMES');
      }
      const bad = images.filter((im) => !im?.dataBase64 || !im?.mediaType);
      if (bad.length) throw err(`${bad.length} frame(s) are missing mediaType or bytes`, 'MALFORMED_FRAMES');

      const t0 = Date.now();
      const r = await agent.send(text, images);
      // The host can degrade mid-turn (boot failure, provider quota). Its reply is
      // then a stub, not a reading of the frames, and must never be parsed.
      if (r?.mode && r.mode !== 'live') {
        throw err(`the agent degraded to "${r.mode}" mid-turn, so its reply is a stub rather than a reading of the frames`, 'VISION_DEGRADED');
      }
      return {
        reply: String(r?.reply || ''),
        tools: Array.isArray(r?.tools) ? r.tools : [],
        model: info().visionModel || info().model || null,
        mode: r?.mode || 'live',
        images: images.length,
        ms: Date.now() - t0,
      };
    },
  };
}

// The direct-HTTP transport, declared and refused.
//
// This is the seam for models that are not in DSH's list: SAM/DINOv2 for real
// segmentation instead of colour-id masks, or a video endpoint for motion. It
// throws rather than silently doing nothing, because a config that asks for it and
// quietly gets no proposals would look like "the model found nothing".
export function createHttpVisionProvider(cfg = {}) {
  const model = cfg?.visionModel || cfg?.vision_model || null;
  const notImpl = () => err(
    'the direct HTTP vision provider is not implemented yet — set "vision_provider": "dsh" in config.json, '
    + 'or implement createHttpVisionProvider.send() against your own GPU server',
    'NOT_IMPLEMENTED',
  );
  return {
    kind: 'http',
    available: () => false,
    model: () => model,
    reason: () => 'the direct HTTP vision provider is not implemented (it is the seam for SAM/DINOv2/video)',
    async send() { throw notImpl(); },
  };
}

// Selected by `vision_provider` in config.json; default `dsh`.
export function createVisionProvider(cfg = {}, agent = null) {
  const kind = String(cfg?.visionProvider || cfg?.vision_provider || 'dsh').toLowerCase();
  if (kind === 'http') return createHttpVisionProvider(cfg);
  // An unknown value falls back to the working transport rather than bricking the
  // round, but says so — a typo should be visible, not silently absorbed.
  if (!VISION_PROVIDERS.includes(kind)) {
    const p = createDshVisionProvider(agent);
    return { ...p, warning: `unknown vision_provider "${kind}"; using "dsh"` };
  }
  return createDshVisionProvider(agent);
}
