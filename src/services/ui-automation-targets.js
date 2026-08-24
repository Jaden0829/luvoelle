const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DEFAULT_TIMEOUT_MS = 1400;
let worker = null;
let workerReadyPromise = null;
let resolveWorkerReady = null;
let rejectWorkerReady = null;
let requestSequence = 0;
const pendingRequests = new Map();

function rejectPending(error) {
  pendingRequests.forEach(({ reject, timer }) => {
    clearTimeout(timer);
    reject(error);
  });
  pendingRequests.clear();
}

function resetWorker(error = new Error('UI Automation worker stopped')) {
  const current = worker;
  worker = null;
  workerReadyPromise = null;
  if (rejectWorkerReady) rejectWorkerReady(error);
  resolveWorkerReady = null;
  rejectWorkerReady = null;
  rejectPending(error);
  if (current && !current.killed) {
    try { current.kill(); } catch { /* process is already gone */ }
  }
}

function encodedWorkerScript() {
  const source = fs.readFileSync(path.join(__dirname, 'ui-automation-worker.ps1'), 'utf8');
  return Buffer.from(source, 'utf16le').toString('base64');
}

function startWorker() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  if (workerReadyPromise) return workerReadyPromise;

  workerReadyPromise = new Promise((resolve, reject) => {
    resolveWorkerReady = resolve;
    rejectWorkerReady = reject;
  });
  worker = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodedWorkerScript(),
  ], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const current = worker;
  const lines = readline.createInterface({ input: current.stdout });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type === 'ready') {
      if (current !== worker) return;
      const resolve = resolveWorkerReady;
      resolveWorkerReady = null;
      rejectWorkerReady = null;
      resolve?.(true);
      return;
    }
    const pending = pendingRequests.get(String(message.id));
    if (!pending) return;
    pendingRequests.delete(String(message.id));
    clearTimeout(pending.timer);
    if (message.type === 'result') pending.resolve({
      targets: Array.isArray(message.targets) ? message.targets : message.targets ? [message.targets] : [],
      roots: Array.isArray(message.roots) ? message.roots : message.roots ? [message.roots] : [],
      elapsedMs: Number(message.elapsedMs) || 0,
    });
    else pending.reject(new Error(message.message || 'UI Automation scan failed'));
  });
  current.once('error', (error) => {
    if (current === worker) resetWorker(error);
  });
  current.once('exit', (code) => {
    if (current === worker) resetWorker(new Error(`UI Automation worker exited (${code ?? 'unknown'})`));
  });
  // Drain provider diagnostics so a noisy provider cannot fill the pipe.
  current.stderr.on('data', () => {});
  return workerReadyPromise;
}

async function requestUiAutomationTargets(handles, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const normalizedHandles = [...new Set((handles || []).map((value) => String(value || '').trim()).filter((value) => /^\d+$/.test(value) && value !== '0'))];
  if (process.platform !== 'win32' || !normalizedHandles.length) return { targets: [], roots: [], elapsedMs: 0 };
  await startWorker();
  if (!worker?.stdin?.writable) throw new Error('UI Automation worker is unavailable');

  const id = String(++requestSequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pendingRequests.has(id)) return;
      pendingRequests.delete(id);
      reject(new Error('UI Automation scan timed out'));
      resetWorker(new Error('UI Automation provider stopped responding'));
    }, Math.max(250, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    pendingRequests.set(id, { resolve, reject, timer });
    worker.stdin.write(`${JSON.stringify({ type: 'scan', id, handles: normalizedHandles })}\n`, 'utf8', (error) => {
      if (!error || !pendingRequests.has(id)) return;
      pendingRequests.delete(id);
      clearTimeout(timer);
      reject(error);
    });
  });
}

function warmUiAutomationTargetDetection() {
  if (process.platform !== 'win32') return;
  startWorker().catch(() => {});
}

function shutdownUiAutomationTargetDetection() {
  if (!worker) return;
  const current = worker;
  try { current.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`); } catch { /* worker may already be closing */ }
  setTimeout(() => {
    if (worker === current) resetWorker(new Error('UI Automation worker shutdown'));
  }, 120).unref?.();
}

module.exports = {
  requestUiAutomationTargets,
  shutdownUiAutomationTargetDetection,
  warmUiAutomationTargetDetection,
};
