const fs = require('fs');
const path = require('path');
const { parentPort: threadParentPort, workerData } = require('worker_threads');

const utilityParentPort = process.parentPort;
const communicationPort = threadParentPort || utilityParentPort;
const modelRootValue = workerData?.modelRoot || process.env.LUVOELLE_OCR_MODEL_ROOT;

if (!communicationPort || !modelRootValue) {
  throw new Error('OCR 隔离进程缺少通信端口或模型目录。');
}

let servicePromise;
let queue = Promise.resolve();

function emit(payload) {
  communicationPort.postMessage(payload);
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function dataUrlToArrayBuffer(dataUrl) {
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(String(dataUrl || ''));
  if (!match) throw new Error('无法读取 OCR 图片数据。');
  return toArrayBuffer(Buffer.from(match[1], 'base64'));
}

async function createService() {
  const { PaddleOcrService } = await import('ppu-paddle-ocr');
  const modelRoot = path.resolve(modelRootValue);
  const service = new PaddleOcrService({
    model: {
      detection: path.join(modelRoot, 'PP-OCRv6_small_det.onnx'),
      recognition: path.join(modelRoot, 'PP-OCRv6_small_rec.onnx'),
      charactersDictionary: path.join(modelRoot, 'ppocrv6_dict.txt'),
    },
    detection: {
      maxSideLength: 1280,
      minimumAreaThreshold: 8,
      paddingVertical: 0.2,
      paddingHorizontal: 0.35,
    },
    recognition: {
      strategy: 'per-box',
      minimumConfidence: 0.35,
    },
    session: {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    },
    debugging: { verbose: false, debug: false },
  });
  const startedAt = Date.now();
  await service.initialize();
  const warmupPath = path.join(modelRoot, 'warmup.png');
  if (fs.existsSync(warmupPath)) {
    try {
      await service.recognize(toArrayBuffer(fs.readFileSync(warmupPath)), { noCache: true, strategy: 'per-box' });
    } catch {
      // The sessions remain initialized even if the synthetic warmup image fails.
    }
  }
  return {
    service,
    summary: {
      backend: 'native',
      provider: 'cpu',
      model: 'PP-OCRv6 small',
      elapsedMs: Date.now() - startedAt,
    },
  };
}

function getService() {
  if (!servicePromise) servicePromise = createService();
  return servicePromise;
}

function normalizeResult(result, totalMs, scale = 1) {
  const lines = Array.isArray(result.lines) ? result.lines : [];
  const blocks = lines.flat().map((item, index) => ({
    text: String(item.text || '').trim(),
    confidence: Math.round(Math.max(0, Math.min(1, Number(item.confidence || 0))) * 100),
    rect: {
      x: Number(item.box?.x || 0) / scale,
      y: Number(item.box?.y || 0) / scale,
      width: Number(item.box?.width || 0) / scale,
      height: Number(item.box?.height || 0) / scale,
    },
    lineId: `paddle-${index}`,
    paragraphId: `paddle-${index}`,
  })).filter((item) => item.text && item.rect.width > 0 && item.rect.height > 0);
  return {
    text: String(result.text || blocks.map((item) => item.text).join('\n')).trim(),
    confidence: Math.round(Math.max(0, Math.min(1, Number(result.confidence || 0))) * 100),
    blocks,
    runtime: { backend: 'native', provider: 'cpu', webgpuAvailable: false },
    metrics: { totalMs },
  };
}

async function recognize(command) {
  const startedAt = Date.now();
  emit({ type: 'progress', id: command.id, stage: command.refined ? 'paddle-refine' : 'paddle-ocr', progress: command.refined ? 72 : 28 });
  const { service } = await getService();
  const result = await service.recognize(dataUrlToArrayBuffer(command.dataUrl), {
    noCache: true,
    strategy: 'per-box',
  });
  emit({
    type: 'result',
    id: command.id,
    result: normalizeResult(result, Date.now() - startedAt, Number(command.scale || 1)),
  });
}

function handleCommand(command) {
  if (command?.type === 'shutdown') {
    getService().then(({ service }) => service.destroy()).finally(() => process.exit(0));
    return;
  }
  if (command?.type !== 'recognize' || !command.id || !command.dataUrl) return;
  if (process.env.LUVOELLE_TEST_OCR_PROCESS_EXIT === '1') process.exit(86);
  queue = queue.then(() => recognize(command)).catch((error) => {
    emit({ type: 'error', id: command.id, message: error?.message || String(error) });
  });
}

if (threadParentPort) threadParentPort.on('message', handleCommand);
else utilityParentPort.on('message', (event) => handleCommand(event.data));

getService().then(({ summary }) => emit({ type: 'ready', summary })).catch((error) => {
  emit({ type: 'failed', message: error?.message || String(error) });
});
