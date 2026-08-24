/* ============================================================================
   iOS 26 Liquid Glass —— 物理折射玻璃滤镜引擎（CSS + SVG 方案）
   实现方法参考 kube.io 博文《Liquid Glass in the Browser》：
   https://kube.io/blog/liquid-glass-css-svg/

   渲染管线（对应博文各章节）：
   1. 表面轮廓函数 Surface Function：f(t)∈[0,1] 描述玻璃截面高度，
      支持 凸方圆/凸圆/凹面/凸缘(lip) 四种剖面；
   2. 折射剖面 Refraction Profile：入射光垂直向下，法线由 f 的导数
      旋转 -90° 得到，按 Snell–Descartes 定律求折射方向，沿剩余玻璃
      厚度累积水平位移，得到 127 个采样（对齐位移图 8bit 分辨率）；
   3. 归一化位移场：以最大位移归一化向量 → Canvas 生成位移图
      （R=X、G=Y、128 为中性值），maximumDisplacement 直接用作
      feDisplacementMap 的 scale 还原真实像素位移；
   4. 镜面高光 Specular Highlight：边缘环上按「表面法线 · 固定光源」
      点积生成 rim light 贴图，经 feComposite/feBlend 叠加在折射结果上。

   参数支持用户自定义：通过 chrome.storage.local 持久化（key 见
   SETTINGS_KEY），经 applySettings() 运行时热更新；滤镜按
   「宽x高x圆角x参数」分组缓存（LRU），同尺寸组件共用一个滤镜节点。
   最终滤镜以内联 backdrop-filter: url(#id) 应用（仅 Chromium 支持 SVG
   滤镜作 backdrop-filter；本扩展目标平台为 Chrome）。
   ========================================================================= */
(function () {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const SAMPLES = 127;          // 博文约束：与位移图 8bit 径向分辨率匹配的采样数
    const SETTINGS_KEY = 'liquidGlassParams';

    /* ------------------------------------------------------------------
     * 表面轮廓函数 Surface Functions（博文 §Creating the Glass Surface）
     * 输入 t∈[0,1]：0 为玻璃外缘，1 为斜面终点（进入平坦区）。
     * 当前版本固定采用 squircle（Apple favored）；其余剖面保留供引擎扩展。
     * ------------------------------------------------------------------ */
    const smootherstep = (x) => 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3;

    const PROFILES = {
        // 凸方圆（Apple favored）：平坦区过渡柔和，拉伸为矩形时无生硬内缘
        squircle: (x) => Math.pow(1 - Math.pow(1 - x, 4), 0.25),
        // 凸圆弧：球面穹顶，折射边缘更锐利
        circle: (x) => Math.sqrt(1 - (1 - x) * (1 - x)),
        // 凹面：光向外发散（会把背景拉出边界，慎用）
        concave: (x) => 1 - PROFILES.circle(x),
        // 凸缘 lip：博文原始定义 mix(Convex, Concave, Smootherstep)
        // ——外圈隆起、中部浅凹
        lip: (x) => {
            const convex = PROFILES.circle(x);
            const t = smootherstep(x);
            return convex * (1 - t) + (1 - convex) * t;
        },
    };

    /* ------------------------------------------------------------------
     * 可调参数：默认值、合法区间与当前生效值。
     * 表面轮廓固定为 squircle，不再作为用户可调项；
     * （specAngle 为固定光源方向，同样不开放给用户）
     * ------------------------------------------------------------------ */
    const DEFAULTS = {
        thickness: 30,           // 玻璃厚度（等效像素）
        bezel: 10,               // 斜面宽度
        ior: 1.45,               // 折射率 n2（环境为空气 n1=1）
        refractionLevel: 0.7,    // 效果缩放（乘于 maximumDisplacement）
        blurIn: 0.3,             // 滤镜内对背景的预模糊
        saturate: 1.4,           // 折射区饱和度增益（1 = 关闭）
        specOpacity: 0.3,        // 边缘高光强度
        specAngle: Math.PI / 3,  // 光源方向（弧度）
        backdropBlur: 1.4,       // 叠加在折射之下的基础背景模糊
    };

    const NUM_RANGES = {
        thickness: [8, 80],
        bezel: [3, 24],
        ior: [1, 2.5],
        refractionLevel: [0, 1.5],
        blurIn: [0, 3],
        saturate: [1, 3],
        specOpacity: [0, 1],
        backdropBlur: [0, 6],
    };

    /** 合并并校验用户参数；非法/越界值回退默认（profile 已固定，忽略旧存值） */
    function sanitizeSettings(raw) {
        const out = Object.assign({}, DEFAULTS);
        if (!raw || typeof raw !== 'object') return out;
        for (const key of Object.keys(NUM_RANGES)) {
            if (raw[key] === undefined) continue;
            const num = Number(raw[key]);
            const [min, max] = NUM_RANGES[key];
            if (Number.isFinite(num)) out[key] = Math.min(max, Math.max(min, num));
        }
        return out;
    }

    // 当前生效参数（init 时从 storage 加载，applySettings 热更新）
    let params = Object.assign({}, DEFAULTS);

    /* --- 应用目标 ---
     * 对话框与调参面板统一使用固定强模糊的玻璃材质（blurIn/backdropBlur
     * 覆写），刻意不随用户「背景模糊」滑杆联动；其余参数正常跟随用户设置。
     * 面板/对话框底色为半透明 scrim（无白底），文字极性由页面解析主题驱动 */
    const DIALOG_BLUR_OVERRIDE = { blurIn: 5, backdropBlur: 18 };
    const TOAST_BLUR_OVERRIDE = { blurIn: 4, backdropBlur: 16 };
    const TARGETS = [
        { selector: '.search-capsule' },
        { selector: '.shortcut-item' },
        { selector: '.add-btn' },
        { selector: '.settings-btn' },
        { selector: '#glass-dialog', override: DIALOG_BLUR_OVERRIDE },
        { selector: '#settings-dialog', override: DIALOG_BLUR_OVERRIDE },
        { selector: '#edit-dialog', override: DIALOG_BLUR_OVERRIDE },
    ];

    let defsHost = null;
    let seq = 0;
    /** @type {Map<string, string>} 缓存键 -> filter id（插入序即 LRU 序） */
    const cache = new Map();
    const CACHE_MAX = 24;

    /* ==================================================================
     * §Refraction —— Snell–Descartes 折射
     * 法线 = 表面函数导数旋转 -90°；入射光恒为竖直向下 (0, -1)。
     * 返回单位折射向量；全反射（k<0）时返回 null。
     * ================================================================== */
    function refractRay(normalX, normalY, ior) {
        const eta = 1 / ior;
        const cosI = -normalY;                       // N·I，I=(0,-1)
        const k = 1 - eta * eta * (1 - cosI * cosI);
        if (k < 0) return null;                      // Total Internal Reflection
        const sq = Math.sqrt(k);
        return {
            x: -(eta * cosI + sq) * normalX,
            y: eta - (eta * cosI + sq) * normalY,
        };
    }

    /**
     * 预计算折射剖面（博文 §Pre-calculating the displacement magnitude）：
     * 位移幅值关于斜面对称，只需沿单侧半径采样一次，再环绕旋转到整个边环。
     * profile[i] = 距外缘第 i 个采样处的水平位移量（像素，未归一化）。
     */
    function calculateRefractionProfile(cfg) {
        const { thickness, bezel, ior } = cfg;
        const heightFn = PROFILES.squircle;          // 固定轮廓（见 PROFILES 注释）
        const step = 1 / (SAMPLES - 1);
        const delta = step / 16;                     // 导数差分步长
        const profile = new Float64Array(SAMPLES);
        for (let i = 0; i < SAMPLES; i++) {
            // 采样点与差分区间一律收拢在 [0,1] 内：
            // 轮廓函数在越界处（如 squircle 的负数四次方根）会得到 NaN，
            // 一旦混入 profile 将令 maximumDisplacement 变 NaN、整条滤镜链静默失效
            const t = i * step;
            const lo = Math.max(0, t - delta);
            const hi = Math.min(1, t + delta);
            const y = heightFn(t);                   // 该处玻璃表面高度
            // 中心差分近似导数 → 旋转 -90° 得法线并归一化
            const deriv = (heightFn(hi) - heightFn(lo)) / Math.max(hi - lo, 1e-6);
            if (!Number.isFinite(y) || !Number.isFinite(deriv)) { profile[i] = 0; continue; }
            const mag = Math.hypot(deriv, 1);
            const nx = -deriv / mag;
            const ny = 1 / mag;
            const ray = refractRay(nx, ny, ior);
            if (!ray || !(ray.y > 0) || !Number.isFinite(ray.x)) { profile[i] = 0; continue; }
            // 水平位移 = 折射水平分量 × 光线在玻璃内继续行进的深度
            profile[i] = ray.x * ((y * bezel + thickness) / ray.y);
        }
        return profile;
    }

    /* ==================================================================
     * §SVG Displacement Map —— 位移向量场 → RGBA 图像
     * 极坐标(法线角, 幅值)转笛卡尔：r = 128 + x*127、g = 128 + y*127，
     * b/a 忽略。外侧 1px 做透明度衰减抗锯齿。
     * ================================================================== */
    function generateDisplacementMap(w, h, r, bezelWidth, profile, maxDisp) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(w, h);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
            d[i] = 128; d[i + 1] = 128; d[i + 2] = 128; d[i + 3] = 255; // 中性值
        }

        const rSq = r * r;
        const r1Sq = (r + 1) ** 2;
        const rBSq = Math.max(r - bezelWidth, 0) ** 2;
        const wB = w - r * 2;
        const hB = h - r * 2;
        const S = profile.length;

        for (let y1 = 0; y1 < h; y1++) {
            for (let x1 = 0; x1 < w; x1++) {
                // 圆角坐标系：把像素映射到最近圆角局部坐标
                const x = x1 < r ? x1 - r : x1 >= w - r ? x1 - r - wB : 0;
                const y = y1 < r ? y1 - r : y1 >= h - r ? y1 - r - hB : 0;
                const dSq = x * x + y * y;
                if (dSq > r1Sq || dSq < rBSq) continue; // 只处理斜面圆环
                const dist = Math.sqrt(dSq);
                const fromSide = r - dist;              // 距外缘距离
                const op = dSq < rSq ? 1 : 1 - (dist - Math.sqrt(rSq)) / (Math.sqrt(r1Sq) - Math.sqrt(rSq));
                if (op <= 0 || dist === 0) continue;
                const cosA = x / dist;                  // 外法线方向
                const sinA = y / dist;
                const bi = Math.min(((fromSide / bezelWidth) * S) | 0, S - 1);
                const disp = profile[bi] || 0;
                // 位移指向内部（凸面把光线向内弯），除以 maxDisp 归一化
                const dX = (-cosA * disp) / maxDisp;
                const dY = (-sinA * disp) / maxDisp;
                const idx = (y1 * w + x1) * 4;
                d[idx] = (128 + dX * 127 * op + 0.5) | 0;
                d[idx + 1] = (128 + dY * 127 * op + 0.5) | 0;
            }
        }
        ctx.putImageData(img, 0, 0);
        return c.toDataURL();
    }

    /* ==================================================================
     * §Specular Highlight —— 镜面高光（rim light）
     * 强度 = |法线角·光源角|² × 外缘集中的平方衰减，白色 + 自 alpha。
     * 高光贴在边线上、向内快速消失——宽环或线性衰减会在深色背景上
     * 晕成一片“内发光”，故收窄加陡。
     * ================================================================== */
    function generateSpecularMap(w, h, r, bezelWidth, angle) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(w, h);
        const d = img.data;

        const rSq = r * r;
        const r1Sq = (r + 1) ** 2;
        const rBSq = Math.max(r - bezelWidth, 0) ** 2;
        const wB = w - r * 2;
        const hB = h - r * 2;
        const sv = [Math.cos(angle), Math.sin(angle)];

        for (let y1 = 0; y1 < h; y1++) {
            for (let x1 = 0; x1 < w; x1++) {
                const x = x1 < r ? x1 - r : x1 >= w - r ? x1 - r - wB : 0;
                const y = y1 < r ? y1 - r : y1 >= h - r ? y1 - r - hB : 0;
                const dSq = x * x + y * y;
                if (dSq > r1Sq || dSq < rBSq) continue;
                const dist = Math.sqrt(dSq);
                const fromSide = r - dist;
                const op = dSq < rSq ? 1 : 1 - (dist - Math.sqrt(rSq)) / (Math.sqrt(r1Sq) - Math.sqrt(rSq));
                if (op <= 0 || dist === 0) continue;
                const cosA = x / dist;
                const sinA = -y / dist;
                const dot = Math.abs(cosA * sv[0] + sinA * sv[1]);
                const tt = Math.min(fromSide / bezelWidth, 1);
                const falloff = (1 - tt) * (1 - tt);
                const coeff = dot * dot * falloff;
                const col = (255 * coeff) | 0;
                const alpha = (col * coeff * op) | 0;
                const idx = (y1 * w + x1) * 4;
                d[idx] = col;
                d[idx + 1] = col;
                d[idx + 2] = col;
                d[idx + 3] = alpha;
            }
        }
        ctx.putImageData(img, 0, 0);
        return c.toDataURL();
    }

    /* ==================================================================
     * §Combining —— 组合滤镜并缓存
     * blur → feImage/feDisplacementMap(scale=maxDisp×refractionLevel)
     * → saturate → 高光合成。LRU 缓存避免重复生成 Canvas 贴图。
     * ================================================================== */
    function el(name, attrs) {
        const node = document.createElementNS(SVG_NS, name);
        for (const k in attrs) node.setAttribute(k, attrs[k]);
        return node;
    }

    function cfgKey(cfg) {
        return `${cfg.thickness}|${cfg.bezel}|${cfg.ior}|${cfg.refractionLevel}` +
               `|${cfg.blurIn}|${cfg.saturate}|${cfg.specOpacity}|${cfg.specAngle}`;
    }

    function ensureFilter(w, h, radius, cfg) {
        const r = Math.min(radius, w / 2 - 1, h / 2 - 1);
        if (!(r >= 2)) return null;
        const bezelW = Math.max(1, Math.min(cfg.bezel, r - 1, Math.min(w, h) / 2 - 1));

        const key = `${w}x${h}x${r.toFixed(1)}x${bezelW.toFixed(1)}#${cfgKey(cfg)}`;
        const hit = cache.get(key);
        if (hit) {
            cache.delete(key);
            cache.set(key, hit); // LRU 触碰
            return hit;
        }

        const profile = calculateRefractionProfile(cfg);
        let maxDisp = 0;
        for (const v of profile) {
            if (Number.isFinite(v)) maxDisp = Math.max(maxDisp, Math.abs(v));
        }
        if (!Number.isFinite(maxDisp) || !(maxDisp > 0)) return null;

        // maximumDisplacement 直接作为 scale，将归一化位移还原为真实像素
        const scale = maxDisp * cfg.refractionLevel;
        const dispUrl = generateDisplacementMap(w, h, r, bezelW, profile, maxDisp);
        // 高光带宽与斜面等宽：过宽的光环会在深色背景上形成“内发光”晕
        const specUrl = generateSpecularMap(w, h, r, bezelW, cfg.specAngle);

        const id = `lg-f-${++seq}`;
        const filter = el('filter', {
            id,
            x: '0%', y: '0%', width: '100%', height: '100%',
            'color-interpolation-filters': 'sRGB',
        });

        let src = 'SourceGraphic';
        if (cfg.blurIn > 0) {
            filter.appendChild(el('feGaussianBlur', {
                in: 'SourceGraphic', stdDeviation: cfg.blurIn, result: 'blurred_source',
            }));
            src = 'blurred_source';
        }

        filter.appendChild(el('feImage', {
            href: dispUrl, x: 0, y: 0, width: w, height: h, result: 'displacement_map',
        }));
        filter.appendChild(el('feDisplacementMap', {
            in: src, in2: 'displacement_map', scale,
            xChannelSelector: 'R', yChannelSelector: 'G', result: 'displaced',
        }));

        // 边缘区域提升饱和度（模拟厚玻璃边缘的色散感），1 = 恒等跳过
        let satSrc = 'displaced';
        if (cfg.saturate && cfg.saturate !== 1) {
            filter.appendChild(el('feColorMatrix', {
                in: 'displaced', type: 'saturate', values: cfg.saturate, result: 'displaced_sat',
            }));
            satSrc = 'displaced_sat';
        }

        filter.appendChild(el('feImage', {
            href: specUrl, x: 0, y: 0, width: w, height: h, result: 'spec_layer',
        }));
        filter.appendChild(el('feComposite', {
            in: satSrc, in2: 'spec_layer', operator: 'in', result: 'spec_masked',
        }));
        const transfer = el('feComponentTransfer', { in: 'spec_layer', result: 'spec_faded' });
        transfer.appendChild(el('feFuncA', { type: 'linear', slope: cfg.specOpacity }));
        filter.appendChild(transfer);
        filter.appendChild(el('feBlend', {
            in: 'spec_masked', in2: 'displaced', mode: 'normal', result: 'with_sat',
        }));
        filter.appendChild(el('feBlend', {
            in: 'spec_faded', in2: 'with_sat', mode: 'normal',
        }));

        defsHost.appendChild(filter);
        cache.set(key, id);

        // 超出缓存上限时淘汰最旧分组并移除对应节点
        if (cache.size > CACHE_MAX) {
            const oldestKey = cache.keys().next().value;
            const oldestId = cache.get(oldestKey);
            cache.delete(oldestKey);
            const node = document.getElementById(oldestId);
            if (node) node.remove();
        }
        return id;
    }

    function applyToElement(node, cfg) {
        const w = node.offsetWidth;
        const h = node.offsetHeight;
        if (w < 8 || h < 8) return;
        let radius = parseFloat(getComputedStyle(node).borderTopLeftRadius);
        if (!Number.isFinite(radius)) radius = cfg.bezel * 2;
        const id = ensureFilter(w, h, radius, cfg);
        if (!id) return;
        // -webkit 声明保留纯模糊作为回退；标准声明叠加动态折射滤镜
        node.style.webkitBackdropFilter = `blur(${cfg.backdropBlur}px)`;
        node.style.backdropFilter = `blur(${cfg.backdropBlur}px) url(#${id})`;
    }

    /**
     * 可见性判定：不能依赖 offsetParent——进入 top layer 的模态对话框、
     * position:fixed 元素该值都可能为 null；改用自身计算样式的
     * display/visibility 判断（目标组件均为顶层元素，无需回溯父链）
     */
    function isVisible(node) {
        if (!node.isConnected) return false;
        const cs = getComputedStyle(node);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
    }

    function refresh() {
        if (!defsHost) return;
        for (const { selector, override } of TARGETS) {
            const merged = override ? Object.assign({}, params, override) : params;
            document.querySelectorAll(selector).forEach((node) => {
                if (!isVisible(node)) return;
                try { applyToElement(node, merged); } catch (e) { console.debug('[liquid-glass] 应用失败:', selector, e); }
            });
        }
    }

    function scheduleRefresh() {
        // 双 rAF：确保布局与样式稳定后再测量元素尺寸
        requestAnimationFrame(() => requestAnimationFrame(() => {
            try { refresh(); } catch (e) { console.debug('[liquid-glass] 刷新失败', e); }
        }));
    }

    function ensureHost() {
        if (defsHost) return;
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('width', '0');
        svg.setAttribute('height', '0');
        svg.style.position = 'absolute';
        svg.setAttribute('aria-hidden', 'true');
        defsHost = document.createElementNS(SVG_NS, 'defs');
        svg.appendChild(defsHost);
        document.body.appendChild(svg);
    }

    /* ------------------------------------------------------------------
     * 用户设置：持久化加载 + 运行时热更新
     * ------------------------------------------------------------------ */
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });

    function loadPersistedSettings() {
        const fallback = () => {
            params = sanitizeSettings(null);
            resolveReady();
            scheduleRefresh();
        };
        try {
            chrome.storage.local.get(SETTINGS_KEY, (res) => {
                if (chrome.runtime.lastError) {
                    console.debug('[liquid-glass] 读取设置失败:', chrome.runtime.lastError);
                    fallback();
                    return;
                }
                params = sanitizeSettings(res && res[SETTINGS_KEY]);
                resolveReady();
                scheduleRefresh();
            });
        } catch (e) {
            console.debug('[liquid-glass] 读取设置异常:', e);
            fallback();
        }
    }

    function init() {
        try {
            ensureHost();
            loadPersistedSettings();
        } catch (e) {
            console.debug('[liquid-glass] 初始化失败', e);
            try { resolveReady(); } catch {}
        }
    }

    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(scheduleRefresh, 150);
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // 供 script.js 使用：
    // - refresh：布局变化 / 磁贴重渲染后重新挂接滤镜
    // - ready：持久化参数加载完成的 Promise（UI 初始化前 await）
    // - getSettings/getDefaults/applySettings：读取与热更新参数
    // - applyTo：对动态创建的元素（如 toast）即时应用统一玻璃材质
    window.LiquidGlass = {
        ready,
        refresh: scheduleRefresh,
        getSettings() { return Object.assign({}, params); },
        getDefaults() {
            const out = Object.assign({}, DEFAULTS);
            delete out.specAngle;
            return out;
        },
        applySettings(raw) {
            params = sanitizeSettings(raw);
            scheduleRefresh();
            return this.getSettings();
        },
        applyTo(node, override = TOAST_BLUR_OVERRIDE) {
            try {
                ensureHost();
                // 覆写为引擎内部常量（如对话框的强模糊），刻意绕过面向用户的
                // sanitize 区间钳制——否则 blurIn>3/backdropBlur>6 会被压平
                const merged = Object.assign({}, params, override || {});
                for (const k of Object.keys(NUM_RANGES)) {
                    if (!Number.isFinite(merged[k])) merged[k] = DEFAULTS[k];
                }
                applyToElement(node, merged);
            } catch (e) {
                console.debug('[liquid-glass] applyTo 失败', e);
            }
        },
    };
})();
