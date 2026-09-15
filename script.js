function showToast(message, type = 'error', duration = 3000) {
    // 模态对话框（showModal）位于浏览器顶层（top layer），其 ::backdrop 会盖住
    // 普通文档流中的任何元素（z-index 再高也没用），因此当有模态对话框打开时，
    // 把气泡挂到该对话框内部使其进入顶层。
    // 非模态对话框（show()，如液态玻璃调参面板）不在顶层：页面级 toast 可正常
    // 覆盖其上——此时保持气泡显示在整个页面中下位置，而非对话框内部。
    const openDialog = document.querySelector('dialog:modal');
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

    // Toast 使用与对话框统一的高模糊玻璃材质（模糊度固定，不随用户参数调整）
    if (window.LiquidGlass) {
        try { window.LiquidGlass.applyTo(toast); } catch {}
    }

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
const GLASS_STORAGE_KEY = 'liquidGlassParams'; // 液态玻璃参数存储键（设置 UI / 导入导出 / 跨页同步共用）

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
            // _favicon 代理 URL 含扩展 ID，重装/换机后失效，且会把“自动获取”
            // 固化为一条不随缓存更新的代理地址，禁止作为图标持久化
            if (url.pathname.startsWith('/_favicon')) return null;
        }
        return url.toString();
    } catch {
        return null;
    }
}

// 稳定 ID：所有编辑 / 删除 / 异步图标写回 / 拖拽排序均按 ID 定位条目，
// 不再依赖随渲染与重排而过期的数组下标（见拖拽排序后右键误删问题）
function makeShortcutId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch {}
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function isValidShortcutId(id) {
    return typeof id === 'string' && id.length >= 1 && id.length <= 64;
}

// 旧数据（含全新安装的默认条目）的确定性 ID：由 名称+网址 派生。
// 必须是确定性的——多个新标签页各自补齐时若随机生成，会在持久化前产生不同的
// ID 集合，导致同一份数据在不同页面被视为不同条目（右键/拖拽按 ID 定位即失效）。
function legacyShortcutId(item) {
    const raw = `${item.name || ''}|${item.url || ''}`;
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++) {
        hash ^= raw.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return 'legacy-' + (hash >>> 0).toString(36);
}

// 为缺少 ID / ID 重复的列表补齐稳定 ID（就地去重），返回是否发生过补写。
// 补写 ID 后需要由调用方持久化，使多个新标签页共享同一套 ID。
function ensureShortcutIds(list) {
    let changed = false;
    const seen = new Set();
    for (const item of list) {
        if (!isValidShortcutId(item.id) || seen.has(item.id)) {
            // 确定性补写：先按内容派生；若与已有 ID 冲突（同名校同网址的重复条目），
            // 再追加序号，保证同一份列表在任何页面得到完全一致的结果
            let candidate = legacyShortcutId(item);
            let suffix = 2;
            while (seen.has(candidate)) {
                candidate = `${legacyShortcutId(item)}-${suffix++}`;
            }
            item.id = candidate;
            changed = true;
        }
        seen.add(item.id);
    }
    return changed;
}

function sanitizeShortcut(item) {
    if (!item || typeof item !== 'object') return null;
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, MAX_SHORTCUT_NAME_LENGTH) : '';
    const url = normalizeHttpUrl(item.url);
    if (!name || !url) return null;

    const sanitized = { name, url };
    // 保留既有稳定 ID；非法 ID 由 ensureShortcutIds 统一补齐
    if (isValidShortcutId(item.id)) sanitized.id = item.id;
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

// 导入专用：与 sanitizeShortcuts 相同的清洗规则，但额外统计被丢弃的条目数，
// 供导入确认对话框展示“丢弃原因”，避免静默吞掉用户数据
function sanitizeShortcutsWithStats(value, fallback = []) {
    const source = Array.isArray(value) ? value : fallback;
    const result = [];
    let dropped = 0;
    for (const item of source) {
        const sanitized = sanitizeShortcut(item);
        if (sanitized && result.length < MAX_SHORTCUTS) {
            result.push(sanitized);
        } else {
            dropped++;
        }
    }
    return { items: result, dropped };
}

// 主题解析回退链（唯一权威实现）：上次权威计算结果 → 系统偏好。
// theme-init.js 为首绘前同步执行无法复用本函数，其内联逻辑须与此保持一致
function getCachedOrSystemTheme() {
    let cached = null;
    try { cached = localStorage.getItem('_resolvedTheme'); } catch(e) {}
    if (cached === 'light' || cached === 'dark') return cached;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
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

    // 版本检查：schemaVersion 缺省视为 1（旧版导出）；高于本版本支持的值时拒绝，
    // 避免未来格式的备份被当前逻辑误读后覆盖现有数据
    if (data.schemaVersion !== undefined) {
        const version = Number(data.schemaVersion);
        if (!Number.isInteger(version) || version < 1 || version > 1) {
            throw new Error(`不支持的备份版本：${String(data.schemaVersion)}`);
        }
    }

    // 字段类型严格区分：shortcuts 存在时必须是数组。
    // 此前 {"shortcuts":{}} / {"shortcuts":null} 会被静默转换为空列表并覆盖现有数据
    if (data.shortcuts !== undefined && !Array.isArray(data.shortcuts)) {
        throw new Error('shortcuts 字段必须为数组');
    }

    // 导入统计：丢弃原因在确认对话框中展示，不再静默截断
    const shortcutStats = data.shortcuts === undefined
        ? { items: undefined, dropped: 0 }
        : sanitizeShortcutsWithStats(data.shortcuts);

    return {
        shortcuts: shortcutStats.items,
        droppedShortcuts: shortcutStats.dropped,
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
        favicons: data.favicons === undefined ? undefined : sanitizeFaviconCache(data.favicons),
        // 液态玻璃参数：结构合法性由 liquid-glass.js 的 sanitizeSettings 权威校验
        glassParams: (data.glassParams && typeof data.glassParams === 'object' && !Array.isArray(data.glassParams))
            ? data.glassParams : undefined
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
        console.error('[Storage] 数据写入失败，部分设置可能未持久化');
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
            return new Promise((resolve, reject) => {
                chrome.storage.local.set(dataToWrite, () => {
                    const lastError = chrome.runtime.lastError;
                    if (lastError) {
                        console.error('Storage write error:', lastError);
                        notifyWriteError();
                        // 失败契约：写入失败以异常上抛。此前失败被吞成 resolve(false)，
                        // 调用方只 await 不检查，导致"内存/界面已提交、持久化失败仍显示成功"
                        const error = new Error('数据写入失败：' + (lastError.message || '未知错误'));
                        resolveQueue.forEach(resolveItem => resolveItem(error));
                        reject(error);
                        return;
                    }
                    resolveQueue.forEach(resolveItem => resolveItem());
                    resolve(true);
                });
            });
        }

        resolveQueue.forEach(resolveItem => resolveItem());
        return Promise.resolve(true);
    }

    function scheduleWrite(key, value) {
        pendingWrites[key] = value;
        if (writeTimeout) clearTimeout(writeTimeout);
        writeTimeout = setTimeout(() => {
            // 定时器回调丢弃返回值：失败时 flushWrites 会 reject，必须就地吞掉，
            // 否则产生未处理的 Promise 拒绝（调用方各自持有的 Promise 仍会正常 reject）
            flushWrites().catch(() => {});
        }, WRITE_DELAY);
        return new Promise((resolve, reject) => {
            flushResolveQueue.push(err => err ? reject(err) : resolve());
        });
    }

    return {
        get(key, defaultVal = null) {
            // 防抖窗口内优先返回待写入的新值，避免"刚 set 完 get 回旧值"
            if (Object.prototype.hasOwnProperty.call(pendingWrites, key)) {
                return Promise.resolve(pendingWrites[key]);
            }
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

        // 批量读取：单次跨进程往返替代 get 的逐键 N 次往返，
        // 用于启动首屏关键路径（首帧前尽快拿到配置，减少串行等待）
        getMany(keys, defaults = {}) {
            const keyList = Array.isArray(keys) ? keys : [];
            const result = {};
            const missing = [];
            for (const key of keyList) {
                // 与 get 语义一致：防抖窗口内优先返回待写入的新值
                if (Object.prototype.hasOwnProperty.call(pendingWrites, key)) {
                    result[key] = pendingWrites[key];
                } else {
                    missing.push(key);
                }
            }
            if (missing.length === 0) {
                return Promise.resolve(result);
            }
            return new Promise(resolve => {
                chrome.storage.local.get(missing, res => {
                    if (chrome.runtime.lastError) {
                        console.error('Storage read error:', chrome.runtime.lastError);
                    }
                    const items = res || {};
                    for (const key of missing) {
                        result[key] = key in items ? items[key] : defaults[key];
                    }
                    resolve(result);
                });
            });
        },

        set(key, value) {
            return scheduleWrite(key, value);
        },
        
        setBatch(items) {
            Object.assign(pendingWrites, items);
            if (writeTimeout) clearTimeout(writeTimeout);
            writeTimeout = setTimeout(() => { flushWrites().catch(() => {}); }, WRITE_DELAY);
            return new Promise((resolve, reject) => {
                flushResolveQueue.push(err => err ? reject(err) : resolve());
            });
        },

        // 一次 chrome.storage.local.set 提交多个键：导入的"集中提交"依赖此语义，
        // 避免逐字段 set 时部分成功、部分失败留下半完成状态
        setImmediateBatch(items) {
            for (const key of Object.keys(items)) {
                delete pendingWrites[key];
            }
            return new Promise((resolve, reject) => {
                chrome.storage.local.set(items, () => {
                    const lastError = chrome.runtime.lastError;
                    if (lastError) {
                        console.error('Storage write error:', lastError);
                        notifyWriteError();
                        reject(new Error('数据写入失败：' + (lastError.message || '未知错误')));
                        return;
                    }
                    resolve(true);
                });
            });
        },

        setImmediate(key, value) {
            delete pendingWrites[key];
            return new Promise((resolve, reject) => {
                chrome.storage.local.set({ [key]: value }, () => {
                    const lastError = chrome.runtime.lastError;
                    if (lastError) {
                        console.error('Storage write error:', lastError);
                        notifyWriteError();
                        reject(new Error('数据写入失败：' + (lastError.message || '未知错误')));
                        return;
                    }
                    resolve(true);
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
            return new Promise((resolve, reject) => {
                chrome.storage.local.remove(key, () => {
                    const lastError = chrome.runtime.lastError;
                    if (lastError) {
                        console.error('Storage remove error:', lastError);
                        notifyWriteError();
                        reject(new Error('数据删除失败：' + (lastError.message || '未知错误')));
                        return;
                    }
                    resolve(true);
                });
            });
        },

        flush() {
            if (Object.keys(pendingWrites).length > 0) {
                return flushWrites();
            }
            return Promise.resolve(true);
        }
    };
})();

// 页面启动关键配置一次性预读取：在脚本解析期即发起存储 IPC，早于首帧绘制；
// 早启动脚本（theme-init.js 已靠 localStorage 镜像直接出壁纸）与 DOMContentLoaded
// 初始化共用这份结果，把原来"逐键、多次、串行"的跨进程读取压缩为单次往返
const EARLY_SETTINGS_KEYS = ['colorMode', 'bgMode', 'gridCols', 'gridSize', 'scale', 'shortcuts'];
const earlySettingsPromise = Storage.getMany(EARLY_SETTINGS_KEYS, {});

window.addEventListener('beforeunload', () => {
    Storage.flush().catch(() => {});
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        Storage.flush().catch(() => {});
    }
});

// 在页面加载早期获取并应用背景与颜色模式，避免闪烁
(async function() {
    // 先读小值配置立即应用主题，须在读取大体积壁纸之前完成，否则阻塞导致"先深后浅"闪烁
    const earlySettings = await earlySettingsPromise;
    const bgModeValue = sanitizeBgMode(earlySettings.bgMode);
    const colorModeValue = sanitizeColorMode(earlySettings.colorMode);

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
        earlyTheme = getCachedOrSystemTheme();
    }

    if (document.body) {
        document.body.classList.add(earlyTheme === 'light' ? 'light-bg' : 'dark-bg');
        // body 已接管主题，移除 <html> 上的临时防闪类
        document.documentElement.classList.remove('theme-light', 'theme-dark');
    }
    // 不在此处保存 _resolvedTheme：早期值可能不准确，覆写会污染缓存；
    // 它仅由 applyColorMode（经 commitResolvedTheme）权威检测后更新
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
        // 同步镜像壁纸，供下个新标签页首帧前由 theme-init.js 直接应用（优先走
        // localStorage：同步读取、无跨进程 IPC，还省去重复解码）
        try { localStorage.setItem('_bgImage', earlyImage); } catch(e) {
            // 壁纸超过 localStorage 配额（自定义大图场景）：不镜像，退回异步读取路径
            try { localStorage.removeItem('_bgImage'); } catch(e2) {}
        }
    } else {
        // 存储中无壁纸但镜像仍残留（如数据导入/重置导致存储已清空，或旧版本
        // 页面写入的镜像）：撤销首帧镜像，避免陈旧壁纸残留到本页与后续页面
        try { localStorage.removeItem('_bgImage'); localStorage.removeItem('_hasCustomBg'); } catch(e) {}
        // 同步回滚 theme-init.js 可能已应用的 DOM 状态（:root 默认 --bg-image: none）
        document.documentElement.classList.remove('has-custom-bg');
        document.documentElement.style.removeProperty('--bg-image');
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
    // 抓取并发去重：锁在首次调用时同步占用（若在首个 await 之后才上锁，
    // 两次调用会同时通过检查并互相踩踏操作令牌）；并发调用共享同一 Promise
    let bingFetchPromise = null;
    // 主题请求令牌：applyColorMode 每次调用递增（声明须先于初始化期间的
    // applyColorMode 调用，否则运行时处于暂时性死区）
    let themeRequestToken = 0;

    // 最高优先级：复用脚本解析期发起的预读取结果（单次 storage IPC），
    // 避免首屏关键路径上逐键串行跨进程读配置
    const earlySettings = await earlySettingsPromise;
    const savedColorMode = sanitizeColorMode(earlySettings.colorMode);
    const savedBgMode = sanitizeBgMode(earlySettings.bgMode);
    try { localStorage.setItem('_colorMode', savedColorMode); localStorage.setItem('_bgMode', savedBgMode); } catch(e) {}
    // 运行时颜色模式缓存：避免 applyBackground 等热路径反复跨进程读 storage；
    // 仅在颜色模式按钮点击与数据导入时更新
    let currentColorMode = savedColorMode;
    // 主题定型不在快捷方式渲染之前 await：自动模式+壁纸时 applyColorMode 会读取并
    // 解码整张壁纸做亮度检测，阻塞首屏（权威结果由 loadBgSettings → applyBackground
    // 得出）；无壁纸场景下为轻量路径，同步并发执行无害
    const colorModeApplied = (savedColorMode === 'auto'
        && document.documentElement.classList.contains('has-custom-bg'))
        ? Promise.resolve()
        : applyColorMode(savedColorMode);

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
    // 编辑会话令牌：每次打开对话框 / 关闭对话框时递增。提交后异步等待（远程图标
    // 下载等）返回时校验令牌，取消或切换目标都会使旧流程失效——防止旧编辑会话
    // 把条目 A 的内容写入用户随后打开的条目 B
    let editSession = 0;
    // 当前编辑目标的稳定 ID；null 表示新建
    let editTargetId = null;

    // 右键菜单元素
    const contextMenu = document.getElementById('context-menu');
    const menuEdit = document.getElementById('menu-edit');
    const menuDelete = document.getElementById('menu-delete');
    // 右键菜单目标条目的稳定 ID（替代易过期的数组下标）
    let contextMenuId = null;

    const settingsTabs = document.querySelectorAll('[data-settings-tab]');
    const settingsPanels = document.querySelectorAll('[data-settings-panel]');

    // 默认条目自带固定 ID：全新安装时它们同样是"可被右键/拖拽定位"的正式条目，
    // 不能依赖运行期随机补齐（否则同一批默认项在各标签页得到不同 ID）
    const DEFAULT_SHORTCUTS = [
        { id: "default-google", name: "Google", url: "https://google.com" },
        { id: "default-bilibili", name: "Bilibili", url: "https://bilibili.com" },
        { id: "default-github", name: "GitHub", url: "https://github.com" },
        { id: "default-unsplash", name: "Unsplash", url: "https://unsplash.com" }
    ];
    
    let shortcuts = sanitizeShortcuts(
        parseJsonSafe(earlySettings.shortcuts, DEFAULT_SHORTCUTS),
        DEFAULT_SHORTCUTS
    );

    // 首次落盘 / 旧数据迁移：补齐稳定 ID 并立即持久化。
    // 关键：全新安装时存储中并不存在 shortcuts 键（earlySettings.shortcuts 为
    // undefined），早期版本仅用 `!= null` 判断会整段跳过，导致默认快捷方式
    // 既没有 ID、也从未写入存储——右键删除静默失效、编辑命中首个条目、
    // 拖拽无效，且新增第一条时后台基于空列表覆盖掉全部默认项。
    try {
        const parsedForMigration = parseJsonSafe(earlySettings.shortcuts, null);
        const storedIsValidList = Array.isArray(parsedForMigration);
        const idsChanged = ensureShortcutIds(shortcuts);
        if (!storedIsValidList || idsChanged) {
            Storage.setImmediate('shortcuts', JSON.stringify(shortcuts)).catch(() => {});
        }
    } catch {}

    // --- 快捷方式数据层：稳定 ID + 后台串行化修改（多标签页一致性） ---
    // 所有修改经由后台 Service Worker 串行执行（见 mutateShortcuts），
    // 避免多标签页各自持有旧快照、整数组写回互相覆盖（最后写入者获胜丢数据）
    const SHORTCUTS_VERSION_KEY = '_shortcutsVersion';
    // 本页刚写出的 shortcuts JSON：storage.onChanged 回声到达时识别"自己写的"，
    // 避免把自己的写入当作远端修改重复采纳
    const pendingEchoShortcuts = new Set();
    // 回声集合上限：正常情况下写入即产生 onChanged 并消费掉对应项，
    // 该上限仅用于兜底，避免异常路径下集合无限增长
    const ECHO_MAX_ENTRIES = 50;
    // 设置类键的跨页同步在初始化完成后才启用（loadBgSettings 等依赖的运行时状态
    // 在初始化过程中尚未就绪）；shortcuts 的采纳不受此限制（依赖均已就绪）
    let settingsSyncReady = false;
    // 页内修改串行化：同一页的多次修改排队执行，避免交错读写版本号
    let shortcutsMutationQueue = Promise.resolve();

    function parseStoredShortcuts(raw) {
        if (raw == null) return sanitizeShortcuts(DEFAULT_SHORTCUTS, DEFAULT_SHORTCUTS);
        const parsed = parseJsonSafe(raw, null);
        if (!Array.isArray(parsed)) return sanitizeShortcuts(DEFAULT_SHORTCUTS, DEFAULT_SHORTCUTS);
        return sanitizeShortcuts(parsed, []);
    }

    // 统一的快捷方式修改入口：所有修改以 op 描述符发往后台 Service Worker，
    // 由后台在单一 Promise 队列内串行执行"读取最新列表 → 应用 → 写回"。
    // 多标签页 / 多操作不再各自持有旧快照做整数组写回，从结构上消除
    // 最后写入者获胜的数据丢失（chrome.storage 无原子 CAS，页内自旋重试不可靠）。
    // 成功后以后台写回的确切 JSON 登记回声并更新本页镜像。
    function mutateShortcuts(op) {
        const run = async () => {
            const response = await sendMessageWithTimeout({ action: 'shortcutOp', op }, 15000);
            if (!response || response.success !== true) {
                throw new Error((response && response.error) || '快捷方式保存失败');
            }
            const json = typeof response.shortcutsJson === 'string'
                ? response.shortcutsJson
                : JSON.stringify(response.shortcuts || []);
            const parsed = parseJsonSafe(json, null);
            const list = Array.isArray(parsed) ? sanitizeShortcuts(parsed, []) : [];
            ensureShortcutIds(list);
            // 仅在后台确实写入了存储时登记回声：后台判定"无变化"时不写盘，
            // 也就不会产生 storage.onChanged 回声，登记后将永远无法被消费而累积
            if (response.changed !== false) {
                pendingEchoShortcuts.add(json);
                // 上限保护：即使出现未预期的回声缺失，也不会无限增长
                if (pendingEchoShortcuts.size > ECHO_MAX_ENTRIES) {
                    const oldest = pendingEchoShortcuts.values().next().value;
                    pendingEchoShortcuts.delete(oldest);
                }
            }
            shortcuts = list;
            return list;
        };
        const result = shortcutsMutationQueue.then(run, run);
        shortcutsMutationQueue = result.then(() => {}, () => {});
        return result;
    }

    // 远端（其他标签页）写入的 shortcuts：采纳并重渲染
    function adoptRemoteShortcuts(json) {
        if (pendingEchoShortcuts.has(json)) {
            pendingEchoShortcuts.delete(json);
            return;
        }
        const parsed = parseJsonSafe(json, null);
        if (!Array.isArray(parsed)) return;
        const list = sanitizeShortcuts(parsed, []);
        ensureShortcutIds(list);
        shortcuts = list;
        if (!currentDragElement) renderShortcuts();
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.shortcuts && typeof changes.shortcuts.newValue === 'string') {
            adoptRemoteShortcuts(changes.shortcuts.newValue);
        }
        if (!settingsSyncReady) return;
        // 设置类键的跨页同步：另一页修改了布局 / 颜色 / 背景时跟随更新
        const settingKeys = ['gridCols', 'gridSize', 'scale', 'colorMode', 'bgMode',
            'bingQuality', 'bingInterval', 'bingBg', 'customBg', GLASS_STORAGE_KEY];
        if (!settingKeys.some(k => Object.prototype.hasOwnProperty.call(changes, k))) return;
        (async () => {
            try {
                if ('gridCols' in changes || 'gridSize' in changes || 'scale' in changes) {
                    const [cols, size, scale] = await Promise.all([
                        Storage.get('gridCols', 5), Storage.get('gridSize', 100), Storage.get('scale', 100)
                    ]);
                    applyLayoutSettings(cols, size, scale);
                    colInput.value = clampNumber(cols, 3, 10, 5);
                    colValDisplay.innerText = colInput.value;
                    sizeInput.value = clampNumber(size, 80, 160, 100);
                    scaleInput.value = clampNumber(scale, 50, 200, 100);
                    scaleValDisplay.innerText = scaleInput.value + '%';
                }
                if ('colorMode' in changes) {
                    const mode = sanitizeColorMode(changes.colorMode.newValue);
                    currentColorMode = mode;
                    colorModeButtons.forEach(btn => {
                        const active = btn.dataset.mode === mode;
                        btn.classList.toggle('active', active);
                        btn.setAttribute('aria-checked', active ? 'true' : 'false');
                    });
                    try { localStorage.setItem('_colorMode', mode); } catch (e) {}
                    await applyColorMode(mode);
                }
                if ('bgMode' in changes || 'bingBg' in changes || 'customBg' in changes ||
                    'bingQuality' in changes || 'bingInterval' in changes) {
                    await loadBgSettings();
                }
                if (Object.prototype.hasOwnProperty.call(changes, GLASS_STORAGE_KEY) && window.LiquidGlass) {
                    window.LiquidGlass.applySettings(changes[GLASS_STORAGE_KEY].newValue);
                    window.dispatchEvent(new CustomEvent('liquidglass:settingschange'));
                }
            } catch (e) {
                console.debug('[sync] 应用其他标签页的设置变更失败:', e);
            }
        })();
    });

    // 渲染中止控制（提前声明，供早期渲染使用）
    let shortcutsAbortController = new AbortController();

    // 历史遗留的远程 URL 图标迁移为 data URL 的共享状态（跨渲染保持）：
    // - remoteIconFetches：按 URL 去重进行中的下载，避免并发渲染重复请求
    // - failedRemoteIcons：会话内已确认无法固化的 URL，渲染阶段直接跳过，避免每次打开新标签页都重试
    // 注意：必须声明在首次 renderShortcuts() 之前——早渲染会对含远程图标 URL 的条目
    // 调用 persistRemoteIcon，若声明位置靠后（初始化流程尾部）会触发 TDZ ReferenceError
    const remoteIconFetches = new Map();
    const failedRemoteIcons = new Set();

    // 远程 URL 图标一次性固化为 data URL：成功后更新磁贴并写入存储，
    // 之后每次渲染直接使用本地 data URL，不再请求远程资源。
    // 按 ID 定位条目并在写入前校验图标未被改动，固化期间的重排/编辑不会错写到其他条目
    async function persistRemoteIcon(id, url, imgElement, signal) {
        if (failedRemoteIcons.has(url)) return;

        let task = remoteIconFetches.get(url);
        if (!task) {
            task = fetchIconDataUrl(url).then(dataUrl => ({ dataUrl }));
            remoteIconFetches.set(url, task);
            try {
                await task;
            } finally {
                remoteIconFetches.delete(url);
            }
        }
        const { dataUrl } = await task;
        if (!dataUrl) {
            // 会话内负缓存：已确认无法固化的 URL 不再于每次渲染时重试
            failedRemoteIcons.add(url);
            return;
        }
        if (signal && signal.aborted) return;

        failedRemoteIcons.delete(url);
        if (imgElement.isConnected) imgElement.src = dataUrl;
        try {
            // 按稳定 ID 定位且要求当前图标仍是发起下载时的 URL：
            // 固化期间的重排/编辑/删除都不会把图标写到别的条目
            await mutateShortcuts({ type: 'setIcon', id, expectUrl: url, iconUrl: dataUrl });
        } catch (e) {
            console.debug('[icon] 固化远程图标写入失败:', url, e);
        }
    }

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
        // 元素尺寸可能变化：刷新物理折射滤镜（尺寸未变的分组命中缓存，代价极低）
        if (window.LiquidGlass) {
            try { window.LiquidGlass.refresh(); } catch {}
        }
    }

    // 布局设置已随 earlySettings 预读取，此处直接派生，无额外 storage 等待
    const savedCols = clampNumber(earlySettings.gridCols, 3, 10, 5);
    const savedSize = clampNumber(earlySettings.gridSize, 80, 160, 100);
    const savedScale = clampNumber(earlySettings.scale, 50, 200, 100);
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
            // 同步壁纸镜像：供下个新标签页首帧前由 theme-init.js 同步应用，
            // 避免每次打开都要等异步存储读取才出背景（大图超过配额则不镜像）
            let mirrored = false;
            try { localStorage.setItem('_bgImage', safeBgUrl); mirrored = true; } catch(e) {}
            if (!mirrored) { try { localStorage.removeItem('_bgImage'); } catch(e2) {} }
            stopBlobAnimation();
            
            // 仅自动模式下检测背景亮度；手动模式是用户显式选择，不被壁纸亮度覆盖。
            // 统一经 applyColorMode 提交（带请求令牌校验），检测函数本身不再直接改 DOM
            if (currentColorMode === 'auto') {
                await applyColorMode('auto', safeBgUrl);
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
            // 同步清除墙纸镜像与标记，下个新标签页不致残留陈旧背景
            try { localStorage.removeItem('_hasCustomBg'); localStorage.removeItem('_bgImage'); } catch(e) {}
            restartBlobAnimation();
            
            // 移除背景后重新应用颜色模式（自动模式将恢复跟随系统主题）
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
        // 先持久化、成功后再切换运行时状态；失败时保持旧模式并提示
        try {
            await Storage.setImmediate('bgMode', next);
        } catch (err) {
            showError('背景模式保存失败，请重试', err);
            return;
        }
        bgMode = next;
        try { localStorage.setItem('_bgMode', bgMode); } catch(e) {}
        syncBgModeUI();
        // loadBgSettings 仅在 custom 模式下读取自定义壁纸，切到该模式时补读预览图
        if (next === 'custom') {
            updatePreviews(await Storage.get('customBg'));
        }
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
        // 小值设置一次批量读取（单次跨进程往返）
        const settingValues = await Storage.getMany(['bgMode', 'bingQuality', 'bingInterval'], {});
        bgMode = sanitizeBgMode(settingValues.bgMode);
        try { localStorage.setItem('_bgMode', bgMode); } catch(e) {}
        bingQuality = sanitizeBingQuality(settingValues.bingQuality);
        bingInterval = sanitizeBingInterval(settingValues.bingInterval);
        bingIntervalSelect.value = String(bingInterval);
        bingQualityButtons.forEach(btn => {
            const active = btn.dataset.bingQuality === bingQuality;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-checked', active ? 'true' : 'false');
        });
        syncBgModeUI();
        // 仅读取当前模式所需要的大体积壁纸（启动首屏关键路径上不把不必要的
        // 数 MB data URL 反序列化进内存）；切换模式时的读取由 setBgMode 兜底
        const preloaded = {};
        let customBgForPreview = null;
        if (bgMode === 'bing') {
            preloaded.bing = sanitizeBackgroundValue(await Storage.get('bingBg'));
        } else if (bgMode === 'custom') {
            preloaded.custom = sanitizeBackgroundValue(await Storage.get('customBg'));
            customBgForPreview = preloaded.custom;
        }
        await updatePreviews(customBgForPreview);
        await applyCurrentBackground(preloaded);
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
        // Bing 部分壁纸没有 UHD 版本（404），UHD 失败时自动回退 1080P 再试一次
        const tryDownload = async (url) => {
            let imgResponse;
            try {
                imgResponse = await sendMessageWithTimeout({
                    action: 'fetchWallpaper',
                    url,
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
        };

        try {
            return await tryDownload(imageUrl);
        } catch (firstError) {
            if (firstError.name === 'AbortError' || firstError.name === 'TimeoutError') throw firstError;
            if (qualityTag === BING_QUALITY_MAP.uhd) {
                const fallbackUrl = `${BING_API_BASE}${pickedBase}_${BING_QUALITY_MAP.hd}.jpg`;
                console.warn('[fetchBingWallpaper] UHD 下载失败，回退 1080P:', firstError.message);
                return await tryDownload(fallbackUrl);
            }
            throw firstError;
        }
    }

    // 获取必应壁纸；force=true 忽略间隔强制获取（换一张、切换画质时用）。
    // 并发调用共享同一 Promise（去重），锁在进入函数时同步占用
    function fetchBing(force = false) {
        if (bingFetchPromise) return bingFetchPromise;
        bingFetchPromise = runBingFetch(force);
        return bingFetchPromise;
    }

    async function runBingFetch(force = false) {
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
            // 抓取期间用户切换过画质：仍处于必应壁纸模式时按最新画质补一次抓取。
            // 先释放并发锁再触发补抓，否则补抓会被去重逻辑误拦截
            const shouldRefetch = bingRefetchPending && bgMode === 'bing' && myToken === bgActionToken;
            bingRefetchPending = false;
            bingFetchPromise = null;
            if (shouldRefetch) fetchBing(true);
        }
    }

    // 初始化 Input 值
    colInput.value = savedCols;
    colValDisplay.innerText = savedCols;
    sizeInput.value = savedSize;
    scaleInput.value = savedScale;
    scaleValDisplay.innerText = savedScale + '%';
    
    // 初始化颜色模式设置（savedColorMode 已在最前方读取并应用）。
    // 全量同步选中态：HTML 中预置在"自动"按钮上的 active 必须先清除，
    // 否则已存手动模式（如深色）与"自动"会同时处于选中状态
    colorModeButtons.forEach(btn => {
        const active = btn.dataset.mode === savedColorMode;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });

    // 监听系统主题变化
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', async (e) => {
        // 对话框极性跟随页面解析主题（见 syncDialogTheme）
        syncDialogTheme();

        // 仅自动模式且无自定义背景时跟随系统主题变化；
        // 有自定义背景时颜色由背景亮度决定，不随系统主题切换
        if (currentColorMode === 'auto' && !document.documentElement.classList.contains('has-custom-bg')) {
            await applyColorMode('auto');
        }
    });
    
    // 对话框极性与页面解析主题对齐（body 类尚未就绪时回退 _resolvedTheme 缓存）
    syncDialogTheme();

    // --- 壁纸设置初始化 ---
    // 轻量主题定型结果（无壁纸场景）已在上面并发执行，此处落定后再应用背景
    await colorModeApplied;
    await loadBgSettings();
    // 必应壁纸模式下，若自动更换已到期（或尚无缓存），后台抓取一张新壁纸
    if (bgMode === 'bing') {
        fetchBing(false);
    }

    // --- 2. 设置面板逻辑 ---
    settingsBtn.addEventListener('click', () => {
        settingsDialog.showModal();
        // 打开时元素刚从 display:none 变为可见，立即挂接玻璃滤镜
        if (window.LiquidGlass) { try { window.LiquidGlass.refresh(); } catch {} }
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

        // 面板切换会改变对话框内容高度，折射滤镜须按新尺寸重新挂接，
        // 否则边缘高光/位移仍按旧尺寸计算而错位
        if (window.LiquidGlass) { try { window.LiquidGlass.refresh(); } catch {} }
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
        Storage.set('gridCols', e.target.value).catch(err => showError('布局设置保存失败', err));
    });

    sizeInput.addEventListener('input', async (e) => {
        e.target.setAttribute('aria-valuenow', e.target.value);
        applyLayoutSettings(colInput.value, e.target.value, scaleInput.value);
        Storage.set('gridSize', e.target.value).catch(err => showError('布局设置保存失败', err));
    });

    scaleInput.addEventListener('input', async (e) => {
        scaleValDisplay.innerText = e.target.value + '%';
        e.target.setAttribute('aria-valuenow', e.target.value);
        applyLayoutSettings(colInput.value, sizeInput.value, e.target.value);
        Storage.set('scale', e.target.value).catch(err => showError('布局设置保存失败', err));
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
            // 获取模式值
            const mode = sanitizeColorMode(button.dataset.mode);

            // 保存设置：UI 优先即时反馈，持久化失败时以错误提示告知
            // （乐观更新：本地已应用，仅持久化可能延迟失败）
            currentColorMode = mode;
            Storage.set('colorMode', mode).catch(err => showError('颜色模式保存失败', err));
            try { localStorage.setItem('_colorMode', mode); } catch(e) {}

            // 移除所有按钮的激活状态，再为当前点击的按钮添加激活状态
            colorModeButtons.forEach(btn => {
                btn.classList.toggle('active', btn === button);
                btn.setAttribute('aria-checked', btn === button ? 'true' : 'false');
            });

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

    // --- 液态玻璃参数设置（外观入口 + 右侧实时调参面板） ---
    const glassControlsHost = document.getElementById('glass-controls');
    const glassResetBtn = document.getElementById('glass-reset-btn');
    const glassTuneBtn = document.getElementById('glass-tune-btn');
    const glassDialogEl = document.getElementById('glass-dialog');
    const glassCloseBtn = document.getElementById('glass-close-btn');

    if (window.LiquidGlass && glassControlsHost && glassResetBtn &&
        glassTuneBtn && glassDialogEl && glassCloseBtn) {
        // 滑杆定义：[参数键, 显示名, min, max, step]
        const glassSliderDefs = [
            ['thickness', '玻璃厚度', 8, 80, 1],
            ['bezel', '斜面宽度', 3, 24, 1],
            ['ior', '折射率', 1, 2.5, 0.05],
            ['refractionLevel', '折射强度', 0, 1.5, 0.05],
            ['blurIn', '边缘柔化', 0, 3, 0.1],
            ['saturate', '色彩饱和', 1, 3, 0.1],
            ['specOpacity', '高光强度', 0, 1, 0.02],
            ['backdropBlur', '背景模糊', 0, 6, 0.2],
        ];
        let glassState = null;
        const glassValueEls = {};

        const formatGlassValue = (value, step) => {
            const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
            return Number(value).toFixed(decimals);
        };

        const applyAndPersistGlass = () => {
            Storage.set(GLASS_STORAGE_KEY, glassState)
                .catch(err => showError('玻璃参数保存失败', err));
            window.LiquidGlass.applySettings(glassState);
        };

        // 动态构建滑杆行（复用布局设置的 setting-group/setting-slider 样式）
        for (const [key, label, min, max, step] of glassSliderDefs) {
            const group = document.createElement('div');
            group.className = 'setting-group';

            const labelEl = document.createElement('label');
            labelEl.className = 'setting-label';
            labelEl.htmlFor = `glass-${key}`;

            const nameSpan = document.createElement('span');
            nameSpan.className = 'setting-name';
            nameSpan.textContent = label;

            const valueSpan = document.createElement('span');
            valueSpan.className = 'setting-value';
            nameSpan.appendChild(valueSpan);

            const input = document.createElement('input');
            input.type = 'range';
            input.className = 'setting-slider';
            input.id = `glass-${key}`;
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.setAttribute('aria-label', label);

            labelEl.appendChild(nameSpan);
            group.appendChild(labelEl);
            group.appendChild(input);

            input.addEventListener('input', () => {
                if (!glassState) return;
                glassState[key] = Number(input.value);
                valueSpan.textContent = formatGlassValue(input.value, step);
                applyAndPersistGlass();
            });

            glassValueEls[key] = { input, valueSpan };
            glassControlsHost.appendChild(group);
        }

        const syncGlassUI = () => {
            for (const [key, , , , step] of glassSliderDefs) {
                const { input, valueSpan } = glassValueEls[key];
                input.value = String(glassState[key]);
                valueSpan.textContent = formatGlassValue(glassState[key], step);
            }
        };

        // 外部变更（如数据导入）时同步滑杆 UI
        window.addEventListener('liquidglass:settingschange', () => {
            glassState = window.LiquidGlass.getSettings();
            syncGlassUI();
        });

        // 等持久化参数加载完成后再初始化 UI 状态，避免默认值闪现覆盖已存值
        window.LiquidGlass.ready.then(() => {
            glassState = window.LiquidGlass.getSettings();
            syncGlassUI();

            glassResetBtn.addEventListener('click', () => {
                glassState = window.LiquidGlass.getDefaults();
                applyAndPersistGlass();
                syncGlassUI();
                showToast('已恢复默认玻璃参数', 'success');
            });

            // 打开右侧调参面板：须先关闭设置对话框——模态对话框打开期间文档
            // 其余部分处于 inert 状态，非模态面板将无法交互；关闭后即可
            // 不遮挡、不模糊页面地实时预览调整效果
            glassTuneBtn.addEventListener('click', () => {
                settingsDialog.close();
                try { glassDialogEl.show(); } catch {}
                if (window.LiquidGlass) { try { window.LiquidGlass.refresh(); } catch {} }
            });

            glassCloseBtn.addEventListener('click', () => glassDialogEl.close());

            // 非模态对话框不自带 Esc 关闭行为，手动补齐
            glassDialogEl.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    glassDialogEl.close();
                }
            });
        }).catch((e) => console.debug('[liquid-glass] 设置初始化失败:', e));
    }

    // 下载远程图标并转为 data URL（经由 background 执行，借助 host_permissions 绕过 CORS）。
    // 远程图标只下载一次，之后以 data URL 形态永久保存，避免每次打开新标签页都重新请求。
    // 失败返回 null，调用方保留原 URL（页面 <img> 直接显示远程图片不受 CORS 限制）
    async function fetchIconDataUrl(url, timeoutMs = 15000) {
        try {
            const response = await sendMessageWithTimeout({
                action: 'fetchIcon',
                url,
                timeoutMs
            }, timeoutMs + 5000);
            if (response && response.success && response.dataUrl) {
                return response.dataUrl;
            }
        } catch (e) {
            console.debug('[icon] 远程图标下载失败:', url, e);
        }
        return null;
    }

    // 保存快捷方式
    // 保存重入守卫：远程图标固化最长 ~20s（fetchIconDataUrl），期间重复提交
    // 会产生重复快捷方式
    let savingShortcut = false;

    async function handleSaveShortcut(e) {
        if (e) e.preventDefault();
        if (savingShortcut) return;
        // 提交时固定会话令牌与目标 ID：等待远程图标期间用户取消或打开其他条目时，
        // 旧保存流程在令牌校验处终止，不会把旧字段写入新目标
        const session = editSession;
        const targetId = editTargetId;
        const name = nameInput.value.trim();
        const finalUrl = normalizeHttpUrl(urlInput.value);
        const rawIcon = iconInput.value.trim();
        let icon = sanitizeIconUrl(rawIcon);

        if (rawIcon && !icon) {
            showError('请输入有效的图标 URL 或上传图片');
            return;
        }

        // 远程 URL 图标：下载一次转为 data URL 后永久保存；失败则保留原 URL 并提示，
        // 渲染阶段仍会尝试迁移（见 persistRemoteIcon）
        savingShortcut = true;
        saveBtn.disabled = true;
        try {
            if (icon && (icon.startsWith('http:') || icon.startsWith('https:'))) {
                const persistedIcon = await fetchIconDataUrl(icon);
                // 下载期间会话已失效（取消 / 关闭 / 打开了其他条目）：立即终止
                if (session !== editSession) return;
                if (persistedIcon) {
                    icon = persistedIcon;
                } else {
                    showToast('远程图标下载失败，已保留原 URL', 'error', 4000);
                }
            }

            if (!name || !finalUrl) {
                showError('请输入有效的名称和网址');
                return;
            }

            const fields = { name: name.slice(0, MAX_SHORTCUT_NAME_LENGTH), url: finalUrl };
            if (icon) fields.icon = icon;

            // 先持久化、成功后再提交界面状态（渲染 + 关闭对话框）；
            // 写入失败保持对话框打开并提示，不再出现"显示成功但未保存"
            if (targetId !== null) {
                await mutateShortcuts({ type: 'update', id: targetId, fields });
            } else {
                // 数量上限校验由后台在串行队列内基于最新列表执行，避免并发新增绕过上限
                await mutateShortcuts({ type: 'add', item: { id: makeShortcutId(), ...fields } });
            }

            await renderShortcuts();
            editDialog.close();
        } catch (err) {
            showError(err && err.message ? err.message : '保存失败，请重试', err);
        } finally {
            savingShortcut = false;
            saveBtn.disabled = false;
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
    // 关闭对话框即失效当前编辑会话：取消、Esc 或点击遮罩关闭后，
    // 仍在进行的旧保存流程（如远程图标下载）在令牌校验处终止
    editDialog.addEventListener('close', () => {
        editSession++;
        editTargetId = null;
    });
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
            try {
                await Storage.setImmediate('bingQuality', quality);
            } catch (err) {
                showError('画质保存失败，请重试', err);
                return;
            }
            bingQuality = quality;
            bingQualityButtons.forEach(b => {
                const active = b.dataset.bingQuality === bingQuality;
                b.classList.toggle('active', active);
                b.setAttribute('aria-checked', active ? 'true' : 'false');
            });
            // 切换画质后立即按新画质重新获取壁纸；
            // 若已有抓取进行中（并发去重会跳过），登记后由其 finally 补抓
            if (bingFetchPromise) {
                bingRefetchPending = true;
                return;
            }
            await fetchBing(true);
        });
    });

    // [壁纸功能 4] 必应壁纸自动更换间隔
    bingIntervalSelect.addEventListener('change', async () => {
        const interval = sanitizeBingInterval(bingIntervalSelect.value);
        try {
            await Storage.setImmediate('bingInterval', interval);
        } catch (err) {
            showError('自动更换间隔保存失败，请重试', err);
            bingIntervalSelect.value = String(bingInterval); // 恢复为已保存的值
            return;
        }
        bingInterval = interval;
        bingIntervalSelect.value = String(bingInterval);
    });

    // [壁纸功能 5] 上传本地图片 (转 Base64 存储)
    bgUploadInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // 用户上传背景：递增令牌并中止正在进行的必应壁纸获取，避免其完成后覆盖。
        // 本次上传持有令牌快照：压缩期间用户移除/再次上传会使旧压缩结果失效，
        // 不会把过期的图片写回存储
        const myBgToken = ++bgActionToken;
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

        // SVG 无固有尺寸时 canvas 解码得到 0×0 画布（输出全黑），
        // 且矢量图位图化无意义，直接拦截
        if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
            showError('不支持 SVG 图片作为背景，请选择 JPG / PNG / WebP');
            bgUploadInput.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = async function(event) {
            const base64String = event.target.result;
            try {
                const compressedImage = await compressImage(base64String, 0.7);
                // 压缩期间用户移除/再次上传背景：本次结果作废，不再写回
                if (myBgToken !== bgActionToken) return;
                if (!isImageDataUrl(compressedImage, MAX_BACKGROUND_DATA_URL_CHARS)) {
                    showError('压缩后的图片仍然过大，请选择更小的图片');
                    return;
                }
                await Storage.setImmediate('customBg', compressedImage);
                if (myBgToken !== bgActionToken) return;
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
        // 递增令牌并中止正在进行的必应壁纸获取（同时使进行中的上传写回失效）
        ++bgActionToken;
        if (bingAbortController) {
            bingAbortController.abort();
            bingAbortController = null;
        }
        try {
            await Storage.remove('customBg');
        } catch (err) {
            showError('移除失败，请重试', err);
            return;
        }
        await updatePreviews(null);
        if (bgMode === 'custom') await applyBackground(null);
        showToast('图片已移除', 'success');
    });

    // 数据导出功能
    exportDataBtn.addEventListener('click', async () => {
        // 并行读取，避免大体积壁纸项串行等待
        const [gridCols, gridSize, scale, customBg, bgMode, bingQuality, bingInterval, bingLastFetch, bingBg, colorMode, glassParams, storedShortcutsRaw] = await Promise.all([
            Storage.get('gridCols', 5),
            Storage.get('gridSize', 100),
            Storage.get('scale', 100), // 显示比例设置
            Storage.get('customBg'),
            Storage.get('bgMode', 'default'),
            Storage.get('bingQuality', 'uhd'),
            Storage.get('bingInterval', DEFAULT_BING_INTERVAL),
            Storage.get('bingLastFetch', 0),
            Storage.get('bingBg'),
            Storage.get('colorMode', 'auto'), // 颜色模式设置
            Storage.get(GLASS_STORAGE_KEY), // 液态玻璃参数
            Storage.get('shortcuts', null)
        ]);
        // 快捷方式以 storage 为准（一致快照）：本页内存可能落后于其他标签页的修改；
        // 仅全新安装（storage 尚无该键）时回退到内存中的默认列表
        const exportShortcuts = storedShortcutsRaw != null
            ? parseStoredShortcuts(storedShortcutsRaw)
            : sanitizeShortcuts(shortcuts, DEFAULT_SHORTCUTS);
        const exportData = {
            schemaVersion: 1,
            shortcuts: exportShortcuts,
            gridCols,
            gridSize,
            scale,
            customBg,
            bgMode,
            bingQuality,
            bingInterval,
            bingLastFetch,
            bingBg,
            colorMode,
            glassParams: glassParams === null ? undefined : glassParams
        };
        
        // 收集所有 favicon 缓存：直接全量扫描（键索引可能落后于实际条目——
        // 并发写入丢键时按索引导出会漏缓存），导出为低频显式操作，可接受一次全量读取；
        // 同时以扫描结果重建键索引，修复潜在的索引缺键
        let favicons = {};
        const items = await new Promise(resolve => {
            chrome.storage.local.get(null, res => resolve(chrome.runtime.lastError ? {} : (res || {})));
        });
        const faviconKeyList = Object.keys(items).filter(key => key.startsWith('favicon_'));
        faviconKeyList.forEach(key => { favicons[key] = items[key]; });
        favicons = Object.fromEntries(
            Object.entries(favicons)
                .sort((a, b) => Number(b[1]?.timestamp || 0) - Number(a[1]?.timestamp || 0))
                .slice(0, MAX_EXPORTED_FAVICONS)
        );
        Storage.setImmediate('_faviconKeys', Object.keys(favicons)).catch(() => {});
        exportData.favicons = sanitizeFaviconCache(favicons);

        // 创建一个 Blob 对象并下载
        const dataStr = JSON.stringify(exportData, null, 2);
        const dataBlob = new Blob([dataStr], {type: 'application/json'});
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        const now = new Date();
        const dateTag = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        link.download = `liquid-newtab-data-${dateTag}.json`;
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

        // 导入大小上限需覆盖"本扩展可导出的最大合法备份"：120 个快捷方式 × 最大
        // 图标 data URL（~700K 字符）+ 2 × 12MB 壁纸 + favicon 缓存，最坏约 150MB 字符。
        // 此前的 32MB 上限会导致"能导出的备份无法重新导入"
        const MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024;
        if (file.size > MAX_IMPORT_FILE_BYTES) {
            showError('文件过大（超过 256MB），请选择有效的导出文件');
            importDataInput.value = '';
            return;
        }
        // 超大文件解析耗时较长，提前告知；仍允许继续
        if (file.size > 32 * 1024 * 1024) {
            if (!window.confirm(`文件较大（约 ${Math.round(file.size / 1024 / 1024)}MB），解析可能需要数秒，继续吗？`)) {
                importDataInput.value = '';
                return;
            }
        }

        const reader = new FileReader();
        reader.onload = async function(event) {
            try {
                const importData = validateImportedData(JSON.parse(event.target.result));

                // 破坏性操作二次确认——在校验后进行，可展示条目数、丢弃原因与覆盖范围，
                // 避免静默丢弃用户数据或以模糊文案掩盖覆盖范围
                const shortcutCount = importData.shortcuts ? importData.shortcuts.length : null;
                const droppedNote = importData.droppedShortcuts > 0
                    ? `，另有 ${importData.droppedShortcuts} 个无效条目将被丢弃（名称/网址非法或超出 120 个上限）`
                    : '';
                const shortcutNote = shortcutCount === null
                    ? '不更改快捷方式'
                    : `导入 ${shortcutCount} 个快捷方式${droppedNote}`;
                if (!window.confirm(`${shortcutNote}。\n布局、外观、颜色模式与背景设置将被备份内容覆盖，确定继续吗？`)) {
                    importDataInput.value = '';
                    return;
                }

                // --- 集中提交：所有键合并为一次 chrome.storage.local.set ---
                ensureShortcutIds(importData.shortcuts || []);
                const shortcutsJson = importData.shortcuts !== undefined
                    ? JSON.stringify(importData.shortcuts)
                    : undefined;
                const [currentVersion] = await Promise.all([Storage.get(SHORTCUTS_VERSION_KEY, 0)]);
                const batch = {};
                if (shortcutsJson !== undefined) batch.shortcuts = shortcutsJson;
                batch[SHORTCUTS_VERSION_KEY] = (Number(currentVersion) || 0) + 1;
                if (importData.gridCols !== undefined) batch.gridCols = importData.gridCols;
                if (importData.gridSize !== undefined) batch.gridSize = importData.gridSize;
                if (importData.scale !== undefined) batch.scale = importData.scale;
                if (importData.customBg !== undefined && importData.customBg) batch.customBg = importData.customBg;
                if (importData.bingBg !== undefined && importData.bingBg) batch.bingBg = importData.bingBg;
                if (importData.bingLastFetch !== undefined) batch.bingLastFetch = importData.bingLastFetch;
                if (importData.bgMode !== undefined) batch.bgMode = importData.bgMode;
                if (importData.bingQuality !== undefined) batch.bingQuality = importData.bingQuality;
                if (importData.bingInterval !== undefined) batch.bingInterval = importData.bingInterval;
                if (importData.colorMode !== undefined) batch.colorMode = importData.colorMode;

                // 液态玻璃参数：有引擎时先经 applySettings 校验并热更新，再持久化净化后的值
                if (importData.glassParams !== undefined) {
                    if (window.LiquidGlass) {
                        batch[GLASS_STORAGE_KEY] = window.LiquidGlass.applySettings(importData.glassParams);
                        window.dispatchEvent(new CustomEvent('liquidglass:settingschange'));
                    } else {
                        batch[GLASS_STORAGE_KEY] = importData.glassParams;
                    }
                }

                // favicon 缓存：导入条目 + 重建键索引；旧条目清理在提交成功后进行
                let staleFaviconKeys = [];
                if (importData.favicons !== undefined) {
                    Object.assign(batch, importData.favicons);
                    batch._faviconKeys = Object.keys(importData.favicons);
                    const allItems = await new Promise(resolve => {
                        chrome.storage.local.get(null, res => resolve(chrome.runtime.lastError ? {} : (res || {})));
                    });
                    const newKeySet = new Set(batch._faviconKeys);
                    staleFaviconKeys = Object.keys(allItems)
                        .filter(key => key.startsWith('favicon_') && !newKeySet.has(key));
                }

                if (shortcutsJson !== undefined) {
                    pendingEchoShortcuts.add(shortcutsJson);
                }
                try {
                    await Storage.setImmediateBatch(batch);
                } catch (err) {
                    if (shortcutsJson !== undefined) pendingEchoShortcuts.delete(shortcutsJson);
                    throw err;
                }

                // 提交成功后再处理需删除的键（null 值字段与被替换的旧 favicon）
                try {
                    if (importData.customBg !== undefined && !importData.customBg) {
                        await Storage.remove('customBg');
                    }
                    if (importData.bingBg !== undefined && !importData.bingBg) {
                        await Storage.remove('bingBg');
                    }
                    if (staleFaviconKeys.length > 0) {
                        await Storage.remove(staleFaviconKeys);
                    }
                } catch (cleanupError) {
                    // 清理失败不影响导入结果（多余条目由容量淘汰机制回收），仅记录
                    console.warn('[import] 清理旧数据失败:', cleanupError);
                }

                // --- 持久化成功后提交界面状态 ---
                if (shortcutsJson !== undefined) {
                    shortcuts = importData.shortcuts;
                }
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
                currentColorMode = colorMode;
                if (importData.bgMode !== undefined || importData.colorMode !== undefined) {
                    try {
                        localStorage.setItem('_bgMode', sanitizeBgMode(await Storage.get('bgMode', 'default')));
                        localStorage.setItem('_colorMode', colorMode);
                    } catch (e) {}
                }

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

                // 显式应用解析后的颜色模式：loadBgSettings 的有效壁纸分支在手动模式下
                // 不会调用 applyColorMode，从浅色页导入"深色+壁纸"时不补这次调用会仍显示浅色
                await applyColorMode(colorMode);

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
    // （remoteIconFetches / failedRemoteIcons / persistRemoteIcon 已前移至首次渲染之前，
    //   见"快捷方式数据层"区块——早渲染会对含远程图标的条目调用 persistRemoteIcon）

    async function renderShortcuts() {
        // 拖拽排序期间 DOM 顺序领先于 shortcuts 数组（dragend 才重排），
        // 此时若被外部触发重渲染（如其他标签页导入数据）会以旧数组回跳，直接跳过
        if (currentDragElement) return;
        shortcutsAbortController.abort();
        shortcutsAbortController = new AbortController();
        const signal = shortcutsAbortController.signal;
        shortcuts = sanitizeShortcuts(shortcuts, DEFAULT_SHORTCUTS);
        // 兜底：渲染出的 DOM 必须带有效 ID（右键/拖拽按 ID 定位）。
        // 确定性补齐，多个页面独立执行也得到一致结果；真正的持久化由启动迁移
        // 与后台修改队列负责。
        ensureShortcutIds(shortcuts);
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
            // 稳定 ID 供拖拽排序 / 右键菜单 / 异步图标写回定位条目，
            // 不再依赖随重排过期的数组下标
            link.dataset.id = item.id;
            link.setAttribute('role', 'listitem');
            link.setAttribute('aria-label', `${item.name} - 快捷方式`);

            const img = document.createElement('img');
            const span = document.createElement('span');
            link.appendChild(img);
            link.appendChild(span);

            if (item.icon) {
                img.src = item.icon;
                // 历史遗留的远程 URL 图标：后台一次性转 data URL 并固化到存储，
                // 之后渲染直接使用本地 data URL，不再每次请求远程资源
                if (item.icon.startsWith('http:') || item.icon.startsWith('https:')) {
                    persistRemoteIcon(item.id, item.icon, img, signal);
                }
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
            // 自定义图标允许任意 http(s) URL，不向第三方站点泄露 referrer
            img.referrerPolicy = 'no-referrer';
            span.textContent = item.name;
            span.title = item.name;

            // 图标加载/解码失败时统一回退为字母占位图（含缓存 dataUrl 损坏的情况）；
            // 升级队列不再自行判断 naturalWidth，避免把仍在加载中的 _favicon 图片误判为失败
            img.addEventListener('error', () => {
                if (img.isConnected) applyFaviconFallback(img, item.url);
            }, { once: true, signal });

            link.addEventListener('contextmenu', (e) => showContextMenu(e, item.id), { signal });
            addDragEvents(link, signal);

            fragment.appendChild(link);
        }

        // 写入 DOM 前再次检查，避免旧渲染覆盖新渲染
        if (signal.aborted) return;
        grid.innerHTML = '';
        grid.appendChild(fragment);

        processUpgradeQueue(upgradeQueue, signal);
        // 新磁贴需要挂接动态折射滤镜（同尺寸分组命中缓存）
        if (window.LiquidGlass) {
            try { window.LiquidGlass.refresh(); } catch {}
        }
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

        e.dataTransfer.setData('text/plain', item.dataset.id || '');
        e.dataTransfer.effectAllowed = 'move';

        // Chromium 原生拖拽快照对含 backdrop-filter 的圆角元素会在四角漏出
        // 未裁剪的白底，且折射效果会被拍扁；改用静态「玻璃质感」克隆作为拖拽幻影。
        // 关键：幻影必须存活到 dragend——过早移除（如 setTimeout 0）会使浏览器
        // 回退到有缺陷的原生快照。拖拽位图是静态的，无法保留实时折射，
        // 故以对角渐变高光 + 内阴影近似玻璃观感
        try {
            const ghost = item.cloneNode(true);
            const radius = getComputedStyle(item).borderTopLeftRadius || '16px';
            ghost.style.cssText =
                'position:fixed;left:-9999px;top:-9999px;' +
                'width:' + item.offsetWidth + 'px;height:' + item.offsetHeight + 'px;' +
                'margin:0;border-radius:' + radius + ';' +
                'background:linear-gradient(135deg,rgba(255,255,255,0.32),rgba(255,255,255,0.07) 42%,rgba(255,255,255,0.16));' +
                'box-shadow:inset 0 1px 1px rgba(255,255,255,0.28),0 10px 28px rgba(0,0,0,0.35);' +
                '-webkit-backdrop-filter:none;backdrop-filter:none;' +
                'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
                'pointer-events:none;';
            ghost.setAttribute('aria-hidden', 'true');
            document.body.appendChild(ghost);
            e.dataTransfer.setDragImage(ghost, Math.round(item.offsetWidth / 2), Math.round(item.offsetHeight / 2));
            const removeGhost = () => ghost.remove();
            window.addEventListener('dragend', removeGhost, { once: true });
            setTimeout(removeGhost, 15000); // 拖拽被系统取消等异常路径的兜底清理
        } catch {}
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

            // 以 DOM 实时顺序为准、按稳定 ID 重排（后台按 ID 映射最新列表，
            // 期间被其他页面删除的条目自动跳过，新出现的条目追加到末尾）
            const domIds = Array.from(grid.querySelectorAll('.shortcut-item'))
                .map(el => el.dataset.id)
                .filter(Boolean);
            try {
                await mutateShortcuts({ type: 'reorder', ids: domIds });
            } catch (err) {
                showError('排序保存失败，请重试', err);
            }
        }, { signal });
    }
    


    // --- 6. 增删改查弹窗逻辑 ---
    const addBtn = document.getElementById('add-shortcut-btn');
    
    addBtn.addEventListener('click', () => {
        editSession++; // 新建会话
        editTargetId = null;
        nameInput.value = '';
        urlInput.value = '';
        iconInput.value = ''; // 清空图标输入框
        iconPreviewFallback = null; // 新建快捷方式无站点 favicon 回退
        updateIconPreview();
        editDialog.showModal();
        if (window.LiquidGlass) { try { window.LiquidGlass.refresh(); } catch {} }
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
        const uploadSession = editSession;
        reader.onload = function(event) {
            // 会话失效（对话框已关闭/切换目标）时不回写输入框
            if (uploadSession !== editSession) return;
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

        const session = editSession;
        refreshIconBtn.disabled = true;

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'getBestFavicon',
                url: fullUrl,
                forceRefresh: true
            });

            // 等待期间会话失效（取消/关闭/切换目标）：不改动任何输入框与预览
            if (session !== editSession) return;

            if (response && response.dataUrl) {
                iconInput.value = response.dataUrl;
                iconPreviewFallback = null;
            } else {
                // 获取失败：不改动输入框（保留用户已输入的自定义 URL；
                // 未输入时保持"自动获取"语义），仅更新预览兜底。
                // _favicon 代理 URL 含扩展 ID，持久化后换机/重装即失效
                iconPreviewFallback = buildFaviconPreviewUrl(fullUrl);
            }
            updateIconPreview();
        } catch {
            if (session !== editSession) return;
            iconPreviewFallback = buildFaviconPreviewUrl(fullUrl);
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

    function showContextMenu(e, id) {
        e.preventDefault();
        e.stopPropagation();
        contextMenuId = id;
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
        contextMenuId = null;
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
    

    

    
    async function deleteContextShortcut() {
        setContextMenuVisible(false);
        // 按稳定 ID 定位：菜单打开期间列表变化（拖拽重排 / 其他页面修改）不会误删相邻条目
        const targetId = contextMenuId;
        if (!targetId) {
            // 不再静默返回：ID 缺失时用户会以为"点了没反应"，给出可诊断的提示
            showError('无法定位该快捷方式，请刷新页面后重试');
            return;
        }
        try {
            const next = await mutateShortcuts({ type: 'remove', id: targetId });
            if (next) await renderShortcuts();
        } catch (err) {
            showError('删除失败，请重试', err);
        }
    }

    function editContextShortcut() {
        setContextMenuVisible(false);
        // 按稳定 ID 定位，防止索引过期导致编辑错项。
        // 必须先判空：contextMenuId 为 undefined 时 find(s => s.id === undefined)
        // 会命中首个无 ID 条目，表现为"编辑第 2 个磁贴却打开第 1 个"
        if (!contextMenuId) {
            showError('无法定位该快捷方式，请刷新页面后重试');
            return;
        }
        const target = shortcuts.find(s => s.id === contextMenuId);
        if (!target) {
            showError('该快捷方式已被删除或在其他标签页中修改');
            return;
        }
        editSession++; // 开启新的编辑会话
        editTargetId = target.id;
        nameInput.value = target.name;
        urlInput.value = target.url;
        // 填充图标URL（如果存在）
        iconInput.value = target.icon || '';
        // 未设置自定义图标时，用站点 favicon 作为预览回退，使预览与磁贴显示一致
        if (target.icon) {
            iconPreviewFallback = null;
        } else {
            // 先用 _favicon 接口即时占位，再异步替换为磁贴所用的最佳 favicon（同源 chrome.storage.local）
            iconPreviewFallback = buildFaviconPreviewUrl(target.url);
            const session = editSession;
            resolveFaviconPreview(target.url).then(best => {
                // 仅当仍在同一编辑会话且未填入自定义图标时，才用最佳 favicon 刷新预览
                if (best && session === editSession && editTargetId === target.id && !iconInput.value.trim()) {
                    iconPreviewFallback = best;
                    updateIconPreview();
                }
            });
        }
        editDialog.showModal();
        // 对话框显示后再更新预览，确保已有图标的快捷方式能可靠加载并渲染出图标
        updateIconPreview();
        if (window.LiquidGlass) { try { window.LiquidGlass.refresh(); } catch {} }
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
    // 异步检测（图片解码/亮度采样）完成后复核请求令牌——检测期间用户切换了
    // 手动主题、切换了背景或再次发起检测时，旧结果整体丢弃，不再修改 DOM
    // 或覆盖缓存（修复旧的自动检测覆盖后来手动选择的问题）

    // 主题统一提交点：应用 body 极性类 + 持久化权威结果 + 同步文本颜色类
    function commitResolvedTheme(theme) {
        const body = document.body;
        // 原子切换：仅在结果与当前不同时修改类名
        const targetClass = theme === 'light' ? 'light-bg' : 'dark-bg';
        const removeClass = theme === 'light' ? 'dark-bg' : 'light-bg';
        if (!body.classList.contains(targetClass)) {
            body.classList.remove(removeClass);
            body.classList.add(targetClass);
        }
        // 持久化实际主题，供下次首绘前的 theme-init.js 同步读取
        try { localStorage.setItem('_resolvedTheme', theme); } catch(e) {}
        return updateTextColorClasses(theme);
    }

    async function applyColorMode(mode, preloadedBgVal) {
        mode = sanitizeColorMode(mode);
        const requestToken = ++themeRequestToken;

        // 解析具体主题：自动模式根据背景亮度/系统偏好计算，手动模式直接使用指定值。
        // 关键：不在异步检测前移除当前主题类，避免检测期间回退 :root 深色默认导致闪烁；
        // 保持当前主题不动，检测完成后仅在结果不同时原子切换。
        let resolvedTheme;
        if (mode === 'auto') {
            if (document.documentElement.classList.contains('has-custom-bg')) {
                // 直接用壁纸 data URL 做亮度检测，避免再走 getComputedStyle 嗅探整段 data URL
                let bgVal = preloadedBgVal !== undefined ? sanitizeBackgroundValue(preloadedBgVal) : null;
                if (!bgVal) {
                    let bgModeNow = null;
                    try { bgModeNow = localStorage.getItem('_bgMode'); } catch(e) {}
                    if (bgModeNow === 'bing') {
                        bgVal = sanitizeBackgroundValue(await Storage.get('bingBg'));
                    } else if (bgModeNow === 'custom') {
                        bgVal = sanitizeBackgroundValue(await Storage.get('customBg'));
                    }
                }
                resolvedTheme = await detectBackgroundBrightness(bgVal);
            } else {
                // 竞态保护：bgMode 为 bing/custom 但 has-custom-bg 类尚未添加时，
                // 用上次权威检测结果而非系统偏好，避免覆盖正确的缓存主题
                let bgModeNow;
                try { bgModeNow = localStorage.getItem('_bgMode'); } catch(e) {}
                if (bgModeNow === 'bing' || bgModeNow === 'custom') {
                    resolvedTheme = getCachedOrSystemTheme();
                } else {
                    resolvedTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
                }
            }
        } else {
            resolvedTheme = mode;
        }

        // 检测期间出现了更新的主题请求：放弃本次提交，由最新请求负责应用
        if (requestToken !== themeRequestToken) return;
        await commitResolvedTheme(resolvedTheme);
    }

    // 检测背景亮度并返回对应主题（'light' | 'dark'）——纯计算函数，
    // 不修改 DOM / 不写缓存；应用由 applyColorMode 的统一提交点负责
    // preferredBgVal：调用方已持有的背景 data URL（可选）；缺省时回退为从计算样式嗅探
    async function detectBackgroundBrightness(preferredBgVal = null) {
        let backgroundImage = '';

        if (preferredBgVal) {
            backgroundImage = `url("${preferredBgVal}")`;
        } else {
            // 获取预加载背景是否有图片
            const preloadBgEl = document.getElementById('preload-bg');
            if (preloadBgEl) {
                const preloadStyle = window.getComputedStyle(preloadBgEl);
                backgroundImage = preloadStyle.backgroundImage;
            }

            // 如果预加载背景没有图片，检查body的背景图
            if (!backgroundImage || backgroundImage === 'none' || !backgroundImage.includes('url')) {
                const bodyStyle = window.getComputedStyle(document.body);
                backgroundImage = bodyStyle.backgroundImage;
            }
        }

        // 如果有自定义背景图
        const urlMatch = backgroundImage.match(/url\(["']?(.*?)["']?\)/);
        if (urlMatch && urlMatch[1] && urlMatch[1] !== 'none') {
            try {
                return await new Promise((resolve) => {
                    const img = new Image();
                    img.crossOrigin = 'Anonymous';
                    img.onload = function() {
                        try {
                            const canvas = document.createElement('canvas');
                            const ctx = canvas.getContext('2d');
                            const sampleSize = 64;
                            canvas.width = sampleSize;
                            canvas.height = sampleSize;
                            ctx.drawImage(img, 0, 0, sampleSize, sampleSize);

                            const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data;

                            let totalBrightness = 0;
                            let count = 0;
                            for (let i = 0; i < data.length; i += 4) {
                                const r = data[i];
                                const g = data[i + 1];
                                const b = data[i + 2];
                                totalBrightness += (r * 299 + g * 587 + b * 114) / 1000;
                                count++;
                            }

                            const averageBrightness = totalBrightness / count;
                            resolve(averageBrightness > 128 ? 'light' : 'dark');
                        } catch (e) {
                            console.warn('无法分析背景图片亮度（可能受 CORS 限制），使用默认深色主题', e);
                            resolve('dark');
                        }
                    };
                    img.onerror = function() {
                        console.warn('背景图片加载失败，使用默认深色主题');
                        resolve('dark');
                    };
                    img.src = urlMatch[1];
                });
            } catch {
                return 'dark';
            }
        }

        // 没有自定义背景图，根据系统主题偏好判断
        return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }

    // 更新文本颜色类
    // theme: 'light' | 'dark'，由 applyColorMode 的统一提交点（commitResolvedTheme）传入
    async function updateTextColorClasses(theme) {
        // 主题解析落定后同步对话框极性（所有主题解析路径都会经过此处，
        // 保证纯黑/纯白壁纸上对话框 scrim 与文字极性一致）
        syncDialogTheme();
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
    

    
    // 对齐对话框极性与页面解析主题（由背景亮度检测/用户手动选择驱动），
    // 而非系统偏好——纯黑/纯白壁纸上必须保证面板底色与文字极性一致才可读。
    // 极性判定优先级：body 类 > _resolvedTheme 缓存（body 类尚未就绪的
    // 初始化窗口期使用，避免与权威缓存冲突）> 系统偏好兜底
    function syncDialogTheme() {
        const dialogs = document.querySelectorAll('.glass-dialog');
        let dark;
        if (document.body.classList.contains('light-bg')) {
            dark = false;
        } else if (document.body.classList.contains('dark-bg')) {
            dark = true;
        } else {
            dark = getCachedOrSystemTheme() === 'dark';
        }
        dialogs.forEach(dialog => {
            dialog.classList.remove('light-bg', 'dark-mode');
            dialog.classList.add(dark ? 'dark-mode' : 'light-bg');
        });
    }
    
    // 对话框关闭后，挂在其内部（顶层）的 toast 不可见，连同容器一并移除，
    // 避免空容器在对话框内残留累积；toast 自身的移除定时器对已分离节点无害
    document.querySelectorAll('.glass-dialog').forEach(dlg => {
        dlg.addEventListener('close', () => {
            dlg.querySelectorAll(':scope > .toast-container--dialog').forEach(c => c.remove());
        });
    });

    // 初始化完成：启用设置类键的跨页同步（此前运行时状态尚未就绪，仅同步 shortcuts）
    settingsSyncReady = true;

    initDragAndDrop();
});
