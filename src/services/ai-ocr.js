const { extractJson, isLocalEndpoint } = require('./vision');

function normalizeEndpoint(endpoint) {
  const value = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!value) throw new Error('请先在设置中配置视觉模型接口。');
  return value.endsWith('/v1') ? value : `${value}/v1`;
}

function buildOcrInstruction(localText = '') {
  const hint = String(localText || '').trim();
  return [
    '你是严格的截图 OCR 转写引擎。',
    '逐字读取图片中的可见文字，保持原始语言、大小写、数字、标点、段落、换行和阅读顺序。',
    '不要翻译，不要润色，不要纠正文案，不要补写图片中不存在的内容。',
    '表格尽量按从左到右、从上到下的顺序保留；无法确认的字符使用 ⟦无法辨认⟧，不要猜测。',
    hint ? `本地 OCR 草稿仅供定位，必须以图片为准：\n${hint.slice(0, 6000)}` : '',
    '只输出 JSON：{"text":"逐字转写结果","language":"zh-CN|en|mixed|unknown","confidence":0-100}',
  ].filter(Boolean).join('\n\n');
}

function normalizeAiOcr(payload = {}) {
  const confidenceValue = Number(payload.confidence);
  const confidence = Number.isFinite(confidenceValue)
    ? Math.max(0, Math.min(100, confidenceValue <= 1 ? confidenceValue * 100 : confidenceValue))
    : 0;
  return {
    text: String(payload.text || payload.transcription || payload.content || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    detectedLanguage: String(payload.language || payload.detected_language || 'unknown').trim() || 'unknown',
    confidence: Math.round(confidence),
  };
}

function shouldEnhanceOcr(ocr, threshold = 82) {
  const text = String(ocr?.text || '').trim();
  if (!text) return true;
  if (Number(ocr?.confidence || 0) < threshold) return true;
  const blocks = Array.isArray(ocr?.blocks) ? ocr.blocks : [];
  if (blocks.length >= 3) {
    const lowConfidenceLines = blocks.filter((block) => Number(block.confidence || 0) < threshold - 8).length;
    if (lowConfidenceLines / blocks.length >= 0.3) return true;
  }
  const suspicious = (text.match(/[�□]|\?{3,}|[|]{3,}/g) || []).length;
  return suspicious >= 2;
}

async function requestAiOcr({ endpoint, apiKey, model, dataUrl, localText = '', signal }) {
  const baseUrl = normalizeEndpoint(endpoint);
  const selectedModel = String(model || '').trim();
  if (!selectedModel) throw new Error('请先在设置中填写视觉模型名称。');
  if (!apiKey && !isLocalEndpoint(baseUrl)) throw new Error('请先在设置中保存视觉模型 API Key。');
  if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(dataUrl || '')) throw new Error('没有可识别的截图。');
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: selectedModel,
        temperature: 0,
        max_tokens: 2200,
        messages: [
          { role: 'system', content: buildOcrInstruction(localText) },
          {
            role: 'user',
            content: [
              { type: 'text', text: '逐字提取这张截图中的全部可见文字，只返回约定 JSON。' },
              { type: 'image_url', image_url: { url: dataUrl, detail: 'original' } },
            ],
          },
        ],
      }),
      signal: signal || AbortSignal.timeout(60000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw error;
    throw new Error(`无法连接 AI OCR 服务 ${baseUrl}。`);
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`AI OCR 请求失败（${response.status}）：${detail.slice(0, 180)}`);
  }
  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;
  let payload;
  try {
    payload = extractJson(content);
  } catch {
    payload = { text: content };
  }
  const normalized = normalizeAiOcr(payload);
  if (!normalized.text) throw new Error('AI OCR 没有返回可用文字。');
  return {
    ...normalized,
    provider: selectedModel,
    latency: Date.now() - startedAt,
  };
}

module.exports = {
  buildOcrInstruction,
  normalizeAiOcr,
  requestAiOcr,
  shouldEnhanceOcr,
};
