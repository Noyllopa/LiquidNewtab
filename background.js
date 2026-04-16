const FAVICON_SOURCES = [
    {
        name: 'googleV2',
        priority: 5,
        getUrl: (url) => {
            const params = new URLSearchParams({
                client: 'SOCIAL',
                type: 'FAVICON',
                fallback_opts: 'TYPE,SIZE,URL',
                url: url,
                size: '256'
            });
            return `https://t1.gstatic.com/faviconV2?${params}`;
        }
    },
    {
        name: 'duckduckgo',
        priority: 4,
        getUrl: (url) => {
            const domain = new URL(url).hostname;
            return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
        }
    },
    {
        name: 'googleS2',
        priority: 2,
        getUrl: (url) => {
            const domain = new URL(url).hostname;
            return `https://www.google.com/s2/favicons?domain=${domain}&sz=256`;
        }
    },
    {
        name: 'iconHorse',
        priority: 1,
        getUrl: (url) => {
            const domain = new URL(url).hostname;
            return `https://icon.horse/icon/${domain}`;
        }
    }
];

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const SOURCE_TIMEOUT = 3000;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'performSearch') {
        try {
            chrome.search.query({
                text: request.text,
                disposition: 'CURRENT_TAB'
            });
        } catch (e) {
            console.error("Search failed:", e);
        }
        return true;
    }

    if (request.action === 'getBestFavicon') {
        handleGetBestFavicon(request.url, request.forceRefresh)
            .then(sendResponse)
            .catch(() => {
                sendResponse({ dataUrl: null, useChromeApi: true });
            });
        return true;
    }
});

async function handleGetBestFavicon(pageUrl, forceRefresh) {
    let domain;
    try {
        domain = new URL(pageUrl).hostname;
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

    const results = await fetchAllSources(pageUrl);

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
    } catch {}

    return { dataUrl, fromCache: false };
}

async function fetchAllSources(pageUrl) {
    const promises = FAVICON_SOURCES.map(async (source) => {
        try {
            const url = source.getUrl(pageUrl);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), SOURCE_TIMEOUT);

            const response = await fetch(url, {
                signal: controller.signal,
                redirect: 'follow'
            });
            clearTimeout(timeoutId);

            if (!response.ok) return { success: false };

            const blob = await response.blob();
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
        }
    });

    const settled = await Promise.allSettled(promises);
    return settled
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value)
        .filter(r => r.success);
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
