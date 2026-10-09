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

// src/client/nativeVoiceTransport.ts
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
export {
  Eyes,
  FactoryAvatar,
  WorldSky,
  createAcceptedTaskNarrationTransport,
  currentWorldSkySelection
};
