/**
 * The in-page audio tap.
 *
 * Chromium renders a page's audio into a device sink Node cannot reach, so the
 * only portable way to hear what an isolated session is playing is to intercept
 * the Web Audio graph inside the page and ship the samples out ourselves. This
 * is the same shape the MCP audio studio app uses in reverse: audio is always
 * produced by Web Audio in the *viewer's* browser, never streamed as encoded
 * media, which is why it plays without codec or CSP trouble.
 *
 * Two sources have to be covered:
 *  1. pages that build their own AudioContext — their `destination` is replaced
 *     by a tap node, so their whole graph flows through us;
 *  2. plain `<audio>`/`<video>` elements — each is routed into a shared tap
 *     context the first time it plays.
 *
 * One tap serves every listener on the page (the live view and a recording
 * can listen at the same time). Each listener is a CDP binding with its own
 * on/off switch in `window.__flujoAudioSinks`, so turning one off never
 * silences another. Installing the tap again only adds a listener; whichever
 * listener installs first also covers sound the page sets up before the
 * others arrive.
 *
 * The script must run in the page's MAIN world, which is why the gateway
 * injects it over CDP: Patchright evaluates Playwright scripts in an isolated
 * world where patching `window` would have no effect. `--mute-audio` only
 * silences the device sink, so the graph still carries real samples and the
 * host machine still stays quiet.
 */
import type { CDPSession } from 'patchright';

const SINKS = 'window.__flujoAudioSinks';

/**
 * Install the tap (once per document) and register `binding` as a listener.
 * `muted: true` registers the listener switched off without switching off one
 * that is already listening; `muted: false` switches it on.
 */
export function audioTapSource(binding: string, muted = false): string {
  const name = JSON.stringify(binding);
  const register = muted
    ? `if (!Object.prototype.hasOwnProperty.call(sinks, ${name})) sinks[${name}] = true;`
    : `sinks[${name}] = false;`;
  return `(function(){
  var sinks = ${SINKS} || (${SINKS} = {});
  ${register}
  if (window.__flujoAudioTap) return;
  var NativeCtx = window.AudioContext || window.webkitAudioContext;
  if (!NativeCtx) return;
  window.__flujoAudioTap = true;
  var CHUNK = 4096;
  var SILENCE = 1 / 32768;

  function encode(bytes){
    var out = "", step = 0x8000;
    for (var i = 0; i < bytes.length; i += step) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(out);
  }

  function listeners(){
    var names = Object.keys(sinks), live = [];
    for (var i = 0; i < names.length; i++) {
      if (sinks[names[i]] === false && typeof window[names[i]] === "function") live.push(names[i]);
    }
    return live;
  }

  /** Insert a silent recorder between a context's graph and its real output. */
  function tap(ctx, output){
    var input = ctx.createGain();
    var processor = ctx.createScriptProcessor(CHUNK, 2, 2);
    processor.onaudioprocess = function(event){
      var live = listeners();
      if (live.length === 0) return;
      var buffer = event.inputBuffer;
      var frames = buffer.length;
      var left = buffer.getChannelData(0);
      var right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
      var pcm = new Int16Array(frames * 2);
      var silent = true;
      for (var i = 0; i < frames; i++) {
        var a = left[i], b = right[i];
        if (a > 1) a = 1; else if (a < -1) a = -1;
        if (b > 1) b = 1; else if (b < -1) b = -1;
        if (silent && (a > SILENCE || a < -SILENCE || b > SILENCE || b < -SILENCE)) silent = false;
        pcm[i * 2] = a * 32767;
        pcm[i * 2 + 1] = b * 32767;
      }
      // Digital silence is the common case on a normal page; never spend
      // bandwidth or CDP round trips on it.
      if (silent) return;
      var payload = JSON.stringify({ rate: ctx.sampleRate, pcm: encode(new Uint8Array(pcm.buffer)) });
      for (var j = 0; j < live.length; j++) {
        try {
          window[live[j]](payload);
        } catch (error) {
          sinks[live[j]] = true;
        }
      }
    };
    input.connect(processor);
    // A ScriptProcessor only runs while it is reachable from the destination.
    // Its own output stays silent because onaudioprocess never writes one.
    processor.connect(output);
    return input;
  }

  // 1) Pages with their own AudioContext.
  function patch(Ctor){
    if (typeof Ctor !== "function") return Ctor;
    function Patched(){
      var ctx = new (Function.prototype.bind.apply(Ctor, [null].concat([].slice.call(arguments))))();
      try {
        var input = tap(ctx, ctx.destination);
        input.maxChannelCount = ctx.destination.maxChannelCount;
        Object.defineProperty(ctx, "destination", {
          configurable: true,
          get: function(){ return input; }
        });
      } catch (error) { /* an untappable context still plays normally */ }
      return ctx;
    }
    Patched.prototype = Ctor.prototype;
    return Patched;
  }
  try {
    if (window.AudioContext) window.AudioContext = patch(window.AudioContext);
    if (window.webkitAudioContext) window.webkitAudioContext = patch(window.webkitAudioContext);
  } catch (error) { /* frozen globals: media elements below still work */ }

  // 2) Plain media elements, routed into one shared context on first play.
  var mediaCtx, mediaTap, attached = new WeakSet();
  function attach(element){
    if (attached.has(element)) return;
    try {
      if (!mediaCtx) {
        mediaCtx = new NativeCtx();
        mediaTap = tap(mediaCtx, mediaCtx.destination);
      }
      attached.add(element);
      mediaCtx.createMediaElementSource(element).connect(mediaTap);
      if (mediaCtx.state === "suspended") mediaCtx.resume();
    } catch (error) {
      // Cross-origin media without CORS headers taints the graph; leave the
      // element alone so at least the picture keeps playing.
    }
  }
  document.addEventListener("play", function(event){
    var target = event.target;
    if (target && (target.tagName === "AUDIO" || target.tagName === "VIDEO")) attach(target);
  }, true);

  // Installing the tap after a session was opened must still recover media
  // whose play event already fired. The pre-navigation install is the normal
  // path; this scan is the fallback for reused sessions and dynamically added
  // elements that began playing before they entered the document.
  function attachPlaying(root){
    if (!root) return;
    if ((root.tagName === "AUDIO" || root.tagName === "VIDEO") && !root.paused && !root.ended) attach(root);
    if (typeof root.querySelectorAll !== "function") return;
    var media = root.querySelectorAll("audio,video");
    for (var i = 0; i < media.length; i++) {
      if (!media[i].paused && !media[i].ended) attach(media[i]);
    }
  }
  attachPlaying(document);
  if (window.MutationObserver) {
    new MutationObserver(function(records){
      for (var i = 0; i < records.length; i++) {
        for (var j = 0; j < records[i].addedNodes.length; j++) attachPlaying(records[i].addedNodes[j]);
      }
    }).observe(document.documentElement || document, { childList: true, subtree: true });
  }
})();`;
}

/** Switch one listener on or off without touching the others. */
export function audioSinkMutedExpression(binding: string, muted: boolean): string {
  return `(${SINKS} || (${SINKS} = {}))[${JSON.stringify(binding)}] = ${muted ? 'true' : 'false'};`;
}

/** Whether the current document already has a tap (so sound set up earlier on the page is covered). */
export const AUDIO_TAP_PRESENT_EXPRESSION = 'window.__flujoAudioTap === true';

/**
 * Keep `contextIds` equal to the page's main-world contexts (one per frame).
 * Call before `Runtime.enable`, which reports the contexts that already exist.
 */
export function trackMainWorlds(
  cdp: CDPSession,
  contextIds: Set<number>,
  onCreated?: (contextId: number) => void,
): void {
  cdp.on('Runtime.executionContextCreated', (event) => {
    const isDefault = (event.context.auxData as Record<string, unknown> | undefined)?.isDefault;
    if (isDefault !== true && isDefault !== 'true') return;
    contextIds.add(event.context.id);
    onCreated?.(event.context.id);
  });
  cdp.on('Runtime.executionContextDestroyed', (event) => {
    contextIds.delete(event.executionContextId);
  });
  cdp.on('Runtime.executionContextsCleared', () => contextIds.clear());
}

/**
 * Run `expression` in every known main world, or in the main frame when none
 * is known yet. A context that throws is forgotten. Returns how many contexts
 * ran it without an exception.
 */
export async function evaluateInMainWorlds(
  cdp: CDPSession,
  contextIds: Set<number>,
  expression: string,
): Promise<number> {
  const ids = [...contextIds];
  if (ids.length === 0) {
    const result = await cdp.send('Runtime.evaluate', { expression }).catch(() => undefined);
    return result && !result.exceptionDetails ? 1 : 0;
  }
  const accepted = await Promise.all(ids.map(async (contextId) => {
    const result = await cdp.send('Runtime.evaluate', { expression, contextId }).catch(() => undefined);
    if (!result) return 0;
    if (result.exceptionDetails) {
      contextIds.delete(contextId);
      return 0;
    }
    return 1;
  }));
  return accepted.reduce<number>((sum, value) => sum + value, 0);
}
