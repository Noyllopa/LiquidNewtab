const FAVICON_SOURCES = [
    {
        name: 'googleV2',
        priority: 5,
        getUrl: (url) => {
            const params = new URLSearchParams({
                client: 'SOCIAL',
                type: 'FAVICON',
                fallback_opts: 'TYPE,SIZE,URL',
                url: getDomainUrl(url),
                size: '256'
            });
            return `https://t1.gstatic.com/faviconV2?${params}`;
        }
    },
    {
        name: 'duckduckgo',
        priority: 4,
        getUrl: (url) => {
            const domain = encodeURIComponent(new URL(url).hostname);
            return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
        }
    },
    {
        name: 'googleS2',
        priority: 2,
        getUrl: (url) => {
            const domain = encodeURIComponent(new URL(url).hostname);
            return `https://www.google.com/s2/favicons?domain=${domain}&sz=256`;
        }
    },
    {
        name: 'iconHorse',
        priority: 1,
        getUrl: (url) => {
            const domain = encodeURIComponent(new URL(url).hostname);
            return `https://icon.horse/icon/${domain}`;
        }
    }
];

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 与 script.js 的 FAVICON_CACHE_TTL 保持一致
const SOURCE_TIMEOUT = 3000;
const MAX_FAVICON_BLOB_BYTES = 128 * 1024;
const MAX_REMOTE_IMAGE_BYTES = 16 * 1024 * 1024; // 远程壁纸响应体大小上限（与 script.js 一致）
const MAX_JSON_BYTES = 5 * 1024 * 1024;          // 接口文本响应体大小上限
const FAILED_FAVICON_TTL = 24 * 60 * 60 * 1000;  // 图标获取失败的负缓存时长，期内不再重试
const FAVICON_INDEX_KEY = '_faviconKeys'; // favicon 键索引：导出时免 get(null) 全量读（含数 MB 壁纸）
const MAX_SHORTCUTS_BG = 120; // 与 script.js 的 MAX_SHORTCUTS 保持一致

/* --------------------------------------------------------------------------
 * 消息入口加固
 * manifest 未配置 externally_connectable，外部网页无法直接发消息；以下校验属于
 * 纵深防御：即使将来放开或出现同源串扰，也保证只有本扩展页面能驱动后台，
 * 且只能请求 http(s) 资源、超时参数被钳制在合理区间。
 * -------------------------------------------------------------------------- */
const ALLOWED_FETCH_PROTOCOLS_BG = new Set(['http:', 'https:']);
const MIN_FETCH_TIMEOUT = 1000;
const MAX_FETCH_TIMEOUT = 120000;

function isTrustedSender(sender) {
    try {
        if (!sender || sender.id !== chrome.runtime.id) return false;
        // 扩展页面 / service worker 自身的消息带 url；外部消息不会有合法的扩展 origin
        if (typeof sender.url === 'string' && sender.url) {
            return sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
        }
        return true;
    } catch {
        return false;
    }
}

// 后台只代理 http(s) 资源：图标/壁纸/接口全部落在此范围，
// 阻止 file:、data:、chrome-extension: 等协议被当作远程资源请求
function normalizeFetchTarget(value) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        if (!ALLOWED_FETCH_PROTOCOLS_BG.has(url.protocol) || !url.hostname) return null;
        return url.toString();
    } catch {
        return null;
    }
}

function clampTimeout(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return fallback;
    return Math.min(MAX_FETCH_TIMEOUT, Math.max(MIN_FETCH_TIMEOUT, Math.round(num)));
}

// favicon 维护互斥队列：索引更新与容量清理都是"读取-修改-写回"的复合操作，
// 并发执行会互相覆盖（两个并发 addToFaviconIndex 从同一索引出发，最终只留一个键）。
// MV3 Service Worker 内以 Promise 链串行化所有维护操作
let faviconMaintenanceChain = Promise.resolve();
function enqueueFaviconMaintenance(task) {
    const run = faviconMaintenanceChain.then(task, task);
    faviconMaintenanceChain = run.then(() => {}, () => {});
    return run;
}

async function addToFaviconIndex(key) {
    return enqueueFaviconMaintenance(async () => {
        try {
            const res = await chrome.storage.local.get(FAVICON_INDEX_KEY);
            const keys = Array.isArray(res[FAVICON_INDEX_KEY]) ? res[FAVICON_INDEX_KEY] : [];
            if (!keys.includes(key)) {
                keys.push(key);
                await chrome.storage.local.set({ [FAVICON_INDEX_KEY]: keys });
            }
        } catch {}
    });
}
const MAX_FAVICON_CACHE_ENTRIES = 80; // 与 script.js 的 MAX_EXPORTED_FAVICONS 保持一致
// 自定义图标 URL 固化的下载大小上限：base64 膨胀约 4/3，需保证转换后的
// data URL 字符数不超过 script.js 的 MAX_ICON_DATA_URL_CHARS（750KB）
const MAX_ICON_BLOB_BYTES = 512 * 1024;
const ALLOWED_PAGE_PROTOCOLS = new Set(['http:', 'https:']);

function normalizePageUrl(value) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        if (!ALLOWED_PAGE_PROTOCOLS.has(url.protocol) || !url.hostname) return null;
        return url.toString();
    } catch {
        return null;
    }
}

function getDomainUrl(value) {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}/`;
}

// 后台 in-flight 去重：并发请求相同资源（如多个新标签页同时抓取必应壁纸/同一图标）
// 共享同一次 fetch，避免重复下载与重复缓存写入
const inflightFetches = new Map();
function dedupeInflight(key, factory) {
    if (inflightFetches.has(key)) {
        return inflightFetches.get(key);
    }
    const promise = factory().finally(() => inflightFetches.delete(key));
    inflightFetches.set(key, promise);
    return promise;
}

/* --------------------------------------------------------------------------
 * 快捷方式修改的串行化执行（多标签页数据一致性）
 * chrome.storage 无原子 CAS，两个页面各自"读-改-写回"整个数组时，并发修改会
 * 互相覆盖（最后写入者获胜）。所有修改以 op 描述符路由到这里，在单一
 * Promise 链内逐个执行，每次都基于最新存储内容应用，写回带版本号递增。
 * -------------------------------------------------------------------------- */
const SHORTCUTS_KEY_BG = 'shortcuts';
const SHORTCUTS_VERSION_KEY_BG = '_shortcutsVersion';
const ALLOWED_PAGE_PROTOCOLS_BG = new Set(['http:', 'https:']);
let shortcutOpSeq = 0;

function bgNormalizePageUrl(value) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        if (!ALLOWED_PAGE_PROTOCOLS_BG.has(url.protocol) || !url.hostname) return null;
        return url.toString();
    } catch {
        return null;
    }
}

function bgIsValidIcon(value) {
    if (typeof value !== 'string' || !value) return false;
    if (/^data:image\/(?:png|jpeg|jpg|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,/i.test(value)) return true;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'chrome-extension:';
    } catch {
        return false;
    }
}

// 宽松清洗：字段非法时丢弃该字段（图标）或报错（名称/网址），不静默造出坏条目
function bgSanitizeFields(fields) {
    const out = {};
    if (!fields || typeof fields !== 'object') return out;
    if (fields.name !== undefined) {
        const name = typeof fields.name === 'string' ? fields.name.trim().slice(0, 80) : '';
        if (!name) throw new Error('快捷方式名称无效');
        out.name = name;
    }
    if (fields.url !== undefined) {
        const url = bgNormalizePageUrl(fields.url);
        if (!url) throw new Error('快捷方式网址无效');
        out.url = url;
    }
    if (fields.icon !== undefined) {
        if (fields.icon === null || fields.icon === '') {
            out.icon = null; // 显式清除
        } else if (bgIsValidIcon(fields.icon)) {
            out.icon = fields.icon;
        } else {
            throw new Error('快捷方式图标无效');
        }
    }
    return out;
}

function bgStorageGet(keys) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, (res) => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error('数据读取失败：' + err.message));
            else resolve(res);
        });
    });
}

function bgStorageSet(obj) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(obj, () => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error('数据写入失败：' + err.message));
            else resolve();
        });
    });
}

let shortcutOpChain = Promise.resolve();

async function applyShortcutOp(op) {
    const [rawRes, verRes] = await Promise.all([
        bgStorageGet(SHORTCUTS_KEY_BG),
        bgStorageGet(SHORTCUTS_VERSION_KEY_BG),
    ]);
    let list = [];
    try {
        const parsed = JSON.parse(rawRes[SHORTCUTS_KEY_BG] || '[]');
        if (Array.isArray(parsed)) list = parsed.filter(s => s && typeof s === 'object');
    } catch {}
    const version = Number(verRes[SHORTCUTS_VERSION_KEY_BG]) || 0;
    let changed = true;

    switch (op && op.type) {
        case 'add': {
            if (list.length >= MAX_SHORTCUTS_BG) {
                throw new Error(`快捷方式数量已达上限（${MAX_SHORTCUTS_BG} 个）`);
            }
            const fields = bgSanitizeFields(op.item);
            if (!fields.name || !fields.url) throw new Error('快捷方式名称或网址无效');
            const id = (typeof op.item.id === 'string' && op.item.id && op.item.id.length <= 64)
                ? op.item.id
                : `bg-${Date.now().toString(36)}-${++shortcutOpSeq}`;
            if (list.some(s => s.id === id)) throw new Error('快捷方式 ID 重复');
            const item = { id, name: fields.name, url: fields.url };
            if (fields.icon) item.icon = fields.icon;
            list.push(item);
            break;
        }
        case 'update': {
            const index = list.findIndex(s => s.id === op.id);
            if (index === -1) throw new Error('被编辑的快捷方式已被删除或已在其他标签页修改');
            const fields = bgSanitizeFields(op.fields);
            if (!fields.name || !fields.url) throw new Error('快捷方式名称或网址无效');
            const updated = Object.assign({}, list[index], { name: fields.name, url: fields.url, id: op.id });
            if (fields.icon) updated.icon = fields.icon;
            else delete updated.icon; // 未提供图标字段 = 清除图标
            list[index] = updated;
            break;
        }
        case 'remove': {
            const before = list.length;
            list = list.filter(s => s.id !== op.id);
            changed = list.length !== before;
            break;
        }
        case 'reorder': {
            const ids = Array.isArray(op.ids) ? op.ids.filter(id => typeof id === 'string') : [];
            const byId = new Map(list.map(s => [s.id, s]));
            const next = ids.map(id => byId.get(id)).filter(Boolean);
            const idSet = new Set(next.map(s => s.id));
            for (const s of list) if (!idSet.has(s.id)) next.push(s);
            changed = !(next.length === list.length && next.every((s, i) => s === list[i]));
            list = next;
            break;
        }
        case 'setIcon': {
            const item = list.find(s => s.id === op.id);
            // 图标仍是最初发起下载时的 URL 才写回：固化期间的编辑/删除不会错写
            if (!item || item.icon !== op.expectUrl) {
                changed = false;
                break;
            }
            if (!bgIsValidIcon(op.iconUrl)) throw new Error('图标数据无效');
            item.icon = op.iconUrl;
            break;
        }
        default:
            throw new Error('未知的快捷方式操作类型');
    }

    const json = JSON.stringify(list);
    if (!changed) {
        // changed=false：存储内容与返回值一致，未发生写入，也不会触发
        // storage.onChanged。调用方据此决定不登记"回声"，避免回声集合累积
        return { list, json, changed: false };
    }
    await bgStorageSet({ [SHORTCUTS_KEY_BG]: json, [SHORTCUTS_VERSION_KEY_BG]: version + 1 });
    return { list, json, changed: true };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 纵深防御：仅接受本扩展页面/自身发出的消息
    if (!isTrustedSender(sender)) {
        console.warn('[BG] 已忽略来源不可信的消息:', request && request.action);
        return false;
    }
    if (!request || typeof request.action !== 'string') return false;

    if (request.action === 'performSearch') {
        if (typeof request.text !== 'string' || !request.text.trim()) {
            return false;
        }

        try {
            chrome.search.query({
                text: request.text.trim(),
                disposition: 'CURRENT_TAB'
            });
        } catch (e) {
            console.error("Search failed:", e);
        }
        return false;
    }

    if (request.action === 'getBestFavicon') {
        const pageUrl = normalizePageUrl(request.url);
        if (!pageUrl) {
            sendResponse({ dataUrl: null });
            return false;
        }
        dedupeInflight(`favicon:${pageUrl}:${!!request.forceRefresh}`, () =>
            handleGetBestFavicon(pageUrl, request.forceRefresh))
            .then(sendResponse)
            .catch(() => {
                sendResponse({ dataUrl: null });
            });
        return true;
    }

    if (request.action === 'fetchWallpaper') {
        const target = normalizeFetchTarget(request.url);
        if (!target) {
            sendResponse({ success: false, error: '不支持的资源地址' });
            return false;
        }
        const timeout = clampTimeout(request.timeoutMs, 60000);
        dedupeInflight(`wallpaper:${target}:${timeout}`, () =>
            handleFetchWallpaper(target, timeout))
            .then((result) => {
                sendResponse(result);
            })
            .catch((error) => {
                console.error('[BG] fetchWallpaper 失败:', error);
                sendResponse({ success: false, error: error.message || 'fetch failed' });
            });
        return true;
    }

    if (request.action === 'fetchJson') {
        const target = normalizeFetchTarget(request.url);
        if (!target) {
            sendResponse({ success: false, error: '不支持的接口地址' });
            return false;
        }
        const timeout = clampTimeout(request.timeoutMs, 30000);
        dedupeInflight(`json:${target}:${timeout}`, () =>
            handleFetchJson(target, timeout))
            .then((data) => {
                sendResponse({ success: true, data });
            })
            .catch((error) => {
                console.error('[BG] fetchJson 失败:', error);
                sendResponse({ success: false, error: error.message || 'fetch failed' });
            });
        return true;
    }

    if (request.action === 'fetchIcon') {
        const target = normalizeFetchTarget(request.url);
        if (!target) {
            sendResponse({ success: false, error: '不支持的图标地址' });
            return false;
        }
        const timeout = clampTimeout(request.timeoutMs, 15000);
        dedupeInflight(`icon:${target}:${timeout}`, () =>
            handleFetchIcon(target, timeout))
            .then((result) => {
                sendResponse(result);
            })
            .catch((error) => {
                console.error('[BG] fetchIcon 失败:', error);
                sendResponse({ success: false, error: error.message || '图标下载失败' });
            });
        return true;
    }

    if (request.action === 'shortcutOp') {
        // 快捷方式修改统一入口：所有页面/所有修改在单一 Promise 链内串行执行
        // "读最新列表 → 应用 → 写回"，消除多标签页整数组写回的相互覆盖
        const run = shortcutOpChain.then(() => applyShortcutOp(request.op));
        shortcutOpChain = run.then(() => {}, () => {});
        run.then(({ list, json, changed }) => {
            sendResponse({ success: true, shortcuts: list, shortcutsJson: json, changed: changed !== false });
        }).catch((error) => {
            sendResponse({ success: false, error: error.message || '快捷方式保存失败' });
        });
        return true;
    }
});

// 有界读取响应体：超过 maxBytes 立即中止，防止超大远程文件耗尽 Service Worker 内存
async function readBodyWithCap(response, maxBytes) {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error('远程资源过大');
    }

    if (!response.body) {
        const blob = await response.blob();
        if (blob.size > maxBytes) throw new Error('远程资源过大');
        return blob;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
            try { await reader.cancel(); } catch {}
            throw new Error('远程资源过大');
        }
        chunks.push(value);
    }
    return new Blob(chunks, { type: response.headers.get('content-type') || '' });
}

async function handleFetchWallpaper(url, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await readBodyWithCap(response, MAX_REMOTE_IMAGE_BYTES);
        if (blob.type && blob.type !== 'application/octet-stream' && !blob.type.startsWith('image/')) {
            throw new Error('远程资源不是图片');
        }
        const dataUrl = await blobToDataUrl(blob);
        return { success: true, dataUrl };
    } finally {
        clearTimeout(timeoutId);
    }
}

async function handleFetchJson(url, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            redirect: 'follow'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await readBodyWithCap(response, MAX_JSON_BYTES);
        const text = await blob.text();
        // 尝试解析为 JSON；若失败则返回原始文本（可能是 XML），由调用端处理
        try {
            return { type: 'json', data: JSON.parse(text) };
        } catch (err) {
            return { type: 'text', data: text };
        }
    } finally {
        clearTimeout(timeoutId);
    }
}

// 下载远程自定义图标并转为 data URL：图标只应下载一次，之后以 data URL 形态
// 永久存入 shortcuts，避免每次打开新标签页都重新请求远程资源
async function handleFetchIcon(url, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await readBodyWithCap(response, MAX_ICON_BLOB_BYTES);
        if (blob.size < 50) throw new Error('远程资源过小，无法用作图标');
        if (blob.type && blob.type !== 'application/octet-stream' && !blob.type.startsWith('image/')) {
            throw new Error('远程资源不是图片');
        }
        const dataUrl = await blobToDataUrl(blob);
        return { success: true, dataUrl };
    } finally {
        clearTimeout(timeoutId);
    }
}

async function handleGetBestFavicon(pageUrl, forceRefresh) {
    const normalizedUrl = normalizePageUrl(pageUrl);
    if (!normalizedUrl) {
        return { dataUrl: null };
    }

    let domain;
    try {
        domain = new URL(normalizedUrl).hostname;
    } catch {
        return { dataUrl: null };
    }

    if (!domain) {
        return { dataUrl: null };
    }

    const cacheKey = `favicon_${domain}`;

    if (!forceRefresh) {
        try {
            const cached = await chrome.storage.local.get(cacheKey);
            const entry = cached[cacheKey];
            if (entry) {
                if (entry.dataUrl) {
                    if (Date.now() - entry.timestamp < CACHE_TTL) {
                        return { dataUrl: entry.dataUrl, fromCache: true };
                    }
                } else if (entry.failedAt && Date.now() - entry.failedAt < FAILED_FAVICON_TTL) {
                    // 负缓存：近期获取失败的域名在 TTL 内直接返回，
                    // 避免每次渲染都对死域名并发请求全部图标源
                    return { dataUrl: null };
                }
            }
        } catch {}
    }

    const results = await fetchAllSources(normalizedUrl);

    let bestResult = null;
    let bestScore = -1;

    for (const result of results) {
        if (!result.success) continue;
        const score = assessQuality(result.width, result.height, result.blobSize, result.sourcePriority);
        if (score > bestScore) {
            bestScore = score;
            bestResult = result;
        }
    }

    if (!bestResult || bestScore < 0) {
        try {
            await chrome.storage.local.set({ [cacheKey]: { failedAt: Date.now() } });
            // 负缓存同样占用缓存容量：与成功路径一样纳入清理（否则大量失败域名
            // 会无限累积，且绕过 80 条容量上限）
            await pruneFaviconCache();
        } catch {}
        return { dataUrl: null };
    }

    const dataUrl = await blobToDataUrl(bestResult.blob);

    try {
        await chrome.storage.local.set({
            [cacheKey]: {
                dataUrl,
                score: bestScore,
                source: bestResult.sourceName,
                timestamp: Date.now(),
                width: bestResult.width,
                height: bestResult.height
            }
        });
        await addToFaviconIndex(cacheKey);
        await pruneFaviconCache();
    } catch {}

    return { dataUrl, fromCache: false };
}

async function fetchAllSources(pageUrl) {
    const promises = FAVICON_SOURCES.map(async (source) => {
        // 超时须覆盖响应头 + 响应体下载全过程（此前 finally 只包住 fetch 阶段，
        // 慢速响应体的 blob() 下载不受 SOURCE_TIMEOUT 约束）
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SOURCE_TIMEOUT);
        try {
            const url = source.getUrl(pageUrl);
            const response = await fetch(url, {
                signal: controller.signal,
                redirect: 'follow'
            });

            if (!response.ok) return { success: false };

            const blob = await readBodyWithCap(response, MAX_FAVICON_BLOB_BYTES);
            if (blob.size < 50) return { success: false };

            let dims;
            try {
                dims = await getImageDimensions(blob);
            } catch {
                return { success: false };
            }

            return {
                success: true,
                blob,
                blobSize: blob.size,
                sourceName: source.name,
                sourcePriority: source.priority,
                width: dims.width,
                height: dims.height
            };
        } catch {
            return { success: false };
        } finally {
            clearTimeout(timeoutId);
        }
    });

    const settled = await Promise.allSettled(promises);
    return settled
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value)
        .filter(r => r.success);
}

// 简单的频率限制：缓存写入计数与时间双触发，避免每次写都 get(null) 把数 MB 的 customBg 也读进 SW。
// 计数状态持久化到 storage——MV3 Service Worker 会被频繁回收，纯内存计数每次唤醒都归零，
// 会导致 prune 几乎在每次写入时都执行全量读取
const PRUNE_STATE_KEY = '_pruneState';
const PRUNE_WRITE_THRESHOLD = 5;
const PRUNE_TIME_THRESHOLD = 10 * 60 * 1000; // 10 分钟

// 与索引更新共用互斥队列：清理会重写整个键索引，与并发 addToFaviconIndex
// 交错执行会丢失刚加入的键
async function pruneFaviconCache(force = false) {
    return enqueueFaviconMaintenance(() => pruneFaviconCacheInner(force));
}

async function pruneFaviconCacheInner(force = false) {
    let state = { count: 0, lastPruneTime: 0 };
    try {
        const saved = await chrome.storage.local.get(PRUNE_STATE_KEY);
        if (saved[PRUNE_STATE_KEY] && typeof saved[PRUNE_STATE_KEY] === 'object') {
            state = saved[PRUNE_STATE_KEY];
        }
    } catch {}

    const now = Date.now();
    const shouldPrune = force ||
        Number(state.count || 0) >= PRUNE_WRITE_THRESHOLD ||
        now - Number(state.lastPruneTime || 0) >= PRUNE_TIME_THRESHOLD;

    if (!shouldPrune) {
        try {
            await chrome.storage.local.set({
                [PRUNE_STATE_KEY]: { count: Number(state.count || 0) + 1, lastPruneTime: Number(state.lastPruneTime || 0) }
            });
        } catch {}
        return;
    }

    const items = await chrome.storage.local.get(null);
    const faviconEntries = Object.entries(items)
        .filter(([key, value]) => key.startsWith('favicon_') && value && typeof value === 'object')
        // 负缓存条目（获取失败，仅 failedAt）没有 timestamp：以 failedAt 作为
        // 排序回退，避免刚写入的负缓存被当作最旧条目优先淘汰
        .sort((a, b) => Number(b[1].timestamp || b[1].failedAt || 0) - Number(a[1].timestamp || a[1].failedAt || 0));

    if (faviconEntries.length > MAX_FAVICON_CACHE_ENTRIES) {
        const keysToRemove = faviconEntries
            .slice(MAX_FAVICON_CACHE_ENTRIES)
            .map(([key]) => key);
        if (keysToRemove.length > 0) {
            await chrome.storage.local.remove(keysToRemove);
        }
        // 同步键索引：仅收录带 dataUrl 的条目（负缓存不可导出，无需入索引）
        try {
            await chrome.storage.local.set({
                [FAVICON_INDEX_KEY]: faviconEntries
                    .slice(0, MAX_FAVICON_CACHE_ENTRIES)
                    .filter(([, value]) => value.dataUrl)
                    .map(([key]) => key)
            });
        } catch {}
    }

    try {
        await chrome.storage.local.set({ [PRUNE_STATE_KEY]: { count: 0, lastPruneTime: now } });
    } catch {}
}

async function getImageDimensions(blob) {
    const bitmap = await createImageBitmap(blob);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dims;
}

function assessQuality(width, height, blobSize, sourcePriority) {
    if (width <= 1 || height <= 1) return -1;
    if (blobSize < 100) return -1;

    const minDim = Math.min(width, height);
    if (minDim < 16) return -1;

    let score = 0;

    if (minDim >= 256) score += 60;
    else if (minDim >= 128) score += 45;
    else if (minDim >= 64) score += 30;
    else if (minDim >= 32) score += 15;
    else score += 5;

    score += sourcePriority * 4;

    return score;
}

async function blobToDataUrl(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const chunkSize = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
    }
    const base64 = btoa(binary);
    const mimeType = blob.type || 'image/png';
    return `data:${mimeType};base64,${base64}`;
}
