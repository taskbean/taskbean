// taskbean voice capture AudioWorkletProcessor
//
// Replaces the deprecated ScriptProcessorNode in the legacy capture path.
// Forwards each Float32 audio quantum from the audio render thread to the
// main thread via port.postMessage, where the consumer either:
//   - accumulates frames into a WAV for /api/transcribe (Whisper batch), or
//   - downsamples to Int16-LE PCM for the live WebSocket bridge (Nemotron).
//
// Served as a same-origin static file (rather than an inline Blob URL) so
// that audioWorklet.addModule's internal fetch is allowed by the strict
// connect-src CSP. Blob URLs were getting blocked with "AbortError: Unable
// to load a worklet's module."
class TaskbeanCaptureProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;
        // Copy because the underlying buffer is reused by the audio system.
        const samples = new Float32Array(input[0]);
        this.port.postMessage(samples, [samples.buffer]);
        return true;
    }
}
registerProcessor('taskbean-capture', TaskbeanCaptureProcessor);
