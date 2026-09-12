'use strict';
/* ============================================================================
 * Liquid Newtab 修复验证脚本（对应 2026-09-11 代码审查 R01–R11 / S01 / S06）
 *
 * 审查报告中的 audit-checks.cjs 断言"缺陷存在"；本脚本在修复后断言"预期正确
 * 行为"。真实 script.js 载入两个 VM 沙箱（模拟两个新标签页），真实
 * background.js 载入第三个沙箱（模拟 Service Worker），三者共享同一
 * chrome.storage 后端；shortcutOp 等消息路由到真实 background 执行，
 * storage.onChanged 按真实语义派发给所有页面。
 *
 * 运行：node output/audit-checks.cjs
 * 按函数名/行为驱动，不依赖源码行号；源码重构后仅需保持对外行为即可。
 * ========================================================================= */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let SCRIPT_SRC = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const BACKGROUND_SRC = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

// DBG 模式：向 script.js 注入同步跟踪点，定位初始化卡点
if (process.argv.includes('--dbg')) {
    const injections = [
        ['try { localStorage.setItem(\'_colorMode\', savedColorMode); localStorage.setItem(\'_bgMode\', savedBgMode); } catch(e) {}',
         'self.__trace("A0:handler-PromiseAll-settled"); try { localStorage.setItem(\'_colorMode\', savedColorMode); localStorage.setItem(\'_bgMode\', savedBgMode); } catch(e) {}'],
        ['resolve(res[key] ?? defaultVal);', 'self.__trace("get-resolve:" + key); resolve(res[key] ?? defaultVal);'],
        ['await applyColorMode(savedColorMode);', 'self.__trace("A0b:before-597"); await applyColorMode(savedColorMode); self.__trace("A:after-init-applyColorMode");'],
        ['const requestToken = ++themeRequestToken;', 'const requestToken = ++themeRequestToken; self.__trace("A1:applyColorMode-enter");'],
        ['if (requestToken !== themeRequestToken) return;', 'self.__trace("A2:applyColorMode-before-commit"); if (requestToken !== themeRequestToken) return;'],
        ['return updateTextColorClasses(theme);', 'self.__trace("A3:commit-enter"); const __r = updateTextColorClasses(theme); self.__trace("A4:commit-utc-called"); return __r;'],
        ['syncDialogTheme();', 'syncDialogTheme(); self.__trace("A5:utc-after-syncDialog");'],
        ['const [rawCols, rawSize, rawScale] = await Promise.all', 'self.__trace("B:before-gridCols"); const [rawCols, rawSize, rawScale] = await Promise.all'],
        ['applyLayoutSettings(savedCols, savedSize, savedScale);', 'applyLayoutSettings(savedCols, savedSize, savedScale); self.__trace("C:after-layout");'],
        ['await renderShortcuts();', 'self.__trace("D:before-early-render"); await renderShortcuts(); self.__trace("E:after-early-render");'],
        ['await loadBgSettings();', 'self.__trace("F:before-loadBg"); await loadBgSettings(); self.__trace("G:after-loadBg");'],
    ];
    for (const [from, to] of injections) {
        if (!SCRIPT_SRC.includes(from)) { fs.writeSync(2, '[dbg] inject miss: ' + from.slice(0, 40) + '\n'); continue; }
        SCRIPT_SRC = SCRIPT_SRC.replace(from, to);
    }
}

/* ---------------------------------------------------------------- results */
const results = [];
let currentTest = '';
const DBG = process.argv.includes('--dbg');
function dbg(...a) {
    if (!DBG) return;
    try {
        fs.writeSync(1, '[dbg] ' + a.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ') + '\n');
    } catch {}
}
function check(desc, cond, detail) {
    results.push({ test: currentTest, desc, ok: !!cond, detail: cond ? '' : String(detail) });
}
function section(name) { currentTest = name; console.log('\n== ' + name); }

/* ------------------------------------------------------------ async utils */
async function settle(rounds = 10) {
    for (let i = 0; i < rounds; i++) {
        await new Promise(r => setImmediate(r));
        await new Promise(r => setTimeout(r, 0));
    }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function makeDeferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/* -------------------------------------------------------- storage backend */
function createBackend() {
    const data = new Map();
    let failWrites = 0;      // 接下来 N 次 set/remove 注入失败
    const listenerLists = []; // 每个上下文（页面/后台）的 onChanged 监听器列表

    function normalizeKeys(keys) {
        if (keys === null || keys === undefined) return Array.from(data.keys());
        if (Array.isArray(keys)) return keys;
        if (typeof keys === 'object') return Object.keys(keys);
        return [keys];
    }

    // done(err)：chrome 包装层把 err 翻译成 chrome.runtime.lastError
    function safeRun(tag, fn) {
        try { fn(); } catch (e) {
            try { fs.writeSync(2, '[' + tag + ' callback error] ' + (e && e.stack ? e.stack : String(e)) + '\n'); } catch {}
        }
    }
    const area = {
        get(keys, done) {
            const ks = normalizeKeys(keys);
            const out = {};
            for (const k of ks) if (data.has(k)) out[k] = data.get(k);
            queueMicrotask(() => safeRun('area.get ' + JSON.stringify(ks), () => done(null, out)));
        },
        set(obj, done) {
            queueMicrotask(() => safeRun('area.set ' + JSON.stringify(Object.keys(obj)), () => {
                let err = null;
                if (failWrites > 0) { failWrites--; err = { message: 'simulated quota failure' }; }
                let changes = null;
                if (!err) {
                    changes = {};
                    for (const k of Object.keys(obj)) {
                        changes[k] = { oldValue: data.has(k) ? data.get(k) : undefined, newValue: obj[k] };
                        data.set(k, obj[k]);
                    }
                }
                done(err);
                if (changes) dispatch(changes);
            }));
        },
        remove(keys, done) {
            const ks = normalizeKeys(keys);
            queueMicrotask(() => safeRun('area.remove ' + JSON.stringify(ks), () => {
                let err = null;
                if (failWrites > 0) { failWrites--; err = { message: 'simulated quota failure' }; }
                let changes = null;
                if (!err) {
                    changes = {};
                    for (const k of ks) {
                        if (data.has(k)) { changes[k] = { oldValue: data.get(k), newValue: undefined }; data.delete(k); }
                    }
                }
                done(err);
                if (changes) dispatch(changes);
            }));
        },
    };

    function dispatch(changes) {
        for (const list of listenerLists) {
            for (const fn of list.slice()) {
                try { fn(changes, 'local'); } catch (e) { console.error('[onChanged handler]', e); }
            }
        }
    }

    return {
        area, data, listenerLists,
        set failWritesNext(n) { failWrites = n; },
        getShortcuts() {
            const raw = data.get('shortcuts');
            return raw == null ? null : JSON.parse(raw);
        },
        dump() { return Object.fromEntries(data); },
    };
}

/* --------------------------------------------------------- element stubs */
class ClassList {
    constructor(el) { this._set = new Set(); this._el = el; }
    add(...cs) { cs.forEach(c => c && this._set.add(c)); }
    remove(...cs) { cs.forEach(c => this._set.delete(c)); }
    contains(c) { return this._set.has(c); }
    toggle(c, force) {
        const has = this._set.has(c);
        const target = force === undefined ? !has : !!force;
        if (target) this._set.add(c); else this._set.delete(c);
        return target;
    }
    toString() { return Array.from(this._set).join(' '); }
}

let elSeq = 0;
class El {
    constructor(tag, id) {
        this.nodeType = 1;
        this.tagName = String(tag || 'div').toUpperCase();
        this.id = id || '';
        this._uid = ++elSeq;
        this.children = [];
        this.parentNode = null;
        this._listeners = new Map();
        this._attrs = {};
        this.dataset = {};
        this.classList = new ClassList(this);
        this.style = { setProperty() {}, removeProperty() {} };
        this.value = '';
        this.innerText = '';
        this.textContent = '';
        this.disabled = false;
        this.hidden = false;
        this.offsetWidth = 120;
        this.offsetHeight = 120;
        this._html = '';
    }
    get className() { return this.classList.toString(); }
    set className(v) {
        this.classList._set.clear();
        String(v || '').split(/\s+/).forEach(c => c && this.classList.add(c));
    }
    get innerHTML() { return this._html; }
    set innerHTML(v) {
        this._html = v;
        for (const c of this.children) c.parentNode = null;
        this.children = [];
    }
    get firstChild() { return this.children[0] || null; }
    get isConnected() {
        let n = this;
        while (n.parentNode) n = n.parentNode;
        return !!(n && n._isRoot);
    }
    appendChild(child) {
        if (child && child._isFragment) {
            for (const c of child.children.slice()) this.appendChild(c);
            child.children = [];
            return child;
        }
        if (child.parentNode) child.parentNode._detach(child);
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    insertBefore(node, ref) {
        if (node.parentNode) node.parentNode._detach(node);
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i === -1) { node.parentNode = this; this.children.push(node); }
        else { node.parentNode = this; this.children.splice(i, 0, node); }
        return node;
    }
    _detach(child) {
        const i = this.children.indexOf(child);
        if (i !== -1) this.children.splice(i, 1);
    }
    remove() { if (this.parentNode) this.parentNode._detach(this); this.parentNode = null; }
    contains(n) {
        let cur = n;
        while (cur) { if (cur === this) return true; cur = cur.parentNode; }
        return false;
    }
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
    removeAttribute(k) { delete this._attrs[k]; }
    addEventListener(t, fn) { if (!this._listeners.has(t)) this._listeners.set(t, []); this._listeners.get(t).push(fn); }
    removeEventListener(t, fn) {
        const arr = this._listeners.get(t);
        if (arr) { const i = arr.indexOf(fn); if (i !== -1) arr.splice(i, 1); }
    }
    async _fire(type, ev) {
        ev = ev || {};
        if (!ev.preventDefault) ev.preventDefault = () => {};
        if (!ev.stopPropagation) ev.stopPropagation = () => {};
        if (!ev.target) ev.target = this;
        const arr = (this._listeners.get(type) || []).slice();
        for (const fn of arr) await fn(ev);
    }
    focus() {}
    click() {}
    scrollIntoView() {}
    cloneNode() {
        const c = new El(this.tagName);
        c.className = this.className;
        Object.assign(c.dataset, this.dataset);
        Object.assign(c._attrs, this._attrs);
        for (const ch of this.children) c.appendChild(ch);
        return c;
    }
    // 简易选择器：tag / .class / #id / [attr] / [attr="v"]（单个简单选择器）
    _matchesSimple(sel) {
        let rest = String(sel);
        const tag = rest.match(/^[a-zA-Z][\w-]*/);
        if (tag) {
            if (this.tagName !== tag[0].toUpperCase()) return false;
            rest = rest.slice(tag[0].length);
        }
        let m;
        while ((m = rest.match(/^([.#][-\w]+)|^\[([-\w]+)(?:="([^"]*)")?\]/))) {
            if (m[1]) {
                if (m[1][0] === '.') {
                    if (!this.classList.contains(m[1].slice(1))) return false;
                } else if (this.id !== m[1].slice(1)) {
                    return false;
                }
            } else {
                const v = this._attrs[m[2]];
                if (v === undefined) return false;
                if (m[3] !== undefined && v !== m[3]) return false;
            }
            rest = rest.slice(m[0].length);
        }
        return rest.length === 0;
    }
    _queryAll(sel, out) {
        const parts = String(sel).trim().split(/\s+/);
        for (const child of this.children) {
            if (child._matchesSimple(parts[0])) {
                if (parts.length === 1) out.push(child);
                else child._queryAll(parts.slice(1).join(' '), out);
            }
            child._queryAll(sel, out);
        }
        return out;
    }
    querySelectorAll(sel) { return this._queryAll(sel, []); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function makeDialogBehavior(el) {
    el._openState = null;
    el.showModal = function () { this._openState = 'modal'; };
    el.show = function () { this._openState = 'nonmodal'; };
    el.close = async function () {
        if (this._openState === null) return;
        this._openState = null;
        await this._fire('close');
    };
    return el;
}

/* --------------------------------------------------------- document stub */
function createDocument(makeCanvas) {
    const registry = new Map();
    const docListeners = new Map();
    const body = new El('body');
    body._isRoot = true;
    const docEl = new El('html');
    docEl.classList.add('theme-dark'); // theme-init.js 默认（auto + 系统深色）

    const doc = {
        readyState: 'complete',
        visibilityState: 'visible',
        body,
        documentElement: docEl,
        getElementById(id) {
            if (!registry.has(id)) {
                const el = new El('div', id);
                if (['edit-dialog', 'settings-dialog', 'glass-dialog'].includes(id)) makeDialogBehavior(el);
                registry.set(id, el);
            }
            return registry.get(id);
        },
        createElement(tag) {
            if (String(tag).toLowerCase() === 'canvas') return makeCanvas();
            return new El(tag);
        },
        createDocumentFragment() {
            const f = new El('#fragment');
            f._isFragment = true;
            return f;
        },
        addEventListener(t, fn) { if (!docListeners.has(t)) docListeners.set(t, []); docListeners.get(t).push(fn); },
        removeEventListener(t, fn) {
            const arr = docListeners.get(t);
            if (arr) { const i = arr.indexOf(fn); if (i !== -1) arr.splice(i, 1); }
        },
        querySelector(sel) { return doc.querySelectorAll(sel)[0] || null; },
        querySelectorAll(sel) {
            if (sel === 'dialog:modal') return [];
            const out = [];
            body._queryAll(sel, out);
            docEl._queryAll(sel, out);
            for (const el of registry.values()) if (el._matchesSimple(sel)) out.push(el);
            return out;
        },
        async fireDOMContentLoaded() {
            const arr = (docListeners.get('DOMContentLoaded') || []).slice();
            for (const fn of arr) await fn({});
        },
    };
    doc._bodyEl = body;
    doc._registry = registry;
    return doc;
}

/* ------------------------------------------------------ canvas/ls stubs */
function createLocalStorageStub() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        clear: () => m.clear(),
    };
}

function makeCanvasFactory(state) {
    return function makeCanvas() {
        return {
            width: 0, height: 0,
            getContext() {
                return {
                    drawImage() {},
                    getImageData(x, y, w, h) {
                        const d = new Uint8ClampedArray(w * h * 4);
                        for (let i = 0; i < d.length; i += 4) {
                            d[i] = state.brightness; d[i + 1] = state.brightness; d[i + 2] = state.brightness; d[i + 3] = 255;
                        }
                        return { data: d, width: w, height: h };
                    },
                    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; },
                    putImageData() {},
                    fillStyle: '', beginPath() {}, arc() {}, fill() {}, fillText() {},
                    font: '', textAlign: '', textBaseline: '',
                };
            },
            toDataURL(type) {
                if (type === 'image/jpeg') return 'data:image/jpeg;base64,JPEGDATA';
                if (type === 'image/png') return 'data:image/png;base64,PNGDATA';
                return 'data:image/webp;base64,WEBPDATA';
            },
        };
    };
}

/* ------------------------------------------------------ chrome storage stubs
 * 同时支持 MV3 的两种调用风格：回调式 get(keys, cb) 与 Promise 式 await get(keys)。
 * background.js 大量使用 Promise 风格，页面 script.js 使用回调风格。
 * ------------------------------------------------------------------------- */
function makeStorageLocal(backend, chromeRef) {
    function wrap(fn) {
        return function (keys, cb) {
            if (typeof cb === 'function') {
                fn(keys, (err) => { chromeRef.runtime.lastError = err; cb(); chromeRef.runtime.lastError = null; });
                return undefined;
            }
            return new Promise((resolve, reject) => {
                fn(keys, (err) => {
                    chromeRef.runtime.lastError = err;
                    if (err) reject(new Error(err.message || 'storage error'));
                    else resolve();
                    chromeRef.runtime.lastError = null;
                });
            });
        };
    }
    const local = {
        get(keys, cb) {
            dbg('storage.get', Array.isArray(keys) ? keys.join(',') : keys, typeof cb);
            if (typeof cb === 'function') {
                backend.area.get(keys, (err, out) => { chromeRef.runtime.lastError = err; cb(out); chromeRef.runtime.lastError = null; });
                return undefined;
            }
            return new Promise((resolve, reject) => {
                backend.area.get(keys, (err, out) => {
                    chromeRef.runtime.lastError = err;
                    if (err) reject(new Error(err.message || 'storage error'));
                    else resolve(out);
                    chromeRef.runtime.lastError = null;
                });
            });
        },
    };
    local.set = wrap(backend.area.set);
    local.remove = wrap(backend.area.remove);
    const origSet = local.set;
    local.set = function (obj, cb) { dbg('storage.set', Object.keys(obj).join(','), typeof cb); return origSet(obj, cb); };
    const origRemove = local.remove;
    local.remove = function (keys, cb) { dbg('storage.remove', String(keys), typeof cb); return origRemove(keys, cb); };
    return local;
}

/* -------------------------------------------------------- background VM */
function createBackground(backend) {
    const listeners = [];
    backend.listenerLists.push([]);
    const onMessageListeners = [];

    const chromeStub = {
        runtime: {
            lastError: null,
            getURL: (p) => 'chrome-extension://testext' + (p || '/'),
            onMessage: { addListener(fn) { onMessageListeners.push(fn); } },
            sendMessage: async () => ({}),
        },
        storage: {
            local: null, // 见下方赋值（需引用 chromeStub 自身以处理 lastError）
            onChanged: { addListener(fn) { backend.listenerLists[backend.listenerLists.length - 1].push(fn); } },
        },
        search: { query() {} },
    };
    chromeStub.storage.local = makeStorageLocal(backend, chromeStub);

    const sandbox = {
        chrome: chromeStub,
        fetch: async () => { throw new Error('network down (simulated)'); },
        createImageBitmap: async () => { throw new Error('no bitmap (simulated)'); },
        btoa, Blob, URL, URLSearchParams,
        console: { error() {}, warn() {}, debug() {}, log() {} },
        setTimeout, clearTimeout,
        performance: { now: () => Date.now() },
        crypto, AbortController, DOMException,
    };
    const ctx = vm.createContext(sandbox, { name: 'bg' });
    vm.runInContext(BACKGROUND_SRC, ctx, { filename: 'background.js' });

    // 以真实 onMessage 监听器路径投递消息（返回 sendResponse 的 Promise）
    function sendMessage(msg) {
        dbg('bg.sendMessage', msg && msg.action, msg && msg.op ? JSON.stringify(msg.op).slice(0, 100) : '');
        return new Promise((resolve, reject) => {
            let answered = false;
            const sendResponse = (resp) => {
                answered = true;
                dbg('bg.response', msg && msg.action, resp && resp.success, resp && resp.error ? resp.error : '');
                resolve(resp);
            };
            const keepOpen = onMessageListeners[0](msg, {}, sendResponse);
            if (!keepOpen && !answered) reject(new Error('listener did not respond: ' + (msg && msg.action)));
        });
    }
    return { ctx, sendMessage, onMessageListeners };
}

/* ------------------------------------------------------------ page (tab) */
function createTab(backend, bg, opts = {}) {
    const ownListeners = [];
    backend.listenerLists.push(ownListeners);
    const canvasState = { brightness: 128 };
    const doc = createDocument(makeCanvasFactory(canvasState));
    const imageQueue = [];
    const sentMessages = [];
    const confirmCalls = [];
    const state = { confirmResult: true };
    const ls = opts.localStorage || createLocalStorageStub();

    class FakeImage {
        constructor() { this._src = ''; imageQueue.push(this); this._done = false; }
        set src(v) { this._src = v; }
        get src() { return this._src; }
        _load() { this._done = true; if (this.onload) this.onload(); }
        _error() { this._done = true; if (this.onerror) this.onerror(); }
    }

    class FakeFileReader {
        readAsDataURL(file) {
            this.result = file._dataUrl || 'data:image/png;base64,AAAA';
            if (this.onload) this.onload({ target: this });
        }
        readAsText(file) {
            this.result = file._text;
            if (this.onload) this.onload({ target: this });
        }
    }

    function defaultRespond(msg) {
        switch (msg && msg.action) {
            case 'getBestFavicon': return { dataUrl: 'data:image/png;base64,FAVICON' };
            case 'fetchIcon': return { success: true, dataUrl: 'data:image/png;base64,ICON' };
            case 'performSearch': return {};
            case 'fetchJson': return { success: true, data: { type: 'json', data: { images: [{ urlbase: '/th?id=OHR.Test_ZH-CN123456' }] } } };
            case 'fetchWallpaper': return { success: true, dataUrl: 'data:image/jpeg;base64,' + 'B'.repeat(2000) };
            default: return {};
        }
    }

    async function respond(msg) {
        dbg('tab msg →', msg && msg.action, msg && msg.op ? JSON.stringify(msg.op).slice(0, 80) : '');
        // shortcutOp 路由到真实 background（串行化修改的核心路径）
        if (msg && msg.action === 'shortcutOp' && bg) {
            return bg.sendMessage(msg);
        }
        if (opts.respond) return opts.respond(msg, sentMessages);
        return defaultRespond(msg);
    }

    const chromeStub = {
        runtime: {
            lastError: null,
            getURL: (p) => 'chrome-extension://testext' + (p || '/'),
            sendMessage(msg) {
                sentMessages.push(msg);
                return respond(msg);
            },
        },
        storage: {
            local: null, // 见下方赋值
            onChanged: { addListener(fn) { ownListeners.push(fn); } },
        },
        search: { query() {} },
    };
    chromeStub.storage.local = makeStorageLocal(backend, chromeStub);

    const sandbox = {
        console,
        chrome: chromeStub,
        document: doc,
        window: {
            addEventListener() {}, removeEventListener() {},
            dispatchEvent() {},
            matchMedia(q) {
                const fn = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
                if (q.includes('prefers-reduced-motion')) return { matches: true, addEventListener() {}, removeEventListener() {} };
                if (q.includes('prefers-color-scheme')) return { matches: !!opts.prefersLight, addEventListener() {}, removeEventListener() {} };
                return fn();
            },
            innerWidth: 1600,
            innerHeight: 900,
            confirm: (msg) => { confirmCalls.push(String(msg)); return state.confirmResult; },
        },
        localStorage: ls,
        getComputedStyle: () => ({ backgroundImage: 'none', borderTopLeftRadius: '16px', display: 'block', visibility: 'visible' }),
        requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
        Image: FakeImage,
        FileReader: FakeFileReader,
        URL, URLSearchParams,
        performance: { now: () => Date.now() },
        crypto,
        AbortController, DOMException, Blob,
        CustomEvent: class { constructor(type) { this.type = type; } },
        setTimeout, clearTimeout,
    };
    sandbox.self = sandbox.window;
    sandbox.globalThis = sandbox;
    sandbox.self.__trace = (tag) => dbg('trace', tag, opts.name);

    const ctx = vm.createContext(sandbox, { name: opts.name || 'tab' });
    vm.runInContext(SCRIPT_SRC, ctx, { filename: 'script.js' });

    return {
        ctx, doc, ls, imageQueue, sentMessages, confirmCalls, state, canvasState,
        async init() { await doc.fireDOMContentLoaded(); await settle(); },
        async importFile(obj, sizeOverride) {
            const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
            const input = doc.getElementById('import-data-input');
            const file = { _text: text, size: sizeOverride !== undefined ? sizeOverride : Buffer.byteLength(text), name: 'backup.json' };
            input.files = [file];
            await input._fire('change', { target: input });
        },
        async addShortcut(name, url, icon) {
            doc.getElementById('add-shortcut-btn')._fire('click');
            doc.getElementById('shortcut-name').value = name;
            doc.getElementById('shortcut-url').value = url;
            if (icon !== undefined) doc.getElementById('shortcut-icon').value = icon;
            await doc.getElementById('edit-form')._fire('submit', { preventDefault() {} });
            await settle();
        },
        gridChildren() {
            return doc.getElementById('shortcuts-grid').children.filter(c => c.classList.contains('shortcut-item'));
        },
    };
}

/* -------------------------------------------------------- default fixtures */
function seedStorage(backend, shortcuts, extra = {}) {
    backend.data.set('shortcuts', JSON.stringify(shortcuts));
    for (const [k, v] of Object.entries(extra)) backend.data.set(k, v);
}
const FIXTURE = [
    { id: 'id-a', name: 'A', url: 'https://a.com/' },
    { id: 'id-b', name: 'B', url: 'https://b.com/' },
];

function attachSharedUI(tab) {
    const group = new El('div');
    group.className = 'color-mode-buttons';
    for (const mode of ['auto', 'light', 'dark']) {
        const btn = new El('button');
        btn.dataset.mode = mode;
        if (mode === 'auto') { btn.className = 'glass-btn active'; btn.setAttribute('aria-checked', 'true'); }
        else btn.className = 'glass-btn';
        group.appendChild(btn);
    }
    tab.doc._bodyEl.appendChild(group);
    // 网格挂到 body：让磁贴 isConnected 语义成立
    tab.doc._bodyEl.appendChild(tab.doc.getElementById('shortcuts-grid'));
}

const unhandled = [];
process.on('unhandledRejection', (err) => unhandled.push(err));
process.on('uncaughtException', (err) => unhandled.push(err));

/* =========================================================== T01 R01 */
async function testR01() {
    section('T01 · R01 拖拽排序后右键删除命中所点条目');
    const backend = createBackend();
    const bg = createBackground(backend);
    seedStorage(backend, FIXTURE);
    const tab = createTab(backend, bg, { name: 't01' });
    attachSharedUI(tab);
    await tab.init();

    const [aEl, bEl] = tab.gridChildren();
    check('初始渲染两个磁贴', aEl && bEl && tab.gridChildren().length === 2, JSON.stringify(tab.gridChildren().map(c => c.dataset.id)));

    // 拖 A 到 B 之后：DOM 顺序变为 [B, A]
    await aEl._fire('dragstart', { dataTransfer: { setData() {}, setDragImage() {} } });
    await bEl._fire('dragenter', {});
    await aEl._fire('dragend');
    await settle();

    const afterDrag = backend.getShortcuts().map(s => s.name);
    check('拖拽后存储顺序为 [B, A]', JSON.stringify(afterDrag) === JSON.stringify(['B', 'A']), JSON.stringify(afterDrag));
    check('拖拽后 DOM 顺序为 [B, A]', JSON.stringify(tab.gridChildren().map(c => c.dataset.id)) === JSON.stringify(['id-b', 'id-a']), JSON.stringify(tab.gridChildren().map(c => c.dataset.id)));

    // 右键点击磁贴 A（当前位于第 2 位）并删除 → 应删除 A、留下 B
    await aEl._fire('contextmenu', { clientX: 10, clientY: 10 });
    const menuDelete = tab.doc.getElementById('menu-delete');
    await menuDelete._fire('click');
    await settle();

    const afterDelete = backend.getShortcuts().map(s => s.name);
    check('删除的是被右键的 A（留下 B）', JSON.stringify(afterDelete) === JSON.stringify(['B']), JSON.stringify(afterDelete));

    // 右键编辑同样按 ID 定位
    const bEl2 = tab.gridChildren()[0];
    await bEl2._fire('contextmenu', { clientX: 10, clientY: 10 });
    await tab.doc.getElementById('menu-edit')._fire('click');
    check('编辑框载入的是 B 的名称', tab.doc.getElementById('shortcut-name').value === 'B', tab.doc.getElementById('shortcut-name').value);
    await tab.doc.getElementById('edit-dialog').close();
}

/* =========================================================== T02 R02 */
async function testR02() {
    section('T02 · R02 双标签页修改经后台串行化，互不覆盖');
    const backend = createBackend();
    const bg = createBackground(backend);
    seedStorage(backend, FIXTURE);
    const tabA = createTab(backend, bg, { name: 't02-a' });
    const tabB = createTab(backend, bg, { name: 't02-b' });
    attachSharedUI(tabA); attachSharedUI(tabB);
    await tabA.init();
    await tabB.init();

    await tabA.addShortcut('TabA新增', 'https://new-a.example.com');
    await settle(20);
    let names = backend.getShortcuts().map(s => s.name);
    check('A 页新增后存储包含全部条目', names.includes('TabA新增') && names.includes('A') && names.includes('B'), JSON.stringify(names));
    check('B 页通过 onChanged 采纳并重渲染', tabB.gridChildren().length === 3, String(tabB.gridChildren().length));

    await tabB.addShortcut('TabB新增', 'https://new-b.example.com');
    await settle(20);
    names = backend.getShortcuts().map(s => s.name);
    check('B 页新增未覆盖 A 页新增', names.includes('TabA新增') && names.includes('TabB新增'), JSON.stringify(names));

    // 真并发：两个提交同时发起（各自页面同时通过任何客户端检查）
    const p1 = tabA.addShortcut('并发A', 'https://conc-a.example.com');
    const p2 = tabB.addShortcut('并发B', 'https://conc-b.example.com');
    await Promise.all([p1, p2]);
    await settle(20);
    names = backend.getShortcuts().map(s => s.name);
    check('并发新增两条都保留（后台串行队列）', names.includes('并发A') && names.includes('并发B'), JSON.stringify(names));
    check('总数为 6 且无重复（A、B + 两页新增 + 两并发新增）', names.length === 6 && new Set(names).size === 6, JSON.stringify(names));

    // 一页删除 + 另一页同时新增：删除不应吞掉新增
    const target = backend.getShortcuts().find(s => s.name === 'TabA新增');
    const aEl = tabA.gridChildren().find(c => c.dataset.id === target.id);
    const pDel = (async () => {
        await aEl._fire('contextmenu', { clientX: 5, clientY: 5 });
        await tabA.doc.getElementById('menu-delete')._fire('click');
    })();
    const pAdd = tabB.addShortcut('并发再新增', 'https://conc-c.example.com');
    await Promise.all([pDel, pAdd]);
    await settle(20);
    names = backend.getShortcuts().map(s => s.name);
    check('并发删除+新增：新增保留、目标已删除', names.includes('并发再新增') && !names.includes('TabA新增'), JSON.stringify(names));
}

/* =========================================================== T03 R03 */
async function testR03() {
    section('T03 · R03 取消编辑后旧保存不写入其他条目');
    const backend = createBackend();
    const bg = createBackground(backend);
    seedStorage(backend, [
        { id: 'id-a', name: 'A', url: 'https://a.com/', icon: 'https://icons.example/a.png' },
        { id: 'id-b', name: 'B', url: 'https://b.com/' },
    ]);
    const iconDeferred = makeDeferred();
    const tab = createTab(backend, bg, {
        name: 't03',
        respond(msg) {
            if (msg.action === 'fetchIcon') return iconDeferred.promise;
            if (msg.action === 'getBestFavicon') return { dataUrl: 'data:image/png;base64,FAVICON' };
            return {};
        },
    });
    attachSharedUI(tab);
    await tab.init();

    // 编辑 A，图标用远程 URL，保存 → 图标下载挂起（不 await 提交：保存会一直等待图标）
    const aEl = tab.gridChildren()[0];
    await aEl._fire('contextmenu', { clientX: 10, clientY: 10 });
    await tab.doc.getElementById('menu-edit')._fire('click');
    const dialog = tab.doc.getElementById('edit-dialog');
    tab.doc.getElementById('shortcut-icon').value = 'https://icons.example/custom.png';
    const submitP = tab.doc.getElementById('edit-form')._fire('submit', { preventDefault() {} });
    await settle(5);
    check('保存期间对话框保持打开（等待图标）', dialog._openState === 'modal', String(dialog._openState));

    // 用户取消 → 打开 B 的编辑框
    await tab.doc.getElementById('cancel-btn')._fire('click');
    check('取消后对话框关闭', dialog._openState === null, String(dialog._openState));
    const bEl = tab.gridChildren().find(c => c.dataset.id === 'id-b');
    await bEl._fire('contextmenu', { clientX: 10, clientY: 10 });
    await tab.doc.getElementById('menu-edit')._fire('click');
    check('B 的编辑框载入 B 的名称', tab.doc.getElementById('shortcut-name').value === 'B', tab.doc.getElementById('shortcut-name').value);

    // 旧下载完成 → 不得写入任何条目、不得关闭 B 的对话框
    iconDeferred.resolve({ success: true, dataUrl: 'data:image/png;base64,OLDICON' });
    await submitP;
    await settle(20);

    const shortcuts = backend.getShortcuts();
    check('B 未被旧保存改写（修复前 B 会被写成 A 的内容）',
        shortcuts[1].name === 'B' && shortcuts[1].url === 'https://b.com/' && !shortcuts[1].icon, JSON.stringify(shortcuts[1]));
    check('A 的名称/网址未被取消的保存破坏',
        shortcuts[0].name === 'A' && shortcuts[0].url === 'https://a.com/', JSON.stringify(shortcuts[0]));
    check('B 的编辑对话框未被旧保存关闭', dialog._openState === 'modal', String(dialog._openState));
    await dialog.close();
}

/* =========================================================== T04 R04 */
async function testR04() {
    section('T04 · R04 写入失败时不显示成功、不关闭对话框');
    const backend = createBackend();
    const bg = createBackground(backend);
    seedStorage(backend, FIXTURE);
    const tab = createTab(backend, bg, { name: 't04' });
    attachSharedUI(tab);
    await tab.init();

    backend.failWritesNext = 1;
    tab.doc.getElementById('add-shortcut-btn')._fire('click');
    tab.doc.getElementById('shortcut-name').value = '会失败的保存';
    tab.doc.getElementById('shortcut-url').value = 'https://fail.example.com';
    await tab.doc.getElementById('edit-form')._fire('submit', { preventDefault() {} });
    await settle(20);

    const shortcuts = backend.getShortcuts().map(s => s.name);
    check('存储未新增条目', !shortcuts.includes('会失败的保存'), JSON.stringify(shortcuts));
    check('编辑对话框保持打开', tab.doc.getElementById('edit-dialog')._openState === 'modal', String(tab.doc.getElementById('edit-dialog')._openState));
    const toasts = Array.from(tab.doc.getElementById('toast-container').children);
    check('出现错误提示（而非成功）', toasts.some(t => t.classList.contains('toast-error')), JSON.stringify(toasts.map(t => t.className)));

    backend.failWritesNext = 0;
    await tab.doc.getElementById('edit-form')._fire('submit', { preventDefault() {} });
    await settle(20);
    check('恢复后保存成功并关闭对话框', backend.getShortcuts().some(s => s.name === '会失败的保存') &&
        tab.doc.getElementById('edit-dialog')._openState === null, '');

    // 导入失败：不得显示"导入成功"，数据保持原样
    backend.failWritesNext = 1;
    await tab.importFile({ schemaVersion: 1, shortcuts: [{ name: '导入项', url: 'https://import.example.com' }] });
    await settle(20);
    check('导入失败时不写入 shortcuts', !backend.getShortcuts().some(s => s.name === '导入项'), JSON.stringify(backend.getShortcuts().map(s => s.name)));
    const toasts2 = Array.from(tab.doc.getElementById('toast-container').children);
    check('导入失败时出现错误提示', toasts2.some(t => t.classList.contains('toast-error')), JSON.stringify(toasts2.map(t => t.className)));
}

/* =========================================================== T05 R05 */
async function testR05() {
    section('T05 · R05 非法 shortcuts 字段被拒绝 / 丢弃条目有统计');
    const backend = createBackend();
    const bg = createBackground(backend);
    seedStorage(backend, FIXTURE);
    const tab = createTab(backend, bg, { name: 't05' });
    attachSharedUI(tab);
    await tab.init();

    await tab.importFile({ shortcuts: { bad: true } });
    await settle();
    check('{"shortcuts":{}} 被拒绝，数据不变', JSON.stringify(backend.getShortcuts().map(s => s.name)) === JSON.stringify(['A', 'B']), JSON.stringify(backend.getShortcuts()));

    await tab.importFile({ shortcuts: null });
    await settle();
    check('{"shortcuts":null} 被拒绝，数据不变', JSON.stringify(backend.getShortcuts().map(s => s.name)) === JSON.stringify(['A', 'B']), JSON.stringify(backend.getShortcuts()));

    tab.state.confirmResult = true;
    await tab.importFile({
        schemaVersion: 1,
        shortcuts: [{ name: 'Good', url: 'https://good.example.com' }, { name: '', url: 'not-a-url' }],
    });
    await settle();
    const summary = tab.confirmCalls[tab.confirmCalls.length - 1] || '';
    check('确认对话框包含导入数量', summary.includes('1 个快捷方式'), summary);
    check('确认对话框包含丢弃统计', summary.includes('1 个无效条目'), summary);
    check('有效条目被导入', backend.getShortcuts().some(s => s.name === 'Good'), JSON.stringify(backend.getShortcuts().map(s => s.name)));

    await tab.importFile({ schemaVersion: 99, shortcuts: [{ name: 'X', url: 'https://x.example.com' }] });
    await settle();
    check('未知 schemaVersion 被拒绝', !backend.getShortcuts().some(s => s.name === 'X'), JSON.stringify(backend.getShortcuts().map(s => s.name)));

    tab.state.confirmResult = false;
    await tab.importFile({ schemaVersion: 1, shortcuts: [{ name: '不该出现', url: 'https://nope.example.com' }] });
    await settle();
    check('确认取消后不覆盖', !backend.getShortcuts().some(s => s.name === '不该出现'), '');
    tab.state.confirmResult = true;
}

/* =========================================================== T06 R06 */
async function testR06() {
    section('T06 · R06 大而合法的备份可完整导入（导出规模 ≤ 导入上限）');
    const backend = createBackend();
    const bg = createBackground(backend);
    seedStorage(backend, FIXTURE);
    const tab = createTab(backend, bg, { name: 't06' });
    attachSharedUI(tab);
    await tab.init();

    // 120 个快捷方式 × ~700K 字符图标 + 2 张近 12MB 壁纸 ≈ 110MB：导出能力内的合法备份
    // （单张壁纸不超 MAX_BACKGROUND_DATA_URL_CHARS=12M 字符的产品上限）
    const bigIcon = 'data:image/png;base64,' + 'A'.repeat(700 * 1024);
    const bgBody = 12 * 1024 * 1024 - 64; // 预留 data URL 前缀，恰好处于产品单图上限之内
    const shortcuts = [];
    for (let i = 0; i < 120; i++) {
        shortcuts.push({ id: 'big-' + i, name: '站点' + i, url: `https://site${i}.example.com`, icon: bigIcon });
    }
    const payload = {
        schemaVersion: 1,
        shortcuts,
        customBg: 'data:image/webp;base64,' + 'C'.repeat(bgBody),
        bingBg: 'data:image/webp;base64,' + 'D'.repeat(bgBody),
        bgMode: 'custom',
    };
    const approxMB = Math.round((Buffer.byteLength(JSON.stringify(shortcuts)) + 24 * 1024 * 1024) / 1024 / 1024);
    check('备份体积约 ' + approxMB + 'MB，超过旧 32MB 导入上限', approxMB > 32, String(approxMB));
    await tab.importFile(payload);
    await settle(30);
    const imported = backend.getShortcuts();
    check('120 个快捷方式全部导入', Array.isArray(imported) && imported.length === 120, String(imported && imported.length));
    check('壁纸完整写入', (backend.dump().customBg || '').length === payload.customBg.length && (backend.dump().bingBg || '').length === payload.bingBg.length, '');
}

/* =========================================================== T07 R07 */
async function testR07() {
    section('T07 · R07 首次渲染远程图标：无 TDZ 异常并完成固化');
    const backend = createBackend();
    const bg = createBackground(backend);
    seedStorage(backend, [
        { id: 'id-a', name: 'A', url: 'https://a.com/', icon: 'https://cdn.example/a.png' },
    ]);
    const tab = createTab(backend, bg, { name: 't07' });
    attachSharedUI(tab);
    await tab.init();
    await settle(20);

    check('无未处理的 Promise 拒绝 / 异常（修复前此处 ReferenceError）', unhandled.length === 0,
        unhandled.map(e => (e && e.message) || String(e)).join(' | '));
    const stored = backend.getShortcuts()[0];
    check('远程图标已固化为 data URL（经后台 setIcon 校验写回）', stored.icon === 'data:image/png;base64,ICON', stored.icon);
}

/* =========================================================== T08 R08+R09 */
async function testR08R09() {
    section('T08 · R08/R09 background 索引并发不丢键 + 负缓存有界');
    const backend = createBackend();
    const bg = createBackground(backend);

    // R08：12 个并发 addToFaviconIndex（修复前非原子读改写会丢键）
    const keys = [];
    for (let i = 0; i < 12; i++) keys.push('favicon://concurrent' + i + '.example');
    await Promise.all(keys.map(k => bg.ctx.addToFaviconIndex(k)));
    const idx = backend.data.get('_faviconKeys') || [];
    check('并发索引更新后 12 个键全部在索引中', idx.length === 12, JSON.stringify(idx));

    // R09：90 个失败域名 → 负缓存有界（≤80 条），且不抛出
    const jobs = [];
    for (let i = 0; i < 90; i++) {
        jobs.push(bg.ctx.handleGetBestFavicon('https://dead' + i + '.example.com/', false));
    }
    await Promise.all(jobs);
    const faviconCount = Array.from(backend.data.keys()).filter(k => k.startsWith('favicon_')).length;
    check('90 个失败域名的负缓存被容量清理到 ≤80', faviconCount <= 80, String(faviconCount));
    const negative = Array.from(backend.data.entries()).filter(([k, v]) => k.startsWith('favicon_') && v && !v.dataUrl);
    check('负缓存条目带 failedAt（供按保留期排序）', negative.length > 0 && negative.every(([, v]) => Number(v.failedAt) > 0), String(negative.length));
}

/* =========================================================== T09 R10 */
async function testR10() {
    section('T09 · R10 必应抓取并发去重');
    const backend = createBackend();
    const bg = createBackground(backend);
    seedStorage(backend, FIXTURE, { bingLastFetch: 0 });
    let jsonCalls = 0;
    let wallpaperCalls = 0;
    const jsonDeferred = makeDeferred();
    const tab = createTab(backend, bg, {
        name: 't09',
        respond(msg) {
            if (msg.action === 'fetchJson') { jsonCalls++; return jsonDeferred.promise; }
            if (msg.action === 'fetchWallpaper') { wallpaperCalls++; return { success: true, dataUrl: 'data:image/jpeg;base64,' + 'B'.repeat(2000) }; }
            return {};
        },
    });
    attachSharedUI(tab);
    await tab.init();

    // 两次并发"换一张"（不 await：click 监听器返回的抓取 Promise 会一直挂起）
    tab.doc.getElementById('bing-refresh-btn')._fire('click');
    tab.doc.getElementById('bing-refresh-btn')._fire('click');
    await settle(5);
    check('并发触发只发起一次接口请求（锁同步占用 + Promise 去重）', jsonCalls === 1, String(jsonCalls));

    jsonDeferred.resolve({ success: true, data: { type: 'json', data: { images: [{ urlbase: '/th?id=OHR.Test_ZH-CN123456' }] } } });
    await settle(10);
    for (const img of tab.imageQueue) if (!img._done) img._load();
    await settle(10);
    check('接口请求全程只发起一次', jsonCalls === 1, String(jsonCalls));
    check('壁纸下载只发起一次', wallpaperCalls === 1, String(wallpaperCalls));
    check('壁纸写入存储', typeof backend.dump().bingBg === 'string' && backend.dump().bingBg.startsWith('data:image/'), String(backend.dump().bingBg).slice(0, 40));
}

/* =========================================================== T10 R11 */
async function testR11() {
    section('T10 · R11 自动亮度检测期间的手动选择获胜');
    const backend = createBackend();
    const bg = createBackground(backend);
    seedStorage(backend, FIXTURE, {
        colorMode: 'auto', bgMode: 'custom',
        customBg: 'data:image/webp;base64,WALLPAPERDATA',
    });
    const tab = createTab(backend, bg, { name: 't10', prefersLight: true });
    attachSharedUI(tab);
    const initPromise = tab.init();

    // 初始化的自动检测被 Image 挂起：给出"浅色"结果让初始化完成
    await settle(10);
    const firstDetect = tab.imageQueue.find(i => !i._done);
    check('初始化亮度检测已发起（Image 挂起）', !!firstDetect, String(tab.imageQueue.length));
    tab.canvasState.brightness = 220; // 浅色壁纸
    firstDetect._load();
    await initPromise;
    check('初始化完成：浅色主题生效', tab.doc.body.classList.contains('light-bg'), tab.doc.body.className);

    // 发起一次新的自动检测（重新选择"自动"），检测挂起期间切换手动深色
    const buttons = tab.doc.querySelectorAll('.color-mode-buttons .glass-btn');
    const autoBtn = buttons.find(b => b.dataset.mode === 'auto');
    const clickAuto = autoBtn._fire('click');
    await settle(10);
    const secondDetect = tab.imageQueue.find(i => !i._done);
    check('二次亮度检测已挂起', !!secondDetect, String(tab.imageQueue.length));

    const darkBtn = buttons.find(b => b.dataset.mode === 'dark');
    await darkBtn._fire('click');
    await settle(5);
    check('手动深色立即生效（body 类）', tab.doc.body.classList.contains('dark-bg'), tab.doc.body.className);

    // 旧检测完成（结果为浅色）→ 必须被丢弃
    tab.canvasState.brightness = 220;
    secondDetect._load();
    await clickAuto;
    await settle(10);
    check('旧检测结果未覆盖手动选择（仍为 dark-bg）', tab.doc.body.classList.contains('dark-bg'), tab.doc.body.className);
    check('_resolvedTheme 缓存为 dark', tab.ls.getItem('_resolvedTheme') === 'dark', tab.ls.getItem('_resolvedTheme'));
    await sleep(600);
    check('colorMode 持久化为 dark', backend.dump().colorMode === 'dark', backend.dump().colorMode);
}

/* =========================================================== T11 S01 */
async function testS01() {
    section('T11 · S01 导入手动深色主题+壁纸后主题被应用');
    const backend = createBackend();
    const bg = createBackground(backend);
    seedStorage(backend, FIXTURE, { colorMode: 'auto', bgMode: 'default' });
    const tab = createTab(backend, bg, { name: 't11', prefersLight: true });
    attachSharedUI(tab);
    await tab.init();
    check('导入前为浅色页', tab.doc.body.classList.contains('light-bg'), tab.doc.body.className);

    await tab.importFile({
        schemaVersion: 1,
        colorMode: 'dark',
        bgMode: 'custom',
        customBg: 'data:image/webp;base64,CUSTOMBG',
    });
    await settle(20);
    check('body 应用深色主题', tab.doc.body.classList.contains('dark-bg'), tab.doc.body.className);
    check('colorMode 已导入', backend.dump().colorMode === 'dark', backend.dump().colorMode);
    check('背景已应用（has-custom-bg）', tab.doc.documentElement.classList.contains('has-custom-bg'), tab.doc.documentElement.className);
}

/* =========================================================== T12 S06 */
async function testS06() {
    section('T12 · S06 初始颜色模式按钮选中态唯一');
    const backend = createBackend();
    const bg = createBackground(backend);
    seedStorage(backend, FIXTURE, { colorMode: 'dark' });
    const tab = createTab(backend, bg, { name: 't12', prefersLight: true });
    attachSharedUI(tab);
    await tab.init();

    const buttons = tab.doc.querySelectorAll('.color-mode-buttons .glass-btn');
    const active = buttons.filter(b => b.classList.contains('active'));
    check('只有一个按钮处于选中态', active.length === 1, JSON.stringify(active.map(b => b.dataset.mode)));
    check('选中的是已存的深色模式', active[0] && active[0].dataset.mode === 'dark', active[0] && active[0].dataset.mode);
    check('body 为深色', tab.doc.body.classList.contains('dark-bg'), tab.doc.body.className);
}

/* ================================================================== main */
(async function main() {
    if (DBG) {
        const wd = setTimeout(() => {
            try {
                fs.writeSync(2, 'WATCHDOG: suite still running after 20s\n');
                const handles = (process._getActiveHandles ? process._getActiveHandles() : [])
                    .map(h => (h && h.constructor ? h.constructor.name : String(h))).join(' | ');
                fs.writeSync(2, 'handles: ' + handles + '\n');
            } catch {}
            process.exit(3);
        }, 20000);
        if (wd.unref) wd.unref();
    }
    const t = (fn) => async () => {
        try { await fn(); }
        catch (err) {
            check('测试执行无异常', false, (err && err.stack) || String(err));
        }
    };

    await t(testR01)();
    await t(testR02)();
    await t(testR03)();
    await t(testR04)();
    await t(testR05)();
    await t(testR06)();
    await t(testR07)();
    await t(testR08R09)();
    await t(testR10)();
    await t(testR11)();
    await t(testS01)();
    await t(testS06)();

    const failed = results.filter(r => !r.ok);
    console.log('\n========================================');
    console.log(`共 ${results.length} 项断言，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    for (const f of failed) {
        console.log(`✗ [${f.test}] ${f.desc}${f.detail ? ' — ' + f.detail : ''}`);
    }
    const unhandledNow = unhandled.filter(e => !/abort/i.test(String(e)));
    if (unhandledNow.length) {
        console.log('未处理异常：');
        for (const e of unhandledNow) console.log('  -', (e && e.stack) || String(e));
    }
    process.exit(failed.length || unhandledNow.length ? 1 : 0);
})().catch(err => { console.error(err); process.exit(2); });
