function showToast(message, type = 'error', duration = 3000) {
    // dialog 通过 showModal() 打开时位于浏览器顶层（top layer），其 ::backdrop 会盖住
    // 普通文档流中的任何元素（z-index 再高也没用）。因此当有 dialog 打开时，把气泡挂到
    // 该 dialog 内部，使其随 dialog 一起进入顶层，避免被模糊遮罩遮挡。
    const openDialog = document.querySelector('dialog[open]');
    let container;
    if (openDialog) {
        container = openDialog.querySelector(':scope > .toast-container--dialog');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container toast-container--dialog';
            openDialog.appendChild(container);
        }
    } else {
        container = document.getElementById('toast-container');
    }
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });
    });

    setTimeout(() => {
        toast.classList.remove('show');
        toast.classList.add('hide');
        let removed = false;
        const remove = () => {
            if (removed) return;
            removed = true;
            toast.remove();
        };
        toast.addEventListener('transitionend', remove, { once: true });
        // Fallback：transitionend 在某些场景（prefers-reduced-motion、display:none、
        // 没有过渡属性等）下不会触发，加一个兜底定时器避免 DOM 累积
        setTimeout(remove, 500);
    }, duration);
}

function showError(message, error = null) {
    console.error(message, error);
    showToast(message, 'error');
}

const ALLOWED_PAGE_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_ICON_PROTOCOLS = new Set(['http:', 'https:', 'chrome-extension:']);
const MAX_SHORTCUTS = 120;
const MAX_SHORTCUT_NAME_LENGTH = 80;
const MAX_ICON_DATA_URL_CHARS = 750 * 1024;
// 自定义背景 data URL 的字符数安全上限：需容纳 4K 图经 JPEG 压缩后的 base64
// （高细节 4K q0.7 可达 7–11MB 字符），故放宽至 12MB；仍作为防超长字符串的安全网
const MAX_BACKGROUND_DATA_URL_CHARS = 12 * 1024 * 1024;
const MAX_EXPORTED_FAVICONS = 80; // 与 background.js 的 MAX_FAVICON_CACHE_ENTRIES 保持一致
const FAVICON_CONCURRENCY = 4;

// --- 壁纸模式配置 ---
const BG_MODES = ['default', 'bing', 'custom'];
// 必应官方壁纸接口（无鉴权、免费、稳定，最多获取近 7 天壁纸）
const BING_API_BASE = 'https://cn.bing.com';
const BING_API_URL = `${BING_API_BASE}/HPImageArchive.aspx?format=json&idx=0&n=8&mkt=zh-CN`;
const BING_QUALITIES = ['uhd', 'hd'];
// 画质标识：uhd → UHD，hd → 1920x1080（用于拼接 /th?id=OHR.XXX_{quality}.jpg&rf=LaDigue_{quality}.jpg&pid=hp）
const BING_QUALITY_MAP = { uhd: 'UHD', hd: '1920x1080' };
// 必应壁纸自动更换间隔（毫秒）：每 12 小时 / 每天 / 每 3 天 / 每周
const BING_INTERVALS = [43200000, 86400000, 259200000, 604800000];
const DEFAULT_BING_INTERVAL = 86400000;

function normalizeHttpUrl(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    try {
        const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
        const url = new URL(withProtocol);
        if (!ALLOWED_PAGE_PROTOCOLS.has(url.protocol) || !url.hostname) return null;
        return url.toString();
    } catch {
        return null;
    }
}

function isImageDataUrl(value, maxChars) {
    return typeof value === 'string' &&
        value.length <= maxChars &&
        /^data:image\/(?:png|jpeg|jpg|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,/i.test(value);
}

function sanitizeIconUrl(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (isImageDataUrl(trimmed, MAX_ICON_DATA_URL_CHARS)) return trimmed;

    try {
        const url = new URL(trimmed);
        if (!ALLOWED_ICON_PROTOCOLS.has(url.protocol)) return null;
        if (url.protocol === 'chrome-extension:') {
            const currentExtensionOrigin = new URL(chrome.runtime.getURL('/')).origin;
            if (url.origin !== currentExtensionOrigin) return null;
        }
        return url.toString();
    } catch {
        return null;
    }
}

function sanitizeShortcut(item) {
    if (!item || typeof item !== 'object') return null;
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, MAX_SHORTCUT_NAME_LENGTH) : '';
    const url = normalizeHttpUrl(item.url);
    if (!name || !url) return null;

    const sanitized = { name, url };
    const icon = sanitizeIconUrl(item.icon);
    if (icon) sanitized.icon = icon;
    return sanitized;
}

function sanitizeShortcuts(value, fallback = []) {
    const source = Array.isArray(value) ? value : fallback;
    const result = [];
    for (const item of source) {
        const sanitized = sanitizeShortcut(item);
        if (sanitized) result.push(sanitized);
        if (result.length >= MAX_SHORTCUTS) break;
    }
    return result;
}

function parseJsonSafe(value, fallback) {
    if (typeof value !== 'string') return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function sanitizeColorMode(value) {
    return ['auto', 'light', 'dark'].includes(value) ? value : 'auto';
}

function sanitizeBackgroundValue(value) {
    if (!value || value === 'none') return null;
    if (
        typeof value === 'string' &&
        value.length <= MAX_BACKGROUND_DATA_URL_CHARS &&
        /^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(value)
    ) {
        return value;
    }
    return null;
}

function sanitizeBgMode(value) {
    return BG_MODES.includes(value) ? value : 'default';
}

function sanitizeBingQuality(value) {
    return BING_QUALITIES.includes(value) ? value : 'uhd';
}

function sanitizeBingInterval(value) {
    const num = Number(value);
    return BING_INTERVALS.includes(num) ? num : DEFAULT_BING_INTERVAL;
}

function sanitizeFaviconCache(favicons) {
    if (!favicons || typeof favicons !== 'object' || Array.isArray(favicons)) return {};

    const entries = Object.entries(favicons)
        .filter(([key, entry]) => {
            return /^favicon_[a-z0-9.-]+$/i.test(key) &&
                entry &&
                typeof entry === 'object' &&
                isImageDataUrl(entry.dataUrl, MAX_ICON_DATA_URL_CHARS);
        })
        .sort((a, b) => Number(b[1].timestamp || 0) - Number(a[1].timestamp || 0))
        .slice(0, MAX_EXPORTED_FAVICONS);

    return Object.fromEntries(entries);
}

function validateImportedData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('导入文件格式无效');
    }

    return {
        shortcuts: data.shortcuts === undefined ? undefined : sanitizeShortcuts(data.shortcuts),
        gridCols: data.gridCols === undefined ? undefined : clampNumber(data.gridCols, 3, 10, 5),
        gridSize: data.gridSize === undefined ? undefined : clampNumber(data.gridSize, 80, 160, 100),
        scale: data.scale === undefined ? undefined : clampNumber(data.scale, 50, 200, 100),
        customBg: data.customBg === undefined ? undefined : sanitizeBackgroundValue(data.customBg),
        bgMode: data.bgMode === undefined ? undefined : sanitizeBgMode(data.bgMode),
        bingQuality: data.bingQuality === undefined ? undefined : sanitizeBingQuality(data.bingQuality),
        bingInterval: data.bingInterval === undefined ? undefined : sanitizeBingInterval(data.bingInterval),
        bingLastFetch: data.bingLastFetch === undefined ? undefined : clampNumber(data.bingLastFetch, 0, Number.MAX_SAFE_INTEGER, 0),
        bingBg: data.bingBg === undefined ? undefined : sanitizeBackgroundValue(data.bingBg),
        colorMode: data.colorMode === undefined ? undefined : sanitizeColorMode(data.colorMode),
        favicons: data.favicons === undefined ? undefined : sanitizeFaviconCache(data.favicons)
    };
}

// --- chrome.storage.local 兼容 localStorage 层 ---
const Storage = (function() {
    let pendingWrites = {};
    let writeTimeout = null;
    let flushResolveQueue = [];
    let writeErrorNotified = false;
    const WRITE_DELAY = 500;

    function notifyWriteError() {
        if (writeErrorNotified) return;
        writeErrorNotified = true;
        // 5 秒内只提示一次，避免刷屏
        setTimeout(() => { writeErrorNotified = false; }, 5000);
        try {
            showToast('数据保存失败，部分设置可能未持久化', 'error');
        } catch {}
    }

    function flushWrites() {
        if (writeTimeout) {
            clearTimeout(writeTimeout);
            writeTimeout = null;
        }

        const resolveQueue = flushResolveQueue;
        flushResolveQueue = [];

        if (Object.keys(pendingWrites).length > 0) {
            const dataToWrite = { ...pendingWrites };
            pendingWrites = {};
            return new Promise(resolve => {
                chrome.storage.local.set(dataToWrite, () => {
                    const lastError = chrome.runtime.lastError;
                    if (lastError) {
                        console.error('Storage write error:', lastError);
                        notifyWriteError();
                    }
                    resolveQueue.forEach(resolveItem => resolveItem(!lastError));
                    resolve(!lastError);
                });
            });
        }

        resolveQueue.forEach(resolveItem => resolveItem(true));
        return Promise.resolve(true);
    }

    function scheduleWrite(key, value) {
        pendingWrites[key] = value;
        if (writeTimeout) clearTimeout(writeTimeout);
        writeTimeout = setTimeout(flushWrites, WRITE_DELAY);
        return new Promise(resolve => {
            flushResolveQueue.push(resolve);
        });
    }

    return {
        get(key, defaultVal = null) {
            return new Promise(resolve => {
                chrome.storage.local.get([key], res => {
                    if (chrome.runtime.lastError) {
                        console.error('Storage read error:', chrome.runtime.lastError);
                        resolve(defaultVal);
                        return;
                    }
                    resolve(res[key] ?? defaultVal);
                });
            });
        },
        
        set(key, value) {
            return scheduleWrite(key, value);
        },
        
        setBatch(items) {
            Object.assign(pendingWrites, items);
            if (writeTimeout) clearTimeout(writeTimeout);
            writeTimeout = setTimeout(flushWrites, WRITE_DELAY);
            return new Promise(resolve => {
                flushResolveQueue.push(resolve);
            });
        },
        
        setImmediate(key, value) {
            delete pendingWrites[key];
            return new Promise(resolve => {
                chrome.storage.local.set({ [key]: value }, () => {
                    const lastError = chrome.runtime.lastError;
                    if (lastError) {
                        console.error('Storage write error:', lastError);
                        notifyWriteError();
                    }
                    resolve(!lastError);
                });
            });
        },
        
        remove(key) {
            const keys = Array.isArray(key) ? key : [key];
            for (const item of keys) {
                if (Object.prototype.hasOwnProperty.call(pendingWrites, item)) {
                    delete pendingWrites[item];
                }
            }
            return new Promise(resolve => {
                chrome.storage.local.remove(key, () => {
                    const lastError = chrome.runtime.lastError;
                    if (lastError) {
                        console.error('Storage remove error:', lastError);
                        notifyWriteError();
                    }
                    resolve(!lastError);
                });
            });
        },
        
        flush() {
            if (Object.keys(pendingWrites).length > 0) {
                return flushWrites();
            }
            return Promise.resolve();
        }
    };
})();

window.addEventListener('beforeunload', () => {
    Storage.flush();
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        Storage.flush();
    }
});

// 在页面加载早期获取并应用背景与颜色模式，避免闪烁
(async function() {
    // 先读小值配置立即应用主题，须在读取大体积壁纸之前完成，否则阻塞导致"先深后浅"闪烁
    const [rawBgMode, rawColorMode] = await Promise.all([
        Storage.get('bgMode', 'default'),
        Storage.get('colorMode', 'auto')
    ]);
    const bgModeValue = sanitizeBgMode(rawBgMode);
    const colorModeValue = sanitizeColorMode(rawColorMode);

    // 确定主题（与 <head> 防闪脚本逻辑一致）
    let earlyTheme;
    const htmlTheme = document.documentElement.classList.contains('theme-light') ? 'light'
                    : document.documentElement.classList.contains('theme-dark') ? 'dark'
                    : null;
    if (htmlTheme) {
        earlyTheme = htmlTheme;
    } else if (colorModeValue === 'light' || colorModeValue === 'dark') {
        earlyTheme = colorModeValue;
    } else {
        // 自动模式：用上次权威计算结果，缺失时回退系统偏好
        let cached;
        try { cached = localStorage.getItem('_resolvedTheme'); } catch(e) {}
        if (cached === 'light' || cached === 'dark') {
            earlyTheme = cached;
        } else {
            earlyTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        }
    }

    if (document.body) {
        document.body.classList.add(earlyTheme === 'light' ? 'light-bg' : 'dark-bg');
        // body 已接管主题，移除 <html> 上的临时防闪类
        document.documentElement.classList.remove('theme-light', 'theme-dark');
    }
    // 不在此处保存 _resolvedTheme：早期值可能不准确，覆写会污染缓存；
    // 它仅由 applyColorMode / detectBackgroundColor 权威检测后更新
    try {
        localStorage.setItem('_colorMode', colorModeValue);
        localStorage.setItem('_bgMode', bgModeValue);
    } catch(e) {}

    // 主题已应用，再读取大体积壁纸
    let earlyImage = null;
    if (bgModeValue === 'bing') {
        earlyImage = sanitizeBackgroundValue(await Storage.get('bingBg'));
    } else if (bgModeValue === 'custom') {
        earlyImage = sanitizeBackgroundValue(await Storage.get('customBg'));
    }

    const preloadBg = document.createElement('div');
    preloadBg.id = 'preload-bg';
    preloadBg.className = 'preloaded-bg';
    preloadBg.style.position = 'fixed';
    preloadBg.style.top = '0';
    preloadBg.style.left = '0';
    preloadBg.style.width = '100vw';
    preloadBg.style.height = '100vh';
    preloadBg.style.zIndex = '-1';
    
    if (earlyImage) {
        preloadBg.style.backgroundImage = `url('${earlyImage}')`;
        preloadBg.style.opacity = '1';
        document.documentElement.style.setProperty('--bg-image', `url('${earlyImage}')`);
        document.body.style.backgroundImage = `url('${earlyImage}')`;
        document.documentElement.classList.add('has-custom-bg');
        try { localStorage.setItem('_hasCustomBg', '1'); } catch(e) {}
    }
    
    // 插入到 body 首个子节点之前
    if (document.body) {
        if (document.body.firstChild) {
            document.body.insertBefore(preloadBg, document.body.firstChild);
        } else {
            document.body.appendChild(preloadBg);
        }
    } else {
        document.documentElement.appendChild(preloadBg);
    }
})();

document.addEventListener('DOMContentLoaded', async () => {

    // --- 1. 配置与初始化 ---

    // 搜索相关元素
    const searchInput = document.getElementById('search-input');
    const searchBtn = document.getElementById('search-btn');
    
    const settingsBtn = document.getElementById('settings-trigger');
    const settingsDialog = document.getElementById('settings-dialog');
    const settingsClose = document.getElementById('settings-close');
    
    // 背景相关元素
    const bgModeButtons = document.querySelectorAll('.bg-mode-segmented .seg-btn');
    const bgSubpanels = document.querySelectorAll('.bg-subpanel');
    const bingRefreshBtn = document.getElementById('bing-refresh-btn');
    const bingQualityButtons = document.querySelectorAll('.bg-quality-segmented .seg-btn');
    const bingIntervalSelect = document.getElementById('bing-interval-select');
    const customPreview = document.getElementById('custom-preview');
    const bgUploadInput = document.getElementById('bg-upload-input');
    const bgRemoveBtn = document.getElementById('bg-remove-btn');

    // 背景操作中断控制：令牌每次背景操作递增，用于让进行中的必应壁纸获取在用户
    // 切换模式/上传/移除背景时静默中断；bingAbortController 用于立即中止网络请求
    let bgActionToken = 0;
    let bingAbortController = null;
    // 画质切换时有抓取进行中而被迫跳过：登记后待其结束自动按新画质补一次抓取
    let bingRefetchPending = false;

    // 最高优先级：立即确认颜色模式，须在 renderShortcuts / loadBgSettings 等耗时操作之前执行
    const [savedColorMode, savedBgMode] = await Promise.all([
        Storage.get('colorMode', 'auto').then(sanitizeColorMode),
        Storage.get('bgMode', 'default').then(sanitizeBgMode)
    ]);
    try { localStorage.setItem('_colorMode', savedColorMode); localStorage.setItem('_bgMode', savedBgMode); } catch(e) {}
    await applyColorMode(savedColorMode);

    // 数据管理元素
    const exportDataBtn = document.getElementById('export-data-btn');
    const importDataInput = document.getElementById('import-data-input');

    // 布局设置元素
    const colInput = document.getElementById('setting-cols');
    const colValDisplay = document.getElementById('col-val');
    const sizeInput = document.getElementById('setting-size');
    const scaleInput = document.getElementById('setting-scale');
    const scaleValDisplay = document.getElementById('scale-val');
    
    // 颜色模式设置元素
    const colorModeButtons = document.querySelectorAll('.color-mode-buttons .glass-btn');

    // 快捷方式相关元素
    const grid = document.getElementById('shortcuts-grid');
    let currentDragElement = null;

    // ---- 背景 Blob 物理碰撞引擎（蓝/粉/紫三球弹性碰撞 + 边界反弹 + 呼吸缩放）----
    const blobsLayer = document.getElementById('blobs-layer');
    const blobEls = blobsLayer ? Array.from(blobsLayer.querySelectorAll('.blob')) : [];
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let blobRAF = null;
    let blobState = [];

    function initBlobState() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        blobState = blobEls.map((el) => {
            const rect = el.getBoundingClientRect();
            const r = (Math.max(rect.width, rect.height) / 2) || 240;
            return {
                el,
                r,
                x: Math.random() * Math.max(w - r * 2, 0) + r,
                y: Math.random() * Math.max(h - r * 2, 0) + r,
                vx: (Math.random() - 0.5) * 0.8,
                vy: (Math.random() - 0.5) * 0.8,
                phase: Math.random() * Math.PI * 2,
            };
        });
    }

    function stepBlobs() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        for (const b of blobState) {
            b.x += b.vx;
            b.y += b.vy;
            if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
            if (b.x + b.r > w) { b.x = w - b.r; b.vx = -Math.abs(b.vx); }
            if (b.y - b.r < 0) { b.y = b.r; b.vy = Math.abs(b.vy); }
            if (b.y + b.r > h) { b.y = h - b.r; b.vy = -Math.abs(b.vy); }
            const sp = Math.hypot(b.vx, b.vy);
            if (sp < 0.18) { b.vx += (Math.random() - 0.5) * 0.12; b.vy += (Math.random() - 0.5) * 0.12; }
            if (sp > 1.3) { b.vx *= 0.97; b.vy *= 0.97; }
        }
        // 球间弹性碰撞（等质量，沿法线交换速度分量并分离重叠）
        for (let i = 0; i < blobState.length; i++) {
            for (let j = i + 1; j < blobState.length; j++) {
                const a = blobState[i];
                const c = blobState[j];
                const dx = c.x - a.x;
                const dy = c.y - a.y;
                const dist = Math.hypot(dx, dy) || 0.0001;
                // 视觉半径因 blur 内缩，碰撞距离取几何半径之和的折中值，避免重叠成团或离太远
                const minDist = (a.r + c.r) * 0.6;
                if (dist < minDist) {
                    const nx = dx / dist;
                    const ny = dy / dist;
                    const overlap = (minDist - dist) / 2;
                    a.x -= nx * overlap; a.y -= ny * overlap;
                    c.x += nx * overlap; c.y += ny * overlap;
                    const va = a.vx * nx + a.vy * ny;
                    const vc = c.vx * nx + c.vy * ny;
                    const diff = vc - va;
                    a.vx += diff * nx; a.vy += diff * ny;
                    c.vx -= diff * nx; c.vy -= diff * ny;
                }
            }
        }
        const t = performance.now() / 1000;
        for (const b of blobState) {
            const s = 1 + Math.sin(t * 0.4 + b.phase) * 0.06;
            b.el.style.transform = 'translate3d(' + (b.x - b.r).toFixed(1) + 'px,' + (b.y - b.r).toFixed(1) + 'px,0) scale(' + s.toFixed(3) + ')';
        }
        blobRAF = requestAnimationFrame(stepBlobs);
    }

    function startBlobAnimation() {
        if (blobRAF !== null) return;
        if (reducedMotionQuery.matches) {
            for (const b of blobState) {
                b.el.style.transform = 'translate3d(' + (b.x - b.r).toFixed(1) + 'px,' + (b.y - b.r).toFixed(1) + 'px,0)';
            }
            return;
        }
        blobRAF = requestAnimationFrame(stepBlobs);
    }

    function stopBlobAnimation() {
        if (blobRAF !== null) { cancelAnimationFrame(blobRAF); blobRAF = null; }
    }

    function restartBlobAnimation() {
        stopBlobAnimation();
        if (!blobEls.length) return;
        // 自定义背景时不启动动画（容器已被 CSS 隐藏）
        if (document.documentElement.classList.contains('has-custom-bg')) return;
        initBlobState();
        requestAnimationFrame(() => blobEls.forEach((el) => el.classList.add('initialized')));
        startBlobAnimation();
    }

    window.addEventListener('resize', () => {
        if (!blobState.length) return;
        const w = window.innerWidth;
        const h = window.innerHeight;
        for (const b of blobState) {
            b.x = Math.min(Math.max(b.x, b.r), Math.max(w - b.r, b.r));
            b.y = Math.min(Math.max(b.y, b.r), Math.max(h - b.r, b.r));
        }
    });

    reducedMotionQuery.addEventListener('change', () => {
        stopBlobAnimation();
        if (!reducedMotionQuery.matches && !document.documentElement.classList.contains('has-custom-bg')) {
            startBlobAnimation();
        }
    });

    restartBlobAnimation();

    // 编辑对话框元素
    const editDialog = document.getElementById('edit-dialog');
    const nameInput = document.getElementById('shortcut-name');
    const urlInput = document.getElementById('shortcut-url');
    const iconInput = document.getElementById('shortcut-icon'); // 新增图标输入框
    const iconUploadInput = document.getElementById('shortcut-icon-upload'); // 图标上传输入框
    const refreshIconBtn = document.getElementById('refresh-icon-btn'); // 重新获取图标按钮
    const clearIconBtn = document.getElementById('clear-icon-btn');
    const iconPreview = document.getElementById('shortcut-icon-preview');
    const iconPreviewImg = document.getElementById('shortcut-icon-preview-img');
    const iconPreviewText = document.getElementById('shortcut-icon-preview-text');
    // 预览回退图标（未设置自定义图标时，展示与磁贴一致的站点 favicon；仅用于预览，不写入输入框）
    let iconPreviewFallback = null;
    const saveBtn = document.getElementById('save-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    let isEditing = false, editIndex = -1;

    // 右键菜单元素
    const contextMenu = document.getElementById('context-menu');
    const menuEdit = document.getElementById('menu-edit');
    const menuDelete = document.getElementById('menu-delete');
    let contextMenuIndex = -1;

    const settingsTabs = document.querySelectorAll('[data-settings-tab]');
    const settingsPanels = document.querySelectorAll('[data-settings-panel]');

    const DEFAULT_SHORTCUTS = [
        { name: "Google", url: "https://google.com" },
        { name: "Bilibili", url: "https://bilibili.com" },
        { name: "GitHub", url: "https://github.com" },
        { name: "Unsplash", url: "https://unsplash.com" }
    ];
    
    let shortcuts = sanitizeShortcuts(
        parseJsonSafe(await Storage.get('shortcuts', JSON.stringify(DEFAULT_SHORTCUTS)), DEFAULT_SHORTCUTS),
        DEFAULT_SHORTCUTS
    );

    // 渲染中止控制（提前声明，供早期渲染使用）
    let shortcutsAbortController = new AbortController();

    function getResponsiveColCount(cols, itemSize) {
        const gap = 20;
        const pagePadding = window.innerWidth <= 640 ? 32 : 64;
        const availableWidth = Math.max(itemSize, window.innerWidth - pagePadding);
        return Math.max(1, Math.min(cols, Math.floor((availableWidth + gap) / (itemSize + gap))));
    }

    function applyLayoutSettings(cols, itemSize, scale) {
        const normalizedCols = clampNumber(cols, 3, 10, 5);
        const normalizedSize = clampNumber(itemSize, 80, 160, 100);
        const normalizedScale = clampNumber(scale, 50, 200, 100);
        const scaleValue = normalizedScale / 100;
        const scaledItemSize = Math.round(normalizedSize * scaleValue);
        const scaledSearchWidth = Math.round(580 * scaleValue);
        document.documentElement.style.setProperty('--col-count', normalizedCols);
        document.documentElement.style.setProperty('--active-col-count', getResponsiveColCount(normalizedCols, scaledItemSize));
        document.documentElement.style.setProperty('--item-size', `${scaledItemSize}px`);
        document.documentElement.style.setProperty('--search-width', `${scaledSearchWidth}px`);
        document.documentElement.style.setProperty('--scale', scaleValue);
    }

    const [rawCols, rawSize, rawScale] = await Promise.all([
        Storage.get('gridCols', 5),
        Storage.get('gridSize', 100),
        Storage.get('scale', 100)
    ]);
    const savedCols = clampNumber(rawCols, 3, 10, 5);
    const savedSize = clampNumber(rawSize, 80, 160, 100);
    const savedScale = clampNumber(rawScale, 50, 200, 100);
    applyLayoutSettings(savedCols, savedSize, savedScale);

    // 优先渲染快捷方式，避免等待背景/主题检测期间网格长时间空白（消除“顿一下才显示”）
    await renderShortcuts();

    // --- 核心：加载并应用背景设置 ---
    const body = document.body;
    let preloadBg = document.getElementById('preload-bg');

    async function applyBackground(bgUrl) {
        const safeBgUrl = sanitizeBackgroundValue(bgUrl);
        // 确保preloadBg元素存在
        if (!preloadBg) {
            preloadBg = document.getElementById('preload-bg');
        }
        
        if (safeBgUrl) {
            // 直接应用背景图片，不再等待onload事件以提升加载速度
            if (preloadBg) {
                preloadBg.style.backgroundImage = `url('${safeBgUrl}')`;
                preloadBg.style.opacity = '1'; // 显示图片
            }
            
            // 设置CSS变量里的背景图URL
            document.documentElement.style.setProperty('--bg-image', `url('${safeBgUrl}')`);
            body.style.backgroundImage = `url('${safeBgUrl}')`;
            // 添加类名以隐藏默认的碰撞光球背景层，并停止其动画
            document.documentElement.classList.add('has-custom-bg');
            try { localStorage.setItem('_hasCustomBg', '1'); } catch(e) {}
            stopBlobAnimation();
            
            // 仅自动模式下检测背景亮度；手动模式是用户显式选择，不被壁纸亮度覆盖
            const colorModeNow = sanitizeColorMode(await Storage.get('colorMode', 'auto'));
            if (colorModeNow === 'auto') {
                await detectBackgroundColor(safeBgUrl);
            }
        } else {
            // 移除背景图片
            if (preloadBg) {
                preloadBg.style.backgroundImage = 'none';
                preloadBg.style.opacity = '0';
            }
            document.documentElement.style.setProperty('--bg-image', 'none');
            body.style.backgroundImage = '';
            document.documentElement.classList.remove('has-custom-bg');
            try { localStorage.removeItem('_hasCustomBg'); } catch(e) {}
            restartBlobAnimation();
            
            // 移除背景后重新应用颜色模式（自动模式将恢复跟随系统主题）
            const currentColorMode = sanitizeColorMode(await Storage.get('colorMode', 'auto'));
            await applyColorMode(currentColorMode);
        }
    }

    // --- 壁纸模式状态机 ---
    // 运行时状态（与 storage 保持同步，由 loadBgSettings 统一加载）
    let bgMode = 'default';
    let bingQuality = 'uhd';
    let bingInterval = DEFAULT_BING_INTERVAL;

    // 应用当前模式对应的背景
    // preloaded：调用方已读取的壁纸值（可选），避免重复把数 MB 的 data URL 从 storage 读入内存
    async function applyCurrentBackground(preloaded = {}) {
        if (bgMode === 'bing') {
            const cached = 'bing' in preloaded
                ? sanitizeBackgroundValue(preloaded.bing)
                : sanitizeBackgroundValue(await Storage.get('bingBg'));
            await applyBackground(cached);
        } else if (bgMode === 'custom') {
            const custom = 'custom' in preloaded
                ? sanitizeBackgroundValue(preloaded.custom)
                : sanitizeBackgroundValue(await Storage.get('customBg'));
            await applyBackground(custom);
        } else {
            await applyBackground(null);
        }
    }

    // 更新自定义背景子面板内的预览缩略图（preloadedCustom：调用方已读取的值，可选）
    async function updatePreviews(preloadedCustom) {
        const customImg = preloadedCustom !== undefined
            ? sanitizeBackgroundValue(preloadedCustom)
            : sanitizeBackgroundValue(await Storage.get('customBg'));
        if (customImg) {
            customPreview.style.backgroundImage = `url('${customImg}')`;
            customPreview.classList.add('has-image');
        } else {
            customPreview.style.backgroundImage = '';
            customPreview.classList.remove('has-image');
        }
    }

    // 同步模式分段控件高亮与子面板可见性
    function syncBgModeUI() {
        bgModeButtons.forEach(btn => {
            const active = btn.dataset.bgMode === bgMode;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-checked', active ? 'true' : 'false');
        });
        bgSubpanels.forEach(panel => {
            panel.hidden = panel.dataset.bgSubpanel !== bgMode;
        });
    }

    // 切换壁纸模式
    async function setBgMode(mode) {
        const next = sanitizeBgMode(mode);
        if (next === bgMode) return;
        // 用户切换模式：中断进行中的必应壁纸获取，避免其完成后覆盖新模式背景
        ++bgActionToken;
        if (bingAbortController) {
            bingAbortController.abort();
            bingAbortController = null;
        }
        bgMode = next;
        await Storage.setImmediate('bgMode', bgMode);
        try { localStorage.setItem('_bgMode', bgMode); } catch(e) {}
        syncBgModeUI();
        await applyCurrentBackground();
        // 首次切到必应壁纸模式且尚无缓存时主动拉取，
        // 否则要等到下次打开新标签页才会触发 fetchBing
        if (bgMode === 'bing') {
            const cached = sanitizeBackgroundValue(await Storage.get('bingBg'));
            if (!cached) fetchBing(false);
        }
    }

    // 加载壁纸设置并应用（初始化与数据导入后调用）
    async function loadBgSettings() {
        bgMode = sanitizeBgMode(await Storage.get('bgMode', 'default'));
        try { localStorage.setItem('_bgMode', bgMode); } catch(e) {}
        bingQuality = sanitizeBingQuality(await Storage.get('bingQuality', 'uhd'));
        bingInterval = sanitizeBingInterval(await Storage.get('bingInterval', DEFAULT_BING_INTERVAL));
        bingIntervalSelect.value = String(bingInterval);
        bingQualityButtons.forEach(btn => {
            const active = btn.dataset.bingQuality === bingQuality;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-checked', active ? 'true' : 'false');
        });
        syncBgModeUI();
        // 一次性读齐两个大体积壁纸项，后续应用/预览直接复用，避免重复跨进程读取
        const [bingBgValue, customBgValue] = await Promise.all([
            Storage.get('bingBg'),
            Storage.get('customBg')
        ]);
        await updatePreviews(customBgValue);
        await applyCurrentBackground({ bing: bingBgValue, custom: customBgValue });
    }

    // 带超时保护的 sendMessage（防止 Service Worker 无响应时 Promise 永久挂起）
    function sendMessageWithTimeout(message, timeoutMs, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) {
                return reject(new DOMException('Aborted', 'AbortError'));
            }
            const timer = setTimeout(() => {
                cleanup();
                reject(new DOMException('请求超时，请检查网络后重试', 'TimeoutError'));
            }, timeoutMs);
            const onAbort = () => {
                cleanup();
                reject(new DOMException('Aborted', 'AbortError'));
            };
            const cleanup = () => {
                clearTimeout(timer);
                if (signal) signal.removeEventListener('abort', onAbort);
            };
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            chrome.runtime.sendMessage(message).then(resolve).catch(reject).finally(cleanup);
        });
    }

    // 从必应官方接口随机获取一张壁纸
    // 流程：请求 HPImageArchive API 获取近 7 天壁纸列表 → 随机选取一张 → 拼接高清/4K URL → 下载图片
    // 路由到 background service worker 执行（service worker 享有 host_permissions 的 CORS 豁免）
    // 注意：Bing 官方接口可能返回 JSON 或 XML，此处兼容两种格式
    async function fetchBingWallpaper(quality, externalSignal) {
        if (externalSignal && externalSignal.aborted) throw new DOMException('Aborted', 'AbortError');

        // 1. 获取壁纸元数据（超时 35 秒，略大于 background 内部的 30 秒超时）
        let apiResponse;
        try {
            apiResponse = await sendMessageWithTimeout({
                action: 'fetchJson',
                url: BING_API_URL,
                timeoutMs: 30000
            }, 35000, externalSignal);
        } catch (msgError) {
            if (msgError.name === 'AbortError') throw msgError;
            if (msgError.name === 'TimeoutError') {
                throw new DOMException('获取壁纸列表超时：Service Worker 无响应，请在 chrome://extensions 重新加载扩展并关闭当前新标签页后重试', 'TimeoutError');
            }
            console.error('[fetchBingWallpaper] sendMessage 异常:', msgError);
            throw new TypeError(`与后台通信失败: ${msgError.message}`);
        }
        if (externalSignal && externalSignal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (!apiResponse || !apiResponse.success || !apiResponse.data) {
            const detail = !apiResponse ? '后台无响应（请在 chrome://extensions 重新加载扩展）'
                : (apiResponse.error || '未知错误');
            throw new TypeError(detail);
        }

        // 2. 解析壁纸列表（兼容 JSON 和 XML 两种响应格式）
        let urlbases = [];
        const payload = apiResponse.data;
        if (payload.type === 'json' && payload.data && Array.isArray(payload.data.images)) {
            // JSON 格式：{ images: [{ urlbase: '...' }, ...] }
            urlbases = payload.data.images
                .map(img => img && img.urlbase)
                .filter(Boolean);
        } else if (payload.type === 'text' && typeof payload.data === 'string') {
            // XML 格式：<images><image><urlBase>...</urlBase></image>...</images>
            try {
                const doc = new DOMParser().parseFromString(payload.data, 'text/xml');
                const nodes = doc.querySelectorAll('image urlBase');
                urlbases = Array.from(nodes).map(n => n.textContent).filter(Boolean);
            } catch {
                throw new TypeError('XML 解析失败');
            }
        }
        if (urlbases.length === 0) {
            throw new TypeError('接口未返回壁纸数据');
        }

        // 3. 随机选取一张，拼接对应画质的完整图片 URL
        // urlBase 格式：/th?id=OHR.Name_ZH-CN123456
        // 完整 URL：https://cn.bing.com/th?id=OHR.Name_ZH-CN123456_UHD.jpg（或 _1920x1080.jpg）
        const pickedBase = urlbases[Math.floor(Math.random() * urlbases.length)];
        const qualityTag = BING_QUALITY_MAP[quality] || BING_QUALITY_MAP.uhd;
        const imageUrl = `${BING_API_BASE}${pickedBase}_${qualityTag}.jpg`;
        if (externalSignal && externalSignal.aborted) throw new DOMException('Aborted', 'AbortError');

        // 4. 下载图片并转为 Data URL（超时 65 秒，略大于 background 内部的 60 秒超时）
        let imgResponse;
        try {
            imgResponse = await sendMessageWithTimeout({
                action: 'fetchWallpaper',
                url: imageUrl,
                timeoutMs: 60000
            }, 65000, externalSignal);
        } catch (msgError) {
            if (msgError.name === 'AbortError') throw msgError;
            if (msgError.name === 'TimeoutError') {
                throw new DOMException('图片下载超时：Service Worker 无响应，请检查网络或重新加载扩展', 'TimeoutError');
            }
            console.error('[fetchBingWallpaper] 图片下载异常:', msgError);
            throw new TypeError(`图片下载失败: ${msgError.message}`);
        }
        if (externalSignal && externalSignal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (!imgResponse || !imgResponse.success) {
            const detail = !imgResponse ? '后台无响应'
                : (imgResponse.error || '图片下载失败');
            throw new TypeError(detail);
        }
        return imgResponse.dataUrl;
    }

    // 获取必应壁纸；force=true 忽略间隔强制获取（换一张、切换画质时用）
    async function fetchBing(force = false) {
        if (bingRefreshBtn.classList.contains('loading')) return;

        const now = Date.now();
        const lastFetch = Number(await Storage.get('bingLastFetch', 0)) || 0;
        // 未到期且已有缓存时直接沿用缓存，不重复抓取
        if (!force && lastFetch && (now - lastFetch) < bingInterval) {
            const cached = sanitizeBackgroundValue(await Storage.get('bingBg'));
            if (cached) return;
        }

        bingRefreshBtn.classList.add('loading');
        bingRefreshBtn.disabled = true;
        const myToken = ++bgActionToken;
        const controller = new AbortController();
        bingAbortController = controller;

        try {
            const dataUrl = await fetchBingWallpaper(bingQuality, controller.signal);
            if (myToken !== bgActionToken) return;
            const compressedImage = await compressImage(dataUrl, 0.7);
            if (myToken !== bgActionToken) return;
            if (!isImageDataUrl(compressedImage, MAX_BACKGROUND_DATA_URL_CHARS)) {
                showError('壁纸过大，请尝试切换到 1080P 高清画质');
                return;
            }
            await Storage.setImmediate('bingBg', compressedImage);
            await Storage.setImmediate('bingLastFetch', Date.now());
            if (myToken !== bgActionToken) return;
            if (bgMode === 'bing') await applyBackground(compressedImage);
        } catch (error) {
            // 被用户主动中断（切换模式/上传/移除）时不提示错误
            if (myToken !== bgActionToken) return;
            const reason = error.name === 'AbortError' ? '请求已取消'
                : error.name === 'TimeoutError' ? (error.message || '请求超时，请检查网络后重试')
                : error instanceof TypeError ? '网络请求失败，请检查网络或稍后重试'
                : (error.message || '未知错误');
            showError(`获取壁纸失败：${reason}`);
            console.error('[BingWallpaper]', error);
        } finally {
            if (bingAbortController === controller) bingAbortController = null;
            bingRefreshBtn.classList.remove('loading');
            bingRefreshBtn.disabled = false;
            // 抓取期间用户切换过画质：仍处于必应壁纸模式时按最新画质补一次抓取
            if (bingRefetchPending && bgMode === 'bing') {
                bingRefetchPending = false;
                fetchBing(true);
            } else {
                bingRefetchPending = false;
            }
        }
    }

    // 初始化 Input 值
    colInput.value = savedCols;
    colValDisplay.innerText = savedCols;
    sizeInput.value = savedSize;
    scaleInput.value = savedScale;
    scaleValDisplay.innerText = savedScale + '%';
    
    // 初始化颜色模式设置（savedColorMode 已在最前方读取并应用）
    const initialColorBtn = document.querySelector(`.color-mode-buttons .glass-btn[data-mode="${savedColorMode}"]`);
    if (initialColorBtn) {
        initialColorBtn.classList.add('active');
        initialColorBtn.setAttribute('aria-checked', 'true');
    }

    // 监听系统主题变化
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', async (e) => {
        // 对话框始终跟随浏览器主题
        applyDialogSystemTheme();

        const currentColorMode = sanitizeColorMode(await Storage.get('colorMode', 'auto'));
        // 仅自动模式且无自定义背景时跟随系统主题变化；
        // 有自定义背景时颜色由背景亮度决定，不随系统主题切换
        if (currentColorMode === 'auto' && !document.documentElement.classList.contains('has-custom-bg')) {
            await applyColorMode('auto');
        }
    });
    
    // 确保自动模式下按钮有高亮显示
    if (savedColorMode === 'auto') {
        const autoButton = document.querySelector(`.color-mode-buttons .glass-btn[data-mode="auto"]`);
        if (autoButton && !autoButton.classList.contains('active')) {
            autoButton.classList.add('active');
            autoButton.setAttribute('aria-checked', 'true');
        }
    }
    
    // 对话框独立跟随浏览器系统主题
    applyDialogSystemTheme();

    // --- 壁纸设置初始化 ---
    await loadBgSettings();
    // 必应壁纸模式下，若自动更换已到期（或尚无缓存），后台抓取一张新壁纸
    if (bgMode === 'bing') {
        fetchBing(false);
    }

    // --- 2. 设置面板逻辑 ---
    settingsBtn.addEventListener('click', () => {
        settingsDialog.showModal();
    });
    
    settingsClose.addEventListener('click', () => settingsDialog.close());
    
    // 点击设置对话框外部关闭对话框
    settingsDialog.addEventListener('click', (e) => {
        if (e.target === settingsDialog) {
            settingsDialog.close();
        }
    });

    function activateSettingsTab(targetPanel) {
        settingsTabs.forEach(tab => {
            const active = tab.dataset.settingsTab === targetPanel;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            tab.tabIndex = active ? 0 : -1;
        });

        settingsPanels.forEach(panel => {
            const active = panel.dataset.settingsPanel === targetPanel;
            panel.classList.toggle('active', active);
            panel.hidden = !active;
        });
    }

    settingsTabs.forEach(tab => {
        tab.addEventListener('click', () => activateSettingsTab(tab.dataset.settingsTab));
        tab.addEventListener('keydown', (e) => {
            const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
            if (!keys.includes(e.key)) return;
            e.preventDefault();

            const tabs = Array.from(settingsTabs);
            const currentIndex = tabs.indexOf(tab);
            let nextIndex = currentIndex;
            if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
            if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
            if (e.key === 'Home') nextIndex = 0;
            if (e.key === 'End') nextIndex = tabs.length - 1;

            tabs[nextIndex].focus();
            activateSettingsTab(tabs[nextIndex].dataset.settingsTab);
        });
    });

    // 布局实时监听
    colInput.addEventListener('input', async (e) => {
        colValDisplay.innerText = e.target.value;
        e.target.setAttribute('aria-valuenow', e.target.value);
        applyLayoutSettings(e.target.value, sizeInput.value, scaleInput.value);
        await Storage.set('gridCols', e.target.value);
    });
    
    sizeInput.addEventListener('input', async (e) => {
        e.target.setAttribute('aria-valuenow', e.target.value);
        applyLayoutSettings(colInput.value, e.target.value, scaleInput.value);
        await Storage.set('gridSize', e.target.value);
    });
    
    scaleInput.addEventListener('input', async (e) => {
        scaleValDisplay.innerText = e.target.value + '%';
        e.target.setAttribute('aria-valuenow', e.target.value);
        applyLayoutSettings(colInput.value, sizeInput.value, e.target.value);
        await Storage.set('scale', e.target.value);
    });

    let layoutResizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(layoutResizeTimer);
        layoutResizeTimer = setTimeout(() => {
            applyLayoutSettings(colInput.value, sizeInput.value, scaleInput.value);
        }, 150);
    });
    
    // 颜色模式设置监听
    colorModeButtons.forEach(button => {
        button.addEventListener('click', async (e) => {
            // 移除所有按钮的激活状态
            colorModeButtons.forEach(btn => {
                btn.classList.remove('active');
                btn.setAttribute('aria-checked', 'false');
            });
            
            // 为当前点击的按钮添加激活状态
            button.classList.add('active');
            button.setAttribute('aria-checked', 'true');
            
            // 获取模式值
            const mode = sanitizeColorMode(button.dataset.mode);
            
            // 保存设置
            await Storage.set('colorMode', mode);
            try { localStorage.setItem('_colorMode', mode); } catch(e) {}
            
            // 应用新的颜色模式（auto 会按背景亮度/系统偏好重新计算）
            await applyColorMode(mode);
        });

        button.addEventListener('keydown', (e) => {
            const keys = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'];
            if (!keys.includes(e.key)) return;
            e.preventDefault();

            const buttons = Array.from(colorModeButtons);
            const currentIndex = buttons.indexOf(button);
            const direction = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
            const nextButton = buttons[(currentIndex + direction + buttons.length) % buttons.length];
            nextButton.focus();
            nextButton.click();
        });
    });

    // 保存快捷方式
    async function handleSaveShortcut(e) {
        if (e) e.preventDefault();
        const name = nameInput.value.trim();
        const finalUrl = normalizeHttpUrl(urlInput.value);
        const rawIcon = iconInput.value.trim();
        const icon = sanitizeIconUrl(rawIcon);

        if (rawIcon && !icon) {
            showError('请输入有效的图标 URL 或上传图片');
            return;
        }

        // 数量上限校验：超出上限的新增项会在渲染时被静默截断，必须在此拦截
        if (!isEditing && shortcuts.length >= MAX_SHORTCUTS) {
            showError(`快捷方式数量已达上限（${MAX_SHORTCUTS} 个）`);
            return;
        }

        if (name && finalUrl) {
            if (isEditing) {
                shortcuts[editIndex] = { name: name.slice(0, MAX_SHORTCUT_NAME_LENGTH), url: finalUrl };
                if (icon) {
                    shortcuts[editIndex].icon = icon;
                } else {
                    delete shortcuts[editIndex].icon;
                }
                await Storage.set('shortcuts', JSON.stringify(shortcuts));
                await renderShortcuts();
            } else {
                const newItem = { name: name.slice(0, MAX_SHORTCUT_NAME_LENGTH), url: finalUrl };
                if (icon) newItem.icon = icon;
                shortcuts.push(newItem);
                await Storage.set('shortcuts', JSON.stringify(shortcuts));
                await renderShortcuts(); 
            }
            
            editDialog.close();
        } else {
            showError('请输入有效的名称和网址');
        }
    }

    // 构造与磁贴一致的站点 favicon 预览地址（chrome 内置 _favicon 接口）
    function buildFaviconPreviewUrl(pageUrl) {
        try {
            const urlObj = new URL(chrome.runtime.getURL("/_favicon/"));
            urlObj.searchParams.set("pageUrl", pageUrl);
            urlObj.searchParams.set("size", "256");
            return urlObj.toString();
        } catch {
            return null;
        }
    }

    // 解析与磁贴完全一致的站点图标：优先读取磁贴所用的最佳 favicon 缓存（chrome.storage.local），
    // 未命中时回退到 _favicon 接口，确保编辑预览与磁贴显示一致
    async function resolveFaviconPreview(pageUrl) {
        let domain = null;
        try { domain = new URL(pageUrl).hostname; } catch {}
        if (domain) {
            try {
                const cacheKey = `favicon_${domain}`;
                const cached = await new Promise(resolve => chrome.storage.local.get(cacheKey, resolve));
                const entry = cached && cached[cacheKey];
                if (entry && isImageDataUrl(entry.dataUrl, MAX_ICON_DATA_URL_CHARS)) {
                    return entry.dataUrl;
                }
            } catch {}
        }
        return buildFaviconPreviewUrl(pageUrl);
    }

    function updateIconPreview() {
        const icon = sanitizeIconUrl(iconInput.value);
        if (icon) {
            iconPreviewImg.src = icon;
            iconPreview.classList.add('has-icon');
            iconPreviewText.textContent = '使用自定义图标';
        } else if (iconPreviewFallback) {
            // 未设置自定义图标时，预览与磁贴一致的站点 favicon（不写入输入框，保存时仍走自动获取）
            iconPreviewImg.src = iconPreviewFallback;
            iconPreview.classList.add('has-icon');
            iconPreviewText.textContent = '自动获取网站图标';
        } else {
            iconPreviewImg.removeAttribute('src');
            iconPreview.classList.remove('has-icon');
            iconPreviewText.textContent = '自动获取网站图标';
        }
    }

    // 绑定表单提交事件（仅 submit 一条路径，避免与 click 重复触发并保留原生 required 校验）
    const editForm = document.getElementById('edit-form');
    if (editForm) {
        editForm.addEventListener('submit', handleSaveShortcut);
    }
    cancelBtn.addEventListener('click', () => editDialog.close());
    iconInput.addEventListener('input', updateIconPreview);
    // 预览图加载失败时回退到占位状态（src 被清空时不触发，避免误报）
    iconPreviewImg.addEventListener('error', () => {
        if (!iconPreviewImg.getAttribute('src')) return;
        iconPreview.classList.remove('has-icon');
        iconPreviewText.textContent = '图标加载失败';
    });
    clearIconBtn.addEventListener('click', () => {
        iconInput.value = '';
        updateIconPreview();
    });

    // 图片压缩函数
    function compressImage(src, quality = 0.7) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = function() {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                
                // 自定义背景最高支持 4K；compressImage 只缩不放，故 ≤1920×1080 的图（如必应壁纸）不受影响
                const maxWidth = 3840;
                const maxHeight = 2160;
                let { width, height } = img;
                
                if (width > maxWidth) {
                    height *= maxWidth / width;
                    width = maxWidth;
                }
                
                if (height > maxHeight) {
                    width *= maxHeight / height;
                    height = maxHeight;
                }
                
                canvas.width = width;
                canvas.height = height;
                
                try {
                    ctx.drawImage(img, 0, 0, width, height);
                    // 优先编码为 WebP：同画质体积更小且保留透明通道；
                    // JPEG 不支持 alpha，会把透明像素填充为黑色。浏览器不支持时回退 JPEG
                    let dataURL = canvas.toDataURL('image/webp', quality);
                    if (!dataURL.startsWith('data:image/webp')) {
                        dataURL = canvas.toDataURL('image/jpeg', quality);
                    }
                    resolve(dataURL);
                } catch (e) {
                    reject(new Error('图片压缩失败（可能受 CORS 限制）: ' + e.message));
                }
            };
            img.onerror = function(err) {
                reject(new Error('图片加载失败'));
            };
            img.src = src;
        });
    }
    
    // [壁纸功能 1] 背景模式切换
    bgModeButtons.forEach(btn => {
        btn.addEventListener('click', () => setBgMode(btn.dataset.bgMode));
    });

    // [壁纸功能 2] 必应壁纸：换一张（强制刷新，忽略自动更换间隔）
    bingRefreshBtn.addEventListener('click', () => fetchBing(true));

    // [壁纸功能 3] 必应壁纸画质切换
    bingQualityButtons.forEach(btn => {
        btn.addEventListener('click', async () => {
            const quality = sanitizeBingQuality(btn.dataset.bingQuality);
            if (quality === bingQuality) return;
            bingQuality = quality;
            await Storage.setImmediate('bingQuality', bingQuality);
            bingQualityButtons.forEach(b => {
                const active = b.dataset.bingQuality === bingQuality;
                b.classList.toggle('active', active);
                b.setAttribute('aria-checked', active ? 'true' : 'false');
            });
            // 切换画质后立即按新画质重新获取壁纸；
            // 若已有抓取进行中（fetchBing 的 loading 守卫会跳过），登记后由其 finally 补抓
            if (bingRefreshBtn.classList.contains('loading')) {
                bingRefetchPending = true;
                return;
            }
            await fetchBing(true);
        });
    });

    // [壁纸功能 4] 必应壁纸自动更换间隔
    bingIntervalSelect.addEventListener('change', async () => {
        bingInterval = sanitizeBingInterval(bingIntervalSelect.value);
        bingIntervalSelect.value = String(bingInterval);
        await Storage.setImmediate('bingInterval', bingInterval);
    });

    // [壁纸功能 5] 上传本地图片 (转 Base64 存储)
    bgUploadInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // 用户上传背景：递增令牌并中止正在进行的必应壁纸获取，避免其完成后覆盖
        ++bgActionToken;
        if (bingAbortController) {
            bingAbortController.abort();
            bingAbortController = null;
        }

        // 4K 原图（相机 JPEG / 设计稿 PNG）体积常较大，压缩在客户端进行，故放宽上传上限至 20MB；
        // 过大的文件多为 6K/8K，解码内存峰值过高且无意义，仍予拦截
        if (file.size > 20 * 1024 * 1024) {
            showError('图片太大啦，请选择 20MB 以内的图片');
            bgUploadInput.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = async function(event) {
            const base64String = event.target.result;
            try {
                const compressedImage = await compressImage(base64String, 0.7);
                if (!isImageDataUrl(compressedImage, MAX_BACKGROUND_DATA_URL_CHARS)) {
                    showError('压缩后的图片仍然过大，请选择更小的图片');
                    return;
                }
                await Storage.setImmediate('customBg', compressedImage);
                await updatePreviews(compressedImage);
                // 仅自定义模式下立即应用，避免覆盖其他模式的背景
                if (bgMode === 'custom') await applyBackground(compressedImage);
            } catch (err) {
                showError('存储失败，可能是图片转换后太大了', err);
            }
        };
        reader.readAsDataURL(file);
        bgUploadInput.value = '';
    });

    // [壁纸功能 6] 移除自定义背景
    bgRemoveBtn.addEventListener('click', async () => {
        const hasCustom = sanitizeBackgroundValue(await Storage.get('customBg'));
        if (!hasCustom) {
            showToast('当前没有已上传的图片', 'info');
            return;
        }
        if (!window.confirm('确定移除已上传的图片？')) return;
        // 递增令牌并中止正在进行的必应壁纸获取
        ++bgActionToken;
        if (bingAbortController) {
            bingAbortController.abort();
            bingAbortController = null;
        }
        await Storage.remove('customBg');
        await updatePreviews(null);
        if (bgMode === 'custom') await applyBackground(null);
        showToast('图片已移除', 'success');
    });

    // 数据导出功能
    exportDataBtn.addEventListener('click', async () => {
        // 并行读取，避免大体积壁纸项串行等待
        const [gridCols, gridSize, scale, customBg, bgMode, bingQuality, bingInterval, bingLastFetch, bingBg, colorMode] = await Promise.all([
            Storage.get('gridCols', 5),
            Storage.get('gridSize', 100),
            Storage.get('scale', 100), // 显示比例设置
            Storage.get('customBg'),
            Storage.get('bgMode', 'default'),
            Storage.get('bingQuality', 'uhd'),
            Storage.get('bingInterval', DEFAULT_BING_INTERVAL),
            Storage.get('bingLastFetch', 0),
            Storage.get('bingBg'),
            Storage.get('colorMode', 'auto') // 颜色模式设置
        ]);
        const exportData = {
            shortcuts: sanitizeShortcuts(shortcuts, DEFAULT_SHORTCUTS),
            gridCols,
            gridSize,
            scale,
            customBg,
            bgMode,
            bingQuality,
            bingInterval,
            bingLastFetch,
            bingBg,
            colorMode
        };
        
        // 收集所有favicon缓存
        const favicons = {};
        // 获取所有存储项
        await new Promise(resolve => {
            chrome.storage.local.get(null, (items = {}) => {
                if (chrome.runtime.lastError) {
                    console.error('Storage read error:', chrome.runtime.lastError);
                    resolve();
                    return;
                }
                const keys = Object.keys(items)
                    .filter(key => key.startsWith('favicon_'))
                    .sort((a, b) => Number(items[b]?.timestamp || 0) - Number(items[a]?.timestamp || 0))
                    .slice(0, MAX_EXPORTED_FAVICONS);

                keys.forEach(key => {
                    if (key.startsWith('favicon_')) {
                        favicons[key] = items[key];
                    }
                });
                resolve();
            });
        });
        exportData.favicons = sanitizeFaviconCache(favicons);

        // 创建一个 Blob 对象并下载
        const dataStr = JSON.stringify(exportData, null, 2);
        const dataBlob = new Blob([dataStr], {type: 'application/json'});
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'liquid-newtab-data.json';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showToast('数据已导出', 'success');
    });

    // 数据导入功能
    importDataInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // 导入会覆盖现有全部数据，属破坏性操作，须二次确认
        if (!window.confirm('导入将覆盖当前的快捷方式、布局、外观与背景数据，确定继续吗？')) {
            importDataInput.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = async function(event) {
            try {
                const importData = validateImportedData(JSON.parse(event.target.result));
                
                // 导入数据
                if (importData.shortcuts !== undefined) {
                    shortcuts = importData.shortcuts;
                    await Storage.setImmediate('shortcuts', JSON.stringify(shortcuts));
                }
                
                if (importData.gridCols !== undefined) {
                    await Storage.setImmediate('gridCols', importData.gridCols);
                }
                
                if (importData.gridSize !== undefined) {
                    await Storage.setImmediate('gridSize', importData.gridSize);
                }
                
                // 导入显示比例设置
                if (importData.scale !== undefined) {
                    await Storage.setImmediate('scale', importData.scale);
                }
                
                if (importData.customBg !== undefined) {
                    if (importData.customBg) {
                        await Storage.setImmediate('customBg', importData.customBg);
                    } else {
                        await Storage.remove('customBg');
                    }
                }

                if (importData.bingBg !== undefined) {
                    if (importData.bingBg) {
                        await Storage.setImmediate('bingBg', importData.bingBg);
                    } else {
                        await Storage.remove('bingBg');
                    }
                }

                if (importData.bingLastFetch !== undefined) {
                    await Storage.setImmediate('bingLastFetch', importData.bingLastFetch);
                }

                if (importData.bgMode !== undefined) {
                    await Storage.setImmediate('bgMode', importData.bgMode);
                    try { localStorage.setItem('_bgMode', importData.bgMode); } catch(e) {}
                }

                if (importData.bingQuality !== undefined) {
                    await Storage.setImmediate('bingQuality', importData.bingQuality);
                }

                if (importData.bingInterval !== undefined) {
                    await Storage.setImmediate('bingInterval', importData.bingInterval);
                }

                // 导入颜色模式设置
                if (importData.colorMode !== undefined) {
                    await Storage.setImmediate('colorMode', importData.colorMode);
                    try { localStorage.setItem('_colorMode', importData.colorMode); } catch(e) {}
                }
                
                // 导入favicon缓存
                if (importData.favicons !== undefined) {
                    // 收集所有favicon键
                    const faviconKeys = [];
                    await new Promise(resolve => {
                        chrome.storage.local.get(null, (items = {}) => {
                            if (chrome.runtime.lastError) {
                                console.error('Storage read error:', chrome.runtime.lastError);
                                resolve();
                                return;
                            }
                            Object.keys(items).forEach(key => {
                                if (key.startsWith('favicon_')) {
                                    faviconKeys.push(key);
                                }
                            });
                            resolve();
                        });
                    });
                    
                    // 清除现有的favicon缓存
                    if (faviconKeys.length > 0) {
                        await Storage.remove(faviconKeys);
                    }
                    
                    // 导入新的favicon缓存
                    await Storage.setBatch(importData.favicons);
                }
                
                // 更新UI
                const [rawGridCols, rawGridSize, rawScale, rawColorMode] = await Promise.all([
                    Storage.get('gridCols', 5),
                    Storage.get('gridSize', 100),
                    Storage.get('scale', 100),
                    Storage.get('colorMode', 'auto')
                ]);
                const gridCols = clampNumber(rawGridCols, 3, 10, 5);
                const gridSize = clampNumber(rawGridSize, 80, 160, 100);
                const scale = clampNumber(rawScale, 50, 200, 100);
                const colorMode = sanitizeColorMode(rawColorMode);
                
                applyLayoutSettings(gridCols, gridSize, scale);
                colInput.value = gridCols;
                colValDisplay.innerText = gridCols;
                sizeInput.value = gridSize;
                scaleInput.value = scale;
                scaleValDisplay.innerText = scale + '%';
                
                // 更新颜色模式按钮状态
                document.querySelectorAll('.color-mode-buttons .glass-btn').forEach(btn => {
                    btn.classList.remove('active');
                    btn.setAttribute('aria-checked', 'false');
                });
                const activeBtn = document.querySelector(`.color-mode-buttons .glass-btn[data-mode="${colorMode}"]`);
                if (activeBtn) {
                    activeBtn.classList.add('active');
                    activeBtn.setAttribute('aria-checked', 'true');
                }
                
                await renderShortcuts();

                // 重新加载并应用壁纸设置（模式/画质/间隔/背景图）
                await loadBgSettings();

                showToast('数据导入成功！', 'success');
            } catch (error) {
                showError('导入数据失败，请确保选择了有效的JSON文件。', error);
            }
        };
        reader.readAsText(file);
        // 清空input以便下次选择相同文件也能触发change事件
        importDataInput.value = '';
    });

    // --- 3. 搜索功能 ---
    function performSearch() {
        const query = searchInput.value.trim();
        if (query) {
            chrome.runtime.sendMessage({
                action: "performSearch",
                text: query
            });
        }
    }
    
    searchBtn.addEventListener('click', performSearch);
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') performSearch();
    });

    // 桌面环境自动聚焦搜索框（触屏设备不弹软键盘）
    if (window.matchMedia('(pointer: fine)').matches) {
        searchInput.focus();
    }

    // --- 4. 快捷方式渲染 ---
    async function renderShortcuts() {
        shortcutsAbortController.abort();
        shortcutsAbortController = new AbortController();
        const signal = shortcutsAbortController.signal;
        shortcuts = sanitizeShortcuts(shortcuts, DEFAULT_SHORTCUTS);
        // 数据即将重渲染，关闭可能残留的右键菜单，避免其索引指向过期数据
        hideContextMenu();

        // 与 background.js 的 CACHE_TTL 保持一致
        const FAVICON_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

        const noIconShortcuts = shortcuts.filter(s => !s.icon);
        const faviconCache = {};
        if (noIconShortcuts.length > 0) {
            const cacheKeys = [];
            for (const s of noIconShortcuts) {
                try {
                    cacheKeys.push(`favicon_${new URL(s.url).hostname}`);
                } catch {}
            }
            if (cacheKeys.length > 0) {
                try {
                    const cached = await new Promise(resolve => {
                        chrome.storage.local.get(cacheKeys, resolve);
                    });
                    // 异步读取完成后检查是否已被 newer render 抢占
                    if (signal.aborted) return;
                    for (const key in cached) {
                        if (cached[key] && cached[key].dataUrl) {
                            faviconCache[key] = cached[key];
                        }
                    }
                } catch {}
            }
        }

        const fragment = document.createDocumentFragment();
        const upgradeQueue = [];

        for (let index = 0; index < shortcuts.length; index++) {
            const item = shortcuts[index];

            // 使用 <a> 承载磁贴：获得浏览器原生导航（中键/Ctrl+点击新标签打开、Enter 激活）
            const link = document.createElement('a');
            link.className = 'shortcut-item glass-element';
            link.href = item.url;
            link.draggable = true;
            link.dataset.index = index;
            link.setAttribute('role', 'listitem');
            link.setAttribute('aria-label', `${item.name} - 快捷方式`);

            const img = document.createElement('img');
            const span = document.createElement('span');
            link.appendChild(img);
            link.appendChild(span);

            if (item.icon) {
                img.src = item.icon;
            } else {
                let domain;
                try { domain = new URL(item.url).hostname; } catch { domain = null; }

                const cacheKey = domain ? `favicon_${domain}` : null;
                const cachedEntry = cacheKey ? faviconCache[cacheKey] : null;

                if (cachedEntry) {
                    img.src = cachedEntry.dataUrl;
                    if (Date.now() - cachedEntry.timestamp > FAVICON_CACHE_TTL) {
                        upgradeQueue.push({ img, url: item.url });
                    }
                } else {
                    const urlObj = new URL(chrome.runtime.getURL("/_favicon/"));
                    urlObj.searchParams.set("pageUrl", item.url);
                    urlObj.searchParams.set("size", "256");
                    img.src = urlObj.toString();
                    upgradeQueue.push({ img, url: item.url });
                }
            }

            img.alt = '';
            img.setAttribute('aria-hidden', 'true');
            span.textContent = item.name;
            span.title = item.name;

            // 图标加载/解码失败时统一回退为字母占位图（含缓存 dataUrl 损坏的情况）；
            // 升级队列不再自行判断 naturalWidth，避免把仍在加载中的 _favicon 图片误判为失败
            img.addEventListener('error', () => {
                if (img.isConnected) applyFaviconFallback(img, item.url);
            }, { once: true, signal });

            link.addEventListener('contextmenu', (e) => showContextMenu(e, index), { signal });
            addDragEvents(link, signal);

            fragment.appendChild(link);
        }

        // 写入 DOM 前再次检查，避免旧渲染覆盖新渲染
        if (signal.aborted) return;
        grid.innerHTML = '';
        grid.appendChild(fragment);

        processUpgradeQueue(upgradeQueue, signal);
    }

    async function upgradeFavicon(imgElement, pageUrl, signal) {
        try {
            // 带超时保护，避免 Service Worker 无响应时升级队列的 worker 被永久占用
            const response = await sendMessageWithTimeout({
                action: 'getBestFavicon',
                url: pageUrl
            }, 15000, signal);

            if (signal && signal.aborted) return;
            if (response && response.dataUrl && imgElement.isConnected) {
                imgElement.src = response.dataUrl;
            }
            // 失败时不在此处兜底：渲染时的 img.error 监听器统一负责字母占位
        } catch (e) {
            console.debug('[favicon] 升级图标失败:', pageUrl, e);
        }
    }

    function applyFaviconFallback(imgElement, pageUrl) {
        let domain = '';
        try { domain = new URL(pageUrl).hostname; } catch {}
        const letter = (domain || '?').charAt(0).toUpperCase();
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#5a6a8a';
        ctx.beginPath();
        ctx.arc(64, 64, 64, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 64px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(letter, 64, 68);
        imgElement.src = canvas.toDataURL('image/png');
    }

    async function processUpgradeQueue(queue, signal) {
        let index = 0;
        async function worker() {
            while (index < queue.length) {
                if (signal.aborted) return;
                const currentIndex = index++;
                const { img, url } = queue[currentIndex];
                await upgradeFavicon(img, url, signal);
            }
        }
        const workers = [];
        for (let i = 0; i < Math.min(FAVICON_CONCURRENCY, queue.length); i++) {
            workers.push(worker());
        }
        await Promise.all(workers);
    }
    
    // 快捷方式已在初始化早期渲染（见布局设置应用后），无需重复渲染

    // 初始化右键菜单颜色模式
    // 不再需要单独调用，因为在updateTextColorClasses中已经处理

    // --- 5. 拖拽逻辑 ---
    function initDragAndDrop() {
        // 为grid容器添加必要的事件监听器
        grid.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        
        grid.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    }
    
    // 全局状态变量，确保所有元素共享同一份状态

    function clearDragIndicators() {
        grid.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    }
    
    function addDragEvents(item, signal) {
        item.addEventListener('dragstart', (e) => {
            currentDragElement = item;
            item.classList.add('dragging');
            item.style.opacity = '0.5';
            
            e.dataTransfer.setData('text/plain', item.dataset.index);
            e.dataTransfer.effectAllowed = 'move';
        }, { signal });
        
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (currentDragElement && currentDragElement !== item) {
                clearDragIndicators();
                item.classList.add('drag-over');
            }
        }, { signal });

        item.addEventListener('dragleave', () => {
            item.classList.remove('drag-over');
        }, { signal });
        
        item.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            if (!currentDragElement || currentDragElement === item) return;
            
            // 基于实时 DOM 位置比较（而非滞后的 dataset.index），
            // 确保拖拽元素能与任意目标正确交换，且可以随时拖回原位
            const parent = item.parentNode;
            const items = Array.from(parent.querySelectorAll('.shortcut-item'));
            const fromIndex = items.indexOf(currentDragElement);
            const toIndex = items.indexOf(item);
            
            if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;
            
            if (fromIndex < toIndex) {
                parent.insertBefore(currentDragElement, item.nextSibling);
            } else {
                parent.insertBefore(currentDragElement, item);
            }
        }, { signal });
        
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, { signal });
        
        item.addEventListener('dragend', async () => {
            // 先同步还原视觉状态：Storage.set 为防抖写入（WRITE_DELAY=500ms），
            // 若 await 在前会导致拖拽元素松手后仍保持半透明"按下"状态约半秒
            const draggedElement = currentDragElement;
            currentDragElement = null;
            if (draggedElement) {
                draggedElement.classList.remove('dragging');
                draggedElement.style.opacity = '';
            }
            clearDragIndicators();

            const shortcutItems = grid.querySelectorAll('.shortcut-item');
            const newShortcuts = [];
            
            shortcutItems.forEach((shortcutItem) => {
                const itemIndex = parseInt(shortcutItem.dataset.index);
                newShortcuts.push(shortcuts[itemIndex]);
            });
            
            shortcutItems.forEach((shortcutItem, index) => {
                shortcutItem.dataset.index = index;
            });
            
            shortcuts = newShortcuts;
            await Storage.set('shortcuts', JSON.stringify(shortcuts));
        }, { signal });
    }
    


    // --- 6. 增删改查弹窗逻辑 ---
    const addBtn = document.getElementById('add-shortcut-btn');
    
    addBtn.addEventListener('click', () => { 
        isEditing = false; 
        nameInput.value = ''; 
        urlInput.value = '';
        iconInput.value = ''; // 清空图标输入框
        iconPreviewFallback = null; // 新建快捷方式无站点 favicon 回退
        updateIconPreview();
        editDialog.showModal(); 
    });

    // 图标上传处理
    iconUploadInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        // 检查文件类型（兼容 ICO：其 MIME 可能为 image/x-icon、image/vnd.microsoft.icon，
        // 部分系统下甚至为空，故额外按 .ico 扩展名判断）
        const isIcoFile = file.type === 'image/x-icon' ||
            file.type === 'image/vnd.microsoft.icon' ||
            /\.ico$/i.test(file.name);
        if (!file.type.match('image.*') && !isIcoFile) {
            showError('请选择图片文件');
            return;
        }
        
        // 限制文件大小 (例如 500KB)
        if (file.size > 500 * 1024) {
            showError('图片太大啦，请选择 500KB 以内的图片');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = function(event) {
            iconInput.value = event.target.result;
            updateIconPreview();
        };
        reader.readAsDataURL(file);
    });
    
    // 重新获取图标按钮事件处理
    refreshIconBtn.addEventListener('click', async () => {
        const fullUrl = normalizeHttpUrl(urlInput.value);
        if (!fullUrl) {
            showError('请输入有效网址后再重新获取图标');
            return;
        }

        refreshIconBtn.disabled = true;

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'getBestFavicon',
                url: fullUrl,
                forceRefresh: true
            });

            if (response && response.dataUrl) {
                iconInput.value = response.dataUrl;
            } else {
                const urlObj = new URL(chrome.runtime.getURL("/_favicon/"));
                urlObj.searchParams.set("pageUrl", fullUrl);
                urlObj.searchParams.set("size", "128");
                iconInput.value = urlObj.toString();
            }
            updateIconPreview();
        } catch {
            const urlObj = new URL(chrome.runtime.getURL("/_favicon/"));
            urlObj.searchParams.set("pageUrl", fullUrl);
            urlObj.searchParams.set("size", "128");
            iconInput.value = urlObj.toString();
            updateIconPreview();
        } finally {
            refreshIconBtn.disabled = false;
        }
    });
    
    // --- 7. 右键菜单 ---
    function setContextMenuVisible(visible) {
        contextMenu.classList.toggle('hidden', !visible);
        contextMenu.setAttribute('aria-hidden', visible ? 'false' : 'true');
    }

    function showContextMenu(e, index) {
        e.preventDefault();
        e.stopPropagation();
        contextMenuIndex = index;
        // 简单的边界检测，防止菜单超出屏幕
        let top = e.clientY;
        let left = e.clientX;
        // 考虑菜单本身的宽度和高度，避免菜单被截断（两个菜单项的实际高度约 90px）
        const menuWidth = 120;
        const menuHeight = 90;
        if (left + menuWidth > window.innerWidth) left = window.innerWidth - menuWidth - 5;
        if (top + menuHeight > window.innerHeight) top = window.innerHeight - menuHeight - 5;
        contextMenu.style.top = `${top}px`;
        contextMenu.style.left = `${left}px`;

        setContextMenuVisible(true);
        // 焦点移到菜单首项，便于键盘用户操作
        const firstItem = contextMenu.querySelector('.menu-item');
        if (firstItem) firstItem.focus();
    }

    function hideContextMenu() {
        setContextMenuVisible(false);
    }

    // Esc 关闭右键菜单 + 方向键导航
    contextMenu.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            hideContextMenu();
            return;
        }
        const items = Array.from(contextMenu.querySelectorAll('.menu-item'));
        if (items.length === 0) return;
        const currentIndex = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const next = items[(currentIndex + 1) % items.length];
            if (next) next.focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = items[(currentIndex - 1 + items.length) % items.length];
            if (prev) prev.focus();
        }
    });

    // 全局 Esc 兜底关闭菜单
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !contextMenu.classList.contains('hidden')) {
            hideContextMenu();
        }
    });

    // 点击页面其他地方隐藏菜单
    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) {
            setContextMenuVisible(false);
        }
    });
    

    

    
    function deleteContextShortcut() {
        setContextMenuVisible(false);
        // 边界校验：菜单打开期间快捷方式列表可能已变化（如其他页面导入数据），防止误删或越界
        if (contextMenuIndex > -1 && contextMenuIndex < shortcuts.length) { 
            shortcuts.splice(contextMenuIndex, 1); 
            Storage.set('shortcuts', JSON.stringify(shortcuts));
            renderShortcuts(); 
        } 
    }

    function editContextShortcut() {
        setContextMenuVisible(false);
        // 边界校验：同上，防止索引过期导致编辑错项或越界
        if (contextMenuIndex > -1 && contextMenuIndex < shortcuts.length) {
            isEditing = true; 
            editIndex = contextMenuIndex;
            nameInput.value = shortcuts[editIndex].name; 
            urlInput.value = shortcuts[editIndex].url;
            // 填充图标URL（如果存在）
            iconInput.value = shortcuts[editIndex].icon || '';
            // 未设置自定义图标时，用站点 favicon 作为预览回退，使预览与磁贴显示一致
            if (shortcuts[editIndex].icon) {
                iconPreviewFallback = null;
            } else {
                // 先用 _favicon 接口即时占位，再异步替换为磁贴所用的最佳 favicon（同源 chrome.storage.local）
                iconPreviewFallback = buildFaviconPreviewUrl(shortcuts[editIndex].url);
                const targetIndex = editIndex;
                resolveFaviconPreview(shortcuts[editIndex].url).then(best => {
                    // 仅当仍在编辑同一项且未填入自定义图标时，才用最佳 favicon 刷新预览
                    if (best && isEditing && editIndex === targetIndex && !iconInput.value.trim()) {
                        iconPreviewFallback = best;
                        updateIconPreview();
                    }
                });
            }
            editDialog.showModal();
            // 对话框显示后再更新预览，确保已有图标的快捷方式能可靠加载并渲染出图标
            updateIconPreview();
        }
    }

    function handleMenuKeydown(action) {
        return (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                action();
            }
        };
    }

    menuDelete.addEventListener('click', deleteContextShortcut);
    menuDelete.addEventListener('keydown', handleMenuKeydown(deleteContextShortcut));
    
    menuEdit.addEventListener('click', editContextShortcut);
    menuEdit.addEventListener('keydown', handleMenuKeydown(editContextShortcut));
    
    // 应用颜色模式
    async function applyColorMode(mode) {
        mode = sanitizeColorMode(mode);
        const body = document.body;
        
        // 解析具体主题：自动模式根据背景亮度/系统偏好计算，手动模式直接使用指定值。
        // 关键：不在异步检测前移除当前主题类，避免检测期间回退 :root 深色默认导致闪烁；
        // 保持当前主题不动，检测完成后仅在结果不同时原子切换。
        let currentTheme;
        if (mode === 'auto') {
            if (document.documentElement.classList.contains('has-custom-bg')) {
                // 直接用存储中的壁纸值做亮度检测，避免再走 getComputedStyle 嗅探整段 data URL
                let bgVal = null;
                let bgModeNow = null;
                try { bgModeNow = localStorage.getItem('_bgMode'); } catch(e) {}
                if (bgModeNow === 'bing') {
                    bgVal = sanitizeBackgroundValue(await Storage.get('bingBg'));
                } else if (bgModeNow === 'custom') {
                    bgVal = sanitizeBackgroundValue(await Storage.get('customBg'));
                }
                currentTheme = await detectBackgroundColor(bgVal);
            } else {
                // 竞态保护：bgMode 为 bing/custom 但 has-custom-bg 类尚未添加时，
                // 用上次权威检测结果而非系统偏好，避免覆盖正确的缓存主题
                let bgModeNow;
                try { bgModeNow = localStorage.getItem('_bgMode'); } catch(e) {}
                if (bgModeNow === 'bing' || bgModeNow === 'custom') {
                    let cached;
                    try { cached = localStorage.getItem('_resolvedTheme'); } catch(e) {}
                    currentTheme = (cached === 'light' || cached === 'dark') ? cached
                        : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
                } else {
                    currentTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
                }
            }
        } else {
            currentTheme = mode;
        }

        // 原子切换：仅在结果与当前不同时修改类名
        const targetClass = currentTheme === 'light' ? 'light-bg' : 'dark-bg';
        const removeClass = currentTheme === 'light' ? 'dark-bg' : 'light-bg';
        if (!body.classList.contains(targetClass)) {
            body.classList.remove(removeClass);
            body.classList.add(targetClass);
        }

        // 持久化实际主题，供下次首绘前的 theme-init.js 同步读取
        // （chrome.storage 中的 resolvedTheme 键从未被消费，不再写入）
        try { localStorage.setItem('_resolvedTheme', currentTheme); } catch(e) {}
        
        await updateTextColorClasses(currentTheme);
    }
    
    // 检测背景亮度并应用对应主题
    // preferredBgUrl：调用方已持有的背景 data URL（可选）；缺省时回退为从计算样式嗅探
    async function detectBackgroundColor(preferredBgUrl = null) {
        const body = document.body;
        let backgroundImage = '';
        
        if (preferredBgUrl) {
            backgroundImage = `url("${preferredBgUrl}")`;
        } else {
            // 获取预加载背景是否有图片
            const preloadBgEl = document.getElementById('preload-bg');
            if (preloadBgEl) {
                const preloadStyle = window.getComputedStyle(preloadBgEl);
                backgroundImage = preloadStyle.backgroundImage;
            }
            
            // 如果预加载背景没有图片，检查body的背景图
            if (!backgroundImage || backgroundImage === 'none' || !backgroundImage.includes('url')) {
                const bodyStyle = window.getComputedStyle(body);
                backgroundImage = bodyStyle.backgroundImage;
            }
        }
        
        // 如果有自定义背景图
        const urlMatch = backgroundImage.match(/url\(["']?(.*?)["']?\)/);
        let theme = 'dark'; // 默认主题
        if (urlMatch && urlMatch[1] && urlMatch[1] !== 'none') {
            return new Promise(resolve => {
                const img = new Image();
                img.crossOrigin = 'Anonymous';
                img.onload = async function() {
                    try {
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        const sampleSize = 64;
                        canvas.width = sampleSize;
                        canvas.height = sampleSize;
                        ctx.drawImage(img, 0, 0, sampleSize, sampleSize);

                        const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);
                        const data = imageData.data;
                        
                        let totalBrightness = 0;
                        let count = 0;
                        for (let i = 0; i < data.length; i += 4) {
                            const r = data[i];
                            const g = data[i + 1];
                            const b = data[i + 2];
                            const brightness = (r * 299 + g * 587 + b * 114) / 1000;
                            totalBrightness += brightness;
                            count++;
                        }
                        
                        const averageBrightness = totalBrightness / count;
                        
                        if (averageBrightness > 128) {
                            theme = 'light';
                            body.classList.remove('dark-bg');
                            body.classList.add('light-bg');
                        } else {
                            body.classList.remove('light-bg');
                            body.classList.add('dark-bg');
                        }
                    } catch (e) {
                        console.warn('无法分析背景图片亮度（可能受 CORS 限制），使用默认深色主题', e);
                        theme = 'dark';
                        body.classList.remove('light-bg');
                        body.classList.add('dark-bg');
                    }
                    
                    persistResolvedTheme(theme);
                    await updateTextColorClasses(theme);
                    resolve(theme);
                };
                img.onerror = async function() {
                    console.warn('背景图片加载失败，使用默认深色主题');
                    theme = 'dark';
                    body.classList.remove('light-bg');
                    body.classList.add('dark-bg');
                    persistResolvedTheme('dark');
                    await updateTextColorClasses('dark');
                    resolve('dark');
                };
                img.src = urlMatch[1];
            });
        }
        
        // 没有自定义背景图，根据系统主题偏好判断
        const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
        theme = prefersLight ? 'light' : 'dark';
        
        if (prefersLight) {
            body.classList.remove('dark-bg');
            body.classList.add('light-bg');
        } else {
            // 默认深色
            body.classList.remove('light-bg');
            body.classList.add('dark-bg');
        }
        
        persistResolvedTheme(theme);
        await updateTextColorClasses(theme);
        return theme;
    }

    // 持久化权威主题结果到 localStorage（供下次首绘前的 theme-init.js 同步读取）
    function persistResolvedTheme(theme) {
        try { localStorage.setItem('_resolvedTheme', theme); } catch(e) {}
    }
    
    // 更新文本颜色类
    // theme: 'light' | 'dark'，由 applyColorMode / detectBackgroundColor 权威计算后传入
    async function updateTextColorClasses(theme) {
        const searchCapsule = document.querySelector('.search-capsule');
        const shortcutsContainer = document.querySelector('.grid-container');
        const addBtnEl = document.querySelector('.add-btn');
        const settingsBtnEl = document.querySelector('.settings-btn');
        const contextMenuEl = document.getElementById('context-menu');
        
        // 移除现有的颜色类
        [searchCapsule, shortcutsContainer, addBtnEl, settingsBtnEl].forEach(el => {
            if (el) {
                el.classList.remove('text-color-dark', 'text-color-light', 'icon-color-dark', 'icon-color-light', 'shortcut-color-dark', 'shortcut-color-light');
            }
        });
        
        // 移除右键菜单现有的颜色类
        if (contextMenuEl) {
            contextMenuEl.classList.remove('text-color-dark', 'text-color-light');
        }
        
        const textColorClass = theme === 'light' ? 'text-color-dark' : 'text-color-light';
        const iconColorClass = theme === 'light' ? 'icon-color-dark' : 'icon-color-light';
        const shortcutColorClass = theme === 'light' ? 'shortcut-color-dark' : 'shortcut-color-light';
        
        // 应用颜色类
        if (searchCapsule) {
            searchCapsule.classList.add(textColorClass, iconColorClass);
        }
        
        if (shortcutsContainer) {
            shortcutsContainer.classList.add(shortcutColorClass);
        }
        
        if (addBtnEl) {
            addBtnEl.classList.add(iconColorClass);
        }
        
        if (settingsBtnEl) {
            settingsBtnEl.classList.add(iconColorClass);
        }
        
        // 应用右键菜单颜色类
        if (contextMenuEl) {
            contextMenuEl.classList.add(textColorClass);
        }
    }
    

    
    // 更新对话框颜色模式：始终跟随浏览器系统主题，与玻璃组件的颜色模式独立
    function applyDialogSystemTheme() {
        const dialogs = document.querySelectorAll('.glass-dialog');
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        
        dialogs.forEach(dialog => {
            dialog.classList.remove('light-bg', 'dark-mode');
            dialog.classList.add(prefersDark ? 'dark-mode' : 'light-bg');
        });
    }
    
    initDragAndDrop();
});
