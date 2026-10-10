'use client';
"use client";
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/client/Eyes.tsx
import { useEffect, useRef } from "react";

// src/client/eyes.module.css
var eyes_default = {
  eyes: "eyes_eyes",
  eye: "eyes_eye",
  blink: "eyes_blink",
  eyeHalo: "eyes_eyeHalo",
  ponder: "eyes_ponder",
  speak: "eyes_speak",
  smallEyes: "eyes_smallEyes"
};

// src/client/Eyes.tsx
import { jsx, jsxs } from "react/jsx-runtime";
function Eyes({ phase, avatar, small = false, level = 0 }) {
  const ref = useRef(null);
  const state = useRef(phase);
  state.current = phase;
  useEffect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, lastPointer = 0, x = 0, y = 0;
    const target = { x: 0, y: 0 };
    const move = (event) => {
      if (motion.matches) return;
      const rect = ref.current?.getBoundingClientRect();
      if (rect) {
        target.x = Math.max(-11, Math.min(11, (event.clientX - rect.x - rect.width / 2) / 45));
        target.y = Math.max(-7, Math.min(7, (event.clientY - rect.y - rect.height / 2) / 60));
        lastPointer = performance.now();
      }
    };
    const tick = (now) => {
      if (motion.matches || document.hidden) {
        frame = 0;
        return;
      }
      const resting = now - lastPointer > 2500;
      const working = state.current === "thinking" || state.current === "usingApp";
      x += ((resting ? working ? 6 + Math.sin(now / 1700) * 2 : Math.sin(now / 3700) * 2.5 : target.x) - x) * 0.09;
      y += ((resting ? working ? -3 : Math.cos(now / 4200) * 1.2 : target.y) - y) * 0.09;
      ref.current?.style.setProperty("--gaze-x", `${x.toFixed(2)}px`);
      ref.current?.style.setProperty("--gaze-y", `${y.toFixed(2)}px`);
      ref.current?.style.setProperty("--head-tilt", `${(x * -0.14).toFixed(2)}deg`);
      frame = requestAnimationFrame(tick);
    };
    const resume = () => {
      cancelAnimationFrame(frame);
      if (!motion.matches && !document.hidden) frame = requestAnimationFrame(tick);
    };
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("visibilitychange", resume);
    motion.addEventListener("change", resume);
    resume();
    return () => {
      window.removeEventListener("pointermove", move);
      document.removeEventListener("visibilitychange", resume);
      motion.removeEventListener("change", resume);
      cancelAnimationFrame(frame);
    };
  }, []);
  return /* @__PURE__ */ jsxs(
    "div",
    {
      ref,
      className: `${eyes_default.eyes} ${small ? eyes_default.smallEyes : ""}`,
      "data-phase": phase,
      "data-avatar": avatar,
      "aria-hidden": "true",
      style: { "--voice-level": Math.max(0, Math.min(1, level)), "--gaze-x": "0px", "--gaze-y": "0px" },
      children: [
        /* @__PURE__ */ jsx("span", { className: eyes_default.eye, children: /* @__PURE__ */ jsx("i", {}) }),
        /* @__PURE__ */ jsx("span", { className: eyes_default.eye, children: /* @__PURE__ */ jsx("i", {}) }),
        /* @__PURE__ */ jsx("span", { className: eyes_default.eyeHalo })
      ]
    }
  );
}

// src/factory/factory.module.css
var factory_default = {
  companion: "factory_companion",
  notice: "factory_notice",
  caption: "factory_caption",
  authority: "factory_authority",
  fact: "factory_fact"
};

// src/factory/FactoryAvatar.tsx
import { Fragment, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var copy = {
  en: { label: "Factory companion", preview: "Sample data", stale: "Last observation \xB7 connection stale", unavailable: "Factory unavailable. No current observation.", fresh: "Factory observation", task: "Recorded task", attempt: "Attempt", cell: "Cell", heartbeat: "Worker heartbeat", evidence: "Activity evidence", recent: "Recent lease and heartbeat evidence", uncertain: "Activity uncertain", idle: "No running task recorded", worker: "Current worker state is unverified.", effects: "Unresolved external effects", drained: "External effects are recorded as drained.", inspect: "Inspect", readonly: "Read-only \xB7 voice and execution unavailable", revision: "Revision", observed: "Snapshot read", candidate: "Candidate evidence", review: "Review evidence", status: { reserved: "reserved", ready: "ready", retired: "retired", running: "running", review: "under review", verified: "verified", delivered: "delivered", rejected: "rejected" } },
  es: { label: "Compa\xF1ero de la f\xE1brica", preview: "Datos de ejemplo", stale: "\xDAltima observaci\xF3n \xB7 conexi\xF3n desactualizada", unavailable: "F\xE1brica no disponible. No hay observaci\xF3n actual.", fresh: "Observaci\xF3n de la f\xE1brica", task: "Tarea registrada", attempt: "Intento", cell: "C\xE9lula", heartbeat: "\xDAltima se\xF1al del trabajador", evidence: "Evidencia de actividad", recent: "Evidencia reciente de se\xF1al y autorizaci\xF3n", uncertain: "Actividad incierta", idle: "Ninguna tarea en ejecuci\xF3n registrada", worker: "El estado actual de los trabajadores no est\xE1 verificado.", effects: "Efectos externos sin resolver", drained: "Los efectos externos figuran como resueltos.", inspect: "Inspeccionar", readonly: "Solo lectura \xB7 voz y ejecuci\xF3n no disponibles", revision: "Revisi\xF3n", observed: "Lectura del estado", candidate: "Evidencia del candidato", review: "Evidencia de revisi\xF3n", status: { reserved: "reservada", ready: "lista", retired: "retirada", running: "en ejecuci\xF3n", review: "en revisi\xF3n", verified: "verificada", delivered: "entregada", rejected: "rechazada" } },
  pt: { label: "Companheiro da f\xE1brica", preview: "Dados de exemplo", stale: "\xDAltima observa\xE7\xE3o \xB7 conex\xE3o desatualizada", unavailable: "F\xE1brica indispon\xEDvel. Sem observa\xE7\xE3o atual.", fresh: "Observa\xE7\xE3o da f\xE1brica", task: "Tarefa registrada", attempt: "Tentativa", cell: "C\xE9lula", heartbeat: "\xDAltimo sinal do trabalhador", evidence: "Evid\xEAncia de atividade", recent: "Evid\xEAncia recente de sinal e autoriza\xE7\xE3o", uncertain: "Atividade incerta", idle: "Nenhuma tarefa em execu\xE7\xE3o registrada", worker: "O estado atual dos trabalhadores n\xE3o est\xE1 verificado.", effects: "Efeitos externos pendentes", drained: "Os efeitos externos constam como resolvidos.", inspect: "Inspecionar", readonly: "Somente leitura \xB7 voz e execu\xE7\xE3o indispon\xEDveis", revision: "Revis\xE3o", observed: "Leitura do estado", candidate: "Evid\xEAncia do candidato", review: "Evid\xEAncia de revis\xE3o", status: { reserved: "reservada", ready: "pronta", retired: "retirada", running: "em execu\xE7\xE3o", review: "em revis\xE3o", verified: "verificada", delivered: "entregue", rejected: "rejeitada" } }
};
var instant = (value, locale) => new Date(value).toLocaleString(locale, { dateStyle: "medium", timeStyle: "medium" });
function FactoryAvatar({ observation, avatar, locale, onInspect }) {
  const c = copy[locale], state = observation?.readState ?? "unavailable";
  const available = observation && state !== "unavailable";
  const task = available ? observation.selectedTask : void 0;
  const cell = available ? observation.selectedCell : void 0;
  return /* @__PURE__ */ jsxs2("section", { className: factory_default.companion, "aria-label": c.label, "data-read-state": state, children: [
    /* @__PURE__ */ jsx2("div", { className: factory_default.notice, children: state === "preview" ? c.preview : state === "stale" ? c.stale : state === "unavailable" ? c.unavailable : c.fresh }),
    /* @__PURE__ */ jsx2(Eyes, { avatar, phase: available ? "idle" : "error", small: true }),
    /* @__PURE__ */ jsx2("h2", { children: available ? observation.mission : c.label }),
    /* @__PURE__ */ jsx2("p", { className: factory_default.caption, role: "status", "aria-live": "polite", children: task ? `${c.task} ${task.id}: ${c.status[task.reportedStatus]}. ${c.attempt} ${task.attempt}.` : available ? c.worker : c.unavailable }),
    available && /* @__PURE__ */ jsxs2(Fragment, { children: [
      /* @__PURE__ */ jsxs2("div", { className: factory_default.authority, children: [
        observation.factoryId,
        " \xB7 ",
        c.revision,
        " ",
        observation.revision,
        /* @__PURE__ */ jsx2("br", {}),
        c.observed,
        ": ",
        /* @__PURE__ */ jsx2("time", { dateTime: observation.observedAt, children: instant(observation.observedAt, locale) })
      ] }),
      cell && /* @__PURE__ */ jsxs2("div", { className: factory_default.fact, children: [
        /* @__PURE__ */ jsxs2("h3", { children: [
          c.cell,
          " \xB7 ",
          cell.id
        ] }),
        /* @__PURE__ */ jsx2("p", { children: cell.purpose }),
        /* @__PURE__ */ jsxs2("dl", { children: [
          /* @__PURE__ */ jsx2("dt", { children: c.heartbeat }),
          /* @__PURE__ */ jsx2("dd", { children: /* @__PURE__ */ jsx2("time", { dateTime: cell.heartbeat, children: instant(cell.heartbeat, locale) }) }),
          /* @__PURE__ */ jsx2("dt", { children: c.evidence }),
          /* @__PURE__ */ jsx2("dd", { children: c[cell.activityEvidence] })
        ] }),
        /* @__PURE__ */ jsxs2("button", { type: "button", onClick: () => onInspect({ kind: "cell", id: cell.id }), children: [
          c.inspect,
          " \xB7 ",
          cell.id
        ] })
      ] }),
      task && /* @__PURE__ */ jsxs2("div", { className: factory_default.fact, children: [
        /* @__PURE__ */ jsxs2("h3", { children: [
          c.task,
          " \xB7 ",
          task.id
        ] }),
        /* @__PURE__ */ jsxs2("p", { children: [
          c.status[task.reportedStatus],
          " \xB7 ",
          c.attempt,
          " ",
          task.attempt
        ] }),
        task.candidateDigest && /* @__PURE__ */ jsxs2("p", { children: [
          c.candidate,
          ": ",
          /* @__PURE__ */ jsx2("code", { children: task.candidateDigest })
        ] }),
        task.reviewEvidenceDigest && /* @__PURE__ */ jsxs2("p", { children: [
          c.review,
          ": ",
          /* @__PURE__ */ jsx2("code", { children: task.reviewEvidenceDigest })
        ] }),
        /* @__PURE__ */ jsxs2("button", { type: "button", onClick: () => onInspect({ kind: "task", id: task.id }), children: [
          c.inspect,
          " \xB7 ",
          task.id
        ] })
      ] }),
      /* @__PURE__ */ jsxs2("p", { children: [
        observation.effectsDrained ? c.drained : `${c.effects}: ${observation.unresolvedEffects}.`,
        " ",
        c.worker
      ] })
    ] }),
    /* @__PURE__ */ jsx2("footer", { children: c.readonly })
  ] });
}

// src/world/WorldSky.tsx
import { useEffect as useEffect2, useId, useLayoutEffect, useRef as useRef2, useState } from "react";

// src/world/selection.ts
function currentWorldSkySelection(model, selection2) {
  if (!model || !selection2) return null;
  const source = model.sources.find((row) => row.id === selection2.sourceId && row.factoryId === selection2.factoryId);
  if (!source || source.status === "unavailable") return null;
  const records = source.snapshot?.snapshot;
  const present = selection2.kind === "source" ? selection2.id === source.id : selection2.kind === "cell" ? records?.cells.some((row) => row.id === selection2.id) : selection2.kind === "task" ? records?.tasks.some((row) => row.id === selection2.id) : selection2.kind === "effect" && records?.effects.some((row) => row.key === selection2.id);
  return present ? { sourceId: source.id, factoryId: source.factoryId, kind: selection2.kind, id: selection2.id } : null;
}

// src/world/world-sky.module.css
var world_sky_default = {
  shell: "world_sky_shell",
  panorama: "world_sky_panorama",
  world: "world_sky_world",
  sky: "world_sky_sky",
  camera: "world_sky_camera",
  selection: "world_sky_selection"
};

// src/world/WorldSky.tsx
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
var copy2 = {
  en: { panorama: "World and sky", world: "FLUJO World", sky: "Swarm sky", up: "Look at the sky", down: "Back to the world", sample: "Sample data \xB7 sky preview", unavailable: "Swarm observations unavailable", sources: "registered sources" },
  es: { panorama: "Mundo y cielo", world: "FLUJO World", sky: "Cielo del enjambre", up: "Mirar al cielo", down: "Volver al mundo", sample: "Datos de ejemplo \xB7 vista del cielo", unavailable: "Observaciones del enjambre no disponibles", sources: "fuentes registradas" },
  pt: { panorama: "Mundo e c\xE9u", world: "FLUJO World", sky: "C\xE9u do enxame", up: "Olhar para o c\xE9u", down: "Voltar ao mundo", sample: "Dados de exemplo \xB7 pr\xE9via do c\xE9u", unavailable: "Observa\xE7\xF5es do enxame indispon\xEDveis", sources: "fontes registradas" }
};
var useClientLayoutEffect = typeof window === "undefined" ? useEffect2 : useLayoutEffect;
function WorldSky({ world, sky, model, selection: selection2, onNavigate, initialLayer = "world", locale = "en" }) {
  const viewport = useRef2(null), worldRegion = useRef2(null), skyRegion = useRef2(null);
  const [layer, setLayer] = useState(initialLayer);
  const layerRef = useRef2(initialLayer);
  const latest = useRef2({ model, selection: selection2, onNavigate });
  latest.current = { model, selection: selection2, onNavigate };
  const id = useId(), c = copy2[locale];
  const visibleSelection = currentWorldSkySelection(model, selection2);
  useClientLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const position = () => {
      element.scrollTop = layerRef.current === "world" ? element.clientHeight : 0;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const recordLayer = (next) => {
    if (next === layerRef.current) return;
    layerRef.current = next;
    setLayer(next);
    const facts = latest.current;
    facts.onNavigate({ layer: next, selection: currentWorldSkySelection(facts.model, facts.selection) });
  };
  const travel = (next) => {
    const element = viewport.current;
    if (!element) return;
    element.scrollTo({
      top: next === "world" ? element.clientHeight : 0,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"
    });
    (next === "world" ? worldRegion : skyRegion).current?.focus({ preventScroll: true });
  };
  return /* @__PURE__ */ jsxs3("div", { className: world_sky_default.shell, "data-layer": layer, children: [
    /* @__PURE__ */ jsxs3("nav", { className: world_sky_default.camera, "aria-label": c.panorama, children: [
      /* @__PURE__ */ jsxs3("button", { type: "button", "aria-controls": `${id}-${layer === "world" ? "sky" : "world"}`, onClick: () => travel(layer === "world" ? "sky" : "world"), children: [
        layer === "world" ? c.up : c.down,
        " ",
        /* @__PURE__ */ jsx3("span", { "aria-hidden": "true", children: layer === "world" ? "\u2191" : "\u2193" })
      ] }),
      /* @__PURE__ */ jsx3("small", { role: "status", children: model?.sample ? c.sample : !model ? c.unavailable : `${model.sources.length} ${c.sources}` })
    ] }),
    /* @__PURE__ */ jsxs3("div", { ref: viewport, className: world_sky_default.panorama, onScroll: (event) => {
      const element = event.currentTarget;
      if (element.clientHeight > 0) recordLayer(element.scrollTop >= element.clientHeight / 2 ? "world" : "sky");
    }, children: [
      /* @__PURE__ */ jsx3("section", { id: `${id}-sky`, ref: skyRegion, className: world_sky_default.sky, "aria-label": c.sky, tabIndex: -1, children: sky }),
      /* @__PURE__ */ jsx3("section", { id: `${id}-world`, ref: worldRegion, className: world_sky_default.world, "aria-label": c.world, tabIndex: -1, children: world })
    ] }),
    layer === "sky" && visibleSelection && /* @__PURE__ */ jsxs3("span", { className: world_sky_default.selection, children: [
      model?.sources.find((source) => source.id === visibleSelection.sourceId)?.label,
      " \xB7 ",
      visibleSelection.kind,
      " ",
      visibleSelection.id
    ] })
  ] });
}

// src/client/voiceLocale.ts
var es = {
  browserRequired: "La voz necesita acceso al micr\xF3fono en una conexi\xF3n segura. Puedes escribir.",
  playbackBlocked: "Activa el sonido para escuchar la voz.",
  microphoneDenied: "Habilita el micr\xF3fono o usa el teclado.",
  streamFailed: "La voz se interrumpi\xF3. Puedes volver a conectarte o escribir.",
  unsupportedAudio: "El audio no es compatible.",
  speechUnrecognized: "No pude reconocer lo que dijiste. Intenta de nuevo.",
  recordingTooLong: "Hablemos en frases de menos de 25 segundos.",
  messageTooLong: "Usa mensajes de menos de 4000 caracteres.",
  providerUnavailable: "La voz no est\xE1 disponible. Puedes escribir."
};
var pt = {
  browserRequired: "A voz precisa de acesso ao microfone em uma conex\xE3o segura. Voc\xEA pode escrever.",
  playbackBlocked: "Ative o som para ouvir a voz.",
  microphoneDenied: "Ative o microfone ou use o teclado.",
  streamFailed: "A voz foi interrompida. Voc\xEA pode conectar novamente ou escrever.",
  unsupportedAudio: "O \xE1udio n\xE3o \xE9 compat\xEDvel.",
  speechUnrecognized: "N\xE3o reconheci o que voc\xEA disse. Tente novamente.",
  recordingTooLong: "Vamos falar em frases de menos de 25 segundos.",
  messageTooLong: "Use mensagens com menos de 4000 caracteres.",
  providerUnavailable: "A voz est\xE1 indispon\xEDvel. Voc\xEA pode escrever."
};
var en = {
  browserRequired: "Voice needs microphone access on a secure connection. You can type.",
  playbackBlocked: "Enable sound to hear the voice.",
  microphoneDenied: "Enable the microphone or use text.",
  streamFailed: "Voice was interrupted. Reconnect or use text.",
  unsupportedAudio: "The audio format is incompatible.",
  speechUnrecognized: "I couldn\u2019t recognize that. Try again.",
  recordingTooLong: "Use phrases shorter than 25 seconds.",
  messageTooLong: "Use messages shorter than 4000 characters.",
  providerUnavailable: "Voice is unavailable. You can type."
};
function voiceCopy(locale) {
  return { es, pt, en }[locale];
}
var VoiceLocaleError = class extends Error {
  constructor(key) {
    super(key);
    __publicField(this, "key", key);
  }
};
function voiceError(locale, error, fallback = "providerUnavailable") {
  return voiceCopy(locale)[error instanceof VoiceLocaleError ? error.key : fallback];
}
function voiceRequestError(_status, _code) {
  return new VoiceLocaleError("providerUnavailable");
}
async function voiceResponseError(response) {
  await response.body?.cancel();
  return new VoiceLocaleError("providerUnavailable");
}

// src/client/nativeVoiceTransport.ts
var clientId = () => {
  const key = "flujo-avatar:voice-client";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
};
var voiceHeaders = () => ({ "Content-Type": "application/json", "x-flujo-avatar-client": clientId() });
var localNativeVoiceTransport = Object.freeze({
  scopeKey: "local-native-voice",
  workletUrl: "/avatar-audio-capture.js",
  request: (endpoint, init) => fetch(`/api/avatar/${endpoint}`, init)
});
function snapshotNativeVoiceTransport(value = localNativeVoiceTransport) {
  if (typeof value.scopeKey !== "string" || !value.scopeKey || value.scopeKey.length > 512 || typeof value.workletUrl !== "string" || !value.workletUrl || value.workletUrl.length > 2048 || typeof value.request !== "function") throw new Error("invalid_voice_transport");
  const request = value.request.bind(value);
  return Object.freeze({ scopeKey: value.scopeKey, workletUrl: value.workletUrl, request });
}
var resetBarriers = /* @__PURE__ */ new Map();
function resetNativeHistory(transport, signal) {
  const next = (resetBarriers.get(transport.scopeKey) ?? Promise.resolve()).catch(() => {
  }).then(async () => {
    const owned = AbortSignal.any([signal, AbortSignal.timeout(5e3)]);
    owned.throwIfAborted();
    const response = await transport.request("native-reset", {
      method: "POST",
      headers: voiceHeaders(),
      body: "{}",
      signal: owned
    });
    if (owned.aborted) {
      await response.body?.cancel();
      owned.throwIfAborted();
    }
    if (!response.ok) throw await voiceResponseError(response);
    await response.body?.cancel();
  });
  const settled = next.catch(() => {
  });
  resetBarriers.set(transport.scopeKey, settled);
  void settled.then(() => {
    if (resetBarriers.get(transport.scopeKey) === settled) resetBarriers.delete(transport.scopeKey);
  });
  return next;
}

// src/client/acceptedTaskNarrationTransport.ts
var UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function selection(init) {
  if (init.method !== "POST" || typeof init.body !== "string" || init.body.length > 8192) {
    throw new Error("invalid_narration_selection");
  }
  let value;
  try {
    value = JSON.parse(init.body);
  } catch {
    throw new Error("invalid_narration_selection");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_narration_selection");
  const body = value;
  if (Object.keys(body).some((key) => !["taskId", "locale", "avatar"].includes(key)) || typeof body.taskId !== "string" || !UUID_V4.test(body.taskId) || !["en", "es", "pt"].includes(body.locale)) throw new Error("invalid_narration_selection");
  return { taskId: body.taskId, locale: body.locale };
}
function createAcceptedTaskNarrationTransport(base, binding) {
  const captured = snapshotNativeVoiceTransport(base);
  if (binding && (typeof binding.revision !== "string" || !binding.revision || binding.revision.length > 128 || typeof binding.selectedTaskId !== "function" || typeof binding.postNarration !== "function")) {
    throw new Error("invalid_narration_binding");
  }
  const revision = binding?.revision ?? null;
  const selectedTaskId = binding?.selectedTaskId.bind(binding);
  const postNarration = binding?.postNarration.bind(binding);
  const scopeKey = JSON.stringify([captured.scopeKey, "accepted-task-narration", revision]);
  if (scopeKey.length > 512) throw new Error("invalid_narration_binding");
  return Object.freeze({
    scopeKey,
    workletUrl: captured.workletUrl,
    request: async (endpoint, init) => {
      if (endpoint === "native-result-receipt") throw new Error("narration_receipt_route_disabled");
      if (endpoint !== "native-result") return captured.request(endpoint, init);
      if (!selectedTaskId || !postNarration) throw new Error("narration_transport_disabled");
      init.signal?.throwIfAborted();
      const input = selection(init);
      if (selectedTaskId() !== input.taskId) throw new Error("narration_selection_changed");
      const headers = new Headers(init.headers);
      headers.set("Content-Type", "application/json");
      return postNarration({ ...init, method: "POST", headers, body: JSON.stringify(input) });
    }
  });
}

// src/world/canonical/src/frontend/components/AvatarWorld/WorldScene.tsx
import { useEffect as useEffect3, useRef as useRef3 } from "react";

// src/world/canonical/src/frontend/components/AvatarWorld/world.module.css
var world_default = {
  world: "world_world",
  grain: "world_grain",
  topbar: "world_topbar",
  wordmark: "world_wordmark",
  topActions: "world_topActions",
  brain: "world_brain",
  mapToggle: "world_mapToggle",
  companion: "world_companion",
  presence: "world_presence",
  presenceDot: "world_presenceDot",
  welcome: "world_welcome",
  primary: "world_primary",
  textButton: "world_textButton",
  stylePicker: "world_stylePicker",
  eyes: "world_eyes",
  eye: "world_eye",
  blink: "world_blink",
  eyeHalo: "world_eyeHalo",
  ponder: "world_ponder",
  speak: "world_speak",
  smallEyes: "world_smallEyes",
  companionAside: "world_companionAside",
  mapLayer: "world_mapLayer",
  mapVisible: "world_mapVisible",
  watershed: "world_watershed",
  landscape: "world_landscape",
  terrain: "world_terrain",
  terrainFar: "world_terrainFar",
  riverBank: "world_riverBank",
  river: "world_river",
  reed: "world_reed",
  firefly: "world_firefly",
  landmark: "world_landmark",
  bottomBar: "world_bottomBar",
  composer: "world_composer",
  workControls: "world_workControls",
  attention: "world_attention",
  transcript: "world_transcript",
  message: "world_message",
  proposal: "world_proposal",
  error: "world_error",
  scrim: "world_scrim",
  setup: "world_setup",
  placeSheet: "world_placeSheet",
  sheetHead: "world_sheetHead",
  panelHead: "world_panelHead",
  eyebrow: "world_eyebrow",
  candidates: "world_candidates",
  candidate: "world_candidate",
  connectionForm: "world_connectionForm",
  help: "world_help",
  testDetails: "world_testDetails",
  object: "world_object",
  panel: "world_panel",
  resourceSheet: "world_resourceSheet",
  resourceActions: "world_resourceActions",
  identity: "world_identity",
  talkIdentity: "world_talkIdentity",
  worldScene: "world_worldScene",
  menuToggle: "world_menuToggle",
  controls: "world_controls",
  character: "world_character",
  characterFloat: "world_characterFloat",
  characterShadow: "world_characterShadow",
  shadowFloat: "world_shadowFloat",
  caption: "world_caption",
  landmarkTarget: "world_landmarkTarget"
};

// src/world/canonical/src/frontend/components/AvatarWorld/Watershed.tsx
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
var LANDMARK_POSITIONS = {
  models: [17, 49],
  apps: [77, 59],
  flows: [30, 62],
  automations: [83, 42],
  packages: [72, 76],
  archive: [43, 77],
  settings: [87, 78],
  personas: [65, 49],
  meetings: [15, 72]
};
var PLACE_KINDS = { apps: "app", flows: "flow", personas: "persona", automations: "automation", meetings: "meeting", archive: "artifact", packages: "package" };

// src/world/canonical/src/frontend/components/AvatarWorld/WorldScene.tsx
import { jsx as jsx5 } from "react/jsx-runtime";
var hash = (n) => {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};
var seed = (text) => [...text].reduce((value, char) => value * 31 + char.charCodeAt(0) >>> 0, 7);
function WorldScene(props) {
  const canvas = useRef3(null);
  const current = useRef3(props);
  current.current = props;
  const repaint = useRef3(null);
  useEffect3(() => {
    const element = canvas.current;
    if (!element || /jsdom/i.test(navigator.userAgent)) return;
    const ctx = element.getContext("2d", { alpha: false });
    if (!ctx) return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = query.matches, frame = 0, last = 0, width = 1, height = 1, ratio = 1, life = 0;
    const pointer = { x: 0, y: 0 }, target = { x: 0, y: 0 };
    const resize = () => {
      width = element.clientWidth;
      height = element.clientHeight;
      ratio = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(25e5 / Math.max(1, width * height)));
      element.width = Math.max(1, Math.round(width * ratio));
      element.height = Math.max(1, Math.round(height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw(performance.now());
    };
    const draw = (now) => {
      const { snapshot, phase, level, exploring } = current.current;
      const t = reduced ? 0 : now / 1e3;
      const active = phase === "thinking" || phase === "usingApp";
      const destination = snapshot?.workModel?.ready || (snapshot?.objects.length ?? 0) > 0 ? 1 : 0;
      life = reduced ? destination : life + (destination - life) * 0.04;
      pointer.x += (target.x - pointer.x) * 0.035;
      pointer.y += (target.y - pointer.y) * 0.035;
      ctx.fillStyle = "#050607";
      ctx.fillRect(0, 0, width, height);
      const sky = ctx.createRadialGradient(width * 0.5, height * 0.42, 0, width * 0.5, height * 0.42, width * 0.65);
      sky.addColorStop(0, `rgba(184,198,202,${0.06 + life * 0.06})`);
      sky.addColorStop(0.55, "rgba(94,111,117,.025)");
      sky.addColorStop(1, "rgba(5,6,7,0)");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, width, height);
      for (let i = 0; i < 68; i++) {
        const x = hash(i + 1) * width, y = hash(i + 301) * height * 0.52;
        ctx.fillStyle = `rgba(230,235,236,${(0.04 + hash(i + 61) * 0.23) * (0.7 + Math.sin(t * 0.18 + i) * 0.3)})`;
        ctx.beginPath();
        ctx.arc(x + pointer.x * 3, y, 0.45 + hash(i + 120) * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      const ridge = (x, layer) => height * (0.52 + layer * 0.055) + Math.sin(x / width * 5.8 + layer * 0.8) * height * (0.027 + layer * 4e-3) + Math.sin(x / width * 10.2 + layer * 1.8) * height * 0.026;
      for (let layer = 0; layer < 5; layer++) {
        const shift = reduced ? 0 : pointer.x * (layer + 1) * 4;
        ctx.beginPath();
        ctx.moveTo(-20, height);
        for (let x = -20; x <= width + 20; x += 8) ctx.lineTo(x, ridge(x + shift, layer));
        ctx.lineTo(width + 20, height);
        ctx.closePath();
        const shade = 10 + layer * 3 + life * 2;
        ctx.fillStyle = `rgb(${shade},${shade + 2},${shade + 3})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(195,206,210,${0.035 + layer * 0.012})`;
        ctx.lineWidth = 0.8;
        ctx.stroke();
        for (let row = 0; row < 14; row++) {
          ctx.beginPath();
          for (let x = -20; x <= width + 20; x += 10) {
            const y = ridge(x + shift, layer) + row * (4 + layer * 1.2) + Math.sin(x / 90 + row * 0.15) * row * 0.55;
            if (x === -20) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = `rgba(184,198,203,${(0.012 + life * 8e-3) * (1 - row / 18)})`;
          ctx.lineWidth = 0.65;
          ctx.stroke();
        }
      }
      const streamX = (p) => width * (0.54 + Math.sin(p * 4.4 - 1.1) * (0.015 + p * 0.12)) + pointer.x * 12 * p;
      const streamY = (p) => height * (0.56 + p * 0.5);
      ctx.beginPath();
      for (let i = 0; i <= 100; i++) {
        const p = i / 100, x = streamX(p) - width * (1e-3 + p * p * 0.11), y = streamY(p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let i = 100; i >= 0; i--) {
        const p = i / 100;
        ctx.lineTo(streamX(p) + width * (1e-3 + p * p * 0.11), streamY(p));
      }
      ctx.closePath();
      const water = ctx.createLinearGradient(0, height * 0.55, 0, height);
      water.addColorStop(0, "#69777b");
      water.addColorStop(0.3, "#243035");
      water.addColorStop(1, "#101719");
      ctx.fillStyle = water;
      ctx.globalAlpha = 0.3 + life * 0.4;
      ctx.fill();
      ctx.globalAlpha = 1;
      for (let i = 0; i < 56; i++) {
        const p = (i / 56 + t * (active ? 0.018 : 5e-3)) % 1;
        const spread = width * (1e-3 + p * p * 0.09), x = streamX(p), y = streamY(p);
        ctx.beginPath();
        ctx.ellipse(x + Math.sin(t * 0.3 + i) * spread * 0.4, y, spread * (0.15 + hash(i) * 0.6), 0.35 + p * 1.2, 0, 0, Math.PI);
        ctx.strokeStyle = `rgba(215,229,232,${(0.025 + hash(i + 50) * 0.1) * (0.4 + life * 0.6)})`;
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
      const size = Math.max(0.62, Math.min(1.3, width / 1e3));
      for (const place of Object.keys(LANDMARK_POSITIONS)) {
        const count = snapshot?.objects.filter((object) => object.kind === PLACE_KINDS[place]).length ?? 0;
        const inhabited = place === "models" ? Boolean(snapshot?.workModel?.ready) : place === "settings" || count > 0;
        const [px, py] = LANDMARK_POSITIONS[place];
        const x = Math.max(52, Math.min(width - 52, width * px / 100)), y = height * py / 100;
        ctx.save();
        ctx.translate(x, y - 12);
        ctx.scale(size, size);
        ctx.globalAlpha = inhabited ? 0.9 : 0.3;
        ctx.fillStyle = "rgba(0,0,0,.4)";
        ctx.beginPath();
        ctx.ellipse(4, 19, 48, 12, -0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#161c1f";
        ctx.beginPath();
        ctx.ellipse(0, 9, 38, 15, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#343d40";
        ctx.beginPath();
        ctx.ellipse(0, 4, 38, 13, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(190,206,209,.18)";
        ctx.lineWidth = 1;
        ctx.stroke();
        if (place === "models" || place === "meetings") {
          ctx.fillStyle = "#101619";
          ctx.beginPath();
          ctx.ellipse(0, 1, 26, 8, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = inhabited ? "#a6b8b9" : "#53666c";
          ctx.beginPath();
          ctx.ellipse(0, 0, 20, 5, 0, 0, Math.PI * 2);
          ctx.stroke();
          if (place === "models") {
            ctx.fillStyle = "#7c9297";
            ctx.beginPath();
            ctx.moveTo(-6, -1);
            ctx.quadraticCurveTo(-12, -25, 0, -40);
            ctx.quadraticCurveTo(14, -23, 6, -1);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = "#d1dedb";
            ctx.beginPath();
            ctx.ellipse(-2, -23, 3, 11, 0.2, 0, Math.PI * 2);
            ctx.fill();
          } else {
            for (let i = 0; i < 4; i++) {
              const angle = i * Math.PI / 2 + 0.4;
              ctx.fillStyle = "#526165";
              ctx.beginPath();
              ctx.ellipse(Math.cos(angle) * 30, Math.sin(angle) * 9 - 4, 5, 6, 0, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        } else if (place === "apps") {
          ctx.fillStyle = "#566469";
          ctx.beginPath();
          ctx.moveTo(-30, -4);
          ctx.quadraticCurveTo(0, 22, 30, -4);
          ctx.lineTo(23, -8);
          ctx.lineTo(-23, -8);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = "#a4b2b4";
          ctx.beginPath();
          ctx.moveTo(0, -8);
          ctx.lineTo(0, -48);
          ctx.stroke();
          ctx.fillStyle = "#c6cecb";
          ctx.beginPath();
          ctx.moveTo(-2, -45);
          ctx.quadraticCurveTo(-26, -28, -2, -15);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "#879796";
          ctx.beginPath();
          ctx.moveTo(3, -43);
          ctx.quadraticCurveTo(31, -28, 3, -18);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillStyle = "#293236";
          ctx.beginPath();
          ctx.roundRect(-22, -28, 39, 32, 6);
          ctx.fill();
          ctx.fillStyle = "#1b2529";
          ctx.beginPath();
          ctx.moveTo(17, -27);
          ctx.lineTo(31, -35);
          ctx.lineTo(31, -3);
          ctx.lineTo(17, 4);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "#778386";
          ctx.beginPath();
          ctx.moveTo(-28, -27);
          ctx.quadraticCurveTo(-14, -48, -4, -51);
          ctx.lineTo(26, -41);
          ctx.lineTo(17, -23);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "#455257";
          ctx.beginPath();
          ctx.moveTo(17, -23);
          ctx.lineTo(26, -41);
          ctx.lineTo(37, -32);
          ctx.lineTo(31, -27);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = inhabited ? "#d2d9c8" : "#4b595d";
          ctx.beginPath();
          ctx.roundRect(-13, -21, 8, 10, 3);
          ctx.fill();
          ctx.fillStyle = "#11191c";
          ctx.beginPath();
          ctx.roundRect(4, -14, 9, 18, 4);
          ctx.fill();
          if (place === "automations") {
            const running = snapshot?.objects.some((object) => object.kind === "automation" && object.state === "running");
            ctx.save();
            ctx.translate(1, -30);
            ctx.rotate(running ? t * 0.8 : 0);
            ctx.strokeStyle = "#b9c5c5";
            ctx.lineWidth = 3;
            for (let i = 0; i < 4; i++) {
              ctx.rotate(Math.PI / 2);
              ctx.beginPath();
              ctx.moveTo(3, 0);
              ctx.lineTo(24, 0);
              ctx.stroke();
            }
            ctx.restore();
            ctx.fillStyle = "#d5ded9";
            ctx.beginPath();
            ctx.arc(1, -30, 4, 0, Math.PI * 2);
            ctx.fill();
          }
          if (place === "archive") {
            ctx.fillStyle = "#536467";
            ctx.beginPath();
            ctx.roundRect(-33, -5, 14, 14, 3);
            ctx.fill();
            ctx.strokeStyle = "#9aabac";
            ctx.stroke();
          }
        }
        for (let i = 0; i < Math.min(count, 5); i++) {
          const tx = (i % 2 ? -1 : 1) * (32 + i * 6), ty = 3 + i * 3;
          ctx.strokeStyle = "#526c65";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.quadraticCurveTo(tx - 3, ty - 11, tx, ty - 19);
          ctx.stroke();
          ctx.fillStyle = "#89988c";
          ctx.beginPath();
          ctx.ellipse(tx - 4, ty - 15, 7, 3.5, -0.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.ellipse(tx + 4, ty - 22, 6, 3, 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      for (const object of snapshot?.objects.slice(0, 80) ?? []) {
        const id = seed(`${object.kind}:${object.id}`), p = 0.2 + hash(id) * 0.57;
        const side = hash(id + 3) > 0.5 ? 1 : -1;
        const x = streamX(p) + side * width * (0.04 + hash(id + 1) * 0.2), y = streamY(p) - height * 0.035;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 14 + p * 14);
        glow.addColorStop(0, "rgba(214,223,218,.10)");
        glow.addColorStop(1, "rgba(214,223,218,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(x - 30, y - 30, 60, 60);
        ctx.fillStyle = `rgba(228,232,222,${0.35 + 0.18 * Math.sin(t * 0.4 + hash(id) * 10)})`;
        ctx.beginPath();
        ctx.arc(x, y, 0.7 + p, 0, Math.PI * 2);
        ctx.fill();
      }
      const breath = phase === "speaking" || phase === "listening" ? level : active ? 0.18 + Math.sin(t * 1.6) * 0.06 : 0.02;
      const halo = ctx.createRadialGradient(width * 0.5, height * 0.52, 0, width * 0.5, height * 0.52, width * 0.26);
      halo.addColorStop(0, `rgba(215,229,228,${0.025 + breath * 0.055})`);
      halo.addColorStop(1, "rgba(215,229,228,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, width, height);
      const mist = ctx.createLinearGradient(0, height * 0.48, 0, height * 0.72);
      mist.addColorStop(0, "rgba(150,175,181,0)");
      mist.addColorStop(0.5, `rgba(150,175,181,${0.025 + life * 0.025})`);
      mist.addColorStop(1, "rgba(150,175,181,0)");
      ctx.fillStyle = mist;
      ctx.fillRect(0, 0, width, height);
      const vignette = ctx.createRadialGradient(width * 0.5, height * 0.48, width * 0.18, width * 0.5, height * 0.48, Math.max(width, height) * 0.65);
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(1, `rgba(0,0,0,${exploring ? 0.38 : 0.7})`);
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, width, height);
    };
    const tick = (now) => {
      if (document.hidden || reduced) {
        frame = 0;
        return;
      }
      if (now - last >= 40) {
        draw(now);
        last = now;
      }
      frame = requestAnimationFrame(tick);
    };
    const resume = () => {
      cancelAnimationFrame(frame);
      draw(performance.now());
      if (!reduced && !document.hidden) frame = requestAnimationFrame(tick);
    };
    repaint.current = () => {
      if (reduced && !document.hidden) draw(performance.now());
    };
    const move = (event) => {
      if (reduced) return;
      target.x = (event.clientX / innerWidth - 0.5) * 2;
      target.y = (event.clientY / innerHeight - 0.5) * 2;
    };
    const motion = () => {
      reduced = query.matches;
      target.x = target.y = pointer.x = pointer.y = 0;
      resume();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("visibilitychange", resume);
    query.addEventListener("change", motion);
    resize();
    resume();
    return () => {
      repaint.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("pointermove", move);
      document.removeEventListener("visibilitychange", resume);
      query.removeEventListener("change", motion);
    };
  }, []);
  useEffect3(() => {
    repaint.current?.();
  }, [props.snapshot, props.phase, props.exploring]);
  return /* @__PURE__ */ jsx5("canvas", { ref: canvas, className: world_default.worldScene, "aria-hidden": "true" });
}

// src/client/useNativeRouterVoice.ts
import { useCallback, useEffect as useEffect4, useRef as useRef4, useState as useState2 } from "react";

// src/client/audio.ts
function wavFromPcm(chunks, sourceRate, targetRate = 16e3) {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isInteger(targetRate) || targetRate <= 0) throw new RangeError("Audio sample rates must be positive.");
  const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Float32Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  const length = Math.floor(count * targetRate / sourceRate);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const label = (pos, value) => [...value].forEach((c, i) => view.setUint8(pos + i, c.charCodeAt(0)));
  label(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  label(8, "WAVE");
  label(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, "data");
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const from = i * sourceRate / targetRate, to = Math.min(count, (i + 1) * sourceRate / targetRate);
    let sum = 0;
    for (let j = Math.floor(from); j < Math.ceil(to); j++) {
      const weight = Math.min(j + 1, to) - Math.max(j, from);
      sum += (Number.isFinite(joined[j]) ? joined[j] : 0) * weight;
    }
    const value = Math.max(-1, Math.min(1, sum / (to - from)));
    view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true);
  }
  return new Uint8Array(buffer);
}
var Pcm16Stream = class {
  constructor() {
    __publicField(this, "carry");
  }
  decode(bytes) {
    const result = new Float32Array(Math.floor((bytes.length + (this.carry === void 0 ? 0 : 1)) / 2));
    let offset = 0, index = 0;
    const signed = (value) => (value >= 32768 ? value - 65536 : value) / 32768;
    if (this.carry !== void 0 && bytes.length) {
      result[index++] = signed(this.carry | bytes[offset++] << 8);
      this.carry = void 0;
    }
    while (offset + 1 < bytes.length) {
      result[index++] = signed(bytes[offset] | bytes[offset + 1] << 8);
      offset += 2;
    }
    if (offset < bytes.length) this.carry = bytes[offset];
    return result;
  }
  finish() {
    if (this.carry !== void 0) throw new Error("The voice stream ended in the middle of an audio sample.");
  }
};
function base64Bytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}

// src/client/locale.ts
var DEFAULT_LOCALE = "en";
function normalizeLocale(value) {
  return value === "es" || value === "pt" ? value : DEFAULT_LOCALE;
}

// src/client/utteranceObserver.ts
var UtteranceCollector = class {
  constructor(sampleRate, maximumSeconds = 25) {
    __publicField(this, "sampleRate", sampleRate);
    __publicField(this, "maximumSeconds", maximumSeconds);
    __publicField(this, "pre", []);
    __publicField(this, "preSamples", 0);
    __publicField(this, "chunks", []);
    __publicField(this, "samples", 0);
    __publicField(this, "onset", 0);
    __publicField(this, "quiet", 0);
    __publicField(this, "active", false);
    __publicField(this, "draining", false);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 192e3) throw new RangeError("Invalid microphone rate.");
    if (!Number.isFinite(maximumSeconds) || maximumSeconds < 1 || maximumSeconds > 25) throw new RangeError("Invalid utterance limit.");
  }
  reset() {
    this.pre.forEach((chunk) => chunk.fill(0));
    this.chunks.forEach((chunk) => chunk.fill(0));
    this.pre = [];
    this.preSamples = 0;
    this.chunks = [];
    this.samples = 0;
    this.onset = 0;
    this.quiet = 0;
    this.active = false;
    this.draining = false;
  }
  push(samples, voiced) {
    if (!(samples instanceof Float32Array) || !samples.length || samples.length > this.sampleRate) return;
    const duration = samples.length / this.sampleRate;
    this.quiet = voiced ? 0 : this.quiet + duration;
    if (this.draining) {
      if (this.quiet >= 0.5) this.reset();
      return;
    }
    if (!this.active) {
      this.onset = voiced ? this.onset + duration : 0;
      this.pre.push(samples.slice());
      this.preSamples += samples.length;
      const maximum = Math.ceil(this.sampleRate * (0.2 + this.onset));
      while (this.preSamples > maximum) {
        const first = this.pre[0], excess = this.preSamples - maximum;
        if (first.length <= excess) {
          this.pre.shift();
          this.preSamples -= first.length;
        } else {
          this.pre[0] = first.slice(excess);
          this.preSamples -= excess;
        }
      }
      if (this.onset < 0.12) return;
      this.active = true;
      this.chunks = this.pre;
      this.samples = this.preSamples;
      this.pre = [];
      this.preSamples = 0;
    } else {
      const remaining = Math.max(0, Math.floor(this.sampleRate * this.maximumSeconds) - this.samples);
      const chunk = samples.slice(0, remaining);
      if (chunk.length) {
        this.chunks.push(chunk);
        this.samples += chunk.length;
      }
    }
    const capped = this.samples >= this.sampleRate * this.maximumSeconds;
    if (!capped && this.quiet < 0.5) return;
    const result = { chunks: this.chunks, sampleRate: this.sampleRate, capped };
    this.chunks = [];
    this.samples = 0;
    this.active = false;
    this.onset = 0;
    this.draining = capped && this.quiet < 0.5;
    if (!this.draining) this.reset();
    return result;
  }
};

// src/client/qwenPlayback.ts
var QWEN_PLAYBACK_RATE = 24e3;
var QWEN_MAX_CHUNK_SAMPLES = QWEN_PLAYBACK_RATE * 4;
var QWEN_MAX_QUEUED_SAMPLES = QWEN_PLAYBACK_RATE * 5;
var QWEN_MAX_RESPONSE_SAMPLES = QWEN_PLAYBACK_RATE * 31;
var QWEN_MAX_RESPONSE_IDS = 128;
var QWEN_MAX_PENDING_SEGMENTS = 512;
var QWEN_OUTPUT_STALL_MS = 5e3;
var browserTimer = {
  now: () => performance.now(),
  schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
  cancel: (handle) => clearTimeout(handle)
};
var identifier = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
var QwenPlayback = class {
  constructor(options) {
    __publicField(this, "options", options);
    __publicField(this, "context");
    __publicField(this, "analyser");
    __publicField(this, "timer");
    __publicField(this, "responses", /* @__PURE__ */ new Map());
    __publicField(this, "poll");
    __publicField(this, "pollEpoch", 0);
    __publicField(this, "closed", false);
    __publicField(this, "closePromise");
    __publicField(this, "outputTime", 0);
    __publicField(this, "renderTime", 0);
    __publicField(this, "scheduled", 0);
    __publicField(this, "progressAt");
    __publicField(this, "progressSamples", 0);
    this.timer = options.timer ?? browserTimer;
    this.progressAt = this.timer.now();
    this.context = (options.createContext ?? (() => new AudioContext({ sampleRate: QWEN_PLAYBACK_RATE })))();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.connect(this.context.destination);
  }
  get isClosed() {
    return this.closed;
  }
  get queuedSamples() {
    let count = 0;
    for (const response of this.responses.values()) if (!response.cancelled) count += response.received - response.played;
    return count;
  }
  get pendingSegments() {
    let count = 0;
    for (const response of this.responses.values()) count += response.segments.length;
    return count;
  }
  isSuppressed(id) {
    return this.closed || this.responses.get(id)?.cancelled === true;
  }
  async resume() {
    if (this.closed) return false;
    try {
      await this.context.resume();
    } catch {
      this.fail("audio_device");
      return false;
    }
    return !this.closed;
  }
  /** Called for response.created; IDs can never be reused, even after drain. */
  begin(id) {
    if (this.closed) return false;
    if (!identifier(id)) return this.fail("invalid_response");
    if (this.responses.has(id)) return false;
    if (this.responses.size >= QWEN_MAX_RESPONSE_IDS) return this.fail("playback_capacity");
    this.responses.set(id, { id, received: 0, played: 0, retired: 0, segments: [], done: false, acknowledged: false, cancelled: false });
    return true;
  }
  /** A wire delta contains complete little-endian PCM16 samples at24k, without a WAV header. */
  enqueue(id, bytes) {
    if (this.closed || this.responses.get(id)?.cancelled) return false;
    const response = this.responses.get(id);
    if (!response) return this.fail("response_not_started");
    if (response.done) return this.fail("audio_after_done");
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length % 2 || bytes.length > QWEN_MAX_CHUNK_SAMPLES * 2) return this.fail("invalid_pcm");
    this.refresh();
    if (this.closed || response.cancelled) return false;
    const samples = bytes.length / 2;
    if (this.queuedSamples + samples > QWEN_MAX_QUEUED_SAMPLES || response.received + samples > QWEN_MAX_RESPONSE_SAMPLES || this.pendingSegments >= QWEN_MAX_PENDING_SEGMENTS) return this.fail("playback_capacity");
    try {
      const pcm = new Pcm16Stream().decode(bytes);
      const buffer = this.context.createBuffer(1, samples, QWEN_PLAYBACK_RATE);
      buffer.getChannelData(0).set(pcm);
      const source = this.context.createBufferSource();
      const start = Math.max(this.scheduled, this.context.currentTime + 0.025);
      const segment = { start, samples, source };
      source.buffer = buffer;
      source.connect(this.analyser);
      source.onended = () => {
        this.releaseSource(segment, false);
        if (!this.closed && !response.cancelled) {
          this.refresh();
          this.armPoll();
        }
      };
      response.segments.push(segment);
      response.received += samples;
      source.start(start);
      this.scheduled = start + samples / QWEN_PLAYBACK_RATE;
      this.armPoll();
      return true;
    } catch {
      return this.fail("audio_device");
    }
  }
  /** response.output_audio.done seals audio; ACK waits for the final output interval. */
  done(id) {
    if (this.closed || this.responses.get(id)?.cancelled) return false;
    const response = this.responses.get(id);
    if (!response) return this.fail("response_not_started");
    response.done = true;
    this.refresh();
    this.armPoll();
    return !this.closed;
  }
  cursor(id) {
    if (!this.closed) this.refresh();
    const response = this.responses.get(id);
    return response ? { receivedSamples: response.received, playedSamples: response.played, done: response.done, cancelled: response.cancelled } : void 0;
  }
  /** Immediate local stop + permanent tombstone; return/send only its own conservative cursor. */
  clear(id) {
    if (this.closed) return void 0;
    let response = this.responses.get(id);
    if (!response) {
      if (!this.begin(id)) return void 0;
      response = this.responses.get(id);
      response.cancelled = true;
      response.done = true;
      response.acknowledged = true;
      return void 0;
    }
    if (response.cancelled) return void 0;
    const time = this.readOutputTime();
    if (time === void 0) return void 0;
    this.measure(response, time);
    response.cancelled = true;
    response.done = true;
    for (const segment of response.segments) this.releaseSource(segment, true);
    response.segments = [];
    this.recomputeScheduled();
    const ack = this.ack(response);
    if (!response.acknowledged) {
      response.acknowledged = true;
      this.options.onAck(ack);
    }
    return ack;
  }
  clearAll() {
    const acks = [];
    for (const id of this.responses.keys()) {
      const ack = this.clear(id);
      if (ack) acks.push(ack);
    }
    return acks;
  }
  /** Teardown emits no captions/ACKs into a potentially different account/session. */
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.pollEpoch++;
    if (this.poll !== void 0) this.timer.cancel(this.poll);
    this.poll = void 0;
    for (const response of this.responses.values()) {
      for (const segment of response.segments) this.releaseSource(segment, true);
      response.segments = [];
    }
    this.responses.clear();
    this.scheduled = 0;
    this.analyser.disconnect();
    this.closePromise = Promise.resolve().then(() => this.context.close());
    return this.closePromise;
  }
  fail(code) {
    if (!this.closed) {
      void this.close().catch(() => {
      });
      this.options.onError?.(code);
    }
    return false;
  }
  ack(response) {
    const milliseconds = Math.round(response.played * 1e3 / QWEN_PLAYBACK_RATE);
    return { type: "playback.ack", response_id: response.id, item_id: `item_${response.id}`, played_ms: milliseconds, committed_ms: milliseconds };
  }
  readOutputTime() {
    const rendered = this.context.currentTime;
    if (!Number.isFinite(rendered) || rendered < this.renderTime || this.context.state === "closed") {
      this.fail("output_clock");
      return;
    }
    this.renderTime = rendered;
    let output;
    try {
      const timestamp = this.context.getOutputTimestamp?.();
      if (timestamp && typeof timestamp.contextTime === "number" && Number.isFinite(timestamp.contextTime) && timestamp.contextTime >= 0 && timestamp.contextTime <= rendered && typeof timestamp.performanceTime === "number" && Number.isFinite(timestamp.performanceTime) && timestamp.performanceTime > 0) output = timestamp.contextTime;
    } catch {
    }
    if (output === void 0) {
      const latency = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
      output = Math.max(0, rendered - latency(this.context.baseLatency, 0.01) - latency(this.context.outputLatency, 0.1));
    }
    this.outputTime = Math.max(this.outputTime, output);
    return this.outputTime;
  }
  measure(response, output) {
    let played = response.retired;
    const pending = [];
    for (const segment of response.segments) {
      const count = Math.min(segment.samples, Math.max(0, Math.floor((output - segment.start) * QWEN_PLAYBACK_RATE + 1e-6)));
      played += count;
      if (count === segment.samples) {
        response.retired += count;
        this.releaseSource(segment, false);
      } else pending.push(segment);
    }
    response.segments = pending;
    response.played = Math.max(response.played, played);
  }
  refresh() {
    if (this.closed) return;
    const output = this.readOutputTime();
    if (output === void 0) return;
    let progress = 0;
    for (const response of this.responses.values()) {
      if (response.cancelled) continue;
      this.measure(response, output);
      progress += response.played;
      if (response.done && !response.acknowledged && response.played === response.received) {
        response.acknowledged = true;
        this.options.onAck(this.ack(response));
        if (this.closed) return;
      }
    }
    if (progress !== this.progressSamples || !this.queuedSamples) {
      this.progressSamples = progress;
      this.progressAt = this.timer.now();
    } else if (this.timer.now() - this.progressAt >= QWEN_OUTPUT_STALL_MS) this.fail("output_stalled");
  }
  armPoll() {
    if (this.closed || this.poll !== void 0 || !this.queuedSamples) return;
    const epoch = this.pollEpoch;
    this.poll = this.timer.schedule(() => {
      if (this.closed || epoch !== this.pollEpoch) return;
      this.poll = void 0;
      this.refresh();
      this.armPoll();
    }, 20);
  }
  recomputeScheduled() {
    this.scheduled = this.context.currentTime;
    for (const response of this.responses.values()) for (const segment of response.segments)
      this.scheduled = Math.max(this.scheduled, segment.start + segment.samples / QWEN_PLAYBACK_RATE);
  }
  releaseSource(segment, stop) {
    const source = segment.source;
    if (!source) return;
    segment.source = void 0;
    source.onended = null;
    if (stop) {
      try {
        source.stop();
      } catch {
      }
    }
    source.disconnect();
    source.buffer = null;
  }
};

// src/client/nativeRouterPlayback.ts
var NATIVE_ROUTER_RATE = 24e3;
var NATIVE_ROUTER_RATE_QUALIFICATION = "assumed";
var MAX_WIRE_BYTES = 4 * 1024 * 1024;
var MAX_EVENT_CHARS = 2 * 1024 * 1024;
var FRAME_SAMPLES = NATIVE_ROUTER_RATE;
var nativeIdentifier = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
var invalid = () => {
  throw new Error("invalid_native_stream");
};
var record = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
function nativeAudioBytes(data) {
  if (typeof data !== "string" || !data.length || data.length > MAX_EVENT_CHARS || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return invalid();
  let binary;
  try {
    binary = atob(data);
  } catch {
    return invalid();
  }
  if (btoa(binary) !== data) return invalid();
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
var NativeTurnProtocol = class {
  constructor() {
    __publicField(this, "turnId");
    __publicField(this, "terminal", false);
    __publicField(this, "bytes", 0);
    __publicField(this, "caption", "");
  }
  accept(value) {
    if (!record(value) || this.terminal || !nativeIdentifier(value.turnId)) return invalid();
    const keys = {
      start: ["type", "turnId", "sampleRate", "sampleRateQualification"],
      audio: ["type", "turnId", "data"],
      caption: ["type", "turnId", "text"],
      complete: ["type", "turnId", "text", "samples", "usage"],
      error: ["type", "turnId", "code", "error"]
    };
    const allowed = typeof value.type === "string" ? keys[value.type] : void 0;
    if (!allowed || Object.keys(value).some((key) => !allowed.includes(key))) return invalid();
    if (value.type === "start") {
      if (this.turnId || value.sampleRate !== NATIVE_ROUTER_RATE || value.sampleRateQualification !== NATIVE_ROUTER_RATE_QUALIFICATION) return invalid();
      this.turnId = value.turnId;
    } else {
      if (!this.turnId || value.turnId !== this.turnId) return invalid();
      if (value.type === "audio") {
        if (typeof value.data !== "string") return invalid();
        this.bytes += nativeAudioBytes(value.data).length;
        if (this.bytes > QWEN_MAX_RESPONSE_SAMPLES * 2) return invalid();
      } else if (value.type === "caption" || value.type === "complete") {
        if (typeof value.text !== "string" || value.text.length > 8e3 || !value.text.startsWith(this.caption)) return invalid();
        this.caption = value.text;
        if (value.type === "complete") {
          if (!Number.isInteger(value.samples) || Number(value.samples) <= 0 || Number(value.samples) !== this.bytes / 2 || !record(value.usage) || JSON.stringify(value.usage).length > 4096) return invalid();
          this.terminal = true;
        }
      } else if (value.type === "error") {
        if (typeof value.code !== "string" || !/^[a-z_]{1,80}$/.test(value.code) || value.error !== void 0 && (typeof value.error !== "string" || value.error.length > 500)) return invalid();
        this.terminal = true;
      }
    }
    return value;
  }
  finish() {
    if (!this.terminal) invalid();
  }
};
function aborted() {
  return new DOMException("The native turn was cancelled.", "AbortError");
}
function nativeAbortable(promise, signal) {
  if (signal.aborted) {
    void promise.catch(() => {
    });
    return Promise.reject(aborted());
  }
  return new Promise((resolve, reject) => {
    const cancel = () => {
      cleanup();
      reject(aborted());
    };
    const cleanup = () => signal.removeEventListener("abort", cancel);
    signal.addEventListener("abort", cancel, { once: true });
    promise.then((value) => {
      cleanup();
      resolve(value);
    }, (error) => {
      cleanup();
      reject(error);
    });
  });
}
async function readNativeTurn(response, signal, event) {
  if (!response.body || !/^application\/(?:x-)?ndjson(?:;|$)/i.test(response.headers.get("content-type") ?? "")) invalid();
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const protocol = new NativeTurnProtocol();
  let pending = "", size = 0, ended = false;
  const line = async (text) => {
    if (signal.aborted) throw aborted();
    if (!text.trim()) return;
    if (text.length > MAX_EVENT_CHARS) invalid();
    await event(protocol.accept(JSON.parse(text)));
    if (signal.aborted) throw aborted();
  };
  try {
    while (true) {
      const result = await nativeAbortable(reader.read(), signal);
      if (result.done) {
        ended = true;
        break;
      }
      size += result.value.byteLength;
      if (size > MAX_WIRE_BYTES) invalid();
      pending += decoder.decode(result.value, { stream: true });
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const next = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        await line(next);
      }
      if (pending.length > MAX_EVENT_CHARS) invalid();
    }
    pending += decoder.decode();
    if (pending.trim()) await line(pending);
    protocol.finish();
  } finally {
    if (!ended) {
      let timer;
      try {
        await Promise.race([reader.cancel().catch(() => {
        }), new Promise((resolve) => {
          timer = setTimeout(resolve, 100);
        })]);
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      reader.releaseLock();
    } catch {
    }
  }
}
var defaultTimer = {
  now: () => performance.now(),
  schedule: (callback, ms) => setTimeout(callback, ms),
  cancel: (handle) => clearTimeout(handle)
};
var NativeRouterPlayback = class {
  constructor(options) {
    __publicField(this, "options", options);
    __publicField(this, "player");
    __publicField(this, "timer");
    __publicField(this, "turns", /* @__PURE__ */ new Map());
    __publicField(this, "closed", false);
    this.timer = options.timer ?? defaultTimer;
    this.player = new QwenPlayback({
      createContext: options.createContext,
      timer: this.timer,
      onError: () => {
        this.invalidate();
        options.onError?.();
      },
      onAck: (ack) => {
        const turn = this.turns.get(ack.response_id), cursor = this.player.cursor(ack.response_id);
        if (this.closed || !turn || !cursor || turn.receiptEmitted) return;
        const complete = turn.sealed && !turn.cancelled && cursor.done && cursor.receivedSamples > 0 && cursor.receivedSamples === cursor.playedSamples;
        if (!turn.cancelled && !complete) return;
        turn.receiptEmitted = true;
        options.onPlayed({ turnId: ack.response_id, playedSamples: cursor.playedSamples, complete });
      }
    });
  }
  get context() {
    return this.player.context;
  }
  get analyser() {
    return this.player.analyser;
  }
  get queuedSamples() {
    return this.player.queuedSamples;
  }
  get isClosed() {
    return this.closed || this.player.isClosed;
  }
  resume() {
    return this.player.resume();
  }
  begin(turnId) {
    if (this.closed || this.turns.has(turnId) || !nativeIdentifier(turnId) || !this.player.begin(turnId)) return false;
    this.turns.set(turnId, { controller: new AbortController(), sealed: false, cancelled: false, receiptEmitted: false, received: 0, writer: false });
    return true;
  }
  wait(ms, signal) {
    if (signal.aborted || this.isClosed) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.timer.cancel(handle);
        signal.removeEventListener("abort", cancel);
        reject(aborted());
      };
      const handle = this.timer.schedule(() => {
        signal.removeEventListener("abort", cancel);
        resolve();
      }, ms);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
  async enqueue(turnId, bytes, signal) {
    const turn = this.turns.get(turnId);
    if (!turn || turn.sealed || turn.cancelled || turn.writer || this.isClosed || !(bytes instanceof Uint8Array) || !bytes.length) throw aborted();
    const combined = AbortSignal.any([signal, turn.controller.signal]);
    if (combined.aborted) throw aborted();
    if (turn.received + bytes.length > QWEN_MAX_RESPONSE_SAMPLES * 2) invalid();
    turn.writer = true;
    try {
      const joined = new Uint8Array(bytes.length + (turn.carry === void 0 ? 0 : 1));
      if (turn.carry !== void 0) joined[0] = turn.carry;
      joined.set(bytes, turn.carry === void 0 ? 0 : 1);
      turn.received += bytes.length;
      turn.carry = joined.length % 2 ? joined[joined.length - 1] : void 0;
      const even = joined.length - joined.length % 2;
      for (let offset = 0; offset < even; ) {
        const count = Math.min(FRAME_SAMPLES * 2, even - offset);
        while (true) {
          if (combined.aborted || this.isClosed) throw aborted();
          this.player.cursor(turnId);
          if (this.isClosed) throw aborted();
          if (this.player.queuedSamples + count / 2 <= QWEN_MAX_QUEUED_SAMPLES && this.player.pendingSegments < 512) break;
          await this.wait(20, combined);
        }
        if (combined.aborted || !this.player.enqueue(turnId, joined.subarray(offset, offset + count))) throw aborted();
        offset += count;
      }
    } finally {
      turn.writer = false;
    }
  }
  async drain(turnId, expectedSamples, signal) {
    const turn = this.turns.get(turnId), cursor = this.player.cursor(turnId);
    if (!turn || turn.cancelled || turn.writer || turn.carry !== void 0 || !cursor || !Number.isInteger(expectedSamples) || expectedSamples <= 0 || expectedSamples !== cursor.receivedSamples || expectedSamples * 2 !== turn.received) return invalid();
    const combined = AbortSignal.any([signal, turn.controller.signal]);
    if (combined.aborted || this.isClosed) throw aborted();
    turn.sealed = true;
    if (!this.player.done(turnId)) throw aborted();
    while (true) {
      if (combined.aborted || this.isClosed) throw aborted();
      const played = this.player.cursor(turnId);
      if (played?.playedSamples === expectedSamples) return;
      await this.wait(20, combined);
    }
  }
  cancel(turnId) {
    const turn = this.turns.get(turnId);
    if (!turn || turn.cancelled || this.closed) return;
    turn.cancelled = true;
    turn.carry = void 0;
    turn.controller.abort();
    this.player.clear(turnId);
  }
  invalidate() {
    this.closed = true;
    for (const turn of this.turns.values()) turn.controller.abort();
  }
  close() {
    this.invalidate();
    this.turns.clear();
    return this.player.close();
  }
};

// src/client/useNativeRouterVoice.ts
var cancelled = () => new DOMException("The native voice turn was cancelled.", "AbortError");
function useNativeRouterVoice(options) {
  const opts = useRef4(options);
  opts.current = options;
  const nextAvatar = useRef4({ id: options.avatar, prop: options.avatar });
  if (nextAvatar.current.prop !== options.avatar) nextAvatar.current = { id: options.avatar, prop: options.avatar };
  const session = useRef4(null);
  const [connected, setConnected] = useState2(false), [connecting, setConnecting] = useState2(false);
  const [phase, setPhase] = useState2("idle"), [muted, setMuted] = useState2(false);
  const [hasMicrophone, setHasMicrophone] = useState2(false);
  const [audioLevel, setAudioLevel] = useState2(0), [error, setError] = useState2("");
  const pump = useRef4(() => {
  }), observe = useRef4(() => {
  });
  const fail = useRef4(() => {
  });
  const current = useCallback((s) => session.current === s && !s.abort.signal.aborted && s.transport.scopeKey === (opts.current.transport?.scopeKey ?? localNativeVoiceTransport.scopeKey), []);
  const liveTurn = useCallback((s, t) => current(s) && s.response === t && s.generation === t.generation && !t.abort.signal.aborted, [current]);
  const refresh = useCallback((s) => {
    if (!current(s) || !s.ready) return;
    const responding = s.response && !s.response.abort.signal.aborted && s.generation === s.response.generation;
    setPhase(s.capturing ? "listening" : responding ? s.playback?.queuedSamples ? "speaking" : "thinking" : s.muted || !s.stream ? "idle" : "listening");
  }, [current]);
  const invalidateObserver = useCallback((s) => {
    s.observerEpoch++;
    s.observer?.abort();
    s.observer = void 0;
    s.observation = void 0;
  }, []);
  const stopResponse = useCallback((s, hold, dropPending = true) => {
    s.generation++;
    s.manualHold = hold;
    if (dropPending) {
      s.pending = void 0;
      s.results = [];
    }
    const turn = s.response;
    turn?.abort.abort();
    if (turn?.turnId) s.playback?.cancel(turn.turnId);
    setAudioLevel(0);
    if (current(s)) {
      opts.current.onInterrupted?.();
      setPhase(s.muted ? "idle" : "listening");
    }
  }, [current]);
  const disconnect = useCallback(() => {
    const old = session.current;
    session.current = null;
    if (old) {
      opts.current.onInterrupted?.();
      old.abort.abort();
      old.response?.abort.abort();
      invalidateObserver(old);
      old.acknowledgements.forEach((controller) => controller.abort());
      old.acknowledgements.clear();
      old.pending = void 0;
      old.results = [];
      old.resultIds.clear();
      old.collector?.reset();
      if (old.raf !== void 0) cancelAnimationFrame(old.raf);
      if (old.capture) {
        old.capture.port.onmessage = null;
        old.capture.disconnect();
      }
      old.input?.disconnect();
      old.silent?.disconnect();
      old.stream?.getTracks().forEach((track) => track.stop());
      void old.context?.close().catch(() => {
      });
      void old.playback?.close().catch(() => {
      });
    }
    setConnected(false);
    setHasMicrophone(false);
    setConnecting(false);
    setMuted(false);
    setPhase("idle");
    setAudioLevel(0);
  }, [invalidateObserver]);
  fail.current = (s) => {
    if (current(s)) {
      disconnect();
      setError(voiceCopy(s.locale).streamFailed);
    }
  };
  const request = useCallback(async (s, path, body, signal, timeout = 45e3) => {
    if (!current(s)) throw cancelled();
    const response = await s.transport.request(path, {
      method: "POST",
      headers: voiceHeaders(),
      body: JSON.stringify({ ...body, locale: s.locale }),
      signal: AbortSignal.any([signal, s.abort.signal, AbortSignal.timeout(timeout)])
    });
    if (!current(s)) {
      await response.body?.cancel();
      throw cancelled();
    }
    if (!response.ok) {
      const error2 = await voiceResponseError(response);
      if ((response.status === 401 || response.status === 403) && current(s)) {
        disconnect();
        setError(voiceError(s.locale, error2));
      }
      throw error2;
    }
    return response;
  }, [current, disconnect]);
  const played = useCallback((s, receipt) => {
    if (!current(s)) return;
    const accountEpoch = s.accountEpoch;
    const publish = async () => {
      if (!current(s) || accountEpoch !== s.accountEpoch) return;
      const controller = new AbortController();
      s.acknowledgements.add(controller);
      try {
        const response = await request(s, "native-played", receipt, controller.signal, 5e3);
        await response.body?.cancel();
      } finally {
        s.acknowledgements.delete(controller);
      }
    };
    if (receipt.complete) {
      s.ackBarrier = s.ackBarrier.then(publish);
      void s.ackBarrier.catch(() => {
        if (current(s) && accountEpoch === s.accountEpoch) fail.current(s);
      });
    } else void publish().catch(() => {
    });
  }, [current, request]);
  observe.current = (s, item) => {
    if (!current(s) || s.muted || !opts.current.backgroundAsr || opts.current.observerPaused) return;
    if (s.observer) {
      s.observation = item;
      return;
    }
    const controller = new AbortController(), epoch = s.observerEpoch;
    s.observer = controller;
    void request(s, "native-observe", { audio: item.audio, format: "wav", turnId: item.turnId }, controller.signal).then((response) => response.json()).then((body) => {
      if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string" || body.text.length > 8e3) throw new VoiceLocaleError("speechUnrecognized");
      if (!current(s) || controller.signal.aborted || epoch !== s.observerEpoch || item.serial !== s.serial || s.muted || opts.current.observerPaused) return;
      const text = body.text.trim();
      if (!text) return;
      const id = `native-observed-${item.turnId}`;
      if (opts.current.onObservedTranscript) opts.current.onObservedTranscript(id, text);
      else opts.current.onTranscript(id, "user", text, true);
    }).catch(() => {
      if (current(s) && !controller.signal.aborted && epoch === s.observerEpoch && item.serial === s.serial && !s.muted && !opts.current.observerPaused) opts.current.onObserverError?.();
    }).finally(() => {
      if (s.observer !== controller) return;
      s.observer = void 0;
      const next = s.observation;
      s.observation = void 0;
      if (next) observe.current(s, next);
    });
  };
  const process = useCallback(async (s, input) => {
    const turn = { generation: input.generation, abort: new AbortController() };
    s.response = turn;
    const deadline = setTimeout(() => turn.abort.abort(), 45e3);
    refresh(s);
    try {
      await nativeAbortable(s.ackBarrier, turn.abort.signal);
      if (!liveTurn(s, turn)) throw cancelled();
      if (input.audio && input.workInput) {
        const response2 = await request(s, "native-input", { audio: input.audio, format: "wav", avatar: input.avatar }, turn.abort.signal);
        const body = await response2.json();
        if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string" || body.text.length > 4e3) throw new VoiceLocaleError("speechUnrecognized");
        if (!liveTurn(s, turn) || input.serial !== s.serial || s.muted || opts.current.observerPaused) return;
        const text = body.text.trim();
        if (text) {
          const id = crypto.randomUUID();
          if (opts.current.onObservedTranscript) opts.current.onObservedTranscript(id, text);
          else opts.current.onTranscript(id, "user", text, true);
        }
        return;
      }
      if (input.message) opts.current.onTranscript(crypto.randomUUID(), "user", input.message, true);
      const path = input.taskId ? "native-result" : "native-turn";
      const payload = input.taskId ? { taskId: input.taskId, avatar: input.avatar } : input.audio ? { audio: input.audio, format: "wav", avatar: input.avatar } : { message: input.message, avatar: input.avatar };
      const response = await request(s, path, payload, turn.abort.signal);
      if (!liveTurn(s, turn)) {
        await response.body?.cancel();
        throw cancelled();
      }
      await readNativeTurn(response, AbortSignal.any([turn.abort.signal, s.abort.signal]), async (event) => {
        if (!liveTurn(s, turn)) throw cancelled();
        if (event.type === "start") {
          turn.turnId = event.turnId;
          if (!s.playback?.begin(event.turnId)) throw new VoiceLocaleError("unsupportedAudio");
          if (input.audio) observe.current(s, { turnId: event.turnId, audio: input.audio, serial: input.serial });
        } else if (event.type === "audio") {
          await s.playback.enqueue(event.turnId, nativeAudioBytes(event.data), turn.abort.signal);
          if (liveTurn(s, turn)) refresh(s);
        } else if (event.type === "caption") {
          opts.current.onTranscript(`native-${event.turnId}`, "assistant", event.text, false);
        } else if (event.type === "complete") turn.complete = event;
        else throw voiceRequestError(502, event.code);
      });
      if (!turn.complete || !turn.turnId || !liveTurn(s, turn)) throw new VoiceLocaleError("streamFailed");
      await s.playback.drain(turn.turnId, turn.complete.samples, turn.abort.signal);
      await nativeAbortable(s.ackBarrier, turn.abort.signal);
      if (liveTurn(s, turn)) opts.current.onTranscript(`native-${turn.turnId}`, "assistant", turn.complete.text, true);
    } catch (e) {
      if (turn.turnId) s.playback?.cancel(turn.turnId);
      if (current(s) && s.response === turn && s.generation === turn.generation) {
        opts.current.onInterrupted?.();
        setError(voiceError(s.locale, e, "streamFailed"));
      }
    } finally {
      clearTimeout(deadline);
      if (s.response === turn) s.response = void 0;
      if (current(s)) {
        refresh(s);
        pump.current(s);
      }
    }
  }, [current, liveTurn, refresh, request]);
  pump.current = (s) => {
    if (!current(s) || !s.ready || s.pumping || s.capturing || s.draining) return;
    const pending = s.pending;
    if (s.muted && pending?.message === void 0 || s.manualHold) return;
    let input = pending;
    if (!input && !s.muted && s.results.length) input = { taskId: s.results.shift(), generation: s.generation, serial: s.serial, avatar: nextAvatar.current.id };
    if (!input) return;
    s.pending = void 0;
    s.pumping = true;
    void process(s, input).finally(() => {
      s.pumping = false;
      if (current(s)) pump.current(s);
    });
  };
  const enqueue = useCallback((s, value) => {
    stopResponse(s, false);
    s.pending = { ...value, workInput: Boolean(opts.current.workInput), avatar: nextAvatar.current.id, generation: s.generation, serial: s.serial };
    pump.current(s);
  }, [stopResponse]);
  const connect = useCallback(async (withMicrophone = true) => {
    if (session.current) {
      if (current(session.current) && (!withMicrophone || session.current.stream)) return;
      disconnect();
    }
    setConnecting(true);
    setError("");
    let transport;
    try {
      transport = snapshotNativeVoiceTransport(opts.current.transport);
    } catch {
      setConnecting(false);
      setError(voiceCopy(normalizeLocale(opts.current.locale)).streamFailed);
      return;
    }
    const s = {
      transport,
      owner: /* @__PURE__ */ Symbol("native-voice-session"),
      accountEpoch: 0,
      abort: new AbortController(),
      locale: normalizeLocale(opts.current.locale),
      ready: false,
      muted: false,
      noise: 2e-3,
      onset: 0,
      quiet: 0,
      capturing: false,
      draining: false,
      inputLevel: 0,
      generation: 0,
      serial: 0,
      pumping: false,
      manualHold: false,
      results: [],
      resultIds: /* @__PURE__ */ new Set(),
      observerEpoch: 0,
      ackBarrier: Promise.resolve(),
      acknowledgements: /* @__PURE__ */ new Set()
    };
    session.current = s;
    try {
      await resetNativeHistory(s.transport, s.abort.signal);
      if (!current(s)) return;
      if (withMicrophone && (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode)) throw new VoiceLocaleError("browserRequired");
      const context = new AudioContext();
      s.context = context;
      await context.resume();
      if (!current(s)) return;
      s.playback = new NativeRouterPlayback({ onPlayed: (receipt) => played(s, receipt), onError: () => fail.current(s) });
      if (!await s.playback.resume() || !current(s)) throw new VoiceLocaleError("playbackBlocked");
      const meter = new Float32Array(s.playback.analyser.fftSize);
      let last = 0;
      const measure = (now) => {
        if (!current(s)) return;
        if (now - last >= 50) {
          last = now;
          if (s.playback.queuedSamples && !s.capturing) {
            s.playback.analyser.getFloatTimeDomainData(meter);
            let power = 0;
            for (const sample of meter) power += sample * sample;
            setAudioLevel(Math.min(1, Math.sqrt(power / meter.length) * 5));
          } else setAudioLevel(s.muted ? 0 : s.inputLevel);
          refresh(s);
        }
        s.raf = requestAnimationFrame(measure);
      };
      if (!withMicrophone) {
        s.ready = true;
        setConnected(true);
        setConnecting(false);
        setPhase("idle");
        s.raf = requestAnimationFrame(measure);
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!current(s)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      s.stream = stream;
      await context.audioWorklet.addModule(s.transport.workletUrl);
      if (!current(s)) return;
      const capture = new AudioWorkletNode(context, "voice-capture");
      s.capture = capture;
      s.silent = context.createGain();
      s.silent.gain.value = 0;
      s.input = context.createMediaStreamSource(stream);
      s.input.connect(capture).connect(s.silent).connect(context.destination);
      s.collector = new UtteranceCollector(context.sampleRate, 25);
      capture.port.onmessage = (event) => {
        if (!current(s) || s.muted) return;
        const pcm = event.data;
        if (!(pcm instanceof Float32Array) || !pcm.length || pcm.length > context.sampleRate) return;
        let power = 0;
        for (const sample of pcm) power += sample * sample;
        const rms = Math.sqrt(power / pcm.length), seconds = pcm.length / context.sampleRate;
        s.inputLevel = Math.min(1, rms * 5);
        const voiced = rms > Math.max(0.012, s.noise * 3.5);
        if (!s.capturing && !s.draining && !s.response && !voiced) s.noise = Math.min(0.015, s.noise * 0.98 + rms * 0.02);
        if (s.draining) {
          s.quiet = voiced ? 0 : s.quiet + seconds;
          s.collector.push(pcm, voiced);
          if (s.quiet >= 0.55) {
            s.draining = false;
            s.quiet = 0;
            s.onset = 0;
            s.collector.reset();
            pump.current(s);
          }
          refresh(s);
          return;
        }
        if (!s.capturing) {
          s.onset = voiced ? s.onset + seconds : 0;
          if (s.onset >= 0.12) {
            s.capturing = true;
            s.serial++;
            s.quiet = 0;
            stopResponse(s, false);
            opts.current.onUserUtterance?.();
          }
        } else s.quiet = voiced ? 0 : s.quiet + seconds;
        const utterance = s.collector.push(pcm, voiced);
        if (utterance) {
          s.capturing = false;
          s.onset = 0;
          s.quiet = 0;
          if (utterance.capped) {
            s.draining = true;
            utterance.chunks.forEach((chunk) => chunk.fill(0));
            setError(voiceCopy(s.locale).recordingTooLong);
          } else {
            const audio = base64Bytes(wavFromPcm(utterance.chunks, context.sampleRate, 24e3));
            utterance.chunks.forEach((chunk) => chunk.fill(0));
            enqueue(s, { audio });
          }
          pump.current(s);
        }
        refresh(s);
      };
      s.ready = true;
      setHasMicrophone(true);
      setConnected(true);
      setConnecting(false);
      refresh(s);
      s.raf = requestAnimationFrame(measure);
    } catch (e) {
      if (current(s)) {
        disconnect();
        setError(e instanceof DOMException && e.name === "NotAllowedError" ? voiceCopy(s.locale).microphoneDenied : voiceError(s.locale, e));
      }
    }
  }, [current, disconnect, enqueue, played, refresh, stopResponse]);
  const interrupt = useCallback((hold = true) => {
    const s = session.current;
    if (s) stopResponse(s, hold && !s.capturing);
  }, [stopResponse]);
  const toggleMute = useCallback(() => {
    const s = session.current;
    if (!s?.ready) return;
    s.muted = !s.muted;
    s.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !s.muted;
    });
    s.collector?.reset();
    s.capturing = false;
    s.draining = false;
    s.onset = 0;
    s.quiet = 0;
    s.inputLevel = 0;
    s.serial++;
    invalidateObserver(s);
    if (s.muted) stopResponse(s, true);
    else {
      s.manualHold = false;
      pump.current(s);
    }
    setMuted(s.muted);
    refresh(s);
  }, [invalidateObserver, refresh, stopResponse]);
  const resetAccountContext = useCallback(() => {
    const s = session.current;
    if (!s?.ready || !current(s)) return;
    s.accountEpoch++;
    s.acknowledgements.forEach((controller) => controller.abort());
    s.acknowledgements.clear();
    s.ackBarrier = Promise.resolve();
    stopResponse(s, s.muted);
    invalidateObserver(s);
    s.collector?.reset();
    s.pending = void 0;
    s.results = [];
    s.resultIds.clear();
    s.capturing = false;
    s.draining = false;
    s.onset = 0;
    s.quiet = 0;
    s.inputLevel = 0;
    s.serial++;
    setError("");
    refresh(s);
  }, [current, invalidateObserver, refresh, stopResponse]);
  const sendText = useCallback((text) => {
    const s = session.current;
    if (!s?.ready || !current(s) || !text.trim()) return false;
    if (text.length > 4e3) {
      setError(voiceCopy(s.locale).messageTooLong);
      return false;
    }
    s.serial++;
    enqueue(s, { message: text.trim() });
    return true;
  }, [current, enqueue]);
  const getSessionOwner = useCallback(() => {
    const s = session.current;
    return s?.ready && current(s) ? s.owner : null;
  }, [current]);
  const sendTaskResult = useCallback((taskId, expectedOwner) => {
    const s = session.current;
    if (!s?.ready || !current(s) || expectedOwner !== void 0 && expectedOwner !== s.owner || !nativeIdentifier(taskId) || s.resultIds.has(taskId) || s.resultIds.size >= 64 || s.results.length >= 4) return false;
    s.resultIds.add(taskId);
    s.results.push(taskId);
    pump.current(s);
    return true;
  }, [current]);
  const setPersona = useCallback((avatar) => {
    if (["moss", "orbit", "spark"].includes(avatar)) nextAvatar.current.id = avatar;
  }, []);
  useEffect4(() => {
    if (session.current && session.current.locale !== normalizeLocale(options.locale)) disconnect();
  }, [options.locale, disconnect]);
  useEffect4(() => {
    if (session.current && session.current.transport.scopeKey !== (options.transport?.scopeKey ?? localNativeVoiceTransport.scopeKey)) disconnect();
  }, [options.transport?.scopeKey, disconnect]);
  useEffect4(() => {
    if (session.current && (!options.backgroundAsr || options.observerPaused)) invalidateObserver(session.current);
  }, [options.backgroundAsr, options.observerPaused, invalidateObserver]);
  useEffect4(() => () => disconnect(), [disconnect]);
  return { connected, connecting, hasMicrophone, phase, muted, error, audioLevel, connect, disconnect, interrupt, toggleMute, sendText, sendTaskResult, getSessionOwner, resetAccountContext, setPersona, clearError: () => setError("") };
}

// src/client/usePocketSpeech.ts
import { useCallback as useCallback2, useEffect as useEffect5, useRef as useRef5, useState as useState3 } from "react";
function usePocketSpeech(request) {
  const currentRequest = useRef5(request);
  currentRequest.current = request;
  const [enabled, setEnabled] = useState3(false), [speaking, setSpeaking] = useState3(false), [error, setError] = useState3("");
  const active = useRef5(null);
  const stop = useCallback2(() => {
    const old = active.current;
    active.current = null;
    old?.controller.abort();
    old?.audio?.pause();
    if (old?.url) URL.revokeObjectURL(old.url);
    setSpeaking(false);
  }, []);
  const disable = useCallback2(() => {
    stop();
    setEnabled(false);
  }, [stop]);
  const enable = useCallback2(() => {
    stop();
    setError("");
    setEnabled(true);
  }, [stop]);
  const speak = useCallback2((result) => {
    stop();
    setError("");
    const owned = { controller: new AbortController() };
    active.current = owned;
    void currentRequest.current(result, AbortSignal.any([owned.controller.signal, AbortSignal.timeout(45e3)])).then(async (response) => {
      if (active.current !== owned || owned.controller.signal.aborted) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "audio/wav") {
        await response.body?.cancel();
        throw Error("Local speech unavailable.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw Error("Local speech unavailable.");
      let bytes = 0;
      const chunks = [];
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.length;
          if (bytes > 44 + 24e3 * 2 * 31) throw Error("Invalid local audio.");
          chunks.push(new Uint8Array(item.value));
        }
      } finally {
        await reader.cancel().catch(() => {
        });
        reader.releaseLock();
      }
      if (active.current !== owned || owned.controller.signal.aborted) return;
      if (bytes < 46) throw Error("Invalid local audio.");
      const url = URL.createObjectURL(new Blob(chunks, { type: "audio/wav" })), audio = new Audio(url);
      owned.audio = audio;
      owned.url = url;
      audio.onended = () => {
        if (active.current === owned) stop();
      };
      audio.onerror = () => {
        if (active.current === owned) {
          stop();
          setError("Local speech could not play. Your reply remains saved.");
        }
      };
      await audio.play();
      if (active.current === owned) setSpeaking(true);
    }).catch(() => {
      if (active.current === owned) {
        stop();
        setError("Local speech unavailable. Your reply remains saved.");
      }
    });
  }, [stop]);
  useEffect5(() => () => {
    const old = active.current;
    active.current = null;
    old?.controller.abort();
    old?.audio?.pause();
    if (old?.url) URL.revokeObjectURL(old.url);
  }, []);
  return { enabled, speaking, error, enable, disable, stop, speak };
}
export {
  DEFAULT_LOCALE,
  Eyes,
  FactoryAvatar,
  WorldScene,
  WorldSky,
  createAcceptedTaskNarrationTransport,
  currentWorldSkySelection,
  localNativeVoiceTransport,
  normalizeLocale,
  snapshotNativeVoiceTransport,
  useNativeRouterVoice,
  usePocketSpeech,
  voiceHeaders
};
