#!/usr/bin/env node
/*
 * asar-probe.cjs — 只读探针：在 Electron 应用的 app.asar 里按关键词找位置，并把命中处的原文打出来。
 *
 * 用法:
 *   node asar-probe.cjs find <kw> [kw2 ...]        # 每个关键词的命中偏移（不打印原文）
 *   node asar-probe.cjs read <offset> [len]        # 从某偏移 dump 一段文本（默认 3000 字符）
 *   node asar-probe.cjs --asar <path> find <kw>    # 手动指定 asar
 *
 * 为什么有它：app.asar 里带着每个官方包的完整 README（英中双语）+ 源码，
 * 想知道「这个应用内部怎么做的、支持哪些开关、语义是什么」，直接查这里比猜快得多。
 * asar 带 JSON 索引、内容可随机读取，所以**不必解包上百 MB**。
 *
 * asar 路径解析顺序：--asar <path> → 环境变量 DSH_ASAR → 常见安装位置。
 *
 * 只读，不修改任何东西。零依赖。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const raw = process.argv.slice(2);

/* ---- asar 路径解析：参数 > 环境变量 > 常见安装位置 ---- */
function fromFlag() {
  const i = raw.indexOf('--asar');
  if (i >= 0 && raw[i + 1]) return raw[i + 1];
  const eq = raw.find(a => a.startsWith('--asar='));
  return eq ? eq.slice(7) : null;
}
function candidates() {
  const home = os.homedir();
  const names = ['DeepSeek Harness', 'DeepSeek-Harness', 'dsh'];
  const out = [];
  if (process.platform === 'win32') {
    const bases = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.APPDATA];
    for (const b of bases) if (b) for (const n of names) out.push(path.join(b, 'Programs', n, 'resources', 'app.asar'), path.join(b, n, 'resources', 'app.asar'));
    // 便携版常见位置
    for (const d of ['C:', 'D:', 'E:', 'F:']) out.push(path.join(d + path.sep, 'DeepSeek Harness', 'resources', 'app.asar'));
  } else if (process.platform === 'darwin') {
    for (const n of names) {
      out.push(`/Applications/${n}.app/Contents/Resources/app.asar`);
      out.push(path.join(home, 'Applications', `${n}.app`, 'Contents', 'Resources', 'app.asar'));
    }
  } else {
    for (const n of names) {
      out.push(`/opt/${n}/resources/app.asar`);
      out.push(`/usr/lib/${n}/resources/app.asar`);
      out.push(path.join(home, '.local', 'share', n, 'resources', 'app.asar'));
    }
  }
  return out;
}
function resolveAsar() {
  const explicit = fromFlag() || process.env.DSH_ASAR;
  if (explicit) return explicit;
  const found = candidates().find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
  return found || null;
}

const argv = raw.filter(a => a !== '--asar' && !a.startsWith('--asar=') && a !== fromFlag());
const cmd = argv[0] || 'help';
const ASAR = resolveAsar();

function need() {
  if (!ASAR) {
    console.error('找不到 app.asar。请用 --asar <path> 或环境变量 DSH_ASAR 指定，例如：');
    console.error('  node asar-probe.cjs --asar "D:\\Apps\\DeepSeek Harness\\resources\\app.asar" find proxy');
    process.exit(2);
  }
  if (!fs.existsSync(ASAR)) { console.error('asar not found: ' + ASAR); process.exit(2); }
  return ASAR;
}
function load() { return fs.readFileSync(need()).toString('latin1'); }

if (cmd === 'find') {
  const s = load();
  console.log('asar: ' + ASAR);
  for (const kw of argv.slice(1)) {
    const pos = []; let i = -1;
    while ((i = s.indexOf(kw, i + 1)) >= 0) pos.push(i);
    console.log(`${kw}: ${pos.length} hit(s)${pos.length ? ' -> ' + pos.slice(0, 40).join(', ') + (pos.length > 40 ? ' ...' : '') : ''}`);
  }
} else if (cmd === 'read') {
  const start = parseInt(argv[1] || '0', 10), len = parseInt(argv[2] || '3000', 10);
  const file = need();
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, start); fs.closeSync(fd);
  console.log('asar: ' + file);
  console.log(buf.subarray(0, n).toString('utf8'));
} else {
  console.log('usage: asar-probe.cjs [--asar <path>] find <kw> [kw2 ...]');
  console.log('       asar-probe.cjs [--asar <path>] read <offset> [len]');
  if (ASAR) console.log('\nresolved asar: ' + ASAR);
}
