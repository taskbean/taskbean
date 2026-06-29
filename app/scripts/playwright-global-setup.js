const baseURL = (process.env.TASKBEAN_BASE_URL || 'https://taskbean.localhost').replace(/\/$/, '');
const timeoutMs = Number.parseInt(process.env.TASKBEAN_READY_TIMEOUT_MS || `${6 * 60_000}`, 10);

async function waitForReady() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/api/ready`);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.modelReady) {
        return;
      }
      if (response.status >= 500 && data.startupError) {
        throw new Error(`Taskbean startup failed: ${data.startupError}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Taskbean startup failed:')) {
        throw error;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(`Taskbean did not become ready within ${timeoutMs}ms at ${baseURL}/api/ready`);
}

export default waitForReady;
