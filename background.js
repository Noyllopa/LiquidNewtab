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

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const SOURCE_TIMEOUT = 3000;
const MAX_FAVICON_BLOB_BYTES = 128 * 1024;
const MAX_FAVICON_CACHE_ENTRIES = 80;
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
                sendResponse({ dataUrl: null, useChromeApi: true });
            });
        return true;
    }

    if (request.action === 'fetchWallpaper') {
        console.log('[BG] fetchWallpaper 收到请求:', request.url);
        handleFetchWallpaper(request.url, request.timeoutMs || 60000)
            .then((result) => {
                console.log('[BG] fetchWallpaper 成功, dataUrl 长度:', result.dataUrl ? result.dataUrl.length : 0);
                sendResponse(result);
            })
            .catch((error) => {
                console.error('[BG] fetchWallpaper 失败:', error);
                sendResponse({ success: false, error: error.message || 'fetch failed' });
            });
        return true;
    }

    if (request.action === 'fetchJson') {
        console.log('[BG] fetchJson 收到请求:', request.url);
        handleFetchJson(request.url, request.timeoutMs || 30000)
            .then((data) => {
                console.log('[BG] fetchJson 成功, type:', data.type);
                sendResponse({ success: true, data });
            })
            .catch((error) => {
                console.error('[BG] fetchJson 失败:', error);
                sendResponse({ success: false, error: error.message || 'fetch failed' });
            });
        return true;
    }
});

async function handleFetchWallpaper(url, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
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
        const text = await response.text();
        // 尝试解析为 JSON；若失败则返回原始文本（可能是 XML），由调用端处理
        try {
            return { type: 'json', data: JSON.parse(text) };
        } catch {
            return { type: 'text', data: text };
        }
    } finally {
        clearTimeout(timeoutId);
    }
}

async function handleGetBestFavicon(pageUrl, forceRefresh) {
    const normalizedUrl = normalizePageUrl(pageUrl);
    if (!normalizedUrl) {
        return { dataUrl: null, useChromeApi: true };
    }

    let domain;
    try {
        domain = new URL(normalizedUrl).hostname;
    } catch {
        return { dataUrl: null, useChromeApi: true };
    }

    if (!domain) {
        return { dataUrl: null, useChromeApi: true };
    }

    const cacheKey = `favicon_${domain}`;

    if (!forceRefresh) {
        try {
            const cached = await chrome.storage.local.get(cacheKey);
            if (cached[cacheKey] && cached[cacheKey].dataUrl) {
                const entry = cached[cacheKey];
                if (Date.now() - entry.timestamp < CACHE_TTL) {
                    return { dataUrl: entry.dataUrl, fromCache: true };
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
        return { dataUrl: null, useChromeApi: true };
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
        prunePendingWrites++;
        await pruneFaviconCache();
    } catch {}

    return { dataUrl, fromCache: false };
}

async function fetchAllSources(pageUrl) {
    const promises = FAVICON_SOURCES.map(async (source) => {
        try {
            const url = source.getUrl(pageUrl);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), SOURCE_TIMEOUT);

            let response;
            try {
                response = await fetch(url, {
                    signal: controller.signal,
                    redirect: 'follow'
                });
            } finally {
                clearTimeout(timeoutId);
            }

            if (!response.ok) return { success: false };

            const blob = await response.blob();
            if (blob.size < 50 || blob.size > MAX_FAVICON_BLOB_BYTES) return { success: false };

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
        }
    });

    const settled = await Promise.allSettled(promises);
    return settled
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value)
        .filter(r => r.success);
}

// 简单的频率限制：缓存写入计数与时间双触发，避免每次写都 get(null) 把数 MB 的 customBg 也读进 SW
let prunePendingWrites = 0;
let lastPruneTime = 0;
const PRUNE_WRITE_THRESHOLD = 5;
const PRUNE_TIME_THRESHOLD = 10 * 60 * 1000; // 10 分钟

async function pruneFaviconCache(force = false) {
    const now = Date.now();
    if (!force) {
        if (prunePendingWrites < PRUNE_WRITE_THRESHOLD &&
            now - lastPruneTime < PRUNE_TIME_THRESHOLD) {
            return;
        }
    }
    prunePendingWrites = 0;
    lastPruneTime = now;

    const items = await chrome.storage.local.get(null);
    const faviconEntries = Object.entries(items)
        .filter(([key, value]) => key.startsWith('favicon_') && value && typeof value === 'object')
        .sort((a, b) => Number(b[1].timestamp || 0) - Number(a[1].timestamp || 0));

    if (faviconEntries.length <= MAX_FAVICON_CACHE_ENTRIES) return;

    const keysToRemove = faviconEntries
        .slice(MAX_FAVICON_CACHE_ENTRIES)
        .map(([key]) => key);

    if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove);
    }
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
