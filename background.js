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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
        handleGetBestFavicon(request.url, request.forceRefresh)
            .then(sendResponse)
            .catch(() => {
                sendResponse({ dataUrl: null });
            });
        return true;
    }

    if (request.action === 'fetchWallpaper') {
        handleFetchWallpaper(request.url, request.timeoutMs || 60000)
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
        handleFetchJson(request.url, request.timeoutMs || 30000)
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
        handleFetchIcon(request.url, request.timeoutMs || 15000)
            .then((result) => {
                sendResponse(result);
            })
            .catch((error) => {
                console.error('[BG] fetchIcon 失败:', error);
                sendResponse({ success: false, error: error.message || '图标下载失败' });
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

async function pruneFaviconCache(force = false) {
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
        .sort((a, b) => Number(b[1].timestamp || 0) - Number(a[1].timestamp || 0));

    if (faviconEntries.length > MAX_FAVICON_CACHE_ENTRIES) {
        const keysToRemove = faviconEntries
            .slice(MAX_FAVICON_CACHE_ENTRIES)
            .map(([key]) => key);
        if (keysToRemove.length > 0) {
            await chrome.storage.local.remove(keysToRemove);
        }
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
