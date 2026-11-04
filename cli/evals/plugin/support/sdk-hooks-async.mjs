const SDK = '@github/copilot-sdk/extension';
const STUB = new URL('./sdk-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === SDK) return { url: STUB, shortCircuit: true };
  return nextResolve(specifier, context);
}
