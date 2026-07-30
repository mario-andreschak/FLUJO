(() => {
  "use strict";

  const FILM_DURATION = 148;
  const VOICEOVER_END = 141.92;
  const STUDIO_CONTENT = window.FLUJO_STUDIO || {};
  const DEFAULT_VOICE_VARIANTS = {
    brian: {
      name: "Brian",
      source: "assets/audio/flujo-voiceover-elevenlabs.mp3",
      language: "en",
    },
    sarah: {
      name: "Sarah",
      source: "assets/audio/flujo-voiceover-sarah.mp3",
      language: "en",
    },
    lily: {
      name: "Lily",
      source: "assets/audio/flujo-voiceover-lily.mp3",
      language: "en",
    },
    george: {
      name: "George",
      source: "assets/audio/flujo-voiceover-george.mp3",
      language: "en",
    },
  };
  const VOICE_VARIANTS = Object.freeze(
    Object.keys(STUDIO_CONTENT.voices || {}).length
      ? STUDIO_CONTENT.voices
      : DEFAULT_VOICE_VARIANTS,
  );
  const SCENES = [
    { id: "scene-chaos", name: "TOOL SPRAWL", start: 0, end: 27.28 },
    { id: "scene-gravity", name: "CENTER OF GRAVITY", start: 26.08, end: 45.68 },
    { id: "scene-control", name: "CONTROL EVERY STEP", start: 44.48, end: 67.04 },
    { id: "scene-team", name: "BUILD A TEAM", start: 65.84, end: 81.68 },
    { id: "scene-triggers", name: "LET IT WORK", start: 80.48, end: 100.08 },
    { id: "scene-chat", name: "STAY IN THE LOOP", start: 98.88, end: 115.20 },
    { id: "scene-ecosystem", name: "USE IT EVERYWHERE", start: 114.00, end: 132.56 },
    { id: "scene-final", name: "YOUR AI. IN FLOW.", start: 131.36, end: FILM_DURATION },
  ];

  const DEFAULT_CAPTIONS = [
    { start: .35, end: 3.35, text: "Using Claude Code? Or Codex?" },
    { start: 3.35, end: 6.2, text: "Cline? Ollama?" },
    { start: 6.2, end: 11.3, text: "Maybe Playwright, Supabase, Context Seven, Azure, Figma… or a WhatsApp MCP?" },
    { start: 11.3, end: 14.6, text: "A thousand AI tools." },
    { start: 14.6, end: 19.7, text: "And somehow, you became the integration layer." },
    { start: 19.7, end: 23.2, text: "Copying context. Pasting keys. Repeating yourself." },
    { start: 23.2, end: 26.08, text: "Tired of micromanaging them all?" },

    { start: 27.28, end: 31.3, text: "Meet FLUJO." },
    { start: 31.3, end: 37.6, text: "One local-first place to connect the models you choose, the tools you trust," },
    { start: 37.6, end: 40.4, text: "and the workflows that make them useful." },
    { start: 40.4, end: 42.65, text: "Use subscriptions, provider APIs, or local models." },
    { start: 42.65, end: 44.48, text: "Store a key once—encrypted—and bind it anywhere." },

    { start: 45.68, end: 48.15, text: "Then design the job. Start with a prompt." },
    { start: 48.15, end: 53.25, text: "Give each agent a role, the context it needs, and two tools—not twenty." },
    { start: 53.25, end: 56.35, text: "Branch. Loop. Hand work to another agent." },
    { start: 56.35, end: 61.05, text: "Or call an entire flow as one reusable step." },
    { start: 61.05, end: 65.84, text: "You decide what every step can see—and what it can do." },

    { start: 67.04, end: 70.9, text: "Turn those workflows into a team: research, build, test, review." },
    { start: 70.9, end: 75.4, text: "Let an orchestrator choose who goes next," },
    { start: 75.4, end: 80.48, text: "pass work between specialists, and loop until the result is ready." },

    { start: 81.68, end: 85.35, text: "When the work shouldn’t wait for you, add a trigger:" },
    { start: 85.35, end: 89.35, text: "every morning, every twenty minutes, on a webhook," },
    { start: 89.35, end: 94.05, text: "when a file or URL changes, when a new message arrives," },
    { start: 94.05, end: 96.45, text: "or when another flow finishes—or fails." },
    { start: 96.45, end: 98.88, text: "FLUJO runs it headlessly and keeps the history." },

    { start: 100.08, end: 103.25, text: "Prefer to stay in the loop? Open Chat and choose the same flow." },
    { start: 103.25, end: 106.45, text: "Watch every handoff and tool call live." },
    { start: 106.45, end: 110.35, text: "Check token use. Pause at a breakpoint. Inspect the state." },
    { start: 110.35, end: 114.00, text: "Require approval before a tool acts." },

    { start: 115.20, end: 118.20, text: "And FLUJO doesn’t trap your setup." },
    { start: 118.20, end: 124.55, text: "Reuse its MCP servers from Claude Desktop, Cline, Cursor, or other clients." },
    { start: 124.55, end: 131.36, text: "Or expose any flow through an OpenAI-compatible endpoint—and call a whole team like a model." },

    { start: 132.56, end: 136.25, text: "Your models. Your tools. Your keys. Your rules." },
    { start: 136.25, end: 141.92, text: "Stop managing AI one prompt at a time. Put your AI in flow." },
  ];
  const CAPTION_TRACKS = Object.freeze(
    Object.keys(STUDIO_CONTENT.captionTracks || {}).length
      ? STUDIO_CONTENT.captionTracks
      : { en: DEFAULT_CAPTIONS },
  );

  const TOOL_DATA = [
    { name: "Claude Code", kind: "coding agent", icon: "✳", color: "#bb6b45", x: 110, y: 100, r: -5, at: .8 },
    { name: "Codex", kind: "coding agent", icon: "</>", color: "#314458", x: 1240, y: 100, r: 4, at: 2.5 },
    { name: "Cline", kind: "VS Code agent", icon: "C", color: "#6c4ce0", x: 105, y: 680, r: 6, at: 3.75 },
    { name: "Ollama", kind: "local models", icon: "◒", color: "#202b38", x: 1270, y: 675, r: -5, at: 5 },
    { name: "Playwright", kind: "MCP server", icon: "▶", color: "#2187c9", x: 365, y: 105, r: 3, at: 8.4 },
    { name: "Supabase", kind: "MCP server", icon: "⚡", color: "#28b96b", x: 1015, y: 105, r: -3, at: 8.7 },
    { name: "Context7", kind: "MCP server", icon: "7", color: "#7252e6", x: 180, y: 310, r: -7, at: 9.05 },
    { name: "Azure", kind: "MCP server", icon: "A", color: "#0877c9", x: 1245, y: 302, r: 6, at: 9.35 },
    { name: "Figma", kind: "MCP server", icon: "F", color: "#ef6142", x: 310, y: 665, r: 5, at: 9.65 },
    { name: "WhatsApp", kind: "MCP server", icon: "◉", color: "#25bd61", x: 1075, y: 675, r: -4, at: 9.9 },
    { name: "GitHub", kind: "MCP server", icon: "GH", color: "#29313d", x: 46, y: 475, r: 6, at: 10.15 },
    { name: "OpenRouter", kind: "model provider", icon: "OR", color: "#cb496b", x: 1320, y: 475, r: -6, at: 10.35 },
    { name: "Filesystem", kind: "MCP server", icon: "▤", color: "#4a83e5", x: 510, y: 680, r: -5, at: 10.58 },
    { name: "Ableton", kind: "MCP server", icon: "▥", color: "#424b58", x: 885, y: 692, r: 5, at: 10.78 },
    { name: "Gemini", kind: "AI model", icon: "✦", color: "#5269e6", x: 570, y: 91, r: -3, at: 11 },
    { name: "Grok", kind: "AI model", icon: "X", color: "#313844", x: 835, y: 86, r: 3, at: 11.2 },
    { name: "OpenAI", kind: "model provider", icon: "◎", color: "#078b70", x: 280, y: 260, r: 5, at: 11.4 },
    { name: "Anthropic", kind: "model provider", icon: "AI", color: "#a45e43", x: 1110, y: 250, r: -4, at: 11.58 },
    { name: "Game Boy", kind: "MCP server", icon: "▦", color: "#6a5ab8", x: 375, y: 440, r: -7, at: 11.75 },
    { name: "Postgres", kind: "MCP server", icon: "P", color: "#286eaa", x: 1030, y: 438, r: 6, at: 11.9 },
    { name: "Slack", kind: "MCP server", icon: "#", color: "#8c48af", x: 690, y: 690, r: -2, at: 12.05 },
    { name: "Notion", kind: "MCP server", icon: "N", color: "#3c4651", x: 730, y: 137, r: 2, at: 12.2 },
    { name: "Web Search", kind: "MCP server", icon: "⌕", color: "#b26b29", x: 1260, y: 590, r: 4, at: 12.38 },
    { name: "Docker", kind: "MCP server", icon: "▰", color: "#1987c9", x: 80, y: 590, r: -4, at: 12.55 },
  ];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const clamp = (v, min = 0, max = 1) => Math.min(max, Math.max(min, v));
  const lerp = (a, b, p) => a + (b - a) * p;
  const invLerp = (a, b, v) => clamp((v - a) / Math.max(.0001, b - a));
  const easeOut = p => 1 - Math.pow(1 - clamp(p), 3);
  const easeInOut = p => {
    p = clamp(p);
    return p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  };
  const smoothstep = p => {
    p = clamp(p);
    return p * p * (3 - 2 * p);
  };
  const mixTransform = (x = 0, y = 0, scale = 1, rotate = 0) =>
    `translate3d(${x}px, ${y}px, 0) scale(${scale}) rotate(${rotate}deg)`;

  const stage = $("#stage");
  const voiceover = $("#voiceover");
  const captions = $("#captions");
  const poster = $("#poster");
  const endOverlay = $("#end-overlay");
  const playPause = $("#play-pause");
  const playIcon = $("#play-icon");
  const pauseIcon = $("#pause-icon");
  const timeline = $("#timeline");
  const timelineFill = $("#timeline-fill");
  const timelineBuffer = $("#timeline-buffer");
  const timelineKnob = $("#timeline-knob");
  const timelineMarkers = $("#timeline-markers");
  const timecode = $("#timecode");
  const sceneName = $("#scene-name");
  const captionsToggle = $("#captions-toggle");
  const voiceoverButton = $("#voiceover-toggle");
  const voiceSelect = $("#voice-select");
  const voiceStatus = $("#voice-status");
  const muteButton = $("#mute");
  const volumeIcon = $("#volume-icon");
  const mutedIcon = $("#muted-icon");

  const sceneEls = new Map(SCENES.map(scene => [scene.id, document.getElementById(scene.id)]));
  let currentTime = 0;
  let startTime = 0;
  let startWall = 0;
  let playing = false;
  let playbackPending = false;
  let playbackGeneration = 0;
  let ended = false;
  let dragging = false;
  let captionsEnabled = true;
  let voiceoverEnabled = true;
  let selectedVoice = VOICE_VARIANTS[STUDIO_CONTENT.defaultVoice]
    ? STUDIO_CONTENT.defaultVoice
    : Object.keys(VOICE_VARIANTS)[0];
  let activeLanguage = VOICE_VARIANTS[selectedVoice]?.language || "en";
  let voiceLoadGeneration = 0;
  let muted = false;
  let raf = 0;
  let lastFrameTime = -1;

  function buildChaos() {
    const container = $("#chaos-tools");
    const paths = $("#chaos-paths");
    TOOL_DATA.forEach((tool, index) => {
      const card = document.createElement("div");
      card.className = "tool-card";
      card.dataset.index = String(index);
      card.innerHTML = `
        <span class="tool-logo" style="--tool-color:${tool.color}">${tool.icon}</span>
        <span class="tool-copy"><b>${tool.name}</b><small>${tool.kind}</small></span>
      `;
      container.appendChild(card);

      const cx = tool.x + 85;
      const cy = tool.y + 29;
      const controlX = lerp(cx, 800, .52) + ((index % 3) - 1) * 65;
      const controlY = lerp(cy, 450, .52) + ((index % 4) - 1.5) * 45;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M${cx} ${cy} Q${controlX} ${controlY} 800 450`);
      path.dataset.index = String(index);
      paths.appendChild(path);
    });
  }

  function buildVoicePicker() {
    voiceSelect.replaceChildren();
    Object.entries(VOICE_VARIANTS).forEach(([key, voice]) => {
      const option = document.createElement("option");
      option.value = key;
      const language = STUDIO_CONTENT.languages?.[voice.language]?.name;
      option.textContent = language ? `${voice.name} · ${language}` : voice.name;
      voiceSelect.appendChild(option);
    });
    voiceSelect.value = selectedVoice;
    const selected = VOICE_VARIANTS[selectedVoice];
    voiceStatus.textContent = `${selected.name} selected`;
    $(".voice-picker").title = `Narrator: ${selected.name}`;
    if (voiceover.getAttribute("src") !== selected.source) {
      voiceover.src = selected.source;
      voiceover.load();
    }
  }

  function buildTimeline() {
    SCENES.forEach(scene => {
      const marker = document.createElement("i");
      marker.className = "timeline-marker";
      marker.style.left = `${scene.start / FILM_DURATION * 100}%`;
      marker.dataset.name = scene.name;
      marker.title = scene.name;
      timelineMarkers.appendChild(marker);
    });
    timeline.setAttribute("aria-valuemax", String(FILM_DURATION));
  }

  function preparePaths() {
    $$(".map-line-group path, .flow-edge, .team-edge, .eco-edge, .trigger-lines path").forEach(path => {
      try {
        const length = path.getTotalLength();
        path.dataset.length = String(length);
        path.style.strokeDasharray = String(length);
        path.style.strokeDashoffset = String(length);
        const markerEnd = path.getAttribute("marker-end");
        if (markerEnd) {
          path.dataset.markerEnd = markerEnd;
          path.style.markerEnd = "none";
        }
      } catch {
        // SVG layout can be briefly unavailable while the page is sizing.
      }
    });
  }

  function setPathProgress(path, progress) {
    const length = Number(path.dataset.length) || 1;
    const clamped = clamp(progress);
    path.style.strokeDasharray = String(length);
    path.style.strokeDashoffset = String(length * (1 - clamped));
    if (path.dataset.markerEnd) {
      path.style.markerEnd = clamped >= .97 ? path.dataset.markerEnd : "none";
    }
  }

  function sceneOpacity(t, start, end, fadeIn = 1.15, fadeOut = 1.15) {
    if (t < start || t > end) return 0;
    const enter = smoothstep(invLerp(start, start + fadeIn, t));
    const leave = 1 - smoothstep(invLerp(end - fadeOut, end, t));
    return Math.min(enter, leave);
  }

  function activateScene(scene, t) {
    const el = sceneEls.get(scene.id);
    const opacity = sceneOpacity(t, scene.start, scene.end);
    el.style.opacity = opacity.toFixed(4);
    el.style.visibility = opacity > .001 ? "visible" : "hidden";
    return { el, local: t - scene.start, opacity };
  }

  function reveal(el, local, at, duration = .8, options = {}) {
    const {
      x = 0,
      y = 22,
      scale = .92,
      rotate = 0,
      blur = 5,
      exitAt = Infinity,
      exitDuration = .5,
    } = options;
    const enter = easeOut(invLerp(at, at + duration, local));
    const exit = exitAt < Infinity ? 1 - smoothstep(invLerp(exitAt, exitAt + exitDuration, local)) : 1;
    const p = enter * exit;
    el.style.opacity = p.toFixed(4);
    el.style.transform = mixTransform(lerp(x, 0, enter), lerp(y, 0, enter), lerp(scale, 1, enter), lerp(rotate, 0, enter));
    el.style.filter = `blur(${lerp(blur, 0, enter)}px)`;
    return p;
  }

  function fadeWindow(local, start, end, fade = .45) {
    if (local < start || local > end) return 0;
    return Math.min(smoothstep(invLerp(start, start + fade, local)), 1 - smoothstep(invLerp(end - fade, end, local)));
  }

  function renderChaos(local) {
    const hook = $("#hook-line");
    const kicker = $("#hook-kicker");
    const hookBeats = [
      { start: .3, end: 2.5, kicker: "USING", text: "Claude Code?" },
      { start: 2.5, end: 3.75, kicker: "OR", text: "Codex?" },
      { start: 3.75, end: 5, kicker: "OR", text: "Cline?" },
      { start: 5, end: 6.2, kicker: "OR", text: "Ollama?" },
    ];
    const activeHook = hookBeats.find(beat => local >= beat.start && local < beat.end);
    if (activeHook) {
      const opacity = fadeWindow(local, activeHook.start, activeHook.end, .26);
      hook.textContent = activeHook.text;
      kicker.textContent = activeHook.kicker;
      hook.style.opacity = opacity;
      kicker.style.opacity = opacity * .85;
      hook.style.transform = mixTransform(0, lerp(12, 0, easeOut(invLerp(activeHook.start, activeHook.start + .5, local))), lerp(.97, 1, easeOut(invLerp(activeHook.start, activeHook.start + .5, local))));
      hook.style.filter = `blur(${lerp(6, 0, easeOut(invLerp(activeHook.start, activeHook.start + .45, local)))}px)`;
    } else {
      hook.style.opacity = 0;
      kicker.style.opacity = 0;
    }

    const frenzy = clamp(invLerp(11.5, 18.5, local));
    $$(".tool-card").forEach((card, index) => {
      const tool = TOOL_DATA[index];
      const enter = easeOut(invLerp(tool.at, tool.at + .65, local));
      const painDim = 1 - smoothstep(invLerp(18.0, 19.3, local)) * .79;
      const jitter = frenzy * (Math.sin(local * (4.8 + index * .09) + index * 2.1) * (3 + index % 3));
      const jitterY = frenzy * (Math.cos(local * (5.2 + index * .07) + index) * (2 + index % 4));
      const depth = Math.sin(index * 1.7) * 16 * frenzy;
      const scale = lerp(.72, 1, enter) * (1 + frenzy * Math.sin(local * 2 + index) * .025);
      card.style.left = `${tool.x}px`;
      card.style.top = `${tool.y}px`;
      card.style.opacity = (enter * painDim).toFixed(4);
      card.style.transform = `translate3d(${jitter}px, ${jitterY}px, ${depth}px) scale(${scale}) rotate(${tool.r + jitter * .28}deg)`;
      card.style.filter = `blur(${lerp(5, frenzy * .5, enter) + (1 - painDim) * 3}px) saturate(${lerp(.65, 1.1, frenzy)})`;
    });

    $$("#chaos-paths path").forEach((path, index) => {
      const p = easeOut(invLerp(10.4 + index * .055, 13 + index * .05, local));
      path.style.opacity = (p * (1 - smoothstep(invLerp(18, 19.2, local))) * .8).toFixed(3);
      path.style.strokeDashoffset = String((local * 25 + index * 13) % 80);
    });

    const cursor = $("#operator-cursor");
    const cursorOpacity = fadeWindow(local, 8.7, 18.2, .5);
    const cursorPoints = [
      [760, 425],
      [1070, 260],
      [510, 625],
      [1220, 580],
      [330, 325],
      [880, 520],
    ];
    const cursorProgress = clamp(invLerp(8.7, 18.2, local)) * (cursorPoints.length - 1);
    const segment = Math.min(cursorPoints.length - 2, Math.floor(cursorProgress));
    const segmentP = easeInOut(cursorProgress - segment);
    const cx = lerp(cursorPoints[segment][0], cursorPoints[segment + 1][0], segmentP);
    const cy = lerp(cursorPoints[segment][1], cursorPoints[segment + 1][1], segmentP);
    cursor.style.opacity = cursorOpacity;
    cursor.style.transform = mixTransform(cx, cy, 1, 0);

    const fragments = [
      [$(".fragment-a"), 10.3, 13.2, -18, 10],
      [$(".fragment-b"), 12.4, 16.5, 22, -10],
      [$(".fragment-c"), 14.1, 17.9, -16, -12],
    ];
    fragments.forEach(([el, start, end, x, y]) => {
      const opacity = fadeWindow(local, start, end, .28);
      el.style.opacity = opacity;
      el.style.transform = mixTransform(x * Math.sin(local * 1.7), y * Math.cos(local * 1.3), .95 + opacity * .05, Math.sin(local * 2) * 3);
    });

    const pain = $("#pain-copy");
    const painP = easeOut(invLerp(18.1, 19.2, local));
    pain.style.opacity = painP;
    pain.style.transform = mixTransform(0, lerp(24, 0, painP), lerp(.96, 1, painP));
    pain.style.filter = `blur(${lerp(8, 0, painP)}px)`;
  }

  function renderGravity(local) {
    const scene = $("#scene-gravity");
    const core = $("#flujo-core");
    const arrival = easeOut(invLerp(.25, 2.65, local));
    const settle = 1 + Math.sin(local * 2.1) * .018 * clamp(invLerp(2.4, 4.2, local));
    const shift = easeInOut(invLerp(17.2, 19.2, local));
    core.style.opacity = arrival;
    core.style.transform = mixTransform(lerp(0, -235, shift), lerp(30, 20, shift), lerp(.2, 1, arrival) * lerp(1, .72, shift) * settle);
    core.style.filter = `blur(${lerp(18, 0, arrival)}px)`;

    $(".halo-one").style.transform = `translate(-50%, -50%) rotate(${local * 9}deg) scale(${1 + Math.sin(local * 1.3) * .025})`;
    $(".halo-two").style.transform = `translate(-50%, -50%) rotate(${-local * 6}deg)`;

    const title = $(".gravity-title");
    const titleP = easeOut(invLerp(1.4, 2.4, local)) * (1 - smoothstep(invLerp(15.8, 17.1, local)));
    title.style.opacity = titleP;
    title.style.transform = mixTransform(0, lerp(18, 0, titleP), 1);
    title.style.filter = `blur(${lerp(7, 0, titleP)}px)`;

    const lineTimes = [7.65, 9.35, 9.85, 10.25, 10.75, 11.15, 11.55, 11.95, 12.35, 8.75, 9.35, 12.75];
    const lineExit = 1 - smoothstep(invLerp(16.35, 17.55, local));
    $$(".map-line-group path").forEach((path, index) => {
      const at = lineTimes[index] ?? 12.75;
      const progress = easeInOut(invLerp(at, at + .9, local));
      setPathProgress(path, progress);
      path.style.opacity = (lineExit * (1 - shift * .3)).toFixed(3);
    });

    $$("[data-map-at]").forEach((node, index) => {
      const at = Number(node.dataset.mapAt);
      const p = reveal(node, local, at, .72, { y: 20, scale: .86, blur: 7 });
      const dx = -235 * shift;
      const dy = (index % 2 ? -8 : 8) * shift;
      if (p > 0) {
        const base = node.style.transform;
        node.style.transform = `${base} translate3d(${dx}px, ${dy}px, 0) scale(${lerp(1, .72, shift)})`;
      }
    });

    const trust = $("#trust-strip");
    const trustP = reveal(trust, local, 13.0, .85, { y: 15, scale: .97, blur: 5, exitAt: 17.1, exitDuration: .7 });
    trust.style.opacity = trustP;
    scene.style.transform = mixTransform(lerp(0, -75, shift), 0, lerp(1, .94, shift));
  }

  function renderControl(local) {
    const mini = $(".mini-stack");
    const miniP = easeOut(invLerp(.2, 1.1, local));
    mini.style.opacity = miniP;
    mini.style.transform = mixTransform(lerp(-30, 0, miniP), 0, lerp(.88, 1, miniP));
    mini.style.filter = `blur(${lerp(7, 0, miniP)}px)`;
    $(".orbit-model").style.transform = `rotate(${local * 22}deg) translateX(${Math.sin(local) * 4}px)`;
    $(".orbit-mcp").style.transform = `rotate(${-local * 18}deg)`;
    $(".orbit-key").style.transform = `scale(${1 + Math.sin(local * 2.4) * .12})`;

    const headline = $(".control-headline");
    reveal(headline, local, .45, .8, { x: 30, y: 0, scale: .98, blur: 6 });

    $$("[data-flow-at]").forEach(node => {
      reveal(node, local, Number(node.dataset.flowAt), .72, { y: 20, scale: .83, blur: 5 });
    });

    const edgeTimes = [4.0, 7.8, 6.0, 9.4, 11.2, 10.1];
    $$(".flow-edge").forEach((path, index) => {
      setPathProgress(path, easeInOut(invLerp(edgeTimes[index], edgeTimes[index] + 1.15, local)));
    });

    const scope = $("#tool-scope");
    const scopeP = reveal(scope, local, 8.7, .78, { x: 28, y: 0, scale: .93, blur: 7 });
    scope.style.boxShadow = scopeP > .9
      ? `0 18px 45px rgba(30,51,78,.18), 0 0 ${12 + Math.sin(local * 3) * 5}px rgba(40,178,137,.24)`
      : "";
    reveal($(".branch-caption"), local, 5.8, .55, { y: 8, scale: .95, blur: 3 });
    reveal($(".loop-caption"), local, 11.8, .55, { y: 8, scale: .95, blur: 3 });

    const packetA = $(".packet-a");
    const pa = ((local - 12.2) % 3.0 + 3.0) % 3.0 / 3.0;
    const paVisible = local > 12.2 ? 1 : 0;
    packetA.style.opacity = paVisible;
    packetA.style.transform = mixTransform(lerp(590, 868, pa), 222 + Math.sin(pa * Math.PI) * -5, 1);

    const packetB = $(".packet-b");
    const pb = ((local - 13.3) % 2.7 + 2.7) % 2.7 / 2.7;
    packetB.style.opacity = local > 13.3 ? 1 : 0;
    packetB.style.transform = mixTransform(776, lerp(485, 578, pb), 1);
  }

  function renderTeam(local) {
    reveal($(".section-heading"), local, .2, .8, { y: 18, scale: .98, blur: 7 });
    const master = $("#master-flow");
    const masterP = reveal(master, local, 1.4, 1.0, { y: 75, scale: .55, blur: 10 });
    master.style.filter = `blur(${lerp(10, 0, masterP)}px) drop-shadow(0 0 ${12 + Math.sin(local * 2) * 5}px rgba(63,202,229,.16))`;

    $$("[data-team-at]").forEach(card => {
      reveal(card, local, Number(card.dataset.teamAt), .7, { y: 28, scale: .86, blur: 6 });
    });

    const edgeTimes = [2.9, 5.9, 6.4, 6.9, 9.7, 10.3, 11.5];
    $$(".team-edge").forEach((path, index) => {
      setPathProgress(path, easeInOut(invLerp(edgeTimes[index], edgeTimes[index] + 1.15, local)));
    });

    const packets = [
      { el: $(".work-one"), start: 8.6, duration: 3.4, points: [[800, 405], [590, 475], [400, 530]] },
      { el: $(".work-two"), start: 10.2, duration: 3.1, points: [[400, 590], [660, 530], [800, 560]] },
      { el: $(".work-three"), start: 11.7, duration: 3.0, points: [[1200, 580], [1140, 680], [1020, 740]] },
    ];
    packets.forEach(({ el, start, duration, points }) => {
      const active = local > start;
      const p = ((local - start) % duration + duration) % duration / duration;
      const scaled = p * (points.length - 1);
      const index = Math.min(points.length - 2, Math.floor(scaled));
      const q = easeInOut(scaled - index);
      el.style.opacity = active ? 1 : 0;
      el.style.transform = mixTransform(
        lerp(points[index][0], points[index + 1][0], q),
        lerp(points[index][1], points[index + 1][1], q),
        .9 + Math.sin(p * Math.PI) * .1
      );
    });
  }

  function renderTriggers(local) {
    reveal($(".trigger-heading"), local, .2, .8, { x: -28, y: 0, scale: .98, blur: 6 });
    const team = $(".trigger-team");
    reveal(team, local, .7, .95, { x: -35, y: 0, scale: .93, blur: 7 });

    $$("[data-trigger-at]").forEach((pill, index) => {
      const p = reveal(pill, local, Number(pill.dataset.triggerAt), .62, {
        x: 36 + (index % 2) * 18,
        y: 0,
        scale: .91,
        blur: 6,
      });
      if (p > .95 && ((Math.floor((local - Number(pill.dataset.triggerAt)) * 2) + index) % 7 === 0)) {
        pill.style.boxShadow = "0 15px 35px rgba(0,0,0,.33), 0 0 25px rgba(53,192,231,.18)";
      } else {
        pill.style.boxShadow = "";
      }
    });

    $$(".trigger-lines path").forEach((path, index) => {
      const progress = easeInOut(invLerp(2.7 + index * 1.05, 4.0 + index * 1.05, local));
      setPathProgress(path, progress);
      path.style.strokeDashoffset = String((Number(path.dataset.length) || 1) * (1 - progress));
    });

    const history = $(".run-history");
    reveal(history, local, 10.4, .85, { y: 24, scale: .96, blur: 6 });
    $(".history-row i.spin").style.transform = `rotate(${local * 160}deg)`;
    $(".active-flow i").textContent = local > 13.7 ? "DONE" : "RUNNING";
    $(".active-flow i").style.background = local > 13.7 ? "#45d68b" : "#4eddf0";
  }

  function renderChat(local) {
    const superTitle = $(".chat-super");
    reveal(superTitle, local, .1, .75, { y: 16, scale: .98, blur: 7, exitAt: 4.0, exitDuration: .7 });

    const shell = $(".chat-shell");
    const shellP = easeOut(invLerp(.45, 1.45, local));
    shell.style.opacity = shellP;
    shell.style.transform = mixTransform(0, lerp(30, 0, shellP), lerp(.90, 1, shellP));
    shell.style.filter = `blur(${lerp(10, 0, shellP)}px)`;

    const user = $("#user-message");
    reveal(user, local, 2.0, .65, { x: 24, y: 0, scale: .93, blur: 5 });

    const nodeSequence = [
      [$(".dbg-start"), 3.1, 4.1],
      [$(".dbg-plan"), 4.0, 6.6],
      [$(".dbg-docs"), 5.9, 8.2],
      [$(".dbg-test"), 7.7, 10.7],
      [$(".dbg-finish"), 12.1, 14.3],
    ];
    nodeSequence.forEach(([node, start, end]) => {
      node.classList.toggle("running", local >= start && local < end);
    });

    const breakDot = $(".breakpoint-dot");
    breakDot.style.opacity = fadeWindow(local, 7.5, 9.5, .25);
    breakDot.style.transform = `scale(${1 + Math.sin(local * 7) * .15})`;

    const inspector = $("#state-inspector");
    const inspectorP = fadeWindow(local, 7.65, 9.75, .35);
    inspector.style.opacity = inspectorP;
    inspector.style.transform = mixTransform(lerp(20, 0, easeOut(invLerp(7.65, 8.15, local))), 0, lerp(.96, 1, inspectorP));

    const approval = $("#approval-modal");
    const approvalP = fadeWindow(local, 9.85, 12.3, .38);
    approval.style.opacity = approvalP;
    approval.style.transform = mixTransform(0, lerp(20, 0, easeOut(invLerp(9.85, 10.35, local))), lerp(.94, 1, easeOut(invLerp(9.85, 10.35, local))));

    const approveButton = $(".approval-modal .approve");
    const approvePulse = local > 10.9 && local < 11.8 ? 1 + Math.sin((local - 10.9) * Math.PI / .9) * .08 : 1;
    approveButton.style.transform = `scale(${approvePulse})`;
    approveButton.style.boxShadow = local > 10.9 && local < 11.8 ? "0 0 0 4px rgba(24,131,239,.16)" : "";

    const assistant = $("#assistant-message");
    reveal(assistant, local, 12.15, .75, { y: 18, scale: .96, blur: 6 });
  }

  function renderEcosystem(local) {
    reveal($(".ecosystem-heading"), local, .2, .8, { y: 18, scale: .98, blur: 6 });

    const app = $(".flujo-app-window");
    const appP = easeOut(invLerp(.7, 2.2, local));
    app.style.opacity = appP;
    app.style.transform = mixTransform(0, lerp(110, 0, appP), lerp(1.65, 1, appP));
    app.style.filter = `blur(${lerp(9, 0, appP)}px)`;

    $$("[data-eco-at]").forEach(appEl => {
      const at = Number(appEl.dataset.ecoAt);
      reveal(appEl, local, at, .75, {
        x: appEl.classList.contains("claude-app") || appEl.classList.contains("cursor-app") ? -35 : 35,
        y: 0,
        scale: .86,
        blur: 6,
      });
    });

    const edgeTimes = [5.7, 6.8, 8.3, 9.3];
    $$(".eco-edge").forEach((path, index) => {
      setPathProgress(path, easeInOut(invLerp(edgeTimes[index], edgeTimes[index] + 1.25, local)));
    });

    reveal($(".proxy-label"), local, 10.1, .72, { y: 18, scale: .97, blur: 5 });
    reveal($(".model-label"), local, 11.2, .72, { y: 18, scale: .97, blur: 5 });
  }

  function renderFinal(local) {
    const copyTop = $(".final-copy-top");
    reveal(copyTop, local, .4, .85, { y: -15, scale: .99, blur: 5 });

    const logo = $(".final-logo-wrap");
    const logoP = easeOut(invLerp(2.4, 4.1, local));
    logo.style.opacity = logoP;
    logo.style.transform = `translateX(-50%) translateY(${lerp(35, 0, logoP)}px) scale(${lerp(.45, 1, logoP)})`;
    logo.style.filter = `blur(${lerp(13, 0, logoP)}px)`;
    $(".final-logo-wrap .ring-a").style.transform = `translate(-50%, -50%) rotate(${local * 10}deg) scale(${1 + Math.sin(local * 1.4) * .02})`;
    $(".final-logo-wrap .ring-b").style.transform = `translate(-50%, -50%) rotate(${-local * 7}deg)`;

    reveal($(".final-word"), local, 4.0, .9, { y: 25, scale: .94, blur: 9 });
    reveal($(".final-tag"), local, 6.4, .8, { y: 16, scale: .97, blur: 6 });
    reveal($(".final-meta"), local, 8.2, .7, { y: 10, scale: .98, blur: 4 });
    reveal($(".install-pill"), local, 9.8, .75, { y: 18, scale: .94, blur: 5 });
    reveal($(".final-url"), local, 11.2, .75, { y: 9, scale: .99, blur: 4 });
    drawFinalStreams(local);
  }

  function drawFinalStreams(local) {
    const canvas = $("#final-streams");
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const converge = easeInOut(invLerp(.2, 4.0, local));
    const fade = 1 - smoothstep(invLerp(4.0, 6.0, local));
    const center = { x: 800, y: 295 };
    const sources = [
      [-100, 110], [1700, 140], [-80, 760], [1680, 730],
      [230, -50], [1360, -80], [300, 960], [1320, 970],
      [-120, 440], [1730, 440],
    ];
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    sources.forEach((source, index) => {
      const endX = lerp(source[0], center.x + Math.sin(index * 1.9) * 55, converge);
      const endY = lerp(source[1], center.y + Math.cos(index * 1.4) * 50, converge);
      const grad = ctx.createLinearGradient(source[0], source[1], endX, endY);
      grad.addColorStop(0, `rgba(59,130,246,${.05 * fade})`);
      grad.addColorStop(.65, `rgba(53,216,237,${.35 * fade})`);
      grad.addColorStop(1, `rgba(115,229,239,${.75 * fade})`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.4 + (index % 3) * .55;
      ctx.shadowColor = "#39d6e8";
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(source[0], source[1]);
      const cx = lerp(source[0], center.x, .52) + Math.sin(index * 1.7) * 180;
      const cy = lerp(source[1], center.y, .52) + Math.cos(index * 1.25) * 130;
      ctx.quadraticCurveTo(cx, cy, endX, endY);
      ctx.stroke();
    });
    ctx.restore();
  }

  const ambientCanvas = $("#ambient");
  const ambientCtx = ambientCanvas.getContext("2d");
  const ambientParticles = Array.from({ length: 92 }, (_, index) => ({
    seed: index * 19.91,
    y: 35 + ((index * 97) % 830),
    speed: 18 + ((index * 37) % 64),
    amp: 8 + ((index * 29) % 42),
    radius: .7 + (index % 5) * .38,
    alpha: .08 + (index % 7) * .025,
  }));

  function drawAmbient(t) {
    const ctx = ambientCtx;
    ctx.clearRect(0, 0, 1600, 900);
    const sceneIndex = Math.max(0, SCENES.findIndex(scene => t >= scene.start && t < scene.end));
    const chaosBoost = t < 27.28 ? 1.7 : 1;
    const hue = sceneIndex >= 5 ? 198 : 207;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ambientParticles.forEach((particle, index) => {
      const x = ((t * particle.speed * chaosBoost + particle.seed * 33) % 1820) - 110;
      const y = particle.y + Math.sin(x * .004 + particle.seed) * particle.amp;
      const pulse = .65 + Math.sin(t * .7 + index) * .35;
      ctx.beginPath();
      ctx.fillStyle = `hsla(${hue}, 88%, 66%, ${particle.alpha * pulse})`;
      ctx.shadowColor = `hsla(${hue}, 88%, 62%, .55)`;
      ctx.shadowBlur = 7;
      ctx.arc(x, y, particle.radius, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();

    const gridAlpha = t > 44 && t < 116 ? .035 : .018;
    ctx.save();
    ctx.strokeStyle = `rgba(98, 150, 211, ${gridAlpha})`;
    ctx.lineWidth = 1;
    const offset = (t * 5) % 80;
    for (let x = -80 + offset; x < 1680; x += 80) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 900);
      ctx.stroke();
    }
    for (let y = -80 + offset * .4; y < 980; y += 80) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(1600, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function updateCaptions(t) {
    const track = CAPTION_TRACKS[activeLanguage]
      || CAPTION_TRACKS[STUDIO_CONTENT.defaultLanguage]
      || DEFAULT_CAPTIONS;
    let active = track.find(caption => t >= caption.start && t < caption.end);
    if (!active && !voiceoverEnabled) {
      for (const caption of track) {
        if (t < caption.start) break;
        active = caption;
      }
      active ||= track[0];
    }
    if ((captionsEnabled || !voiceoverEnabled) && active) {
      if (captions.textContent !== active.text) captions.textContent = active.text;
      captions.classList.add("visible");
    } else {
      captions.classList.remove("visible");
    }
  }

  function syncNarrationMode() {
    const textNarration = !voiceoverEnabled;
    voiceover.muted = muted || textNarration;
    voiceoverButton.classList.toggle("active", voiceoverEnabled);
    voiceoverButton.setAttribute("aria-pressed", String(voiceoverEnabled));
    const voiceLabel = voiceoverEnabled ? "Disable AI voiceover" : "Enable AI voiceover";
    voiceoverButton.setAttribute("aria-label", voiceLabel);
    voiceoverButton.title = voiceLabel;

    captions.classList.toggle("transcript-mode", textNarration);
    captionsToggle.disabled = textNarration;
    captionsToggle.classList.toggle("active", captionsEnabled || textNarration);
    captionsToggle.setAttribute("aria-pressed", String(captionsEnabled || textNarration));
    captionsToggle.setAttribute(
      "aria-label",
      textNarration ? "Captions stay on while AI voiceover is off" : "Toggle captions",
    );
    updateCaptions(currentTime);
  }

  function changeNarrator(key) {
    const variant = VOICE_VARIANTS[key];
    if (!variant || key === selectedVoice) return;

    selectedVoice = key;
    voiceSelect.value = key;
    voiceStatus.textContent = `${variant.name} selected`;
    $(".voice-picker").title = `Narrator: ${variant.name}`;
    activeLanguage = variant.language || activeLanguage;

    const generation = ++voiceLoadGeneration;
    const target = clamp(movieNow(), 0, Math.max(0, VOICEOVER_END - .02));
    const continuePlaying = playing && target < VOICEOVER_END;
    if (continuePlaying) {
      currentTime = target;
      startTime = target;
      playbackPending = true;
      Score.pause();
    }
    voiceover.pause();

    let metadataHandled = false;
    const configureTrack = () => {
      if (metadataHandled || generation !== voiceLoadGeneration) return;
      metadataHandled = true;
      voiceover.muted = muted || !voiceoverEnabled;

      let resumed = false;
      const resumeTrack = async () => {
        if (resumed || generation !== voiceLoadGeneration || !playing) return;
        resumed = true;
        try {
          await voiceover.play();
        } catch {
          // Keep the visual film usable if this voice cannot start immediately.
        }
        if (generation !== voiceLoadGeneration || !playing) return;
        currentTime = target;
        startTime = target;
        startWall = performance.now();
        playbackPending = false;
        Score.start(target, muted);
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(tick);
      };

      try {
        voiceover.currentTime = target;
      } catch {
        playbackPending = false;
        return;
      }
      if (continuePlaying) {
        let seekChecks = 0;
        const resumeWhenReady = () => {
          if (generation !== voiceLoadGeneration || !playing || resumed) return;
          const atTarget = Math.abs(voiceover.currentTime - target) < .15;
          if ((!voiceover.seeking && atTarget) || target <= .02 || seekChecks >= 40) {
            resumeTrack();
            return;
          }
          seekChecks += 1;
          setTimeout(resumeWhenReady, 25);
        };
        resumeWhenReady();
      }
    };

    voiceover.addEventListener("loadedmetadata", configureTrack, { once: true });
    voiceover.src = variant.source;
    voiceover.load();
    if (voiceover.readyState >= 1) queueMicrotask(configureTrack);
  }

  function renderFrame(t) {
    const states = SCENES.map(scene => ({ scene, ...activateScene(scene, t) }));
    states.forEach(({ scene, local, opacity }) => {
      if (opacity <= .001) return;
      switch (scene.id) {
        case "scene-chaos": renderChaos(local); break;
        case "scene-gravity": renderGravity(local); break;
        case "scene-control": renderControl(local); break;
        case "scene-team": renderTeam(local); break;
        case "scene-triggers": renderTriggers(local); break;
        case "scene-chat": renderChat(local); break;
        case "scene-ecosystem": renderEcosystem(local); break;
        case "scene-final": renderFinal(local); break;
      }
    });

    drawAmbient(t);
    updateCaptions(t);
    updateControls(t);
  }

  function movieNow() {
    if (!playing || playbackPending) return currentTime;
    return clamp(startTime + (performance.now() - startWall) / 1000, 0, FILM_DURATION);
  }

  async function play() {
    if (ended || currentTime >= FILM_DURATION - .02) {
      seek(0);
      ended = false;
      endOverlay.hidden = true;
    }
    if (playing) return;
    const resumeAt = currentTime;
    const generation = ++playbackGeneration;
    playing = true;
    playbackPending = true;
    startTime = currentTime;
    startWall = performance.now();
    poster.classList.add("hidden");
    document.documentElement.style.setProperty("--play-state", "running");
    setPlayIcon();

    let audioStarted = false;
    if (currentTime < VOICEOVER_END) {
      try {
        voiceover.currentTime = clamp(resumeAt, 0, Math.max(0, voiceover.duration || VOICEOVER_END));
        voiceover.muted = muted || !voiceoverEnabled;
        await voiceover.play();
        audioStarted = !voiceover.paused;
      } catch {
        // The visual film remains playable if browser audio setup is delayed.
      }
    }
    if (!playing || generation !== playbackGeneration) return;

    playbackPending = false;
    if (audioStarted) {
      const audioTime = clamp(voiceover.currentTime, 0, VOICEOVER_END);
      if (Math.abs(audioTime - resumeAt) <= .75) {
        currentTime = audioTime;
      } else {
        currentTime = resumeAt;
        voiceover.currentTime = resumeAt;
      }
    } else {
      currentTime = resumeAt;
    }
    startTime = currentTime;
    startWall = performance.now();
    Score.start(currentTime, muted);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function pause() {
    if (!playing) return;
    currentTime = movieNow();
    playing = false;
    playbackPending = false;
    playbackGeneration += 1;
    voiceover.pause();
    Score.pause();
    document.documentElement.style.setProperty("--play-state", "paused");
    setPlayIcon();
    renderFrame(currentTime);
  }

  function seek(value) {
    const restartPendingPlayback = playing && playbackPending;
    if (restartPendingPlayback) {
      playing = false;
      playbackPending = false;
      playbackGeneration += 1;
      voiceover.pause();
      Score.pause();
    }
    const target = clamp(value, 0, FILM_DURATION);
    currentTime = target;
    startTime = target;
    startWall = performance.now();
    ended = false;
    endOverlay.hidden = true;
    if (Number.isFinite(voiceover.duration)) {
      voiceover.currentTime = clamp(target, 0, Math.max(0, voiceover.duration - .02));
    }
    if (restartPendingPlayback) {
      renderFrame(target);
      play();
      return;
    }
    if (playing) {
      if (target < VOICEOVER_END) {
        voiceover.play().catch(() => {});
      } else {
        voiceover.pause();
      }
      Score.start(target, muted);
    }
    renderFrame(target);
  }

  function finish() {
    currentTime = FILM_DURATION;
    playing = false;
    playbackPending = false;
    playbackGeneration += 1;
    ended = true;
    voiceover.pause();
    Score.pause();
    setPlayIcon();
    renderFrame(FILM_DURATION - .001);
    updateControls(FILM_DURATION);
    setTimeout(() => {
      if (ended) endOverlay.hidden = false;
    }, 500);
  }

  function tick() {
    if (!playing) return;
    const t = movieNow();
    currentTime = t;

    if (t < VOICEOVER_END && !voiceover.paused && Math.abs(voiceover.currentTime - t) > .28) {
      voiceover.currentTime = t;
    }
    if (t >= VOICEOVER_END && !voiceover.paused) voiceover.pause();

    if (Math.abs(t - lastFrameTime) > .005) {
      renderFrame(t);
      lastFrameTime = t;
    }
    if (t >= FILM_DURATION - .01) {
      finish();
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function setPlayIcon() {
    playIcon.toggleAttribute("hidden", playing);
    pauseIcon.toggleAttribute("hidden", !playing);
    playPause.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  function formatTime(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }

  function updateControls(t) {
    const progress = clamp(t / FILM_DURATION);
    timelineFill.style.width = `${progress * 100}%`;
    timelineKnob.style.left = `${progress * 100}%`;
    timeline.setAttribute("aria-valuenow", t.toFixed(2));
    timecode.textContent = `${formatTime(t)} / ${formatTime(FILM_DURATION)}`;
    const activeScene = [...SCENES].reverse().find(scene => t >= scene.start) || SCENES[0];
    sceneName.textContent = activeScene.name;
  }

  function seekFromPointer(event) {
    const rect = timeline.getBoundingClientRect();
    seek((event.clientX - rect.left) / rect.width * FILM_DURATION);
  }

  function fitStage() {
    const availableWidth = window.innerWidth;
    const availableHeight = window.innerHeight - (window.innerWidth <= 760 ? 58 : 68);
    const scale = Math.min(availableWidth / 1600, availableHeight / 900) * .985;
    stage.style.setProperty("--stage-scale", String(scale));
  }

  const Score = (() => {
    let context = null;
    let master = null;
    let liveNodes = [];
    const events = [];
    const progression = [
      [110.00, 164.81, 220.00],
      [87.31, 130.81, 174.61],
      [130.81, 196.00, 261.63],
      [98.00, 146.83, 196.00],
    ];

    for (let t = 0, bar = 0; t < FILM_DURATION; t += 4, bar += 1) {
      const chord = progression[bar % progression.length];
      chord.forEach((frequency, index) => {
        events.push({ t, frequency, duration: 4.5, gain: t < 26 ? .012 : .017, type: index === 0 ? "sine" : "triangle", pad: true });
      });
    }

    [0.5, 3.35, 5.45, 7.15, 11.3, 14.6, 19.7, 23.2, 27.28].forEach((t, index) => {
      events.push({ t, frequency: 440 * Math.pow(2, (index % 5) / 12), duration: .36, gain: .035, type: "sine" });
    });

    for (let t = 27.28, index = 0; t < 132; t += .75, index += 1) {
      const chord = progression[Math.floor(t / 4) % progression.length];
      events.push({
        t,
        frequency: chord[(index + 1) % chord.length] * (index % 4 === 0 ? 2 : 3),
        duration: .24,
        gain: t > 98 && t < 116 ? .018 : .026,
        type: "sine",
      });
    }

    for (let t = 45.68; t < 100; t += 2) {
      events.push({ t, frequency: 55, duration: .38, gain: .025, type: "sine" });
    }

    [132.56, 136.25, 141.9].forEach((t, index) => {
      [130.81, 196, 261.63, 329.63, 392].forEach(frequency => {
        events.push({ t, frequency: frequency * (index === 2 ? 1.5 : 1), duration: 5.2, gain: .018, type: "sine", pad: true });
      });
    });

    function ensure() {
      if (context) return;
      context = new (window.AudioContext || window.webkitAudioContext)();
      master = context.createGain();
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -19;
      compressor.knee.value = 17;
      compressor.ratio.value = 4;
      compressor.attack.value = .02;
      compressor.release.value = .28;
      master.connect(compressor);
      compressor.connect(context.destination);
    }

    function clear() {
      liveNodes.forEach(node => {
        try { node.stop(); } catch {}
      });
      liveNodes = [];
    }

    function schedule(offset) {
      const base = context.currentTime + .05;
      events.forEach(event => {
        const elapsed = Math.max(0, offset - event.t);
        if (elapsed >= event.duration - .02 || (!event.pad && elapsed > .02)) return;
        const startAt = base + Math.max(0, event.t - offset);
        const remaining = event.duration - elapsed;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = event.type;
        oscillator.frequency.value = event.frequency;
        oscillator.detune.value = Math.sin(event.frequency) * 4;

        if (event.pad) {
          const filter = context.createBiquadFilter();
          filter.type = "lowpass";
          filter.frequency.value = 820;
          oscillator.connect(filter);
          filter.connect(gain);
          const attackEnd = 1.1;
          const releaseStart = Math.max(1.15, event.duration - 1.2);
          const level = elapsed < attackEnd
            ? .0001 + (event.gain - .0001) * (elapsed / attackEnd)
            : elapsed < releaseStart
              ? event.gain
              : .0001 + (event.gain - .0001) * ((event.duration - elapsed) / (event.duration - releaseStart));
          gain.gain.setValueAtTime(Math.max(.0001, level), startAt);
          if (elapsed < attackEnd) {
            gain.gain.linearRampToValueAtTime(event.gain, startAt + attackEnd - elapsed);
          }
          if (elapsed < releaseStart) {
            gain.gain.setValueAtTime(event.gain, startAt + releaseStart - elapsed);
          }
          gain.gain.linearRampToValueAtTime(.0001, startAt + remaining);
        } else {
          oscillator.connect(gain);
          gain.gain.setValueAtTime(.0001, startAt);
          gain.gain.linearRampToValueAtTime(event.gain, startAt + .018);
          gain.gain.exponentialRampToValueAtTime(.0001, startAt + event.duration);
        }
        gain.connect(master);
        oscillator.start(startAt);
        oscillator.stop(startAt + remaining + .1);
        liveNodes.push(oscillator);
      });
    }

    return {
      start(offset, isMuted) {
        ensure();
        clear();
        master.gain.setValueAtTime(isMuted ? 0 : .85, context.currentTime);
        schedule(offset);
        context.resume();
      },
      pause() {
        if (context) context.suspend();
      },
      setMuted(isMuted) {
        if (!master || !context) return;
        master.gain.cancelScheduledValues(context.currentTime);
        master.gain.linearRampToValueAtTime(isMuted ? 0 : .85, context.currentTime + .08);
      },
    };
  })();

  $("#poster-play").addEventListener("click", play);
  $("#replay").addEventListener("click", () => {
    endOverlay.hidden = true;
    seek(0);
    play();
  });
  playPause.addEventListener("click", () => playing ? pause() : play());

  captionsToggle.addEventListener("click", () => {
    if (!voiceoverEnabled) return;
    captionsEnabled = !captionsEnabled;
    syncNarrationMode();
  });

  voiceoverButton.addEventListener("click", () => {
    voiceoverEnabled = !voiceoverEnabled;
    syncNarrationMode();
  });

  voiceSelect.addEventListener("change", () => {
    changeNarrator(voiceSelect.value);
  });

  muteButton.addEventListener("click", () => {
    muted = !muted;
    voiceover.muted = muted || !voiceoverEnabled;
    Score.setMuted(muted);
    volumeIcon.toggleAttribute("hidden", muted);
    mutedIcon.toggleAttribute("hidden", !muted);
    muteButton.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  });

  $("#fullscreen").addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  });

  timeline.addEventListener("pointerdown", event => {
    dragging = true;
    timeline.setPointerCapture(event.pointerId);
    seekFromPointer(event);
  });
  timeline.addEventListener("pointermove", event => {
    if (dragging) seekFromPointer(event);
  });
  timeline.addEventListener("pointerup", () => {
    dragging = false;
  });
  timeline.addEventListener("pointercancel", () => {
    dragging = false;
  });
  timeline.addEventListener("lostpointercapture", () => {
    dragging = false;
  });
  timeline.addEventListener("keydown", event => {
    if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) {
      event.stopPropagation();
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      seek(currentTime + (event.shiftKey ? 10 : 3));
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      seek(currentTime - (event.shiftKey ? 10 : 3));
    }
    if (event.key === "Home") seek(0);
    if (event.key === "End") seek(FILM_DURATION);
  });

  document.addEventListener("keydown", event => {
    if (event.code === "Space" && !/INPUT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName || "")) {
      event.preventDefault();
      playing ? pause() : play();
    } else if (event.key === "ArrowRight") {
      seek(movieNow() + 5);
    } else if (event.key === "ArrowLeft") {
      seek(movieNow() - 5);
    } else if (event.key.toLowerCase() === "m") {
      muteButton.click();
    } else if (event.key.toLowerCase() === "c") {
      captionsToggle.click();
    } else if (event.key.toLowerCase() === "f") {
      $("#fullscreen").click();
    }
  });

  voiceover.addEventListener("progress", () => {
    if (!voiceover.buffered.length || !Number.isFinite(voiceover.duration)) return;
    const buffered = voiceover.buffered.end(voiceover.buffered.length - 1);
    timelineBuffer.style.width = `${clamp(buffered / FILM_DURATION) * 100}%`;
  });

  window.addEventListener("resize", fitStage);
  document.addEventListener("fullscreenchange", fitStage);

  window.__seek = seconds => seek(Number(seconds) || 0);
  window.__play = play;
  window.__pause = pause;
  window.__film = {
    duration: FILM_DURATION,
    scenes: SCENES,
    get currentTime() { return movieNow(); },
    get playing() { return playing; },
    get voice() { return selectedVoice; },
  };

  $$(".chat-shell button").forEach(button => {
    button.tabIndex = -1;
    button.setAttribute("aria-hidden", "true");
  });
  syncNarrationMode();
  buildVoicePicker();
  buildChaos();
  buildTimeline();
  fitStage();
  const previewValue = new URLSearchParams(window.location.search).get("t");
  const previewTime = previewValue === null ? null : Number(previewValue);
  if (Number.isFinite(previewTime)) {
    currentTime = clamp(previewTime, 0, FILM_DURATION);
    startTime = currentTime;
    poster.classList.add("hidden");
  }
  requestAnimationFrame(() => {
    preparePaths();
    renderFrame(currentTime);
    setPlayIcon();
  });
})();
