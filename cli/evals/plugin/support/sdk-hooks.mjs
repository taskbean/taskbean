import { registerHooks, register } from 'node:module';

const SDK = '@github/copilot-sdk/extension';
const STUB = new URL('./sdk-stub.mjs', import.meta.url).href;

export function installSdkStub() {
  if (globalThis.__taskbeanSdkStubInstalled) return;
  globalThis.__taskbeanSdkStubInstalled = true;
  if (typeof registerHooks === 'function') {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === SDK) return { url: STUB, shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
  } else {
    register(new URL('./sdk-hooks-async.mjs', import.meta.url));
  }
}
