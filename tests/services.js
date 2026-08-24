const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildVisionInstruction,
  extractJson,
  normalizeAnalysis,
} = require('../src/services/vision');
const { buildEcommerceGridPrompt, buildReferencePrompt, primaryPromptForMode } = require('../src/services/generation');
const { buildOcrInstruction, normalizeAiOcr, shouldEnhanceOcr } = require('../src/services/ai-ocr');
const { shouldUseContextTranslation } = require('../src/services/routing');
const { mapViewportRectToPixels } = require('../src/services/capture-geometry');
const {
  mapAutomationTargetsToDisplays,
  mapAutomationTargetsToWindowTarget,
  mapWindowTargetsToDisplays,
} = require('../src/services/window-targets');
const { DEFAULT_SHORTCUTS, normalizeAccelerator, normalizeShortcutMap } = require('../src/services/shortcuts');
const {
  DEEPSEEK_ENDPOINT,
  DEEPSEEK_MODEL,
  applyDistributionDefaults,
  migrateDistributionSettings,
} = require('../src/services/distribution');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const settingsMarkup = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const assistantMarkup = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'assistant.html'), 'utf8');
const assistantSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'assistant.js'), 'utf8');
const assistantStyles = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'assistant.css'), 'utf8');
const windowsMouseHookSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'windows-mouse-hook.js'), 'utf8');
const petAssetPath = path.join(__dirname, '..', 'assets', 'pet-character-hd.png');
assert.match(mainSource, /\['google', 'openai', 'cun', 'deepseek', 'auto'\]/);
assert.match(mainSource, /actualProvider === 'cun'[\s\S]{0,100}CUN\.AI/);
assert.match(mainSource, /actualProvider === 'deepseek'[\s\S]{0,100}DeepSeek/);
assert.match(mainSource, /thinking: \{ type: 'disabled' \}/);
assert.match(mainSource, /net\.fetch/);
assert.match(settingsMarkup, /option value="cun">CUN\.AI<\/option>/);
assert.match(settingsMarkup, /option value="deepseek">DeepSeek V4 Flash<\/option>/);
assert.match(settingsSource, /https:\/\/api\.deepseek\.com/);
assert.match(settingsSource, /DEEPSEEK_MODEL = 'deepseek-v4-flash'/);
assert.match(settingsMarkup, /https:\/\/www\.cun\.ai\/v1/);
['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-mini'].forEach((model) => {
  assert.match(settingsSource, new RegExp(`id: '${model.replace(/\./g, '\\.')}'`));
});
assert.match(settingsMarkup, /translation-model-options/);
assert.match(settingsMarkup, /id="manual-paste-image"/);
assert.match(settingsMarkup, /option value="vi">越南语<\/option>/);
assert.match(settingsMarkup, /option value="th">泰语<\/option>/);
assert.match(settingsSource, /translateManualImage/);
assert.match(mainSource, /ipcMain\.handle\('translate:image'/);
assert.match(mainSource, /vi: '越南语'/);
assert.match(mainSource, /th: '泰语'/);
assert.match(preloadSource, /translateImage:.*translate:image/);
assert.match(mainSource, /function createAssistantWindow/);
assert.match(mainSource, /assistantWindow, ...promptWindows/);
assert.match(mainSource, /ipcMain\.handle\('assistant:translate'/);
assert.match(mainSource, /ipcMain\.handle\('assistant:ocr'/);
assert.match(preloadSource, /assistantTranslate:.*assistant:translate/);
assert.match(preloadSource, /assistantOcr:.*assistant:ocr/);
assert.match(assistantMarkup, /id="pet-button"/);
assert.equal((assistantMarkup.match(/pet-character-hd\.png/g) || []).length, 2);
assert.doesNotMatch(assistantMarkup, /id="pet-body"|class="pupil|class="ear ear-/);
assert.ok(fs.statSync(petAssetPath).size > 100000, 'HD desktop pet asset is unexpectedly small');
const petPng = fs.readFileSync(petAssetPath);
assert.equal(petPng.subarray(1, 4).toString('ascii'), 'PNG');
assert.equal(petPng.readUInt32BE(16), 903);
assert.equal(petPng.readUInt32BE(20), 1157);
assert.match(assistantStyles, /body\[data-side="left"\] \.pet-character/);
assert.match(assistantStyles, /body\.is-busy \.pet-character/);
assert.match(assistantStyles, /body\.is-success \.pet-stage/);
assert.match(assistantStyles, /body\.is-error \.pet-stage/);
assert.match(assistantSource, /playPetFeedback\('success'\)/);
assert.match(assistantSource, /playPetFeedback\('error'\)/);
assert.match(assistantMarkup, /id="translate-forward"/);
assert.match(assistantMarkup, /option value="vi">越南语<\/option>/);
assert.match(assistantMarkup, /option value="th">泰语<\/option>/);
assert.match(assistantSource, /recognizeImage\(assistantState\.activePane/);
assert.match(assistantSource, /translateDirection\('right', 'left'\)/);
assert.match(settingsMarkup, /id="setting-assistant-enabled"/);
assert.match(settingsMarkup, /id="setting-assistant-side"/);
assert.match(settingsMarkup, /id="restore-assistant"/);
assert.match(settingsMarkup, /settings-icon pet[^>]*><img src="\.\.\/\.\.\/assets\/pet-character-hd\.png"/);
assert.match(preloadSource, /assistantShow:.*assistant:show/);
assert.match(preloadSource, /assistantOpen:.*assistant:open/);
assert.match(mainSource, /ipcMain\.handle\('assistant:open'/);
assert.match(mainSource, /function setAssistantInputRegion/);
assert.match(mainSource, /assistantExpanded \|\| process\.platform === 'win32'/);
assert.match(mainSource, /assistant-native-click-open/);
assert.match(windowsMouseHookSource, /SetWindowsHookExW/);
assert.match(windowsMouseHookSource, /WH_MOUSE_LL|SetWindowsHookExW\(14/);
assert.match(assistantSource, /addEventListener\('pointerdown', openPetPanel\)/);
assert.match(assistantSource, /addEventListener\('click', openPetPanel\)/);
assert.match(assistantStyles, /data-platform="win32".*not\(\.is-hovered\).*\.pet-stage/);
assert.match(mainSource, /ipcMain\.handle\('assistant:show'/);
assert.match(assistantMarkup, /id="close-panel"/);
assert.match(assistantSource, /\$\('#close-panel'\).*assistantCollapse/);
assert.doesNotMatch(assistantSource, /\$\('#close-panel'\).*assistantHide/);
assert.match(mainSource, /tray\.on\('click', \(\) => showMain\(\)\)/);
assert.match(mainSource, /captureRestoreWindows = \[floatWindow, assistantWindow, \.\.\.promptWindows, \.\.\.pinnedImageWindows\]/);
assert.doesNotMatch(mainSource, /captureRestoreWindows = \[mainWindow,/);

assert.deepEqual(applyDistributionDefaults({ provider: 'google', endpoint: 'x', model: 'y' }, {}), { provider: 'google', endpoint: 'x', model: 'y' });
assert.deepEqual(applyDistributionDefaults({ provider: 'google' }, { luvoelleDistribution: 'friend' }), {
  provider: 'deepseek',
  endpoint: DEEPSEEK_ENDPOINT,
  model: DEEPSEEK_MODEL,
  distributionDefaultApplied: 'friend-deepseek-v4-flash',
});
const migratedFriend = migrateDistributionSettings({ provider: 'google', endpoint: 'old', model: 'old' }, { luvoelleDistribution: 'friend' });
assert.equal(migratedFriend.changed, true);
assert.equal(migratedFriend.settings.provider, 'deepseek');
assert.equal(migratedFriend.settings.endpoint, DEEPSEEK_ENDPOINT);
assert.equal(migratedFriend.settings.model, DEEPSEEK_MODEL);
const preservedFriendChoice = migrateDistributionSettings({ provider: 'openai', apiKeyEncrypted: 'encrypted', endpoint: 'custom', model: 'custom' }, { luvoelleDistribution: 'friend' });
assert.equal(preservedFriendChoice.settings.provider, 'openai');
assert.equal(preservedFriendChoice.settings.endpoint, 'custom');
assert.equal(preservedFriendChoice.settings.distributionDefaultApplied, 'friend-existing-choice-preserved');

assert.equal(normalizeAccelerator('control + shift + p'), 'Ctrl+Shift+P');
assert.equal(normalizeAccelerator('f1'), 'F1');
assert.throws(() => normalizeAccelerator('A'), /单按键快捷键仅支持/);
assert.throws(() => normalizeShortcutMap({ ...DEFAULT_SHORTCUTS, edit: 'F1' }), /不能使用同一个快捷键/);
assert.deepEqual(normalizeShortcutMap({}), DEFAULT_SHORTCUTS);

assert.deepEqual(
  mapViewportRectToPixels(
    { left: 100, top: 100, width: 400, height: 300 },
    { width: 2560, height: 1392 },
    { width: 3840, height: 2160 },
  ),
  { left: 150, top: 155, right: 750, bottom: 621, width: 600, height: 466, scaleX: 1.5, scaleY: 2160 / 1392 },
);

const mappedWindowTargets = mapWindowTargetsToDisplays([
  { id: 'primary', bounds: { x: 0, y: 0, width: 1000, height: 800 }, scaleFactor: 1.5 },
  { id: 'side', bounds: { x: -800, y: -100, width: 800, height: 600 }, scaleFactor: 1 },
], [
  { left: 150, top: 90, right: 1350, bottom: 900, title: 'Primary window', zIndex: 0 },
  { left: -700, top: 0, right: -100, bottom: 500, title: 'Side window', zIndex: 1 },
], ({ x }) => (x === 0 ? { x: 0, y: 0 } : { x: -800, y: -20 }));
assert.deepEqual(mappedWindowTargets.get('primary')[0], { left: 100, top: 60, width: 800, height: 540, title: 'Primary window', zIndex: 0 });
assert.deepEqual(mappedWindowTargets.get('side')[0], { left: 100, top: 20, width: 600, height: 500, title: 'Side window', zIndex: 1 });

const mappedAutomationTargets = mapAutomationTargetsToDisplays([
  { id: 'primary', bounds: { x: 0, y: 0, width: 1000, height: 800 }, scaleFactor: 1.5 },
], [
  { left: 150, top: 90, right: 750, bottom: 180, title: '反馈中心', controlType: 'ListItem', zIndex: 7 },
  { left: 160, top: 100, right: 170, bottom: 110, title: 'too small', controlType: 'Text', zIndex: 8 },
  { left: 150, top: 90, right: 750, bottom: 180, title: 'duplicate', controlType: 'Pane', zIndex: 9 },
], () => ({ x: 0, y: 0 }));
assert.deepEqual(mappedAutomationTargets.get('primary'), [{
  left: 100,
  top: 60,
  width: 400,
  height: 60,
  title: '反馈中心',
  zIndex: 7,
  source: 'uia',
  controlType: 'ListItem',
}]);

const calibratedAutomationTargets = mapAutomationTargetsToWindowTarget({
  nativeBounds: { left: 0, top: 0, right: 3000, bottom: 1500 },
  displayPhysicalBounds: { left: 0, top: 0, right: 3000, bottom: 1500 },
  scaleFactor: 1.5,
}, {
  handle: '123', left: 10, top: 20, right: 3010, bottom: 1520,
}, [
  { left: 160, top: 170, right: 760, bottom: 320, title: '校准后的列表项', controlType: 'ListItem', zIndex: 2 },
  { left: -500, top: -500, right: -100, bottom: -100, title: '窗口外元素', controlType: 'Pane', zIndex: 3 },
]);
assert.deepEqual(calibratedAutomationTargets, [{
  left: 100,
  top: 100,
  width: 400,
  height: 100,
  title: '校准后的列表项',
  zIndex: 2,
  source: 'uia',
  controlType: 'ListItem',
}]);

const fenced = extractJson('```json\n{"summary":"测试画面","scene_type":"电商"}\n```');
assert.equal(fenced.summary, '测试画面');

const surrounded = extractJson('模型分析如下：\n{"summary":"结构化结果"}\n分析结束');
assert.equal(surrounded.summary, '结构化结果');

const normalized = normalizeAnalysis({
  description: '一只玻璃瓶',
  subject: { name: '精华瓶', material: '玻璃、金属', color: ['白色'] },
  prompt: { chinese: '商业产品摄影' },
});
assert.equal(normalized.subject.description, '精华瓶');
assert.deepEqual(normalized.subject.attributes, ['玻璃', '金属']);
assert.equal(normalized.prompts.qwenImage, '商业产品摄影');
assert.equal(normalized.prompts.flux, '商业产品摄影');

const instruction = buildVisionInstruction();
assert.match(instruction, /只输出 JSON/);
assert.match(instruction, /艺术家/);
assert.match(buildVisionInstruction('ecommerce'), /品牌名/);
assert.match(buildVisionInstruction('daily'), /日常模式/);
assert.match(buildVisionInstruction('ecommerce'), /电商拆图模式/);
assert.match(buildVisionInstruction('drama'), /短剧拆图模式/);
assert.doesNotMatch(buildVisionInstruction('drama'), /商品展示|电商主图|电商拆图模式|商品名|商业电商/);

const stylePrompt = buildReferencePrompt({ prompt: '柔和灯光的玻璃瓶', strategy: 'style' });
const compositionPrompt = buildReferencePrompt({ prompt: '柔和灯光的玻璃瓶', strategy: 'composition' });
const productPrompt = buildReferencePrompt({ prompt: '柔和灯光的玻璃瓶', strategy: 'product', analysis: { analysisMode: 'ecommerce' } });
assert.match(stylePrompt, /明显不同的构图/);
assert.match(compositionPrompt, /保留画幅比例/);
assert.match(productPrompt, /用户确认拥有商品图片权利/);
assert.notEqual(stylePrompt, compositionPrompt);
assert.notEqual(compositionPrompt, productPrompt);

const normalizedDrama = normalizeAnalysis({
  summary: '人物商品展示电商主图',
  scene_type: '服饰电商视觉',
  product: { subject: '{商品名}' },
  drama: {
    narrative_beat: '[推测]少女发现门外有人',
    dramatic_purpose: '制造疑问',
    characters: [{ name: '少女', appearance: '黑色长发', wardrobe: '浅紫和服', expression: '警觉' }],
    location: { setting: '木质房间', time: '夜晚' },
    visible_action: '少女转头看向门外',
    conflict_tension: '门外动静打破安静',
    continuity: { identity_locks: ['同一张脸'], wardrobe_locks: ['浅紫和服'], screen_direction: '视线朝画面右侧' },
    suggested_duration: '4秒',
  },
  prompts: {
    universal_zh: '一名少女穿着{商品名}，棚拍商品展示，电商主图',
    first_frame_zh: '少女穿浅紫和服站在木质房间内，警觉地看向画面右侧',
    image_to_video: '少女缓慢转头，镜头轻微推近，门帘被风吹动',
    negative: '换脸，服装变化，时间闪烁，镜头抖动',
  },
}, { analysisMode: 'drama' });
assert.equal(normalizedDrama.sceneType, '短剧镜头');
assert.equal(normalizedDrama.product.subject, '');
assert.deepEqual(Object.keys(normalizedDrama.prompts).sort(), ['characterContinuity', 'firstFrameEn', 'firstFrameZh', 'imageToVideo', 'keyframeZh', 'negative', 'storyboardZh'].sort());
assert.match(normalizedDrama.prompts.firstFrameZh, /少女|和服/);
assert.match(normalizedDrama.prompts.imageToVideo, /转头|推近/);
assert.doesNotMatch(JSON.stringify(normalizedDrama.prompts), /商品名|商品展示|电商主图|保持商品|商品图瑕疵/);
assert.equal(primaryPromptForMode(normalizedDrama), normalizedDrama.prompts.firstFrameZh);

const dramaReferencePrompt = buildReferencePrompt({
  prompt: normalizedDrama.prompts.firstFrameZh,
  strategy: 'character',
  analysis: normalizedDrama,
});
assert.match(dramaReferencePrompt, /短剧镜头参考|锁定可见角色|不得换脸/);
assert.doesNotMatch(dramaReferencePrompt, /商品名|商品展示|电商主图|保持商品|商品图瑕疵|商业电商/);

const ecommerceGridPrompt = buildEcommerceGridPrompt({
  analysis: {
    summary: '穿蓝色外套的模特手持护肤瓶',
    product: { subject: '模特与护肤瓶', category: '人物带货', colors: ['蓝色', '白色'] },
    modeData: { identity_locks: ['同一张脸', '蓝色外套', '白色瓶身'] },
    prompts: { negative: '模糊文字' },
  },
  subjectMode: 'selling',
  visualStyle: 'premium',
});
assert.match(ecommerceGridPrompt, /ONE final square/);
assert.match(ecommerceGridPrompt, /exact 3-by-3 grid/);
assert.match(ecommerceGridPrompt, /同一张脸/);
assert.match(ecommerceGridPrompt, /人物实际操作商品/);

const ocrInstruction = buildOcrInstruction('H3LLO WORLD');
assert.match(ocrInstruction, /不要翻译/);
assert.match(ocrInstruction, /本地 OCR 草稿/);
const normalizedAiOcr = normalizeAiOcr({ text: 'HELLO WORLD', language: 'en', confidence: 0.97 });
assert.deepEqual(normalizedAiOcr, { text: 'HELLO WORLD', detectedLanguage: 'en', confidence: 97 });
assert.equal(shouldEnhanceOcr({ text: 'HELLO', confidence: 96, blocks: [] }), false);
assert.equal(shouldEnhanceOcr({ text: 'H?L?O', confidence: 61, blocks: [] }), true);
assert.equal(shouldUseContextTranslation('Hello world'), false);
assert.equal(shouldUseContextTranslation('短'.repeat(59)), false);
assert.equal(shouldUseContextTranslation('短'.repeat(60)), false);
assert.equal(shouldUseContextTranslation('短'.repeat(109)), false);
assert.equal(shouldUseContextTranslation('长'.repeat(110)), true);
assert.equal(shouldUseContextTranslation(`${'甲'.repeat(28)}。${'乙'.repeat(29)}。`), false);
assert.equal(shouldUseContextTranslation(`${'甲'.repeat(29)}。${'乙'.repeat(29)}。`), true);
assert.equal(shouldUseContextTranslation('第一句内容足够长。第二句内容同样完整。'.padEnd(60, '补')), true);
assert.equal(shouldUseContextTranslation('第一行\n第二行\n第三行'), false);
assert.equal(shouldUseContextTranslation('第一行\n第二行\n第三行\n第四行'), true);
assert.equal(shouldUseContextTranslation('- 第一项\n- 第二项'), true);

console.log(JSON.stringify({
  visionJsonParsing: true,
  normalizationFallbacks: true,
  safePromptInstruction: true,
  aiOcrNormalization: true,
  hybridOcrRouting: ['local', 'auto', 'ai'],
  translationRouting: ['google', 'deepseek', 'openai', 'cun', 'auto'],
  apiPresets: { cun: 'https://www.cun.ai/v1', deepseek: DEEPSEEK_ENDPOINT },
  deepseekTranslation: { model: DEEPSEEK_MODEL, thinking: 'disabled', friendDefault: true, localDefaultPreserved: true },
  cunModelPresets: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-mini'],
  manualImageTranslation: { clipboardPaste: true, editableOcrText: true },
  desktopPetAssistant: { edgePeek: true, alwaysOnTop: true, bidirectionalEditing: true, imageOcrBothSides: true, closeReturnsToEdge: true, workbenchSettings: true },
  workbenchVisibility: { trayClickOpens: true, captureNeverRestores: true, explicitWorkbenchActionOpens: true },
  translationTargets: ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'vi', 'th'],
  translationRoutingThresholds: { longText: 110, contextualText: 60, sentences: 2, structuredLines: 4 },
  referenceStrategies: {
    daily: ['style', 'composition', 'subject'],
    ecommerce: ['style', 'composition', 'product'],
    drama: ['character', 'shot', 'continuity'],
  },
  analysisModes: ['daily', 'ecommerce', 'drama'],
  dramaSchemaIsolation: true,
  ecommerceGrid: { singleImage: true, panels: 9 },
  nativeWindowTargetMapping: true,
  smartControlTargetMapping: true,
  viewportCalibratedCropping: true,
  configurableShortcuts: { quickEdit: 'F1', conflictDetection: true, safeSingleKeys: true },
}));
