const bridge = window.luvoelle;

const state = {
  job: null,
  analysis: null,
  analysisMode: 'daily',
  displayedMode: 'daily',
  modeSwitching: false,
  pendingMode: null,
  modeCache: {},
  pinned: false,
  selectedPrompt: 'universalZh',
  promptEdits: {},
  strategy: 'style',
  generated: null,
  gridGenerated: null,
  settings: {},
};

const ANALYSIS_MODE_META = Object.freeze({
  daily: {
    label: '日常模式',
    scene: '日常视觉',
    subjectTitle: '主体与场景',
    geometryLabel: '形态',
    detailsLabel: '观察',
    insightTitle: '日常观察',
    insightSubtitle: '活动、氛围与可复现特征',
    railNote: '镜头与参数来自视觉推测；画面文字、Logo 和水印会单独列出，不会被当作真实拍摄参数。',
  },
  ecommerce: {
    label: '电商拆图',
    scene: '电商视觉',
    subjectTitle: '人物、商品与主体',
    geometryLabel: '外观',
    detailsLabel: '商品细节',
    insightTitle: '电商主体锁定',
    insightSubtitle: '卖点、一致性与不可擅自修改信息',
    railNote: '九宫格会尽量锁定人物、服装与商品；单张截图看不到的侧面或背面结构仍属于推测。',
  },
  drama: {
    label: '短剧拆图',
    scene: '短剧镜头',
    subjectTitle: '人物、关系与场景',
    geometryLabel: '人物状态',
    detailsLabel: '动作细节',
    insightTitle: '短剧镜头信息',
    insightSubtitle: '剧情、动作、运镜与连续性',
    railNote: '短剧模式重点拆解剧情节点、人物关系和镜头连续性；无法从单帧确认的信息会作为推测呈现。',
  },
});

const MODE_PROMPT_TEMPLATES = Object.freeze({
  daily: [
    ['universalZh', '通用中文'],
    ['universalEn', 'Universal English'],
    ['qwenImage', 'Qwen-Image'],
    ['flux', 'FLUX'],
    ['midjourney', 'Midjourney'],
  ],
  ecommerce: [
    ['universalZh', '电商中文'],
    ['universalEn', 'E-commerce English'],
    ['qwenImage', 'Qwen-Image'],
    ['flux', 'FLUX'],
    ['midjourney', 'Midjourney'],
  ],
  drama: [
    ['firstFrameZh', '首帧画面 · 中文'],
    ['keyframeZh', '戏剧关键帧 · 中文'],
    ['storyboardZh', '分镜复现 · 中文'],
    ['firstFrameEn', 'Opening frame · English'],
    ['imageToVideo', '图生视频 · 运动提示'],
    ['characterContinuity', '角色连续性锚点'],
  ],
});

const MODE_STRATEGIES = Object.freeze({
  daily: [
    { value: 'style', title: '只取风格', description: '配色、质感与灯光' },
    { value: 'composition', title: '保持构图', description: '机位、留白与光影' },
    { value: 'subject', title: '保持主体', description: '保留人物或物体特征' },
  ],
  ecommerce: [
    { value: 'style', title: '只取风格', description: '配色、材质与灯光' },
    { value: 'composition', title: '保持构图', description: '机位、留白与光影' },
    { value: 'product', title: '保持商品', description: '保留自有商品外观' },
  ],
  drama: [
    { value: 'character', title: '保持角色', description: '锁定脸、发型与服装' },
    { value: 'shot', title: '保持镜头', description: '景别、站位与画面轴线' },
    { value: 'continuity', title: '延续剧情', description: '承接动作、情绪与空间' },
  ],
});

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function toast(message, kind = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${kind === 'error' ? 'error' : ''}`;
  element.textContent = message;
  $('#toast-stack').appendChild(element);
  setTimeout(() => {
    element.classList.add('is-leaving');
    setTimeout(() => element.remove(), 200);
  }, 2400);
}

function setWindowStatus(text, kind = '') {
  const status = $('#window-status');
  status.className = `status-pill ${kind ? `is-${kind}` : ''}`;
  status.innerHTML = `<i></i>${escapeHtml(text)}`;
}

function updateMaximizeButton(maximized) {
  const button = $('#maximize-window');
  if (!button) return;
  button.classList.toggle('is-maximized', Boolean(maximized));
  button.title = maximized ? '还原窗口' : '最大化';
  button.setAttribute('aria-label', maximized ? '还原窗口' : '最大化');
}

function updatePinButton(pinned) {
  state.pinned = Boolean(pinned);
  const button = $('#pin-window');
  if (!button) return;
  button.classList.toggle('is-active', state.pinned);
  button.setAttribute('aria-pressed', String(state.pinned));
  button.setAttribute('aria-label', state.pinned ? '取消固定窗口' : '固定在桌面上');
  button.title = state.pinned
    ? '已固定：窗口持续置顶，Esc 不会关闭'
    : '固定后窗口持续置顶，Esc 不会关闭';
  $('span', button).textContent = state.pinned ? '已固定' : '固定';
}

function updatePromptWindowState(windowState = {}) {
  updateMaximizeButton(Boolean(windowState.maximized));
  if (Object.prototype.hasOwnProperty.call(windowState, 'pinned')) updatePinButton(Boolean(windowState.pinned));
}

async function toggleMaximize() {
  const result = await bridge.windowControl('maximize');
  updateMaximizeButton(Boolean(result?.maximized));
}

function generationServiceLabel() {
  const model = String(state.settings.generationModel || '').trim();
  const endpoint = String(state.settings.generationEndpoint || '').trim();
  let host = '';
  try { host = endpoint ? new URL(endpoint).host : ''; } catch { /* keep endpoint label empty */ }
  return { model, endpoint, host, label: model ? `${model}${host ? ` · ${host}` : ''}` : '生成模型未配置' };
}

function renderGenerationService() {
  const service = generationServiceLabel();
  $('#generator-model-badge').textContent = service.label;
  $('#grid-generator-model-badge').textContent = service.label;
  $('#generator-model-badge').classList.toggle('is-missing', !service.model);
  $('#grid-generator-model-badge').classList.toggle('is-missing', !service.model);
  $('#generation-working-model').textContent = service.model
    ? `正在调用 ${service.model}，可能需要几分钟`
    : '请先在设置中配置参考生成模型';
  $('#grid-generation-working-model').textContent = service.model
    ? `正在调用 ${service.model} 生成一张完整3×3图片`
    : '请先在设置中配置图像生成模型';
  if (!state.job?.image) {
    $('#generation-hint').textContent = '历史记录出于隐私考虑不保存原图；重新截图或导入图片后才能参考生成。';
  } else if (service.model) {
    $('#generation-hint').textContent = state.displayedMode === 'drama'
      ? `实际生图模型：${service.model}。当前生成短剧关键帧参考图；图生视频运动提示词更适合复制到视频模型使用。`
      : `实际生图模型：${service.model}。提示词模板不会自动切换模型，源图不会写入历史记录。`;
  } else {
    $('#generation-hint').textContent = '尚未配置参考生成模型，请先前往工作台设置。';
  }
  if (!state.generated) $('#generate-image').disabled = state.modeSwitching || !state.job?.image || !service.model;
  if (!state.gridGenerated) $('#generate-grid').disabled = state.modeSwitching || state.analysisMode !== 'ecommerce' || !state.job?.image || !service.model;
  $('#grid-generation-hint').textContent = !state.job?.image
    ? '历史记录没有保存原图，重新截图或导入图片后才能生成九宫格。'
    : service.model
      ? `实际生图模型：${service.model}。最终输出为一张完整的正方形3×3图片。`
      : '尚未配置图像生成模型，请先前往工作台设置。';
}

function stageLabel(stage) {
  return ({
    'vision-analysis': '正在拆解视觉语言',
    'paddle-ocr': '正在提取画面文字',
    'paddle-refine': '正在增强较小和低置信文字',
    'tesseract-fallback': '正在切换兼容识别引擎',
    'loading tesseract core': '正在启动本地 OCR',
    'initializing tesseract': '正在初始化 OCR',
    'loading language traineddata': '正在载入中英文字库',
    'initializing api': '正在准备文字提取',
    'recognizing text': '正在提取画面文字',
    'waiting-vision': '文字已提取，正在等待视觉模型',
    generating: '正在生成参考视觉',
    'grid-generating': '正在生成电商九宫格',
  })[stage] || '正在理解画面';
}

function setPromptProcessingState(mode = 'waiting', message = '') {
  const tab = $('[data-tab="prompts"]');
  const panel = $('[data-tab-panel="prompts"]');
  const waiting = $('#prompt-waiting-state');
  const isWaiting = mode === 'waiting';
  const isFailed = mode === 'failed';

  tab.disabled = false;
  tab.classList.toggle('is-pending', isWaiting);
  tab.classList.toggle('is-error', isFailed);
  if (isWaiting) tab.setAttribute('aria-busy', 'true');
  else tab.removeAttribute('aria-busy');
  panel.classList.toggle('is-waiting', isWaiting);
  panel.classList.toggle('is-failed', isFailed);
  waiting.hidden = mode === 'ready';
  waiting.classList.toggle('is-error', isFailed);
  $('#prompt-waiting-back').hidden = !isFailed;

  if (isWaiting) {
    $('#prompt-waiting-title').textContent = '生图提示词正在生成';
    $('#prompt-waiting-message').textContent = '你可以停留在这里。模型完成主体、构图、镜头与灯光分析后，提示词会自动出现。';
    $('#prompt-vision-step').textContent = '视觉拆解中';
    $('#prompt-vision-step').className = 'is-active';
    $('#prompt-ready-step').textContent = '提示词待生成';
    $('#prompt-ready-step').className = '';
  } else if (isFailed) {
    $('#prompt-waiting-title').textContent = '暂时无法生成提示词';
    $('#prompt-waiting-message').textContent = message || '视觉模型没有返回有效结果，请检查服务配置后重新截图。';
    $('#prompt-vision-step').textContent = '视觉分析失败';
    $('#prompt-vision-step').className = '';
    $('#prompt-ready-step').textContent = '提示词未生成';
    $('#prompt-ready-step').className = '';
  }
}

function updatePromptWaitingStage(stage) {
  if (state.analysis || !$('[data-tab-panel="prompts"]').classList.contains('is-waiting')) return;
  if (stage === 'waiting-vision') {
    $('#prompt-waiting-title').textContent = '文字已提取，正在生成提示词';
    $('#prompt-waiting-message').textContent = 'OCR 已经完成。视觉模型正在理解主体、构图、镜头和灯光，完成后本页会自动显示可编辑提示词。';
    $('#prompt-vision-step').textContent = '视觉模型处理中';
    return;
  }
  if (stage === 'vision-analysis') {
    $('#prompt-waiting-title').textContent = '正在理解画面并生成提示词';
    $('#prompt-waiting-message').textContent = '视觉模型正在拆解画面结构，同时组织适合不同生图工具的提示词。';
    return;
  }
  $('#prompt-waiting-title').textContent = '正在准备生图提示词';
  $('#prompt-waiting-message').textContent = `${stageLabel(stage)}。文字提取与视觉分析会并行进行，请稍候。`;
}

function valueOrDash(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join('、') || '—';
  return String(value || '').trim() || '—';
}

function normalizeAnalysisMode(mode = '') {
  return Object.prototype.hasOwnProperty.call(ANALYSIS_MODE_META, mode) ? mode : 'daily';
}

function modeValue(modeData, ...keys) {
  for (const key of keys) {
    const value = modeData?.[key];
    if (Array.isArray(value) ? value.length : String(value || '').trim()) return value;
  }
  return '';
}

function promptTemplatesForMode(mode) {
  return MODE_PROMPT_TEMPLATES[normalizeAnalysisMode(mode)] || MODE_PROMPT_TEMPLATES.daily;
}

function defaultPromptForMode(mode) {
  return promptTemplatesForMode(mode)[0][0];
}

function strategiesForMode(mode) {
  return MODE_STRATEGIES[normalizeAnalysisMode(mode)] || MODE_STRATEGIES.daily;
}

function strategyNeedsRights(mode, strategy) {
  return (normalizeAnalysisMode(mode) === 'ecommerce' && strategy === 'product')
    || (normalizeAnalysisMode(mode) === 'drama' && strategy === 'character');
}

function configurePromptTemplates(mode, preferred = state.selectedPrompt) {
  const normalizedMode = normalizeAnalysisMode(mode);
  const templates = promptTemplatesForMode(normalizedMode);
  const allowed = new Set(templates.map(([value]) => value));
  const next = allowed.has(preferred) ? preferred : defaultPromptForMode(normalizedMode);
  const select = $('#prompt-model');
  select.replaceChildren(...templates.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
  state.selectedPrompt = next;
  select.value = next;
  $('#negative-description').textContent = normalizedMode === 'drama'
    ? '避免身份漂移、动作跳变、闪烁与翻轴'
    : normalizedMode === 'ecommerce'
      ? '避免包装变形、错误文字与主体漂移'
      : '避免常见画面瑕疵';
  $('#prompt-template-note').textContent = normalizedMode === 'drama'
    ? '首帧、关键帧与图生视频运动提示词彼此独立；切换模板不会切换实际生成模型。'
    : '上方只切换提示词模板，不会切换实际生图模型；复制时使用当前编辑版本。';
}

function configureStrategies(mode, preferred = state.strategy) {
  const normalizedMode = normalizeAnalysisMode(mode);
  const strategies = strategiesForMode(normalizedMode);
  const buttons = $$('#strategy-control button');
  buttons.forEach((button, index) => {
    const item = strategies[index];
    button.dataset.strategy = item.value;
    $('strong', button).textContent = item.title;
    $('small', button).textContent = item.description;
  });
  const next = strategies.some((item) => item.value === preferred) ? preferred : strategies[0].value;
  state.strategy = next;
  buttons.forEach((button) => button.classList.toggle('is-active', button.dataset.strategy === next));
  $('#rights-confirm').hidden = !strategyNeedsRights(normalizedMode, next);
  if (normalizedMode === 'drama') {
    $('#rights-title').textContent = '我拥有这张图片和人物肖像素材的使用权';
    $('#rights-description').textContent = '“保持角色”会锁定人物身份、发型、体型与服装。';
  } else {
    $('#rights-title').textContent = '我拥有这张图片和商品素材的使用权';
    $('#rights-description').textContent = '该模式会尝试保留商品外观、标识和可见文字。';
  }
}

function configureModeSpecificControls(mode) {
  configurePromptTemplates(mode);
  configureStrategies(mode);
}

function formatDramaCharacters(characters = []) {
  return characters.map((character) => {
    if (!character || typeof character !== 'object') return String(character || '').trim();
    return [character.name, character.appearance, character.wardrobe, character.expression].filter(Boolean).join('：');
  }).filter(Boolean);
}

function dramaLocationLabel(location = {}) {
  return [location.setting, location.time, location.weather].filter(Boolean).join('，');
}

function subjectViewForMode(analysis, mode) {
  const normalizedMode = normalizeAnalysisMode(mode);
  if (normalizedMode === 'drama') {
    const drama = analysis.drama || analysis.modeData || {};
    const characters = formatDramaCharacters(drama.characters || []);
    return {
      category: drama.dramaticPurpose || drama.narrativeBeat || '剧情镜头',
      description: [characters.join('；'), drama.visibleAction || drama.visible_action, dramaLocationLabel(drama.location || {})].filter(Boolean).join('；'),
      chips: [
        ...(drama.relationships || []),
        ...(drama.continuity?.wardrobeLocks || drama.continuity?.wardrobe_locks || []),
      ],
      form: drama.blocking || drama.continuity?.screenDirection || drama.continuity?.screen_direction,
      details: [drama.performance, drama.conflictTension || drama.conflict_tension].filter(Boolean),
    };
  }
  if (normalizedMode === 'ecommerce') {
    return {
      category: analysis.product?.category,
      description: analysis.product?.subject,
      chips: [...(analysis.product?.materials || []), ...(analysis.product?.colors || [])],
      form: analysis.product?.geometry,
      details: analysis.product?.details || [],
    };
  }
  const subject = analysis.subject || {};
  return {
    category: subject.type || analysis.product?.category,
    description: subject.description || analysis.product?.subject,
    chips: [...(subject.attributes || analysis.product?.materials || []), ...(subject.colors || analysis.product?.colors || [])],
    form: subject.form || analysis.product?.geometry,
    details: subject.details || analysis.product?.details || [],
  };
}

function setAnalysisModeUI(mode, processing = false) {
  const normalizedMode = normalizeAnalysisMode(mode);
  const contentMode = processing && state.analysis ? normalizeAnalysisMode(state.displayedMode) : normalizedMode;
  const meta = ANALYSIS_MODE_META[contentMode];
  state.analysisMode = normalizedMode;
  state.modeSwitching = processing;
  $$('#analysis-mode-switch button').forEach((button) => {
    const buttonMode = button.dataset.analysisMode;
    button.classList.toggle('is-active', buttonMode === normalizedMode);
    button.classList.toggle('has-result', Boolean(state.modeCache[buttonMode]));
    button.classList.toggle('is-generating', processing && buttonMode === normalizedMode);
    button.disabled = processing && buttonMode === normalizedMode;
  });
  $('#regenerate-mode').disabled = processing || !state.job?.image || !state.modeCache[normalizedMode];
  $('#grid-tab').hidden = contentMode !== 'ecommerce';
  if (contentMode !== 'ecommerce' && $('[data-tab="grid"]')?.classList.contains('is-active')) switchTab('analysis');
  $('#subject-card-title').textContent = meta.subjectTitle;
  $('#geometry-label').textContent = meta.geometryLabel;
  $('#details-label').textContent = meta.detailsLabel;
  $('.rail-note p').textContent = meta.railNote;
  $('#mode-insight-title').textContent = meta.insightTitle;
  $('#mode-insight-subtitle').textContent = meta.insightSubtitle;
  configureModeSpecificControls(contentMode);
}

function hideModeTransition() {
  $('#mode-transition-banner').hidden = true;
}

function showModeTransition(targetMode, fromMode) {
  const target = ANALYSIS_MODE_META[normalizeAnalysisMode(targetMode)];
  const from = ANALYSIS_MODE_META[normalizeAnalysisMode(fromMode)];
  $('#mode-transition-title').textContent = `正在后台生成${target.label}`;
  $('#mode-transition-message').textContent = `当前继续保留${from.label}结果；生成完成后自动切换，返回日常/电商/短剧时会直接恢复缓存。`;
  $('#mode-transition-banner').hidden = false;
}

function snapshotDisplayedMode() {
  if (!state.analysis || !state.displayedMode) return;
  state.promptEdits[state.selectedPrompt] = $('#prompt-text').value;
  state.promptEdits.negative = $('#negative-prompt').value;
  const mode = normalizeAnalysisMode(state.displayedMode);
  state.modeCache[mode] = {
    job: { ...state.job, analysisMode: mode, analysis: state.analysis },
    analysis: state.analysis,
    selectedPrompt: state.selectedPrompt,
    promptEdits: { ...state.promptEdits },
    strategy: state.strategy,
    generated: state.generated,
    gridGenerated: state.gridGenerated,
    gridSubjectMode: $('#grid-subject-mode').value,
    gridVisualStyle: $('#grid-visual-style').value,
    gridExtraPrompt: $('#grid-extra-prompt').value,
  };
}

function clearRenderedGenerationResults() {
  state.generated = null;
  state.gridGenerated = null;
  $('#generation-result').hidden = true;
  $('#generation-error').hidden = true;
  $('#generated-actions').hidden = true;
  $('#grid-generation-result').hidden = true;
  $('#grid-generation-error').hidden = true;
  $('#grid-generated-actions').hidden = true;
}

function renderCachedMode(mode) {
  const normalizedMode = normalizeAnalysisMode(mode);
  const cached = state.modeCache[normalizedMode];
  if (!cached) return false;
  state.pendingMode = null;
  state.modeSwitching = false;
  hideModeTransition();
  renderAnalysis({ ...cached.job, analysisMode: normalizedMode, analysis: cached.analysis }, { cacheResult: false });
  state.selectedPrompt = cached.selectedPrompt || defaultPromptForMode(normalizedMode);
  state.promptEdits = { ...(cached.promptEdits || cached.analysis.prompts || {}) };
  $('#prompt-model').value = state.selectedPrompt;
  $('#prompt-text').value = state.promptEdits[state.selectedPrompt] || '';
  $('#negative-prompt').value = state.promptEdits.negative || '';
  selectStrategy(cached.strategy || 'style');
  clearRenderedGenerationResults();
  if (cached.generated) finishGeneration(cached.generated, { silent: true });
  if (cached.gridGenerated) finishGridGeneration(cached.gridGenerated, { silent: true });
  $('#grid-subject-mode').value = cached.gridSubjectMode || 'auto';
  $('#grid-visual-style').value = cached.gridVisualStyle || 'source';
  $('#grid-extra-prompt').value = cached.gridExtraPrompt || '';
  state.modeCache[normalizedMode] = { ...cached, generated: state.generated, gridGenerated: state.gridGenerated };
  setAnalysisModeUI(normalizedMode, false);
  renderGenerationService();
  return true;
}

function renderModeInsights(analysis) {
  const mode = normalizeAnalysisMode(analysis.analysisMode || state.analysisMode);
  const data = mode === 'drama' ? (analysis.drama || analysis.modeData || {}) : (analysis.modeData || {});
  const definitions = {
    daily: [
      ['主体类型', modeValue(data, 'subject_type', 'subjectType')],
      ['正在发生', modeValue(data, 'activity')],
      ['情绪氛围', modeValue(data, 'mood')],
      ['风格关键词', modeValue(data, 'style_keywords', 'styleKeywords')],
      ['复现要点', modeValue(data, 'recreation_notes', 'recreationNotes')],
    ],
    ecommerce: [
      ['主体类型', modeValue(data, 'subject_type', 'subjectType')],
      ['身份锁定', modeValue(data, 'identity_locks', 'identityLocks')],
      ['核心卖点', modeValue(data, 'selling_points', 'sellingPoints')],
      ['使用场景', modeValue(data, 'usage_context', 'usageContext')],
      ['目标人群', modeValue(data, 'target_audience', 'targetAudience')],
      ['平台比例', modeValue(data, 'platform_ratio', 'platformRatio')],
      ['九格建议', modeValue(data, 'grid_subject_notes', 'gridSubjectNotes')],
      ['推测视角', modeValue(data, 'uncertain_views', 'uncertainViews')],
    ],
    drama: [
      ['剧情节拍', modeValue(data, 'narrativeBeat', 'narrative_beat')],
      ['戏剧目的', modeValue(data, 'dramaticPurpose', 'dramatic_purpose')],
      ['角色定妆', formatDramaCharacters(data.characters || [])],
      ['人物关系', modeValue(data, 'relationships')],
      ['场景时空', dramaLocationLabel(data.location || {})],
      ['可见动作', modeValue(data, 'visibleAction', 'visible_action', 'action')],
      ['表演情绪', modeValue(data, 'performance', 'expression')],
      ['冲突张力', modeValue(data, 'conflictTension', 'conflict_tension')],
      ['空间走位', modeValue(data, 'blocking')],
      ['镜头语言', [analysis.camera?.shotType, analysis.camera?.cameraAngle, analysis.camera?.cameraMovement].filter(Boolean).join('；')],
      ['身份锁定', modeValue(data.continuity, 'identityLocks', 'identity_locks')],
      ['服装锁定', modeValue(data.continuity, 'wardrobeLocks', 'wardrobe_locks')],
      ['轴线与朝向', modeValue(data.continuity, 'screenDirection', 'screen_direction')],
      ['前镜承接', modeValue(data.continuity, 'before')],
      ['后镜建议', modeValue(data.continuity, 'after')],
      ['镜头时长', modeValue(data, 'suggestedDuration', 'suggested_duration')],
      ['推测边界', modeValue(data, 'uncertainties')],
    ],
  };
  const rows = definitions[mode].filter(([, value]) => Array.isArray(value) ? value.length : String(value || '').trim());
  $('#mode-insight-card').hidden = !rows.length;
  $('#mode-insight-list').innerHTML = rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(valueOrDash(value))}</dd></div>`).join('');
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = valueOrDash(value);
}

function renderChips(selector, values = []) {
  $(selector).innerHTML = values.filter(Boolean).map((value) => `<span>${escapeHtml(value)}</span>`).join('');
}

function colorFromLabel(label) {
  const match = String(label).match(/#[0-9a-f]{3,8}/i);
  if (match) return match[0];
  const known = { 白: '#f5f5f3', 黑: '#252528', 红: '#e65750', 蓝: '#4b75d1', 绿: '#62a66f', 黄: '#eac956', 紫: '#9670ba', 橙: '#e58a48', 灰: '#a8a8aa', 金: '#bf9654', 银: '#b9bec5', 粉: '#e7a7b8', 棕: '#8b6550' };
  return Object.entries(known).find(([name]) => String(label).includes(name))?.[1] || '#d8d8dc';
}

function renderSourceImage(job) {
  if (job?.image) {
    $('#source-image').src = job.image;
    $('#preview-frame').classList.add('has-image');
    $('#preview-frame').classList.remove('is-empty');
  } else {
    $('#source-image').removeAttribute('src');
    $('#preview-frame').classList.remove('has-image');
    $('#preview-frame').classList.add('is-empty');
  }
}

function clearAnalysisView() {
  const waitingFields = [
    '#product-geometry', '#product-details', '#aspect-ratio', '#composition-framing',
    '#composition-viewpoint', '#composition-position', '#composition-space', '#camera-shot',
    '#camera-lens', '#camera-depth', '#light-source', '#light-direction', '#light-quality',
    '#light-temperature', '#background-setting', '#background-texture', '#typography',
  ];
  waitingFields.forEach((selector) => setText(selector, '—'));
  $('#product-category').textContent = '等待分析';
  $('#product-subject').textContent = '正在分析新图片…';
  $('#scene-type').textContent = '新视觉任务';
  $('#provider-meta').textContent = '等待视觉模型';
  $('#summary-text').textContent = 'Luvoelle 正在识别新图片的主体、构图、镜头和灯光关系。';
  $('#visible-text').textContent = '等待分析';
  $('#product-chips').replaceChildren();
  $('#background-props').replaceChildren();
  $('#palette').innerHTML = '<span><i></i>等待分析</span>';
  $('#warning-card').hidden = true;
  $('#warning-list').replaceChildren();
  $('#mode-insight-card').hidden = true;
  $('#mode-insight-list').replaceChildren();
  state.selectedPrompt = defaultPromptForMode(state.displayedMode);
  configureModeSpecificControls(state.displayedMode);
  $('#prompt-model').value = state.selectedPrompt;
  $('#prompt-text').value = '';
  $('#negative-prompt').value = '';
  $('#prompt-text').placeholder = '新图片分析完成后会生成可编辑提示词';
  $('#copy-prompt').disabled = true;
  $('#copy-negative').disabled = true;
  $('#generate-image').disabled = true;
  $('#rights-checkbox').checked = false;
  selectStrategy(strategiesForMode(state.displayedMode)[0].value);
  $('#generation-result').hidden = true;
  $('#generation-error').hidden = true;
  $('#generated-actions').hidden = true;
  $('#grid-generation-result').hidden = true;
  $('#grid-generation-error').hidden = true;
  $('#grid-generated-actions').hidden = true;
  $('#grid-rights-checkbox').checked = false;
  $('#grid-extra-prompt').value = '';
  setPromptProcessingState('waiting');
  switchTab('analysis');
  $$('[data-tab-panel]').forEach((panel) => { panel.scrollTop = 0; });
}

function reset(job) {
  state.job = job;
  state.analysis = null;
  state.modeCache = {};
  state.pendingMode = null;
  state.promptEdits = {};
  state.generated = null;
  state.gridGenerated = null;
  state.displayedMode = normalizeAnalysisMode(job?.analysisMode || state.settings.promptAnalysisMode || 'daily');
  state.selectedPrompt = defaultPromptForMode(state.displayedMode);
  hideModeTransition();
  setAnalysisModeUI(state.displayedMode, true);
  clearAnalysisView();
  $('#preview-loading').hidden = false;
  setWindowStatus('正在分析');
  renderSourceImage(job);
}

function renderAnalysis(job, { cacheResult = true } = {}) {
  const analysis = job.analysis || {};
  const resultMode = normalizeAnalysisMode(analysis.analysisMode || job.analysisMode || 'daily');
  if (state.analysis && state.displayedMode !== resultMode) clearRenderedGenerationResults();
  state.job = job;
  state.analysis = analysis;
  state.displayedMode = resultMode;
  state.pendingMode = null;
  hideModeTransition();
  setAnalysisModeUI(resultMode, false);
  renderSourceImage(job);
  setPromptProcessingState('ready');
  $('#copy-prompt').disabled = false;
  $('#copy-negative').disabled = false;
  state.promptEdits = { ...(analysis.prompts || {}) };
  $('#preview-loading').hidden = true;
  setWindowStatus('分析完成', 'ready');
  setText('#scene-type', analysis.sceneType || '视觉拆解');
  $('#provider-meta').textContent = [analysis.provider, analysis.latency ? `${analysis.latency} ms` : ''].filter(Boolean).join(' · ') || '视觉模型';
  setText('#summary-text', analysis.summary);
  const subjectView = subjectViewForMode(analysis, resultMode);
  setText('#product-category', subjectView.category);
  setText('#product-subject', subjectView.description);
  renderChips('#product-chips', subjectView.chips);
  setText('#product-geometry', subjectView.form);
  setText('#product-details', subjectView.details);
  setText('#aspect-ratio', analysis.composition?.aspectRatio);
  setText('#composition-framing', analysis.composition?.framing);
  setText('#composition-viewpoint', analysis.composition?.viewpoint);
  setText('#composition-position', analysis.composition?.subjectPosition);
  setText('#composition-space', analysis.composition?.negativeSpace);
  setText('#camera-shot', analysis.camera?.shotType);
  setText('#camera-lens', analysis.camera?.lensGuess);
  setText('#camera-depth', analysis.camera?.depthOfField);
  setText('#light-source', analysis.lighting?.source);
  setText('#light-direction', analysis.lighting?.direction);
  setText('#light-quality', analysis.lighting?.quality);
  setText('#light-temperature', analysis.lighting?.colorTemperature);
  setText('#background-setting', analysis.background?.setting);
  setText('#background-texture', analysis.background?.texture);
  renderChips('#background-props', analysis.background?.props || []);
  $('#palette').innerHTML = (analysis.palette || []).map((color) => `<span><i style="--swatch:${colorFromLabel(color)}"></i>${escapeHtml(color)}</span>`).join('') || '<span><i></i>未提取</span>';
  setText('#visible-text', (analysis.visibleText || []).join(' · ') || '未识别到文字');
  setText('#typography', analysis.typography);
  renderModeInsights(analysis);
  const warnings = analysis.warnings || [];
  $('#warning-card').hidden = !warnings.length;
  $('#warning-list').innerHTML = warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
  $('#prompt-model').value = state.selectedPrompt;
  $('#prompt-text').value = state.promptEdits[state.selectedPrompt] || '';
  $('#negative-prompt').value = state.promptEdits.negative || '';
  $('#prompt-text').placeholder = '视觉分析完成后会生成可编辑提示词';
  const historyOnly = !job.image;
  $('#generate-image').disabled = historyOnly;
  renderGenerationService();
  if (historyOnly) renderSourceImage(null);
  if (cacheResult) snapshotDisplayedMode();
  setAnalysisModeUI(resultMode, false);
}

function renderFailure(message) {
  $('#preview-loading').hidden = true;
  setWindowStatus('分析失败', 'error');
  $('#summary-text').textContent = message || '视觉服务未返回结果。';
  setPromptProcessingState('failed', message);
  setAnalysisModeUI(state.analysisMode, false);
  toast(message || '视觉分析失败', 'error');
}

function switchTab(name) {
  if (name === 'grid' && state.analysisMode !== 'ecommerce') return;
  $$('.tabs [data-tab]').forEach((button) => button.classList.toggle('is-active', button.dataset.tab === name));
  $$('[data-tab-panel]').forEach((panel) => panel.classList.toggle('is-active', panel.dataset.tabPanel === name));
}

function markModeRequestPending() {
  const promptTab = $('[data-tab="prompts"]');
  promptTab.classList.add('is-pending');
  promptTab.classList.remove('is-error');
  promptTab.setAttribute('aria-busy', 'true');
}

function restoreAfterModeFailure(message) {
  const pending = state.pendingMode;
  const fallbackMode = pending?.fromMode;
  state.pendingMode = null;
  state.modeSwitching = false;
  hideModeTransition();
  $('#preview-loading').hidden = true;
  if (fallbackMode && state.modeCache[fallbackMode]) {
    renderCachedMode(fallbackMode);
    toast(`${ANALYSIS_MODE_META[pending.targetMode].label}生成失败：${message}`, 'error');
    return;
  }
  renderFailure(message);
}

async function beginModeAnalysis(mode, { clear = false } = {}) {
  const normalizedMode = normalizeAnalysisMode(mode);
  const sourceJob = state.job;
  const fromMode = clear ? null : state.displayedMode;
  state.pendingMode = { targetMode: normalizedMode, fromMode, clear };
  state.job = { ...sourceJob, analysisMode: normalizedMode };

  if (clear) {
    state.analysis = null;
    state.displayedMode = normalizedMode;
    state.promptEdits = {};
    state.generated = null;
    state.gridGenerated = null;
    clearAnalysisView();
  } else {
    showModeTransition(normalizedMode, fromMode);
    markModeRequestPending();
  }

  setAnalysisModeUI(normalizedMode, true);
  $('#preview-loading').hidden = false;
  $('#progress-label').textContent = `正在生成${ANALYSIS_MODE_META[normalizedMode].label}`;
  setWindowStatus(`正在生成${ANALYSIS_MODE_META[normalizedMode].label}`);
  renderSourceImage(sourceJob);
  renderGenerationService();

  try {
    const result = await bridge.reanalyzePrompt({
      jobId: sourceJob.id,
      dataUrl: sourceJob.image,
      origin: 'mode-switch',
      imageCopied: sourceJob.imageCopied,
      analysisMode: normalizedMode,
    });
    if (result && state.job?.id === result.id && state.analysisMode === normalizedMode && state.pendingMode) renderAnalysis(result);
  } catch (error) {
    if (state.pendingMode?.targetMode === normalizedMode) restoreAfterModeFailure(error.message);
  }
}

async function switchAnalysisMode(nextMode) {
  const mode = normalizeAnalysisMode(nextMode);
  if (mode === state.analysisMode && !state.modeSwitching) return;
  if (!state.job?.image) return toast('这条历史记录没有保存原图，请重新截图后切换模式', 'error');
  snapshotDisplayedMode();

  if (state.modeCache[mode]) {
    if (state.modeSwitching) await bridge.cancelPromptAnalysis(state.job.id).catch(() => {});
    renderCachedMode(mode);
    bridge.saveSettings({ promptAnalysisMode: mode }).then((settings) => { state.settings = settings || state.settings; }).catch(() => {});
    return;
  }

  await beginModeAnalysis(mode);
}

async function regenerateCurrentMode() {
  if (!state.job?.image) return toast('当前记录没有原图，无法重新生成', 'error');
  const mode = normalizeAnalysisMode(state.analysisMode);
  if (state.modeSwitching) await bridge.cancelPromptAnalysis(state.job.id).catch(() => {});
  delete state.modeCache[mode];
  await beginModeAnalysis(mode, { clear: true });
}

function selectPromptModel(next) {
  if (state.selectedPrompt) state.promptEdits[state.selectedPrompt] = $('#prompt-text').value;
  state.selectedPrompt = next;
  $('#prompt-text').value = state.promptEdits[next] || '';
}

async function copyText(text, message) {
  if (!String(text || '').trim()) return toast('当前没有可复制的内容', 'error');
  await bridge.copyText(text);
  toast(message);
}

function selectStrategy(strategy) {
  const strategies = strategiesForMode(state.displayedMode);
  const next = strategies.some((item) => item.value === strategy) ? strategy : strategies[0].value;
  state.strategy = next;
  $$('#strategy-control button').forEach((button) => button.classList.toggle('is-active', button.dataset.strategy === next));
  $('#rights-confirm').hidden = !strategyNeedsRights(state.displayedMode, next);
}

function showGenerationWorking() {
  state.generated = null;
  $('#generation-error').hidden = true;
  $('#generation-result').hidden = false;
  $('#generation-working').hidden = false;
  $('#generated-image').removeAttribute('src');
  $('#generated-strategy').textContent = '正在生成参考图';
  $('#generated-provider').textContent = generationServiceLabel().label;
  $('#generated-actions').hidden = true;
  $('#generate-image').disabled = true;
  $('#generate-image').innerHTML = '生成中…';
}

function finishGeneration(result, { silent = false } = {}) {
  state.generated = result;
  $('#generation-result').hidden = false;
  $('#generation-working').hidden = true;
  $('#generated-image').src = result.dataUrl;
  $('#generated-strategy').textContent = `${result.strategyLabel || '参考生成'}完成`;
  $('#generated-provider').textContent = [result.provider, result.latency ? `${result.latency} ms` : ''].filter(Boolean).join(' · ');
  $('#generated-actions').hidden = false;
  $('#generate-image').disabled = !state.job?.image;
  $('#generate-image').innerHTML = '再次生成 <span>→</span>';
  if (state.modeCache[state.displayedMode]) state.modeCache[state.displayedMode].generated = result;
  if (!silent) toast('参考图已生成');
}

function failGeneration(message) {
  $('#generation-working').hidden = true;
  $('#generation-result').hidden = true;
  $('#generated-actions').hidden = true;
  $('#generation-error').hidden = false;
  $('#generation-error').textContent = message;
  $('#generate-image').disabled = !state.job?.image;
  $('#generate-image').innerHTML = '重新生成 <span>→</span>';
}

function showGridGenerationWorking() {
  state.gridGenerated = null;
  $('#grid-generation-error').hidden = true;
  $('#grid-generation-result').hidden = false;
  $('#grid-generation-working').hidden = false;
  $('#grid-generated-image').removeAttribute('src');
  $('#zoom-grid-image').hidden = true;
  $('#grid-generated-title').textContent = '正在锁定主体并安排九个镜头';
  $('#grid-generated-provider').textContent = generationServiceLabel().label;
  $('#grid-generated-actions').hidden = true;
  $('#generate-grid').disabled = true;
  $('#generate-grid span').textContent = '九宫格生成中…';
}

function finishGridGeneration(result, { silent = false } = {}) {
  state.gridGenerated = result;
  $('#grid-generation-result').hidden = false;
  $('#grid-generation-working').hidden = true;
  $('#grid-generated-image').src = result.dataUrl;
  $('#zoom-grid-image').hidden = false;
  $('#grid-generated-title').textContent = '一张完整电商九宫格已生成';
  $('#grid-generated-provider').textContent = [result.provider, result.latency ? `${result.latency} ms` : ''].filter(Boolean).join(' · ');
  $('#grid-generated-actions').hidden = false;
  $('#generate-grid').disabled = !state.job?.image;
  $('#generate-grid span').textContent = '再次生成九宫格';
  if (state.modeCache[state.displayedMode]) state.modeCache[state.displayedMode].gridGenerated = result;
  if (!silent) toast('电商九宫格已生成');
}

function failGridGeneration(message) {
  $('#grid-generation-working').hidden = true;
  $('#grid-generation-result').hidden = true;
  $('#grid-generated-actions').hidden = true;
  $('#grid-generation-error').hidden = false;
  $('#grid-generation-error').textContent = message;
  $('#generate-grid').disabled = !state.job?.image;
  $('#generate-grid span').textContent = '重新生成九宫格';
}

async function generateEcommerceGrid() {
  if (state.analysisMode !== 'ecommerce') return toast('请先切换到电商拆图模式', 'error');
  if (!state.job?.image) return toast('这条历史记录没有保存原图，请重新截图或导入图片', 'error');
  if (!state.analysis) return toast('请等待电商视觉拆解完成', 'error');
  if (!$('#grid-rights-checkbox').checked) return toast('请先确认图片、人物肖像和商品素材的使用权', 'error');
  const generationJobId = state.job.id;
  try {
    const bootstrap = await bridge.bootstrap();
    state.settings = bootstrap.settings || {};
    renderGenerationService();
  } catch { /* generation IPC will return the actionable configuration error */ }
  showGridGenerationWorking();
  try {
    const result = await bridge.generateReferenceImage({
      jobId: generationJobId,
      dataUrl: state.job.image,
      prompt: $('#grid-extra-prompt').value,
      analysis: state.analysis,
      strategy: 'product',
      generationKind: 'ecommerce-grid',
      gridOptions: {
        subjectMode: $('#grid-subject-mode').value,
        visualStyle: $('#grid-visual-style').value,
      },
      rightsConfirmed: true,
    });
    if (state.job?.id !== generationJobId || state.analysisMode !== 'ecommerce') return;
    if (state.gridGenerated?.dataUrl !== result.dataUrl) finishGridGeneration(result);
  } catch (error) {
    if (state.job?.id !== generationJobId) return;
    if ($('#grid-generation-error').hidden) failGridGeneration(error.message);
  }
}

function openImageLightbox(dataUrl) {
  if (!dataUrl) return;
  $('#lightbox-image').src = dataUrl;
  $('#image-lightbox').hidden = false;
}

function closeImageLightbox() {
  $('#image-lightbox').hidden = true;
  $('#lightbox-image').removeAttribute('src');
}

function handleEscape() {
  if (!$('#image-lightbox').hidden) {
    closeImageLightbox();
    return;
  }
  if (state.pinned) {
    toast('窗口已固定，请点击右上角 × 关闭');
    return;
  }
  bridge.promptAction('close');
}

async function generate() {
  if (!state.job?.image) return toast('这条历史记录没有保存原图，请重新截图或导入图片', 'error');
  state.promptEdits[state.selectedPrompt] = $('#prompt-text').value;
  state.promptEdits.negative = $('#negative-prompt').value;
  if (!state.promptEdits[state.selectedPrompt].trim()) return toast('请先填写生图提示词', 'error');
  if (strategyNeedsRights(state.displayedMode, state.strategy) && !$('#rights-checkbox').checked) {
    return toast(state.displayedMode === 'drama' ? '请先确认图片与人物肖像素材使用权' : '请先确认图片与商品素材使用权', 'error');
  }
  const generationJobId = state.job.id;
  try {
    const bootstrap = await bridge.bootstrap();
    state.settings = bootstrap.settings || {};
    renderGenerationService();
  } catch { /* generation IPC will provide the actionable configuration error */ }
  showGenerationWorking();
  try {
    const result = await bridge.generateReferenceImage({
      jobId: generationJobId,
      dataUrl: state.job.image,
      prompt: `${state.promptEdits[state.selectedPrompt]}\n\n负面提示：${state.promptEdits.negative || '无'}`,
      analysis: state.analysis,
      strategy: state.strategy,
      rightsConfirmed: $('#rights-checkbox').checked,
    });
    if (state.job?.id !== generationJobId) return;
    if (state.generated?.dataUrl !== result.dataUrl) finishGeneration(result);
  } catch (error) {
    if (state.job?.id !== generationJobId) return;
    if ($('#generation-error').hidden) failGeneration(error.message);
  }
}

function handlePromptEvent(event) {
  if (!event) return;
  if (event.type === 'escape') {
    handleEscape();
    return;
  }
  if (event.type === 'started') {
    if (state.job?.id === event.job?.id && event.job?.origin === 'mode-switch') {
      state.job = { ...state.job, ...event.job };
    } else {
      reset(event.job);
    }
  }
  if (event.type === 'progress') {
    if (!state.job && event.job) reset(event.job);
    if (event.job?.id && state.job?.id && event.job.id !== state.job.id) return;
    $('#progress-label').textContent = stageLabel(event.stage);
    setWindowStatus(stageLabel(event.stage));
    updatePromptWaitingStage(event.stage);
  }
  if (event.type === 'completed' && (!state.job || event.job?.id === state.job.id)) {
    const resultMode = normalizeAnalysisMode(event.job?.analysis?.analysisMode || event.job?.analysisMode);
    if (!state.modeSwitching || resultMode === state.analysisMode) renderAnalysis(event.job);
  }
  if (event.type === 'failed' && (!state.job || event.job?.id === state.job.id)) {
    if (state.pendingMode) restoreAfterModeFailure(event.message);
    else renderFailure(event.message);
  }
  if (event.type === 'generation-progress' && event.jobId === state.job?.id) showGenerationWorking();
  if (event.type === 'generation-completed' && event.jobId === state.job?.id) finishGeneration(event.result);
  if (event.type === 'generation-failed' && event.jobId === state.job?.id) failGeneration(event.message);
  if (event.type === 'grid-generation-progress' && event.jobId === state.job?.id) showGridGenerationWorking();
  if (event.type === 'grid-generation-completed' && event.jobId === state.job?.id) finishGridGeneration(event.result);
  if (event.type === 'grid-generation-failed' && event.jobId === state.job?.id) failGridGeneration(event.message);
}

function bindEvents() {
  $$('.tabs [data-tab]').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  $$('#analysis-mode-switch button').forEach((button) => button.addEventListener('click', () => switchAnalysisMode(button.dataset.analysisMode)));
  $('#regenerate-mode').addEventListener('click', regenerateCurrentMode);
  $('#prompt-waiting-back').addEventListener('click', () => switchTab('analysis'));
  $('#prompt-model').addEventListener('change', (event) => selectPromptModel(event.target.value));
  $('#prompt-text').addEventListener('input', (event) => { state.promptEdits[state.selectedPrompt] = event.target.value; });
  $('#negative-prompt').addEventListener('input', (event) => { state.promptEdits.negative = event.target.value; });
  $('#copy-prompt').addEventListener('click', () => copyText($('#prompt-text').value, '提示词已复制'));
  $('#copy-negative').addEventListener('click', () => copyText($('#negative-prompt').value, '负面提示词已复制'));
  $$('#strategy-control button').forEach((button) => button.addEventListener('click', () => selectStrategy(button.dataset.strategy)));
  $('#generate-image').addEventListener('click', generate);
  $('#generate-grid').addEventListener('click', generateEcommerceGrid);
  $('#copy-generated').addEventListener('click', async () => {
    if (!state.generated?.dataUrl) return;
    await bridge.copyImage(state.generated.dataUrl);
    toast('生成图片已复制');
  });
  $('#save-generated').addEventListener('click', async () => {
    if (!state.generated?.dataUrl) return;
    const result = await bridge.saveGeneratedImage(state.generated.dataUrl);
    if (result.saved) toast('生成图片已保存');
  });
  $('#copy-grid-generated').addEventListener('click', async () => {
    if (!state.gridGenerated?.dataUrl) return;
    await bridge.copyImage(state.gridGenerated.dataUrl);
    toast('九宫格图片已复制');
  });
  $('#save-grid-generated').addEventListener('click', async () => {
    if (!state.gridGenerated?.dataUrl) return;
    const result = await bridge.saveGeneratedImage({ dataUrl: state.gridGenerated.dataUrl, kind: 'ecommerce-grid' });
    if (result.saved) toast('九宫格图片已保存');
  });
  $('#zoom-grid-image').addEventListener('click', () => openImageLightbox(state.gridGenerated?.dataUrl));
  $('#grid-generated-image').addEventListener('dblclick', () => openImageLightbox(state.gridGenerated?.dataUrl));
  $('#lightbox-close').addEventListener('click', closeImageLightbox);
  $('#image-lightbox').addEventListener('click', (event) => { if (event.target === $('#image-lightbox')) closeImageLightbox(); });
  $('#open-main').addEventListener('click', () => bridge.promptAction('open-main'));
  $('#pin-window').addEventListener('click', async () => {
    const pinned = await bridge.promptAction('pin');
    updatePinButton(pinned);
    toast(pinned ? '窗口已固定，Esc 不会关闭' : '已取消固定，Esc 可关闭窗口');
  });
  $('[data-window-action="minimize"]').addEventListener('click', () => bridge.windowControl('minimize'));
  $('#maximize-window').addEventListener('click', toggleMaximize);
  $('.titlebar-drag').addEventListener('dblclick', toggleMaximize);
  $('#close-window').addEventListener('click', () => bridge.promptAction('close'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      handleEscape();
    }
  });
}

if (!bridge) {
  document.body.textContent = '请从 Electron 启动 Luvoelle。';
} else {
  bindEvents();
  bridge.onPromptEvent(handlePromptEvent);
  bridge.onWindowState(updatePromptWindowState);
  bridge.windowControl('state').then(updatePromptWindowState).catch(() => {});
  bridge.bootstrap().then((bootstrap) => {
    state.settings = bootstrap.settings || {};
    renderGenerationService();
  }).catch(() => {});
}
