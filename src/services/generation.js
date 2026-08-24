const STRATEGY_LABELS = Object.freeze({
  style: '只取风格',
  composition: '保持构图',
  subject: '保持主体',
  product: '保持商品',
  character: '保持角色',
  shot: '保持镜头',
  continuity: '延续剧情',
});

const GRID_SUBJECT_LABELS = Object.freeze({
  auto: '自动判断主体',
  fashion: '人物穿搭',
  selling: '人物带货',
  product: '纯商品',
});

const GRID_STYLE_LABELS = Object.freeze({
  source: '保持原图视觉',
  studio: '白底棚拍',
  premium: '高级商业',
  lifestyle: '生活方式',
});

function normalizeEndpoint(endpoint = '') {
  const normalized = String(endpoint).trim().replace(/\/$/, '');
  if (!normalized) throw new Error('请先在设置中配置图像生成接口。');
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('图像生成接口地址无效。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('图像生成接口只支持 HTTP 或 HTTPS。');
  return normalized;
}

function isLocalEndpoint(endpoint = '') {
  try {
    const url = new URL(endpoint);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function parseImageDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('没有可用于参考生成的截图。');
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}

function normalizeAnalysisMode(mode = '') {
  return ['daily', 'ecommerce', 'drama'].includes(mode) ? mode : 'daily';
}

function primaryPromptForMode(analysis = {}) {
  const mode = normalizeAnalysisMode(analysis.analysisMode || analysis.analysis_mode);
  if (mode === 'drama') {
    return analysis.prompts?.firstFrameZh
      || analysis.prompts?.keyframeZh
      || analysis.prompts?.storyboardZh
      || analysis.prompts?.first_frame_zh
      || '';
  }
  return analysis.prompts?.qwenImage || analysis.prompts?.universalZh || analysis.prompts?.qwen_image || analysis.prompts?.universal_zh || '';
}

function buildReferencePrompt({ prompt, strategy = 'style', analysis = {} }) {
  const analysisMode = normalizeAnalysisMode(analysis.analysisMode || analysis.analysis_mode);
  const basePrompt = String(prompt || primaryPromptForMode(analysis)).trim();
  if (!basePrompt) throw new Error('请先填写生图提示词。');
  if (analysisMode === 'drama') {
    const shared = '以输入截图作为短剧镜头参考，生成一张新的电影感剧情关键帧。当前图片只用于角色、服装、场景、道具和镜头关系参考。不要复制水印、字幕、Logo 或版权角色；可见对白仅作为剧情线索，除非用户明确要求，否则不要重新渲染文字。避免任何营销陈列、零售卖点或商业主视觉包装。';
    const instructions = {
      character: '锁定可见角色的脸型、五官、发型、肤色、年龄感、体型和服装；允许改变动作与表情，但不得换脸、换人、改衣或新增角色。',
      shot: '保留当前画幅、景别、机位高度、人物站位、视线方向、画面轴线、留白和光影方向；只根据提示词调整戏剧动作与情绪强度。',
      continuity: '把输入图视为当前镜头的首帧或关键帧，延续可见动作、情绪和空间关系；只生成与当前状态自然相接的下一戏剧瞬间，不虚构无法确认的重大前因后果。',
    };
    return `${shared}\n${instructions[strategy] || instructions.character}\n\n镜头要求：${basePrompt}`;
  }

  if (analysisMode === 'ecommerce') {
    const shared = '生成一张全新的、可用于商业电商展示的高质量图片。不要复制水印、竞品品牌名、版权角色或不可替换的宣传文案。';
    const instructions = {
      style: '参考输入图的配色、材质表现、灯光质感和视觉氛围，但采用明显不同的构图与道具布局；商品与品牌使用提示词中的可替换变量。',
      composition: '保留输入图的画幅比例、主体位置、镜头角度、留白关系和光影方向，同时替换品牌、商品文字与装饰细节，形成独立设计。',
      product: '只在用户确认拥有商品图片权利时使用。尽可能保持前景商品的外形比例、包装几何、标签位置、Logo 与可读文字不变，仅重新设计背景、道具和环境光。',
    };
    return `${shared}\n${instructions[strategy] || instructions.style}\n\n画面要求：${basePrompt}`;
  }

  const shared = '基于输入图片生成一张新的高质量视觉作品。不要复制水印、专有 Logo、版权角色或不可替换的文字内容。';
  const instructions = {
    style: '只参考配色、光线、质感和整体氛围，采用明显不同的构图与元素布局。',
    composition: '保留画幅比例、主体位置、镜头角度、留白和光影方向，同时替换具体内容与装饰细节。',
    subject: '保持输入图中核心人物或物体的可见身份特征、比例、颜色与形态，只改变环境、动作或视觉表达。',
  };
  return `${shared}\n${instructions[strategy] || instructions.style}\n\n画面要求：${basePrompt}`;
}

function buildEcommerceGridPrompt({ analysis = {}, subjectMode = 'auto', visualStyle = 'source', extraPrompt = '' } = {}) {
  const detectedSubjectType = String(analysis.modeData?.subject_type || analysis.modeData?.subjectType || '').toLowerCase();
  const searchableSubject = `${detectedSubjectType} ${analysis.product?.category || ''} ${analysis.product?.subject || ''}`.toLowerCase();
  let inferredSubjectMode = 'product';
  if (/person_with_product|带货|手持|使用商品|模特.*商品/.test(searchableSubject)) inferredSubjectMode = 'selling';
  else if (/person|人物|模特|穿搭|服装|服饰|美妆人像/.test(searchableSubject)) inferredSubjectMode = 'fashion';
  const effectiveSubjectMode = subjectMode === 'auto' ? inferredSubjectMode : subjectMode;
  const subjectLabel = subjectMode === 'auto'
    ? `${GRID_SUBJECT_LABELS.auto}（识别为${GRID_SUBJECT_LABELS[effectiveSubjectMode]}）`
    : (GRID_SUBJECT_LABELS[subjectMode] || GRID_SUBJECT_LABELS.auto);
  const styleLabel = GRID_STYLE_LABELS[visualStyle] || GRID_STYLE_LABELS.source;
  const subject = String(analysis.product?.subject || analysis.summary || '输入图中的核心主体').trim();
  const category = String(analysis.product?.category || '').trim();
  const materials = (analysis.product?.materials || []).filter(Boolean).join('、');
  const colors = (analysis.product?.colors || []).filter(Boolean).join('、');
  const details = (analysis.product?.details || []).filter(Boolean).join('、');
  const locks = (analysis.modeData?.identity_locks || analysis.modeData?.identityLocks || []).filter(Boolean).join('；');
  const negative = String(analysis.prompts?.negative || '').trim();
  const subjectFacts = [
    `主体：${subject}`,
    category && `品类：${category}`,
    materials && `材质：${materials}`,
    colors && `颜色：${colors}`,
    details && `可见细节：${details}`,
    locks && `身份锁定：${locks}`,
  ].filter(Boolean).join('\n');

  const shotPlans = {
    fashion: [
      '左上：45度全身或大半身电商主视觉', '中上：正面平视完整穿搭', '右上：侧面轮廓展示',
      '左中：背面或后侧45度展示', '正中：上半身与脸部身份特写', '右中：服装面料、剪裁或配饰细节特写',
      '左下：自然动态姿势', '中下：真实使用或生活方式场景', '右下：带安全留白的品牌广告主视觉',
    ],
    selling: [
      '左上：人物与商品的45度带货主视觉', '中上：人物正面手持商品', '右上：人物侧面展示商品使用关系',
      '左中：商品靠近镜头、人物仍清晰可辨', '正中：人物脸部表情与商品同框特写', '右中：商品材质、功能或包装细节特写',
      '左下：人物实际操作商品', '中下：生活方式使用场景', '右下：人物与商品的广告KV，保留文案安全区',
    ],
    product: [
      '左上：45度商品英雄主图', '中上：正面平视完整视图', '右上：侧面轮廓视图',
      '左中：后侧45度结构视图，不得虚构不可见结构', '正中：俯拍平铺或完整套装', '右中：材质纹理微距',
      '左下：核心功能、控制或标签细节', '中下：真实使用与尺寸参照场景', '右下：包装全家福或带留白的广告KV',
    ],
    auto: [
      '左上：45度电商英雄主视觉', '中上：正面平视完整展示', '右上：侧面轮廓展示',
      '左中：后侧45度展示，不得虚构不可见结构', '正中：主体身份或上半身核心特写', '右中：材质、服装或商品细节微距',
      '左下：自然动作或功能使用', '中下：生活方式与尺度关系场景', '右下：带安全留白的高级广告主视觉',
    ],
  };

  return `Create ONE final square e-commerce contact-sheet image, not nine separate files.
The final canvas must be an exact 3-by-3 grid containing nine equal rectangular panels with clean, even gutters and aligned edges. Do not add panel numbers, captions, labels, UI, borders with text, logos not present in the reference, or decorative typography.

Use the supplied image as the identity reference. Every panel must show the exact same recognizable primary person and/or product. Lock face identity, hairstyle, skin tone, body proportions, clothing design, product silhouette, material, color, packaging geometry, label position and visible logo. Change only camera angle, shot size, pose, action, crop and scene arrangement. Do not create a different person or a redesigned product in any panel. Do not invent hidden ports, packaging copy, accessories or rear structures; when the reference does not reveal a view, use a conservative angle that preserves known geometry.

九宫格类型：${subjectLabel}
统一视觉方向：${styleLabel}
${subjectFacts}

九个格子从左到右、从上到下严格安排：
${(shotPlans[effectiveSubjectMode] || shotPlans.auto).map((shot, index) => `${index + 1}. ${shot}`).join('\n')}

全局画面要求：九格采用同一套商业美术指导、色彩体系、曝光、肤色与商品色彩管理；每格构图独立清晰，主体不跨格，不重复肢体，不把多个视角融合在同一格；细节锐利，商业摄影质感，布局整齐，最终只输出一张完整3×3九宫格图片。
${extraPrompt ? `补充要求：${String(extraPrompt).trim()}\n` : ''}${negative ? `避免：${negative}，` : '避免：'}不同人物、不同商品、换脸、服装变色、商品变形、Logo变形、乱码、重复主体、额外肢体、跨格元素、格子数量错误、拼贴错位。`;
}

async function imageUrlToDataUrl(url, signal) {
  const response = await fetch(url, { signal: signal || AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`无法下载生成图片（${response.status}）。`);
  const mime = response.headers.get('content-type')?.split(';')[0] || 'image/png';
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function requestReferenceGeneration({ endpoint, apiKey, model, dataUrl, prompt, analysis, strategy = 'style', generationKind = 'reference', gridOptions = {}, size = '1024x1024', signal }) {
  const baseUrl = normalizeEndpoint(endpoint);
  const local = isLocalEndpoint(baseUrl);
  if (!model?.trim()) throw new Error('请先在设置中填写图像生成模型。');
  if (!apiKey && !local) throw new Error('请先在设置中保存图像生成 API Key。');
  const image = parseImageDataUrl(dataUrl);
  const isGrid = generationKind === 'ecommerce-grid';
  const finalPrompt = isGrid
    ? buildEcommerceGridPrompt({ analysis, ...gridOptions, extraPrompt: prompt })
    : buildReferencePrompt({ prompt, strategy, analysis });
  const form = new FormData();
  form.append('model', model.trim());
  form.append('prompt', finalPrompt);
  form.append('image', new Blob([image.buffer], { type: image.mime }), `luvoelle-reference.${image.mime.includes('jpeg') ? 'jpg' : 'png'}`);
  form.append('size', size);
  form.append('n', '1');
  form.append('response_format', 'b64_json');
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(`${baseUrl}/images/edits`, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal: signal || AbortSignal.timeout(240000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw error;
    throw new Error(`无法连接参考生成服务 ${baseUrl}。请先保存接口配置并确认服务正在运行。`);
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`参考生成请求失败（${response.status}）：${detail.slice(0, 240)}`);
  }
  const json = await response.json();
  const item = json.data?.[0] || json.output?.[0] || {};
  let resultDataUrl = item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.data_url || item.image || '';
  if (!resultDataUrl && item.url) resultDataUrl = await imageUrlToDataUrl(item.url, signal);
  if (!/^data:image\//.test(resultDataUrl)) throw new Error('图像生成接口没有返回可读取的图片。');
  return {
    dataUrl: resultDataUrl,
    provider: model.trim(),
    latency: Date.now() - startedAt,
    kind: isGrid ? 'ecommerce-grid' : 'reference',
    strategy,
    strategyLabel: isGrid ? '电商九宫格' : (STRATEGY_LABELS[strategy] || STRATEGY_LABELS.style),
    revisedPrompt: item.revised_prompt || finalPrompt,
  };
}

module.exports = {
  GRID_STYLE_LABELS,
  GRID_SUBJECT_LABELS,
  STRATEGY_LABELS,
  buildEcommerceGridPrompt,
  buildReferencePrompt,
  primaryPromptForMode,
  requestReferenceGeneration,
};
