const ANALYSIS_MODES = Object.freeze({
  daily: '日常模式',
  ecommerce: '电商拆图',
  drama: '短剧拆图',
});

const DEFAULT_ANALYSIS = Object.freeze({
  analysisMode: 'daily',
  summary: '',
  sceneType: '日常视觉',
  subject: {
    type: '',
    description: '',
    attributes: [],
    colors: [],
    form: '',
    details: [],
  },
  product: {
    category: '',
    subject: '',
    materials: [],
    colors: [],
    geometry: '',
    details: [],
  },
  composition: {
    aspectRatio: '',
    framing: '',
    viewpoint: '',
    subjectPosition: '',
    negativeSpace: '',
  },
  camera: {
    shotType: '',
    cameraAngle: '',
    lensGuess: '',
    depthOfField: '',
    cameraMovement: '',
  },
  lighting: {
    source: '',
    direction: '',
    quality: '',
    colorTemperature: '',
  },
  background: {
    setting: '',
    props: [],
    texture: '',
  },
  palette: [],
  visibleText: [],
  typography: '',
  drama: {
    narrativeBeat: '',
    dramaticPurpose: '',
    characters: [],
    relationships: [],
    location: { setting: '', time: '', weather: '' },
    props: [],
    visibleAction: '',
    performance: '',
    conflictTension: '',
    blocking: '',
    dialogueOrSubtitle: [],
    continuity: {
      identityLocks: [],
      wardrobeLocks: [],
      sceneLocks: [],
      screenDirection: '',
      before: '',
      after: '',
    },
    suggestedDuration: '',
    uncertainties: [],
  },
  prompts: {},
  warnings: [],
  confidence: {},
  modeData: {},
});

function normalizeAnalysisMode(mode = '') {
  return Object.prototype.hasOwnProperty.call(ANALYSIS_MODES, mode) ? mode : 'daily';
}

function isLocalEndpoint(endpoint = '') {
  try {
    const url = new URL(endpoint);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function normalizeEndpoint(endpoint = '') {
  const normalized = String(endpoint).trim().replace(/\/$/, '');
  if (!normalized) throw new Error('请先在设置中配置视觉模型接口。');
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('视觉模型接口地址无效。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('视觉模型接口只支持 HTTP 或 HTTPS。');
  return normalized;
}

function stringValue(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (Array.isArray(value)) return value.map((item) => stringValue(item)).filter(Boolean).join('、');
  if (typeof value === 'object') return Object.values(value).map((item) => stringValue(item)).filter(Boolean).join('；');
  return String(value).trim();
}

function stringArray(value) {
  if (Array.isArray(value)) return value.map((item) => stringValue(item)).filter(Boolean).slice(0, 24);
  const text = stringValue(value);
  return text ? text.split(/[、,，;；\n]+/).map((item) => item.trim()).filter(Boolean).slice(0, 24) : [];
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeDramaCharacters(value) {
  const items = Array.isArray(value) ? value : stringArray(value);
  return items.slice(0, 12).map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { name: stringValue(item, `角色${index + 1}`), appearance: '', wardrobe: '', expression: '', bodyLanguage: '', screenPosition: '' };
    }
    return {
      name: stringValue(item.name || item.role, `角色${index + 1}`),
      appearance: stringValue(item.appearance || item.identity || item.look),
      wardrobe: stringValue(item.wardrobe || item.costume || item.clothing),
      expression: stringValue(item.expression || item.emotion),
      bodyLanguage: stringValue(item.bodyLanguage || item.body_language || item.pose),
      screenPosition: stringValue(item.screenPosition || item.screen_position || item.position),
    };
  }).filter((item) => item.name);
}

const DRAMA_CONTAMINATION = /(商品展示|商品主图|商品图瑕疵|电商(?:主图|展示|视觉|摄影|风格)?|商业电商|带货|广告\s*KV|品牌安全区|\{商品名\}|保持商品)/i;

function dramaSafeText(value) {
  return stringValue(value)
    .replace(/\{商品名\}/gi, '关键道具')
    .replace(/商品图瑕疵/gi, '画面时序瑕疵')
    .replace(/保持商品/gi, '保持关键道具')
    .replace(/商业电商(?:展示)?/gi, '剧情化呈现')
    .replace(/电商(?:主图|展示|视觉|摄影|风格)?/gi, '剧情画面')
    .replace(/商品(?:展示|主图|摄影)/gi, '道具呈现')
    .replace(/带货/gi, '人物互动')
    .replace(/广告\s*KV/gi, '关键画面')
    .replace(/品牌安全区/gi, '构图留白')
    .trim();
}

function dramaPromptText(value) {
  const text = stringValue(value);
  return DRAMA_CONTAMINATION.test(text) ? '' : dramaSafeText(text);
}

function dramaSafeArray(value) {
  return stringArray(value).map(dramaSafeText).filter(Boolean);
}

function normalizeDrama(raw, legacyModeData = {}) {
  const source = objectValue(raw.drama || legacyModeData);
  const location = objectValue(source.location);
  const continuity = objectValue(source.continuity);
  return {
    narrativeBeat: dramaSafeText(source.narrativeBeat || source.narrative_beat),
    dramaticPurpose: dramaSafeText(source.dramaticPurpose || source.dramatic_purpose),
    characters: normalizeDramaCharacters(source.characters).map((character) => Object.fromEntries(
      Object.entries(character).map(([key, value]) => [key, dramaSafeText(value)]),
    )),
    relationships: dramaSafeArray(source.relationships),
    location: {
      setting: dramaSafeText(location.setting || source.setting || source.scene),
      time: dramaSafeText(location.time || source.time_of_day || source.time),
      weather: dramaSafeText(location.weather || source.weather),
    },
    props: dramaSafeArray(source.props),
    visibleAction: dramaSafeText(source.visibleAction || source.visible_action || source.action),
    performance: dramaSafeText(source.performance || source.expression),
    conflictTension: dramaSafeText(source.conflictTension || source.conflict_tension || source.tension),
    blocking: dramaSafeText(source.blocking || source.spatial_relationship),
    dialogueOrSubtitle: dramaSafeArray(source.dialogueOrSubtitle || source.dialogue_or_subtitle || source.dialogue),
    continuity: {
      identityLocks: dramaSafeArray(continuity.identityLocks || continuity.identity_locks || source.identity_locks),
      wardrobeLocks: dramaSafeArray(continuity.wardrobeLocks || continuity.wardrobe_locks || source.wardrobe_locks),
      sceneLocks: dramaSafeArray(continuity.sceneLocks || continuity.scene_locks || source.scene_locks),
      screenDirection: dramaSafeText(continuity.screenDirection || continuity.screen_direction || source.screen_direction),
      before: dramaSafeText(continuity.before || source.before || source.previous_beat),
      after: dramaSafeText(continuity.after || source.after || source.next_beat),
    },
    suggestedDuration: dramaSafeText(source.suggestedDuration || source.suggested_duration),
    uncertainties: dramaSafeArray(source.uncertainties || source.uncertainty || source.inferences),
  };
}

function dramaCharacterBrief(characters = []) {
  return characters.map((character) => [
    character.name,
    character.appearance,
    character.wardrobe,
    character.expression,
    character.bodyLanguage,
  ].filter(Boolean).join('，')).filter(Boolean).join('；');
}

function buildDramaPromptFallbacks(normalized) {
  const drama = normalized.drama;
  const characterBrief = dramaCharacterBrief(drama.characters);
  const location = [drama.location.setting, drama.location.time, drama.location.weather].filter(Boolean).join('，');
  const framing = [normalized.camera.shotType, normalized.camera.cameraAngle, normalized.composition.viewpoint, normalized.composition.framing].filter(Boolean).join('，');
  const light = [normalized.lighting.source, normalized.lighting.direction, normalized.lighting.quality].filter(Boolean).join('，');
  const currentState = [characterBrief, drama.visibleAction, drama.performance, location, framing, light].filter(Boolean).join('；');
  const duration = drama.suggestedDuration || '3–6 秒';
  const movement = normalized.camera.cameraMovement || '固定机位或单一缓慢运镜';
  const locks = [
    ...drama.continuity.identityLocks,
    ...drama.continuity.wardrobeLocks,
    ...drama.continuity.sceneLocks,
  ].join('；');
  return {
    firstFrameZh: `短剧首帧：${currentState || '保持输入画面中可见的人物、场景与镜头关系'}。只呈现当前动作的起始状态，电影感叙事画面。`,
    firstFrameEn: currentState ? `Short-drama opening frame: ${currentState}. Preserve the visible cast, wardrobe, setting and framing.` : '',
    keyframeZh: `短剧关键帧：${[drama.narrativeBeat, drama.conflictTension, currentState].filter(Boolean).join('；') || '捕捉当前镜头最有戏剧张力的可见瞬间'}。`,
    storyboardZh: `分镜复现：${[drama.dramaticPurpose, currentState, drama.blocking].filter(Boolean).join('；') || '依据输入画面复现人物关系、空间站位与镜头语言'}。`,
    imageToVideo: `以输入画面为首帧，保持角色身份、服装、场景与构图不变；${drama.visibleAction || '角色仅做自然呼吸、眨眼和轻微视线变化'}；摄影机采用${movement}；环境运动克制且符合物理规律，持续${duration}。`,
    characterContinuity: locks || `锁定${characterBrief || '输入画面中可见角色'}的脸部特征、发型、服装、身体比例与空间朝向，不新增角色，不改变场景。`,
    negative: '身份漂移、换脸、年龄变化、发型变化、服装变化、额外人物、重复人物、肢体畸形、动作跳变、时间闪烁、镜头抖动、轴线翻转、乱码字幕、水印',
  };
}

function extractJson(content) {
  const rawContent = Array.isArray(content)
    ? content.map((part) => (typeof part === 'string' ? part : part?.text || part?.content || '')).filter(Boolean).join('\n')
    : content;
  const text = stringValue(rawContent).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!text) throw new Error('视觉模型没有返回分析结果。');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Fall through to the user-facing format error below.
      }
    }
  }
  throw new Error('视觉模型返回的内容不是有效 JSON，请换用支持结构化输出的视觉模型。');
}

function normalizeAnalysis(value, metadata = {}) {
  const raw = objectValue(value);
  const analysisMode = normalizeAnalysisMode(metadata.analysisMode || raw.analysisMode || raw.analysis_mode);
  const legacyModeData = objectValue(raw.modeData || raw.mode_data);
  const dailySubject = objectValue(raw.subject || (analysisMode === 'daily' ? raw.product : {}));
  const product = objectValue(analysisMode === 'ecommerce' ? (raw.product || raw.subject) : {});
  const composition = objectValue(raw.composition);
  const camera = objectValue(raw.camera);
  const lighting = objectValue(raw.lighting);
  const background = objectValue(raw.background);
  const prompts = objectValue(raw.prompts || raw.prompt);
  const drama = analysisMode === 'drama' ? normalizeDrama(raw, legacyModeData) : { ...DEFAULT_ANALYSIS.drama };
  const normalized = {
    ...DEFAULT_ANALYSIS,
    analysisMode,
    summary: analysisMode === 'drama'
      ? dramaPromptText(raw.summary || raw.visual_summary || raw.description)
      : stringValue(raw.summary || raw.visual_summary || raw.description),
    sceneType: analysisMode === 'drama'
      ? '短剧镜头'
      : stringValue(raw.sceneType || raw.scene_type, ({ daily: '日常视觉', ecommerce: '电商视觉' })[analysisMode]),
    subject: {
      type: stringValue(dailySubject.type || dailySubject.category),
      description: stringValue(dailySubject.description || dailySubject.subject || dailySubject.name),
      attributes: stringArray(dailySubject.attributes || dailySubject.materials || dailySubject.material || dailySubject.features),
      colors: stringArray(dailySubject.colors || dailySubject.colours || dailySubject.color),
      form: stringValue(dailySubject.form || dailySubject.geometry || dailySubject.shape),
      details: stringArray(dailySubject.details || dailySubject.observations),
    },
    product: {
      category: stringValue(product.category || product.type),
      subject: stringValue(product.subject || product.name || product.description),
      materials: stringArray(product.materials || product.material),
      colors: stringArray(product.colors || product.colours || product.color),
      geometry: stringValue(product.geometry || product.shape),
      details: stringArray(product.details || product.features),
    },
    composition: {
      aspectRatio: stringValue(composition.aspectRatio || composition.aspect_ratio),
      framing: stringValue(composition.framing),
      viewpoint: stringValue(composition.viewpoint || composition.camera_angle),
      subjectPosition: stringValue(composition.subjectPosition || composition.subject_position),
      negativeSpace: stringValue(composition.negativeSpace || composition.negative_space),
    },
    camera: {
      shotType: stringValue(camera.shotType || camera.shot_type),
      cameraAngle: stringValue(camera.cameraAngle || camera.camera_angle || camera.angle),
      lensGuess: stringValue(camera.lensGuess || camera.lens_guess || camera.lens),
      depthOfField: stringValue(camera.depthOfField || camera.depth_of_field),
      cameraMovement: stringValue(camera.cameraMovement || camera.camera_movement || camera.movement),
    },
    lighting: {
      source: stringValue(lighting.source),
      direction: stringValue(lighting.direction),
      quality: stringValue(lighting.quality || lighting.hardness),
      colorTemperature: stringValue(lighting.colorTemperature || lighting.color_temperature),
    },
    background: {
      setting: stringValue(background.setting || background.scene || background.description),
      props: stringArray(background.props || background.objects),
      texture: stringValue(background.texture),
    },
    palette: stringArray(raw.palette || raw.color_palette),
    visibleText: stringArray(raw.visibleText || raw.visible_text || raw.text),
    typography: stringValue(raw.typography),
    drama,
    prompts: analysisMode === 'drama' ? {
      firstFrameZh: dramaPromptText(prompts.firstFrameZh || prompts.first_frame_zh || legacyModeData.first_frame_prompt),
      firstFrameEn: dramaPromptText(prompts.firstFrameEn || prompts.first_frame_en),
      keyframeZh: dramaPromptText(prompts.keyframeZh || prompts.keyframe_zh || prompts.key_frame_zh),
      storyboardZh: dramaPromptText(prompts.storyboardZh || prompts.storyboard_zh || prompts.shot_zh),
      imageToVideo: dramaPromptText(prompts.imageToVideo || prompts.image_to_video || prompts.video_prompt || legacyModeData.video_prompt),
      characterContinuity: dramaPromptText(prompts.characterContinuity || prompts.character_continuity || prompts.continuity),
      negative: dramaPromptText(prompts.negative || prompts.negative_prompt),
    } : {
      universalZh: stringValue(prompts.universalZh || prompts.universal_zh || prompts.chinese),
      universalEn: stringValue(prompts.universalEn || prompts.universal_en || prompts.english),
      qwenImage: stringValue(prompts.qwenImage || prompts.qwen_image),
      flux: stringValue(prompts.flux),
      midjourney: stringValue(prompts.midjourney),
      negative: stringValue(prompts.negative || prompts.negative_prompt),
    },
    warnings: analysisMode === 'drama' ? dramaSafeArray(raw.warnings || raw.risks) : stringArray(raw.warnings || raw.risks),
    confidence: objectValue(raw.confidence),
    modeData: analysisMode === 'drama' ? drama : legacyModeData,
    provider: stringValue(metadata.provider),
    latency: Number(metadata.latency || 0),
    local: Boolean(metadata.local),
  };

  if (!normalized.summary) {
    const modeSubject = analysisMode === 'drama'
      ? [normalized.drama.narrativeBeat, dramaCharacterBrief(normalized.drama.characters), normalized.drama.visibleAction]
      : analysisMode === 'ecommerce'
        ? [normalized.product.subject]
        : [normalized.subject.description];
    normalized.summary = [...modeSubject, normalized.background.setting, normalized.composition.framing]
      .filter(Boolean).join('，') || '已完成视觉拆解';
  }
  if (analysisMode === 'drama') {
    const fallbacks = buildDramaPromptFallbacks(normalized);
    Object.keys(fallbacks).forEach((key) => {
      if (!normalized.prompts[key] || DRAMA_CONTAMINATION.test(normalized.prompts[key])) normalized.prompts[key] = fallbacks[key];
    });
    normalized.summary = dramaSafeText(normalized.summary);
    return normalized;
  }
  if (!normalized.prompts.universalZh) {
    const subjectDescription = analysisMode === 'ecommerce' ? normalized.product.subject : normalized.subject.description;
    const subjectAttributes = analysisMode === 'ecommerce' ? normalized.product.materials : normalized.subject.attributes;
    normalized.prompts.universalZh = [
      subjectDescription,
      subjectAttributes.join('、'),
      normalized.background.setting,
      normalized.composition.framing,
      normalized.lighting.source,
      normalized.lighting.quality,
    ].filter(Boolean).join('，');
  }
  if (!normalized.prompts.qwenImage) normalized.prompts.qwenImage = normalized.prompts.universalZh;
  if (!normalized.prompts.flux) normalized.prompts.flux = normalized.prompts.universalEn || normalized.prompts.universalZh;
  if (!normalized.prompts.midjourney) normalized.prompts.midjourney = normalized.prompts.universalEn || normalized.prompts.universalZh;
  return normalized;
}

function buildVisionInstruction(mode = 'daily') {
  const analysisMode = normalizeAnalysisMode(mode);
  const commonRules = `你是 Luvoelle 的视觉拆解助手。只根据输入截图中可见的证据进行分析，输出可编辑、可用于重新创作的结构化 JSON。

共同规则：
1. 焦段、光圈、拍摄时间和截图之外的事件无法确认时，必须明确写“推测”，不能伪装成真实 EXIF 或事实。
2. 单独列出可见文字、Logo 与水印；不要照抄不可替换的专有文案。
3. 不模仿具体艺术家，只描述可观察的构图、色彩、光影、质感与媒介特征。
4. warnings 标记商标、水印、人物肖像与版权角色风险。
5. 只输出 JSON 对象，不要 Markdown，不要解释。`;

  if (analysisMode === 'drama') {
    return `${commonRules}

这是“短剧拆图模式”。你是一名影视导演、分镜师与连续性指导，不是营销制图人员。禁止套用零售、广告、卖点、陈列、营销占位符或商业主视觉语言；画面中的物件一律按剧情道具处理。

短剧专属规则：
1. 先识别当前单帧可证实的角色外观、服装、表情、身体姿态、场景、道具、空间站位、景别、机位、构图、光线与色彩。
2. narrative_beat、dramatic_purpose、人物关系、前因后果若无法从单帧确认，必须以“[推测]”开头；不得把推测写成既定剧情。
3. 角色连续性分别锁定脸部/发型/体型、服装、场景与道具；记录人物朝向、视线和画面左右关系，避免后续反打翻轴。
4. first_frame_zh / first_frame_en 只描述当前镜头的起始静帧；keyframe_zh 捕捉最有戏剧张力的可见瞬间；storyboard_zh 写清镜头执行信息。
5. image_to_video 以输入图为首帧，主要写“接下来发生的运动”：角色微动作或动作变化、环境动态、一个明确运镜、建议时长。不要重复堆砌静态外观，不要同时给互相冲突的运镜。
6. character_continuity 使用可复用的身份、发型、服装、体型、场景和轴线锚点；negative 针对换脸、身份漂移、服装变化、额外人物、肢体畸形、动作跳变、闪烁、抖动和翻轴。

JSON 字段固定为：
{
  "analysis_mode":"drama",
  "summary":"",
  "scene_type":"短剧镜头",
  "drama":{
    "narrative_beat":"",
    "dramatic_purpose":"",
    "characters":[{"name":"","appearance":"","wardrobe":"","expression":"","body_language":"","screen_position":""}],
    "relationships":[],
    "location":{"setting":"","time":"","weather":""},
    "props":[],
    "visible_action":"",
    "performance":"",
    "conflict_tension":"",
    "blocking":"",
    "dialogue_or_subtitle":[],
    "continuity":{"identity_locks":[],"wardrobe_locks":[],"scene_locks":[],"screen_direction":"","before":"","after":""},
    "suggested_duration":"",
    "uncertainties":[]
  },
  "composition":{"aspect_ratio":"","framing":"","viewpoint":"","subject_position":"","negative_space":""},
  "camera":{"shot_type":"","camera_angle":"","lens_guess":"","depth_of_field":"","camera_movement":""},
  "lighting":{"source":"","direction":"","quality":"","color_temperature":""},
  "background":{"setting":"","props":[],"texture":""},
  "palette":[],
  "visible_text":[],
  "typography":"",
  "prompts":{"first_frame_zh":"","first_frame_en":"","keyframe_zh":"","storyboard_zh":"","image_to_video":"","character_continuity":"","negative":""},
  "warnings":[],
  "confidence":{}
}`;
  }

  if (analysisMode === 'ecommerce') {
    return `${commonRules}

这是“电商拆图模式”。重点分析人物或商品身份、商品外观、材质、颜色、结构、服装、Logo、标签、核心卖点、使用方式和商业构图。把不能改变的主体特征写入 identity_locks；单张图片看不到的背面或侧面结构必须标记为“推测”，不得虚构接口、Logo、文字或配件。生成提示词中的具体品牌和文案替换为 {品牌名}、{商品名}、{主标题} 等变量。

JSON 字段固定为：
{"analysis_mode":"ecommerce","summary":"","scene_type":"","product":{"category":"","subject":"","materials":[],"colors":[],"geometry":"","details":[]},"composition":{"aspect_ratio":"","framing":"","viewpoint":"","subject_position":"","negative_space":""},"camera":{"shot_type":"","lens_guess":"","depth_of_field":"","camera_movement":""},"lighting":{"source":"","direction":"","quality":"","color_temperature":""},"background":{"setting":"","props":[],"texture":""},"palette":[],"visible_text":[],"typography":"","prompts":{"universal_zh":"","universal_en":"","qwen_image":"","flux":"","midjourney":"","negative":""},"mode_data":{"subject_type":"person|person_with_product|product","identity_locks":[],"selling_points":[],"usage_context":"","target_audience":"","platform_ratio":"","grid_subject_notes":[],"uncertain_views":[]},"warnings":[],"confidence":{}}`;
  }

  return `${commonRules}

这是“日常模式”。使用中立、通用的视觉语言，不预设营销用途。重点分析人物或物体、正在发生的事件、环境、构图、镜头、光线、色彩、可见文字与整体氛围。

JSON 字段固定为：
{"analysis_mode":"daily","summary":"","scene_type":"","subject":{"type":"","description":"","attributes":[],"colors":[],"form":"","details":[]},"composition":{"aspect_ratio":"","framing":"","viewpoint":"","subject_position":"","negative_space":""},"camera":{"shot_type":"","lens_guess":"","depth_of_field":"","camera_movement":""},"lighting":{"source":"","direction":"","quality":"","color_temperature":""},"background":{"setting":"","props":[],"texture":""},"palette":[],"visible_text":[],"typography":"","prompts":{"universal_zh":"","universal_en":"","qwen_image":"","flux":"","midjourney":"","negative":""},"mode_data":{"subject_type":"","activity":"","mood":"","style_keywords":[],"recreation_notes":[]},"warnings":[],"confidence":{}}`;
}

async function requestVisionAnalysis({ endpoint, apiKey, model, dataUrl, provider = 'cloud', analysisMode = 'daily', signal }) {
  const baseUrl = normalizeEndpoint(endpoint);
  const local = provider === 'local' || isLocalEndpoint(baseUrl);
  const normalizedMode = normalizeAnalysisMode(analysisMode);
  if (!model?.trim()) throw new Error('请先在设置中填写视觉模型名称。');
  if (!apiKey && !local) throw new Error('请先在设置中保存视觉模型 API Key。');
  if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(dataUrl || '')) throw new Error('没有可分析的截图。');
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
        model: model.trim(),
        temperature: 0.15,
        max_tokens: normalizedMode === 'drama' ? 3200 : 2400,
        messages: [
          { role: 'system', content: buildVisionInstruction(normalizedMode) },
          {
            role: 'user',
            content: [
              { type: 'text', text: `使用${ANALYSIS_MODES[normalizedMode]}拆解这张截图，并生成可编辑提示词。` },
              { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
            ],
          },
        ],
      }),
      signal: signal || AbortSignal.timeout(120000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw error;
    throw new Error(`无法连接视觉服务 ${baseUrl}。请在设置中点击“检测并保存”后重试。`);
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`视觉分析请求失败（${response.status}）：${detail.slice(0, 240)}`);
  }
  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;
  return normalizeAnalysis(extractJson(content), {
    provider: model.trim(),
    latency: Date.now() - startedAt,
    local,
    analysisMode: normalizedMode,
  });
}

async function checkVisionService({ endpoint, apiKey, signal }) {
  const baseUrl = normalizeEndpoint(endpoint);
  const response = await fetch(`${baseUrl}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: signal || AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`视觉服务检测失败（${response.status}）。`);
  const json = await response.json().catch(() => ({}));
  const models = Array.isArray(json.data) ? json.data.map((item) => item.id).filter(Boolean) : [];
  return { ok: true, models };
}

module.exports = {
  ANALYSIS_MODES,
  buildVisionInstruction,
  checkVisionService,
  extractJson,
  isLocalEndpoint,
  normalizeAnalysis,
  normalizeAnalysisMode,
  requestVisionAnalysis,
};
