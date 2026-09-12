// 从 .git 对象库提取指定提交的文件内容（支持 loose 对象与 packfile）
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const GIT = path.join(__dirname, '..', '.git');

function readLoose(sha) {
    const p = path.join(GIT, 'objects', sha.slice(0, 2), sha.slice(2));
    if (!fs.existsSync(p)) return null;
    const raw = zlib.inflateSync(fs.readFileSync(p));
    const nul = raw.indexOf(0);
    const header = raw.slice(0, nul).toString('utf8'); // "commit 123"
    return { type: header.split(' ')[0], body: raw.slice(nul + 1) };
}

// --- packfile 读取 ---
const packs = fs.readdirSync(path.join(GIT, 'objects', 'pack'))
    .filter(f => f.endsWith('.idx'))
    .map(f => {
        const base = path.join(GIT, 'objects', 'pack', f.slice(0, -4));
        return { idx: readIdx(base + '.idx'), pack: fs.readFileSync(base + '.pack') };
    });

function readIdx(file) {
    const buf = fs.readFileSync(file);
    if (buf.readUInt32BE(0) !== 0xff744f63) throw new Error('仅支持 idx v2');
    const fanout = [];
    for (let i = 0; i < 256; i++) fanout.push(buf.readUInt32BE(8 + i * 4));
    const count = fanout[255];
    const shas = [];
    for (let i = 0; i < count; i++) shas.push(buf.slice(8 + 1024 + i * 20, 8 + 1024 + (i + 1) * 20).toString('hex'));
    const offTable = 8 + 1024 + count * 20 + count * 4; // 跳过 crc32
    const bigOffIdxStart = offTable + count * 4;
    const offsets = [];
    for (let i = 0; i < count; i++) {
        const v = buf.readUInt32BE(offTable + i * 4);
        offsets.push(v & 0x80000000 ? null : v);
    }
    const bigOffsets = [];
    let p = bigOffIdxStart;
    while (p + 8 <= buf.length - 40) { // 末尾还有两个 40 字节校验
        bigOffsets.push(Number(buf.readBigUInt64BE(p)));
        p += 8;
    }
    return { shas, offsets, bigOffsets, count };
}

function readPackEntry(pack, offset) {
    let type = (pack[offset] >> 4) & 7;
    let size = pack[offset] & 15;
    let shift = 4;
    let pos = offset + 1;
    while (pack[pos] & 0x80) { size |= (pack[pos] & 0x7f) << shift; shift += 7; pos++; }
    pos++; // 结束长度字节
    if (type === 6) { // OBJ_OFS_DELTA
        let b = pack[pos++], off = b & 0x7f;
        while (b & 0x80) { b = pack[pos++]; off = ((off + 1) << 7) | (b & 0x7f); }
        const baseOffset = offset - off;
        const deltaData = zlib.inflateSync(pack.slice(pos));
        return { type: 'ofs-delta', baseOffset, deltaData };
    }
    if (type === 7) { // OBJ_REF_DELTA
        const baseSha = pack.slice(pos, pos + 20).toString('hex');
        const deltaData = zlib.inflateSync(pack.slice(pos + 20));
        return { type: 'ref-delta', baseSha, deltaData };
    }
    const names = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
    const data = zlib.inflateSync(pack.slice(pos));
    return { type: names[type], body: data };
}

function applyDelta(base, delta) {
    let p = 0;
    function varint() { let r = 0, s = 0, b; do { b = delta[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r; }
    varint(); // base size
    const resultSize = varint();
    const out = Buffer.alloc(resultSize);
    let o = 0;
    while (p < delta.length) {
        const op = delta[p++];
        if (op & 0x80) { // copy
            let cpOff = 0, cpSize = 0;
            for (let i = 0; i < 4; i++) if (op & (1 << i)) cpOff |= delta[p++] << (i * 8);
            for (let i = 0; i < 3; i++) if (op & (0x10 << i)) cpSize |= delta[p++] << (i * 8);
            if (cpSize === 0) cpSize = 0x10000;
            base.copy(out, o, cpOff, cpOff + cpSize);
            o += cpSize;
        } else { // insert
            delta.copy(out, o, p, p + op);
            o += op; p += op;
        }
    }
    if (o !== resultSize) throw new Error('delta 大小不符');
    return out;
}

function readObject(sha, depth = 0) {
    if (depth > 50) throw new Error('delta 链过深');
    const loose = readLoose(sha);
    if (loose) return loose;
    for (const { idx, pack } of packs) {
        const i = idx.shas.indexOf(sha);
        if (i === -1) continue;
        let off = idx.offsets[i];
        if (off === null) off = idx.bigOffsets[idx.offsets.indexOf(0x80000000 | 0) === -1 ? i : i]; // 大偏移兜底
        if (off === null || off === undefined) {
            // v2 idx：大偏移表按 MSB 条目顺序排列
            const bigIndex = idx.offsets.reduce((acc, v, k) => { if (v === null) acc.push(k); return acc; }, []).indexOf(i);
            off = idx.bigOffsets[bigIndex];
        }
        const entry = readPackEntry(pack, off);
        if (entry.type === 'ofs-delta') {
            const base = readPackEntryByOffset(pack, idx, entry.baseOffset, depth);
            const baseObj = base.type === 'ofs-delta' || base.type === 'ref-delta'
                ? resolveDeltaEntry(pack, idx, entry.baseOffset, depth)
                : base;
            return { type: baseObj.type, body: applyDelta(baseObj.body, entry.deltaData) };
        }
        if (entry.type === 'ref-delta') {
            const baseObj = readObject(entry.baseSha, depth + 1);
            return { type: baseObj.type, body: applyDelta(baseObj.body, entry.deltaData) };
        }
        return { type: entry.type, body: entry.body };
    }
    throw new Error('对象不存在: ' + sha);
}

function readPackEntryByOffset(pack, idx, offset, depth) {
    return readPackEntry(pack, offset);
}

function resolveDeltaEntry(pack, idx, offset, depth) {
    const entry = readPackEntry(pack, offset);
    if (entry.type === 'ofs-delta') {
        const baseObj = resolveDeltaEntry(pack, idx, entry.baseOffset, depth + 1);
        return { type: baseObj.type, body: applyDelta(baseObj.body, entry.deltaData) };
    }
    if (entry.type === 'ref-delta') {
        const baseObj = readObject(entry.baseSha, depth + 1);
        return { type: baseObj.type, body: applyDelta(baseObj.body, entry.deltaData) };
    }
    return entry;
}

function parseCommit(sha) {
    const obj = readObject(sha);
    if (obj.type !== 'commit') throw new Error('不是 commit: ' + sha);
    const text = obj.body.toString('utf8');
    const tree = (text.match(/^tree ([0-9a-f]{40})/m) || [])[1];
    const parents = [...text.matchAll(/^parent ([0-9a-f]{40})/gm)].map(m => m[1]);
    const msg = text.slice(text.indexOf('\n\n') + 2).trim().split('\n')[0];
    return { tree, parents, msg, sha };
}

function treeLookup(treeSha, name) {
    const obj = readObject(treeSha);
    if (obj.type !== 'tree') throw new Error('不是 tree');
    const body = obj.body;
    let p = 0;
    while (p < body.length) {
        const sp = body.indexOf(0x20, p);
        const mode = body.slice(p, sp).toString('utf8');
        const nul = body.indexOf(0, sp);
        const entryName = body.slice(sp + 1, nul).toString('utf8');
        const sha = body.slice(nul + 1, nul + 21).toString('hex');
        p = nul + 21;
        if (entryName === name) return { mode, sha, name: entryName };
    }
    return null;
}

function fileFromCommit(commitSha, filePath) {
    const commit = parseCommit(commitSha);
    const parts = filePath.split('/');
    let tree = commit.tree;
    for (let i = 0; i < parts.length - 1; i++) {
        const sub = treeLookup(tree, parts[i]);
        if (!sub) return null;
        tree = sub.sha;
    }
    const entry = treeLookup(tree, parts[parts.length - 1]);
    if (!entry) return null;
    const blob = readObject(entry.sha);
    return { content: blob.body.toString('utf8'), sha: entry.sha, commit: parseCommit(commitSha) };
}

// ---- 主流程 ----
function listTree(commitSha) {
    const files = {};
    function walk(treeSha, prefix) {
        const obj = readObject(treeSha);
        const body = obj.body;
        let p = 0;
        while (p < body.length) {
            const sp = body.indexOf(0x20, p);
            const mode = body.slice(p, sp).toString('utf8');
            const nul = body.indexOf(0, sp);
            const name = body.slice(sp + 1, nul).toString('utf8');
            const sha = body.slice(nul + 1, nul + 21).toString('hex');
            p = nul + 21;
            const full = prefix + name;
            if (mode === '40000') walk(sha, full + '/');
            else files[full] = sha;
        }
    }
    walk(parseCommit(commitSha).tree, '');
    return files;
}

const args = process.argv.slice(2);
if (args[0] === 'file') {
    const r = fileFromCommit(args[1], args[2]);
    if (!r) { console.error('NOT FOUND'); process.exit(1); }
    fs.writeFileSync(args[3], r.content);
    console.log('OK', args[1].slice(0, 10), args[2], '->', args[3], 'blob', r.sha.slice(0, 10), 'bytes', r.content.length);
} else if (args[0] === 'log') {
    let sha = args[1];
    for (let i = 0; i < (Number(args[2]) || 8); i++) {
        const c = parseCommit(sha);
        console.log(c.sha.slice(0, 10), '<-', c.parents.map(p => p.slice(0, 10)).join(','), '|', c.msg.slice(0, 80));
        if (!c.parents.length) break;
        sha = c.parents[0];
    }
} else if (args[0] === 'treediff') {
    const t1 = listTree(args[1]);
    const t2 = listTree(args[2]);
    const keys = new Set([...Object.keys(t1), ...Object.keys(t2)]);
    for (const k of [...keys].sort()) {
        if (t1[k] !== t2[k]) console.log((t1[k] ? 'M' : 'A') + (t2[k] ? 'M' : 'D') + ' ' + k);
    }
} else {
    console.log('usage: file <sha> <path> <out> | log <sha> [n] | treediff <sha1> <sha2>');
}
