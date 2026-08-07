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
 * The script must run in the page's MAIN world, which is why the gateway
 * injects it over CDP: Patchright evaluates Playwright scripts in an isolated
 * world where patching `window` would have no effect. `--mute-audio` only
 * silences the device sink, so the graph still carries real samples and the
 * host machine still stays quiet.
 */
export function audioTapSource(binding: string): string {
  return `(function(){
  if (window.__flujoAudioTap) { window.__flujoAudioMuted = false; return; }
  var NativeCtx = window.AudioContext || window.webkitAudioContext;
  if (!NativeCtx) return;
  window.__flujoAudioTap = true;
  window.__flujoAudioMuted = false;
  var CHUNK = 4096;
  var SILENCE = 1 / 32768;

  function encode(bytes){
    var out = "", step = 0x8000;
    for (var i = 0; i < bytes.length; i += step) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(out);
  }

  /** Insert a silent recorder between a context's graph and its real output. */
  function tap(ctx, output){
    var input = ctx.createGain();
    var processor = ctx.createScriptProcessor(CHUNK, 2, 2);
    processor.onaudioprocess = function(event){
      var send = window.${binding};
      if (window.__flujoAudioMuted || typeof send !== "function") return;
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
      try {
        send(JSON.stringify({ rate: ctx.sampleRate, pcm: encode(new Uint8Array(pcm.buffer)) }));
      } catch (error) {
        window.__flujoAudioMuted = true;
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
})();`;
}
