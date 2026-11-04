// Minimal stand-in for @github/copilot-sdk/extension. It captures the canvas
// declaration so evals can call action handlers without a Copilot host.
const captured = (globalThis.__taskbeanEval ??= { canvases: [], logs: [], session: null });

export class CanvasError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CanvasError';
    this.code = code;
  }

  static noHandler() {
    return new CanvasError('no_handler', 'No handler is wired for this action.');
  }
}

export function createCanvas(config) {
  captured.canvases.push(config);
  return config;
}

export async function joinSession(options) {
  captured.session = options;
  return {
    async log(message, details = {}) {
      captured.logs.push({ message, ...details });
    },
  };
}
