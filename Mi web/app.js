(() => {
  'use strict';
  const $ = id => document.getElementById(id);

  // ==================== CANCELACIÓN (todas las llamadas fetch del análisis) ====================
  let activeAbort = null;
  const fetch = (u, o = {}) => window.fetch(u, { signal: activeAbort ? activeAbort.signal : undefined, ...o });

  // ==================== PERSISTENCIA LOCAL (IndexedDB: último proyecto) ====================
  let pendingRestore = null;
  let pendingWindow = null; // ventana inicio/fin a aplicar al cargar un corte de directo
  let pendingLiveSubs = null; // subtítulos del corte en vivo al abrirlo en el Estudio
  const ProjectDB = {
    open() {
      return new Promise((res, rej) => {
        const r = indexedDB.open('cliphub_studio', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('projects');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    },
    async run(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction('projects', mode);
        const req = fn(tx.objectStore('projects'));
        tx.oncomplete = () => { db.close(); res(req.result); };
        tx.onerror = tx.onabort = () => { db.close(); rej(tx.error); };
      });
    },
    put(k, v) { return this.run('readwrite', s => s.put(v, k)); },
    get(k) { return this.run('readonly', s => s.get(k)); },
    del(k) { return this.run('readwrite', s => s.delete(k)); }
  };

  // ==================== CONFIGURACIÓN PÚBLICA DE PRODUCCIÓN ====================
  // 1. Pega aquí la URL real de tu Cloudflare Worker (cloudflare-worker-proxy.js)
  //    Ejemplo: 'https://cliphub-api-proxy.tu-cuenta.workers.dev'
  // ==================== CONFIGURACIÓN DE MODO MANUAL (TOKENS PROPIOS) ====================
  // PUBLIC_SAAS_MODE en false mantiene siempre visible la sección para conectar
  // manualmente los tokens de cada IA (Groq, Gemini, fal.ai, OpenAI, Claude, etc.).
  const PUBLIC_APP_CONFIG = {
    DEFAULT_PROXY_URL: '',
    PUBLIC_SAAS_MODE: false,
    DEFAULT_THUMB_ENGINE: 'canvas', // 'canvas' (instantáneo $0) o 'fal' (FLUX.1 Schnell)
    APP_ACCESS_TOKEN: ''
  };

  const IS_ADMIN_OVERRIDE = /(?:^|[?&])admin=1(?:&|$)/i.test(window.location.search || '');

  function isPublicSaasMode() {
    return Boolean(PUBLIC_APP_CONFIG.PUBLIC_SAAS_MODE) && !IS_ADMIN_OVERRIDE;
  }

  function isPlaceholderProxy(url) {
    const clean = String(url || '').trim();
    return !clean || /TU-WORKER\.TU-CUENTA/i.test(clean);
  }

  function getActiveProxy(customUrl = null) {
    const candidate = customUrl !== null ? customUrl : state?.ai?.proxyUrl;
    const raw = String(candidate || '').trim().replace(/\/+$/, '');
    return isPlaceholderProxy(raw) ? '' : raw;
  }

  function getProxyHeaders() {
    const token = String(PUBLIC_APP_CONFIG.APP_ACCESS_TOKEN || '').trim();
    return token ? { 'X-App-Token': token } : {};
  }

  // ==================== ALMACENAMIENTO SEGURO ====================
  function safeGet(key, fallback = null) {
    try {
      const val = window.localStorage.getItem(key);
      return val !== null ? val : fallback;
    } catch (_) {
      return fallback;
    }
  }
  function safeSet(key, val) {
    try { window.localStorage.setItem(key, val); } catch (_) {}
  }

  // ==================== FETCH CON BACKOFF EXPONENCIAL ====================
  async function fetchWithBackoff(url, options, maxRetries = 2) {
    let delay = 800;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      return res;
    }
    throw new Error('Error de red al conectar con el servidor');
  }

  // ==================== PRESETS MULTI-IA + STACK OPTIMIZADO ====================
  const AI_PROVIDERS = {
    gemini: {
      name: 'Google Gemini (Flash-Lite Optimizado)',
      short: 'Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      defaultModel: 'gemini-flash-lite-latest',
      models: ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.5-flash'],
      vision: true,
      portal: 'https://aistudio.google.com/apikey',
      placeholder: 'AIzaSy... (clave de Google AI Studio)'
    },
    openai: {
      name: 'OpenAI (ChatGPT)',
      short: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      defaultModel: 'gpt-4o-mini',
      models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
      vision: true,
      portal: 'https://platform.openai.com/api-keys',
      placeholder: 'sk-proj-...'
    },
    openrouter: {
      name: 'OpenRouter',
      short: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
      defaultModel: 'google/gemini-2.5-flash-lite',
      models: ['google/gemini-2.5-flash-lite', 'openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'deepseek/deepseek-chat'],
      vision: true,
      portal: 'https://openrouter.ai/keys',
      placeholder: 'sk-or-v1-...'
    },
    anthropic: {
      name: 'Anthropic Claude',
      short: 'Claude',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      defaultModel: 'claude-3-5-haiku-latest',
      models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest'],
      vision: true,
      portal: 'https://console.anthropic.com/settings/keys',
      placeholder: 'sk-ant-...'
    },
    groq: {
      name: 'Groq',
      short: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
      defaultModel: 'llama-3.3-70b-versatile',
      models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
      vision: false,
      portal: 'https://console.groq.com/keys',
      placeholder: 'gsk_...'
    },
    deepseek: {
      name: 'DeepSeek',
      short: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/chat/completions',
      defaultModel: 'deepseek-chat',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      vision: false,
      portal: 'https://platform.deepseek.com/api_keys',
      placeholder: 'sk-...'
    },
    xai: {
      name: 'xAI (Grok)',
      short: 'Grok',
      baseUrl: 'https://api.x.ai/v1/chat/completions',
      defaultModel: 'grok-2-latest',
      models: ['grok-2-latest', 'grok-2-vision-1212'],
      vision: true,
      portal: 'https://console.x.ai/',
      placeholder: 'xai-...'
    },
    custom: {
      name: 'Personalizada (OpenAI / Ollama)',
      short: 'Custom IA',
      baseUrl: 'http://localhost:11434/v1/chat/completions',
      defaultModel: 'llama3.2',
      models: ['llama3.2', 'qwen2.5', 'mistral'],
      vision: false,
      portal: 'https://ollama.com',
      placeholder: 'Opcional para API local o token personalizado'
    }
  };

  function isRetiredGeminiModel(name) {
    return /^(models\/)?gemini-(1\.0|1\.5|2\.0|2\.5-flash(?!-))/i.test(String(name || '').trim());
  }

  /**
   * Carga la configuración persistida del Stack Optimizado (Groq + Gemini 2.5 Flash-Lite + fal.ai + Proxy)
   * manteniendo retrocompatibilidad con configuraciones previas.
   */
  function loadAiConfig() {
    const defaultProxy = isPlaceholderProxy(PUBLIC_APP_CONFIG.DEFAULT_PROXY_URL)
      ? ''
      : PUBLIC_APP_CONFIG.DEFAULT_PROXY_URL.trim().replace(/\/+$/, '');

    const defaults = {
      provider: 'gemini',
      apiKey: isPublicSaasMode() ? '' : safeGet('cliphub_gemini_key', ''),
      model: 'gemini-flash-lite-latest',
      baseUrl: AI_PROVIDERS.gemini.baseUrl,
      groqKey: '',
      falKey: '',
      thumbEngine: PUBLIC_APP_CONFIG.DEFAULT_THUMB_ENGINE || 'canvas',
      proxyUrl: defaultProxy
    };
    try {
      const saved = JSON.parse(safeGet('cliphub_ai_config', 'null'));
      if (saved && typeof saved === 'object') {
        const merged = { ...defaults, ...saved };
        if (!AI_PROVIDERS[merged.provider]) merged.provider = 'gemini';
        if (merged.provider === 'gemini' && (!merged.model || isRetiredGeminiModel(merged.model))) {
          merged.model = 'gemini-flash-lite-latest';
        }
        // En modo SaaS público forzamos el uso exclusivo del Proxy del servidor y nunca claves cliente
        if (isPublicSaasMode()) {
          merged.provider = 'gemini';
          merged.model = 'gemini-flash-lite-latest';
          merged.apiKey = '';
          merged.groqKey = '';
          merged.falKey = '';
          merged.proxyUrl = defaultProxy;
          if (merged.thumbEngine === 'provider') {
            merged.thumbEngine = PUBLIC_APP_CONFIG.DEFAULT_THUMB_ENGINE || 'canvas';
          }
        } else if (!merged.proxyUrl && defaultProxy) {
          merged.proxyUrl = defaultProxy;
        }
        return merged;
      }
    } catch (_) {}
    return defaults;
  }

  const DEFAULT_ACCOUNTS = {
    youtube: { name: 'YouTube', icon: '▶️', portal: 'https://console.cloud.google.com/apis/credentials', studioUrl: 'https://studio.youtube.com', connected: false, mode: 'token', handle: '', channelId: '', token: '', clientId: '', webhookUrl: '', webhookSecret: '', loginUser: '', profileUrl: '', verified: false },
    instagram: { name: 'Instagram', icon: '📸', portal: 'https://developers.facebook.com/apps/', studioUrl: 'https://business.facebook.com/latest/home', connected: false, mode: 'token', handle: '', channelId: '', token: '', clientId: '', webhookUrl: '', webhookSecret: '', loginUser: '', profileUrl: '', verified: false },
    tiktok: { name: 'TikTok', icon: '🎵', portal: 'https://developers.tiktok.com/', studioUrl: 'https://www.tiktok.com/creator-center/upload', connected: false, mode: 'token', handle: '', channelId: '', token: '', clientId: '', webhookUrl: '', webhookSecret: '', loginUser: '', profileUrl: '', verified: false },
    facebook: { name: 'Facebook Reels', icon: '📘', portal: 'https://developers.facebook.com/apps/', studioUrl: 'https://business.facebook.com/latest/home', connected: false, mode: 'token', handle: '', channelId: '', token: '', clientId: '', webhookUrl: '', webhookSecret: '', loginUser: '', profileUrl: '', verified: false },
    x: { name: 'X (Twitter)', icon: '𝕏', portal: 'https://developer.x.com/en/portal/dashboard', studioUrl: 'https://x.com/compose/post', connected: false, mode: 'token', handle: '', channelId: '', token: '', clientId: '', webhookUrl: '', webhookSecret: '', loginUser: '', profileUrl: '', verified: false }
  };

  function loadAccounts() {
    let saved = {};
    try { saved = JSON.parse(safeGet('cliphub_accounts', '{}')) || {}; } catch (_) {}
    const merged = {};
    for (const [k, def] of Object.entries(DEFAULT_ACCOUNTS)) {
      merged[k] = { ...def, ...(saved[k] || {}) };
    }
    return merged;
  }

  function loadSchedule() {
    try { return JSON.parse(safeGet('cliphub_schedule', '[]')) || []; }
    catch (_) { return []; }
  }

  // ==================== ESTADO GLOBAL ====================
  const state = {
    ai: loadAiConfig(),
    activeTab: 'studio',
    isAnalyzing: false,
    isExporting: false,
    videoName: 'video_demo',
    videoBlob: null,        // Archivo/Blob real para decodificar pista de audio
    transcript: null,       // { text, segments: [{start, end, text}], words: [] }
    proxyHealth: null,      // Estado devuelto por GET /health del Cloudflare Worker
    duration: 0,
    cutDuration: 45,
    frames: [],
    cuts: [],
    activeCutIdx: -1,
    startTime: 0,
    endTime: 15,
    loopCut: true,
    aspect: '9:16',
    subStyle: 'word',
    showSubs: true,
    subtitles: [],
    pngImg: null,
    pngProcessed: null,
    draggingPng: false,
    draggingTimeline: false,
    thumbnails: [],
    creativeSeed: Math.floor(Math.random() * 9000),
    edit: {
      speed: 1,
      volume: 1,
      muted: false,
      zoom: 1,
      panX: 0,
      panY: 0,
      rotation: 0,
      flipX: false,
      filterPreset: 'none',
      brightness: 100,
      contrast: 100,
      saturate: 100,
      grayscale: 0,
      sepia: 0,
      showHook: false,
      hookText: '',
      hookColor: '#f59e0b',
      watermark: '',
      watermarkPos: 'tr',
      watermarkOpacity: 0.75
    },
    accounts: loadAccounts(),
    schedule: loadSchedule()
  };

  const video = $('sourceVideo');
  const canvas = $('previewCanvas');
  const ctx = canvas.getContext('2d');
  const editorCanvas = $('editorCanvas');
  const editorCtx = editorCanvas.getContext('2d');

  // ==================== TOAST, CAJAS Y PORTAPAPELES (SIN ALERT) ====================
  let toastTimer = null;
  function showToast(msg, type = '') {
    const box = $('toastBox');
    box.textContent = msg;
    box.className = 'show' + (type ? ' ' + type : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.className = ''; }, 3600);
  }

  function showBoxMsg(elId, type, msg) {
    const el = $(elId);
    if (!el) return;
    el.textContent = msg;
    el.className = `test-box show ${type || 'info'}`;
  }

  function copyTextSafe(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch (_) {
      return false;
    }
  }

  function hasProxy() {
    return Boolean(getActiveProxy());
  }

  function isAiConfigured() {
    if (isPublicSaasMode()) return hasProxy();
    return Boolean(
      (state.ai.apiKey || '').trim() ||
      (state.ai.groqKey || '').trim() ||
      (state.ai.falKey || '').trim() ||
      hasProxy() ||
      (state.ai.provider === 'custom' && state.ai.baseUrl)
    );
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ==================== UTILIDADES DE TIEMPO Y DIBUJO ====================
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(1).padStart(4, '0');
    return `${String(m).padStart(2, '0')}:${s}`;
  }

  function drawRoundRect(c, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    c.beginPath();
    if (typeof c.roundRect === 'function') {
      c.roundRect(x, y, w, h, rad);
    } else {
      c.moveTo(x + rad, y);
      c.arcTo(x + w, y, x + w, y + h, rad);
      c.arcTo(x + w, y + h, x, y + h, rad);
      c.arcTo(x, y + h, x, y, rad);
      c.arcTo(x, y, x + w, y, rad);
      c.closePath();
    }
  }

  function setStep(num, status, text) {
    const el = $('pStep' + num);
    if (!el) return;
    const orderNum = num === 3 ? 2 : num === 2 ? 3 : num;
    el.className = 'pipe-step' + (status ? ' ' + status : '');
    $('pSub' + num).textContent = text;
    el.querySelector('.pipe-ico').textContent = status === 'done' ? '✓' : status === 'err' ? '!' : orderNum;
  }

  function refreshAiBadge() {
    if (isPublicSaasMode()) {
      const proxyReady = hasProxy();
      const online = proxyReady && (!state.proxyHealth || state.proxyHealth.status === 'ok');
      $('aiDot').className = 'dot' + (online ? ' ok' : '');
      if (!proxyReady) {
        $('aiStatusText').textContent = 'IA en Modo Local';
      } else if (state.proxyHealth?.status === 'ok') {
        $('aiStatusText').textContent = 'IA Cloud Activa';
      } else if (state.proxyHealth?.status === 'error') {
        $('aiStatusText').textContent = 'IA Sin Conexión';
      } else {
        $('aiStatusText').textContent = 'IA Cloud Lista';
      }
      return;
    }

    const ok = isAiConfigured();
    $('aiDot').className = 'dot' + (ok ? ' ok' : '');
    if (hasProxy()) {
      $('aiStatusText').textContent = 'Proxy Pro Activo';
      return;
    }
    const activeParts = [];
    if ((state.ai.groqKey || '').trim()) activeParts.push('Whisper');
    if ((state.ai.apiKey || '').trim()) activeParts.push((AI_PROVIDERS[state.ai.provider] || AI_PROVIDERS.gemini).short);
    if ((state.ai.falKey || '').trim() && state.ai.thumbEngine === 'fal') activeParts.push('FLUX');
    $('aiStatusText').textContent = activeParts.length ? activeParts.join(' + ') : (ok ? 'IA Conectada' : 'Configurar IA');
    updateManualApiPills();
  }

  /**
   * Actualiza los indicadores visibles de la barra de conexión manual en el Estudio.
   */
  function updateManualApiPills() {
    const groqEl = $('pillGroq');
    const llmEl = $('pillLlm');
    const thumbEl = $('pillThumb');
    if (!groqEl || !llmEl || !thumbEl) return;

    const proxyActive = hasProxy();
    const hasGroq = Boolean((state.ai.groqKey || '').trim()) || proxyActive;
    const hasLlm = Boolean((state.ai.apiKey || '').trim()) || proxyActive || (state.ai.provider === 'custom' && Boolean((state.ai.baseUrl || '').trim()));
    const provShort = (AI_PROVIDERS[state.ai.provider] || AI_PROVIDERS.gemini).short;

    groqEl.textContent = hasGroq
      ? (proxyActive ? '🎙️ Groq Whisper: Vía Proxy' : '🎙️ Groq Whisper: Conectado')
      : '🎙️ Groq Whisper: Sin conectar';
    groqEl.className = 'api-pill' + (hasGroq ? ' ok' : '');

    llmEl.textContent = hasLlm
      ? (proxyActive ? '✂️ Gemini Flash-Lite: Vía Proxy' : `✂️ ${provShort}: Conectado`)
      : `✂️ ${provShort}: Sin conectar`;
    llmEl.className = 'api-pill' + (hasLlm ? ' ok' : '');

    if (state.ai.thumbEngine === 'fal') {
      const hasFal = Boolean((state.ai.falKey || '').trim()) || proxyActive;
      thumbEl.textContent = hasFal ? '🖼️ Miniaturas: FLUX.1 Conectado' : '🖼️ Miniaturas: FLUX (Falta Token)';
      thumbEl.className = 'api-pill' + (hasFal ? ' ok' : '');
    } else if (state.ai.thumbEngine === 'provider') {
      thumbEl.textContent = hasLlm ? `🖼️ Miniaturas: ${provShort}` : '🖼️ Miniaturas: Proveedor (Falta Token)';
      thumbEl.className = 'api-pill' + (hasLlm ? ' ok' : '');
    } else {
      thumbEl.textContent = '🖼️ Miniaturas: Canvas ($0)';
      thumbEl.className = 'api-pill ok';
    }
  }

  function updateCutRangeLabel() {
    const label = `Corte: ${fmtTime(state.startTime)} - ${fmtTime(state.endTime)} (${Math.max(0.5, state.endTime - state.startTime).toFixed(1)}s)`;
    $('cutRangeLabel').textContent = label;
    $('edCutRangeLabel').textContent = label;
    updateTimelineUI();
  }

  function syncPlayButtons() {
    const txt = video.paused ? '▶ Reproducir' : '⏸ Pausar';
    $('playPauseBtn').textContent = txt;
    $('edPlayPauseBtn').textContent = txt;
  }

  function syncLoopButtons() {
    const color = state.loopCut ? 'var(--green)' : 'var(--border)';
    $('loopCutBtn').style.borderColor = color;
    $('edLoopCutBtn').style.borderColor = color;
  }

  function applyAspectRatio(val) {
    state.aspect = val;
    $('aspectSelect').value = val;
    $('edAspectSelect').value = val;
    const dims = val === '16:9' ? { w: 960, h: 540, cls: 'landscape' }
      : val === '1:1' ? { w: 720, h: 720, cls: 'square' }
      : { w: 540, h: 960, cls: '' };
    [canvas, editorCanvas].forEach(el => {
      el.width = dims.w;
      el.height = dims.h;
      el.classList.remove('landscape', 'square');
      if (dims.cls) el.classList.add(dims.cls);
    });
  }

  function updateTimelineUI() {
    const dur = Math.max(0.1, state.duration || 15);
    const startPct = Math.max(0, Math.min(100, (state.startTime / dur) * 100));
    const endPct = Math.max(startPct, Math.min(100, (state.endTime / dur) * 100));
    const nowPct = Math.max(0, Math.min(100, ((video.currentTime || 0) / dur) * 100));
    $('timelineSelection').style.left = `${startPct}%`;
    $('timelineSelection').style.width = `${Math.max(1, endPct - startPct)}%`;
    $('timelinePlayhead').style.left = `${nowPct}%`;
  }

  // ==================== NAVEGACIÓN ====================
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      state.activeTab = btn.dataset.tab;
      $('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  $('openEditorFromStudioBtn').addEventListener('click', () => {
    document.querySelector('[data-tab="editor"]').click();
  });

  // ==================== BANCO CREATIVO DINÁMICO (RESPALDO LOCAL) ====================
  const CREATIVE_PACKS = [
    {
      title: 'El giro inesperado que cambia toda la historia',
      hook: '¡MIRA ESTE GIRO!',
      badge: 'MOMENTO CLAVE',
      lines: [
        'Quédate hasta el final porque aquí pasa algo increíble',
        'Fíjate en este detalle que casi todos pasan por alto',
        'Justo en este segundo toda la escena cambia por completo',
        '¿Tú también lo notaste? Cuéntamelo en los comentarios'
      ]
    },
    {
      title: 'Nadie esperaba lo que ocurre en este segundo',
      hook: 'NO LO CREERÁS',
      badge: 'ALTO IMPACTO',
      lines: [
        'No parpadees durante los próximos segundos del clip',
        'Todo lo que vino antes llevaba directo a este instante',
        'Mira cómo cambia el ritmo en menos de tres segundos',
        'Guarda este video para verlo de nuevo más tarde'
      ]
    },
    {
      title: 'El detalle oculto que explica todo el video',
      hook: 'EL SECRETO OCULTO',
      badge: 'VIRAL 98%',
      lines: [
        'Al principio parece una toma tranquila, pero espera...',
        'Aquí es donde la tensión sube al máximo nivel',
        'Ese pequeño movimiento lo transforma absolutamente todo',
        'Comparte esto con alguien que necesite verlo hoy'
      ]
    },
    {
      title: 'La escena más intensa resumida al instante',
      hook: '¡BRUTAL FINAL! 🔥',
      badge: 'RETENCIÓN TOP',
      lines: [
        'Esto es lo que separa un clip normal de uno viral',
        'Observa la precisión y el color en cada cuadro',
        'Ese remate final hace que quieras verlo en bucle',
        '¿Del 1 al 10 qué puntuación le das a este momento?'
      ]
    },
    {
      title: 'Por qué todos están hablando de esta toma',
      hook: '¡IMPOSIBLE VERLO SOLO 1 VEZ!',
      badge: 'TENDENCIA',
      lines: [
        'Arranca con fuerza desde el primer segundo sin pausas',
        'Mantén los ojos en el centro de la pantalla ahora',
        'La reacción aquí es simplemente espectacular',
        'Suscríbete si quieres ver la segunda parte muy pronto'
      ]
    },
    {
      title: 'El clímax exacto que dispara la audiencia',
      hook: 'PASÓ ESTO EN VIVO',
      badge: 'EXCLUSIVO',
      lines: [
        'Este instante vale oro para tus Shorts y Reels',
        'Muchos intentan lograr este efecto pero pocos lo consiguen',
        'El contraste entre el inicio y el cierre atrapa al instante',
        'Dale like y comenta qué parte te sorprendió más'
      ]
    }
  ];

  function getUniqueCreativePack(seedIndex) {
    const idx = Math.abs(Math.floor(seedIndex)) % CREATIVE_PACKS.length;
    const pack = CREATIVE_PACKS[idx];
    return {
      title: pack.title,
      hook: pack.hook,
      badge: pack.badge,
      lines: [...pack.lines]
    };
  }

  function buildSmartCutsFallback() {
    const d = Math.max(3, state.duration || 15);
    const desiredLen = Math.min(d, Math.max(3, state.cutDuration || 15));
    const maxStart = Math.max(0, d - desiredLen);
    const starts = [
      0,
      Number((maxStart * 0.5).toFixed(1)),
      Number(maxStart.toFixed(1))
    ];
    const shortMode = maxStart < 0.8;
    const seg = d / 3;

    return [0, 1, 2].map(i => {
      const pack = getUniqueCreativePack(state.creativeSeed + i * 2);
      const s = shortMode ? Number((i * seg).toFixed(1)) : starts[i];
      const e = shortMode
        ? Number(Math.min(d, (i + 1) * seg).toFixed(1))
        : Number(Math.min(d, s + desiredLen).toFixed(1));
      const realEnd = e > s + 0.5 ? e : d;
      const frameIdx = Math.min(Math.max(0, state.frames.length - 1), i === 0 ? 0 : i === 1 ? 2 : 4);
      const realSubs = state.transcript?.segments?.length
        ? state.transcript.segments.filter(item => item.end >= s && item.start <= realEnd)
        : [];
      return {
        title: pack.title,
        hookText: pack.hook,
        badge: pack.badge,
        score: 97 - i * 2,
        start: s,
        end: realEnd,
        frameIdx,
        lines: realSubs.length ? realSubs.map(x => x.text.trim()).filter(Boolean) : pack.lines,
        timedSegments: realSubs.map(x => ({
          start: Math.max(s, Number(x.start)),
          end: Math.min(realEnd, Number(x.end)),
          text: x.text.trim()
        })),
        thumbnailPrompt: ''
      };
    });
  }

  // ==================== SELECTOR DE SEGUNDOS POR CORTE ====================
  function setCutDuration(secs, applyToCurrent = true) {
    const clean = Math.max(3, Math.min(300, Math.round(Number(secs) || 15)));
    state.cutDuration = clean;
    $('cutDurationInput').value = clean;
    document.querySelectorAll('.dur-pill').forEach(p => {
      p.classList.toggle('active', Number(p.dataset.dur) === clean);
    });
    if (applyToCurrent && state.duration > 0) {
      const targetEnd = Math.min(state.duration, state.startTime + clean);
      state.endTime = targetEnd > state.startTime + 0.5 ? targetEnd : state.duration;
      $('endInput').value = state.endTime.toFixed(1);
      if (state.activeCutIdx >= 0 && state.cuts[state.activeCutIdx]) {
        state.cuts[state.activeCutIdx].end = state.endTime;
        state.subtitles = buildTimedSubtitles(state.cuts[state.activeCutIdx].lines, state.startTime, state.endTime);
        renderCutsList();
      } else if (state.subtitles.length) {
        state.subtitles = buildTimedSubtitles(state.subtitles.map(s => s.text), state.startTime, state.endTime);
      }
      updateCutRangeLabel();
    }
  }

  document.querySelectorAll('.dur-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      setCutDuration(Number(pill.dataset.dur), true);
      showToast(`Duración de cortes ajustada a ${state.cutDuration}s`, 'ok');
    });
  });

  $('applyCutDurationBtn').addEventListener('click', () => {
    setCutDuration($('cutDurationInput').value, true);
    showToast(`Duración aplicada: ${state.cutDuration} segundos por corte`, 'ok');
  });

  $('addManualCutBtn').addEventListener('click', () => {
    if (!video.src) {
      showToast('Primero sube un video o carga el demo', 'warn');
      return;
    }
    const start = Number(Math.max(0, Math.min(Math.max(0, state.duration - 1), video.currentTime || 0)).toFixed(1));
    const end = Number(Math.min(state.duration || state.cutDuration, start + state.cutDuration).toFixed(1));
    const realEnd = end > start + 0.5 ? end : state.duration;
    const idx = state.cuts.length;
    const fresh = getUniqueCreativePack(idx + Date.now());
    const realSubs = state.transcript?.segments?.length
      ? state.transcript.segments.filter(seg => seg.end >= start && seg.start <= realEnd)
      : [];

    state.cuts.push({
      title: `Corte Manual #${idx + 1} (${fmtTime(start)})`,
      hookText: fresh.hook,
      badge: fresh.badge,
      score: 91 + (idx % 8),
      start,
      end: realEnd,
      frameIdx: Math.min(Math.max(0, state.frames.length - 1), Math.floor((start / Math.max(1, state.duration)) * Math.max(1, state.frames.length))),
      lines: realSubs.length ? realSubs.map(x => x.text.trim()).filter(Boolean) : fresh.lines,
      timedSegments: realSubs.map(x => ({
        start: Math.max(start, Number(x.start)),
        end: Math.min(realEnd, Number(x.end)),
        text: x.text.trim()
      })),
      thumbnailPrompt: ''
    });
    renderCutsList();
    loadCutIntoPlayer(idx, true);
    showToast(`Corte manual creado (${fmtTime(start)} → ${fmtTime(realEnd)})`, 'ok');
  });

  // ==================== VIDEO DEMO REAL (3 ESCENAS COLORIDAS + AUDIO) ====================
  async function generateDemoVideoBlob() {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 360;
    const g = c.getContext('2d');
    const canvasStream = c.captureStream(30);
    const tracks = [...canvasStream.getVideoTracks()];

    let audioCtx = null;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        audioCtx = new AudioCtx();
        const dest = audioCtx.createMediaStreamDestination();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(220, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(330, audioCtx.currentTime + 2);
        osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 4);
        gain.gain.setValueAtTime(0.05, audioCtx.currentTime);
        osc.connect(gain);
        gain.connect(dest);
        osc.start();
        osc.stop(audioCtx.currentTime + 4.3);
        tracks.push(...dest.stream.getAudioTracks());
      }
    } catch (_) {}

    const combined = new MediaStream(tracks);
    const mimeTypes = ['video/webm;codecs=vp8,opus', 'video/webm'];
    const chosen = mimeTypes.find(m => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));
    const rec = chosen ? new MediaRecorder(combined, { mimeType: chosen }) : new MediaRecorder(combined);
    const chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.start();

    const start = performance.now();
    const totalMs = 4200;
    await new Promise(resolve => {
      function tick(now) {
        const t = (now - start) / 1000;
        if (t < 1.4) {
          const grad = g.createLinearGradient(0, 0, 0, 360);
          grad.addColorStop(0, '#311068');
          grad.addColorStop(0.55, '#db2777');
          grad.addColorStop(1, '#f59e0b');
          g.fillStyle = grad; g.fillRect(0, 0, 640, 360);
          g.fillStyle = '#fde047';
          g.beginPath(); g.arc(320 + Math.sin(t * 2) * 50, 175, 58, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#0f172a';
          g.beginPath(); g.moveTo(0, 265); g.lineTo(180, 170); g.lineTo(360, 265); g.lineTo(520, 180); g.lineTo(640, 265); g.lineTo(640, 360); g.lineTo(0, 360); g.fill();
          g.fillStyle = 'rgba(14,165,233,0.45)'; g.fillRect(0, 265, 640, 95);
          g.fillStyle = '#fff'; g.font = '900 28px Segoe UI';
          g.fillText('ESCENA 1 • ATARDECER ÉPICO', 120, 62);
        } else if (t < 2.8) {
          const grad = g.createLinearGradient(0, 0, 640, 360);
          grad.addColorStop(0, '#020617');
          grad.addColorStop(1, '#1e1b4b');
          g.fillStyle = grad; g.fillRect(0, 0, 640, 360);
          for (let b = 0; b < 9; b++) {
            const bh = 110 + ((b * 43) % 130);
            g.fillStyle = b % 2 ? '#0f172a' : '#172554';
            g.fillRect(b * 74, 360 - bh, 64, bh);
            g.fillStyle = b % 2 ? '#38bdf8' : '#f43f5e';
            for (let wy = 360 - bh + 16; wy < 340; wy += 24) {
              g.fillRect(b * 74 + 12, wy, 14, 10);
              g.fillRect(b * 74 + 38, wy, 14, 10);
            }
          }
          g.strokeStyle = '#38bdf8'; g.lineWidth = 4;
          g.beginPath(); g.moveTo(0, 120 + Math.sin(t * 8) * 12); g.lineTo(640, 120 + Math.cos(t * 8) * 12); g.stroke();
          g.fillStyle = '#38bdf8'; g.font = '900 28px Segoe UI';
          g.fillText('ESCENA 2 • CIUDAD CYBER', 145, 62);
        } else {
          const grad = g.createRadialGradient(320, 180, 20, 320, 180, 360);
          grad.addColorStop(0, '#7c3aed');
          grad.addColorStop(0.5, '#1e1b4b');
          grad.addColorStop(1, '#020617');
          g.fillStyle = grad; g.fillRect(0, 0, 640, 360);
          for (let s = 0; s < 35; s++) {
            g.fillStyle = '#fff';
            g.fillRect((s * 97 + t * 60) % 640, (s * 53) % 360, 3, 3);
          }
          g.fillStyle = '#f59e0b';
          g.beginPath(); g.arc(320, 200, 62, 0, Math.PI * 2); g.fill();
          g.strokeStyle = '#fde047'; g.lineWidth = 6;
          g.beginPath(); g.ellipse(320, 200, 115, 28, -0.2, 0, Math.PI * 2); g.stroke();
          g.fillStyle = '#fde047'; g.font = '900 28px Segoe UI';
          g.fillText('ESCENA 3 • CLÍMAX FINAL', 145, 62);
        }

        if (now - start < totalMs) requestAnimationFrame(tick);
        else { rec.stop(); resolve(); }
      }
      requestAnimationFrame(tick);
    });
    await new Promise(r => { rec.onstop = r; });
    if (audioCtx) { try { audioCtx.close(); } catch (_) {} }
    return new Blob(chunks, { type: 'video/webm' });
  }

  // ==================== CARGA DE VIDEO ROBUSTA ====================
  let activeVideoUrl = null;
  let loadWatchdog = null;

  function loadVideoSrc(url, name, fallbackDuration = 15) {
    state.sourceCredit = '';
    if (loadWatchdog) clearTimeout(loadWatchdog);
    if (activeVideoUrl && activeVideoUrl !== url) {
      try { URL.revokeObjectURL(activeVideoUrl); } catch (_) {}
    }
    activeVideoUrl = url;
    state.videoName = (name || 'mi_video').replace(/\.[^.]+$/, '') || 'mi_video';
    state.transcript = null;
    $('pipelineMsg').textContent = `Cargando video "${state.videoName}"...`;
    setStep(1, 'run', 'Cargando archivo...');

    let handled = false;
    const onReady = async () => {
      if (handled) return;
      handled = true;
      if (loadWatchdog) clearTimeout(loadWatchdog);

      if (!isFinite(video.duration)) {
        try {
          video.currentTime = 1e101;
          await new Promise(res => { const f = () => { video.removeEventListener('timeupdate', f); res(); }; video.addEventListener('timeupdate', f); setTimeout(res, 1500); });
          video.currentTime = 0;
        } catch (_) {}
      }
      let detectedDur = video.duration;
      if (!isFinite(detectedDur) || detectedDur <= 0) {
        detectedDur = fallbackDuration;
      }
      state.duration = detectedDur;
      $('timeTotal').textContent = fmtTime(state.duration);
      $('edTimeTotal').textContent = fmtTime(state.duration);
      state.startTime = 0;
      state.endTime = Math.min(state.duration, state.cutDuration);
      $('startInput').value = state.startTime.toFixed(1);
      $('endInput').value = state.endTime.toFixed(1);
      const liveWin = pendingWindow;
      const liveSubsMeta = pendingLiveSubs;
      pendingWindow = null;
      pendingLiveSubs = null;
      if (liveWin) {
        state.startTime = Math.max(0, Math.min(liveWin.start, state.duration - 1));
        state.endTime = Math.min(state.duration, liveWin.end);
        $('startInput').value = state.startTime.toFixed(1);
        $('endInput').value = state.endTime.toFixed(1);
        try { video.currentTime = state.startTime; } catch (_) {}
        if (liveSubsMeta) {
          const segs = liveSubsMeta.subtitles || [];
          const lines = segs.length
            ? segs.map(s => s.text)
            : (liveSubsMeta.transcript ? liveSubsMeta.transcript.split(/(?<=[.!?])\s+/).filter(Boolean) : [liveSubsMeta.name]);
          if (liveSubsMeta.words && liveSubsMeta.words.length) {
            state.transcript = { text: liveSubsMeta.transcript, segments: segs, words: liveSubsMeta.words };
          }
          state.cuts = [{
            title: liveSubsMeta.name,
            hookText: liveSubsMeta.name.toUpperCase().slice(0, 26),
            badge: 'EN VIVO',
            emotion: liveSubsMeta.emotion,
            score: liveSubsMeta.score,
            reason: liveSubsMeta.reason,
            start: state.startTime,
            end: state.endTime,
            frameIdx: 0,
            lines,
            timedSegments: segs,
            thumbnailPrompt: ''
          }];
          loadCutIntoPlayer(0, false);
        }
      }
      $('seekBar').max = state.duration;
      $('seekBar').value = 0;
      updateCutRangeLabel();
      showToast(`Video "${state.videoName}" cargado (${fmtTime(state.duration)})`, 'ok');

      if (pendingRestore) {
        applyRestore();
      } else if ($('autoAnalyzeCheck').checked && !liveWin) {
        await runFullAnalysis();
      } else {
        setStep(1, 'done', 'Video cargado');
        $('pipelineMsg').textContent = 'Video listo. Pulsa "🚀 Auto-Analizar Todo (IA)" o reprodúcelo directamente.';
      }
    };

    video.onerror = () => {
      if (loadWatchdog) clearTimeout(loadWatchdog);
      setStep(1, 'err', 'Formato no compatible');
      const ve = video.error;
      $('pipelineMsg').textContent = `⚠️ No se pudo decodificar este archivo (código ${ve ? ve.code : '?'}${ve && ve.message ? ': ' + ve.message : ''}). Si es un corte de directo, cambia el "Formato" de captura (prueba MP4 o WebM VP9) y vuelve a capturar.`;
      showToast('Error al leer el archivo de video. Usa MP4 o WebM.', 'warn');
    };
    video.onloadedmetadata = () => {
      if (video.readyState >= 1) onReady();
    };
    video.onloadeddata = onReady;
    video.oncanplay = onReady;

    loadWatchdog = setTimeout(() => {
      if (!handled && video.src === url) {
        if (video.readyState >= 1 || video.videoWidth > 0) {
          onReady();
        } else {
          setStep(1, 'err', 'Tiempo agotado');
          $('pipelineMsg').textContent = '⚠️ El video tardó demasiado en decodificar. Intenta con un archivo MP4 más ligero o pulsa "✨ Cargar Video Demo".';
        }
      }
    }, 5000);

    video.pause();
    syncPlayButtons();
    video.src = url;
    video.muted = state.edit.muted;
    video.volume = state.edit.volume;
    video.playbackRate = state.edit.speed;
    video.load();
  }

  $('videoInput').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    state.videoBlob = file; // Guardar archivo original para extracción de audio WAV
    loadVideoSrc(URL.createObjectURL(file), file.name, 15);
    e.target.value = '';
  });

  $('loadDemoBtn').addEventListener('click', async () => {
    const btn = $('loadDemoBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Generando Demo...';
    try {
      $('pipelineMsg').textContent = 'Generando video demo de 3 escenas coloridas en tu navegador...';
      const blob = await generateDemoVideoBlob();
      state.videoBlob = blob; // Guardar blob demo
      loadVideoSrc(URL.createObjectURL(blob), 'historia_viral_demo', 4.2);
    } catch (err) {
      $('pipelineMsg').textContent = `⚠️ No se pudo crear el video demo: ${err.message}`;
      showToast('No se pudo generar el video demo', 'warn');
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ Cargar Video Demo';
    }
  });

  // ==================== EXTRACCIÓN SEGURA DE FOTOGRAMAS REALES ====================
  function isFrameMostlyBlack(c) {
    try {
      const g = c.getContext('2d');
      const data = g.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      const step = 4 * 20;
      for (let i = 0; i < data.length; i += step) {
        sum += data[i] + data[i + 1] + data[i + 2];
      }
      const avg = sum / (data.length / step);
      return avg < 10;
    } catch (_) {
      return false;
    }
  }

  async function seekAndCapture(t) {
    const maxT = Math.max(0.2, state.duration - 0.15);
    const target = Math.min(Math.max(0.15, t), maxT);
    await new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      video.addEventListener('seeked', finish, { once: true });
      try { video.currentTime = target; } catch (_) { finish(); }
      setTimeout(finish, 650);
    });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const c = document.createElement('canvas');
    c.width = 480; c.height = 270;
    const g = c.getContext('2d');
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      g.drawImage(video, 0, 0, c.width, c.height);
    } else {
      const gr = g.createLinearGradient(0, 0, 480, 270);
      gr.addColorStop(0, '#1e293b'); gr.addColorStop(1, '#0f172a');
      g.fillStyle = gr; g.fillRect(0, 0, 480, 270);
    }
    return { canvas: c, time: target };
  }

  async function extractRealFrames() {
    setStep(1, 'run', 'Extrayendo fotogramas...');
    const prevMuted = video.muted;
    video.muted = true;
    try { await video.play(); } catch (_) {}
    await new Promise(r => setTimeout(r, 140));
    video.pause();

    const dur = (isFinite(video.duration) && video.duration > 0) ? video.duration : (state.duration || 12);
    state.duration = dur;
    $('timeTotal').textContent = fmtTime(dur);
    $('edTimeTotal').textContent = fmtTime(dur);
    $('seekBar').max = dur;

    const ratios = [0.10, 0.30, 0.50, 0.70, 0.88];
    const results = [];

    for (let i = 0; i < ratios.length; i++) {
      let cap = await seekAndCapture(dur * ratios[i]);
      if (isFrameMostlyBlack(cap.canvas)) {
        cap = await seekAndCapture(Math.min(dur - 0.15, dur * ratios[i] + 0.45));
      }
      results.push({ time: cap.time, dataUrl: cap.canvas.toDataURL('image/jpeg', 0.86) });
    }

    video.muted = prevMuted;
    state.frames = results;

    $('framesStrip').innerHTML = results.map((f, idx) => `
      <div class="frame-box" data-frame-time="${f.time}" title="Saltar al segundo ${fmtTime(f.time)}">
        <img src="${f.dataUrl}" alt="Fotograma ${idx + 1}" />
        <span class="frame-ts">${fmtTime(f.time)}</span>
      </div>
    `).join('');

    document.querySelectorAll('#framesStrip .frame-box').forEach(el => {
      el.addEventListener('click', () => {
        const t = Number(el.dataset.frameTime);
        if (isFinite(t)) {
          video.currentTime = t;
          showToast(`Saltando a ${fmtTime(t)}`, '');
        }
      });
    });

    setStep(1, 'done', `${results.length} fotogramas reales`);
  }

  // ==================== MÓDULO 1: EXTRACCIÓN DE AUDIO WAV 16kHz + GROQ WHISPER ====================

  /**
   * Codifica un arreglo Float32Array PCM mono en un Blob WAV de 16 bits.
   */
  function encodeWav16Bit(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  /**
   * Extrae la pista de audio del video en el navegador, la convierte a mono 16 kHz
   * y la divide automáticamente en bloques seguros (< 20 MB, 10 min) si el video es muy largo.
   */
  async function extractMonoAudioChunks(videoBlob) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('Web Audio API no soportada en este navegador.');
    const ctxAudio = new AudioCtx();
    try {
      if (videoBlob.size > 1.5 * 1024 * 1024 * 1024) {
        throw new Error('el archivo supera 1.5 GB y no se puede extraer el audio en el navegador');
      }
      const arrayBuf = await videoBlob.arrayBuffer();
      const decoded = await ctxAudio.decodeAudioData(arrayBuf);
      const targetRate = 16000;
      const frameCount = Math.max(1, Math.ceil(decoded.duration * targetRate));
      const offline = new OfflineAudioContext(1, frameCount, targetRate);
      const src = offline.createBufferSource();
      src.buffer = decoded;
      src.connect(offline.destination);
      src.start(0);
      const rendered = await offline.startRendering();
      const channelData = rendered.getChannelData(0);

      // Cada 10 minutos a 16 kHz 16-bit mono ≈ 19.2 MB (bajo el límite de 25 MB de Groq)
      const chunkSec = 600;
      const samplesPerChunk = chunkSec * targetRate;
      const chunks = [];
      for (let startSample = 0; startSample < channelData.length; startSample += samplesPerChunk) {
        const slice = channelData.subarray(startSample, Math.min(channelData.length, startSample + samplesPerChunk));
        chunks.push({
          offsetSec: startSample / targetRate,
          wavBlob: encodeWav16Bit(slice, targetRate)
        });
      }
      return chunks;
    } finally {
      await ctxAudio.close().catch(() => {});
    }
  }

  /**
   * Envía un bloque WAV ligero a Groq Whisper (`whisper-large-v3-turbo`, $0.04 USD/h)
   * o al Proxy URL configurado, devolviendo transcripción con marcas de tiempo exactas.
   */
  async function transcribeWavChunkWithGroq(mediaBlob, filename = 'audio.wav') {
    const groqKey = (state.ai.groqKey || '').trim();
    const proxy = getActiveProxy();
    if (!groqKey && !proxy) return null;

    if (mediaBlob.size > 24 * 1024 * 1024) {
      throw new Error('El archivo de audio/video excede 24 MB.');
    }

    const form = new FormData();
    form.append('file', mediaBlob, filename);
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    form.append('timestamp_granularities[]', 'word');

    const endpoint = proxy
      ? `${proxy}/api/transcribe`
      : 'https://api.groq.com/openai/v1/audio/transcriptions';
    const headers = proxy ? getProxyHeaders() : { Authorization: `Bearer ${groqKey}` };

    const res = await fetchWithBackoff(endpoint, {
      method: 'POST',
      headers,
      body: form
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `Groq HTTP ${res.status}`);
    }
    return {
      text: data.text || '',
      segments: Array.isArray(data.segments) ? data.segments : [],
      words: Array.isArray(data.words) ? data.words : []
    };
  }

  /**
   * Transcribe todos los bloques de audio y unifica los timestamps con el desplazamiento real.
   * Si Chrome no puede decodificar WebM con decodeAudioData, envía el clip directo a Groq Whisper (nativo).
   */
  async function transcribeVideoWithGroqWhisper(videoBlob) {
    let chunks = null;
    try {
      chunks = await extractMonoAudioChunks(videoBlob);
    } catch (decodeErr) {
      console.warn('extractMonoAudioChunks falló, enviando blob directo a Groq Whisper:', decodeErr);
      if (videoBlob && videoBlob.size <= 24 * 1024 * 1024) {
        const mime = String(videoBlob.type || '').toLowerCase();
        const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm';
        const direct = await transcribeWavChunkWithGroq(videoBlob, `clip.${ext}`);
        if (direct) {
          return {
            text: direct.text || '',
            segments: (direct.segments || []).map(seg => ({
              start: Number(seg.start || 0),
              end: Number(seg.end || 0),
              text: String(seg.text || '').trim()
            })).filter(s => s.text),
            words: (direct.words || []).map(w => ({
              start: Number(w.start || 0),
              end: Number(w.end || 0),
              word: String(w.word || '')
            }))
          };
        }
      }
      throw decodeErr;
    }

    const fullTextParts = [];
    const allSegments = [];
    const allWords = [];

    for (let i = 0; i < chunks.length; i++) {
      if (chunks.length > 1) {
        setStep(3, 'run', `Transcribiendo parte ${i + 1}/${chunks.length}...`);
      }
      const part = await transcribeWavChunkWithGroq(chunks[i].wavBlob, 'audio.wav');
      if (!part) continue;
      if (part.text) fullTextParts.push(part.text.trim());
      const off = chunks[i].offsetSec;
      part.segments.forEach(seg => {
        const cleanText = String(seg.text || '').trim();
        if (!cleanText) return;
        allSegments.push({
          start: Number(seg.start || 0) + off,
          end: Number(seg.end || 0) + off,
          text: cleanText
        });
      });
      part.words.forEach(w => {
        allWords.push({
          start: Number(w.start || 0) + off,
          end: Number(w.end || 0) + off,
          word: String(w.word || '')
        });
      });
    }

    return {
      text: fullTextParts.join(' '),
      segments: allSegments,
      words: allWords
    };
  }

  // ==================== MOTOR MULTI-IA (SOLO TEXTO / RESPALDO) ====================
  async function discoverGeminiModels(apiKey, baseUrl = 'https://generativelanguage.googleapis.com/v1beta') {
    const cleanBase = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const res = await fetch(`${cleanBase}/models?key=${encodeURIComponent(apiKey || '')}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
    const all = (json.models || [])
      .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''))
      .filter(name => name && !isRetiredGeminiModel(name));

    const imageModels = all.filter(n => /image/i.test(n));
    const textModels = all.filter(n => /gemini/i.test(n) && !/image|tts|audio|embedding|live/i.test(n));
    textModels.sort((a, b) => {
      const score = x => (/flash-lite/i.test(x) ? 30 : /flash/i.test(x) ? 15 : 0) + (/gemini-2\.5/i.test(x) ? 20 : /gemini-3/i.test(x) ? 10 : 0);
      return score(b) - score(a);
    });
    return { textModels, imageModels, all };
  }

  async function callConfiguredAI(prompt, frameBase64List = [], cfgOverride = null, forceJson = false) {
    const cfg = cfgOverride || state.ai;
    const provider = cfg.provider || 'gemini';
    const meta = AI_PROVIDERS[provider] || AI_PROVIDERS.custom;
    let model = (cfg.model || meta.defaultModel).trim().replace(/^models\//, '');
    const apiKey = (cfg.apiKey || '').trim();
    const baseUrl = (cfg.baseUrl || meta.baseUrl).trim();
    const proxy = getActiveProxy(cfg.proxyUrl !== undefined ? cfg.proxyUrl : state.ai.proxyUrl);

    // Si hay Proxy configurado y usamos Gemini, enrutar por /api/analyze-cuts
    if (proxy && provider === 'gemini') {
      const res = await fetchWithBackoff(`${proxy}/api/analyze-cuts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getProxyHeaders() },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: forceJson
            ? { responseMimeType: 'application/json', temperature: 0.4 }
            : { temperature: 0.7 }
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message || `Proxy HTTP ${res.status}`);
      return json?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || json?.text || '';
    }

    if (provider === 'gemini') {
      const cleanBase = baseUrl.replace(/\/+$/, '');
      if (isRetiredGeminiModel(model)) model = 'gemini-flash-lite-latest';
      const parts = [{ text: prompt }];
      frameBase64List.forEach(b64 => {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
      });

      const candidateModels = [...new Set([model, 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-flash-latest'])];
      let lastErr = 'Error desconocido en Gemini';

      const tryGeminiModel = async (mName) => {
        const url = `${cleanBase}/models/${encodeURIComponent(mName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const payload = {
          contents: [{ parts }],
          generationConfig: forceJson
            ? { responseMimeType: 'application/json', temperature: 0.4 }
            : { temperature: 0.7 }
        };
        const res = await fetchWithBackoff(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok) {
          return {
            ok: true,
            text: json?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '',
            modelUsed: mName
          };
        }
        return { ok: false, status: res.status, message: json?.error?.message || `HTTP ${res.status}` };
      };

      for (const m of candidateModels) {
        const attempt = await tryGeminiModel(m);
        if (attempt.ok) {
          if (cfgOverride) cfgOverride.model = attempt.modelUsed;
          return attempt.text;
        }
        lastErr = attempt.message;
        if (attempt.status === 401 || /API key not valid/i.test(lastErr)) break;
      }

      if (apiKey && /not found|no longer available|not supported|404/i.test(lastErr)) {
        try {
          const found = await discoverGeminiModels(apiKey, cleanBase);
          for (const discovered of found.textModels.slice(0, 3)) {
            if (candidateModels.includes(discovered)) continue;
            const retry = await tryGeminiModel(discovered);
            if (retry.ok) {
              if (cfgOverride) cfgOverride.model = retry.modelUsed;
              state.ai.model = retry.modelUsed;
              safeSet('cliphub_ai_config', JSON.stringify(state.ai));
              return retry.text;
            }
            lastErr = retry.message;
          }
        } catch (_) {}
      }

      if (!apiKey && /API key|403|401|unregistered/i.test(lastErr)) {
        throw new Error('Pega tu API Key de Google AI Studio en "Configurar IA".');
      }
      throw new Error(lastErr);
    }

    if (provider === 'anthropic') {
      if (!apiKey) throw new Error('Falta API Key de Anthropic');
      const content = [{ type: 'text', text: prompt }];
      const res = await fetchWithBackoff(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content }] })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
      return json?.content?.map(c => c.text || '').join('') || '';
    }

    // Proveedores compatibles con OpenAI (solo texto para máximo ahorro)
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = window.location.origin || 'https://cliphub.studio';
      headers['X-Title'] = 'ClipHub Studio Pro';
    }

    const bodyObj = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: forceJson ? 0.4 : 0.75
    };
    if (forceJson && (provider === 'openai' || provider === 'groq')) {
      bodyObj.response_format = { type: 'json_object' };
    }

    const res = await fetchWithBackoff(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyObj)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || json?.message || `HTTP ${res.status}`);
    return json?.choices?.[0]?.message?.content || '';
  }

  // ==================== MÓDULO 2: CORTES EMOCIONANTES (SOLO TEXTO -> GEMINI 2.5 FLASH-LITE) ====================
  async function askAIForCuts() {
    const canCall = Boolean((state.ai.apiKey || '').trim() || hasProxy() || (state.ai.provider === 'custom' && state.ai.baseUrl));
    if (!canCall) return null;

    try {
      const hasTranscript = Boolean(state.transcript?.segments?.length);
      const transcriptLines = hasTranscript
        ? state.transcript.segments
            .map(s => `[${Number(s.start).toFixed(1)}s-${Number(s.end).toFixed(1)}s] ${s.text.trim()}`)
            .join('\n')
        : `Video sin transcripción de audio: "${state.videoName}" (duración ${state.duration.toFixed(1)}s).`;

      const activeEmos = getSelectedEmotionsText();
      const prompt = `Eres editor experto en retención para YouTube Shorts, Instagram Reels y TikTok.
Analiza la siguiente información y elige los 3 momentos más ÉPICOS y virales (aprox. ${state.cutDuration}s cada uno, dentro del rango 0s a ${state.duration.toFixed(1)}s), priorizando específicamente estas emociones: ${activeEmos}.

TRANSCRIPCIÓN CON MARCAS DE TIEMPO:
${transcriptLines.slice(0, 28000)}

Responde ÚNICAMENTE con un JSON válido (sin texto adicional ni bloques markdown) con esta estructura exacta:
{
  "cuts": [
    {
      "title": "Título viral en español",
      "hookText": "2 A 4 PALABRAS IMPACTO",
      "badge": "ETIQUETA CORTA",
      "emotion": "${EMOTION_KEYS_STR}",
      "score": 95,
      "start": 0.0,
      "end": 15.0,
      "reason": "Por qué este momento atrapa a la audiencia",
      "thumbnailPrompt": "Concise English visual prompt describing a dramatic 16:9 YouTube thumbnail scene for this clip"
    }
  ]
}`;

      // IMPORTANTE: Se envía [] (cero imágenes base64, cero video crudo) para ahorrar >90% en tokens
      const raw = await callConfiguredAI(prompt, [], null, true);
      const cleaned = raw.replace(/`{3}json|`{3}/gi, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);

      if (!Array.isArray(parsed.cuts) || !parsed.cuts.length) return null;

      return parsed.cuts.slice(0, 3).map((c, i) => {
        const fallbackPack = getUniqueCreativePack(state.creativeSeed + i);
        const maxStart = Math.max(0, (state.duration || 15) - 0.8);
        const s = Math.max(0, Math.min(maxStart, Number(c.start) || 0));
        const rawEnd = Number(c.end) || (s + state.cutDuration);
        const e = Math.max(s + 0.8, Math.min(state.duration || 15, rawEnd));

        // Sincronizar las frases reales transcritas por Groq Whisper que caen dentro del corte
        const realSubs = hasTranscript
          ? state.transcript.segments.filter(seg => seg.end >= s && seg.start <= e)
          : [];
        const lines = realSubs.length
          ? realSubs.map(seg => seg.text.trim()).filter(Boolean)
          : (Array.isArray(c.lines) && c.lines.length ? c.lines.map(String) : fallbackPack.lines);

        const frameIdx = Math.min(
          Math.max(0, state.frames.length - 1),
          Math.floor((s / Math.max(1, state.duration)) * Math.max(1, state.frames.length))
        );

        return {
          title: String(c.title || fallbackPack.title),
          hookText: String(c.hookText || fallbackPack.hook).toUpperCase().slice(0, 28),
          badge: String(c.badge || fallbackPack.badge).toUpperCase().slice(0, 18),
          emotion: normalizeEmotion(c.emotion),
          score: Math.min(99, Math.max(80, Number(c.score) || (96 - i * 2))),
          reason: String(c.reason || ''),
          start: Number(s.toFixed(1)),
          end: Number(e.toFixed(1)),
          frameIdx,
          lines,
          timedSegments: realSubs.map(seg => ({
            start: Math.max(s, Number(seg.start)),
            end: Math.min(e, Number(seg.end)),
            text: seg.text.trim()
          })),
          thumbnailPrompt: String(c.thumbnailPrompt || '')
        };
      });
    } catch (err) {
      console.warn('askAIForCuts fallback:', err);
      return null;
    }
  }

  // ==================== SUBTÍTULOS EN TODO EL CORTE ====================
  function buildTimedSubtitles(lines, start, end) {
    const clean = (lines || []).map(l => String(l).trim()).filter(Boolean);
    if (!clean.length) return [];
    const span = Math.max(0.8, end - start);
    const step = span / clean.length;
    return clean.map((text, idx) => ({
      start: start + idx * step,
      end: start + (idx + 1) * step,
      text
    }));
  }

  function loadCutIntoPlayer(idx, autoPlay = true) {
    const cut = state.cuts[idx];
    if (!cut) return;
    state.activeCutIdx = idx;
    state.startTime = Math.max(0, cut.start);
    state.endTime = cut.end > cut.start + 0.4 ? cut.end : (state.duration || 15);
    $('startInput').value = state.startTime.toFixed(1);
    $('endInput').value = state.endTime.toFixed(1);
    $('subsTextarea').value = (cut.lines || []).join('\n');

    // Priorizar marcas de tiempo exactas de Groq Whisper cuando existan
    const hasWhisperTiming = Array.isArray(cut.timedSegments) && cut.timedSegments.length > 0;
    state.subtitles = hasWhisperTiming
      ? cut.timedSegments
      : buildTimedSubtitles(cut.lines, state.startTime, state.endTime);

    const badge = $('subsSourceBadge');
    if (badge) {
      badge.textContent = hasWhisperTiming ? '🎙️ Whisper Real' : '✍️ Sincronizado Local';
      badge.className = hasWhisperTiming ? 'badge green' : 'badge';
    }

    if (!state.edit.hookText) {
      $('edHookInput').value = cut.hookText;
      state.edit.hookText = cut.hookText;
    }

    updateCutRangeLabel();
    renderCutsList();

    if (video.src) {
      video.currentTime = state.startTime;
      if (autoPlay) {
        video.play().then(syncPlayButtons).catch(syncPlayButtons);
      }
    }
  }

  function renderCutsList() {
    if (!state.cuts.length) {
      $('cutsContainer').innerHTML = '<div class="muted">Aún no hay cortes generados. Sube un video o pulsa "✨ Cargar Video Demo".</div>';
      return;
    }
    $('cutsContainer').innerHTML = state.cuts.map((c, i) => `
      <div class="cut-item ${i === state.activeCutIdx ? 'active' : ''}" data-cut="${i}">
        <div class="row" style="justify-content:space-between; margin-bottom:4px;">
          <strong>#${i + 1} ${escapeHtml(c.title)}</strong>
          <div class="row" style="gap:5px;">
            ${c.emotion ? `<span class="badge emo-${escapeHtml(c.emotion)}">${escapeHtml(emotionLabel(c.emotion))}</span>` : ''}
            <span class="badge green">CTR ${c.score}%</span>
          </div>
        </div>
        <div class="muted">
          ${fmtTime(c.start)} → ${fmtTime(c.end)} (${Math.max(0.5, c.end - c.start).toFixed(1)}s) • Gancho: <strong>${escapeHtml(c.hookText)}</strong> • ${c.lines.length} bloques
          ${c.timedSegments && c.timedSegments.length ? ' • <span style="color:var(--green); font-weight:700;">Whisper</span>' : ''}
        </div>
        ${c.reason ? `<div class="muted" style="font-size:0.77rem; margin-top:4px; color:#cbd5e1;">💡 ${escapeHtml(c.reason)}</div>` : ''}
      </div>
    `).join('');
    document.querySelectorAll('.cut-item').forEach(el => {
      el.addEventListener('click', () => loadCutIntoPlayer(Number(el.dataset.cut), true));
    });
  }

  // ==================== MÓDULO 3: MINIATURAS (CANVAS $0 + FLUX.1 [SCHNELL] $0.003) ====================
  const THUMB_ART_STYLES = [
    { key: 'viral', name: 'Ultra Viral Alto Contraste', desc: 'Vibrant YouTube creator thumbnail, dramatic rim lighting, high saturation, punchy yellow and dark shadows, dynamic diagonal framing', accent: '#facc15', secondary: '#ef4444', bgTint: 'rgba(15,23,42,0.78)', layout: 0 },
    { key: 'cinema', name: 'Póster Cinematográfico', desc: 'Epic Hollywood movie poster lighting, teal and orange color grade, moody lens flare, dramatic depth of field', accent: '#fb923c', secondary: '#0ea5e9', bgTint: 'rgba(6,10,22,0.82)', layout: 1 },
    { key: 'cyber', name: 'Neón Cyberpunk & Energía', desc: 'Futuristic neon cyan and magenta glowing highlights, electric energy arcs, sleek dark cyberpunk atmosphere', accent: '#38bdf8', secondary: '#ec4899', bgTint: 'rgba(15,10,40,0.82)', layout: 2 },
    { key: 'mystery', name: 'Misterio Documental', desc: 'Suspenseful investigative documentary aesthetic, spotlight vignette, bold red warning accents, intense contrast', accent: '#f43f5e', secondary: '#fde047', bgTint: 'rgba(10,5,12,0.86)', layout: 3 },
    { key: 'comic', name: 'Cómic Pop-Art Dinámico', desc: 'Bold graphic novel halftone action lines, bright pop-art energy burst, crisp heavy outlines and energetic colors', accent: '#22c55e', secondary: '#facc15', bgTint: 'rgba(20,12,48,0.75)', layout: 4 },
    { key: 'luxury', name: 'Editorial Lujo Dorado', desc: 'Sleek luxury magazine editorial, warm metallic gold light leaks, rich deep obsidian backdrop, refined typography', accent: '#f59e0b', secondary: '#fef08a', bgTint: 'rgba(12,10,6,0.84)', layout: 5 }
  ];

  const EXTRA_VISUAL_TWISTS = [
    'dramatic golden hour rim light and subtle motion blur background',
    'bold spotlight beam focusing attention on the center subject',
    'cinematic anamorphic lens flare with crisp high-detail foreground',
    'energetic color-split duotone background with glowing sparks',
    'ultra-clean modern documentary framing with sharp depth contrast',
    'explosive speed lines and vivid HDR dynamic range'
  ];

  function pickStyleForCard(idx, freshTwist) {
    const mood = $('thumbMoodSelect').value;
    if (mood !== 'random') {
      const found = THUMB_ART_STYLES.find(s => s.key === mood);
      if (found) return found;
    }
    const offset = (state.creativeSeed + (freshTwist ? 3 : 0) + idx * 2) % THUMB_ART_STYLES.length;
    return THUMB_ART_STYLES[offset];
  }

  /**
   * Genera miniatura económica con FLUX.1 [schnell] vía fal.ai ($0.003/imagen) o Proxy URL.
   * Reutiliza `cut.thumbnailPrompt` generado en la misma llamada de Gemini Flash-Lite.
   */
  async function callFluxSchnellThumbnail(cut, styleObj, customIdea) {
    const falKey = (state.ai.falKey || '').trim();
    const proxy = getActiveProxy();
    if (!falKey && !proxy) {
      throw new Error(isPublicSaasMode()
        ? 'El servidor de miniaturas IA no está disponible en este momento.'
        : 'Falta tu fal.ai API Key o Proxy URL (Configurar IA).');
    }

    const twist = EXTRA_VISUAL_TWISTS[Math.floor(Math.random() * EXTRA_VISUAL_TWISTS.length)];
    const baseIdea = (cut.thumbnailPrompt || '').trim() || `Dramatic high-CTR YouTube thumbnail scene representing "${cut.title}"`;
    const prompt = `${baseIdea}. Art direction: ${styleObj.desc}. Lighting & mood: ${twist}. ${customIdea ? `Extra detail: ${customIdea}.` : ''} Sharp foreground focal point, vivid colors, 16:9 composition, clean visual background without garbled text or watermarks.`;

    const endpoint = proxy
      ? `${proxy}/api/thumbnail`
      : 'https://fal.run/fal-ai/flux/schnell';
    const headers = { 'Content-Type': 'application/json', ...(proxy ? getProxyHeaders() : {}) };
    if (!proxy) headers['Authorization'] = `Key ${falKey}`;

    const res = await fetchWithBackoff(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt,
        image_size: 'landscape_16_9',
        num_inference_steps: 4,
        num_images: 1,
        enable_safety_checker: true
      })
    }, 1);

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.detail || json?.error?.message || `fal.ai HTTP ${res.status}`);
    const imgUrl = json?.images?.[0]?.url || json?.url;
    if (!imgUrl) throw new Error('FLUX.1 [schnell] no devolvió URL de imagen.');
    return imgUrl;
  }

  /**
   * Proveedor avanzado opcional (Gemini Image / OpenAI DALL-E 3) solo si el usuario elige 'provider'.
   */
  async function callGeminiImageThumbnail(frameDataUrl, cut, styleObj, customIdea) {
    const apiKey = state.ai.provider === 'gemini' ? (state.ai.apiKey || '').trim() : '';
    if (!apiKey) throw new Error('Falta API Key de Gemini.');
    const twist = EXTRA_VISUAL_TWISTS[Math.floor(Math.random() * EXTRA_VISUAL_TWISTS.length)];
    const promptText = `Transform this video scene into an eye-catching 16:9 YouTube thumbnail.
Style: ${styleObj.name} — ${styleObj.desc}. Twist: ${twist}. ${customIdea || ''}
Include bold Spanish headline text reading "${cut.hookText}" and a small badge "${cut.badge}".`;

    const parts = [{ text: promptText }];
    if (frameDataUrl && frameDataUrl.includes(',')) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: frameDataUrl.split(',')[1] } });
    }

    const attempts = [
      { model: 'gemini-2.5-flash-image', generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } },
      { model: 'gemini-3.1-flash-image', generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } } }
    ];

    let lastErr = 'Sin respuesta de imagen';
    for (const att of attempts) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(att.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetchWithBackoff(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: att.generationConfig })
      }, 1);
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        const imgPart = json?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
        if (imgPart) {
          const mime = imgPart.inlineData.mimeType || 'image/png';
          return `data:${mime};base64,${imgPart.inlineData.data}`;
        }
      } else {
        lastErr = json?.error?.message || `HTTP ${res.status}`;
      }
    }
    throw new Error(lastErr);
  }

  async function callOpenAIImageThumbnail(cut, styleObj, customIdea) {
    const apiKey = (state.ai.apiKey || '').trim();
    if (!apiKey) throw new Error('Falta API Key de OpenAI.');
    const prompt = `High-CTR 16:9 YouTube thumbnail about "${cut.title}". Style: ${styleObj.name}, ${styleObj.desc}. ${customIdea || ''}. Dramatic lighting, no cluttered text.`;
    const res = await fetchWithBackoff('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size: '1792x1024', response_format: 'b64_json' })
    }, 1);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) throw new Error('OpenAI no devolvió imagen.');
    return `data:image/png;base64,${b64}`;
  }

  /**
   * Composición de miniaturas en Canvas local ($0.00 en tokens) con 6 direcciones de arte.
   */
  async function createCanvasFallbackThumbnail(cut, styleObj) {
    const c = document.createElement('canvas');
    c.width = 1280; c.height = 720;
    const g = c.getContext('2d');

    const frameObj = state.frames[cut.frameIdx] || state.frames[0];
    if (frameObj && frameObj.dataUrl) {
      const img = await new Promise(res => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => res(null);
        im.src = frameObj.dataUrl;
      });
      if (img) {
        g.save();
        const filters = [
          'contrast(1.22) saturate(1.32)',
          'contrast(1.28) brightness(0.92) saturate(1.25)',
          'contrast(1.25) saturate(1.5) hue-rotate(-10deg)',
          'contrast(1.35) brightness(0.84) saturate(1.1)',
          'contrast(1.2) saturate(1.6)',
          'contrast(1.18) sepia(0.25) saturate(1.35)'
        ];
        g.filter = filters[styleObj.layout % filters.length];
        g.drawImage(img, 0, 0, 1280, 720);
        g.restore();
      }
    } else {
      const gr = g.createLinearGradient(0, 0, 1280, 720);
      gr.addColorStop(0, '#0f172a');
      gr.addColorStop(1, '#1e1b4b');
      g.fillStyle = gr;
      g.fillRect(0, 0, 1280, 720);
    }

    const variant = styleObj.layout % 6;

    if (variant === 0) {
      const grad = g.createLinearGradient(0, 0, 1280, 720);
      grad.addColorStop(0, 'rgba(6,10,22,0.88)');
      grad.addColorStop(0.55, 'rgba(6,10,22,0.20)');
      grad.addColorStop(1, 'rgba(239,68,68,0.42)');
      g.fillStyle = grad; g.fillRect(0, 0, 1280, 720);

      g.fillStyle = styleObj.accent;
      drawRoundRect(g, 54, 48, 360, 62, 16); g.fill();
      g.fillStyle = '#090d16'; g.font = '900 30px Segoe UI';
      g.fillText(`⚡ ${cut.badge}`, 78, 90);

      g.font = '900 106px Impact, Segoe UI';
      g.lineWidth = 16; g.strokeStyle = '#050811';
      g.strokeText(cut.hookText, 54, 555);
      g.fillStyle = '#ffffff'; g.fillText(cut.hookText, 54, 555);

      g.font = '800 42px Segoe UI';
      g.lineWidth = 10; g.strokeText(cut.title.slice(0, 42), 54, 634);
      g.fillStyle = styleObj.accent; g.fillText(cut.title.slice(0, 42), 54, 634);
    } else if (variant === 1) {
      const grad = g.createLinearGradient(0, 260, 0, 720);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(4,9,24,0.94)');
      g.fillStyle = grad; g.fillRect(0, 260, 1280, 460);

      g.fillStyle = 'rgba(0,0,0,0.85)';
      g.fillRect(0, 0, 1280, 44);
      g.fillRect(0, 676, 1280, 44);

      g.textAlign = 'center';
      g.fillStyle = styleObj.secondary;
      drawRoundRect(g, 470, 64, 340, 48, 999); g.fill();
      g.fillStyle = '#fff'; g.font = '900 24px Segoe UI';
      g.fillText(`🎬 ${cut.badge}`, 640, 96);

      g.font = '900 102px Impact, Segoe UI';
      g.lineWidth = 14; g.strokeStyle = '#020617';
      g.strokeText(cut.hookText, 640, 560);
      g.fillStyle = styleObj.accent; g.fillText(cut.hookText, 640, 560);

      g.font = '700 36px Segoe UI';
      g.fillStyle = '#f8fafc'; g.fillText(cut.title.slice(0, 46), 640, 635);
      g.textAlign = 'left';
    } else if (variant === 2) {
      const rad = g.createRadialGradient(640, 340, 130, 640, 360, 780);
      rad.addColorStop(0, 'rgba(0,0,0,0.06)');
      rad.addColorStop(1, 'rgba(15,6,36,0.9)');
      g.fillStyle = rad; g.fillRect(0, 0, 1280, 720);

      g.strokeStyle = styleObj.accent; g.lineWidth = 14;
      drawRoundRect(g, 22, 22, 1236, 676, 26); g.stroke();

      g.save();
      g.translate(640, 560); g.rotate(-0.035);
      g.fillStyle = styleObj.secondary;
      drawRoundRect(g, -480, -68, 960, 128, 22); g.fill();
      g.fillStyle = '#ffffff'; g.font = '900 84px Impact, Segoe UI'; g.textAlign = 'center';
      g.fillText(cut.hookText, 0, 24);
      g.restore();

      g.fillStyle = '#0ea5e9';
      drawRoundRect(g, 880, 52, 340, 58, 999); g.fill();
      g.fillStyle = '#04101f'; g.font = '900 26px Segoe UI'; g.textAlign = 'center';
      g.fillText(`⚡ ${cut.badge}`, 1050, 90);
      g.textAlign = 'left';
    } else if (variant === 3) {
      const rad = g.createRadialGradient(780, 320, 90, 640, 360, 740);
      rad.addColorStop(0, 'rgba(0,0,0,0.04)');
      rad.addColorStop(1, 'rgba(4,4,10,0.92)');
      g.fillStyle = rad; g.fillRect(0, 0, 1280, 720);

      g.fillStyle = styleObj.accent;
      g.fillRect(46, 420, 16, 230);

      g.fillStyle = styleObj.accent;
      drawRoundRect(g, 82, 422, 310, 48, 8); g.fill();
      g.fillStyle = '#fff'; g.font = '900 25px Segoe UI';
      g.fillText(`🔎 ${cut.badge}`, 102, 455);

      g.font = '900 96px Impact, Segoe UI';
      g.lineWidth = 14; g.strokeStyle = '#000';
      g.strokeText(cut.hookText, 82, 565);
      g.fillStyle = '#fff'; g.fillText(cut.hookText, 82, 565);

      g.font = '700 38px Segoe UI';
      g.fillStyle = styleObj.secondary; g.fillText(cut.title.slice(0, 42), 82, 635);
    } else if (variant === 4) {
      const bGrad = g.createLinearGradient(0, 330, 0, 720);
      bGrad.addColorStop(0, 'rgba(0,0,0,0)');
      bGrad.addColorStop(1, 'rgba(88,28,135,0.94)');
      g.fillStyle = bGrad; g.fillRect(0, 330, 1280, 390);

      g.save();
      g.translate(220, 110); g.rotate(-0.08);
      g.fillStyle = styleObj.accent;
      drawRoundRect(g, -165, -38, 330, 76, 16); g.fill();
      g.lineWidth = 6; g.strokeStyle = '#090d16'; g.stroke();
      g.fillStyle = '#04101f'; g.font = '900 30px Segoe UI'; g.textAlign = 'center';
      g.fillText(`💥 ${cut.badge}`, 0, 11);
      g.restore();

      g.textAlign = 'center';
      g.font = '900 108px Impact, Segoe UI';
      g.lineWidth = 16; g.strokeStyle = '#090d16';
      g.strokeText(cut.hookText, 640, 585);
      g.fillStyle = styleObj.secondary; g.fillText(cut.hookText, 640, 585);

      g.font = '800 38px Segoe UI';
      g.fillStyle = '#ffffff'; g.fillText(cut.title.slice(0, 44), 640, 655);
      g.textAlign = 'left';
    } else {
      const grad = g.createLinearGradient(0, 0, 1280, 720);
      grad.addColorStop(0, 'rgba(10,8,4,0.88)');
      grad.addColorStop(0.55, 'rgba(10,8,4,0.35)');
      grad.addColorStop(1, 'rgba(245,158,11,0.35)');
      g.fillStyle = grad; g.fillRect(0, 0, 1280, 720);

      g.strokeStyle = styleObj.accent; g.lineWidth = 6;
      drawRoundRect(g, 36, 36, 1208, 648, 12); g.stroke();

      g.fillStyle = styleObj.accent; g.font = '900 28px Segoe UI';
      g.fillText(`✦ ${cut.badge} ✦`, 72, 102);

      g.font = '900 98px Impact, Segoe UI';
      g.lineWidth = 12; g.strokeStyle = '#090704';
      g.strokeText(cut.hookText, 72, 545);
      g.fillStyle = styleObj.secondary; g.fillText(cut.hookText, 72, 545);

      g.font = '700 38px Segoe UI';
      g.fillStyle = '#f8fafc'; g.fillText(cut.title.slice(0, 44), 72, 622);
    }

    return c.toDataURL('image/png');
  }

  async function generateSingleThumbnail(idx, freshTwist = false) {
    const cut = state.cuts[idx];
    if (!cut) return { isAI: false, error: 'Corte no encontrado' };

    if (freshTwist) {
      const freshPack = getUniqueCreativePack(state.creativeSeed + idx * 3 + Math.floor(Math.random() * 50));
      cut.hookText = freshPack.hook;
      cut.badge = freshPack.badge;
      if (!cut.thumbnailPrompt) cut.title = freshPack.title;
      renderCutsList();
    }

    const styleObj = pickStyleForCard(idx, freshTwist);
    const customIdea = $('thumbCustomIdea').value.trim();
    const frameObj = state.frames[cut.frameIdx] || state.frames[0];
    const engine = state.ai.thumbEngine || 'canvas';

    state.thumbnails[idx] = {
      cutIdx: idx,
      title: cut.title,
      hook: cut.hookText,
      styleName: styleObj.name,
      source: '⏳ Generando...',
      loading: true,
      dataUrl: frameObj?.dataUrl || ''
    };
    renderThumbnailsGrid();

    let dataUrl = '';
    let sourceLabel = '🎨 Canvas ($0)';
    let lastAiError = '';

    try {
      if (engine === 'canvas') {
        dataUrl = await createCanvasFallbackThumbnail(cut, styleObj);
        sourceLabel = '🎨 Canvas ($0)';
      } else if (engine === 'fal') {
        dataUrl = await callFluxSchnellThumbnail(cut, styleObj, customIdea);
        sourceLabel = '⚡ FLUX.1 Schnell';
      } else if (engine === 'provider') {
        if (state.ai.provider === 'openai' && state.ai.apiKey) {
          dataUrl = await callOpenAIImageThumbnail(cut, styleObj, customIdea);
          sourceLabel = '✨ IA OpenAI';
        } else {
          dataUrl = await callGeminiImageThumbnail(frameObj?.dataUrl, cut, styleObj, customIdea);
          sourceLabel = '✨ IA Gemini';
        }
      }
    } catch (err) {
      lastAiError = err?.message || 'Error de conexión';
      dataUrl = await createCanvasFallbackThumbnail(cut, styleObj);
      sourceLabel = '🎨 Canvas ($0 Respaldo)';
    }

    state.thumbnails[idx] = {
      cutIdx: idx,
      title: cut.title,
      hook: cut.hookText,
      styleName: styleObj.name,
      source: sourceLabel,
      loading: false,
      aiError: lastAiError,
      dataUrl
    };
    renderThumbnailsGrid();
    return { isAI: sourceLabel.includes('FLUX') || sourceLabel.includes('IA'), error: lastAiError };
  }

  async function buildAllThumbnails(freshTwist = false) {
    if (!state.cuts.length) {
      showToast('Primero carga y analiza un video para generar miniaturas', 'warn');
      return;
    }
    setStep(4, 'run', state.ai.thumbEngine === 'fal' ? 'Generando con FLUX...' : 'Componiendo Canvas $0...');
    $('regenThumbsBtn').disabled = true;
    $('regenThumbsBtn').textContent = '⏳ Generando Miniaturas...';
    $('thumbDiagBox').className = 'test-box';

    const count = Math.min(3, state.cuts.length);
    state.thumbnails = new Array(count);

    const outcomes = await Promise.all(
      Array.from({ length: count }, (_, i) => generateSingleThumbnail(i, freshTwist))
    );

    const aiCount = outcomes.filter(o => o && o.isAI).length;
    const firstErr = outcomes.find(o => o && o.error)?.error || '';

    if (state.ai.thumbEngine === 'canvas') {
      showBoxMsg('thumbDiagBox', 'ok', isPublicSaasMode()
        ? `🎨 ${count} miniaturas generadas instantáneamente. Puedes activar la Generación Creativa con IA en el selector superior.`
        : `🎨 ${count} miniaturas creadas localmente en Canvas a costo $0.00. Puedes cambiar a FLUX.1 [schnell] ($0.003/img) en el selector superior.`);
    } else if (aiCount === 0 && firstErr) {
      showBoxMsg('thumbDiagBox', 'err', isPublicSaasMode()
        ? `ℹ️ Se aplicó el diseño rápido local porque el generador IA devolvió un aviso: ${firstErr}.`
        : `ℹ️ Se usó Canvas local ($0) como respaldo porque la API devolvió: ${firstErr}. (Si fal.ai bloquea CORS desde el navegador, usa el Proxy URL en Configurar IA).`);
    } else if (aiCount > 0) {
      showBoxMsg('thumbDiagBox', 'ok', isPublicSaasMode()
        ? `⚡ ${aiCount} miniatura(s) generada(s) con Inteligencia Artificial.`
        : `⚡ ${aiCount} miniatura(s) generada(s) con IA económica (~$${(aiCount * 0.003).toFixed(3)} USD total).`);
    }

    setStep(4, 'done', aiCount > 0 ? `${aiCount} miniaturas FLUX/IA` : `${count} miniaturas Canvas $0`);
    $('regenThumbsBtn').disabled = false;
    $('regenThumbsBtn').textContent = '✨ Generar 3 Miniaturas Nuevas';
  }

  function renderThumbnailsGrid() {
    const valid = state.thumbnails.filter(Boolean);
    if (!valid.length) {
      $('thumbsGrid').innerHTML = '<div class="card muted">Analiza un video en el Estudio de Cortes para generar automáticamente 3 miniaturas únicas.</div>';
      return;
    }
    $('thumbsGrid').innerHTML = state.thumbnails.map((t, i) => {
      if (!t) return '';
      const isExternalUrl = /^https?:\/\//i.test(t.dataUrl || '');
      return `
        <div class="thumb-card">
          <div class="thumb-img-wrap">
            ${t.dataUrl ? `<img src="${t.dataUrl}" alt="Miniatura ${i + 1}" />` : ''}
            ${t.loading ? `<div class="thumb-loader"><div class="spinner"></div><span>Creando estilo: ${escapeHtml(t.styleName)}...</span></div>` : ''}
          </div>
          <div class="thumb-body">
            <div class="row" style="justify-content:space-between;">
              <strong>Corte #${i + 1}: ${escapeHtml(t.hook)}</strong>
              <span class="badge ${t.source.includes('FLUX') || t.source.includes('IA') ? 'purple' : 'green'}">${escapeHtml(t.source)}</span>
            </div>
            <div class="muted" style="font-size:0.78rem;">Estilo: <strong>${escapeHtml(t.styleName)}</strong></div>
            <p class="muted">${escapeHtml(t.title)}</p>
            <div class="row" style="margin-top:auto;">
              ${!t.loading && t.dataUrl ? `<a class="btn btn-sm btn-green" href="${t.dataUrl}" ${isExternalUrl ? 'target="_blank" rel="noopener noreferrer"' : `download="miniatura_corte_${i + 1}.png"`} style="text-decoration:none;">⬇️ ${isExternalUrl ? 'Abrir / Guardar' : 'Descargar'}</a>` : ''}
              <button type="button" class="btn btn-sm btn-primary" data-open-cut="${i}">✂️ Corte</button>
              <button type="button" class="btn btn-sm btn-purple" data-regen-one="${i}" ${t.loading ? 'disabled' : ''}>🎲 Variar</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    document.querySelectorAll('[data-open-cut]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelector('[data-tab="studio"]').click();
        loadCutIntoPlayer(Number(btn.dataset.openCut), true);
      });
    });
    document.querySelectorAll('[data-regen-one]').forEach(btn => {
      btn.addEventListener('click', async () => {
        state.creativeSeed += 1 + Math.floor(Math.random() * 5);
        await generateSingleThumbnail(Number(btn.dataset.regenOne), true);
      });
    });
  }

  // Selector rápido de motor de miniaturas dentro de la pestaña Miniaturas
  $('thumbEngineQuickSelect').addEventListener('change', e => {
    state.ai.thumbEngine = e.target.value;
    $('thumbEngineSelect').value = e.target.value;
    safeSet('cliphub_ai_config', JSON.stringify(state.ai));
    refreshAiBadge();
    showToast(`Motor de miniaturas cambiado a: ${e.target.options[e.target.selectedIndex].text}`, 'ok');
  });

  // ==================== PIPELINE COMPLETO OPTIMIZADO ====================
  async function runFullAnalysis() {
    if (state.isAnalyzing) return;
    if (!video.src) {
      $('pipelineMsg').textContent = 'Primero sube un video o pulsa "✨ Cargar Video Demo".';
      showToast('Sube un video o carga el video demo primero', 'warn');
      return;
    }

    state.isAnalyzing = true;
    state.cancelled = false;
    activeAbort = new AbortController();
    $('analyzeBtn').disabled = true;
    $('cancelBtn').style.display = 'inline-flex';
    const preEst = ((state.duration / 3600) * 0.04 + 0.0008).toFixed(4);
    $('pipelineMsg').textContent = `Ejecutando pipeline: Fotogramas → Audio Whisper → Cortes → Miniaturas... (costo estimado ≈ $${preEst} USD)`;

    let usedWhisper = false;
    let usedLLM = false;

    try {
      // PASO 1: Fotogramas reales del video
      await extractRealFrames();

      // PASO 2: Extracción de audio WAV 16 kHz + Transcripción Groq Whisper
      state.transcript = null;
      const canWhisper = Boolean(state.videoBlob && ((state.ai.groqKey || '').trim() || hasProxy()));
      if (canWhisper) {
        setStep(3, 'run', 'Extrayendo audio + Whisper...');
        try {
          state.transcript = await transcribeVideoWithGroqWhisper(state.videoBlob);
          if (state.transcript?.segments?.length) {
            usedWhisper = true;
            setStep(3, 'done', `${state.transcript.segments.length} frases (Whisper)`);
          } else {
            setStep(3, 'done', 'Sin voz detectada (respaldo)');
          }
        } catch (err) {
          if (state.cancelled) throw err;
          console.warn('Groq Whisper fallback:', err);
          setStep(3, 'err', 'Audio sin API; usando respaldo');
          showToast(`Whisper no disponible (${err.message}). Continuando con respaldo local.`, 'warn');
        }
      } else {
        setStep(3, 'done', 'Modo local (sin clave Groq)');
      }

      if (state.cancelled) throw new Error('cancelado');
      // PASO 3: Detección de cortes emocionantes enviando SOLO TEXTO a Gemini 2.5 Flash-Lite
      setStep(2, 'run', 'Analizando texto (Flash-Lite)...');
      state.creativeSeed += 1;
      const aiCuts = await askAIForCuts();
      if (state.cancelled) throw new Error('cancelado');
      usedLLM = Boolean(aiCuts);
      state.cuts = aiCuts || buildSmartCutsFallback();
      const modelTag = usedLLM
        ? (state.ai.provider === 'gemini' ? (state.ai.model || 'Flash-Lite') : (AI_PROVIDERS[state.ai.provider]?.short || 'IA'))
        : 'Motor Local';
      setStep(2, 'done', `${state.cuts.length} cortes (${modelTag})`);

      // Cargar primer corte con subtítulos sincronizados
      loadCutIntoPlayer(0, true);

      // PASO 4: Miniaturas (Canvas $0 o FLUX.1 Schnell $0.003)
      await buildAllThumbnails(false);
      saveProject();

      // Estimación transparente del costo real de esta ejecución (solo visible en modo admin/dev)
      const estWhisper = usedWhisper ? (state.duration / 3600) * 0.04 : 0;
      const estLLM = usedLLM ? 0.0008 : 0;
      const estThumbs = (state.ai.thumbEngine === 'fal' && ((state.ai.falKey || '').trim() || hasProxy()))
        ? Math.min(3, state.cuts.length) * 0.003 : 0;
      const totalEst = estWhisper + estLLM + estThumbs;

      $('pipelineMsg').textContent = isPublicSaasMode()
        ? `✅ ¡Análisis completado! Subtítulos: ${usedWhisper ? 'Audio transcrito con IA' : 'Sincronizado local'} • ${state.cuts.length} cortes y miniaturas listos para editar o exportar.`
        : `✅ ¡Análisis listo! Subtítulos: ${usedWhisper ? 'Groq Whisper real' : 'Local'} • Cortes: ${modelTag} • Costo estimado de este video: ~$${totalEst.toFixed(4)} USD.`;
      showToast('Análisis completo: cortes, subtítulos y miniaturas listos', 'ok');
    } catch (err) {
      if (state.cancelled || err.name === 'AbortError') {
        setStep(2, 'err', 'Cancelado');
        $('pipelineMsg').textContent = '⏹ Análisis cancelado. No se guardó nada.';
        showToast('Análisis cancelado', 'warn');
      } else {
        setStep(2, 'err', 'Error en análisis');
        $('pipelineMsg').textContent = `⚠️ Ocurrió un problema durante el análisis: ${err.message}`;
        showToast('Error al analizar el video', 'warn');
      }
    } finally {
      activeAbort = null;
      state.isAnalyzing = false;
      $('analyzeBtn').disabled = false;
      $('cancelBtn').style.display = 'none';
    }
  }

  // ==================== GUARDAR / RESTAURAR PROYECTO ====================
  async function saveProject() {
    if (!state.videoBlob || !state.cuts.length) return;
    try {
      await ProjectDB.put('last', {
        videoBlob: state.videoBlob, videoName: state.videoName, duration: state.duration,
        transcript: state.transcript, cuts: state.cuts, savedAt: Date.now()
      });
      $('restoreBtn').style.display = 'inline-flex';
    } catch (err) {
      console.warn('No se pudo guardar el proyecto:', err);
      showToast('No se pudo guardar el proyecto (¿poco espacio en disco?)', 'warn');
    }
  }
  function applyRestore() {
    const p = pendingRestore;
    pendingRestore = null;
    if (!p) return;
    state.transcript = p.transcript || null;
    state.cuts = p.cuts || [];
    setStep(1, 'done', 'Proyecto restaurado');
    $('pipelineMsg').textContent = `♻️ Proyecto "${state.videoName}" restaurado (${state.cuts.length} cortes).`;
    if (state.cuts.length) loadCutIntoPlayer(0, true);
    if (state.ai.thumbEngine !== 'fal') buildAllThumbnails(false).catch(() => {});
    showToast('Último proyecto restaurado', 'ok');
  }
  $('cancelBtn').addEventListener('click', () => {
    state.cancelled = true;
    if (activeAbort) activeAbort.abort();
  });
  $('restoreBtn').addEventListener('click', async () => {
    try {
      const p = await ProjectDB.get('last');
      if (!p || !p.videoBlob) { showToast('No hay proyecto guardado', 'warn'); return; }
      pendingRestore = p;
      state.videoBlob = p.videoBlob;
      loadVideoSrc(URL.createObjectURL(p.videoBlob), p.videoName, p.duration || 15);
    } catch (err) {
      showToast('No se pudo restaurar el proyecto', 'warn');
    }
  });
  ProjectDB.get('last').then(p => { if (p && p.videoBlob) $('restoreBtn').style.display = 'inline-flex'; }).catch(() => {});

  $('analyzeBtn').addEventListener('click', runFullAnalysis);
  $('regenThumbsBtn').addEventListener('click', async () => {
    if (!state.cuts.length) {
      showToast('Primero carga y analiza un video', 'warn');
      return;
    }
    state.creativeSeed += 3 + Math.floor(Math.random() * 7);
    await buildAllThumbnails(true);
  });

  // ==================== MOTOR DE RENDER EN VIVO (VIDEO + FILTROS + ZOOM + GANCHO + MARCA + PNG + SUBTÍTULOS) ====================
  function wrapText(c, text, maxW) {
    const words = String(text || '').split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (c.measureText(test).width > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function buildFilterString() {
    const e = state.edit;
    let f = `brightness(${e.brightness}%) contrast(${e.contrast}%) saturate(${e.saturate}%)`;
    if (e.grayscale > 0) f += ` grayscale(${e.grayscale}%)`;
    if (e.sepia > 0) f += ` sepia(${e.sepia}%)`;
    return f;
  }

  // Palabras de una frase: tiempos reales de Whisper si existen; si no, se reparte el tiempo en partes iguales
  function getSubWords(active) {
    if (active._words) return active._words;
    const tw = (!active.edited && state.transcript && state.transcript.words) || [];
    let ws = tw.filter(x => x.start >= active.start - 0.15 && x.end <= active.end + 0.15 && String(x.word).trim());
    if (!ws.length) {
      const parts = String(active.text || '').trim().split(/\s+/).filter(Boolean);
      const step = (active.end - active.start) / Math.max(1, parts.length);
      ws = parts.map((p, i) => ({ word: p, start: active.start + i * step, end: active.start + (i + 1) * step }));
    }
    active._words = ws;
    return ws;
  }

  // Muestra grupos de 3 palabras y resalta en amarillo la que se está diciendo
  function drawWordByWord(c, w, h, now, active) {
    const ws = getSubWords(active);
    if (!ws.length) return;
    let idx = 0;
    for (let i = 0; i < ws.length; i++) { if (ws[i].start <= now) idx = i; }
    const G = 3, g = Math.floor(idx / G);
    const txt = ws.slice(g * G, g * G + G).map(x => String(x.word).trim().toUpperCase());
    let fs = state.aspect === '9:16' ? 38 : 42;
    c.save();
    c.textAlign = 'left';
    c.lineJoin = 'round';
    let widths, sp, total;
    const measure = () => {
      c.font = `900 ${fs}px Segoe UI, Impact, sans-serif`;
      sp = c.measureText(' ').width;
      widths = txt.map(t => c.measureText(t).width);
      total = widths.reduce((a, b) => a + b, 0) + sp * (txt.length - 1);
    };
    measure();
    if (total > w * 0.92) { fs = Math.floor(fs * (w * 0.92) / total); measure(); }
    let x = (w - total) / 2;
    const y = h * 0.80;
    txt.forEach((t, i) => {
      c.lineWidth = 9;
      c.strokeStyle = '#050811';
      c.strokeText(t, x, y);
      c.fillStyle = (g * G + i) === idx ? '#fde047' : '#ffffff';
      c.fillText(t, x, y);
      x += widths[i] + sp;
    });
    c.restore();
  }

  function drawSubtitleOverlay(c, w, h, now) {
    if (!state.showSubs || !state.subtitles.length) return;
    const active = state.subtitles.find(s => now >= s.start && now <= s.end) ||
                   (now >= state.startTime && now <= state.endTime ? state.subtitles[state.subtitles.length - 1] : null);
    if (!active) return;
    if (state.subStyle === 'word') { drawWordByWord(c, w, h, now, active); return; }

    const fontSize = state.aspect === '9:16' ? 32 : 36;
    c.save();
    c.font = `900 ${fontSize}px Segoe UI, Impact, sans-serif`;
    c.textAlign = 'center';
    const lines = wrapText(c, active.text.toUpperCase(), w * 0.86);
    const lineH = fontSize * 1.24;
    const baseY = h * 0.80 - ((lines.length - 1) * lineH) / 2;

    lines.forEach((line, idx) => {
      const y = baseY + idx * lineH;
      if (state.subStyle === 'box') {
        const tw = c.measureText(line).width + 28;
        c.fillStyle = 'rgba(255,255,255,0.95)';
        drawRoundRect(c, w / 2 - tw / 2, y - fontSize * 0.85, tw, fontSize * 1.15, 10);
        c.fill();
        c.fillStyle = '#090d16';
        c.fillText(line, w / 2, y);
      } else {
        c.lineWidth = 8;
        c.strokeStyle = '#050811';
        c.strokeText(line, w / 2, y);
        c.fillStyle = state.subStyle === 'viral' ? '#fde047' : state.subStyle === 'neon' ? '#38bdf8' : '#ffffff';
        c.fillText(line, w / 2, y);
      }
    });
    c.restore();
  }

  function drawSceneToCanvas(targetCtx, w, h) {
    targetCtx.fillStyle = '#050811';
    targetCtx.fillRect(0, 0, w, h);

    if (video.readyState >= 2 && video.videoWidth > 0) {
      const vr = video.videoWidth / video.videoHeight;
      const cr = w / h;
      let sx = 0, sy = 0, sw = video.videoWidth, sh = video.videoHeight;
      if (vr > cr) {
        sw = video.videoHeight * cr;
        sx = (video.videoWidth - sw) / 2;
      } else {
        sh = video.videoWidth / cr;
        sy = (video.videoHeight - sh) / 2;
      }

      targetCtx.save();
      targetCtx.filter = buildFilterString();
      targetCtx.translate(w / 2 + (state.edit.panX / 100) * w, h / 2 + (state.edit.panY / 100) * h);
      targetCtx.rotate((state.edit.rotation * Math.PI) / 180);
      targetCtx.scale(state.edit.flipX ? -state.edit.zoom : state.edit.zoom, state.edit.zoom);
      targetCtx.drawImage(video, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
      targetCtx.restore();
    } else {
      targetCtx.save();
      targetCtx.fillStyle = '#64748b';
      targetCtx.font = '700 20px Segoe UI';
      targetCtx.textAlign = 'center';
      targetCtx.fillText('Sube un video o carga el Demo', w / 2, h / 2);
      targetCtx.restore();
    }

    // Gancho superior del editor
    if (state.edit.showHook && state.edit.hookText.trim()) {
      targetCtx.save();
      const padX = w * 0.06;
      const boxW = w - padX * 2;
      const boxH = state.aspect === '9:16' ? 74 : 64;
      targetCtx.fillStyle = state.edit.hookColor || '#f59e0b';
      drawRoundRect(targetCtx, padX, 24, boxW, boxH, 16);
      targetCtx.fill();
      targetCtx.fillStyle = '#090d16';
      targetCtx.font = `900 ${state.aspect === '9:16' ? 24 : 26}px Segoe UI`;
      targetCtx.textAlign = 'center';
      targetCtx.fillText(state.edit.hookText.trim().slice(0, 38).toUpperCase(), w / 2, 24 + boxH * 0.65);
      targetCtx.restore();
    }

    // Marca de agua
    if (state.edit.watermark.trim()) {
      targetCtx.save();
      targetCtx.globalAlpha = state.edit.watermarkOpacity;
      targetCtx.font = '800 22px Segoe UI';
      const txt = state.edit.watermark.trim();
      const tw = targetCtx.measureText(txt).width + 20;
      const pos = state.edit.watermarkPos;
      const x = (pos === 'tr' || pos === 'br') ? w - tw - 18 : 18;
      const y = (pos === 'bl' || pos === 'br') ? h - 52 : (state.edit.showHook ? 112 : 24);
      targetCtx.fillStyle = 'rgba(0,0,0,0.58)';
      drawRoundRect(targetCtx, x, y, tw, 34, 999);
      targetCtx.fill();
      targetCtx.fillStyle = '#ffffff';
      targetCtx.fillText(txt, x + 10, y + 24);
      targetCtx.restore();
    }

    // Foto PNG sin fondo
    if (state.pngProcessed) {
      const scale = Number($('pngScale').value) / 100;
      const pw = w * scale;
      const ph = pw * (state.pngProcessed.height / Math.max(1, state.pngProcessed.width));
      const px = (Number($('pngX').value) / 100) * w - pw / 2;
      const py = (Number($('pngY').value) / 100) * h - ph / 2;
      targetCtx.drawImage(state.pngProcessed, px, py, pw, ph);
    }

    // Subtítulos en vivo
    drawSubtitleOverlay(targetCtx, w, h, video.currentTime || 0);
  }

  let lastIdleDraw = 0;
  function renderFrameLoop(ts) {
    const onCanvasTab = (state.activeTab === 'studio' || state.activeTab === 'editor');
    const isActiveMotion = (!video.paused && video.readyState >= 2) || state.draggingPng || state.draggingTimeline || state.isExporting;

    // Ahorro de CPU/GPU: si estás en "En Vivo", "Miniaturas" o "Redes", o el video está pausado, no redibuja a 60fps
    if (!onCanvasTab) {
      setTimeout(() => requestAnimationFrame(renderFrameLoop), 350);
      return;
    }
    if (!isActiveMotion && (ts - lastIdleDraw) < 220) {
      requestAnimationFrame(renderFrameLoop);
      return;
    }
    lastIdleDraw = ts || performance.now();

    if (video.readyState >= 2) {
      if (!video.paused && state.loopCut && !state.isExporting && video.currentTime >= state.endTime) {
        video.currentTime = state.startTime;
      }
      const now = video.currentTime || 0;
      $('seekBar').value = now;
      const formatted = fmtTime(now);
      $('timeNow').textContent = formatted;
      $('edTimeNow').textContent = formatted;
      updateTimelineUI();
    }

    if (state.activeTab === 'studio' || state.isExporting) {
      drawSceneToCanvas(ctx, canvas.width, canvas.height);
    }
    if (state.activeTab === 'editor') {
      drawSceneToCanvas(editorCtx, editorCanvas.width, editorCanvas.height);
    }
    requestAnimationFrame(renderFrameLoop);
  }
  requestAnimationFrame(renderFrameLoop);

  // ==================== CONTROLES DE REPRODUCCIÓN Y SUBTÍTULOS ====================
  function togglePlayPause() {
    if (!video.src) {
      showToast('Sube un video o pulsa "✨ Cargar Video Demo" primero', 'warn');
      return;
    }
    if (video.paused) {
      if (video.currentTime < state.startTime || video.currentTime >= state.endTime) {
        video.currentTime = state.startTime;
      }
      video.play().then(syncPlayButtons).catch(syncPlayButtons);
    } else {
      video.pause();
      syncPlayButtons();
    }
  }

  $('playPauseBtn').addEventListener('click', togglePlayPause);
  $('edPlayPauseBtn').addEventListener('click', togglePlayPause);

  function toggleLoop() {
    state.loopCut = !state.loopCut;
    syncLoopButtons();
    showToast(state.loopCut ? 'Loop del corte activado' : 'Loop desactivado', '');
  }
  $('loopCutBtn').addEventListener('click', toggleLoop);
  $('edLoopCutBtn').addEventListener('click', toggleLoop);

  $('seekBar').addEventListener('input', e => {
    if (video.src) video.currentTime = Number(e.target.value);
  });
  $('aspectSelect').addEventListener('change', e => applyAspectRatio(e.target.value));
  $('edAspectSelect').addEventListener('change', e => applyAspectRatio(e.target.value));
  $('subStyleSelect').addEventListener('change', e => { state.subStyle = e.target.value; });
  $('showSubsCheck').addEventListener('change', e => { state.showSubs = e.target.checked; });

  $('applySubsBtn').addEventListener('click', () => {
    const newStart = Math.max(0, Number($('startInput').value) || 0);
    let newEnd = Math.max(newStart + 0.5, Number($('endInput').value) || state.duration || 15);
    if (state.duration > 0) newEnd = Math.min(state.duration, newEnd);
    const cleanLines = $('subsTextarea').value.split('\n').map(l => l.trim()).filter(Boolean);

    const cut = state.activeCutIdx >= 0 ? state.cuts[state.activeCutIdx] : null;
    const prevTimed = cut && Array.isArray(cut.timedSegments) ? cut.timedSegments : [];
    const sameLineCount = prevTimed.length > 0 && cleanLines.length === prevTimed.length;
    const sameWindow = cut && Math.abs(newStart - cut.start) < 0.05 && Math.abs(newEnd - cut.end) < 0.05;

    state.startTime = newStart;
    state.endTime = newEnd;

    let preservedWhisper = false;
    if (sameLineCount && sameWindow) {
      // Conserva los tiempos reales de Groq Whisper y actualiza solo el texto modificado
      const updatedSegments = prevTimed.map((seg, i) => ({
        start: seg.start,
        end: seg.end,
        text: cleanLines[i],
        edited: seg.edited || (cleanLines[i] !== seg.text)
      }));
      state.subtitles = updatedSegments;
      if (cut) {
        cut.lines = cleanLines;
        cut.timedSegments = updatedSegments;
      }
      preservedWhisper = true;
    } else {
      state.subtitles = buildTimedSubtitles(cleanLines, state.startTime, state.endTime);
      if (cut) {
        cut.start = state.startTime;
        cut.end = state.endTime;
        cut.lines = cleanLines;
        cut.timedSegments = [];
      }
    }

    if (cut) renderCutsList();
    const badge = $('subsSourceBadge');
    if (badge) {
      badge.textContent = preservedWhisper ? '🎙️ Whisper (Texto editado)' : '✍️ Editado Manual';
      badge.className = preservedWhisper ? 'badge green' : 'badge';
    }
    updateCutRangeLabel();
    if (video.src) {
      video.currentTime = state.startTime;
      video.play().then(syncPlayButtons).catch(syncPlayButtons);
    }
    showToast(
      preservedWhisper
        ? 'Texto corregido conservando los tiempos reales de Whisper'
        : 'Subtítulos aplicados a todo el corte',
      'ok'
    );
  });

  // ==================== CONTROLES DEL EDITOR DE VIDEO ====================
  function seekFromTimelinePointer(clientX) {
    if (!video.src || !state.duration) return;
    const rect = $('timelineTrack').getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    video.currentTime = pct * state.duration;
    updateTimelineUI();
  }

  $('timelineTrack').addEventListener('mousedown', e => {
    state.draggingTimeline = true;
    seekFromTimelinePointer(e.clientX);
  });
  window.addEventListener('mousemove', e => {
    if (state.draggingTimeline) seekFromTimelinePointer(e.clientX);
  });
  window.addEventListener('mouseup', () => { state.draggingTimeline = false; });

  $('timelineTrack').addEventListener('touchstart', e => {
    if (e.touches[0]) {
      state.draggingTimeline = true;
      seekFromTimelinePointer(e.touches[0].clientX);
    }
  }, { passive: true });
  $('timelineTrack').addEventListener('touchmove', e => {
    if (state.draggingTimeline && e.touches[0]) seekFromTimelinePointer(e.touches[0].clientX);
  }, { passive: true });
  $('timelineTrack').addEventListener('touchend', () => { state.draggingTimeline = false; });

  $('edMarkStartBtn').addEventListener('click', () => {
    if (!video.src) return;
    state.startTime = Number(Math.max(0, Math.min(state.endTime - 0.5, video.currentTime)).toFixed(1));
    $('startInput').value = state.startTime.toFixed(1);
    state.subtitles = buildTimedSubtitles($('subsTextarea').value.split('\n'), state.startTime, state.endTime);
    updateCutRangeLabel();
    showToast(`Inicio fijado en ${fmtTime(state.startTime)}`, 'ok');
  });

  $('edMarkEndBtn').addEventListener('click', () => {
    if (!video.src) return;
    state.endTime = Number(Math.max(state.startTime + 0.5, Math.min(state.duration, video.currentTime)).toFixed(1));
    $('endInput').value = state.endTime.toFixed(1);
    state.subtitles = buildTimedSubtitles($('subsTextarea').value.split('\n'), state.startTime, state.endTime);
    updateCutRangeLabel();
    showToast(`Fin fijado en ${fmtTime(state.endTime)}`, 'ok');
  });

  $('edSplitCutBtn').addEventListener('click', () => {
    if (!video.src) return;
    const mid = Number((video.currentTime || 0).toFixed(1));
    if (mid <= state.startTime + 0.5 || mid >= state.endTime - 0.5) {
      showToast('Coloca el cabezal amarillo dentro del corte para dividirlo', 'warn');
      return;
    }
    const oldEnd = state.endTime;
    state.endTime = mid;
    $('endInput').value = mid.toFixed(1);
    if (state.activeCutIdx >= 0 && state.cuts[state.activeCutIdx]) {
      state.cuts[state.activeCutIdx].end = mid;
    }
    const fresh = getUniqueCreativePack(state.cuts.length + Date.now());
    state.cuts.push({
      title: `Parte 2 (${fmtTime(mid)} → ${fmtTime(oldEnd)})`,
      hookText: fresh.hook,
      badge: 'DIVIDIDO',
      score: 93,
      start: mid,
      end: oldEnd,
      frameIdx: 0,
      lines: fresh.lines,
      timedSegments: [],
      thumbnailPrompt: ''
    });
    renderCutsList();
    updateCutRangeLabel();
    showToast(`Corte dividido en ${fmtTime(mid)} (Parte 2 añadida)`, 'ok');
  });

  $('edSaveNewCutBtn').addEventListener('click', () => {
    if (!video.src) return;
    const lines = $('subsTextarea').value.split('\n').map(l => l.trim()).filter(Boolean);
    const fresh = getUniqueCreativePack(state.cuts.length + 1);
    const newCut = {
      title: `Corte Editado #${state.cuts.length + 1}`,
      hookText: (state.edit.hookText || fresh.hook).toUpperCase(),
      badge: 'EDITADO PRO',
      score: 95,
      start: state.startTime,
      end: state.endTime,
      frameIdx: 0,
      lines: lines.length ? lines : fresh.lines,
      timedSegments: [],
      thumbnailPrompt: ''
    };
    state.cuts.push(newCut);
    state.activeCutIdx = state.cuts.length - 1;
    renderCutsList();
    showToast('Corte editado guardado en tu lista', 'ok');
  });

  $('edSpeedSelect').addEventListener('change', e => {
    state.edit.speed = Number(e.target.value) || 1;
    video.playbackRate = state.edit.speed;
  });
  $('edVolumeRange').addEventListener('input', e => {
    const v = Number(e.target.value);
    state.edit.volume = v / 100;
    video.volume = state.edit.volume;
    $('edVolumeVal').textContent = `${v}%`;
  });
  $('edMuteBtn').addEventListener('click', () => {
    state.edit.muted = !state.edit.muted;
    video.muted = state.edit.muted;
    $('edMuteBtn').textContent = state.edit.muted ? '🔇 Silenciado (Clic para activar)' : '🔊 Audio Activo (Clic para silenciar)';
  });

  $('edZoomRange').addEventListener('input', e => {
    const v = Number(e.target.value);
    state.edit.zoom = v / 100;
    $('edZoomVal').textContent = `${v}%`;
  });
  $('edPanXRange').addEventListener('input', e => {
    state.edit.panX = Number(e.target.value);
    $('edPanXVal').textContent = `${state.edit.panX}%`;
  });
  $('edPanYRange').addEventListener('input', e => {
    state.edit.panY = Number(e.target.value);
    $('edPanYVal').textContent = `${state.edit.panY}%`;
  });
  $('edRotateBtn').addEventListener('click', () => {
    state.edit.rotation = (state.edit.rotation + 90) % 360;
    showToast(`Rotación: ${state.edit.rotation}°`, '');
  });
  $('edFlipXBtn').addEventListener('click', () => {
    state.edit.flipX = !state.edit.flipX;
    showToast(state.edit.flipX ? 'Modo espejo activado' : 'Modo espejo desactivado', '');
  });

  function syncColorSliders() {
    $('edBrightRange').value = state.edit.brightness;
    $('edBrightVal').textContent = `${state.edit.brightness}%`;
    $('edContrastRange').value = state.edit.contrast;
    $('edContrastVal').textContent = `${state.edit.contrast}%`;
    $('edSatRange').value = state.edit.saturate;
    $('edSatVal').textContent = `${state.edit.saturate}%`;
  }

  $('edFilterPreset').addEventListener('change', e => {
    const p = e.target.value;
    state.edit.filterPreset = p;
    const presets = {
      none: { brightness: 100, contrast: 100, saturate: 100, grayscale: 0, sepia: 0 },
      cine: { brightness: 96, contrast: 126, saturate: 112, grayscale: 0, sepia: 8 },
      vibrant: { brightness: 105, contrast: 116, saturate: 155, grayscale: 0, sepia: 0 },
      warm: { brightness: 104, contrast: 108, saturate: 128, grayscale: 0, sepia: 28 },
      bw: { brightness: 102, contrast: 135, saturate: 0, grayscale: 100, sepia: 0 },
      cyber: { brightness: 95, contrast: 132, saturate: 165, grayscale: 0, sepia: 0 }
    };
    Object.assign(state.edit, presets[p] || presets.none);
    syncColorSliders();
  });

  $('edBrightRange').addEventListener('input', e => {
    state.edit.brightness = Number(e.target.value);
    $('edBrightVal').textContent = `${state.edit.brightness}%`;
  });
  $('edContrastRange').addEventListener('input', e => {
    state.edit.contrast = Number(e.target.value);
    $('edContrastVal').textContent = `${state.edit.contrast}%`;
  });
  $('edSatRange').addEventListener('input', e => {
    state.edit.saturate = Number(e.target.value);
    $('edSatVal').textContent = `${state.edit.saturate}%`;
  });

  $('edShowHookCheck').addEventListener('change', e => { state.edit.showHook = e.target.checked; });
  $('edHookInput').addEventListener('input', e => {
    state.edit.hookText = e.target.value;
    if (e.target.value.trim() && !$('edShowHookCheck').checked) {
      $('edShowHookCheck').checked = true;
      state.edit.showHook = true;
    }
  });
  $('edHookColorSelect').addEventListener('change', e => { state.edit.hookColor = e.target.value; });
  $('edWatermarkInput').addEventListener('input', e => { state.edit.watermark = e.target.value; });
  $('edWatermarkPos').addEventListener('change', e => { state.edit.watermarkPos = e.target.value; });
  $('edWatermarkOpacity').addEventListener('input', e => {
    const v = Number(e.target.value);
    state.edit.watermarkOpacity = v / 100;
    $('edWmOpVal').textContent = `${v}%`;
  });

  $('edResetBtn').addEventListener('click', () => {
    state.edit = {
      speed: 1, volume: 1, muted: false, zoom: 1, panX: 0, panY: 0,
      rotation: 0, flipX: false, filterPreset: 'none',
      brightness: 100, contrast: 100, saturate: 100, grayscale: 0, sepia: 0,
      showHook: false, hookText: '', hookColor: '#f59e0b',
      watermark: '', watermarkPos: 'tr', watermarkOpacity: 0.75
    };
    video.playbackRate = 1;
    video.volume = 1;
    video.muted = false;
    $('edSpeedSelect').value = '1';
    $('edVolumeRange').value = '100'; $('edVolumeVal').textContent = '100%';
    $('edMuteBtn').textContent = '🔊 Audio Activo (Clic para silenciar)';
    $('edZoomRange').value = '100'; $('edZoomVal').textContent = '100%';
    $('edPanXRange').value = '0'; $('edPanXVal').textContent = '0%';
    $('edPanYRange').value = '0'; $('edPanYVal').textContent = '0%';
    $('edFilterPreset').value = 'none';
    syncColorSliders();
    $('edShowHookCheck').checked = false;
    $('edHookInput').value = '';
    $('edWatermarkInput').value = '';
    $('edWatermarkOpacity').value = '75'; $('edWmOpVal').textContent = '75%';
    showToast('Ajustes del editor restablecidos', 'ok');
  });

  // ==================== PNG SIN FONDO + ARRASTRE EN CANVAS ====================
  function processPngChroma() {
    if (!state.pngImg) return;
    const mode = $('chromaSelect').value;
    const c = document.createElement('canvas');
    c.width = state.pngImg.width;
    c.height = state.pngImg.height;
    const g = c.getContext('2d');
    g.drawImage(state.pngImg, 0, 0);
    if (mode !== 'none') {
      const imgData = g.getImageData(0, 0, c.width, c.height);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gr = d[i + 1], b = d[i + 2];
        if ((mode === 'white' && r > 222 && gr > 222 && b > 222) ||
            (mode === 'black' && r < 32 && gr < 32 && b < 32) ||
            (mode === 'green' && gr > 115 && gr > r * 1.28 && gr > b * 1.28)) {
          d[i + 3] = 0;
        }
      }
      g.putImageData(imgData, 0, 0);
    }
    state.pngProcessed = c;
  }

  $('pngInput').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      state.pngImg = img;
      processPngChroma();
      try { URL.revokeObjectURL(pngUrl); } catch (_) {}
      showToast('Foto PNG añadida (puedes arrastrarla sobre el video)', 'ok');
    };
    const pngUrl = URL.createObjectURL(f);
    img.src = pngUrl;
    e.target.value = '';
  });
  $('chromaSelect').addEventListener('change', processPngChroma);
  $('clearPngBtn').addEventListener('click', () => {
    state.pngImg = null;
    state.pngProcessed = null;
    showToast('Foto PNG quitada', '');
  });

  function bindPngDrag(targetCanvas) {
    const movePng = (clientX, clientY) => {
      if (!state.draggingPng || !state.pngProcessed) return;
      const rect = targetCanvas.getBoundingClientRect();
      const xPct = Math.max(5, Math.min(95, Math.round(((clientX - rect.left) / Math.max(1, rect.width)) * 100)));
      const yPct = Math.max(5, Math.min(95, Math.round(((clientY - rect.top) / Math.max(1, rect.height)) * 100)));
      $('pngX').value = xPct;
      $('pngY').value = yPct;
    };
    targetCanvas.addEventListener('mousedown', e => {
      if (!state.pngProcessed) return;
      state.draggingPng = true;
      movePng(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', e => movePng(e.clientX, e.clientY));
    window.addEventListener('mouseup', () => { state.draggingPng = false; });

    targetCanvas.addEventListener('touchstart', e => {
      if (!state.pngProcessed || !e.touches[0]) return;
      state.draggingPng = true;
      movePng(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    targetCanvas.addEventListener('touchmove', e => {
      if (state.draggingPng && e.touches[0]) movePng(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    targetCanvas.addEventListener('touchend', () => { state.draggingPng = false; });
  }
  bindPngDrag(canvas);
  bindPngDrag(editorCanvas);

  // ==================== EXPORTAR Y PREVISUALIZAR CLIP LOCAL ($0 TOKENS) ====================
  async function exportCurrentClip(autoSendToTelegram = false) {
    if (!video.src) {
      showToast('Primero carga un video para exportar', 'warn');
      return;
    }
    if (state.isExporting) return;
    state.isExporting = true;

    const exportFormats = [
      { mime: 'video/mp4;codecs=avc1.4D4028,mp4a.40.2', ext: 'mp4', label: 'MP4 (H.264)' },
      { mime: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4', label: 'MP4 (H.264)' },
      { mime: 'video/mp4', ext: 'mp4', label: 'MP4' },
      { mime: 'video/webm;codecs=vp9,opus', ext: 'webm', label: 'WebM (VP9)' },
      { mime: 'video/webm;codecs=vp8,opus', ext: 'webm', label: 'WebM (VP8)' },
      { mime: 'video/webm', ext: 'webm', label: 'WebM' }
    ];
    const chosenFmt = exportFormats.find(f => {
      try { return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(f.mime); }
      catch (_) { return false; }
    }) || { mime: '', ext: 'webm', label: 'WebM' };

    $('exportModal').classList.add('open');
    $('exportedVideoPreview').style.display = 'none';
    $('downloadExportBtn').style.display = 'none';
    if ($('sendExportToTgBtn')) $('sendExportToTgBtn').style.display = 'none';
    if ($('openExportInViewerBtn')) $('openExportInViewerBtn').style.display = 'none';
    if ($('exportTabWarn')) $('exportTabWarn').style.display = 'block';
    $('exportProgress').style.width = '5%';
    $('exportStatus').textContent = `Renderizando corte en ${chosenFmt.label} con subtítulos, filtros, PNG y audio...`;

    let wakeLock = null;
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (_) {}

    let tabWasHidden = false;
    const onVisChange = () => {
      if (document.hidden && state.isExporting) tabWasHidden = true;
    };
    document.addEventListener('visibilitychange', onVisChange);

    try {
      const videoStream = canvas.captureStream(30);
      const tracks = [...videoStream.getVideoTracks()];

      try {
        const cap = video.captureStream ? video.captureStream() : (video.mozCaptureStream ? video.mozCaptureStream() : null);
        if (cap && cap.getAudioTracks().length && !state.edit.muted) {
          tracks.push(...cap.getAudioTracks());
        }
      } catch (_) {}

      const combined = new MediaStream(tracks);
      const recOpts = chosenFmt.mime
        ? { mimeType: chosenFmt.mime, videoBitsPerSecond: 5000000 }
        : { videoBitsPerSecond: 5000000 };
      const rec = new MediaRecorder(combined, recOpts);
      const chunks = [];
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

      const clipSecs = Math.max(1.2, (state.endTime - state.startTime) / Math.max(0.5, state.edit.speed));
      const durMs = Math.min(120000, clipSecs * 1000);
      await new Promise(resolve => {
        let done = false;
        const fin = () => { if (!done) { done = true; resolve(); } };
        video.addEventListener('seeked', fin, { once: true });
        try { video.currentTime = state.startTime; } catch (_) { fin(); }
        setTimeout(fin, 1200);
      });
      await video.play().catch(() => {});
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      rec.start();

      const t0 = performance.now();
      const timer = setInterval(() => {
        const pct = Math.min(98, ((performance.now() - t0) / durMs) * 100);
        $('exportProgress').style.width = `${pct}%`;
      }, 100);

      await new Promise(r => setTimeout(r, durMs));
      clearInterval(timer);
      rec.stop();
      video.pause();
      syncPlayButtons();

      await new Promise(r => { rec.onstop = r; });
      const blobType = (chosenFmt.mime || 'video/webm').split(';')[0];
      const blob = new Blob(chunks, { type: blobType });
      state.lastExport = { blob, ext: chosenFmt.ext, title: (state.cuts[state.activeCutIdx] || {}).title || '' };
      const prevUrl = $('downloadExportBtn').href || '';
      if (prevUrl.startsWith('blob:')) { try { URL.revokeObjectURL(prevUrl); } catch (_) {} }
      const url = URL.createObjectURL(blob);
      $('exportProgress').style.width = '100%';
      if ($('exportTabWarn')) $('exportTabWarn').style.display = 'none';
      $('exportStatus').textContent = tabWasHidden
        ? `⚠️ Clip listo en ${chosenFmt.label}, pero cambiaste de pestaña durante el renderizado. Revisa la vista previa por si hubo algún fotograma congelado.`
        : `✅ Clip listo en ${chosenFmt.label}. Revísalo antes de descargarlo o publicarlo.`;
      $('exportedVideoPreview').src = url;
      $('exportedVideoPreview').style.display = 'block';
      $('downloadExportBtn').href = url;
      $('downloadExportBtn').download = `${state.videoName}_corte.${chosenFmt.ext}`;
      $('downloadExportBtn').textContent = `⬇️ Descargar Video (${chosenFmt.ext.toUpperCase()})`;
      $('downloadExportBtn').style.display = 'inline-flex';
      if ($('sendExportToTgBtn')) $('sendExportToTgBtn').style.display = 'inline-flex';
      if ($('openExportInViewerBtn')) $('openExportInViewerBtn').style.display = 'inline-flex';
      const activeCutObj = state.cuts[state.activeCutIdx] || {};
      registerViewerClip({
        source: 'studio',
        title: activeCutObj.title || `${state.videoName} (Exportado)`,
        blob,
        ext: chosenFmt.ext,
        dur: clipSecs,
        start: 0,
        end: clipSecs,
        aspect: state.aspect || '9:16',
        emotion: activeCutObj.emotion || '',
        reason: activeCutObj.reason || '',
        score: activeCutObj.score || 0,
        hasSubs: Boolean(state.showSubs && state.subtitles.length),
        transcript: (state.subtitles || []).map(s => s.text).join(' '),
        subtitles: state.subtitles || [],
        words: [],
        credit: state.sourceCredit || ''
      });
      if (autoSendToTelegram === true) {
        saveTelegramConfigFromUI(true);
        if (!isTelegramConfigured()) {
          $('exportStatus').textContent = '⚠️ Clip listo, pero falta configurar tu Bot Token y Chat ID en En Vivo & Radar → Radar & Telegram.';
          showToast('Configura tu Bot Token y Chat ID de Telegram primero', 'warn');
        } else {
          $('exportStatus').textContent = '✈️ Enviando clip renderizado a Telegram con subtítulos y audio...';
          try {
            await sendBlobToTelegram({
              blob,
              ext: chosenFmt.ext || 'mp4',
              title: activeCutObj.title || state.videoName || 'Clip ClipHub',
              emotion: activeCutObj.emotion || '',
              reason: activeCutObj.reason || '',
              score: activeCutObj.score || 0,
              transcript: (state.subtitles || []).map(s => s.text).join(' '),
              subs: state.subtitles || [],
              startOffset: state.startTime || 0,
              credit: state.sourceCredit || ''
            });
            pushTelegramHistory({ ok: true, title: activeCutObj.title || state.videoName || 'Clip', emotion: activeCutObj.emotion || '', time: new Date().toLocaleTimeString() });
            $('exportStatus').textContent = `✅ Clip renderizado en ${chosenFmt.label} y enviado a Telegram con éxito.`;
            showToast('✈️ Clip enviado a Telegram con subtítulos y audio', 'ok');
          } catch (tgErr) {
            $('exportStatus').textContent = `⚠️ Clip listo, pero Telegram devolvió error: ${tgErr.message}`;
            showToast(`Error Telegram: ${tgErr.message}`, 'warn');
          }
        }
      }
    } catch (err) {
      $('exportStatus').textContent = `⚠️ Error al renderizar el clip: ${err.message}`;
    } finally {
      document.removeEventListener('visibilitychange', onVisChange);
      if (wakeLock) { try { await wakeLock.release(); } catch (_) {} }
      state.isExporting = false;
    }
  }

  $('exportClipBtn').addEventListener('click', () => exportCurrentClip(false));
  $('edExportBtn').addEventListener('click', () => exportCurrentClip(false));
  $('studioSendTgBtn')?.addEventListener('click', () => exportCurrentClip(true));
  $('edSendTgBtn')?.addEventListener('click', () => exportCurrentClip(true));
  $('closeExportModal').addEventListener('click', () => $('exportModal').classList.remove('open'));

  
// ==================== CORTES DESDE ENLACE DE YOUTUBE (sin descargar) ====================
function ytId(url) {
  const s = String(url || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:[?&]v=|youtu\.be\/|\/live\/|\/shorts\/|\/embed\/|\/v\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}
function fmtT(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function mkBtn(label, fn) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn btn-sm'; b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

// ==================== CREADORES AUTORIZADOS Y CRÉDITOS ====================
state.sourceCredit = '';
function loadCreators() {
  try { return JSON.parse(safeGet('cliphub_creators', '[]') || '[]'); } catch (_) { return []; }
}
function renderCreators(selectName) {
  const sel = $('ytCreatorSelect');
  const keep = selectName || (sel.options[sel.selectedIndex] || {}).value || '';
  sel.textContent = '';
  const first = document.createElement('option');
  first.value = ''; first.textContent = '— elige un creador —';
  sel.appendChild(first);
  loadCreators().forEach(c => {
    const o = document.createElement('option');
    o.value = c.name; o.textContent = c.name;
    sel.appendChild(o);
  });
  sel.value = keep;
  if (sel.value !== keep) sel.value = '';
}
function getCreator() {
  const name = $('ytCreatorSelect').value;
  return loadCreators().find(c => c.name === name) || null;
}
function creatorCredit(creator, srcUrl) {
  if (!creator) return '';
  return `\n\n🎬 Contenido original: ${creator.name}${creator.url ? ' — ' + creator.url : ''}\n▶ Video completo: ${srcUrl}\n✅ Publicado con permiso del creador.`;
}
$('creatorAddBtn').addEventListener('click', () => {
  const name = $('creatorNameInput').value.trim();
  const url = $('creatorUrlInput').value.trim();
  if (!name) { showToast('Escribe el nombre del creador', 'warn'); return; }
  const list = loadCreators().filter(c => c.name !== name);
  list.push({ name, url, addedAt: new Date().toISOString().slice(0, 10) });
  safeSet('cliphub_creators', JSON.stringify(list));
  $('creatorNameInput').value = ''; $('creatorUrlInput').value = '';
  renderCreators(name);
  showToast(`${name} añadido a tus creadores autorizados`, 'ok');
});
$('creatorDelBtn').addEventListener('click', () => {
  const name = $('ytCreatorSelect').value;
  if (!name) return;
  safeSet('cliphub_creators', JSON.stringify(loadCreators().filter(c => c.name !== name)));
  renderCreators('');
});
renderCreators('');

function getYtGeminiKey() {
  const typed = ($('ytGeminiKeyInput').value || '').trim();
  if (typed) return typed;
  if (state.ai.provider === 'gemini' && (state.ai.apiKey || '').trim()) return state.ai.apiKey.trim();
  return (safeGet('cliphub_gemini_key', '') || '').trim();
}

function parseTs(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).trim();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  if (!/\d/.test(s)) return NaN;
  const parts = s.replace(/[^\d:.]/g, '').split(':').map(Number);
  if (!parts.length || parts.some(isNaN)) return NaN;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}
function extractCuts(txt) {
  const clean = String(txt || '').replace(/```json|```/gi, '').trim();
  try {
    const m = clean.match(/[\[{][\s\S]*[\]}]/);
    const o = JSON.parse(m ? m[0] : clean);
    const arr = Array.isArray(o) ? o : (o.cuts || o.clips || o.moments);
    if (Array.isArray(arr) && arr.length) return arr;
  } catch (_) {}
  const out = []; // JSON cortado o roto: rescata los objetos sueltos
  (clean.match(/\{[^{}]*\}/g) || []).forEach(s => {
    try { const o = JSON.parse(s); if (o && ('start' in o || 'start_time' in o)) out.push(o); } catch (_) {}
  });
  return out;
}

async function callYtGemini(model, key, id, range, flags) {
  const part = { fileData: { fileUri: `https://www.youtube.com/watch?v=${id}` } };
  if (range) part.videoMetadata = { startOffset: `${Math.floor(range.from)}s`, endOffset: `${Math.floor(range.to)}s` };
  const timeRule = range
    ? ' IMPORTANTE: solo ves un fragmento del video; da los tiempos en segundos RELATIVOS al inicio de ese fragmento (0 = inicio del fragmento).'
    : ' Usa tiempos EXACTOS en segundos desde el inicio del video.';
  const activeEmos = getSelectedEmotionsText();
  const desiredDur = Math.max(5, Math.min(180, Number($('ytCutDurInput')?.value) || state.cutDuration || 45));
  const maxDur = Math.min(180, desiredDur + 15);
  const prompt = `Eres editor experto en retención para YouTube Shorts, Reels y TikTok. Mira este video y elige los 5 momentos más ÉPICOS, cada uno con una duración cercana a ${desiredDur} segundos (mínimo ${Math.max(5, desiredDur - 10)} s, máximo ${maxDur} s), buscando específicamente: ${activeEmos}.${timeRule} Escribe "start" y "end" como números (segundos) y clasifica "emotion" usando una de estas claves: ${EMOTION_KEYS_STR}. Responde SOLO con JSON: {"cuts":[{"title":"título viral en español","hookText":"2-4 PALABRAS","emotion":"risa","score":95,"start":0,"end":${desiredDur},"reason":"por qué atrapa","caption":"descripción corta con hashtags"}]}`;
  const gen = { responseMimeType: 'application/json' };
  if (flags.res) gen.mediaResolution = 'MEDIA_RESOLUTION_LOW';
  if (flags.schema) {
    gen.responseSchema = { type: 'OBJECT', properties: { cuts: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      title: { type: 'STRING' }, hookText: { type: 'STRING' }, emotion: { type: 'STRING' }, score: { type: 'NUMBER' },
      start: { type: 'NUMBER' }, end: { type: 'NUMBER' }, reason: { type: 'STRING' }, caption: { type: 'STRING' }
    }, required: ['title', 'start', 'end'] } } }, required: ['cuts'] };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 300000);
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts: [part, { text: prompt }] }], generationConfig: gen })
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `${model}: tiempo agotado (5 min)` : `${model}: no hubo conexión con Google (${e.message})`);
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${model}: ${res.status} ${(data.error && data.error.message) || ''}`.trim());
  if (data.promptFeedback && data.promptFeedback.blockReason) throw new Error(`${model}: bloqueado (${data.promptFeedback.blockReason})`);
  const cand = (data.candidates || [])[0];
  const txt = ((cand && cand.content && cand.content.parts) || []).map(x => x.text || '').join('');
  if (!txt.trim()) throw new Error(`${model}: respuesta vacía (${(cand && cand.finishReason) || 'sin motivo'})`);
  const off = range ? range.from : 0;
  return extractCuts(txt).map(c => {
    const s = parseTs(c.start != null ? c.start : (c.start_time != null ? c.start_time : c.startTime)) + off;
    let e = parseTs(c.end != null ? c.end : (c.end_time != null ? c.end_time : c.endTime)) + off;
    const ytDur = Math.max(5, Math.min(180, Number($('ytCutDurInput')?.value) || state.cutDuration || 45));
    if (isFinite(s) && (!isFinite(e) || e <= s)) e = s + ytDur;
    return { title: c.title || 'Corte', hookText: c.hookText || '', emotion: normalizeEmotion(c.emotion), score: Number(c.score) || 0, start: s, end: Math.min(e, s + 185), reason: c.reason || '', caption: c.caption || '' };
  }).filter(c => isFinite(c.start) && c.start >= 0 && c.end - c.start >= 3);
}

async function analyzeYtRange(range, key, id, models, flags, onStatus) {
  let lastErr = '';
  for (let pass = 0; pass < 2; pass++) {
    for (let mi = 0; mi < models.length; mi++) {
      onStatus(`Analizando con ${models[mi]}${range ? ` (min ${Math.floor(range.from / 60)}–${Math.floor(range.to / 60)})` : ''}...`);
      try {
        const cuts = await callYtGemini(models[mi], key, id, range, flags);
        if (cuts.length) return { cuts };
        lastErr = `${models[mi]}: no devolvió cortes válidos`;
      } catch (err) {
        lastErr = String(err.message || err);
        console.warn('Cortes YouTube:', lastErr);
        if (flags.res && /media.?resolution/i.test(lastErr)) { flags.res = false; mi--; continue; }
        if (flags.schema && /schema/i.test(lastErr)) { flags.schema = false; mi--; continue; }
        if (/API key|API_KEY|PERMISSION_DENIED|UNAUTHENTICATED|\b401\b|\b403\b/i.test(lastErr)) return { err: lastErr, fatal: true };
      }
    }
    if (pass === 0 && /429|503|quota|RESOURCE_EXHAUSTED|UNAVAILABLE|high demand|overloaded|saturad/i.test(lastErr)) {
      onStatus('Google está saturado; reintento en 12 s...');
      await new Promise(r => setTimeout(r, 12000));
    } else break;
  }
  return { err: lastErr };
}

async function generateYtCuts() {
  const id = ytId($('ytUrlInput').value);
  const list = $('ytCutsList');
  const fail = msg => { list.textContent = `⚠️ ${msg}`; showToast(msg.slice(0, 120), 'warn'); };
  if (!id) { fail('Pega un enlace válido de YouTube (watch?v=, youtu.be/, live/ o shorts/).'); return; }
  // El creador es opcional: si eliges uno se añaden sus créditos automáticamente
  const key = getYtGeminiKey();
  if (!key) { fail('Falta la clave de Gemini: pégala en el campo de al lado del botón (se guarda en tu navegador). Se crea gratis en aistudio.google.com/apikey.'); return; }
  safeSet('cliphub_gemini_key', key);

  const chosen = /^(models\/)?gemini-(3|flash|pro)/i.test(state.ai.model || '') ? state.ai.model.replace(/^models\//, '') : '';
  const models = [...new Set([chosen, 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.5-flash'].filter(Boolean))];
  const flags = { res: true, schema: true };
  const fromMin = parseFloat($('ytFromMin').value), toMin = parseFloat($('ytToMin').value);
  const userRange = (isFinite(fromMin) || isFinite(toMin)) ? { from: Math.max(0, (isFinite(fromMin) ? fromMin : 0) * 60), to: (isFinite(toMin) ? toMin : (isFinite(fromMin) ? fromMin : 0) + 30) * 60 } : null;
  if (userRange && userRange.to <= userRange.from) { fail('El minuto final debe ser mayor que el inicial.'); return; }

  const btn = $('ytAiCutsBtn');
  btn.disabled = true;
  const t0 = Date.now();
  let status = 'Preparando...';
  list.textContent = status;
  const tick = setInterval(() => { list.textContent = `${status}  (${Math.round((Date.now() - t0) / 1000)} s)`; }, 1000);
  const setStatus = s => { status = s; };
  try {
    let result = await analyzeYtRange(userRange, key, id, models, flags, setStatus);
    if (!result.cuts && !userRange && !result.fatal && /token|exceed|too long|too large|maximum|context|quota|RESOURCE_EXHAUSTED/i.test(result.err || '')) {
      setStatus('Video largo: lo analizo por partes de 25 min...');
      const all = [];
      let lastE = result.err;
      for (let w = 0; w < 4; w++) {
        const r = await analyzeYtRange({ from: w * 1500, to: (w + 1) * 1500 }, key, id, models, flags, setStatus);
        if (r.cuts) all.push(...r.cuts); else { lastE = r.err; if (all.length || r.fatal) break; }
      }
      result = all.length ? { cuts: all } : { err: lastE };
    }
    if (!result.cuts) {
      const e = result.err || 'error desconocido';
      let hint = '';
      if (/API key|API_KEY|PERMISSION_DENIED|UNAUTHENTICATED|\b401\b|\b403\b/i.test(e)) hint = ' Revisa que la clave de Gemini sea correcta y esté activa.';
      else if (/quota|429|RESOURCE_EXHAUSTED/i.test(e)) hint = ' Superaste la cuota gratuita de Google; espera unos minutos o usa "Analizar solo" con un tramo más corto.';
      else if (/private|not found|unavailable|INVALID_ARGUMENT|\b400\b|\b404\b/i.test(e)) hint = ' El video debe ser público (no privado, no con restricción de edad) y no estar en directo en este momento.';
      else if (/conexión|tiempo agotado/i.test(e)) hint = ' Revisa tu conexión e inténtalo de nuevo.';
      fail(`No se pudieron generar los cortes. ${e}.${hint}`);
      return;
    }
    const cuts = result.cuts.sort((x, y) => y.score - x.score).slice(0, 10);
    list.textContent = '';
    const creator = getCreator();
    const rows = [];
    cuts.forEach((c, i) => {
      const s0 = Math.max(0, Math.floor(c.start));
      const e0 = Math.max(s0 + 5, Math.ceil(c.end));
      const card = document.createElement('div');
      card.style.cssText = 'padding:10px;border:1px solid var(--border);border-radius:10px;';
      const h = document.createElement('div');
      h.style.fontWeight = '700';
      h.textContent = `${i + 1}. ${c.emotion ? '[' + emotionLabel(c.emotion) + '] ' : ''}${c.title}  ·  ⭐ ${c.score || ''}`;
      const r = document.createElement('div');
      r.className = 'muted'; r.textContent = c.reason;
      const ok = document.createElement('input'); ok.type = 'checkbox';
      const okLab = document.createElement('label'); okLab.append(ok, ' Aprobar');
      const sIn = document.createElement('input'); sIn.type = 'number'; sIn.min = 0; sIn.value = s0; sIn.style.width = '80px';
      const eIn = document.createElement('input'); eIn.type = 'number'; eIn.min = 0; eIn.value = e0; eIn.style.width = '80px';
      const times = document.createElement('div');
      times.className = 'row'; times.style.cssText = 'margin-top:6px;align-items:center;';
      times.append('Inicio (s)', sIn, 'Fin (s)', eIn, okLab);
      const cur = () => {
        const s = Math.max(0, Math.floor(Number(sIn.value) || 0));
        return { s, e: Math.max(s + 3, Math.ceil(Number(eIn.value) || s + 30)) };
      };
      const link = () => `https://youtu.be/${id}?t=${cur().s}`;
      const descr = () => `${c.title}\n\n${c.caption}${creatorCredit(creator, link())}`;
      const mk = () => { const t2 = cur(); return { id, s: t2.s, e: t2.e, title: c.title, emotion: c.emotion || '', reason: c.reason || '', score: c.score || 0, caption: c.caption || '', link: link(), creator }; };
      const row = document.createElement('div');
      row.className = 'row'; row.style.marginTop = '6px';
      row.append(
        mkBtn('▶ Previsualizar', () => {
          const t2 = cur();
          const originP = location.protocol !== 'file:' ? `&origin=${encodeURIComponent(location.origin)}` : '';
          $('ytCutPreviewIframe').src = `https://www.youtube.com/embed/${id}?start=${t2.s}&end=${t2.e}&autoplay=1&rel=0${originP}`;
          if ($('ytCutPreviewTitle')) $('ytCutPreviewTitle').textContent = `▶ Vista previa: ${c.title} (${fmtT(t2.s)} → ${fmtT(t2.e)})`;
          $('ytCutPreviewWrap').style.display = 'block';
          $('ytCutPreviewWrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }),
        mkBtn('⚡ Descargar, Cortar y Subtitular', () => processYtClipsViaBackend([mk()], { autoTg: false })),
        mkBtn('🎥 Grabar pantalla', () => recordYtClips([mk()])),
        mkBtn('↗ Abrir en YouTube', () => window.open(link(), '_blank', 'noopener')),
        mkBtn('🔗 Copiar enlace con tiempo', () => { copyTextSafe(link()); showToast('Enlace copiado', 'ok'); }),
        mkBtn('📋 Copiar descripción con créditos', () => { copyTextSafe(descr()); showToast('Descripción copiada', 'ok'); })
      );
      card.append(h, r, times, row);
      list.appendChild(card);
      rows.push({ ok, cur, link, descr, mk });
    });
    list.appendChild(mkBtn('📋 Copiar todos los aprobados', () => {
      const sel = rows.filter(x => x.ok.checked);
      if (!sel.length) { showToast('Marca al menos un corte como "Aprobar"', 'warn'); return; }
      copyTextSafe(sel.map((x, n) => `${n + 1}. ${fmtT(x.cur().s)}–${fmtT(x.cur().e)}  ${x.link()}\n${x.descr()}`).join('\n\n-----\n\n'));
      showToast(`${sel.length} cortes aprobados copiados`, 'ok');
    }));
    list.appendChild(mkBtn('⚡ Descargar y Cortar todos los aprobados (Auto)', () => processYtClipsViaBackend(rows.filter(x => x.ok.checked).map(x => x.mk()), { autoTg: false })));
    list.appendChild(mkBtn('🎥 Grabar aprobados en pantalla', () => recordYtClips(rows.filter(x => x.ok.checked).map(x => x.mk()))));
    showToast(`${cuts.length} cortes generados desde el enlace`, 'ok');
  } catch (err) {
    fail(`Error inesperado: ${err && err.message ? err.message : err}`);
  } finally {
    clearInterval(tick);
    btn.disabled = false;
  }
}
$('ytGeminiKeyInput').value = (state.ai.provider === 'gemini' && state.ai.apiKey) ? state.ai.apiKey : (safeGet('cliphub_gemini_key', '') || '');
$('ytAiCutsBtn').addEventListener('click', generateYtCuts);

// ==================== CORTES DE DIRECTOS (captura de pestaña con búfer de 5 min) ====================
// Grabadoras solapadas: cada una guarda TODO lo que lleva grabado (archivo válido); una nueva empieza cada 3 min
// y las viejas se detienen a los 6 min, así siempre hay al menos 3 min de historial sin recortar trozos.
const EMOTION_CATALOG = {
  risa: { label: '😂 Risa / Chiste', desc: 'momentos graciosos, carcajadas, chistes, burlas o humor' },
  feliz: { label: '😊 Felicidad / Logro', desc: 'momentos felices, alegría genuina, logros o euforia' },
  fiesta: { label: '🎉 Fiesta / Baile', desc: 'momentos de fiesta, baile, música, brindis, coros o ambiente prendido' },
  pelea: { label: '🤬 Discusión / Pelea', desc: 'discusiones intensas, peleas, enojo, gritos o conflictos' },
  serio: { label: '😐 Momento Serio', desc: 'conversaciones serias, temas profundos, confesiones honestas o anuncios importantes' },
  reflexion: { label: '🧠 Reflexión', desc: 'momentos de reflexión, pensamiento profundo, análisis de vida o madurez' },
  tristeza: { label: '😢 Tristeza / Emotivo', desc: 'momentos tristes, nostalgia, llanto, desahogo o vulnerabilidad' },
  sorpresa: { label: '😱 Sorpresa / Shock', desc: 'reacciones de sorpresa, sustos, giros inesperados, asombro o shock' },
  reaccion: { label: '🤯 Reacción / Fail', desc: 'reacciones épicas, caras/gestos exagerados, fails, bloopers o momentos incómodos' },
  salseo: { label: '👀 Chisme / Polémica', desc: 'chismes, revelaciones picantes, indirectas, tiraderas o polémica' },
  inspiracion: { label: '💡 Motivación / Consejo', desc: 'consejos potentes, frases motivadoras, enseñanzas o superación personal' },
  amor: { label: '❤️ Cariño / Tierno', desc: 'momentos tiernos, abrazos, romance, gratitud o muestras de cariño' }
};
const EMOTION_KEYS_STR = Object.keys(EMOTION_CATALOG).join('|');
const selectedEmotions = new Set(Object.keys(EMOTION_CATALOG));

function normalizeEmotion(val) {
  const s = String(val || '').toLowerCase();
  if (/fiest|bail|rumba|party|brind|music|celebr/.test(s)) return 'fiesta';
  if (/seri|grave|formal|anunci|confes|sincer/.test(s)) return 'serio';
  if (/sorpres|shock|sust|asombr|inesper|impact/.test(s)) return 'sorpresa';
  if (/salse|chism|polem|tirader|indirect|revel|picant/.test(s)) return 'salseo';
  if (/inspir|motiv|consej|lecci|superac|enseñ/.test(s)) return 'inspiracion';
  if (/reacc|fail|bloop|incomod|verguenz|cringe|epico/.test(s)) return 'reaccion';
  if (/amor|cariñ|tiern|romanc|abraz|gratit/.test(s)) return 'amor';
  if (/risa|chiste|grac|humor|divert|broma/.test(s)) return 'risa';
  if (/feliz|alegr|logr|eufor/.test(s)) return 'feliz';
  if (/pelea|discus|enoj|drama|tens|conflic/.test(s)) return 'pelea';
  if (/trist|llor|dolor|emotiv|nostalg|desahog/.test(s)) return 'tristeza';
  if (/reflex|sabid|filosof|pens|profund/.test(s)) return 'reflexion';
  return '';
}
function emotionLabel(key) {
  return (EMOTION_CATALOG[key] && EMOTION_CATALOG[key].label) || '🔥 Momento Épico';
}
function getSelectedEmotionsText() {
  const list = [...selectedEmotions].map(k => EMOTION_CATALOG[k]?.desc).filter(Boolean);
  return list.length ? list.join('; ') : 'todas las reacciones: risas, fiesta, momentos serios, reflexión, pelea, sorpresa, chisme, tristeza, motivación y cariño';
}
function syncEmotionPillsUI() {
  document.querySelectorAll('#epicEmotionPills .emo-pill').forEach(pill => {
    pill.classList.toggle('active', selectedEmotions.has(pill.dataset.emo));
  });
}
function applyEmotionPreset(keys, msg) {
  selectedEmotions.clear();
  keys.forEach(k => { if (EMOTION_CATALOG[k]) selectedEmotions.add(k); });
  syncEmotionPillsUI();
  showToast(msg, 'ok');
}
$('emoSelectAllBtn')?.addEventListener('click', () => applyEmotionPreset(Object.keys(EMOTION_CATALOG), 'Todas las reacciones y momentos activados (12)'));
$('emoPresetPartyBtn')?.addEventListener('click', () => applyEmotionPreset(['risa', 'feliz', 'fiesta', 'sorpresa', 'reaccion', 'salseo'], 'Preset activado: Fiesta, Risas y Reacciones'));
$('emoPresetDeepBtn')?.addEventListener('click', () => applyEmotionPreset(['serio', 'reflexion', 'tristeza', 'inspiracion', 'amor'], 'Preset activado: Serio, Reflexión y Emotivo'));

document.querySelectorAll('#epicEmotionPills .emo-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    const emo = pill.dataset.emo;
    if (selectedEmotions.has(emo)) {
      if (selectedEmotions.size === 1) { showToast('Deja al menos una categoría activa', 'warn'); return; }
      selectedEmotions.delete(emo);
      pill.classList.remove('active');
    } else {
      selectedEmotions.add(emo);
      pill.classList.add('active');
    }
  });
});

const liveCapture = {
  stream: null, recs: [], timer: null, rotTimer: null, clips: [],
  audioCtx: null, analyser: null, meterRaf: null,
  epicTimer: null, epicAudioRec: null, epicAudioChunks: [],
  epicBusy: false, lastAutoCutAt: 0, baselineVoice: 18,
  peakStartAt: 0, peakInWindow: 0, postRollTimer: null,
  prevTranscript: ''
};

const LIVE_FORMATS = [
  { id: 'vp8', label: 'WebM VP8 (Recomendado en vivo)', mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
  { id: 'vp9', label: 'WebM VP9 (Alta calidad)', mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { id: 'mp4', label: 'MP4 (H.264 Main)', mime: 'video/mp4;codecs=avc1.4D4028,mp4a.40.2', ext: 'mp4' },
  { id: 'mp4b', label: 'MP4 (genérico)', mime: 'video/mp4', ext: 'mp4' }
].filter(f => { try { return MediaRecorder.isTypeSupported(f.mime); } catch (_) { return false; } });
if (!LIVE_FORMATS.length) LIVE_FORMATS.push({ id: 'auto', label: 'Automático', mime: '', ext: 'webm' });
LIVE_FORMATS.forEach(f => {
  const o = document.createElement('option');
  o.value = f.id; o.textContent = f.label;
  $('liveFormat').appendChild(o);
});

function liveSpawnRecorder() {
  const stream = liveCapture.stream;
  if (!stream) return;
  const fmt = LIVE_FORMATS.find(f => f.id === $('liveFormat').value) || LIVE_FORMATS[0];
  // 2.4 Mbps + 128 kbps audio: imagen nítida con la mitad de RAM/CPU y clips de 90s seguros para Telegram (<50 MB)
  const opts = fmt.mime
    ? { mimeType: fmt.mime, videoBitsPerSecond: 2400000, audioBitsPerSecond: 128000 }
    : { videoBitsPerSecond: 2400000, audioBitsPerSecond: 128000 };
  const rec = new MediaRecorder(stream, opts);
  const r = { rec, chunks: [], t0: Date.now(), fmt };
  rec.ondataavailable = e => { if (e.data && e.data.size) r.chunks.push(e.data); };
  rec.start(1000);
  liveCapture.recs.push(r);
  liveCapture.recs = liveCapture.recs.filter(x => {
    if (Date.now() - x.t0 > 300000 && liveCapture.recs.length > 1) {
      try { x.rec.stop(); } catch (_) {}
      x.chunks = [];
      return false;
    }
    return true;
  });
}
async function liveStart(here) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    showToast('Tu navegador no permite capturar pestañas (usa Chrome o Edge de escritorio)', 'warn');
    return;
  }
  try {
    let stream;
    if (here) {
      const id = ytId($('ytUrlInput').value);
      if (!id) { showToast('Pega primero el enlace del directo en el campo de YouTube', 'warn'); return; }
      const fr = $('ytIframe');
      fr.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
      const w = Math.min((fr.parentElement && fr.parentElement.clientWidth) || 800, 960);
      fr.style.width = w + 'px';
      fr.style.height = Math.round(w * 9 / 16) + 'px';
      const liveOrigin = location.protocol !== 'file:' ? `&origin=${encodeURIComponent(location.origin)}` : '';
      fr.src = `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1&rel=0${liveOrigin}`;
      $('ytEmbedWrap').style.display = 'block';
      fr.scrollIntoView({ block: 'center' });
      await new Promise(r => setTimeout(r, 900));
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30, displaySurface: 'browser' }, audio: true,
        preferCurrentTab: true, selfBrowserSurface: 'include'
      });
      try {
        const vt = stream.getVideoTracks()[0];
        if (window.CropTarget && vt.cropTo) { await vt.cropTo(await CropTarget.fromElement(fr)); }
        else showToast('Tu navegador no recorta al reproductor: se captura toda la pestaña', 'warn');
      } catch (e) {
        console.warn('Recorte al reproductor no disponible:', e);
        showToast('Se captura toda la pestaña (no se pudo recortar al reproductor)', 'warn');
      }
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    }
    if (!stream.getAudioTracks().length) showToast('No se capturó audio: al elegir la pestaña marca "Compartir audio de la pestaña"', 'warn');
    liveCapture.stream = stream;
    liveCapture.recs = [];
    stream.getVideoTracks()[0].addEventListener('ended', liveStop);
    liveSpawnRecorder();
    liveCapture.rotTimer = setInterval(liveSpawnRecorder, 150000);
    $('liveStartBtn').style.display = 'none';
    $('liveHereBtn').style.display = 'none';
    $('liveStopBtn').style.display = 'inline-flex';
    if ($('liveHudBar')) $('liveHudBar').classList.add('active');
    $('liveStatus').textContent = '🔴 Capturando' + (here ? ' el reproductor de esta página' : '') + '. No minimices la ventana ni cambies el tamaño del reproductor. Cuando pase algo, pulsa "✂️ Sacar Corte del Directo" (hasta 3 min hacia atrás). Si el directo no arranca, pulsa play en el reproductor.';
    liveApplyAuto();
    startLiveEpicRadar();
  } catch (err) {
    showToast('No se inició la captura: ' + (err.message || err), 'warn');
  }
}
function loadRadarPrefs() {
  try {
    const saved = JSON.parse(safeGet('cliphub_radar_cfg', 'null'));
    if (saved && typeof saved === 'object') {
      if ($('liveEpicMinScore') && saved.minScore) $('liveEpicMinScore').value = String(saved.minScore);
      if ($('liveEpicContext') && saved.context) $('liveEpicContext').value = saved.context;
      if ($('liveEpicKeywords') && saved.keywords) $('liveEpicKeywords').value = saved.keywords;
    }
  } catch (_) {}
}
function saveRadarPrefs() {
  safeSet('cliphub_radar_cfg', JSON.stringify({
    minScore: $('liveEpicMinScore')?.value || '75',
    context: ($('liveEpicContext')?.value || '').trim(),
    keywords: ($('liveEpicKeywords')?.value || '').trim()
  }));
}
['liveEpicMinScore', 'liveEpicContext', 'liveEpicKeywords'].forEach(id => {
  $(id)?.addEventListener('change', saveRadarPrefs);
  $(id)?.addEventListener('input', saveRadarPrefs);
});
loadRadarPrefs();

function findMatchedKeywords(text) {
  const raw = ($('liveEpicKeywords')?.value || '').trim();
  if (!raw || !text) return [];
  const lower = text.toLowerCase();
  return raw.split(',').map(k => k.trim()).filter(k => k.length >= 2 && lower.includes(k.toLowerCase()));
}

function stopLiveEpicRadar() {
  if (liveCapture.meterRaf) clearInterval(liveCapture.meterRaf);
  clearInterval(liveCapture.epicTimer);
  clearTimeout(liveCapture.postRollTimer);
  try { if (liveCapture.epicAudioRec && liveCapture.epicAudioRec.state !== 'inactive') liveCapture.epicAudioRec.stop(); } catch (_) {}
  try { if (liveCapture.audioCtx) liveCapture.audioCtx.close(); } catch (_) {}
  Object.assign(liveCapture, {
    audioCtx: null, analyser: null, meterRaf: null,
    epicTimer: null, epicAudioRec: null, epicAudioChunks: [],
    epicBusy: false, peakStartAt: 0, peakInWindow: 0,
    postRollTimer: null, prevTranscript: ''
  });
  if ($('liveAudioMeter')) $('liveAudioMeter').style.width = '0%';
  if ($('liveRadarBadge')) { $('liveRadarBadge').textContent = 'En espera'; $('liveRadarBadge').className = 'badge'; }
}

function startLiveEpicRadar() {
  stopLiveEpicRadar();
  const mode = $('liveEpicMode') ? $('liveEpicMode').value : 'off';
  const stream = liveCapture.stream;
  if (!stream || mode === 'off') {
    if ($('liveRadarStatus')) $('liveRadarStatus').textContent = 'Radar desactivado. Usa "✂️ Sacar Corte del Directo" manualmente.';
    return;
  }
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    if ($('liveRadarBadge')) { $('liveRadarBadge').textContent = 'Sin audio'; $('liveRadarBadge').className = 'badge amber'; }
    if ($('liveRadarStatus')) $('liveRadarStatus').textContent = '⚠️ No se detectó audio en la captura. Marca "Compartir audio" para activar el radar épico.';
    return;
  }

  // 1. Monitor de frecuencias de VOZ HUMANA (300 Hz - 3,400 Hz) + duración sostenida + post-roll 8s
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ac = new AudioCtx();
    const src = ac.createMediaStreamSource(new MediaStream(audioTracks));
    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    src.connect(analyser);
    liveCapture.audioCtx = ac;
    liveCapture.analyser = analyser;
    liveCapture.baselineVoice = 18;
    liveCapture.peakStartAt = 0;
    liveCapture.peakInWindow = 0;

    const binHz = ac.sampleRate / analyser.fftSize;
    const voiceLowBin = Math.max(1, Math.floor(300 / binHz));
    const voiceHighBin = Math.min(analyser.frequencyBinCount - 1, Math.ceil(3400 / binHz));
    const freqBuf = new Uint8Array(analyser.frequencyBinCount);

    const tickMeter = () => {
      if (!liveCapture.analyser || !liveCapture.stream) return;
      analyser.getByteFrequencyData(freqBuf);
      let sum = 0;
      const count = Math.max(1, voiceHighBin - voiceLowBin + 1);
      for (let i = voiceLowBin; i <= voiceHighBin; i++) {
        sum += freqBuf[i];
      }
      const voiceEnergy = sum / count; // 0..255 solo en banda de voz humana (ignora bajos de música/golpes)
      liveCapture.baselineVoice = liveCapture.baselineVoice * 0.985 + Math.max(8, voiceEnergy) * 0.015;
      const ratio = voiceEnergy / Math.max(12, liveCapture.baselineVoice);
      if (ratio > liveCapture.peakInWindow) liveCapture.peakInWindow = ratio;

      const pct = Math.min(100, Math.round((voiceEnergy / 135) * 100));
      if ($('liveAudioMeter')) $('liveAudioMeter').style.width = pct + '%';
      if ($('hudAudioMeter')) $('hudAudioMeter').style.width = pct + '%';

      // Modo Solo Picos de Audio ($0) o respaldo si faltan claves IA
      const curMode = $('liveEpicMode')?.value || 'off';
      const hasAiStack = Boolean((state.ai.groqKey || '').trim() || hasProxy()) && Boolean((state.ai.apiKey || '').trim() || getYtGeminiKey() || hasProxy());
      if (curMode === 'audio' || (curMode === 'ai' && !hasAiStack)) {
        const now = Date.now();
        if (voiceEnergy > 42 && ratio > 1.85) {
          if (!liveCapture.peakStartAt) liveCapture.peakStartAt = now;
          // Exigir al menos 850 ms sostenidos en banda de voz (filtra toses, aplausos sueltos y golpes de micro)
          if (now - liveCapture.peakStartAt >= 850 && !liveCapture.postRollTimer && now - liveCapture.lastAutoCutAt > 35000) {
            liveCapture.peakStartAt = 0;
            liveCapture.lastAutoCutAt = now;
            if ($('liveRadarBadge')) { $('liveRadarBadge').textContent = '⏳ Post-roll 8s'; $('liveRadarBadge').className = 'badge amber'; }
            if ($('liveRadarStatus')) $('liveRadarStatus').textContent = '🔥 Pico de voz sostenido detectado. Esperando 8 s para capturar la reacción completa...';
            liveCapture.postRollTimer = setTimeout(() => {
              liveCapture.postRollTimer = null;
              if (!liveCapture.stream) return;
              liveCutNow(Number($('liveSecs').value) || 45, true, {
                emotion: 'feliz',
                title: 'Reacción / risas / momento intenso en vivo',
                reason: 'Pico sostenido en frecuencias de voz humana (+8 s de reacción completa)',
                score: 88
              });
              if ($('liveRadarBadge')) { $('liveRadarBadge').textContent = '⚡ Radar Voz ($0)'; $('liveRadarBadge').className = 'badge green'; }
              if ($('liveRadarStatus')) $('liveRadarStatus').textContent = '✅ Corte guardado con reacción completa. Siguiendo la escucha en banda de voz...';
            }, 8000);
          }
        } else if (voiceEnergy < 34) {
          liveCapture.peakStartAt = 0;
        }
      }
    };
    // 10 fps (cada 100 ms) en vez de 60 fps: reduce en ~80% el uso de CPU del medidor de voz
    liveCapture.meterRaf = setInterval(tickMeter, 100);
  } catch (e) {
    console.warn('No se pudo iniciar el medidor de audio:', e);
  }

  // 2. Escucha inteligente por ventanas con Memoria + Timestamps exactos + Palabras gatillo + Antiduplicados
  const canGroq = Boolean((state.ai.groqKey || '').trim() || hasProxy());
  const canLlm = Boolean((state.ai.apiKey || '').trim() || getYtGeminiKey() || hasProxy());
  if (mode === 'ai' && canGroq && canLlm) {
    const secInterval = Math.max(20, Number($('liveEpicInterval')?.value || 30));
    if ($('liveRadarBadge')) { $('liveRadarBadge').textContent = '🧠 Escuchando IA'; $('liveRadarBadge').className = 'badge green'; }
    if ($('liveRadarStatus')) $('liveRadarStatus').textContent = `Analizando voz y emociones cada ${secInterval} s (con memoria de contexto y recorte exacto)...`;

    const audioStream = new MediaStream(audioTracks);
    const audioMime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(m => {
      try { return MediaRecorder.isTypeSupported(m); } catch (_) { return false; }
    }) || '';

    const startAudioChunk = () => {
      if (!liveCapture.stream) return;
      liveCapture.epicAudioChunks = [];
      try {
        const rec = new MediaRecorder(audioStream, audioMime ? { mimeType: audioMime } : {});
        rec.ondataavailable = e => { if (e.data && e.data.size) liveCapture.epicAudioChunks.push(e.data); };
        rec.start();
        liveCapture.epicAudioRec = rec;
      } catch (e) { console.warn('epicAudioRec:', e); }
    };

    const analyzeLiveWindow = async () => {
      if (!liveCapture.stream || liveCapture.epicBusy || !liveCapture.epicAudioRec) return;
      liveCapture.epicBusy = true;
      const peakRatio = liveCapture.peakInWindow || 1;
      liveCapture.peakInWindow = 0;

      try {
        const oldRec = liveCapture.epicAudioRec;
        const blob = await new Promise(res => {
          oldRec.onstop = () => res(new Blob(liveCapture.epicAudioChunks, { type: audioMime || 'audio/webm' }));
          try { if (oldRec.state !== 'inactive') oldRec.stop(); else res(null); } catch (_) { res(null); }
        });
        startAudioChunk();
        if (!blob || blob.size < 4000) return;

        if ($('liveRadarBadge')) { $('liveRadarBadge').textContent = '⏳ Analizando...'; $('liveRadarBadge').className = 'badge amber'; }
        const ext = (audioMime || '').includes('mp4') ? 'mp4' : 'webm';
        const form = new FormData();
        form.append('file', blob, `live.${ext}`);
        form.append('model', 'whisper-large-v3-turbo');
        form.append('response_format', 'verbose_json');
        form.append('timestamp_granularities[]', 'segment');
        form.append('timestamp_granularities[]', 'word');
        const proxy = getActiveProxy();
        const endpoint = proxy ? `${proxy}/api/transcribe` : 'https://api.groq.com/openai/v1/audio/transcriptions';
        const headers = proxy ? getProxyHeaders() : { Authorization: `Bearer ${(state.ai.groqKey || '').trim()}` };
        const wRes = await fetchWithBackoff(endpoint, { method: 'POST', headers, body: form }, 1);
        const wData = await wRes.json().catch(() => ({}));
        const transcript = String(wData.text || '').trim();
        const rawSegs = Array.isArray(wData.segments) ? wData.segments : [];
        const rawWords = Array.isArray(wData.words) ? wData.words : [];

        if (transcript.length < 15) {
          if ($('liveRadarStatus')) $('liveRadarStatus').textContent = 'Sin diálogo relevante en el último bloque. Siguiendo la escucha...';
          return;
        }

        // Guardar memoria de contexto de los últimos ~20 s para el siguiente bloque
        const prevContext = liveCapture.prevTranscript || '';
        const tailSegs = rawSegs.filter(s => Number(s.end || 0) >= Math.max(0, secInterval - 20));
        liveCapture.prevTranscript = (tailSegs.length ? tailSegs.map(s => String(s.text || '').trim()).join(' ') : transcript).slice(-450);

        const segLines = rawSegs.length
          ? rawSegs.map(s => `[${Number(s.start || 0).toFixed(1)}s-${Number(s.end || 0).toFixed(1)}s] ${String(s.text || '').trim()}`).join('\n')
          : `[0.0s-${secInterval.toFixed(1)}s] ${transcript}`;

        const matchedKws = findMatchedKeywords(transcript);
        const userCtx = ($('liveEpicContext')?.value || '').trim();
        const energyDesc = peakRatio > 1.9 ? 'ALTA en banda de voz (posibles risas, gritos o discusión)'
          : peakRatio < 1.25 ? 'CALMA/SUAVE (posible reflexión o momento emotivo)'
          : 'NORMAL';

        const prompt = `Eres director de clips virales (TikTok/Shorts/Reels). Analiza este bloque recién dicho en un directo (duración ${secInterval}s) y decide si contiene un MOMENTO ÉPICO.
${userCtx ? `Contexto del directo: ${userCtx}\n` : ''}Emociones buscadas: ${getSelectedEmotionsText()}.
Energía de voz: ${energyDesc}.
${matchedKws.length ? `Palabras gatillo detectadas (priorizar): ${matchedKws.join(', ')}\n` : ''}${prevContext ? `Contexto previo (solo referencia para entender chistes o discusiones; NO repitas ese bloque): "${prevContext}"\n` : ''}
SEGMENTOS ACTUALES CON TIEMPO (0s a ${secInterval}s):
${segLines.slice(0, 2600)}

Si es épico, indica exactamente clipStart y clipEnd (en segundos dentro de 0 a ${secInterval}) abarcando el momento clave completo.
Responde SOLO JSON válido:
{"isEpic": true/false, "emotion": "${EMOTION_KEYS_STR}", "score": 0-100, "clipStart": 0.0, "clipEnd": ${secInterval}, "title": "Título viral corto en español", "reason": "Por qué es épico en 1 frase"}`;

        const llmCfg = (state.ai.apiKey || '').trim() || hasProxy()
          ? null
          : { provider: 'gemini', apiKey: getYtGeminiKey(), model: 'gemini-flash-lite-latest', baseUrl: AI_PROVIDERS.gemini.baseUrl };
        const raw = await callConfiguredAI(prompt, [], llmCfg, true);
        const cleaned = raw.replace(/`{3}json|`{3}/gi, '').trim();
        const m = cleaned.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(m ? m[0] : cleaned);
        const emo = normalizeEmotion(parsed.emotion);
        const baseScore = Number(parsed.score) || 0;
        const score = Math.min(100, baseScore + (matchedKws.length ? 8 : 0));
        const minScore = Number($('liveEpicMinScore')?.value || 75);

        // Cooldown inteligente antiduplicados: 45 s tras un corte, salvo que sea oro puro (score >= 90)
        const sinceLast = Date.now() - liveCapture.lastAutoCutAt;
        const blockedByCooldown = sinceLast < 45000 && score < 90;

        if (parsed.isEpic && score >= minScore && (!emo || selectedEmotions.has(emo)) && !blockedByCooldown) {
          liveCapture.lastAutoCutAt = Date.now();
          const desiredSecs = Math.max(45, Number($('liveSecs')?.value) || 90);
          const rawStart = isFinite(Number(parsed.clipStart)) ? Number(parsed.clipStart) : 0;
          const rawEnd = isFinite(Number(parsed.clipEnd)) ? Number(parsed.clipEnd) : secInterval;
          // Incluir contexto previo (pre-roll) para que el corte sea más largo y completo (45s - 90s)
          const cEnd = Math.min(secInterval, rawEnd + 4);
          const preRollNeeded = Math.max(18, desiredSecs - Math.max(10, cEnd - rawStart));
          const cStart = rawStart - preRollNeeded; // puede ser negativo: liveCutNow retrocede en el búfer
          const exactRange = { relStart: cStart, relEnd: cEnd };

          liveCutNow(desiredSecs, true, {
            emotion: emo || 'feliz',
            title: String(parsed.title || 'Momento épico en vivo'),
            reason: String(parsed.reason || transcript.slice(0, 90)) + (matchedKws.length ? ` · Gatillo: ${matchedKws.join(', ')}` : ''),
            score,
            transcript,
            windowSecs: secInterval,
            exactRange,
            rawSegments: rawSegs,
            rawWords
          });
          if ($('liveRadarStatus')) $('liveRadarStatus').textContent = `🔥 ¡Detectado [${emotionLabel(emo)}]: "${parsed.title}" (Score ${score}/${minScore})!`;
        } else if (blockedByCooldown && parsed.isEpic && score >= minScore) {
          if ($('liveRadarStatus')) $('liveRadarStatus').textContent = `⏳ Bloque épico (${score}) omitido por enfriamiento antiduplicados (${Math.ceil((45000 - sinceLast) / 1000)}s).`;
        } else {
          if ($('liveRadarStatus')) $('liveRadarStatus').textContent = `Último bloque revisado (score ${score}/${minScore}). Escuchando con memoria activa...`;
        }
      } catch (err) {
        console.warn('Radar IA en vivo:', err);
        if ($('liveRadarStatus')) $('liveRadarStatus').textContent = `⚠️ Aviso del radar IA: ${err.message || err}`;
      } finally {
        liveCapture.epicBusy = false;
        if (liveCapture.stream && $('liveRadarBadge')) {
          $('liveRadarBadge').textContent = '🧠 Escuchando IA';
          $('liveRadarBadge').className = 'badge green';
        }
      }
    };

    startAudioChunk();
    liveCapture.epicTimer = setInterval(analyzeLiveWindow, secInterval * 1000);
  } else {
    if ($('liveRadarBadge')) { $('liveRadarBadge').textContent = '⚡ Radar Voz ($0)'; $('liveRadarBadge').className = 'badge green'; }
    if ($('liveRadarStatus')) {
      $('liveRadarStatus').textContent = mode === 'ai'
        ? '⚡ Faltan tokens de Groq Whisper o Gemini: usando Radar de Voz Humana ($0) con post-roll de 8 s.'
        : '⚡ Radar de Voz Humana activo ($0): filtra música/ruido y espera 8 s tras cada pico para capturar la reacción completa.';
    }
  }
}

function liveStop() {
  stopLiveEpicRadar();
  clearInterval(liveCapture.timer);
  clearInterval(liveCapture.rotTimer);
  liveCapture.recs.forEach(x => { try { if (x.rec.state !== 'inactive') x.rec.stop(); } catch (_) {} });
  if (liveCapture.stream) liveCapture.stream.getTracks().forEach(tr => tr.stop());
  Object.assign(liveCapture, { stream: null, recs: [], timer: null, rotTimer: null });
  $('liveStartBtn').style.display = 'inline-flex';
  $('liveHereBtn').style.display = 'inline-flex';
  $('liveStopBtn').style.display = 'none';
  if ($('liveHudBar')) $('liveHudBar').classList.remove('active');
  if ($('hudAudioMeter')) $('hudAudioMeter').style.width = '0%';
  $('liveStatus').textContent = 'Captura detenida.';
}
function liveApplyAuto() {
  clearInterval(liveCapture.timer);
  const v = Number($('liveAuto').value) || 0;
  if (liveCapture.stream && v) liveCapture.timer = setInterval(() => liveCutNow(Math.min(v, 180), true), v * 1000);
}
function renderLiveClips() {
  const box = $('liveClips');
  if (!box) return;
  if ($('liveClipsCount')) $('liveClipsCount').textContent = `${liveCapture.clips.length} clip${liveCapture.clips.length === 1 ? '' : 's'}`;
  box.textContent = '';
  if (!liveCapture.clips.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'Aún no hay clips capturados. Inicia la captura de un directo y pulsa "✂️ Sacar Corte (K)" o deja actuar al Radar.';
    box.appendChild(empty);
    return;
  }
  liveCapture.clips.forEach((c, idx) => {
    const card = document.createElement('div');
    card.className = 'live-clip-card';
    const top = document.createElement('div');
    top.className = 'row'; top.style.justifyContent = 'space-between';
    const left = document.createElement('div');
    left.className = 'row'; left.style.gap = '6px';
    if (c.emotion) {
      const emoBadge = document.createElement('span');
      emoBadge.className = `badge emo-${c.emotion}`;
      emoBadge.textContent = emotionLabel(c.emotion);
      left.appendChild(emoBadge);
    }
    const titleEl = document.createElement('strong');
    titleEl.textContent = `🎬 ${c.name}`;
    left.appendChild(titleEl);
    const metaEl = document.createElement('span');
    metaEl.className = 'muted';
    metaEl.textContent = `${c.timeTag} · ${c.n}s · ${(c.blob.size / 1048576).toFixed(1)} MB${c.score ? ` · ⭐ ${c.score}` : ''}`;
    top.append(left, metaEl);
    card.appendChild(top);

    if (c.reason) {
      const rEl = document.createElement('div');
      rEl.className = 'muted'; rEl.style.fontSize = '0.78rem';
      rEl.textContent = `💡 ${c.reason}`;
      card.appendChild(rEl);
    }

    const previewWrap = document.createElement('div');
    previewWrap.className = 'live-preview-wrap';
    previewWrap.style.display = 'none';
    let previewUrl = null;

    const previewBtn = mkBtn('▶ Ver aquí', () => {
      if (previewWrap.style.display === 'none') {
        previewWrap.textContent = '';
        previewUrl = URL.createObjectURL(c.blob);
        const pv = document.createElement('video');
        pv.className = 'live-preview-video';
        pv.controls = true;
        pv.playsInline = true;
        pv.src = previewUrl;
        pv.onloadedmetadata = () => {
          if (c.start > 0.2 && isFinite(pv.duration) && c.start < pv.duration - 1) {
            try { pv.currentTime = c.start; } catch (_) {}
          }
          pv.play().catch(() => {});
        };
        previewWrap.appendChild(pv);
        previewWrap.style.display = 'block';
        previewBtn.textContent = '✕ Ocultar vista';
      } else {
        const pv = previewWrap.querySelector('video');
        if (pv) { try { pv.pause(); pv.src = ''; } catch (_) {} }
        if (previewUrl) { try { URL.revokeObjectURL(previewUrl); } catch (_) {} previewUrl = null; }
        previewWrap.textContent = '';
        previewWrap.style.display = 'none';
        previewBtn.textContent = '▶ Ver aquí';
      }
    });

    const discardBtn = mkBtn('🗑️ Descartar', () => {
      if (previewUrl) { try { URL.revokeObjectURL(previewUrl); } catch (_) {} }
      liveCapture.clips.splice(idx, 1);
      renderLiveClips();
      showToast('Clip descartado', '');
    });
    discardBtn.classList.add('btn-danger');

    const actions = document.createElement('div');
    actions.className = 'row';
    actions.append(
      previewBtn,
      mkBtn('📺 Visualizador', () => openClipInViewer(c.viewerId)),
      mkBtn('✂️ Cargar en el Estudio', () => {
        pendingWindow = { start: c.start, end: c.end };
        pendingLiveSubs = {
          name: c.name,
          emotion: c.emotion || '',
          reason: c.reason || '',
          score: c.score || 92,
          transcript: c.transcript || '',
          subtitles: Array.isArray(c.subtitles) ? c.subtitles : [],
          words: Array.isArray(c.words) ? c.words : []
        };
        state.videoBlob = c.blob;
        loadVideoSrc(URL.createObjectURL(c.blob), c.name, c.dur);
        state.sourceCredit = creatorCredit(c.creator, c.src || (c.creator && c.creator.url) || '');
        document.querySelector('[data-tab="studio"]')?.click();
      }),
      mkBtn('✈️ Enviar a Telegram', () => enqueueTelegramLiveClip(c)),
      mkBtn(`⬇️ Descargar (${c.dur} s)`, () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(c.blob); a.download = `${c.name.replace(/[^\w-]+/g, '_')}.${c.ext}`;
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      }),
      discardBtn
    );
    if (c.tgStatus) {
      const tgTag = document.createElement('span');
      tgTag.className = 'muted';
      tgTag.style.fontSize = '0.76rem';
      tgTag.textContent = c.tgStatus;
      actions.appendChild(tgTag);
    }
    card.append(actions, previewWrap);
    box.appendChild(card);
  });
}

function liveCutNow(secs, auto, epicMeta = null) {
  if (!liveCapture.stream || !liveCapture.recs.length) { showToast('Primero pulsa "Capturar directo / pestaña"', 'warn'); return; }
  if (!auto && !getCreator()) { showToast('Tip: puedes elegir un creador autorizado para añadir créditos automáticos', ''); }
  const r = liveCapture.recs[0]; // la que tiene más historial
  const dur = r.chunks.length; // 1 trozo = 1 segundo
  if (dur < 5) { if (!auto) showToast('Aún hay muy poco video capturado', 'warn'); return; }
  const defaultN = Math.min(secs || Number($('liveSecs').value) || 60, dur);
  const blob = new Blob(r.chunks, { type: (r.fmt.mime || 'video/webm').split(';')[0] });
  const timeTag = new Date().toLocaleTimeString();
  const name = epicMeta?.title ? epicMeta.title : `Directo ${timeTag}`;
  const winSec = Number(epicMeta?.windowSecs) || defaultN;
  const winOrigin = Math.max(0, dur - winSec);
  let cutStart = Math.max(0, dur - defaultN);
  let cutEnd = dur;
  if (epicMeta?.exactRange && dur >= 10) {
    cutEnd = Math.min(dur, Math.max(10, winOrigin + epicMeta.exactRange.relEnd));
    cutStart = Math.max(0, Math.min(cutEnd - 15, winOrigin + epicMeta.exactRange.relStart));
  }
  const n = Math.max(1, Math.round(cutEnd - cutStart));
  const chunkOffset = winOrigin;
  const mappedSegments = (epicMeta?.rawSegments || [])
    .map(seg => ({
      start: Math.max(cutStart, Number(seg.start || 0) + chunkOffset),
      end: Math.min(cutEnd, Number(seg.end || 0) + chunkOffset),
      text: String(seg.text || '').trim()
    }))
    .filter(seg => seg.text && seg.end > seg.start);
  const mappedWords = (epicMeta?.rawWords || [])
    .map(w => ({
      start: Math.max(cutStart, Number(w.start || 0) + chunkOffset),
      end: Math.min(cutEnd, Number(w.end || 0) + chunkOffset),
      word: String(w.word || '').trim()
    }))
    .filter(w => w.word);

  const clipObj = {
    ext: r.fmt.ext, name, timeTag, blob, dur,
    start: cutStart, end: cutEnd, n,
    emotion: epicMeta?.emotion || '',
    reason: epicMeta?.reason || '',
    score: epicMeta?.score || 0,
    transcript: epicMeta?.transcript || '',
    subtitles: mappedSegments,
    words: mappedWords,
    tgStatus: '',
    creator: getCreator(), src: $('ytUrlInput').value.trim()
  };
  liveCapture.clips.unshift(clipObj);
  liveCapture.clips = liveCapture.clips.slice(0, 6);
  clipObj.viewerId = registerViewerClip({
    source: 'live',
    title: clipObj.name,
    blob: clipObj.blob,
    ext: clipObj.ext,
    dur: clipObj.n,
    start: clipObj.start,
    end: clipObj.end,
    aspect: state.aspect || '9:16',
    emotion: clipObj.emotion,
    reason: clipObj.reason,
    score: clipObj.score,
    hasSubs: Boolean(clipObj.subtitles && clipObj.subtitles.length),
    transcript: clipObj.transcript,
    subtitles: clipObj.subtitles,
    words: clipObj.words,
    credit: creatorCredit(clipObj.creator, clipObj.src || (clipObj.creator && clipObj.creator.url) || '')
  });
  renderLiveClips();
  if (auto && epicMeta && isTelegramConfigured() && $('tgAutoSendCheck')?.checked) {
    enqueueTelegramLiveClip(clipObj);
  }
  showToast(
    epicMeta?.emotion ? `${emotionLabel(epicMeta.emotion)} detectado y guardado (${n}s)` : (auto ? `Corte automático de ${n} s guardado` : `Corte de ${n} s listo`),
    'ok'
  );
}
$('liveStartBtn').addEventListener('click', () => liveStart(false));
$('liveHereBtn').addEventListener('click', () => liveStart(true));
$('liveStopBtn').addEventListener('click', liveStop);
$('liveAuto').addEventListener('change', liveApplyAuto);
$('liveEpicMode')?.addEventListener('change', () => { if (liveCapture.stream) startLiveEpicRadar(); });
$('liveEpicInterval')?.addEventListener('change', () => { if (liveCapture.stream) startLiveEpicRadar(); });

// ==================== GRABAR LOS CORTES DEL ENLACE COMO VIDEO REAL ====================
const ytRec = { busy: false, cancel: false, finishNow: null, onState: null, clips: [] };
let ytApiPromise = null;
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

function loadYtApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((res, rej) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => rej(new Error('no se pudo cargar la API de YouTube'));
    document.head.appendChild(s);
    setTimeout(() => rej(new Error('la API de YouTube tardó demasiado')), 10000);
  });
  return ytApiPromise;
}

function recordYtOne(stream, fr, player, it, fmt) {
  return new Promise(resolve => {
    const rec = new MediaRecorder(stream, fmt.mime ? { mimeType: fmt.mime, videoBitsPerSecond: 8000000, audioBitsPerSecond: 128000 } : {});
    const chunks = [];
    let started = false, done = false, t0 = 0, guard = null;
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      clearTimeout(guard);
      ytRec.onState = null; ytRec.finishNow = null;
      const dur = started ? (Date.now() - t0) / 1000 : 0;
      resolve(started && chunks.length ? { blob: new Blob(chunks, { type: (fmt.mime || 'video/webm').split(';')[0] }), ext: fmt.ext, dur, it, precise: !!player } : null);
    };
    const begin = () => { if (started) return; started = true; t0 = Date.now(); rec.start(1000); };
    const finish = () => {
      if (done) return;
      done = true;
      if (rec.state !== 'inactive') { try { rec.stop(); } catch (_) { rec.onstop(); } } else rec.onstop();
    };
    ytRec.finishNow = finish;
    const len = Math.max(3, it.e - it.s);
    if (player) {
      ytRec.onState = s => { if (s === 1) begin(); if (s === 0 && started) finish(); }; // 1 = reproduciendo, 0 = terminó
      player.loadVideoById({ videoId: it.id, startSeconds: it.s, endSeconds: it.e, suggestedQuality: 'hd1080' });
      guard = setTimeout(finish, (len + 45) * 1000);
    } else {
      ytRec.loader(`https://www.youtube.com/embed/${it.id}?start=${it.s}&end=${it.e}&autoplay=1&controls=0&rel=0&modestbranding=1&playsinline=1&vq=hd1080`);
      begin();
      guard = setTimeout(finish, (len + 6) * 1000);
    }
  });
}

function renderYtClips() {
  const box = $('ytClipFiles');
  if (!box) return;
  box.textContent = '';
  ytRec.clips.forEach((x, idx) => {
    const card = document.createElement('div');
    card.className = 'live-clip-card';

    const top = document.createElement('div');
    top.className = 'row'; top.style.justifyContent = 'space-between';
    const left = document.createElement('div');
    left.className = 'row'; left.style.gap = '6px';
    if (x.it.emotion) {
      const emoB = document.createElement('span');
      emoB.className = `badge emo-${x.it.emotion}`;
      emoB.textContent = emotionLabel(x.it.emotion);
      left.appendChild(emoB);
    }
    const fmtB = document.createElement('span');
    fmtB.className = 'badge';
    fmtB.textContent = x.aspect || '16:9';
    left.appendChild(fmtB);
    if (x.hasSubs) {
      const subB = document.createElement('span');
      subB.className = 'badge green';
      subB.textContent = '💬 Subtítulos';
      left.appendChild(subB);
    }
    const titleEl = document.createElement('strong');
    titleEl.textContent = `🎬 ${x.it.title}`;
    left.appendChild(titleEl);

    const metaEl = document.createElement('span');
    metaEl.className = 'muted';
    metaEl.textContent = `${Math.round(x.dur)} s · ${(x.blob.size / 1048576).toFixed(1)} MB${x.ok === false ? ' ⚠️ posible daño' : ' ✅'}`;
    top.append(left, metaEl);
    card.appendChild(top);

    const previewWrap = document.createElement('div');
    previewWrap.className = 'live-preview-wrap';
    previewWrap.style.display = 'none';
    let pvUrl = null;
    const previewBtn = mkBtn('▶ Ver aquí', () => {
      if (previewWrap.style.display === 'none') {
        previewWrap.textContent = '';
        pvUrl = URL.createObjectURL(x.blob);
        const pv = document.createElement('video');
        pv.className = 'live-preview-video';
        pv.controls = true; pv.playsInline = true; pv.src = pvUrl;
        previewWrap.appendChild(pv);
        previewWrap.style.display = 'block';
        pv.play().catch(() => {});
        previewBtn.textContent = '✕ Ocultar';
      } else {
        const pv = previewWrap.querySelector('video');
        if (pv) { try { pv.pause(); pv.src = ''; } catch (_) {} }
        if (pvUrl) { try { URL.revokeObjectURL(pvUrl); } catch (_) {} pvUrl = null; }
        previewWrap.textContent = '';
        previewWrap.style.display = 'none';
        previewBtn.textContent = '▶ Ver aquí';
      }
    });

    const discardBtn = mkBtn('🗑️ Descartar', () => {
      if (pvUrl) { try { URL.revokeObjectURL(pvUrl); } catch (_) {} }
      ytRec.clips.splice(idx, 1);
      renderYtClips();
    });
    discardBtn.classList.add('btn-danger');

    const actions = document.createElement('div');
    actions.className = 'row';
    actions.append(
      previewBtn,
      mkBtn('📺 Visualizador', () => openClipInViewer(x.viewerId)),
      mkBtn('✂️ Cargar en el Estudio', () => {
        pendingWindow = { start: 0, end: x.dur };
        pendingLiveSubs = {
          name: x.it.title,
          emotion: x.it.emotion || '',
          reason: x.it.reason || '',
          score: x.it.score || 92,
          transcript: x.transcript || '',
          subtitles: x.subtitles || [],
          words: x.words || []
        };
        state.videoBlob = x.blob;
        loadVideoSrc(URL.createObjectURL(x.blob), x.it.title, x.dur);
        state.sourceCredit = creatorCredit(x.it.creator, x.it.link);
        document.querySelector('[data-tab="studio"]')?.click();
      }),
      mkBtn('✈️ Enviar a Telegram', async () => {
        saveTelegramConfigFromUI(true);
        if (!isTelegramConfigured()) { showToast('Configura tu Bot Token y Chat ID en Radar & Telegram', 'warn'); return; }
        showToast(`✈️ Enviando "${x.it.title}" a Telegram...`, '');
        try {
          await sendBlobToTelegram({
            blob: x.blob,
            ext: x.ext || 'mp4',
            title: x.it.title,
            emotion: x.it.emotion || '',
            reason: x.it.reason || '',
            score: x.it.score || 0,
            transcript: x.transcript || (x.subtitles || []).map(s => s.text).join(' '),
            subs: x.subtitles || [],
            startOffset: 0,
            credit: creatorCredit(x.it.creator, x.it.link)
          });
          pushTelegramHistory({ ok: true, title: x.it.title, emotion: x.it.emotion || '', time: new Date().toLocaleTimeString() });
          showToast(`✈️ "${x.it.title}" enviado a Telegram`, 'ok');
        } catch (err) {
          showToast(`Error Telegram: ${err.message}`, 'warn');
        }
      }),
      mkBtn(`⬇️ Descargar (${(x.ext || 'mp4').toUpperCase()})`, () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(x.blob); a.download = `${String(x.it.title).replace(/[^\w-]+/g, '_')}_${(x.aspect || 'clip').replace(':','x')}.${x.ext}`;
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      }),
      discardBtn
    );
    card.append(actions, previewWrap);
    box.appendChild(card);
  });
}
function addYtClip(c) {
  ytRec.clips.unshift(c);
  ytRec.clips = ytRec.clips.slice(0, 8);
  c.viewerId = registerViewerClip({
    source: 'yt',
    title: c.it.title,
    blob: c.blob,
    ext: c.ext || 'mp4',
    dur: c.dur,
    start: 0,
    end: c.dur,
    aspect: c.aspect || '9:16',
    emotion: c.it.emotion || '',
    reason: c.it.reason || '',
    score: c.it.score || 0,
    hasSubs: Boolean(c.hasSubs),
    transcript: c.transcript || '',
    subtitles: c.subtitles || [],
    words: c.words || [],
    credit: creatorCredit(c.it.creator, c.it.link)
  });
  renderYtClips();
}

function openYtPopup(id, useApi) {
  const pw = window.open('', 'cliphub_player', 'popup=yes,width=1280,height=720');
  if (!pw) return null;
  const api = useApi
    ? '<script src="https://www.youtube.com/iframe_api"><\/script><script>window.onYouTubeIframeAPIReady=function(){window.pl=new YT.Player("p",{events:{onReady:function(){try{window.opener.__ytPopupReady(window.pl)}catch(e){}},onStateChange:function(e){try{window.opener.__ytPopupState(e.data)}catch(x){}}}})}<\/script>'
    : '';
  pw.document.open();
  pw.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="strict-origin-when-cross-origin"><title>CLIPHUB - Reproductor (comparte ESTA pestaña)</title><style>html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{width:100%;height:100%;border:0}</style></head><body><iframe id="p" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" src="https://www.youtube.com/embed/${id}?controls=0&rel=0&modestbranding=1&playsinline=1&vq=hd1080${useApi ? '&enablejsapi=1&origin=' + encodeURIComponent(location.origin) : ''}"></iframe>${api}</body></html>`);
  pw.document.close();
  return pw;
}

function verifyClip(blob) {
  return new Promise(res => {
    const v = document.createElement('video');
    const u = URL.createObjectURL(blob);
    let fin = false;
    const done = ok => { if (fin) return; fin = true; URL.revokeObjectURL(u); res(ok); };
    v.muted = true; v.preload = 'auto';
    v.onloadeddata = () => done(v.videoWidth > 0);
    v.onerror = () => done(false);
    setTimeout(() => done(false), 8000);
    v.src = u;
  });
}

async function recordYtClips(items, recOpts = {}) {
  if (ytRec.busy) { showToast('Ya hay una grabación en curso', 'warn'); return; }
  if (!items.length) { showToast('Marca al menos un corte como "Aprobar"', 'warn'); return; }
  if (liveCapture.stream) { showToast('Detén primero la captura del directo', 'warn'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    showToast('Tu navegador no permite capturar (usa Chrome o Edge de escritorio)', 'warn');
    return;
  }
  const mode = $('ytRecMode').value;
  const useApi = location.protocol !== 'file:';
  const st = $('ytRecStatus');
  const fmt = LIVE_FORMATS.find(f => f.id === $('liveFormat').value) || LIVE_FORMATS[0];
  const fr = $('ytIframe');
  window.__ytPopupState = s => { if (ytRec.onState) ytRec.onState(s); };
  // La ventana se abre aquí, antes de cualquier espera, o el navegador la bloquea
  let pw = null, readyP = null;
  if (mode === 'popup') {
    if (useApi) {
      readyP = new Promise((res, rej) => { window.__ytPopupReady = pl => res(pl); setTimeout(() => rej(new Error('el reproductor no respondió')), 12000); });
      readyP.catch(() => {});
    }
    pw = openYtPopup(items[0].id, useApi);
    if (!pw) { showToast('El navegador bloqueó la ventana nueva: permite las ventanas emergentes de esta página y vuelve a intentarlo', 'warn'); return; }
  }
  ytRec.busy = true; ytRec.cancel = false;
  $('ytRecStopBtn').style.display = 'inline-flex';
  let stream = null, player = null;
  try {
    if (mode === 'popup') {
      st.textContent = '👉 En el aviso del navegador elige la PESTAÑA "CLIPHUB - Reproductor" (no la pantalla completa) y marca "Compartir audio".';
      showToast('Elige la pestaña "CLIPHUB - Reproductor" y marca "Compartir audio"', 'ok');
      await sleepMs(1500);
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
      ytRec.loader = u => { try { pw.location.replace(u); } catch (e) { console.warn(e); } };
      if (readyP) { try { player = await readyP; } catch (e) { player = null; } }
    } else {
      fr.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
      const w = Math.min((fr.parentElement && fr.parentElement.clientWidth) || 800, 960);
      fr.style.width = w + 'px';
      fr.style.height = Math.round(w * 9 / 16) + 'px';
      fr.src = `https://www.youtube.com/embed/${items[0].id}?controls=0&rel=0&modestbranding=1&playsinline=1&vq=hd1080` +
        (useApi ? `&enablejsapi=1&origin=${encodeURIComponent(location.origin)}` : '');
      $('ytEmbedWrap').style.display = 'block';
      fr.scrollIntoView({ block: 'center' });
      await sleepMs(900);
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30, displaySurface: 'browser' }, audio: true,
        preferCurrentTab: true, selfBrowserSurface: 'include'
      });
      try {
        const vt = stream.getVideoTracks()[0];
        if (window.CropTarget && vt.cropTo) await vt.cropTo(await CropTarget.fromElement(fr));
      } catch (e) { console.warn('Sin recorte al reproductor:', e); }
      ytRec.loader = u => { fr.src = u; };
      if (useApi) {
        try {
          await loadYtApi();
          player = await new Promise((res, rej) => {
            const pl = new YT.Player(fr, { events: { onReady: () => res(pl), onStateChange: ev => { if (ytRec.onState) ytRec.onState(ev.data); } } });
            setTimeout(() => rej(new Error('el reproductor no respondió')), 10000);
          });
        } catch (e) { console.warn('Sin control del reproductor:', e); player = null; }
      }
    }
    if (!stream.getAudioTracks().length) showToast('No se capturó audio: marca "Compartir audio" al elegir la pestaña', 'warn');
    if (!player) showToast('Sin control exacto del reproductor: los clips pueden traer unos segundos de más al inicio (abre la página desde un servidor y no como archivo para mayor precisión)', 'warn');
    let ok = 0, bad = 0;
    const ytAspect = $('ytAspectSelect')?.value || '9:16';
    const ytRes = $('ytResSelect')?.value || 'sd';
    const ytBurnSubs = Boolean($('ytBurnSubsCheck')?.checked);
    const ytSubStyle = $('ytSubStyleSelect')?.value || state.subStyle || 'word';
    const needsRender = ytBurnSubs || ytAspect !== '16:9';

    for (let i = 0; i < items.length && !ytRec.cancel; i++) {
      const it = items[i];
      st.textContent = `🎥 Grabando corte ${i + 1} de ${items.length}: "${it.title}" (${Math.max(3, it.e - it.s)} s en tiempo real). No cierres ni minimices ninguna de las dos ventanas.`;
      const clip = await recordYtOne(stream, fr, player, it, fmt);
      if (clip) {
        st.textContent = `Comprobando el archivo del corte ${i + 1}...`;
        clip.ok = await verifyClip(clip.blob);
        clip.aspect = ytAspect;
        clip.hasSubs = false;
        clip.subtitles = [];
        clip.words = [];
        clip.transcript = '';

        if (clip.ok && needsRender && !ytRec.cancel) {
          if (ytBurnSubs && ((state.ai.groqKey || '').trim() || hasProxy())) {
            st.textContent = `🎙️ Transcribiendo subtítulos del corte ${i + 1} con Groq Whisper...`;
            try {
              const tr = await transcribeVideoWithGroqWhisper(clip.blob);
              if (tr?.segments?.length) {
                clip.transcript = tr.text || '';
                clip.subtitles = tr.segments;
                clip.words = tr.words || [];
              }
            } catch (trErr) {
              console.warn('Whisper en corte YT:', trErr);
              showToast(`Whisper aviso: ${trErr.message}`, 'warn');
            }
          }
          st.textContent = `🎬 Renderizando corte ${i + 1} en ${ytAspect}${ytBurnSubs ? ' con subtítulos' : ''}...`;
          try {
            const rendered = await renderOffscreenClipWithSubtitles({
              blob: clip.blob,
              start: 0,
              end: clip.dur,
              dur: clip.dur,
              name: it.title,
              transcript: clip.transcript || it.caption || '',
              subtitles: clip.subtitles,
              words: clip.words,
              subsFromFullBlob: true
            }, { aspect: ytAspect, res: ytRes, subStyle: ytSubStyle, burnSubs: ytBurnSubs });
            clip.blob = rendered.blob;
            clip.ext = rendered.ext;
            clip.subtitles = rendered.subs;
            clip.hasSubs = ytBurnSubs && rendered.subs.length > 0;
          } catch (rErr) {
            console.warn('Render corte YT:', rErr);
            showToast(`No se pudo renderizar en ${ytAspect}: ${rErr.message}`, 'warn');
          }
        }

        clip.ok ? ok++ : bad++;
        addYtClip(clip);
        const shouldSendYtTg = Boolean(recOpts.autoTg || $('ytAutoTgCheck')?.checked);
        if (clip.ok && shouldSendYtTg && !ytRec.cancel) {
          saveTelegramConfigFromUI(true);
          if (!isTelegramConfigured()) {
            showToast('Configura tu Bot Token y Chat ID en Radar & Telegram para auto-enviar', 'warn');
          } else {
            st.textContent = `✈️ Enviando corte ${i + 1} ("${it.title}") a Telegram...`;
            try {
              await sendBlobToTelegram({
                blob: clip.blob,
                ext: clip.ext || 'mp4',
                title: it.title,
                emotion: it.emotion || '',
                reason: it.reason || '',
                score: it.score || 0,
                transcript: clip.transcript || (clip.subtitles || []).map(s => s.text).join(' '),
                subs: clip.subtitles || [],
                startOffset: 0,
                credit: creatorCredit(it.creator, it.link)
              });
              pushTelegramHistory({ ok: true, title: it.title, emotion: it.emotion || '', time: new Date().toLocaleTimeString() });
              showToast(`✈️ "${it.title}" enviado a Telegram`, 'ok');
            } catch (tgErr) {
              showToast(`Error Telegram: ${tgErr.message}`, 'warn');
            }
          }
        }
      } else if (!ytRec.cancel) showToast(`El corte "${it.title}" no se pudo grabar (el video no arrancó)`, 'warn');
    }
    st.textContent = ytRec.cancel ? 'Grabación detenida.' : `✅ ${ok} cortes verificados${bad ? `, ⚠️ ${bad} con posible daño (cambia el "Formato" y repite)` : ''}. Los tienes abajo.`;
  } catch (err) {
    st.textContent = `⚠️ No se pudo grabar: ${err && err.message ? err.message : err}`;
  } finally {
    if (stream) stream.getTracks().forEach(tr => tr.stop());
    try { if (player && player.pauseVideo) player.pauseVideo(); } catch (_) {}
    try { if (pw) pw.close(); } catch (_) {}
    ytRec.busy = false; ytRec.finishNow = null; ytRec.onState = null;
    $('ytRecStopBtn').style.display = 'none';
  }
}
$('ytRecStopBtn').addEventListener('click', () => { ytRec.cancel = true; if (ytRec.finishNow) ytRec.finishNow(); });

// ==================== YOUTUBE DIRECTO ====================
  $('toggleYtBtn').addEventListener('click', () => {
    document.querySelector('[data-tab="live"]')?.click();
  });

  $('loadYtEmbedBtn').addEventListener('click', () => {
    if (location.protocol === 'file:') {
      showToast('YouTube bloquea embeds en archivos locales (Error 153). Ábrelo desde GitHub Pages o http://localhost', 'warn');
    }
    const url = $('ytUrlInput').value.trim();
    const m = url.match(/(?:v=|youtu\.be\/|live\/|shorts\/)([a-zA-Z0-9_-]{11})/);
    if (!m) {
      showToast('Pega un enlace válido de YouTube o directo', 'warn');
      return;
    }
    const originParam = location.protocol !== 'file:' ? `&origin=${encodeURIComponent(location.origin)}` : '';
    $('ytIframe').src = `https://www.youtube.com/embed/${m[1]}?autoplay=1&rel=0${originParam}`;
    $('ytEmbedWrap').style.display = 'block';
    showToast('Enlace de YouTube cargado en el panel', 'ok');
  });

  $('ytQuickCutBtn').addEventListener('click', () => {
  liveCutNow();
  return;
    const idx = state.cuts.length;
    const fresh = getUniqueCreativePack(idx + Date.now());
    state.cuts.push({
      title: `Momento en Directo #${idx + 1}`,
      hookText: '¡PASÓ EN VIVO!',
      badge: 'DIRECTO YT',
      score: 95,
      start: 0,
      end: Math.min(state.cutDuration, state.duration || state.cutDuration),
      frameIdx: 0,
      lines: [
        'Esto acaba de ocurrir en plena transmisión en vivo',
        'Mira la reacción en tiempo real sin ningún corte',
        '¿Estabas conectado cuando pasó este momento?',
        'Comenta y guarda este clip antes de que se pierda'
      ],
      timedSegments: [],
      thumbnailPrompt: ''
    });
    renderCutsList();
    loadCutIntoPlayer(idx, false);
    showToast(`Corte en directo #${idx + 1} añadido (${fresh.badge})`, 'ok');
  });

  // ==================== CONFIGURACIÓN DEL MODAL DE IA (STACK OPTIMIZADO + MULTI-IA) ====================
  function setAiModalTab(tabKey) {
    document.querySelectorAll('#aiModalTabs .modal-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.aiTab === tabKey);
    });
    $('aiPaneStack').style.display = tabKey === 'stack' ? 'block' : 'none';
    $('aiPaneAdvanced').style.display = tabKey === 'advanced' ? 'block' : 'none';
  }

  document.querySelectorAll('#aiModalTabs .modal-tab').forEach(tab => {
    tab.addEventListener('click', () => setAiModalTab(tab.dataset.aiTab));
  });

  document.querySelectorAll('[data-toggle-vis]').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = $(btn.dataset.toggleVis);
      if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
    });
  });

  function syncAiModalFields(providerKey, keepKey = true) {
    const p = AI_PROVIDERS[providerKey] || AI_PROVIDERS.gemini;
    $('aiProviderSelect').value = providerKey;
    $('aiModelInput').value = (providerKey === state.ai.provider && state.ai.model) ? state.ai.model : p.defaultModel;
    $('aiBaseUrlInput').value = (providerKey === state.ai.provider && state.ai.baseUrl) ? state.ai.baseUrl : p.baseUrl;
    if (!keepKey) $('apiKeyInput').value = '';
    $('apiKeyInput').placeholder = p.placeholder;
    $('aiPortalLink').href = p.portal;
    $('aiModelSuggestions').innerHTML = p.models.map(m => `<option value="${m}"></option>`).join('');
  }

  // Sincronizar bidireccionalmente la clave Gemini entre Pestaña 1 (Stack) y Pestaña 2 (Avanzado)
  $('stackGeminiKeyInput').addEventListener('input', e => {
    if ($('aiProviderSelect').value !== 'gemini' && e.target.value.trim()) {
      syncAiModalFields('gemini', true);
    }
    if ($('aiProviderSelect').value === 'gemini') {
      $('apiKeyInput').value = e.target.value;
    }
  });
  $('apiKeyInput').addEventListener('input', e => {
    if ($('aiProviderSelect').value === 'gemini') {
      $('stackGeminiKeyInput').value = e.target.value;
    }
  });

  /**
   * Consulta GET /health en el Cloudflare Worker Proxy (si está configurado)
   * y actualiza los indicadores de estado de los servicios IA.
   */
  async function checkProxyHealth() {
    const proxy = getActiveProxy();
    if (!proxy) {
      state.proxyHealth = null;
      refreshAiBadge();
      return null;
    }
    try {
      const res = await fetch(`${proxy}/health`, { headers: getProxyHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      state.proxyHealth = { status: 'ok', configured: data.configured || {} };
      const list = $('publicStatusList');
      if (list) {
        const cfg = state.proxyHealth.configured;
        list.innerHTML = [
          `🎙️ Subtítulos (Groq Whisper): <strong>${cfg.groqWhisper ? 'Activo' : 'Pendiente'}</strong>`,
          `✂️ Cortes (Gemini Flash-Lite): <strong>${cfg.geminiFlashLite ? 'Activo' : 'Pendiente'}</strong>`,
          `🖼️ Miniaturas (FLUX.1 Schnell): <strong>${cfg.falFluxSchnell ? 'Activo' : 'Solo Canvas $0'}</strong>`
        ].join('<br>');
      }
    } catch (err) {
      state.proxyHealth = { status: 'error', message: err.message };
      const list = $('publicStatusList');
      if (list) {
        list.textContent = `⚠️ No se pudo conectar con el proxy: ${err.message}`;
      }
    }
    refreshAiBadge();
    return state.proxyHealth;
  }

  /**
   * Sincroniza la visibilidad de la barra de conexión manual de APIs.
   */
  function applyPublicSaasUI() {
    const publicMode = isPublicSaasMode();
    const apiBar = $('manualApiBar');
    if (apiBar) {
      apiBar.style.display = publicMode ? 'none' : 'flex';
    }
    if (!publicMode) {
      updateManualApiPills();
    }
  }

  function openManualAiModal(defaultTab = 'stack') {
    $('aiTestResult').className = 'test-box';
    if (isPublicSaasMode()) {
      $('aiModalTitle').textContent = '☁️ Estado de la IA en la Nube';
      $('aiVisionBadge').textContent = 'Servicio Gestionado';
      $('aiPanePublic').style.display = 'block';
      $('aiModalTabs').style.display = 'none';
      $('aiPaneStack').style.display = 'none';
      $('aiPaneAdvanced').style.display = 'none';
      $('clearAiKeyBtn').style.display = 'none';
      $('saveAiKeyBtn').textContent = '💾 Guardar Preferencia';
      $('publicThumbEngineSelect').value = state.ai.thumbEngine === 'fal' ? 'fal' : 'canvas';
      $('aiModal').classList.add('open');
      if (hasProxy()) checkProxyHealth();
      return;
    }

    $('aiModalTitle').textContent = '⚡ Configurar APIs de IA Optimizadas';
    $('aiVisionBadge').textContent = '-92% Costo en Tokens';
    $('aiPanePublic').style.display = 'none';
    $('aiModalTabs').style.display = 'flex';
    $('clearAiKeyBtn').style.display = 'inline-flex';
    $('saveAiKeyBtn').textContent = '💾 Guardar Configuración';

    syncAiModalFields(state.ai.provider, true);
    $('apiKeyInput').value = state.ai.apiKey || '';
    $('stackGeminiKeyInput').value = state.ai.provider === 'gemini' ? (state.ai.apiKey || '') : '';
    $('groqKeyInput').value = state.ai.groqKey || '';
    $('falKeyInput').value = state.ai.falKey || '';
    $('thumbEngineSelect').value = state.ai.thumbEngine || 'canvas';
    $('proxyUrlInput').value = state.ai.proxyUrl || '';
    setAiModalTab(defaultTab);
    $('aiModal').classList.add('open');
  }

  $('openAiModal').addEventListener('click', () => openManualAiModal('stack'));
  $('openManualApiBtn').addEventListener('click', () => openManualAiModal('stack'));
  $('pillGroq').addEventListener('click', () => openManualAiModal('stack'));
  $('pillLlm').addEventListener('click', () => openManualAiModal(state.ai.provider === 'gemini' ? 'stack' : 'advanced'));
  $('pillThumb').addEventListener('click', () => openManualAiModal('stack'));

  $('recheckPublicAiBtn').addEventListener('click', async () => {
    $('recheckPublicAiBtn').disabled = true;
    await checkProxyHealth();
    $('recheckPublicAiBtn').disabled = false;
    showToast(state.proxyHealth?.status === 'ok' ? 'Servicios IA en línea' : 'Verificación completada', state.proxyHealth?.status === 'ok' ? 'ok' : 'warn');
  });
  $('closeAiModal').addEventListener('click', () => $('aiModal').classList.remove('open'));
  $('aiProviderSelect').addEventListener('change', e => syncAiModalFields(e.target.value, true));

  $('toggleAiKeyVis').addEventListener('click', () => {
    const inp = $('apiKeyInput');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  $('detectModelsBtn').addEventListener('click', async () => {
    const provider = $('aiProviderSelect').value;
    const apiKey = $('apiKeyInput').value.trim();
    const baseUrl = $('aiBaseUrlInput').value.trim();
    if (provider !== 'gemini') {
      showBoxMsg('aiTestResult', 'info', 'La detección automática funciona con Google Gemini. Para otros proveedores elige un modelo de la lista sugerida.');
      return;
    }
    if (!apiKey) {
      showBoxMsg('aiTestResult', 'err', 'Pega primero tu API Key de Google AI Studio para detectar los modelos activos.');
      return;
    }
    showBoxMsg('aiTestResult', 'info', '🔍 Consultando los modelos disponibles en tu cuenta de Google AI Studio...');
    try {
      const { textModels } = await discoverGeminiModels(apiKey, baseUrl);
      if (!textModels.length) throw new Error('No se encontraron modelos de texto activos.');
      $('aiModelSuggestions').innerHTML = textModels.map(m => `<option value="${m}"></option>`).join('');
      $('aiModelInput').value = textModels[0];
      showBoxMsg('aiTestResult', 'ok', `✅ Modelo económico recomendado seleccionado: ${textModels[0]} (${textModels.length} modelos activos).`);
    } catch (err) {
      showBoxMsg('aiTestResult', 'err', `❌ No se pudieron listar modelos: ${err.message}`);
    }
  });

  // Prueba rápida del Stack Optimizado (Gemini Flash-Lite + Groq)
  $('testStackBtn').addEventListener('click', async () => {
    const geminiKey = $('stackGeminiKeyInput').value.trim();
    const groqKey = $('groqKeyInput').value.trim();
    const proxyUrl = $('proxyUrlInput').value.trim();
    const results = [];

    if (!geminiKey && !groqKey && !proxyUrl) {
      showBoxMsg('aiTestResult', 'err', 'Ingresa al menos una clave (Groq o Gemini) o tu Proxy URL para probar.');
      return;
    }

    showBoxMsg('aiTestResult', 'info', '⏳ Verificando conexiones del Stack Optimizado...');

    // Probar Gemini Flash-Lite o Proxy
    if (geminiKey || proxyUrl) {
      try {
        const tempCfg = {
          provider: 'gemini',
          apiKey: geminiKey,
          model: 'gemini-flash-lite-latest',
          baseUrl: AI_PROVIDERS.gemini.baseUrl,
          proxyUrl
        };
        const reply = await callConfiguredAI('Responde solo: OK', [], tempCfg, false);
        results.push(`✅ Gemini (${tempCfg.model}): "${reply.trim().slice(0, 20)}"`);
      } catch (err) {
        results.push(`❌ Gemini: ${err.message}`);
      }
    }

    // Probar clave Groq consultando modelos disponibles (sin gastar audio)
    if (groqKey) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { Authorization: `Bearer ${groqKey}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        results.push('✅ Groq Whisper: Clave válida y lista ($0.04/h)');
      } catch (err) {
        results.push(`❌ Groq: ${err.message}`);
      }
    }

    const hasErr = results.some(r => r.startsWith('❌'));
    showBoxMsg('aiTestResult', hasErr ? 'err' : 'ok', results.join('  |  '));
  });

  $('testAiBtn').addEventListener('click', async () => {
    const tempCfg = {
      provider: $('aiProviderSelect').value,
      apiKey: $('apiKeyInput').value.trim(),
      model: $('aiModelInput').value.trim(),
      baseUrl: $('aiBaseUrlInput').value.trim(),
      proxyUrl: $('proxyUrlInput').value.trim()
    };
    showBoxMsg('aiTestResult', 'info', '⏳ Probando conexión con el proveedor...');
    try {
      const reply = await callConfiguredAI('Responde únicamente con la palabra: CONECTADO', [], tempCfg, false);
      if (tempCfg.model && tempCfg.model !== $('aiModelInput').value.trim()) {
        $('aiModelInput').value = tempCfg.model;
      }
      showBoxMsg('aiTestResult', 'ok', `✅ Conexión exitosa (${tempCfg.model}). Respuesta: "${reply.trim().slice(0, 60)}"`);
    } catch (err) {
      showBoxMsg('aiTestResult', 'err', `❌ Error al conectar: ${err.message}`);
    }
  });

  $('saveAiKeyBtn').addEventListener('click', () => {
    if (isPublicSaasMode()) {
      const chosenEngine = $('publicThumbEngineSelect').value === 'fal' ? 'fal' : 'canvas';
      state.ai.thumbEngine = chosenEngine;
      safeSet('cliphub_ai_config', JSON.stringify({ thumbEngine: chosenEngine }));
      $('thumbEngineQuickSelect').value = chosenEngine;
      refreshAiBadge();
      $('aiModal').classList.remove('open');
      showToast('Preferencias guardadas', 'ok');
      return;
    }

    const provider = $('aiProviderSelect').value;
    const stackGemini = $('stackGeminiKeyInput').value.trim();
    const advKey = $('apiKeyInput').value.trim();
    const finalApiKey = provider === 'gemini' ? (stackGemini || advKey) : advKey;

    state.ai = {
      provider,
      apiKey: finalApiKey,
      model: $('aiModelInput').value.trim() || AI_PROVIDERS[provider].defaultModel,
      baseUrl: $('aiBaseUrlInput').value.trim() || AI_PROVIDERS[provider].baseUrl,
      groqKey: $('groqKeyInput').value.trim(),
      falKey: $('falKeyInput').value.trim(),
      thumbEngine: $('thumbEngineSelect').value || 'canvas',
      proxyUrl: $('proxyUrlInput').value.trim()
    };

    safeSet('cliphub_ai_config', JSON.stringify(state.ai));
    if (provider === 'gemini') safeSet('cliphub_gemini_key', state.ai.apiKey);
    $('thumbEngineQuickSelect').value = state.ai.thumbEngine;
    refreshAiBadge();
    $('aiModal').classList.remove('open');
    showToast('Configuración del Stack Optimizado guardada', 'ok');
  });

  $('clearAiKeyBtn').addEventListener('click', () => {
    state.ai.apiKey = '';
    state.ai.groqKey = '';
    state.ai.falKey = '';
    state.ai.proxyUrl = '';
    state.ai.thumbEngine = 'canvas';
    safeSet('cliphub_ai_config', JSON.stringify(state.ai));
    safeSet('cliphub_gemini_key', '');
    $('apiKeyInput').value = '';
    $('stackGeminiKeyInput').value = '';
    $('groqKeyInput').value = '';
    $('falKeyInput').value = '';
    $('proxyUrlInput').value = '';
    $('thumbEngineSelect').value = 'canvas';
    $('thumbEngineQuickSelect').value = 'canvas';
    refreshAiBadge();
    showBoxMsg('aiTestResult', 'info', 'Claves eliminadas. Se usará el motor local gratuito ($0).');
    showToast('Claves de IA eliminadas', '');
  });

  // ==================== REDES SOCIALES Y CALENDARIO ====================
  function toLocalInputValue(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function makeDynamicCopy(title, platform, idx = 0) {
    const openers = [
      `🔥 ${title} — ¡Míralo hasta el último segundo!`,
      `👀 ¿Notaste este detalle? ${title}`,
      `⚡ El momento más intenso del video: ${title}`,
      `🎬 No podrás verlo solo una vez: ${title}`,
      `🚀 Esto está dando de qué hablar: ${title}`
    ];
    const tags = {
      'YouTube Shorts': '#Shorts #Viral #Contenido #Tendencia',
      'Instagram Reels': '#Reels #ExplorePage #Creatividad #VideoViral',
      'TikTok': '#ParaTi #FYP #TikTokViral #Clips',
      'Facebook Reels': '#ReelsFB #VideoViral #Tendencias',
      'X (Twitter)': '#Viral #Video #Trending'
    };
    return `${openers[(idx + Math.floor(Math.random() * openers.length)) % openers.length]}\n\n💬 Cuéntame qué opinas en los comentarios.\n${tags[platform] || '#Viral'}`;
  }

  function saveAccounts() {
    safeSet('cliphub_accounts', JSON.stringify(state.accounts));
    renderAccounts();
  }
  function saveSchedule() {
    safeSet('cliphub_schedule', JSON.stringify(state.schedule));
    renderSchedule();
  }

  let editingAccountKey = null;
  let activeAccMode = 'token';

  function setAccModalMode(mode) {
    activeAccMode = mode;
    document.querySelectorAll('#accModeTabs .modal-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.accMode === mode);
    });
    $('accPaneToken').style.display = mode === 'token' ? 'block' : 'none';
    $('accPaneWebhook').style.display = mode === 'webhook' ? 'block' : 'none';
    $('accPaneProfile').style.display = mode === 'profile' ? 'block' : 'none';
  }

  document.querySelectorAll('#accModeTabs .modal-tab').forEach(tab => {
    tab.addEventListener('click', () => setAccModalMode(tab.dataset.accMode));
  });

  $('toggleAccTokenVis').addEventListener('click', () => {
    const inp = $('accTokenInput');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  function renderAccounts() {
    const modeLabels = { token: '🔑 Token API', webhook: '🔗 Webhook', profile: '👤 Perfil' };
    $('accountsGrid').innerHTML = Object.entries(state.accounts).map(([key, acc]) => `
      <div class="social-card">
        <div class="social-card-top">
          <div>
            <strong>${acc.icon} ${escapeHtml(acc.name)}</strong>
            <div class="muted">${acc.connected ? escapeHtml(acc.handle || acc.loginUser || 'Cuenta vinculada') : 'Sin conectar'}</div>
          </div>
          <button type="button" class="btn btn-sm ${acc.connected ? 'btn-green' : ''}" data-open-acc="${key}">
            ${acc.connected ? '✓ Configurar' : 'Conectar'}
          </button>
        </div>
        <div class="social-meta">
          <span class="badge ${acc.connected ? 'green' : 'amber'}">${acc.connected ? 'Conectada' : 'Pendiente'}</span>
          ${acc.connected ? `<span class="badge">${modeLabels[acc.mode] || 'Conectada'}</span>` : ''}
          ${acc.verified ? '<span class="badge purple">✓ Verificada</span>' : ''}
        </div>
      </div>
    `).join('');

    document.querySelectorAll('[data-open-acc]').forEach(btn => {
      btn.addEventListener('click', () => openAccountModal(btn.dataset.openAcc));
    });

    // Sincronizar el bloqueo obligatorio del programador cada vez que cambia una conexión
    updateScheduleGateUI();
  }

  function openAccountModal(key) {
    const acc = state.accounts[key];
    if (!acc) return;
    editingAccountKey = key;
    $('accModalTitle').textContent = `${acc.icon} Conectar ${acc.name}`;
    $('accPortalLink').href = acc.portal;
    $('accHandleInput').value = acc.handle || '';
    $('accChannelIdInput').value = acc.channelId || '';
    $('accTokenInput').value = acc.token || '';
    $('accClientIdInput').value = acc.clientId || '';
    $('accWebhookUrlInput').value = acc.webhookUrl || '';
    $('accWebhookSecretInput').value = acc.webhookSecret || '';
    $('accLoginUserInput').value = acc.loginUser || '';
    $('accProfileUrlInput').value = acc.profileUrl || acc.studioUrl || '';
    $('accTestResult').className = 'test-box';
    setAccModalMode(acc.mode || 'token');
    $('accountModal').classList.add('open');
  }

  $('testAccBtn').addEventListener('click', async () => {
    const key = editingAccountKey;
    if (!key) return;
    showBoxMsg('accTestResult', 'info', '⏳ Verificando conexión...');
    try {
      if (activeAccMode === 'token') {
        const token = $('accTokenInput').value.trim();
        if (!token) throw new Error('Ingresa tu Access Token primero');
        if (key === 'youtube') {
          const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
            headers: { Authorization: `Bearer ${token}` }
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
          const ch = data?.items?.[0];
          if (ch) {
            $('accHandleInput').value = ch.snippet?.title || $('accHandleInput').value;
            $('accChannelIdInput').value = ch.id || $('accChannelIdInput').value;
          }
          showBoxMsg('accTestResult', 'ok', `✅ Token verificado en YouTube (${ch?.snippet?.title || 'Canal activo'})`);
        } else if (key === 'instagram' || key === 'facebook') {
          const res = await fetch(`https://graph.facebook.com/v19.0/me?access_token=${encodeURIComponent(token)}`);
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
          if (data?.name && !$('accHandleInput').value) $('accHandleInput').value = data.name;
          if (data?.id) $('accChannelIdInput').value = data.id;
          showBoxMsg('accTestResult', 'ok', `✅ Token verificado en Meta Graph API (${data?.name || data?.id})`);
        } else {
          showBoxMsg('accTestResult', 'ok', '✅ Token guardado con formato válido. Listo para usar con tu flujo.');
        }
      } else if (activeAccMode === 'webhook') {
        const url = $('accWebhookUrlInput').value.trim();
        if (!/^https?:\/\//i.test(url)) throw new Error('Ingresa una URL de Webhook válida (https://...)');
        const headers = { 'Content-Type': 'application/json' };
        const secret = $('accWebhookSecretInput').value.trim();
        if (secret) headers['Authorization'] = secret;
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ event: 'cliphub_test', platform: key, timestamp: new Date().toISOString() })
        });
        if (!res.ok) throw new Error(`El webhook respondió HTTP ${res.status}`);
        showBoxMsg('accTestResult', 'ok', '✅ Webhook probado y operativo.');
      } else {
        const user = $('accLoginUserInput').value.trim() || $('accHandleInput').value.trim();
        if (!user) throw new Error('Escribe tu usuario o @canal');
        showBoxMsg('accTestResult', 'ok', `✅ Perfil "${user}" configurado para apertura directa en Studio.`);
      }
    } catch (err) {
      showBoxMsg('accTestResult', 'err', `❌ ${err.message}`);
    }
  });

  $('saveAccBtn').addEventListener('click', () => {
    const acc = state.accounts[editingAccountKey];
    if (!acc) return;

    const handle = $('accHandleInput').value.trim();
    const token = $('accTokenInput').value.trim();
    const webhookUrl = $('accWebhookUrlInput').value.trim();
    const loginUser = $('accLoginUserInput').value.trim();

    // Validar que el usuario completó los datos mínimos del método de conexión elegido
    if (activeAccMode === 'token' && !token) {
      showBoxMsg('accTestResult', 'err', '❌ Ingresa un Access Token válido para conectar esta red.');
      return;
    }
    if (activeAccMode === 'webhook' && !/^https?:\/\//i.test(webhookUrl)) {
      showBoxMsg('accTestResult', 'err', '❌ Ingresa una URL de Webhook válida (https://...) para conectar esta red.');
      return;
    }
    if (activeAccMode === 'profile' && !loginUser && !handle) {
      showBoxMsg('accTestResult', 'err', '❌ Escribe tu @usuario o correo de la cuenta para vincular este perfil.');
      return;
    }

    acc.mode = activeAccMode;
    acc.handle = handle;
    acc.channelId = $('accChannelIdInput').value.trim();
    acc.token = token;
    acc.clientId = $('accClientIdInput').value.trim();
    acc.webhookUrl = webhookUrl;
    acc.webhookSecret = $('accWebhookSecretInput').value.trim();
    acc.loginUser = loginUser;
    acc.profileUrl = $('accProfileUrlInput').value.trim() || acc.studioUrl;
    acc.connected = true;
    acc.verified = $('accTestResult').classList.contains('ok');
    saveAccounts();
    $('accountModal').classList.remove('open');
    showToast(`✅ ${acc.name} conectada. Ya puedes programar publicaciones en esta red.`, 'ok');
  });

  $('disconnectAccBtn').addEventListener('click', () => {
    const acc = state.accounts[editingAccountKey];
    if (!acc) return;
    acc.connected = false;
    acc.verified = false;
    acc.token = '';
    acc.webhookUrl = '';
    acc.webhookSecret = '';
    acc.handle = '';
    acc.loginUser = '';
    saveAccounts();
    $('accountModal').classList.remove('open');
    showToast(`${acc.name} desconectada`, '');
  });
  $('closeAccModal').addEventListener('click', () => $('accountModal').classList.remove('open'));

  $('verifyAllAccountsBtn').addEventListener('click', () => {
    const connected = Object.values(state.accounts).filter(a => a.connected);
    if (!connected.length) {
      showToast('Aún no tienes redes conectadas. Pulsa "Conectar" en una tarjeta.', 'warn');
    } else {
      showToast(`${connected.length} red(es) conectada(s) y listas para publicar`, 'ok');
    }
  });

  const ACCOUNT_TO_PLATFORM = {
    youtube: 'YouTube Shorts',
    instagram: 'Instagram Reels',
    tiktok: 'TikTok',
    facebook: 'Facebook Reels',
    x: 'X (Twitter)'
  };

  function platformToAccountKey(platform) {
    const p = String(platform || '').toLowerCase();
    if (p.includes('youtube')) return 'youtube';
    if (p.includes('instagram')) return 'instagram';
    if (p.includes('tiktok')) return 'tiktok';
    if (p.includes('facebook')) return 'facebook';
    return 'x';
  }

  /**
   * Comprueba si la plataforma seleccionada tiene su cuenta social conectada.
   */
  function isPlatformConnected(platform) {
    const accKey = platformToAccountKey(platform);
    return Boolean(state.accounts[accKey]?.connected);
  }

  /**
   * Devuelve la lista de plataformas que actualmente están conectadas.
   */
  function getConnectedPlatforms() {
    return Object.entries(state.accounts)
      .filter(([, acc]) => Boolean(acc?.connected))
      .map(([key]) => ACCOUNT_TO_PLATFORM[key])
      .filter(Boolean);
  }

  /**
   * Bloquea o habilita el formulario de programación según el estado de conexión
   * de la red social elegida.
   */
  function updateScheduleGateUI() {
    const select = $('schedPlatform');
    const addBtn = $('addScheduleBtn');
    const banner = $('schedConnBanner');
    const bannerText = $('schedConnBannerText');
    const badge = $('schedGateBadge');
    const quickBtn = $('schedQuickConnectBtn');
    if (!select || !addBtn) return;

    // Mostrar indicador visual de estado en cada opción del selector
    Array.from(select.options).forEach(opt => {
      const connected = isPlatformConnected(opt.value);
      opt.textContent = connected
        ? `${opt.value} (✓ Conectada)`
        : `${opt.value} (🔒 Sin conectar)`;
    });

    const selectedPlatform = select.value;
    const accKey = platformToAccountKey(selectedPlatform);
    const acc = state.accounts[accKey];
    const isConnected = Boolean(acc?.connected);

    if (isConnected) {
      addBtn.disabled = false;
      addBtn.textContent = '📌 Guardar en Calendario';
      if (badge) {
        badge.textContent = `✓ ${acc.name} conectada`;
        badge.className = 'badge green';
      }
      if (banner) banner.style.display = 'none';
    } else {
      addBtn.disabled = true;
      addBtn.textContent = `🔒 Conecta ${acc?.name || selectedPlatform} para programar`;
      if (badge) {
        badge.textContent = `🔒 ${acc?.name || selectedPlatform} sin conectar`;
        badge.className = 'badge amber';
      }
      if (banner) banner.style.display = 'block';
      if (bannerText) {
        bannerText.innerHTML = `⚠️ <strong>Conexión obligatoria:</strong> debes conectar <strong>${escapeHtml(acc?.name || selectedPlatform)}</strong> antes de poder programar publicaciones en esta red.`;
      }
      if (quickBtn) {
        quickBtn.textContent = `🔗 Conectar ${acc?.name || selectedPlatform}`;
      }
    }
  }

  $('schedPlatform').addEventListener('change', updateScheduleGateUI);
  $('schedQuickConnectBtn').addEventListener('click', () => {
    const accKey = platformToAccountKey($('schedPlatform').value);
    openAccountModal(accKey);
  });

  let currentPublishCaption = '';

  function renderSchedule() {
    $('schedCountBadge').textContent = `${state.schedule.length} programadas`;
    if (!state.schedule.length) {
      $('scheduleList').innerHTML = '<div class="muted">No hay publicaciones programadas todavía.</div>';
      return;
    }
    const sorted = [...state.schedule].sort((a, b) => new Date(a.date) - new Date(b.date));
    $('scheduleList').innerHTML = sorted.map(item => `
      <div class="sched-item">
        <div style="flex:1; min-width:220px;">
          <div class="row" style="margin-bottom:4px;">
            <span class="badge">${escapeHtml(item.platform)}</span>
            <span class="badge ${item.status === 'Publicado' ? 'green' : 'amber'}">${escapeHtml(item.status)}</span>
            <span class="muted">🗓️ ${new Date(item.date).toLocaleString()}</span>
          </div>
          <strong>${escapeHtml(item.title)}</strong>
          <div class="muted" style="white-space:pre-line; margin-top:4px;">${escapeHtml(item.caption)}</div>
        </div>
        <div class="row">
          <button type="button" class="btn btn-sm btn-primary" data-pub-now="${item.id}">🚀 Publicar Ahora</button>
          <button type="button" class="btn btn-sm btn-danger" data-del-sched="${item.id}">🗑️</button>
        </div>
      </div>
    `).join('');

    document.querySelectorAll('[data-del-sched]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.schedule = state.schedule.filter(x => x.id !== btn.dataset.delSched);
        saveSchedule();
        showToast('Publicación eliminada del calendario', '');
      });
    });

    document.querySelectorAll('[data-pub-now]').forEach(btn => {
      btn.addEventListener('click', () => publishScheduledItem(btn.dataset.pubNow));
    });
  }

  // Subida real a YouTube (Data API v3, subida resumible)
  async function uploadToYouTube(token, blob, item) {
    const type = blob.type || 'video/webm';
    const meta = {
      snippet: {
        title: String(item.title || 'Clip').replace(/[<>]/g, '').slice(0, 100),
        description: `${item.caption || ''}${state.sourceCredit || ''}\n\n#Shorts`.slice(0, 4900),
        categoryId: '22'
      },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    };
    const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(blob.size),
        'X-Upload-Content-Type': type
      },
      body: JSON.stringify(meta)
    });
    if (!init.ok) {
      const e = await init.json().catch(() => ({}));
      throw new Error((e && e.error && e.error.message) || `HTTP ${init.status}`);
    }
    const loc = init.headers.get('Location');
    if (!loc) throw new Error('YouTube no devolvió la URL de subida');
    const up = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
    const data = await up.json().catch(() => ({}));
    if (!up.ok) throw new Error((data && data.error && data.error.message) || `HTTP ${up.status}`);
    return data;
  }

  function buildWebhookBody(obj) {
    obj = Object.assign({ credit: state.sourceCredit || '' }, obj);
    if (!state.lastExport) return JSON.stringify(obj);
    const fd = new FormData();
    Object.entries(obj).forEach(([k, v]) => fd.append(k, v == null ? '' : v));
    fd.append('video', state.lastExport.blob, `clip.${state.lastExport.ext || 'webm'}`);
    return fd;
  }

  async function publishScheduledItem(id) {
    const item = state.schedule.find(x => x.id === id);
    if (!item) return;
    const accKey = platformToAccountKey(item.platform);
    const acc = state.accounts[accKey] || DEFAULT_ACCOUNTS.youtube;

    // Exigir red conectada también al momento de publicar
    if (!acc.connected) {
      showToast(`Debes conectar ${acc.name} antes de publicar este corte`, 'warn');
      openAccountModal(accKey);
      return;
    }

    currentPublishCaption = `${item.title}\n\n${item.caption}`;
    copyTextSafe(currentPublishCaption);

    $('pubModalTitle').textContent = `🚀 Publicando en ${item.platform}`;
    $('pubProgress').style.width = '20%';
    $('pubLinks').style.display = 'none';
    $('pubDirectStudioBtn').href = acc.profileUrl || acc.studioUrl;
    $('pubStatus').textContent = 'Empaquetando video, subtítulos y copiando descripción al portapapeles...';
    $('publishModal').classList.add('open');

    if (accKey === 'youtube' && acc.mode === 'token' && acc.token) {
      if (!state.lastExport) {
        $('pubProgress').style.width = '100%';
        $('pubStatus').textContent = '⚠️ Primero exporta el clip (Editor → Exportar) y luego pulsa Publicar otra vez, para tener el archivo de video que subir.';
        $('pubLinks').style.display = 'flex';
        return;
      }
      try {
        $('pubProgress').style.width = '50%';
        $('pubStatus').textContent = 'Subiendo el video a YouTube... (puede tardar según el tamaño)';
        const r = await uploadToYouTube(acc.token, state.lastExport.blob, item);
        $('pubProgress').style.width = '100%';
        const priv = r && r.status && r.status.privacyStatus;
        $('pubStatus').textContent = `✅ Video subido a YouTube: https://youtube.com/shorts/${r.id}` +
          (priv && priv !== 'public' ? ` — ⚠️ quedó como "${priv}": YouTube bloquea como privados los videos de apps de API sin verificar; cámbialo a público en YouTube Studio.` : '');
        item.status = 'Publicado';
        saveSchedule();
      } catch (err) {
        const m = String(err.message || err);
        const hint = /invalid credentials|401|expired/i.test(m) ? ' Tu token expiró (duran ~1 hora); genera uno nuevo y vuelve a guardarlo.'
          : /insufficient|scope|403/i.test(m) ? ' El token necesita el permiso youtube.upload.'
          : /quota/i.test(m) ? ' Superaste la cuota diaria de la API de YouTube.' : '';
        $('pubStatus').textContent = `❌ No se pudo subir a YouTube: ${m}.${hint} La descripción quedó copiada para subirlo a mano.`;
        $('pubProgress').style.width = '100%';
      }
      $('pubLinks').style.display = 'flex';
      return;
    }

    if (acc.connected && acc.mode === 'webhook' && acc.webhookUrl) {
      try {
        $('pubProgress').style.width = '65%';
        $('pubStatus').textContent = 'Enviando paquete automático a tu Webhook...';
        const headers = state.lastExport ? {} : { 'Content-Type': 'application/json' };
        if (acc.webhookSecret) headers['Authorization'] = acc.webhookSecret;
        const res = await fetch(acc.webhookUrl, {
          method: 'POST',
          headers,
          body: buildWebhookBody({
            event: 'cliphub_publish',
            platform: item.platform,
            account: acc.handle || acc.loginUser,
            title: item.title,
            caption: item.caption,
            scheduledDate: item.date
          })
        });
        if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
        $('pubProgress').style.width = '100%';
        $('pubStatus').textContent = `✅ Enviado automáticamente a tu Webhook de ${item.platform}.`;
        $('pubLinks').style.display = 'flex';
        item.status = 'Publicado';
        saveSchedule();
        return;
      } catch (err) {
        $('pubStatus').textContent = `⚠️ Webhook falló (${err.message}). Descripción copiada al portapapeles para subir manualmente:`;
        $('pubProgress').style.width = '100%';
        $('pubLinks').style.display = 'flex';
        return;
      }
    }

    setTimeout(() => {
      $('pubProgress').style.width = '65%';
      $('pubStatus').textContent = 'Preparando metadatos y portada CTR...';
    }, 550);
    setTimeout(() => {
      $('pubProgress').style.width = '100%';
      $('pubStatus').textContent = `📋 Aún NO se subió nada a ${item.platform}: la subida automática solo funciona con YouTube (token con permiso de subida) o con un Webhook. La descripción ya se copió; abre tu Studio para subirlo a mano:`;
      $('pubLinks').style.display = 'flex';
      item.status = 'Pendiente manual';
      saveSchedule();
    }, 1250);
  }

  $('pubCopyAgainBtn').addEventListener('click', () => {
    copyTextSafe(currentPublishCaption);
    showToast('Descripción copiada al portapapeles', 'ok');
  });
  $('closePubModal').addEventListener('click', () => $('publishModal').classList.remove('open'));

  $('addScheduleBtn').addEventListener('click', () => {
    const platform = $('schedPlatform').value;
    const accKey = platformToAccountKey(platform);
    const acc = state.accounts[accKey];

    // Validación obligatoria: no permitir programar si la red no está conectada
    if (!acc || !acc.connected) {
      showToast(`Debes conectar ${acc?.name || platform} antes de programar una publicación`, 'warn');
      openAccountModal(accKey);
      return;
    }

    const title = $('schedTitle').value.trim();
    const date = $('schedDate').value;
    if (!title || !date) {
      showToast('Completa el título y la fecha/hora de publicación', 'warn');
      return;
    }
    state.schedule.push({
      id: `${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
      title,
      platform,
      date,
      caption: $('schedCaption').value.trim() || makeDynamicCopy(title, platform),
      status: 'Programado'
    });
    saveSchedule();
    $('schedTitle').value = '';
    showToast(`Publicación programada en ${platform}`, 'ok');
  });

  $('genDynamicCopyBtn').addEventListener('click', async () => {
    const title = $('schedTitle').value.trim() || (state.cuts[state.activeCutIdx]?.title || 'Nuevo Clip Viral');
    const platform = $('schedPlatform').value;
    if ((state.ai.apiKey || '').trim() || hasProxy()) {
      $('genDynamicCopyBtn').disabled = true;
      $('genDynamicCopyBtn').textContent = '⏳ Generando...';
      try {
        const aiCopy = await callConfiguredAI(`Escribe una descripción corta, creativa y viral en español con 4 hashtags para ${platform} sobre el video titulado "${title}". Solo responde con el texto final.`, [], null, false);
        if (aiCopy.trim()) {
          $('schedCaption').value = aiCopy.trim();
          showToast('Copy creativo generado por IA económica', 'ok');
          return;
        }
      } catch (_) {}
      finally {
        $('genDynamicCopyBtn').disabled = false;
        $('genDynamicCopyBtn').textContent = '✨ Variar Copy Creativo (IA)';
      }
    }
    $('schedCaption').value = makeDynamicCopy(title, platform);
    showToast('Copy creativo variado', 'ok');
  });

  $('sendCutToSchedBtn').addEventListener('click', () => {
    const cut = state.cuts[state.activeCutIdx] || { title: 'Mi Nuevo Corte Viral' };
    const nextDay = new Date(Date.now() + 24 * 3600 * 1000);
    nextDay.setHours(18, 0, 0, 0);

    // Si la plataforma actual no está conectada, preseleccionar la primera red conectada
    const connectedPlatforms = getConnectedPlatforms();
    if (connectedPlatforms.length && !isPlatformConnected($('schedPlatform').value)) {
      $('schedPlatform').value = connectedPlatforms[0];
    }
    updateScheduleGateUI();

    $('schedTitle').value = cut.title;
    $('schedDate').value = toLocalInputValue(nextDay);
    $('schedCaption').value = makeDynamicCopy(cut.title, $('schedPlatform').value, Math.max(0, state.activeCutIdx));
    document.querySelector('[data-tab="social"]').click();

    if (!connectedPlatforms.length) {
      showToast('Corte cargado. Conecta al menos una red social para poder guardarlo en el calendario.', 'warn');
    } else {
      showToast('Corte enviado al programador de fechas', 'ok');
    }
  });

  $('autoScheduleAllBtn').addEventListener('click', () => {
    if (!state.cuts.length) {
      showToast('Primero analiza un video para generar los cortes', 'warn');
      return;
    }

    // Exigir al menos una red conectada antes de auto-programar
    const connectedPlatforms = getConnectedPlatforms();
    if (!connectedPlatforms.length) {
      document.querySelector('[data-tab="social"]').click();
      showToast('Conecta al menos una red social antes de auto-programar los cortes', 'warn');
      return;
    }

    state.cuts.forEach((c, i) => {
      const targetPlatform = connectedPlatforms[i % connectedPlatforms.length];
      const dt = new Date(Date.now() + (i + 1) * 24 * 3600 * 1000);
      dt.setHours(18 + (i % 3), 30, 0, 0);
      state.schedule.push({
        id: `${Date.now()}_${i}_${Math.random().toString(16).slice(2, 5)}`,
        title: c.title,
        platform: targetPlatform,
        date: toLocalInputValue(dt),
        caption: makeDynamicCopy(c.title, targetPlatform, i),
        status: 'Programado'
      });
    });
    saveSchedule();
    document.querySelector('[data-tab="social"]').click();
    showToast(`${state.cuts.length} cortes auto-programados en tus redes conectadas (${connectedPlatforms.join(', ')})`, 'ok');
  });

  // ==================== INICIALIZACIÓN ====================
  const initDate = new Date(Date.now() + 3600 * 1000);
  $('schedDate').value = toLocalInputValue(initDate);
  $('thumbEngineQuickSelect').value = state.ai.thumbEngine || 'canvas';
  applyPublicSaasUI();
  refreshAiBadge();
  syncLoopButtons();
  renderAccounts();
  renderSchedule();
  if (hasProxy()) {
    checkProxyHealth();
  }

  // ==================== CONTROLADOR UX (2 ESTADOS + 3 COLUMNAS + INSPECTORES) ====================
  function enterStudioWorkspace() {
    const empty = $('studioEmptyState');
    const ws = $('studioWorkspace');
    if (empty) empty.classList.add('ux-hidden');
    if (ws) ws.classList.remove('ux-hidden');
  }

  // Cambiar al Estado B automáticamente en cuanto el video decodifica o se carga un corte
  video.addEventListener('loadedmetadata', enterStudioWorkspace);
  video.addEventListener('loadeddata', enterStudioWorkspace);

  // Dropzone de arrastrar y soltar en Estado A
  const dropZone = $('studioDropZone');
  if (dropZone) {
    dropZone.addEventListener('click', () => $('videoInput').click());
    ['dragenter', 'dragover'].forEach(ev => {
      dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(ev => {
      dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove('dragover'); });
    });
    dropZone.addEventListener('drop', e => {
      const file = e.dataTransfer?.files?.[0];
      if (!file || !file.type.startsWith('video/')) {
        showToast('Suelta un archivo de video válido (MP4, WebM, MOV)', 'warn');
        return;
      }
      const dt = new DataTransfer();
      dt.items.add(file);
      $('videoInput').files = dt.files;
      $('videoInput').dispatchEvent(new Event('change'));
    });
  }

  // Botón "+ Nuevo Video" en el Workspace
  $('wsUploadNewBtn')?.addEventListener('click', () => $('videoInput').click());

  // Navegar entre Estudio y la pestaña dedicada En Vivo & Radar
  $('emptyOpenYtBtn')?.addEventListener('click', () => {
    document.querySelector('[data-tab="live"]')?.click();
  });
  $('closeYtPanelBtn')?.addEventListener('click', () => {
    document.querySelector('[data-tab="studio"]')?.click();
  });

  // Pestañas del Inspector derecho del Estudio (Subtítulos / PNG / Tiempos)
  document.querySelectorAll('#studioInspTabs .ux-insp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#studioInspTabs .ux-insp-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.ux-insp-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const target = $('inspPane-' + tab.dataset.insp);
      if (target) target.classList.add('active');
    });
  });

  // Selector rápido de duración en la barra superior del Workspace
  $('quickDurSelect')?.addEventListener('change', e => {
    setCutDuration(Number(e.target.value), true);
    showToast(`Duración de cortes ajustada a ${state.cutDuration}s`, 'ok');
  });

  // Mostrar/ocultar el progreso de 4 pasos automáticamente al analizar
  const pipeDrawer = $('pipelineDrawer');
  $('togglePipelineBtn')?.addEventListener('click', () => pipeDrawer?.classList.toggle('ux-hidden'));
  $('closePipelineBtn')?.addEventListener('click', () => pipeDrawer?.classList.add('ux-hidden'));
  $('analyzeBtn')?.addEventListener('click', () => pipeDrawer?.classList.remove('ux-hidden'));

  if (pipeDrawer && typeof MutationObserver !== 'undefined') {
    const obs = new MutationObserver(() => {
      if (state.isAnalyzing || $('pStep1')?.classList.contains('run') || $('pStep1')?.classList.contains('err')) {
        pipeDrawer.classList.remove('ux-hidden');
      }
    });
    ['pStep1', 'pStep2', 'pStep3', 'pStep4'].forEach(id => {
      const el = $(id);
      if (el) obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
  }

  // Pestañas del Inspector del Editor de Video
  document.querySelectorAll('#edInspTabs .ux-insp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#edInspTabs .ux-insp-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.ux-ed-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const target = $('edPane-' + tab.dataset.edTab);
      if (target) target.classList.add('active');
    });
  });

  // Evitar que el botón "Verificar Conexiones" abra/cierre el acordeón <details>
  $('verifyAllAccountsBtn')?.addEventListener('click', e => e.preventDefault());


  // ==================== MÓDULO TELEGRAM (ENVÍO DE CORTES ÉPICOS CON SUBTÍTULOS) ====================
  function loadTelegramConfig() {
    try {
      const saved = JSON.parse(safeGet('cliphub_telegram', 'null'));
      if (saved && typeof saved === 'object') return saved;
    } catch (_) {}
    return { botToken: '', chatId: '646422028', autoSend: true, burnSubs: true, sendSrt: false };
  }

  state.telegram = loadTelegramConfig();
  const tgQueue = [];
  let tgSending = false;

  function isTelegramConfigured() {
    return Boolean((state.telegram?.botToken || '').trim() && (state.telegram?.chatId || '').trim());
  }

  function refreshTelegramUI() {
    const ok = isTelegramConfigured();
    if ($('tgBotTokenInput')) $('tgBotTokenInput').value = state.telegram.botToken || '';
    if ($('tgChatIdInput')) $('tgChatIdInput').value = state.telegram.chatId || '';
    if ($('tgAutoSendCheck')) $('tgAutoSendCheck').checked = state.telegram.autoSend !== false;
    if ($('tgBurnSubsCheck')) $('tgBurnSubsCheck').checked = state.telegram.burnSubs !== false;
    if ($('tgSendSrtCheck')) $('tgSendSrtCheck').checked = Boolean(state.telegram.sendSrt);
    if ($('tgBadge')) {
      $('tgBadge').textContent = ok ? '✓ Conectado' : 'Sin configurar';
      $('tgBadge').className = ok ? 'badge green' : 'badge';
    }
  }

  function saveTelegramConfigFromUI(silent = false) {
    state.telegram = {
      botToken: ($('tgBotTokenInput')?.value || '').trim(),
      chatId: ($('tgChatIdInput')?.value || '').trim(),
      autoSend: Boolean($('tgAutoSendCheck')?.checked),
      burnSubs: Boolean($('tgBurnSubsCheck')?.checked),
      sendSrt: Boolean($('tgSendSrtCheck')?.checked)
    };
    safeSet('cliphub_telegram', JSON.stringify(state.telegram));
    refreshTelegramUI();
    if (!silent) {
      showToast(isTelegramConfigured() ? 'Telegram configurado y guardado' : 'Configuración de Telegram guardada', 'ok');
    }
  }

  $('tgSaveBtn')?.addEventListener('click', () => saveTelegramConfigFromUI(false));
  ['tgAutoSendCheck', 'tgBurnSubsCheck', 'tgSendSrtCheck'].forEach(id => {
    $(id)?.addEventListener('change', () => saveTelegramConfigFromUI(true));
  });

  $('tgTestBtn')?.addEventListener('click', async () => {
    saveTelegramConfigFromUI(true);
    if (!isTelegramConfigured()) {
      showToast('Ingresa tu Bot Token y Chat ID primero', 'warn');
      return;
    }
    const { botToken, chatId } = state.telegram;
    if ($('tgStatusText')) $('tgStatusText').textContent = '⏳ Probando conexión con Telegram...';
    try {
      const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '✅ ClipHub Studio Pro conectado. Aquí recibirás tus cortes épicos con subtítulos incluidos.'
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.description || `HTTP ${res.status}`);
      if ($('tgStatusText')) $('tgStatusText').textContent = '✅ Mensaje de prueba enviado correctamente a tu Telegram.';
      showToast('Telegram conectado correctamente', 'ok');
    } catch (err) {
      if ($('tgStatusText')) $('tgStatusText').textContent = `❌ Error Telegram: ${err.message}. (Asegúrate de haber iniciado tu bot con /start o añadirlo como admin del canal).`;
      showToast(`Error Telegram: ${err.message}`, 'warn');
    }
  });

  function fmtSrtTime(sec) {
    sec = Math.max(0, Number(sec) || 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec - Math.floor(sec)) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  function buildSrtContent(segments, offsetStart = 0) {
    const clean = (segments || []).filter(s => s && String(s.text || '').trim());
    if (!clean.length) return '';
    return clean.map((s, idx) => {
      const st = Math.max(0, Number(s.start) - offsetStart);
      const en = Math.max(st + 0.4, Number(s.end) - offsetStart);
      return `${idx + 1}\n${fmtSrtTime(st)} --> ${fmtSrtTime(en)}\n${String(s.text).trim()}`;
    }).join('\n\n') + '\n';
  }

  // Dibuja subtítulos para un clip offscreen (reutiliza exactamente el mismo estilo visual del Estudio)
  function drawOffscreenSubtitles(c, w, h, now, subsList, wordsList, style, aspect) {
    if (!subsList || !subsList.length) return;
    const active = subsList.find(s => now >= (s.start - 0.15) && now <= (s.end + 0.25));
    if (!active) return;

    if (style === 'word') {
      let ws = (wordsList || []).filter(x => x.start >= active.start - 0.15 && x.end <= active.end + 0.15 && String(x.word).trim());
      if (!ws.length) {
        const parts = String(active.text || '').trim().split(/\s+/).filter(Boolean);
        const step = Math.max(0.2, (active.end - active.start) / Math.max(1, parts.length));
        ws = parts.map((p, i) => ({ word: p, start: active.start + i * step, end: active.start + (i + 1) * step }));
      }
      if (!ws.length) return;
      let idx = 0;
      for (let i = 0; i < ws.length; i++) { if (ws[i].start <= now) idx = i; }
      const G = 3, g = Math.floor(idx / G);
      const txt = ws.slice(g * G, g * G + G).map(x => String(x.word).trim().toUpperCase());
      let fs = aspect === '9:16' ? 38 : 42;
      c.save();
      c.textAlign = 'left';
      c.lineJoin = 'round';
      let widths, sp, total;
      const measure = () => {
        c.font = `900 ${fs}px Segoe UI, Impact, sans-serif`;
        sp = c.measureText(' ').width;
        widths = txt.map(t => c.measureText(t).width);
        total = widths.reduce((a, b) => a + b, 0) + sp * (txt.length - 1);
      };
      measure();
      if (total > w * 0.92) { fs = Math.floor(fs * (w * 0.92) / total); measure(); }
      let x = (w - total) / 2;
      const y = h * 0.80;
      txt.forEach((t, i) => {
        c.lineWidth = 9;
        c.strokeStyle = '#050811';
        c.strokeText(t, x, y);
        c.fillStyle = (g * G + i) === idx ? '#fde047' : '#ffffff';
        c.fillText(t, x, y);
        x += widths[i] + sp;
      });
      c.restore();
      return;
    }

    const fontSize = aspect === '9:16' ? 32 : 36;
    c.save();
    c.font = `900 ${fontSize}px Segoe UI, Impact, sans-serif`;
    c.textAlign = 'center';
    const lines = wrapText(c, active.text.toUpperCase(), w * 0.86);
    const lineH = fontSize * 1.24;
    const baseY = h * 0.80 - ((lines.length - 1) * lineH) / 2;
    lines.forEach((line, idx) => {
      const y = baseY + idx * lineH;
      if (style === 'box') {
        const tw = c.measureText(line).width + 28;
        c.fillStyle = 'rgba(255,255,255,0.95)';
        drawRoundRect(c, w / 2 - tw / 2, y - fontSize * 0.85, tw, fontSize * 1.15, 10);
        c.fill();
        c.fillStyle = '#090d16';
        c.fillText(line, w / 2, y);
      } else {
        c.lineWidth = 8;
        c.strokeStyle = '#050811';
        c.strokeText(line, w / 2, y);
        c.fillStyle = style === 'viral' ? '#fde047' : style === 'neon' ? '#38bdf8' : '#ffffff';
        c.fillText(line, w / 2, y);
      }
    });
    c.restore();
  }

  // AudioContext compartido y desbloqueado con interacción del usuario (evita videos mudos en Telegram)
  let sharedTgAudioCtx = null;
  function getUnlockedAudioCtx() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!sharedTgAudioCtx || sharedTgAudioCtx.state === 'closed') {
      sharedTgAudioCtx = new AudioCtx();
    }
    if (sharedTgAudioCtx.state === 'suspended') {
      sharedTgAudioCtx.resume().catch(() => {});
    }
    return sharedTgAudioCtx;
  }
  ['click', 'keydown', 'touchstart'].forEach(ev => {
    window.addEventListener(ev, () => { getUnlockedAudioCtx(); }, { once: true, passive: true });
  });

  // Renderiza en segundo plano (sin eco y CON AUDIO GARANTIZADO) un clip al tamaño elegido y con subtítulos opcionales
  async function renderOffscreenClipWithSubtitles(clipObj, opts = {}) {
    const offVideo = document.createElement('video');
    offVideo.playsInline = true;
    offVideo.muted = false;
    offVideo.volume = 1;
    offVideo.preload = 'auto';
    offVideo.style.cssText = 'position:fixed;bottom:0;right:0;width:320px;height:180px;opacity:0.001;pointer-events:none;z-index:-2;';
    document.body.appendChild(offVideo);

    const srcUrl = URL.createObjectURL(clipObj.blob);
    let drawTimer = null;
    let sourceNode = null;
    let silentGain = null;
    let destNode = null;
    try {
      await new Promise((res, rej) => {
        offVideo.onloadeddata = () => res();
        offVideo.onerror = () => rej(new Error('No se pudo leer el clip para incrustar subtítulos'));
        setTimeout(() => res(), 4000);
        offVideo.src = srcUrl;
        offVideo.load();
      });

      const aspect = opts.aspect || state.aspect || '9:16';
      const isHd = opts.res === 'hd';
      const dims = aspect === '16:9' ? (isHd ? { w: 1280, h: 720 } : { w: 960, h: 540 })
        : aspect === '1:1' ? (isHd ? { w: 960, h: 960 } : { w: 720, h: 720 })
        : aspect === '4:5' ? (isHd ? { w: 864, h: 1080 } : { w: 640, h: 800 })
        : (isHd ? { w: 720, h: 1280 } : { w: 540, h: 960 });

      const offCanvas = document.createElement('canvas');
      offCanvas.width = dims.w;
      offCanvas.height = dims.h;
      const g = offCanvas.getContext('2d');

      const vStream = offCanvas.captureStream(24);
      const tracks = [...vStream.getVideoTracks()];

      // Captura de audio continua (evita que Chrome corte el audio a los 20-30 s por ahorro de energía)
      let audioAdded = false;
      let keepAliveOsc = null;
      let keepAliveGain = null;
      const acRef = getUnlockedAudioCtx();
      try {
        if (acRef) {
          if (acRef.state === 'suspended') await acRef.resume().catch(() => {});
          sourceNode = acRef.createMediaElementSource(offVideo);
          destNode = acRef.createMediaStreamDestination();
          silentGain = acRef.createGain();
          silentGain.gain.value = 0.0002; // Inaudible, pero por encima del umbral de suspensión de Chrome
          sourceNode.connect(destNode);
          sourceNode.connect(silentGain);
          silentGain.connect(acRef.destination);

          // Oscilador inaudible de 1 Hz para mantener vivo el reloj de audio durante todo el clip (incluso > 2 min)
          keepAliveOsc = acRef.createOscillator();
          keepAliveOsc.frequency.value = 1;
          keepAliveGain = acRef.createGain();
          keepAliveGain.gain.value = 0.00005;
          keepAliveOsc.connect(keepAliveGain);
          keepAliveGain.connect(destNode);
          keepAliveGain.connect(acRef.destination);
          keepAliveOsc.start();

          const aTracks = destNode.stream.getAudioTracks();
          if (aTracks.length) {
            tracks.push(...aTracks);
            audioAdded = true;
          }
        }
      } catch (e) {
        console.warn('WebAudio offscreen fallback:', e);
      }

      // Respaldo con captureStream() si WebAudio no logró enganchar la pista
      if (!audioAdded) {
        try {
          const cap = offVideo.captureStream ? offVideo.captureStream() : (offVideo.mozCaptureStream ? offVideo.mozCaptureStream() : null);
          if (cap && cap.getAudioTracks().length) {
            tracks.push(...cap.getAudioTracks());
            audioAdded = true;
          }
        } catch (_) {}
      }

      // Priorizar códecs con audio explícito compatible con Telegram (MP4+AAC primero, luego WebM+Opus)
      const formats = [
        { mime: 'video/mp4;codecs=avc1.4D4028,mp4a.40.2', ext: 'mp4' },
        { mime: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4' },
        { mime: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4' },
        { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
        { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
        { mime: 'video/mp4', ext: 'mp4' },
        { mime: 'video/webm', ext: 'webm' }
      ];
      const chosen = formats.find(f => {
        try { return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(f.mime); }
        catch (_) { return false; }
      }) || { mime: '', ext: 'webm' };

      const combined = new MediaStream(tracks);
      const recOpts = chosen.mime
        ? { mimeType: chosen.mime, videoBitsPerSecond: 2400000, audioBitsPerSecond: 128000 }
        : { videoBitsPerSecond: 2400000, audioBitsPerSecond: 128000 };
      const rec = new MediaRecorder(combined, recOpts);
      const chunks = [];
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

      const startT = Math.max(0, Number(clipObj.start) || 0);
      const endT = Math.max(startT + 2, Number(clipObj.end) || Number(clipObj.dur) || 60);
      const clipMs = Math.min(185000, Math.max(2000, (endT - startT) * 1000));
      const burnSubs = opts.burnSubs !== false;

      let subs = Array.isArray(clipObj.subtitles) && clipObj.subtitles.length
        ? clipObj.subtitles
        : (clipObj.transcript ? buildTimedSubtitles(clipObj.transcript.split(/(?<=[.!?])\s+/), startT, endT) : []);
      if (burnSubs && !subs.length && clipObj.name) {
        subs = [{ start: startT, end: endT, text: clipObj.name }];
      }
      if (!burnSubs) subs = [];
      const words = burnSubs && Array.isArray(clipObj.words) ? clipObj.words : [];
      const subStyle = opts.subStyle || state.subStyle || 'word';

      let recStartedAt = 0;
      let realStartBase = startT;
      const drawFrame = () => {
        if (acRef && acRef.state === 'suspended') { acRef.resume().catch(() => {}); }
        g.fillStyle = '#050811';
        g.fillRect(0, 0, dims.w, dims.h);
        if (offVideo.readyState >= 2 && offVideo.videoWidth > 0) {
          const vr = offVideo.videoWidth / offVideo.videoHeight;
          const cr = dims.w / dims.h;
          let sx = 0, sy = 0, sw = offVideo.videoWidth, sh = offVideo.videoHeight;
          if (vr > cr) { sw = offVideo.videoHeight * cr; sx = (offVideo.videoWidth - sw) / 2; }
          else { sh = offVideo.videoWidth / cr; sy = (offVideo.videoHeight - sh) / 2; }
          g.drawImage(offVideo, sx, sy, sw, sh, 0, 0, dims.w, dims.h);
        }
        // Reloj confiable de subtítulos: usa tiempo real del video o tiempo transcurrido si WebM no reporta currentTime exacto
        const elapsed = recStartedAt ? (performance.now() - recStartedAt) / 1000 : 0;
        const vidNow = Number(offVideo.currentTime);
        const subClock = (isFinite(vidNow) && vidNow > 0.05) ? vidNow : (realStartBase + elapsed);
        drawOffscreenSubtitles(g, dims.w, dims.h, subClock, subs, words, subStyle, aspect);
      };

      // Esperar a que offVideo complete el salto (seeked) a un fotograma limpio antes de empezar a grabar
      if (startT > 0.2) {
        await new Promise(resolve => {
          let done = false;
          const fin = () => { if (!done) { done = true; resolve(); } };
          offVideo.addEventListener('seeked', fin, { once: true });
          try { offVideo.currentTime = startT; } catch (_) { fin(); }
          setTimeout(fin, 1800);
        });
      }
      await offVideo.play().catch(() => {});
      realStartBase = Number(offVideo.currentTime) || 0;
      // Si el WebM no saltó a startT (quedó en ~0s) pero los subtítulos empiezan en startT, desplazarlos al tiempo real
      if (!clipObj.subsFromFullBlob && startT > 2 && Math.abs(realStartBase - startT) > 2 && subs.length) {
        const shift = realStartBase - startT;
        subs = subs.map(s => ({ ...s, start: Math.max(0, s.start + shift), end: Math.max(0.5, s.end + shift) }));
        for (let i = 0; i < words.length; i++) {
          words[i] = { ...words[i], start: Math.max(0, words[i].start + shift), end: Math.max(0.1, words[i].end + shift) };
        }
      }
      recStartedAt = performance.now();
      drawFrame();
      // 24 fps con setInterval: mitad de carga de CPU que requestAnimationFrame y nunca se pausa en segundo plano ligero
      drawTimer = setInterval(drawFrame, 42);
      await new Promise(r => setTimeout(r, 120));
      rec.start(500);

      await new Promise(resolve => {
        const endTimer = setTimeout(resolve, clipMs);
        offVideo.onended = () => { clearTimeout(endTimer); resolve(); };
      });
      clearInterval(drawTimer);
      drawTimer = null;
      offVideo.pause();
      if (rec.state !== 'inactive') rec.stop();
      await new Promise(r => { rec.onstop = r; });

      const mimeClean = (chosen.mime || 'video/webm').split(';')[0];
      return { blob: new Blob(chunks, { type: mimeClean }), ext: chosen.ext, subs };
    } finally {
      if (drawTimer) clearInterval(drawTimer);
      try { if (keepAliveOsc) { keepAliveOsc.stop(); keepAliveOsc.disconnect(); } } catch (_) {}
      try { if (keepAliveGain) keepAliveGain.disconnect(); } catch (_) {}
      try { if (sourceNode) sourceNode.disconnect(); } catch (_) {}
      try { if (silentGain) silentGain.disconnect(); } catch (_) {}
      try { offVideo.pause(); offVideo.src = ''; offVideo.remove(); } catch (_) {}
      try { URL.revokeObjectURL(srcUrl); } catch (_) {}
    }
  }

  async function sendBlobToTelegram({ blob, ext, title, emotion, reason, score, transcript, subs, startOffset, credit }) {
    if (!isTelegramConfigured()) {
      throw new Error('Configura tu Bot Token y Chat ID de Telegram primero');
    }
    if (blob.size > 49 * 1024 * 1024) {
      throw new Error('El clip supera el límite de 50 MB de Telegram Bot API');
    }
    const { botToken, chatId, sendSrt } = state.telegram;
    const emoTag = emotion ? `[${emotionLabel(emotion)}] ` : '';
    const lines = [
      `🔥 ${emoTag}${title || 'Corte Épico'}${score ? ` (⭐ ${score}/100)` : ''}`
    ];
    if (reason) lines.push(`💡 ${reason}`);
    if (transcript) lines.push(`💬 Subtítulos:\n"${transcript.slice(0, 520)}"`);
    if (credit) lines.push(credit.trim());
    const caption = lines.join('\n\n').slice(0, 1020);

    const safeName = String(title || 'cliphub_epico').replace(/[^\w-]+/g, '_').slice(0, 40) || 'cliphub_epico';
    const fd = new FormData();
    fd.append('chat_id', chatId);
    fd.append('video', blob, `${safeName}.${ext || 'mp4'}`);
    fd.append('caption', caption);
    fd.append('supports_streaming', 'true');

    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendVideo`, {
      method: 'POST',
      body: fd
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.description || `Telegram HTTP ${res.status}`);
    }

    // Enviar archivo .SRT adjunto si está activado y hay subtítulos
    if (sendSrt && Array.isArray(subs) && subs.length) {
      const srtText = buildSrtContent(subs, startOffset || 0);
      if (srtText) {
        const srtFd = new FormData();
        srtFd.append('chat_id', chatId);
        srtFd.append('document', new Blob([srtText], { type: 'application/x-subrip' }), `${safeName}.srt`);
        srtFd.append('caption', `📝 Subtítulos SRT — ${title || 'Corte Épico'}`.slice(0, 1000));
        await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendDocument`, {
          method: 'POST',
          body: srtFd
        }).catch(() => {});
      }
    }
    return data;
  }

  async function processTelegramQueue() {
    if (tgSending || !tgQueue.length) return;
    tgSending = true;
    while (tgQueue.length) {
      const c = tgQueue.shift();
      try {
        let finalBlob = c.blob;
        let finalExt = c.ext || 'mp4';
        let finalSubs = c.subtitles || [];

        // Comprobar si los subtítulos cubren todo el clip (los clips con pre-roll de 45-90s necesitan transcribir el tramo completo)
        const clipLenSec = Math.max(5, (Number(c.end) || Number(c.dur) || 60) - (Number(c.start) || 0));
        const subsSpan = finalSubs.length
          ? (Math.max(...finalSubs.map(s => Number(s.end) || 0)) - Math.min(...finalSubs.map(s => Number(s.start) || 0)))
          : 0;
        const needsFullTranscribe = (!finalSubs.length || subsSpan < clipLenSec * 0.55);
        const hasGroqForSubs = Boolean((state.ai.groqKey || '').trim() || hasProxy());

        if (needsFullTranscribe && c.blob && hasGroqForSubs) {
          if ($('tgStatusText')) $('tgStatusText').textContent = `🎙️ Transcribiendo subtítulos completos de "${c.name}"...`;
          try {
            const tr = await transcribeVideoWithGroqWhisper(c.blob);
            if (tr?.segments?.length) {
              c.transcript = tr.text || '';
              c.subtitles = tr.segments;
              c.words = tr.words || [];
              c.subsFromFullBlob = true;
              finalSubs = c.subtitles;
            }
          } catch (trErr) {
            console.warn('Error transcribiendo clip para Telegram:', trErr);
            if ($('tgStatusText')) $('tgStatusText').textContent = `⚠️ Whisper no pudo transcribir (${trErr.message}). Usando texto disponible...`;
          }
        } else if (!finalSubs.length && !hasGroqForSubs) {
          if ($('tgStatusText')) $('tgStatusText').textContent = `⚠️ Sin clave de Groq Whisper: conecta Groq en "⚙️ Tokens IA" para subtítulos reales.`;
        }

        if (state.telegram.burnSubs !== false) {
          if ($('tgStatusText')) $('tgStatusText').textContent = `🎬 Renderizando subtítulos en "${c.name}" para Telegram (${tgQueue.length} en cola)...`;
          const rendered = await renderOffscreenClipWithSubtitles(c);
          finalBlob = rendered.blob;
          finalExt = rendered.ext;
          finalSubs = rendered.subs;
        }

        if ($('tgStatusText')) $('tgStatusText').textContent = `✈️ Enviando "${c.name}" a Telegram...`;
        await sendBlobToTelegram({
          blob: finalBlob,
          ext: finalExt,
          title: c.name,
          emotion: c.emotion,
          reason: c.reason,
          score: c.score,
          transcript: c.transcript || finalSubs.map(s => s.text).join(' '),
          subs: finalSubs,
          startOffset: c.start || 0,
          credit: creatorCredit(c.creator, c.src || (c.creator && c.creator.url) || '')
        });
        c.tgStatus = '✅ Enviado a Telegram';
        if ($('tgStatusText')) $('tgStatusText').textContent = `✅ "${c.name}" enviado a Telegram con subtítulos.`;
        pushTelegramHistory({ ok: true, title: c.name, emotion: c.emotion, time: new Date().toLocaleTimeString() });
        renderLiveClips();
        showToast(`✈️ "${c.name}" enviado a Telegram`, 'ok');
      } catch (err) {
        c.tgStatus = `❌ Error TG`;
        if ($('tgStatusText')) $('tgStatusText').textContent = `❌ No se pudo enviar "${c.name}" a Telegram: ${err.message}`;
        pushTelegramHistory({ ok: false, title: c.name, emotion: c.emotion, error: err.message, time: new Date().toLocaleTimeString() });
        renderLiveClips();
        showToast(`Error Telegram: ${err.message}`, 'warn');
      }
    }
    tgSending = false;
  }

  function enqueueTelegramLiveClip(clipObj) {
    saveTelegramConfigFromUI(true);
    if (!isTelegramConfigured()) {
      showToast('Configura tu Bot Token y Chat ID de Telegram en el Radar Épico', 'warn');
      return;
    }
    tgQueue.push(clipObj);
    if ($('tgStatusText')) $('tgStatusText').textContent = `📥 "${clipObj.name}" añadido a la cola de envío a Telegram...`;
    processTelegramQueue();
  }

  // Botón "Enviar a Telegram" dentro del Modal de Exportación (el video YA tiene subtítulos, filtros y PNG quemados)
  $('sendExportToTgBtn')?.addEventListener('click', async () => {
    saveTelegramConfigFromUI(true);
    if (!isTelegramConfigured()) {
      showToast('Configura primero tu Bot Token y Chat ID de Telegram en el panel YouTube / En Directo', 'warn');
      return;
    }
    if (!state.lastExport?.blob) {
      showToast('Primero renderiza el clip para enviarlo', 'warn');
      return;
    }
    const btn = $('sendExportToTgBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Enviando...';
    try {
      const cut = state.cuts[state.activeCutIdx] || {};
      const transcript = (state.subtitles || []).map(s => s.text).join(' ');
      await sendBlobToTelegram({
        blob: state.lastExport.blob,
        ext: state.lastExport.ext || 'mp4',
        title: cut.title || state.videoName || 'Clip ClipHub',
        emotion: cut.emotion || '',
        reason: cut.reason || '',
        score: cut.score || 0,
        transcript,
        subs: state.subtitles || [],
        startOffset: state.startTime || 0,
        credit: state.sourceCredit || ''
      });
      pushTelegramHistory({ ok: true, title: cut.title || state.videoName || 'Clip', emotion: cut.emotion || '', time: new Date().toLocaleTimeString() });
      showToast('✈️ Clip enviado a Telegram con subtítulos incluidos', 'ok');
    } catch (err) {
      showToast(`Error al enviar a Telegram: ${err.message}`, 'warn');
    } finally {
      btn.disabled = false;
      btn.textContent = '✈️ Enviar a Telegram';
    }
  });

  refreshTelegramUI();

  // ==================== v10: SUB-PESTAÑAS EN VIVO, HUD, HISTORIAL TG, PLANTILLA DE MARCA Y ATAJOS ====================

  // 1. Sub-pestañas de la pestaña "En Vivo & Radar"
  function setLiveSubTab(key) {
    document.querySelectorAll('#liveSubTabs .live-subtab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.liveSub === key);
    });
    document.querySelectorAll('.live-subpane').forEach(p => {
      p.classList.toggle('active', p.id === 'livePane-' + key);
    });
  }
  document.querySelectorAll('#liveSubTabs .live-subtab').forEach(btn => {
    btn.addEventListener('click', () => setLiveSubTab(btn.dataset.liveSub));
  });

  // 2. Controles y sincronización del HUD fijo en vivo
  $('hudCutNowBtn')?.addEventListener('click', () => liveCutNow());
  $('hudStopBtn')?.addEventListener('click', () => liveStop());
  $('hudOpenLiveBtn')?.addEventListener('click', () => {
    document.querySelector('[data-tab="live"]')?.click();
    setLiveSubTab('capture');
  });

  if ($('liveRadarBadge') && $('hudRadarBadge') && typeof MutationObserver !== 'undefined') {
    const syncHudBadge = () => {
      $('hudRadarBadge').textContent = $('liveRadarBadge').textContent;
      $('hudRadarBadge').className = $('liveRadarBadge').className;
    };
    const badgeObs = new MutationObserver(syncHudBadge);
    badgeObs.observe($('liveRadarBadge'), { childList: true, characterData: true, subtree: true, attributes: true });
    syncHudBadge();
  }

  // 3. Mini historial de los últimos 5 envíos a Telegram
  function loadTelegramHistory() {
    try {
      const arr = JSON.parse(safeGet('cliphub_tg_history', '[]'));
      return Array.isArray(arr) ? arr.slice(0, 5) : [];
    } catch (_) { return []; }
  }
  function renderTelegramHistory() {
    const list = loadTelegramHistory();
    const box = $('tgHistoryList');
    if (box) {
      if (!list.length) {
        box.innerHTML = '<div class="muted" style="font-size:0.75rem;">Sin envíos recientes todavía.</div>';
      } else {
        box.innerHTML = list.map(item => `
          <div class="tg-history-item">
            <div class="row" style="gap:6px; min-width:0;">
              <span>${item.ok ? '✅' : '❌'}</span>
              ${item.emotion ? `<span class="badge emo-${escapeHtml(item.emotion)}">${escapeHtml(emotionLabel(item.emotion))}</span>` : ''}
              <strong style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:260px;">${escapeHtml(item.title || 'Clip')}</strong>
            </div>
            <span class="muted" style="font-size:0.72rem; flex-shrink:0;">${escapeHtml(item.time || '')}</span>
          </div>
        `).join('');
      }
    }
    if ($('hudTgLast')) {
      if (!list.length) {
        $('hudTgLast').textContent = isTelegramConfigured() ? 'Telegram: listo' : 'Telegram: sin configurar';
      } else {
        const last = list[0];
        $('hudTgLast').textContent = `TG: ${last.ok ? '✅' : '❌'} ${(last.title || 'Clip').slice(0, 26)} (${last.time})`;
      }
    }
  }
  function pushTelegramHistory(entry) {
    const list = loadTelegramHistory();
    list.unshift(entry);
    safeSet('cliphub_tg_history', JSON.stringify(list.slice(0, 5)));
    renderTelegramHistory();
  }
  $('tgClearHistoryBtn')?.addEventListener('click', () => {
    safeSet('cliphub_tg_history', '[]');
    renderTelegramHistory();
    showToast('Historial de Telegram limpiado', '');
  });
  renderTelegramHistory();

  // 4. Guardado automático de Estilo de Marca / Plantilla Visual
  function saveBrandPreset(notify = false) {
    const preset = {
      aspect: state.aspect,
      subStyle: state.subStyle,
      showSubs: state.showSubs,
      cutDuration: state.cutDuration,
      filterPreset: state.edit.filterPreset,
      brightness: state.edit.brightness,
      contrast: state.edit.contrast,
      saturate: state.edit.saturate,
      grayscale: state.edit.grayscale,
      sepia: state.edit.sepia,
      showHook: state.edit.showHook,
      hookColor: state.edit.hookColor,
      watermark: state.edit.watermark,
      watermarkPos: state.edit.watermarkPos,
      watermarkOpacity: state.edit.watermarkOpacity
    };
    safeSet('cliphub_brand_preset', JSON.stringify(preset));
    if (notify) showToast('💾 Plantilla de marca guardada (se cargará automáticamente)', 'ok');
  }

  function loadBrandPreset() {
    try {
      const p = JSON.parse(safeGet('cliphub_brand_preset', 'null'));
      if (!p || typeof p !== 'object') return;
      if (p.aspect) applyAspectRatio(p.aspect);
      if (p.subStyle && $('subStyleSelect')) {
        state.subStyle = p.subStyle;
        $('subStyleSelect').value = p.subStyle;
      }
      if (typeof p.showSubs === 'boolean' && $('showSubsCheck')) {
        state.showSubs = p.showSubs;
        $('showSubsCheck').checked = p.showSubs;
      }
      if (p.cutDuration) {
        setCutDuration(Number(p.cutDuration), false);
        if ($('quickDurSelect') && ['10','15','30','45','60'].includes(String(p.cutDuration))) {
          $('quickDurSelect').value = String(p.cutDuration);
        }
      }
      if (p.filterPreset && $('edFilterPreset')) {
        state.edit.filterPreset = p.filterPreset;
        $('edFilterPreset').value = p.filterPreset;
      }
      ['brightness', 'contrast', 'saturate', 'grayscale', 'sepia'].forEach(k => {
        if (typeof p[k] === 'number') state.edit[k] = p[k];
      });
      syncColorSliders();
      if (typeof p.showHook === 'boolean' && $('edShowHookCheck')) {
        state.edit.showHook = p.showHook;
        $('edShowHookCheck').checked = p.showHook;
      }
      if (p.hookColor && $('edHookColorSelect')) {
        state.edit.hookColor = p.hookColor;
        $('edHookColorSelect').value = p.hookColor;
      }
      if (typeof p.watermark === 'string' && $('edWatermarkInput')) {
        state.edit.watermark = p.watermark;
        $('edWatermarkInput').value = p.watermark;
      }
      if (p.watermarkPos && $('edWatermarkPos')) {
        state.edit.watermarkPos = p.watermarkPos;
        $('edWatermarkPos').value = p.watermarkPos;
      }
      if (typeof p.watermarkOpacity === 'number' && $('edWatermarkOpacity')) {
        state.edit.watermarkOpacity = p.watermarkOpacity;
        const pct = Math.round(p.watermarkOpacity * 100);
        $('edWatermarkOpacity').value = String(pct);
        if ($('edWmOpVal')) $('edWmOpVal').textContent = `${pct}%`;
      }
    } catch (_) {}
  }

  $('edSaveBrandBtn')?.addEventListener('click', () => saveBrandPreset(true));
  ['aspectSelect', 'edAspectSelect', 'subStyleSelect', 'showSubsCheck', 'edFilterPreset', 'edHookColorSelect', 'edWatermarkInput', 'edWatermarkPos', 'edWatermarkOpacity', 'edShowHookCheck'].forEach(id => {
    $(id)?.addEventListener('change', () => saveBrandPreset(false));
  });
  loadBrandPreset();

  // 4b. Controles de Cortes por Enlace de YouTube (tamaño, tiempo, subtítulos y corte manual)
  if ($('ytLinkInput2') && $('ytUrlInput')) {
    $('ytLinkInput2').addEventListener('input', e => { $('ytUrlInput').value = e.target.value; });
    $('ytUrlInput').addEventListener('input', e => { $('ytLinkInput2').value = e.target.value; });
  }
  function saveYtCutPrefs() {
    safeSet('cliphub_yt_cut_prefs', JSON.stringify({
      aspect: $('ytAspectSelect')?.value || '9:16',
      res: $('ytResSelect')?.value || 'sd',
      dur: Number($('ytCutDurInput')?.value) || 45,
      burnSubs: Boolean($('ytBurnSubsCheck')?.checked),
      subStyle: $('ytSubStyleSelect')?.value || 'word',
      autoTg: Boolean($('ytAutoTgCheck')?.checked)
    }));
  }
  function syncYtDurPills(val) {
    document.querySelectorAll('.yt-dur-pill').forEach(p => {
      p.classList.toggle('active', Number(p.dataset.ytDur) === Number(val));
    });
  }
  document.querySelectorAll('.yt-dur-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const secs = Number(pill.dataset.ytDur) || 45;
      if ($('ytCutDurInput')) $('ytCutDurInput').value = String(secs);
      syncYtDurPills(secs);
      saveYtCutPrefs();
      showToast(`Duración de cortes YouTube: ${secs} s`, 'ok');
    });
  });
  $('ytCutDurInput')?.addEventListener('input', e => { syncYtDurPills(e.target.value); saveYtCutPrefs(); });
  ['ytAspectSelect', 'ytResSelect', 'ytBurnSubsCheck', 'ytSubStyleSelect', 'ytAutoTgCheck'].forEach(id => {
    $(id)?.addEventListener('change', saveYtCutPrefs);
  });
  try {
    const yp = JSON.parse(safeGet('cliphub_yt_cut_prefs', 'null'));
    if (yp && typeof yp === 'object') {
      if (yp.aspect && $('ytAspectSelect')) $('ytAspectSelect').value = yp.aspect;
      if (yp.res && $('ytResSelect')) $('ytResSelect').value = yp.res;
      if (yp.dur && $('ytCutDurInput')) { $('ytCutDurInput').value = String(yp.dur); syncYtDurPills(yp.dur); }
      if (typeof yp.burnSubs === 'boolean' && $('ytBurnSubsCheck')) $('ytBurnSubsCheck').checked = yp.burnSubs;
      if (yp.subStyle && $('ytSubStyleSelect')) $('ytSubStyleSelect').value = yp.subStyle;
      if (typeof yp.autoTg === 'boolean' && $('ytAutoTgCheck')) $('ytAutoTgCheck').checked = yp.autoTg;
    }
  } catch (_) {}

  $('ytManualRecBtn')?.addEventListener('click', () => {
    const rawUrl = ($('ytLinkInput2')?.value || $('ytUrlInput')?.value || '').trim();
    const id = ytId(rawUrl);
    if (!id) { showToast('Pega primero un enlace válido de YouTube arriba', 'warn'); return; }
    const fromMin = parseFloat($('ytFromMin')?.value);
    const startSec = isFinite(fromMin) && fromMin > 0 ? Math.floor(fromMin * 60) : 0;
    const durSec = Math.max(5, Math.min(180, Number($('ytCutDurInput')?.value) || 45));
    const endSec = startSec + durSec;
    const link = `https://youtu.be/${id}?t=${startSec}`;
    recordYtClips([{
      id,
      s: startSec,
      e: endSec,
      title: `Corte YouTube ${fmtT(startSec)}-${fmtT(endSec)}`,
      emotion: '',
      reason: `Corte manual de ${durSec} s en formato ${$('ytAspectSelect')?.value || '9:16'}`,
      score: 0,
      caption: '',
      link,
      creator: getCreator()
    }]);
  });

  // ==================== v17: CONTROLADOR DEL VISUALIZADOR ESTILO YOUTUBE (GRILLA 3 COLUMNAS + MINIATURAS REALES) ====================
  const viewerState = {
    clips: [],
    activeId: null,
    filter: 'all',
    loop: true,
    activeUrl: null
  };

  $('closeYtCutPreviewBtn')?.addEventListener('click', () => {
    if ($('ytCutPreviewIframe')) $('ytCutPreviewIframe').src = '';
    if ($('ytCutPreviewWrap')) $('ytCutPreviewWrap').style.display = 'none';
  });

  function updateViewerNavBadge() {
    const n = viewerState.clips.length;
    if ($('viewerNavBtn')) $('viewerNavBtn').textContent = `📺 Visualizador (${n})`;
    if ($('viewerCountBadge')) $('viewerCountBadge').textContent = `${n} clip${n === 1 ? '' : 's'}`;
  }

  // Extrae una miniatura real 16:9 desde el video Blob para mostrar en la tarjeta estilo YouTube
  function captureViewerThumbnail(entry) {
    if (!entry || !entry.blob || entry.thumbUrl) return;
    const v = document.createElement('video');
    const url = URL.createObjectURL(entry.blob);
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      try { v.pause(); v.src = ''; } catch (_) {}
      try { URL.revokeObjectURL(url); } catch (_) {}
    };
    const grab = () => {
      if (finished) return;
      try {
        if (v.videoWidth > 0 && v.videoHeight > 0) {
          const c = document.createElement('canvas');
          c.width = 480;
          c.height = 270;
          const g = c.getContext('2d');
          const vr = v.videoWidth / v.videoHeight;
          const cr = c.width / c.height;
          let sx = 0, sy = 0, sw = v.videoWidth, sh = v.videoHeight;
          if (vr > cr) { sw = v.videoHeight * cr; sx = (v.videoWidth - sw) / 2; }
          else { sh = v.videoWidth / cr; sy = (v.videoHeight - sh) / 2; }
          g.drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
          entry.thumbUrl = c.toDataURL('image/jpeg', 0.8);
          if (!entry.dur && isFinite(v.duration) && v.duration > 0) {
            entry.dur = v.duration;
          }
          renderViewerList();
        }
      } catch (_) {}
      cleanup();
    };
    v.onloadeddata = () => {
      const seekTarget = (entry.source === 'live' && entry.start > 0.5)
        ? entry.start + 1
        : (isFinite(v.duration) && v.duration > 2 ? Math.min(2, v.duration * 0.2) : 0.2);
      if (seekTarget > 0.25) {
        v.onseeked = grab;
        try { v.currentTime = seekTarget; } catch (_) { grab(); }
        setTimeout(grab, 1400);
      } else {
        grab();
      }
    };
    v.onerror = cleanup;
    setTimeout(cleanup, 5000);
    v.src = url;
    v.load();
  }

  function registerViewerClip(meta) {
    const id = 'vc_' + Date.now() + '_' + Math.random().toString(16).slice(2, 6);
    const entry = {
      id,
      source: meta.source || 'studio',
      title: meta.title || 'Corte sin título',
      blob: meta.blob,
      ext: meta.ext || 'mp4',
      dur: Number(meta.dur) || 0,
      start: Number(meta.start) || 0,
      end: Number(meta.end) || Number(meta.dur) || 0,
      aspect: meta.aspect || '9:16',
      emotion: meta.emotion || '',
      reason: meta.reason || '',
      score: Number(meta.score) || 0,
      hasSubs: Boolean(meta.hasSubs),
      transcript: meta.transcript || '',
      subtitles: Array.isArray(meta.subtitles) ? meta.subtitles : [],
      words: Array.isArray(meta.words) ? meta.words : [],
      credit: meta.credit || '',
      thumbUrl: '',
      createdAt: new Date().toLocaleTimeString()
    };
    viewerState.clips.unshift(entry);
    if (viewerState.clips.length > 24) {
      viewerState.clips = viewerState.clips.slice(0, 24);
    }
    updateViewerNavBadge();
    renderViewerList();
    captureViewerThumbnail(entry);
    return id;
  }

  function getFilteredViewerClips() {
    if (viewerState.filter === 'all') return viewerState.clips;
    return viewerState.clips.filter(c => c.source === viewerState.filter);
  }

  function sourceTagLabel(src) {
    if (src === 'live') return 'En Vivo';
    if (src === 'yt') return 'YouTube';
    if (src === 'local') return 'Archivo Local';
    return 'Estudio';
  }

  function sourceAvatarIcon(src) {
    if (src === 'live') return '🔴';
    if (src === 'yt') return '▶️';
    if (src === 'local') return '📁';
    return '✂️';
  }

  function closeViewerTheater() {
    const theater = $('viewerTheater');
    const vEl = $('viewerVideo');
    if (vEl) { try { vEl.pause(); vEl.src = ''; } catch (_) {} }
    if (viewerState.activeUrl) { try { URL.revokeObjectURL(viewerState.activeUrl); } catch (_) {} viewerState.activeUrl = null; }
    if (theater) theater.classList.remove('open');
    viewerState.activeId = null;
    renderViewerList();
  }

  $('viewerCloseTheaterBtn')?.addEventListener('click', closeViewerTheater);

  function selectViewerClip(id, autoPlay = true) {
    const clip = viewerState.clips.find(c => c.id === id);
    const theater = $('viewerTheater');
    const vEl = $('viewerVideo');
    if (!clip || !vEl) {
      closeViewerTheater();
      return;
    }

    viewerState.activeId = clip.id;
    if (viewerState.activeUrl) { try { URL.revokeObjectURL(viewerState.activeUrl); } catch (_) {} }
    viewerState.activeUrl = URL.createObjectURL(clip.blob);

    if (theater) theater.classList.add('open');
    vEl.src = viewerState.activeUrl;
    vEl.loop = viewerState.loop;
    vEl.playbackRate = Number($('viewerSpeedSelect')?.value) || 1;
    vEl.onloadedmetadata = () => {
      if (clip.source === 'live' && clip.start > 0.2 && isFinite(vEl.duration) && clip.start < vEl.duration - 1) {
        try { vEl.currentTime = clip.start; } catch (_) {}
      }
      if (autoPlay) {
        vEl.play().then(() => {
          if ($('viewerPlayBtn')) $('viewerPlayBtn').textContent = '⏸ Pausar';
        }).catch(() => {});
      }
    };
    vEl.ontimeupdate = () => {
      if (clip.source === 'live' && viewerState.loop && clip.end > clip.start + 1 && vEl.currentTime >= clip.end) {
        vEl.currentTime = clip.start;
      }
    };

    if ($('viewerClipTitle')) $('viewerClipTitle').textContent = clip.title;
    if ($('viewerClipBadges')) {
      const badges = [];
      badges.push(`<span class="badge">${escapeHtml(sourceAvatarIcon(clip.source) + ' ' + sourceTagLabel(clip.source))}</span>`);
      badges.push(`<span class="badge purple">${escapeHtml(clip.aspect)}</span>`);
      if (clip.hasSubs) badges.push('<span class="badge green">💬 Subtítulos</span>');
      if (clip.emotion) badges.push(`<span class="badge emo-${escapeHtml(clip.emotion)}">${escapeHtml(emotionLabel(clip.emotion))}</span>`);
      $('viewerClipBadges').innerHTML = badges.join('');
    }
    if ($('viewerClipInfo')) {
      const sizeMb = (clip.blob.size / 1048576).toFixed(1);
      $('viewerClipInfo').textContent = `${clip.createdAt} · ${fmtT(clip.dur)} · ${sizeMb} MB${clip.score ? ` · ⭐ ${clip.score}/100` : ''}${clip.reason ? `
💡 ${clip.reason}` : ''}`;
    }
    if ($('viewerClipSubs')) {
      const txt = (clip.transcript || (clip.subtitles || []).map(s => s.text).join(' ')).trim();
      if (txt) {
        $('viewerClipSubs').textContent = `💬 Subtítulos:
${txt}`;
        $('viewerClipSubs').style.display = 'block';
      } else {
        $('viewerClipSubs').style.display = 'none';
      }
    }
    renderViewerList();
    theater?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openClipInViewer(id) {
    document.querySelector('[data-tab="viewer"]')?.click();
    if (id) selectViewerClip(id, true);
    else if (viewerState.clips.length) selectViewerClip(viewerState.clips[0].id, true);
  }

  function renderViewerList() {
    const box = $('viewerClipsList');
    if (!box) return;
    const list = getFilteredViewerClips();
    if (!list.length) {
      box.innerHTML = `
        <div class="viewer-empty-grid">
          <div style="font-size:2.4rem; margin-bottom:8px;">📺</div>
          <strong style="color:var(--text); font-size:1rem;">No hay cortes en esta categoría todavía</strong>
          <div class="muted" style="margin-top:6px;">Cuando saques un corte en <strong>En Vivo</strong>, generes uno desde <strong>YouTube</strong> o exportes desde el <strong>Estudio</strong>, aparecerá aquí con su miniatura.</div>
        </div>
      `;
      return;
    }
    box.textContent = '';
    list.forEach(c => {
      const card = document.createElement('div');
      card.className = 'yt-card' + (c.id === viewerState.activeId ? ' active' : '');
      const durText = c.dur > 0 ? fmtT(c.dur) : 'CLIP';
      const sizeMb = (c.blob.size / 1048576).toFixed(1);
      const topBadges = [];
      if (c.hasSubs) topBadges.push('<span class="badge green">💬 SUBS</span>');
      if (c.emotion) topBadges.push(`<span class="badge emo-${escapeHtml(c.emotion)}">${escapeHtml(emotionLabel(c.emotion))}</span>`);
      topBadges.push(`<span class="badge">${escapeHtml(c.aspect)}</span>`);

      card.innerHTML = `
        <div class="yt-thumb-box">
          ${c.thumbUrl ? `<img src="${c.thumbUrl}" alt="${escapeHtml(c.title)}" />` : `<div style="width:100%;height:100%;display:grid;place-items:center;font-size:2rem;color:#475569;">🎬</div>`}
          <div class="yt-thumb-play">▶</div>
          <div class="yt-thumb-top-badges">${topBadges.join('')}</div>
          <span class="yt-thumb-dur ${c.source === 'live' ? 'live-pill' : ''}">${c.source === 'live' ? '🔴 ' : ''}${escapeHtml(durText)}</span>
        </div>
        <div class="yt-card-body">
          <div class="yt-avatar" title="${escapeHtml(sourceTagLabel(c.source))}">${sourceAvatarIcon(c.source)}</div>
          <div class="yt-meta-col">
            <div class="yt-title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</div>
            <div class="yt-submeta">${escapeHtml(sourceTagLabel(c.source))} · ${sizeMb} MB · ${escapeHtml(c.createdAt)}</div>
          </div>
        </div>
        <div class="yt-card-actions">
          <button type="button" class="btn btn-sm btn-tg" data-v-tg="${c.id}">✈️ Telegram</button>
          <button type="button" class="btn btn-sm btn-green" data-v-dl="${c.id}">⬇️ Bajar</button>
          <button type="button" class="btn btn-sm" data-v-st="${c.id}">✂️ Estudio</button>
          <button type="button" class="btn btn-sm btn-danger" data-v-del="${c.id}" title="Eliminar">🗑️</button>
        </div>
      `;

      card.addEventListener('click', () => selectViewerClip(c.id, true));
      card.querySelector('[data-v-tg]')?.addEventListener('click', ev => {
        ev.stopPropagation();
        sendViewerClipToTelegram(c, ev.currentTarget);
      });
      card.querySelector('[data-v-dl]')?.addEventListener('click', ev => {
        ev.stopPropagation();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(c.blob);
        a.download = `${String(c.title).replace(/[^\w-]+/g, '_')}_${c.aspect.replace(':', 'x')}.${c.ext}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      });
      card.querySelector('[data-v-st]')?.addEventListener('click', ev => {
        ev.stopPropagation();
        loadViewerClipToStudio(c);
      });
      card.querySelector('[data-v-del]')?.addEventListener('click', ev => {
        ev.stopPropagation();
        viewerState.clips = viewerState.clips.filter(x => x.id !== c.id);
        if (viewerState.activeId === c.id) closeViewerTheater();
        updateViewerNavBadge();
        renderViewerList();
        showToast('Corte eliminado del visualizador', '');
      });

      box.appendChild(card);
    });
  }

  function loadViewerClipToStudio(clip) {
    if (!clip) return;
    if (vVideoEl) vVideoEl.pause();
    pendingWindow = { start: clip.source === 'live' ? clip.start : 0, end: clip.source === 'live' ? clip.end : clip.dur };
    pendingLiveSubs = {
      name: clip.title,
      emotion: clip.emotion,
      reason: clip.reason,
      score: clip.score || 92,
      transcript: clip.transcript,
      subtitles: clip.subtitles,
      words: clip.words
    };
    state.videoBlob = clip.blob;
    loadVideoSrc(URL.createObjectURL(clip.blob), clip.title, clip.dur);
    state.sourceCredit = clip.credit || '';
    document.querySelector('[data-tab="studio"]')?.click();
  }

  // Controles del Visualizador
  const vVideoEl = $('viewerVideo');
  vVideoEl?.addEventListener('play', () => { if ($('viewerPlayBtn')) $('viewerPlayBtn').textContent = '⏸ Pausar'; });
  vVideoEl?.addEventListener('pause', () => { if ($('viewerPlayBtn')) $('viewerPlayBtn').textContent = '▶ Reproducir'; });

  $('viewerPlayBtn')?.addEventListener('click', () => {
    if (!vVideoEl || !vVideoEl.src) return;
    if (vVideoEl.paused) vVideoEl.play().catch(() => {});
    else vVideoEl.pause();
  });

  $('viewerLoopBtn')?.addEventListener('click', () => {
    viewerState.loop = !viewerState.loop;
    if (vVideoEl) vVideoEl.loop = viewerState.loop;
    if ($('viewerLoopBtn')) $('viewerLoopBtn').style.borderColor = viewerState.loop ? 'var(--green)' : 'var(--border)';
    showToast(viewerState.loop ? 'Bucle activado en visualizador' : 'Bucle desactivado', '');
  });

  $('viewerSpeedSelect')?.addEventListener('change', e => {
    if (vVideoEl) vVideoEl.playbackRate = Number(e.target.value) || 1;
  });

  $('viewerPrevBtn')?.addEventListener('click', () => {
    const list = getFilteredViewerClips();
    if (!list.length) return;
    const idx = list.findIndex(c => c.id === viewerState.activeId);
    const prevIdx = idx <= 0 ? list.length - 1 : idx - 1;
    selectViewerClip(list[prevIdx].id, true);
  });

  $('viewerNextBtn')?.addEventListener('click', () => {
    const list = getFilteredViewerClips();
    if (!list.length) return;
    const idx = list.findIndex(c => c.id === viewerState.activeId);
    const nextIdx = (idx + 1) % list.length;
    selectViewerClip(list[nextIdx].id, true);
  });

  $('viewerDownloadBtn')?.addEventListener('click', () => {
    const clip = viewerState.clips.find(c => c.id === viewerState.activeId);
    if (!clip) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(clip.blob);
    a.download = `${String(clip.title).replace(/[^\w-]+/g, '_')}_${clip.aspect.replace(':', 'x')}.${clip.ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  async function sendViewerClipToTelegram(clip, btnEl = null) {
    if (!clip) {
      showToast('Selecciona un corte primero para enviarlo a Telegram', 'warn');
      return;
    }
    saveTelegramConfigFromUI(true);
    if (!isTelegramConfigured()) {
      showToast('Configura tu Bot Token y Chat ID en En Vivo & Radar → Radar & Telegram', 'warn');
      return;
    }
    if (clip.source === 'live' && state.telegram.burnSubs !== false) {
      enqueueTelegramLiveClip({
        name: clip.title,
        blob: clip.blob,
        ext: clip.ext,
        start: clip.start,
        end: clip.end,
        dur: clip.dur,
        emotion: clip.emotion,
        reason: clip.reason,
        score: clip.score,
        transcript: clip.transcript,
        subtitles: clip.subtitles,
        words: clip.words,
        creator: null,
        src: ''
      });
      showToast(`📥 "${clip.title}" procesándose con subtítulos para Telegram...`, 'ok');
      return;
    }

    const origText = btnEl ? btnEl.textContent : '';
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳'; }
    try {
      await sendBlobToTelegram({
        blob: clip.blob,
        ext: clip.ext,
        title: clip.title,
        emotion: clip.emotion,
        reason: clip.reason,
        score: clip.score,
        transcript: clip.transcript || (clip.subtitles || []).map(s => s.text).join(' '),
        subs: clip.subtitles || [],
        startOffset: clip.start || 0,
        credit: clip.credit || ''
      });
      pushTelegramHistory({ ok: true, title: clip.title, emotion: clip.emotion, time: new Date().toLocaleTimeString() });
      showToast(`✈️ "${clip.title}" enviado a Telegram`, 'ok');
    } catch (err) {
      showToast(`Error Telegram: ${err.message}`, 'warn');
    } finally {
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = origText; }
    }
  }

  $('viewerSendTgBtn')?.addEventListener('click', () => {
    const clip = viewerState.clips.find(c => c.id === viewerState.activeId);
    sendViewerClipToTelegram(clip, $('viewerSendTgBtn'));
  });
  $('viewerTopSendTgBtn')?.addEventListener('click', () => {
    const clip = viewerState.clips.find(c => c.id === viewerState.activeId) || viewerState.clips[0];
    sendViewerClipToTelegram(clip, $('viewerTopSendTgBtn'));
  });

  $('viewerLoadStudioBtn')?.addEventListener('click', () => {
    const clip = viewerState.clips.find(c => c.id === viewerState.activeId);
    loadViewerClipToStudio(clip);
  });

  $('viewerDeleteOneBtn')?.addEventListener('click', () => {
    if (!viewerState.activeId) return;
    viewerState.clips = viewerState.clips.filter(c => c.id !== viewerState.activeId);
    updateViewerNavBadge();
    closeViewerTheater();
    showToast('Corte eliminado del visualizador', '');
  });

  $('viewerClearAllBtn')?.addEventListener('click', () => {
    viewerState.clips = [];
    updateViewerNavBadge();
    closeViewerTheater();
    showToast('Visualizador vaciado', '');
  });

  document.querySelectorAll('#viewerFilterPills [data-vfilter]').forEach(btn => {
    btn.addEventListener('click', () => {
      viewerState.filter = btn.dataset.vfilter;
      document.querySelectorAll('#viewerFilterPills [data-vfilter]').forEach(b => b.classList.toggle('active', b === btn));
      renderViewerList();
    });
  });

  $('viewerAddLocalBtn')?.addEventListener('click', () => $('viewerLocalFileInput')?.click());
  $('viewerLocalFileInput')?.addEventListener('change', e => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    let firstId = null;
    files.forEach(file => {
      const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
      const id = registerViewerClip({
        source: 'local',
        title: file.name.replace(/\.[^.]+$/, ''),
        blob: file,
        ext,
        dur: 0,
        aspect: 'Original',
        hasSubs: false
      });
      if (!firstId) firstId = id;
    });
    if (firstId) selectViewerClip(firstId, true);
    e.target.value = '';
  });

  $('openExportInViewerBtn')?.addEventListener('click', () => {
    $('exportModal')?.classList.remove('open');
    openClipInViewer(viewerState.clips[0]?.id);
  });

  // Pausar el visualizador si el usuario cambia a otra pestaña
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab !== 'viewer' && vVideoEl && !vVideoEl.paused) {
        vVideoEl.pause();
      }
    });
  });

  // ==================== v16: MOTOR BACKEND AUTOMÁTICO (DESCARGA + CORTE + SUBTÍTULOS + ENVÍO BAJO ORDEN) ====================
  function getYtBackendUrl() {
    return String($('ytBackendUrlInput')?.value || '').trim().replace(/\/+$/, '');
  }

  async function checkYtBackendHealth(silent = false) {
    const base = getYtBackendUrl();
    const badge = $('ytBackendBadge');
    const st = $('ytBackendStatusText');
    if (!base) {
      if (badge) { badge.textContent = 'Sin URL'; badge.className = 'badge'; }
      return false;
    }
    safeSet('cliphub_yt_backend_url', base);
    if (!silent && st) st.textContent = '⏳ Comprobando conexión con el motor automático...';
    try {
      const res = await fetch(`${base}/health`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(`HTTP ${res.status}`);
      const ready = Boolean(data.ffmpeg && data.ytdlp);
      if (badge) {
        badge.textContent = ready ? '🟢 Conectado' : '⚠️ Falta FFmpeg/yt-dlp';
        badge.className = ready ? 'badge green' : 'badge amber';
      }
      if (st) {
        st.textContent = ready
          ? `✅ Motor listo en ${base} (yt-dlp + FFmpeg activos). Ya puedes descargar, cortar y subtitular automáticamente.`
          : `⚠️ Servidor activo pero falta instalar: ${!data.ytdlp ? 'yt-dlp ' : ''}${!data.ffmpeg ? 'FFmpeg' : ''}.`;
      }
      if (!silent) showToast(ready ? 'Motor automático conectado' : 'Falta yt-dlp o FFmpeg en el servidor', ready ? 'ok' : 'warn');
      return ready;
    } catch (err) {
      if (badge) { badge.textContent = '🔴 Desconectado'; badge.className = 'badge amber'; }
      if (!silent && st) {
        st.textContent = `❌ No se pudo conectar a ${base}. Ejecuta "python server.py" en tu PC o pega la URL de tu servidor en la nube.`;
      }
      if (!silent) showToast('No se pudo conectar al servidor automático', 'warn');
      return false;
    }
  }

  const savedBackendUrl = safeGet('cliphub_yt_backend_url', '');
  if (savedBackendUrl && $('ytBackendUrlInput')) {
    $('ytBackendUrlInput').value = savedBackendUrl;
  }
  $('ytBackendUrlInput')?.addEventListener('change', () => safeSet('cliphub_yt_backend_url', getYtBackendUrl()));
  $('ytBackendCheckBtn')?.addEventListener('click', () => checkYtBackendHealth(false));
  // Comprobación silenciosa al iniciar
  checkYtBackendHealth(true);

  let backendBusy = false;
  async function processYtClipsViaBackend(items, opts = {}) {
    if (backendBusy) {
      showToast('Ya se está procesando un corte en el servidor, espera un momento', 'warn');
      return;
    }
    if (!items || !items.length) {
      showToast('Marca al menos un corte como "Aprobar" o usa el botón de corte manual', 'warn');
      return;
    }
    const base = getYtBackendUrl();
    if (!base) {
      showToast('Ingresa la URL del Motor Automático (ej. http://localhost:8000)', 'warn');
      return;
    }

    const st = $('ytRecStatus');
    const ytAspect = $('ytAspectSelect')?.value || '9:16';
    const ytRes = $('ytResSelect')?.value || 'sd';
    const ytBurnSubs = Boolean($('ytBurnSubsCheck')?.checked);
    const ytSubStyle = $('ytSubStyleSelect')?.value || state.subStyle || 'word';
    const shouldAutoTg = Boolean(opts.autoTg || $('ytAutoTgCheck')?.checked);
    const groqKey = (state.ai.groqKey || '').trim();

    backendBusy = true;
    let doneCount = 0;
    try {
      const online = await checkYtBackendHealth(true);
      if (!online) {
        throw new Error(`El servidor en ${base} no responde. Ejecuta "python server.py" primero.`);
      }

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const ytUrl = `https://www.youtube.com/watch?v=${it.id}`;
        if (st) st.textContent = `⚡ [${i + 1}/${items.length}] Descargando, cortando (${ytAspect}) y subtitulando "${it.title}"...`;
        showToast(`⚡ Procesando "${it.title}" en el servidor...`, '');

        const res = await fetch(`${base}/api/yt-cut`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: ytUrl,
            start: Number(it.s) || 0,
            end: Number(it.e) || 45,
            aspect: ytAspect,
            res: ytRes,
            burnSubs: ytBurnSubs,
            subStyle: ytSubStyle,
            groqKey,
            title: it.title
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          throw new Error(data.detail || `Error del servidor HTTP ${res.status}`);
        }

        if (st) st.textContent = `📥 [${i + 1}/${items.length}] Cargando video final en el Visualizador...`;
        const fileRes = await fetch(`${base}${data.downloadUrl}`);
        if (!fileRes.ok) throw new Error(`No se pudo bajar el clip generado (HTTP ${fileRes.status})`);
        const blob = await fileRes.blob();

        const clip = {
          blob,
          ext: 'mp4',
          dur: Number(data.duration) || Math.max(3, (it.e || 45) - (it.s || 0)),
          it,
          precise: true,
          ok: true,
          aspect: data.aspect || ytAspect,
          hasSubs: Boolean(data.hasSubs),
          transcript: data.transcript || '',
          subtitles: Array.isArray(data.segments) ? data.segments : [],
          words: Array.isArray(data.words) ? data.words : [],
          backendClipId: data.clipId
        };

        addYtClip(clip);
        doneCount++;
        if (data.subsWarning) {
          showToast(`⚠️ Subtítulos: ${data.subsWarning}`, 'warn');
        }

        // Solo envía a Telegram si el usuario marcó "Auto-enviar" o lo pidió explícitamente
        if (shouldAutoTg) {
          saveTelegramConfigFromUI(true);
          if (!isTelegramConfigured()) {
            showToast('Clip listo, pero falta configurar tu Bot Token y Chat ID en Radar & Telegram', 'warn');
          } else {
            if (st) st.textContent = `✈️ [${i + 1}/${items.length}] Enviando "${it.title}" a Telegram...`;
            await sendBlobToTelegram({
              blob: clip.blob,
              ext: 'mp4',
              title: it.title,
              emotion: it.emotion || '',
              reason: it.reason || '',
              score: it.score || 0,
              transcript: clip.transcript || (clip.subtitles || []).map(s => s.text).join(' '),
              subs: clip.subtitles || [],
              startOffset: 0,
              credit: creatorCredit(it.creator, it.link)
            });
            pushTelegramHistory({ ok: true, title: it.title, emotion: it.emotion || '', time: new Date().toLocaleTimeString() });
            showToast(`✈️ "${it.title}" enviado a Telegram`, 'ok');
          }
        }
      }

      if (st) {
        st.textContent = `✅ ${doneCount} corte(s) listo(s) con subtítulos en ${ytAspect}. Revísalos abajo o en 📺 Visualizador y envíalos a Telegram cuando quieras.`;
      }
      showToast(`✅ ${doneCount} corte(s) listos en el Visualizador`, 'ok');
    } catch (err) {
      if (st) st.textContent = `❌ ${err.message}`;
      showToast(err.message, 'warn');
    } finally {
      backendBusy = false;
    }
  }

  $('ytAutoManualCutBtn')?.addEventListener('click', () => {
    const rawUrl = ($('ytLinkInput2')?.value || $('ytUrlInput')?.value || '').trim();
    const id = ytId(rawUrl);
    if (!id) { showToast('Pega primero un enlace válido de YouTube arriba', 'warn'); return; }
    const fromMin = parseFloat($('ytFromMin')?.value);
    const startSec = isFinite(fromMin) && fromMin > 0 ? Math.floor(fromMin * 60) : 0;
    const durSec = Math.max(5, Math.min(180, Number($('ytCutDurInput')?.value) || 45));
    const endSec = startSec + durSec;
    const link = `https://youtu.be/${id}?t=${startSec}`;
    processYtClipsViaBackend([{
      id,
      s: startSec,
      e: endSec,
      title: `Corte YouTube ${fmtT(startSec)}-${fmtT(endSec)}`,
      emotion: '',
      reason: `Corte automático de ${durSec} s en ${$('ytAspectSelect')?.value || '9:16'}`,
      score: 0,
      caption: '',
      link,
      creator: getCreator()
    }], { autoTg: false });
  });

  // 5. Atajos de teclado globales (ignorados cuando se escribe en campos de texto)
  window.addEventListener('keydown', e => {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const key = e.key;
    if (key === 'k' || key === 'K') {
      if (liveCapture.stream) {
        e.preventDefault();
        liveCutNow();
      }
      return;
    }

    if (state.activeTab !== 'studio' && state.activeTab !== 'editor') return;
    if (!video.src) return;

    if (key === ' ') {
      e.preventDefault();
      togglePlayPause();
    } else if (key === 'i' || key === 'I') {
      e.preventDefault();
      $('edMarkStartBtn')?.click();
    } else if (key === 'o' || key === 'O') {
      e.preventDefault();
      $('edMarkEndBtn')?.click();
    } else if (key === 's' || key === 'S') {
      e.preventDefault();
      $('edSplitCutBtn')?.click();
    } else if (key === 'ArrowLeft') {
      e.preventDefault();
      const step = e.shiftKey ? 5 : 1;
      video.currentTime = Math.max(0, (video.currentTime || 0) - step);
    } else if (key === 'ArrowRight') {
      e.preventDefault();
      const step = e.shiftKey ? 5 : 1;
      video.currentTime = Math.min(state.duration || 9999, (video.currentTime || 0) + step);
    }
  });

})();
