(() => {
  "use strict";

  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));
  const state = {
    project: null,
    status: null,
    selectedLanguage: "en",
    selectedVoice: null,
    selectedScenes: new Set(),
    activeView: "script",
    dirty: false,
    catalogVoices: [],
  };

  const escapeHtml = value => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  const slugify = value => String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .slice(0, 48);
  const formatTime = seconds => {
    const minutes = Math.floor(Number(seconds) / 60);
    const rest = (Number(seconds) - minutes * 60).toFixed(2).padStart(5, "0");
    return `${minutes}:${rest}`;
  };
  const words = text => (String(text || "").trim().match(/\S+/g) || []).length;
  const unwrap = value => {
    if (typeof value === "string") {
      return value
        .replace(/^<untrusted-content\b[^>]*>/i, "")
        .replace(/<\/untrusted-content>$/i, "");
    }
    if (value && typeof value === "object") {
      return value.value || value.text || value.name || "";
    }
    return "";
  };

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Studio server returned ${response.status}.`);
    }
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || payload.message || `Request failed (${response.status}).`);
    }
    return payload;
  }

  function activeVoice() {
    return state.project.voices.find(voice => voice.key === state.selectedVoice) || null;
  }

  function activeLanguage() {
    return state.project.languages[state.selectedLanguage] || {
      name: state.selectedLanguage,
      locale: state.selectedLanguage,
    };
  }

  function voiceStatus(key) {
    return state.status?.voices?.[key] || { rawScenes: [], trackExists: false, trackBytes: 0 };
  }

  function markDirty() {
    state.dirty = true;
    $("#save-state").textContent = "UNSAVED CHANGES";
    $("#save-state").style.color = "var(--amber)";
  }

  function markSaved(label = "SAVED LOCALLY") {
    state.dirty = false;
    $("#save-state").textContent = label;
    $("#save-state").style.color = "";
  }

  function log(message, kind = "") {
    const item = document.createElement("div");
    item.className = `log-entry ${kind}`;
    item.innerHTML = `<time>${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><span>${escapeHtml(message)}</span>`;
    $("#activity-log").prepend(item);
  }

  let toastTimer;
  function toast(message, error = false) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.toggle("error", error);
    element.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("visible"), 3600);
  }

  function setBusy(active, title = "Working…", detail = "Please keep this window open.") {
    $("#busy-title").textContent = title;
    $("#busy-detail").textContent = detail;
    $("#busy-overlay").hidden = !active;
  }

  function renderLanguages() {
    $("#language-list").innerHTML = Object.entries(state.project.languages)
      .map(([code, language]) => {
        const voiceCount = state.project.voices.filter(voice => voice.language === code).length;
        return `
          <button class="side-item ${code === state.selectedLanguage ? "active" : ""}" data-language="${escapeHtml(code)}" type="button">
            <span class="side-icon">${escapeHtml(code.slice(0, 2).toUpperCase())}</span>
            <span class="side-copy"><b>${escapeHtml(language.name)}</b><small>${escapeHtml(language.locale || code)}</small></span>
            <span class="side-count">${voiceCount}</span>
          </button>`;
      }).join("");
  }

  function renderVoices() {
    $("#voice-list").innerHTML = state.project.voices.map(voice => {
      const status = voiceStatus(voice.key);
      const language = state.project.languages[voice.language]?.name || voice.language;
      return `
        <button class="side-item ${voice.key === state.selectedVoice ? "active" : ""}" data-voice="${escapeHtml(voice.key)}" type="button">
          <span class="side-icon">${escapeHtml(voice.name.slice(0, 1).toUpperCase())}</span>
          <span class="side-copy"><b>${escapeHtml(voice.name)}</b><small>${escapeHtml(language)} · ${escapeHtml(voice.gender || "Voice")}</small></span>
          <span class="side-count" title="${status.trackExists ? "Master track ready" : "Track missing"}">${status.trackExists ? "●" : "○"}</span>
        </button>`;
    }).join("");
  }

  function renderSceneList() {
    const voice = activeVoice();
    const status = voice ? voiceStatus(voice.key) : { rawScenes: [] };
    const language = activeLanguage();
    $("#workbench-title").textContent = voice
      ? `${voice.name} · ${language.name}`
      : `${language.name} script`;
    $("#workbench-subtitle").textContent = voice
      ? "Edit a section, regenerate it, and keep the film timing intact."
      : "Translate the script, then add a voice for this language.";

    $("#scene-list").innerHTML = state.project.scenes.map(scene => {
      const text = scene.scripts?.[state.selectedLanguage] || "";
      const count = words(text);
      const wpm = Math.round(count / (Number(scene.duration) / 60));
      const pressure = wpm > 190 ? "warn" : "";
      const ready = voice && status.rawScenes.includes(Number(scene.id));
      const selected = state.selectedScenes.has(Number(scene.id));
      return `
        <article class="scene-card ${selected ? "selected" : ""}" data-scene-card="${scene.id}">
          <div class="scene-main">
            <label class="scene-check" aria-label="Select scene ${scene.id}">
              <input class="scene-select" data-scene="${scene.id}" type="checkbox" ${selected ? "checked" : ""}>
            </label>
            <div class="scene-meta">
              <small>SCENE ${String(scene.id).padStart(2, "0")}</small>
              <strong>${escapeHtml(scene.name)}</strong>
              <time>${formatTime(scene.start)} → ${formatTime(scene.end)}</time>
              <span class="scene-status ${ready ? "" : "missing"}">${ready ? "AUDIO READY" : voice ? "AUDIO MISSING" : "NO VOICE"}</span>
            </div>
            <div class="scene-editor">
              <textarea data-script-scene="${scene.id}" aria-label="${escapeHtml(scene.name)} script">${escapeHtml(text)}</textarea>
              <div class="scene-footer">
                <span class="scene-stat">${count} words</span>
                <span class="scene-stat ${pressure}">${wpm} WPM target</span>
                <span class="scene-stat">${Number(scene.duration).toFixed(2)}s slot</span>
                <div class="scene-actions">
                  <button class="mini-button preview-scene" data-scene="${scene.id}" type="button" ${ready ? "" : "disabled"}>▶ Preview</button>
                  <button class="mini-button replace-scene" data-scene="${scene.id}" type="button" ${voice ? "" : "disabled"}>Replace audio</button>
                  <input class="file-input" data-file-scene="${scene.id}" type="file" accept="audio/*">
                  <button class="mini-button generate generate-scene" data-scene="${scene.id}" type="button" ${voice ? "" : "disabled"}>✦ Generate</button>
                </div>
              </div>
            </div>
          </div>
        </article>`;
    }).join("");

    const missingCount = voice
      ? state.project.scenes.length - status.rawScenes.length
      : state.project.scenes.length;
    $("#generate-selected").disabled = !voice || (state.selectedScenes.size === 0 && missingCount === 0);
    $("#render-track").disabled = !voice || missingCount > 0;
    $("#select-all-scenes").checked = state.selectedScenes.size === state.project.scenes.length;
    $("#select-all-scenes").indeterminate = state.selectedScenes.size > 0
      && state.selectedScenes.size < state.project.scenes.length;
    $("#selection-summary").textContent = `${state.selectedScenes.size} selected`;
    $("#generate-selected").textContent = state.selectedScenes.size
      ? `✦ Generate ${state.selectedScenes.size} selected`
      : missingCount
        ? `✦ Generate ${missingCount} missing`
        : "✦ Generate selected";
  }

  function renderCaptions() {
    const language = activeLanguage();
    $("#caption-title").textContent = `${language.name} subtitles`;
    const track = state.project.captionTracks[state.selectedLanguage] ||= [];
    $("#caption-list").innerHTML = track.map((cue, index) => `
      <tr data-cue="${index}">
        <td>${String(index + 1).padStart(2, "0")}</td>
        <td><input class="caption-time" data-cue-field="start" data-cue-index="${index}" type="number" min="0" step=".01" value="${Number(cue.start)}" aria-label="Cue ${index + 1} start"></td>
        <td><input class="caption-time" data-cue-field="end" data-cue-index="${index}" type="number" min="0" step=".01" value="${Number(cue.end)}" aria-label="Cue ${index + 1} end"></td>
        <td><input data-cue-field="text" data-cue-index="${index}" value="${escapeHtml(cue.text)}" aria-label="Cue ${index + 1} subtitle"></td>
        <td><button class="delete-cue" data-delete-cue="${index}" type="button" aria-label="Delete cue ${index + 1}">×</button></td>
      </tr>`).join("");
  }

  function collectReview() {
    const items = [];
    const voice = activeVoice();
    const status = voice ? voiceStatus(voice.key) : null;
    const scripts = state.project.scenes.map(scene => {
      const text = scene.scripts?.[state.selectedLanguage] || "";
      return {
        scene,
        words: words(text),
        wpm: Math.round(words(text) / (Number(scene.duration) / 60)),
      };
    });
    scripts.forEach(({ scene, words: count, wpm }) => {
      if (!count) items.push({ severity: "error", text: `Scene ${scene.id} has no ${activeLanguage().name} script.`, meta: "SCRIPT" });
      else if (wpm > 190) items.push({ severity: "warn", text: `Scene ${scene.id} targets ${wpm} WPM and may sound rushed.`, meta: "PACING" });
      else if (wpm < 75) items.push({ severity: "warn", text: `Scene ${scene.id} targets ${wpm} WPM and may need long pauses.`, meta: "PACING" });
    });
    if (!voice) {
      items.push({ severity: "error", text: `No narrator is assigned to ${activeLanguage().name}.`, meta: "VOICE" });
    } else {
      const missing = state.project.scenes.filter(scene => !status.rawScenes.includes(Number(scene.id)));
      if (missing.length) {
        items.push({ severity: "error", text: `${voice.name} is missing ${missing.length} audio section${missing.length === 1 ? "" : "s"}.`, meta: "AUDIO" });
      } else {
        items.push({ severity: "ok", text: `All ${voice.name} scene recordings are available.`, meta: "AUDIO" });
      }
      items.push(status.trackExists
        ? { severity: "ok", text: `${voice.name}'s synchronized master track is ready.`, meta: "MASTER" }
        : { severity: "error", text: `${voice.name}'s master track has not been rendered.`, meta: "MASTER" });
    }
    const cues = state.project.captionTracks[state.selectedLanguage] || [];
    if (!cues.length) {
      items.push({ severity: "error", text: `${activeLanguage().name} has no subtitles.`, meta: "CAPTIONS" });
    } else {
      let overlap = 0;
      let invalid = 0;
      cues.forEach((cue, index) => {
        if (!cue.text?.trim() || Number(cue.end) <= Number(cue.start)) invalid += 1;
        if (index && Number(cue.start) < Number(cues[index - 1].end) - .005) overlap += 1;
      });
      if (invalid) items.push({ severity: "error", text: `${invalid} subtitle cue${invalid === 1 ? " is" : "s are"} empty or mistimed.`, meta: "CAPTIONS" });
      if (overlap) items.push({ severity: "warn", text: `${overlap} subtitle cue${overlap === 1 ? "" : "s"} overlap.`, meta: "CAPTIONS" });
      if (!invalid && !overlap) items.push({ severity: "ok", text: `${cues.length} subtitle cues are ordered and valid.`, meta: "CAPTIONS" });
    }
    return { items, scripts, voice, status };
  }

  function renderReview() {
    const review = collectReview();
    const errors = review.items.filter(item => item.severity === "error").length;
    const warnings = review.items.filter(item => item.severity === "warn").length;
    const score = Math.max(0, 100 - errors * 20 - warnings * 5);
    $("#ready-score").textContent = `${score}%`;
    $("#quick-review").innerHTML = review.items.slice(0, 5).map(item => `
      <div class="quick-item ${item.severity}">
        <span class="quick-dot"></span><span>${escapeHtml(item.text)}</span>
      </div>`).join("");

    const totalWords = review.scripts.reduce((sum, item) => sum + item.words, 0);
    const pressure = review.scripts.filter(item => item.wpm > 190 || item.wpm < 75);
    const readyScenes = review.status?.rawScenes?.length || 0;
    $("#review-grid").innerHTML = `
      <article class="review-card">
        <header><span>SCRIPT</span><b>${totalWords}</b></header>
        <div class="check-list">
          <div class="check-item"><span class="check-icon">✓</span><span>${state.project.scenes.length} timed scenes</span><em>${escapeHtml(activeLanguage().name)}</em></div>
          <div class="check-item ${pressure.length ? "warn" : ""}"><span class="check-icon">${pressure.length ? "!" : "✓"}</span><span>${pressure.length ? `${pressure.length} pacing flag${pressure.length === 1 ? "" : "s"}` : "Pacing is within target"}</span><em>75–190 WPM</em></div>
        </div>
      </article>
      <article class="review-card">
        <header><span>AUDIO</span><b>${readyScenes}/${state.project.scenes.length}</b></header>
        <div class="check-list">
          <div class="check-item ${review.voice ? "" : "error"}"><span class="check-icon">${review.voice ? "✓" : "×"}</span><span>${review.voice ? escapeHtml(review.voice.name) : "No voice assigned"}</span><em>NARRATOR</em></div>
          <div class="check-item ${review.status?.trackExists ? "" : "error"}"><span class="check-icon">${review.status?.trackExists ? "✓" : "×"}</span><span>${review.status?.trackExists ? "Master track rendered" : "Master track missing"}</span><em>−16 LUFS</em></div>
        </div>
      </article>
      <article class="review-card wide">
        <header><span>ISSUES & CHECKS</span><b>${errors ? `${errors} ERROR${errors === 1 ? "" : "S"}` : warnings ? `${warnings} FLAG${warnings === 1 ? "" : "S"}` : "READY"}</b></header>
        <div class="check-list">
          ${review.items.map(item => `
            <div class="check-item ${item.severity}">
              <span class="check-icon">${item.severity === "ok" ? "✓" : item.severity === "warn" ? "!" : "×"}</span>
              <span>${escapeHtml(item.text)}</span><em>${escapeHtml(item.meta)}</em>
            </div>`).join("")}
        </div>
      </article>`;
  }

  function renderInspector() {
    const voice = activeVoice();
    const language = activeLanguage();
    const status = voice ? voiceStatus(voice.key) : null;
    $("#track-name").textContent = voice ? `${voice.name} · ${language.name}` : `No ${language.name} voice`;
    $("#track-state").textContent = status?.trackExists ? "READY" : "MISSING";
    $("#track-state").classList.toggle("missing", !status?.trackExists);
    const audio = $("#master-audio");
    if (voice && status?.trackExists) {
      const nextSource = `/${voice.source}?studio=${Date.now()}`;
      if (!audio.src.includes(`/${voice.source}`)) audio.src = nextSource;
      audio.hidden = false;
    } else {
      audio.removeAttribute("src");
      audio.load();
      audio.hidden = true;
    }
    $("#track-duration").textContent = `${formatTime(state.project.voiceoverEnd)} master`;
    renderReview();
  }

  function renderAll() {
    renderLanguages();
    renderVoices();
    renderSceneList();
    renderCaptions();
    renderInspector();
    $("#project-title").textContent = state.project.title;
    $("#ffmpeg-dot").classList.toggle("off", !state.status.ffmpeg || !state.status.ffprobe);
    $("#renderer-status").textContent = state.status.ffmpeg && state.status.ffprobe
      ? "ffmpeg ready · exact scene fitting"
      : "ffmpeg or ffprobe is missing";
  }

  async function saveProject(silent = false) {
    const payload = await api("/api/save", {
      method: "POST",
      body: JSON.stringify({ project: state.project }),
    });
    markSaved();
    if (!silent) {
      toast(payload.message);
      log(payload.message, "success");
    }
  }

  async function publishProject() {
    setBusy(true, "Publishing studio changes…", "Updating the film’s voice and subtitle manifest.");
    try {
      const payload = await api("/api/publish", {
        method: "POST",
        body: JSON.stringify({ project: state.project }),
      });
      markSaved("PUBLISHED");
      $("#film-preview").src = `/?t=0&studio=${Date.now()}`;
      toast(payload.message);
      log(payload.message, "success");
    } catch (error) {
      toast(error.message, true);
      log(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function generateScenes(sceneIds) {
    const voice = activeVoice();
    if (!voice) return;
    await saveProject(true);
    const count = sceneIds.length || (state.project.scenes.length - voiceStatus(voice.key).rawScenes.length);
    setBusy(
      true,
      `Generating ${voice.name}…`,
      `${count || "Selected"} section${count === 1 ? "" : "s"} via ElevenLabs, then rebuilding the master track.`,
    );
    try {
      const payload = await api("/api/generate", {
        method: "POST",
        body: JSON.stringify({ voiceKey: voice.key, sceneIds }),
      });
      state.status = payload.status;
      state.selectedScenes.clear();
      toast(payload.message);
      log(payload.message, "success");
      renderAll();
      $("#master-audio").src = `/${voice.source}?studio=${Date.now()}`;
    } catch (error) {
      toast(error.message, true);
      log(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function renderTrack() {
    const voice = activeVoice();
    if (!voice) return;
    await saveProject(true);
    setBusy(true, `Rebuilding ${voice.name}…`, "Fitting sections, inserting scene gaps, and normalizing loudness.");
    try {
      const payload = await api("/api/render", {
        method: "POST",
        body: JSON.stringify({ voiceKey: voice.key }),
      });
      state.status = payload.status;
      toast(payload.message);
      log(payload.message, "success");
      renderAll();
      $("#master-audio").src = `/${voice.source}?studio=${Date.now()}`;
    } catch (error) {
      toast(error.message, true);
      log(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function replaceScene(sceneId, file) {
    const voice = activeVoice();
    if (!voice || !file) return;
    if (file.size > 25 * 1024 * 1024) {
      toast("Please choose an audio file under 25 MB.", true);
      return;
    }
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    await saveProject(true);
    setBusy(true, `Replacing scene ${sceneId}…`, `Rebuilding ${voice.name}'s synchronized master track.`);
    try {
      const payload = await api("/api/replace-section", {
        method: "POST",
        body: JSON.stringify({ voiceKey: voice.key, sceneId, data, fileName: file.name }),
      });
      state.status = payload.status;
      toast(payload.message);
      log(payload.message, "success");
      renderAll();
    } catch (error) {
      toast(error.message, true);
      log(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  function previewScene(sceneId) {
    const voice = activeVoice();
    if (!voice) return;
    const preview = new Audio(`/assets/audio/voice-scenes/${voice.key}/scene-${String(sceneId).padStart(2, "0")}-raw.mp3?studio=${Date.now()}`);
    preview.play().catch(() => toast("The browser could not play this section.", true));
    const scene = state.project.scenes.find(item => Number(item.id) === Number(sceneId));
    $("#film-preview").src = `/?t=${scene.start}&studio=${Date.now()}`;
    log(`Previewing ${voice.name}, scene ${sceneId}.`);
  }

  function switchView(view) {
    state.activeView = view;
    $$(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === view));
    $$(".view").forEach(panel => panel.classList.toggle("active", panel.id === `${view}-view`));
    if (view === "review") renderReview();
  }

  function addVoiceFromForm() {
    const name = $("#voice-name").value.trim();
    const key = slugify($("#voice-key").value);
    const voiceId = $("#voice-id").value.trim();
    if (!name || !key || !voiceId) {
      toast("Name, key, and ElevenLabs voice ID are required.", true);
      return false;
    }
    if (state.project.voices.some(voice => voice.key === key)) {
      toast(`The voice key “${key}” already exists.`, true);
      return false;
    }
    const language = $("#voice-language").value;
    state.project.voices.push({
      key,
      name,
      voiceId,
      language,
      gender: $("#voice-gender").value.trim(),
      modelId: "eleven_v3",
      stability: 0.42,
      similarityBoost: 0.8,
      source: `assets/audio/flujo-voiceover-${key}.mp3`,
    });
    state.status.voices[key] = { rawScenes: [], trackExists: false, trackBytes: 0 };
    state.selectedVoice = key;
    state.selectedLanguage = language;
    state.selectedScenes.clear();
    markDirty();
    renderAll();
    log(`Added ${name}. Generate the missing sections to create its track.`);
    toast(`${name} added. Generate its eight sections when ready.`);
    return true;
  }

  function addLanguageFromForm() {
    const name = $("#language-name").value.trim();
    const code = $("#language-code").value.trim().toLowerCase();
    if (!name || !/^[a-z0-9-]+$/i.test(code)) {
      toast("Enter a valid language name and code.", true);
      return false;
    }
    if (state.project.languages[code]) {
      toast(`Language “${code}” already exists.`, true);
      return false;
    }
    const source = state.selectedLanguage;
    const sourceName = state.project.languages[source]?.name || source;
    state.project.languages[code] = {
      name,
      locale: $("#language-locale").value.trim() || code,
    };
    state.project.scenes.forEach(scene => {
      scene.scripts ||= {};
      scene.scripts[code] = scene.scripts[source] || "";
    });
    state.project.captionTracks[code] = structuredClone(state.project.captionTracks[source] || []);
    state.selectedLanguage = code;
    state.selectedVoice = state.project.voices.find(voice => voice.language === code)?.key || null;
    state.selectedScenes.clear();
    markDirty();
    renderAll();
    log(`Added ${name}; copied ${sourceName} editing tracks.`);
    toast(`${name} added. Translate its script and subtitles next.`);
    return true;
  }

  async function loadVoiceCatalog() {
    const button = $("#load-elevenlabs");
    button.disabled = true;
    button.textContent = "Loading ElevenLabs voices…";
    try {
      const result = await api("/api/elevenlabs/voices");
      const payload = result.payload || {};
      state.catalogVoices = payload.voices || payload.data?.voices || [];
      const select = $("#voice-catalog");
      select.innerHTML = `<option value="">Choose or enter one manually…</option>` + state.catalogVoices.map((voice, index) => {
        const name = unwrap(voice.name) || `Voice ${index + 1}`;
        return `<option value="${index}">${escapeHtml(name)}${voice.category ? ` · ${escapeHtml(voice.category)}` : ""}</option>`;
      }).join("");
      toast(`Loaded ${state.catalogVoices.length} ElevenLabs voices.`);
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = "Reload ElevenLabs voice catalog";
    }
  }

  function bindEvents() {
    $$("[data-close-dialog]").forEach(button => button.addEventListener("click", () => {
      button.closest("dialog")?.close();
    }));
    $("#save-project").addEventListener("click", () => saveProject().catch(error => toast(error.message, true)));
    $("#publish-project").addEventListener("click", publishProject);
    $("#generate-selected").addEventListener("click", () => generateScenes([...state.selectedScenes]));
    $("#render-track").addEventListener("click", renderTrack);
    $("#refresh-review").addEventListener("click", renderReview);
    $("#reload-preview").addEventListener("click", () => {
      const frame = $("#film-preview");
      frame.src = `${frame.src.split("&studio=")[0]}&studio=${Date.now()}`;
    });
    $("#clear-log").addEventListener("click", () => { $("#activity-log").innerHTML = ""; });

    $$(".tab").forEach(tab => tab.addEventListener("click", () => switchView(tab.dataset.view)));

    $("#language-list").addEventListener("click", event => {
      const item = event.target.closest("[data-language]");
      if (!item) return;
      state.selectedLanguage = item.dataset.language;
      state.selectedVoice = state.project.voices.find(voice => voice.language === state.selectedLanguage)?.key || null;
      state.selectedScenes.clear();
      renderAll();
    });
    $("#voice-list").addEventListener("click", event => {
      const item = event.target.closest("[data-voice]");
      if (!item) return;
      state.selectedVoice = item.dataset.voice;
      state.selectedLanguage = activeVoice().language;
      state.selectedScenes.clear();
      renderAll();
    });

    $("#select-all-scenes").addEventListener("change", event => {
      state.selectedScenes.clear();
      if (event.target.checked) state.project.scenes.forEach(scene => state.selectedScenes.add(Number(scene.id)));
      renderSceneList();
    });

    $("#scene-list").addEventListener("change", event => {
      if (event.target.matches(".scene-select")) {
        const sceneId = Number(event.target.dataset.scene);
        event.target.checked ? state.selectedScenes.add(sceneId) : state.selectedScenes.delete(sceneId);
        renderSceneList();
      }
      if (event.target.matches("[data-file-scene]") && event.target.files[0]) {
        replaceScene(Number(event.target.dataset.fileScene), event.target.files[0]);
      }
    });
    $("#scene-list").addEventListener("input", event => {
      if (!event.target.matches("[data-script-scene]")) return;
      const scene = state.project.scenes.find(item => Number(item.id) === Number(event.target.dataset.scriptScene));
      scene.scripts ||= {};
      scene.scripts[state.selectedLanguage] = event.target.value;
      markDirty();
      const editor = event.target.closest(".scene-editor");
      const count = words(event.target.value);
      const wpm = Math.round(count / (Number(scene.duration) / 60));
      const stats = editor.querySelectorAll(".scene-stat");
      stats[0].textContent = `${count} words`;
      stats[1].textContent = `${wpm} WPM target`;
      stats[1].classList.toggle("warn", wpm > 190);
      renderReview();
    });
    $("#scene-list").addEventListener("click", event => {
      const preview = event.target.closest(".preview-scene");
      if (preview) previewScene(Number(preview.dataset.scene));
      const generate = event.target.closest(".generate-scene");
      if (generate) generateScenes([Number(generate.dataset.scene)]);
      const replace = event.target.closest(".replace-scene");
      if (replace) {
        $(`[data-file-scene="${replace.dataset.scene}"]`).click();
      }
    });

    $("#caption-list").addEventListener("input", event => {
      if (!event.target.matches("[data-cue-field]")) return;
      const cue = state.project.captionTracks[state.selectedLanguage][Number(event.target.dataset.cueIndex)];
      const field = event.target.dataset.cueField;
      cue[field] = field === "text" ? event.target.value : Number(event.target.value);
      markDirty();
      renderReview();
    });
    $("#caption-list").addEventListener("click", event => {
      const button = event.target.closest("[data-delete-cue]");
      if (!button) return;
      state.project.captionTracks[state.selectedLanguage].splice(Number(button.dataset.deleteCue), 1);
      markDirty();
      renderCaptions();
      renderReview();
    });
    $("#add-caption").addEventListener("click", () => {
      const track = state.project.captionTracks[state.selectedLanguage] ||= [];
      const start = track.length ? Number(track.at(-1).end) : 0;
      track.push({ start, end: Math.min(start + 3, state.project.voiceoverEnd), text: "New subtitle" });
      markDirty();
      renderCaptions();
    });

    $("#add-voice").addEventListener("click", () => {
      $("#voice-form").reset();
      delete $("#voice-key").dataset.touched;
      $("#voice-catalog").innerHTML = `<option value="">Choose or enter one manually…</option>`;
      $("#voice-language").innerHTML = Object.entries(state.project.languages)
        .map(([code, language]) => `<option value="${escapeHtml(code)}" ${code === state.selectedLanguage ? "selected" : ""}>${escapeHtml(language.name)}</option>`)
        .join("");
      $("#voice-dialog").showModal();
    });
    $("#voice-name").addEventListener("input", event => {
      if (!$("#voice-key").dataset.touched) $("#voice-key").value = slugify(event.target.value);
    });
    $("#voice-key").addEventListener("input", event => { event.target.dataset.touched = "true"; });
    $("#load-elevenlabs").addEventListener("click", loadVoiceCatalog);
    $("#voice-catalog").addEventListener("change", event => {
      const voice = state.catalogVoices[Number(event.target.value)];
      if (!voice) return;
      const name = unwrap(voice.name) || "Narrator";
      $("#voice-name").value = name;
      $("#voice-key").value = slugify(name);
      $("#voice-id").value = voice.voice_id || voice.voiceId || "";
      $("#voice-gender").value = unwrap(voice.labels?.gender) || unwrap(voice.gender) || "";
    });
    $("#confirm-voice").addEventListener("click", event => {
      event.preventDefault();
      if (addVoiceFromForm()) $("#voice-dialog").close();
    });

    $("#add-language").addEventListener("click", () => {
      $("#language-form").reset();
      $("#language-dialog").showModal();
    });
    $("#confirm-language").addEventListener("click", event => {
      event.preventDefault();
      if (addLanguageFromForm()) $("#language-dialog").close();
    });

    window.addEventListener("beforeunload", event => {
      if (!state.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  async function init() {
    try {
      const payload = await api("/api/project");
      state.project = payload.project;
      state.status = payload.status;
      state.selectedLanguage = state.project.defaultLanguage;
      state.selectedVoice = state.project.defaultVoice;
      bindEvents();
      renderAll();
      markSaved();
      log("Studio project loaded.", "success");
    } catch (error) {
      $("#project-title").textContent = "Studio unavailable";
      toast(error.message, true);
      log(error.message, "error");
    }
  }

  init();
})();
