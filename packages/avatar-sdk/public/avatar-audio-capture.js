// The processor also provides a stable source of PCM for browser-independent STT.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(2048); this.count = 0; }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      let offset = 0;
      while (offset < channel.length) {
        const length = Math.min(channel.length - offset, this.block.length - this.count);
        this.block.set(channel.subarray(offset, offset + length), this.count);
        this.count += length; offset += length;
        if (this.count === this.block.length) {
          this.port.postMessage(this.block, [this.block.buffer]); this.block = new Float32Array(2048); this.count = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
