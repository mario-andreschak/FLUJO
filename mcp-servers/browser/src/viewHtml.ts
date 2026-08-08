/**
 * The live browser UI, served from the gateway's own loopback origin.
 *
 * This document is deliberately NOT the MCP App resource. The MCP App resource
 * is a thin shell that iframes this page (the same trick the VS Code MCP App
 * uses for OpenVSCode), which means this document runs on a real HTTP origin
 * and is therefore free of the host's app CSP — no `worker-src 'none'`, no
 * missing `blob:`, no inline-only scripting. That is what lets the viewport
 * behave like a real browser window instead of a screenshot slideshow.
 */
export function renderBrowserViewHtml(): string {
  return VIEW_HTML;
}

const VIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>Browser</title>
<style>
:root{
  --chrome:#dee1e6; --chrome-hi:#f1f3f4; --tab:#fff; --fg:#202124; --muted:#5f6368;
  --omni:#fff; --omni-border:#dadce0; --accent:#1a73e8; --page:#fff; --danger:#c5221f; --hover:rgba(0,0,0,.06);
}
html[data-theme="dark"]{
  --chrome:#202124; --chrome-hi:#292a2d; --tab:#35363a; --fg:#e8eaed; --muted:#9aa0a6;
  --omni:#292a2d; --omni-border:#3c4043; --accent:#8ab4f8; --page:#202124; --danger:#f28b82; --hover:rgba(255,255,255,.08);
}
*{box-sizing:border-box}
html,body{height:100%;margin:0;overflow:hidden}
body{background:var(--chrome);color:var(--fg);font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;user-select:none}
button{font:inherit;color:inherit;background:none;border:0;border-radius:50%;width:30px;height:30px;display:grid;place-items:center;cursor:pointer;flex:none}
button:hover:not(:disabled){background:var(--hover)}
button:disabled{opacity:.35;cursor:default}
button svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

/* ---- tab strip ---- */
#tabs{display:flex;align-items:flex-end;gap:2px;height:36px;padding:5px 6px 0;flex:none}
.tab{display:flex;align-items:center;gap:8px;height:31px;padding:0 10px;min-width:120px;max-width:260px;
  background:var(--tab);border-radius:9px 9px 0 0;box-shadow:0 0 0 .5px rgba(0,0,0,.08)}
.tab .favicon{width:15px;height:15px;flex:none;fill:none;stroke:var(--muted);stroke-width:2;visibility:hidden}
.tab .label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.tab button{width:19px;height:19px}
.tab button svg{width:11px;height:11px}
#spinner{width:14px;height:14px;flex:none;border:2px solid var(--muted);border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite;display:none}
.loading #spinner{display:block}
.loading .favicon{display:none}
@keyframes spin{to{transform:rotate(360deg)}}

/* ---- toolbar ---- */
#bar{display:flex;align-items:center;gap:2px;padding:4px 6px;background:var(--chrome-hi);flex:none}
#omnibox{flex:1;display:flex;align-items:center;gap:8px;height:30px;padding:0 12px;margin:0 6px;
  background:var(--omni);border:1px solid var(--omni-border);border-radius:15px;min-width:0}
#omnibox:focus-within{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
#security{width:14px;height:14px;flex:none;stroke:var(--muted);fill:none;stroke-width:2}
#security.secure{stroke:#188038}
#security.insecure{stroke:var(--danger)}
#url{flex:1;min-width:0;border:0;outline:0;background:none;color:inherit;font:inherit;user-select:text}
#url::placeholder{color:var(--muted)}
#progress{height:2px;background:var(--accent);width:0;transition:width .2s ease,opacity .3s;opacity:0;flex:none}
.loading #progress{opacity:1}

/* ---- viewport ---- */
#stage{flex:1;position:relative;background:var(--page);overflow:hidden;min-height:0}
#screen{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block;background:var(--page);
  -webkit-user-drag:none;outline:none}
#stage:focus-within #screen{outline:none}
#overlay{position:absolute;inset:0;display:none;place-items:center;background:var(--page);color:var(--muted);
  text-align:center;padding:24px;font-size:13px}
#overlay.show{display:grid}
#overlay b{display:block;color:var(--fg);font-size:15px;margin-bottom:6px;font-weight:600}
#retry{width:auto;height:28px;padding:0 14px;border-radius:14px;border:1px solid var(--omni-border);margin-top:12px}

/* ---- status ---- */
#status{position:absolute;left:0;bottom:0;max-width:70%;padding:3px 9px;background:var(--chrome-hi);color:var(--muted);
  font-size:11px;border-radius:0 6px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:none}
#status.show{display:block}

/* ---- sound ---- */
#soundWaves{display:none}
#soundCross{display:none}
body.audio-on #soundWaves{display:inline}
body:not(.audio-on) #soundCross{display:inline}
body.audio-blocked #sound{color:var(--accent)}
</style>
</head>
<body>

<div id="tabs">
  <div class="tab" id="tab">
    <div id="spinner"></div>
    <svg class="favicon" id="favicon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"/></svg>
    <span class="label" id="tabLabel">New tab</span>
    <button id="closeTab" title="Close session"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  </div>
</div>

<div id="bar">
  <button id="back" title="Back (Alt+Left)"><svg viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></button>
  <button id="forward" title="Forward (Alt+Right)"><svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg></button>
  <button id="reload" title="Reload (Ctrl+R)"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6"/></svg></button>
  <div id="omnibox">
    <svg id="security" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>
    <input id="url" type="text" placeholder="Search or enter address" spellcheck="false" autocomplete="off" />
  </div>
  <button id="sound" title="Play this session's audio" hidden><svg viewBox="0 0 24 24"><path id="soundIcon" d="M11 5L6 9H3v6h3l5 4V5z"/><g id="soundWaves"><path d="M16 9a4 4 0 010 6"/><path d="M19 6a8 8 0 010 12"/></g><path id="soundCross" d="M16 9l5 6M21 9l-5 6"/></svg></button>
  <button id="fullscreen" title="Toggle full screen"><svg viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/></svg></button>
</div>
<div id="progress"></div>

<div id="stage">
  <img id="screen" alt="Live browser viewport" draggable="false" tabindex="0" />
  <div id="overlay" class="show"><div><b>Connecting to the browser…</b><span id="overlayMsg">Starting the isolated session.</span><br/><button id="retry">Retry</button></div></div>
  <div id="status"></div>
</div>

<script>
(function(){
  "use strict";
  var q = new URLSearchParams(location.search);
  var sid = q.get("s") || "";
  var token = q.get("t") || "";
  var el = function(id){ return document.getElementById(id); };
  var screenEl = el("screen"), overlay = el("overlay"), overlayMsg = el("overlayMsg");
  var urlEl = el("url"), statusEl = el("status"), progress = el("progress");
  var tabLabel = el("tabLabel"), favicon = el("favicon"), security = el("security");
  var viewport = { width: 1280, height: 720 };
  var editing = false, streamAlive = false, retryTimer = 0, retryDelay = 500;

  function api(path){
    return path + "?s=" + encodeURIComponent(sid) + "&t=" + encodeURIComponent(token);
  }
  function toShell(message){
    try { parent.postMessage(Object.assign({ source: "flujo-browser-view" }, message), "*"); } catch (e) {}
  }
  function setStatus(text){
    statusEl.textContent = text || "";
    statusEl.classList.toggle("show", !!text);
  }
  function setLoading(on){
    document.body.classList.toggle("loading", !!on);
    progress.style.width = on ? "70%" : "100%";
    if (!on) setTimeout(function(){ progress.style.width = "0"; }, 250);
  }
  function showOverlay(title, detail){
    overlay.querySelector("b").textContent = title;
    overlayMsg.textContent = detail || "";
    overlay.classList.add("show");
  }
  function hideOverlay(){ overlay.classList.remove("show"); }

  /* ---------------- input ---------------- */
  var queued = [], flushHandle = 0;
  function flush(){
    flushHandle = 0;
    if (!queued.length) return;
    var batch = queued;
    queued = [];
    fetch(api("/input"), {
      method: "POST",
      // A CORS-safelisted content type keeps every keystroke preflight-free.
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(batch)
    }).catch(function(){});
  }
  function send(event, immediate){
    queued.push(event);
    if (immediate) { if (flushHandle) { cancelAnimationFrame(flushHandle); flushHandle = 0; } flush(); return; }
    if (!flushHandle) flushHandle = requestAnimationFrame(flush);
  }

  /** Map a pointer event onto page CSS pixels through the letterboxed frame. */
  function toPage(e){
    var w = screenEl.naturalWidth, h = screenEl.naturalHeight;
    if (!w || !h) return null;
    var r = screenEl.getBoundingClientRect();
    var scale = Math.min(r.width / w, r.height / h);
    var ox = r.left + (r.width - w * scale) / 2;
    var oy = r.top + (r.height - h * scale) / 2;
    var x = (e.clientX - ox) / scale, y = (e.clientY - oy) / scale;
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    return { x: Math.round(x * (viewport.width / w)), y: Math.round(y * (viewport.height / h)) };
  }

  screenEl.addEventListener("mousemove", function(e){
    var p = toPage(e); if (!p) return;
    // Coalesce: only the newest pointer position in a frame is meaningful.
    for (var i = queued.length - 1; i >= 0; i--) if (queued[i].type === "mousemove") { queued.splice(i, 1); break; }
    send({ type: "mousemove", x: p.x, y: p.y });
  });
  screenEl.addEventListener("mousedown", function(e){
    var p = toPage(e); if (!p) return;
    e.preventDefault(); screenEl.focus();
    send({ type: "mousedown", x: p.x, y: p.y, button: buttonName(e.button), clickCount: Math.min(3, e.detail || 1) }, true);
  });
  window.addEventListener("mouseup", function(e){
    var p = toPage(e); if (!p) return;
    send({ type: "mouseup", x: p.x, y: p.y, button: buttonName(e.button), clickCount: Math.min(3, e.detail || 1) }, true);
  });
  screenEl.addEventListener("contextmenu", function(e){ e.preventDefault(); });
  screenEl.addEventListener("wheel", function(e){
    e.preventDefault();
    send({ type: "wheel", deltaX: e.deltaX, deltaY: e.deltaY }, true);
  }, { passive: false });
  screenEl.addEventListener("dragstart", function(e){ e.preventDefault(); });

  function buttonName(code){ return code === 2 ? "right" : code === 1 ? "middle" : "left"; }

  var PASSTHROUGH = /^(Enter|Tab|Backspace|Delete|Escape|Arrow|Page|Home|End|F\\d)/;
  screenEl.addEventListener("keydown", function(e){
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l"){ e.preventDefault(); urlEl.focus(); urlEl.select(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r"){ e.preventDefault(); navigateCommand("reload"); return; }
    if (e.altKey && e.key === "ArrowLeft"){ e.preventDefault(); navigateCommand("back"); return; }
    if (e.altKey && e.key === "ArrowRight"){ e.preventDefault(); navigateCommand("forward"); return; }
    if (e.key.length === 1 || PASSTHROUGH.test(e.key)) e.preventDefault();
    send({ type: "keydown", key: e.key }, true);
  });
  screenEl.addEventListener("keyup", function(e){ send({ type: "keyup", key: e.key }, true); });
  // IME and clipboard paste never surface as plain keydowns.
  screenEl.addEventListener("paste", function(e){
    var text = e.clipboardData && e.clipboardData.getData("text");
    if (!text) return;
    e.preventDefault();
    send({ type: "text", text: text }, true);
  });

  /* ---------------- viewport sizing ---------------- */
  var resizeTimer = 0;
  function syncViewport(){
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function(){
      var r = el("stage").getBoundingClientRect();
      var width = Math.max(320, Math.min(3840, Math.round(r.width)));
      var height = Math.max(240, Math.min(2160, Math.round(r.height)));
      if (width === viewport.width && height === viewport.height) return;
      viewport = { width: width, height: height };
      send({ type: "viewport", width: width, height: height }, true);
    }, 200);
  }
  if (window.ResizeObserver) new ResizeObserver(syncViewport).observe(el("stage"));
  window.addEventListener("resize", syncViewport);

  /* ---------------- live frame stream ---------------- */
  function attachStream(){
    streamAlive = false;
    screenEl.src = api("/stream") + "&_=" + Date.now();
  }
  screenEl.addEventListener("load", function(){
    streamAlive = true; retryDelay = 500; hideOverlay();
  });
  // MJPEG keeps one response open forever, so "error" means the socket died.
  screenEl.addEventListener("error", function(){
    streamAlive = false;
    showOverlay("Live view interrupted", "Reconnecting to the browser session…");
    scheduleRetry();
  });
  function scheduleRetry(){
    if (retryTimer) return;
    retryTimer = setTimeout(function(){
      retryTimer = 0;
      retryDelay = Math.min(8000, retryDelay * 2);
      attachStream();
    }, retryDelay);
  }
  el("retry").onclick = function(){ retryDelay = 500; attachStream(); };

  /* ---------------- audio ----------------
     The page's Web Audio graph is tapped server-side and streamed here as raw
     PCM; playback happens in this browser, exactly like a locally rendered
     audio app. Autoplay policy still applies, so a suspended context surfaces
     as a highlighted speaker button the user can click. */
  var audioCtx, audioAbort, audioNext = 0, audioWanted = false, audioAvailable = false;
  var soundBtn = el("sound");

  function audioSupported(){
    return !!(window.AudioContext || window.webkitAudioContext) && !!window.ReadableStream;
  }
  function setAudioState(){
    document.body.classList.toggle("audio-on", audioWanted && !!audioCtx && audioCtx.state === "running");
    document.body.classList.toggle("audio-blocked", audioWanted && !!audioCtx && audioCtx.state !== "running");
    soundBtn.title = audioWanted && !!audioCtx && audioCtx.state === "running" ? "Mute this session" : "Play this session's audio";
  }
  function stopAudio(){
    audioWanted = false;
    if (audioAbort) { audioAbort.abort(); audioAbort = null; }
    audioNext = 0;
    setAudioState();
  }
  function startAudio(){
    if (!audioAvailable || !audioSupported()) return;
    audioWanted = true;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!audioCtx) audioCtx = new Ctor();
    if (audioCtx.state === "suspended") audioCtx.resume().then(setAudioState, setAudioState);
    if (!audioAbort) pumpAudio();
    setAudioState();
  }
  soundBtn.onclick = function(){
    if (audioWanted && audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().then(setAudioState, setAudioState);
      return;
    }
    if (audioWanted) stopAudio(); else startAudio();
  };
  // A click anywhere in the view is the gesture an autoplay-blocked context needs.
  document.addEventListener("pointerdown", function(){
    if (audioWanted && audioCtx && audioCtx.state === "suspended") audioCtx.resume().then(setAudioState, setAudioState);
  }, true);

  function pumpAudio(){
    audioAbort = new AbortController();
    fetch(api("/audio"), { signal: audioAbort.signal }).then(function(response){
      if (!response.ok || !response.body) throw new Error("audio unavailable");
      var reader = response.body.getReader();
      var pending = new Uint8Array(0);
      function read(){
        return reader.read().then(function(result){
          if (result.done) return;
          pending = concat(pending, result.value);
          pending = drain(pending);
          return read();
        });
      }
      return read();
    }).catch(function(){}).then(function(){
      audioAbort = null;
      // Reconnect while the user still wants sound; the stream ends whenever
      // the session navigates away or the socket drops.
      if (audioWanted) setTimeout(function(){ if (audioWanted && !audioAbort) pumpAudio(); }, 700);
    });
  }
  function concat(a, b){
    if (!a.length) return b;
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }
  /** Consume every whole [rate, channels, byteLength] frame in the buffer. */
  function drain(bytes){
    var offset = 0;
    while (bytes.length - offset >= 12) {
      var head = new DataView(bytes.buffer, bytes.byteOffset + offset, 12);
      var rate = head.getUint32(0, true), channels = head.getUint32(4, true), length = head.getUint32(8, true);
      if (bytes.length - offset - 12 < length) break;
      var pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset + offset + 12, bytes.byteOffset + offset + 12 + length));
      offset += 12 + length;
      schedule(pcm, rate, channels);
    }
    return offset ? bytes.subarray(offset) : bytes;
  }
  function schedule(pcm, rate, channels){
    if (!audioCtx || !audioWanted || audioCtx.state !== "running") return;
    var frames = Math.floor(pcm.length / channels);
    if (!frames) return;
    var buffer = audioCtx.createBuffer(channels, frames, rate);
    for (var c = 0; c < channels; c++) {
      var data = buffer.getChannelData(c);
      for (var i = 0; i < frames; i++) data[i] = pcm[i * channels + c] / 32768;
    }
    var source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    var now = audioCtx.currentTime;
    // Keep a small jitter buffer, and resynchronise whenever the network
    // hiccup pushed us behind or a pause left us far ahead.
    if (audioNext < now + 0.02 || audioNext > now + 0.6) audioNext = now + 0.12;
    source.start(audioNext);
    audioNext += buffer.duration;
  }

  /* ---------------- page state ---------------- */
  var events;
  function attachEvents(){
    try { events = new EventSource(api("/events")); } catch (e) { return; }
    events.addEventListener("state", function(message){
      var data;
      try { data = JSON.parse(message.data); } catch (e) { return; }
      applyState(data);
    });
    events.onerror = function(){
      // EventSource reconnects on its own; surface nothing unless frames stop.
      if (!streamAlive) setStatus("Reconnecting…");
    };
  }
  function applyState(data){
    if (data.viewport && data.viewport.width) viewport = data.viewport;
    if (data.audio && audioSupported() && !audioAvailable){
      audioAvailable = true;
      setAudioState();
      // Sound is part of "live", so try immediately; a blocked context simply
      // waits for the first click instead of failing silently.
      startAudio();
    }
    // Configuration means the capture path may be used; a non-silent PCM
    // chunk is the first truthful proof that this page actually has audio.
    soundBtn.hidden = !(data.audio && data.audioSignal);
    setLoading(data.phase === "loading");
    var url = data.url && data.url !== "about:blank" ? data.url : "";
    if (!editing) urlEl.value = url;
    tabLabel.textContent = data.title || hostOf(url) || "New tab";
    document.title = data.title || "Browser";
    setStatus("");
    if (url.indexOf("https://") === 0) security.className = "secure";
    else if (url.indexOf("http://") === 0) security.className = "insecure";
    else security.className = "";
    // Deliberately no third-party favicon service: an isolated browser must not
    // leak every hostname the session visits to an outside provider.
    favicon.style.visibility = url ? "visible" : "hidden";
  }
  function hostOf(url){ try { return new URL(url).hostname; } catch (e) { return ""; } }

  /* ---------------- navigation (relayed through the MCP shell) ---------------- */
  function navigateCommand(kind, url){
    setLoading(true);
    toShell({ type: kind, url: url });
  }
  el("back").onclick = function(){ navigateCommand("back"); };
  el("forward").onclick = function(){ navigateCommand("forward"); };
  el("reload").onclick = function(){ navigateCommand("reload"); };
  el("closeTab").onclick = function(){ toShell({ type: "close" }); };
  el("fullscreen").onclick = function(){ toShell({ type: "fullscreen" }); };
  urlEl.onfocus = function(){ editing = true; urlEl.select(); };
  urlEl.onblur = function(){ editing = false; };
  urlEl.onkeydown = function(e){
    if (e.key === "Escape"){ urlEl.blur(); screenEl.focus(); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    var value = urlEl.value.trim();
    if (!value) return;
    urlEl.blur();
    screenEl.focus();
    navigateCommand("navigate", normalizeAddress(value));
  };
  /** Treat bare words as a search and bare hosts as https, like a real omnibox. */
  function normalizeAddress(value){
    if (/^https?:\\/\\//i.test(value)) return value;
    if (/^[^\\s.\\/]+\\.[^\\s\\/]{2,}(\\/|$|\\?|#)/.test(value) || /^localhost(:\\d+)?(\\/|$)/i.test(value)) {
      return "https://" + value;
    }
    return "https://duckduckgo.com/?q=" + encodeURIComponent(value);
  }

  /* ---------------- shell messages ---------------- */
  window.addEventListener("message", function(event){
    var data = event.data;
    if (!data || data.source !== "flujo-browser-shell") return;
    if (data.type === "theme"){
      document.documentElement.dataset.theme = data.theme === "dark" ? "dark" : "light";
      return;
    }
    if (data.type === "error"){ setStatus(data.message || ""); return; }
    if (data.type === "loading"){ setLoading(!!data.value); return; }
  });

  if (!sid || !token){
    showOverlay("Live view unavailable", "The session handshake did not complete.");
    return;
  }
  attachEvents();
  attachStream();
  syncViewport();
  screenEl.focus();
  toShell({ type: "ready" });
})();
</script>
</body>
</html>`;
