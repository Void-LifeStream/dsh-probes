#!/usr/bin/env node
/*
 * proxy-doctor.cjs — 只读体检：这台机器上「代理」与「程序的出站」是什么关系。
 *
 * 用法:
 *   node proxy-doctor.cjs env              # 进程/用户/机器 三层代理变量 + 系统代理 + 端口探活
 *   node proxy-doctor.cjs route <url>      # 实测：按当前环境路由 vs 强制直连，各发一次请求
 *   node proxy-doctor.cjs writes [--limit N]   # 考古：哪个会话写过代理环境变量（扫 DSH 会话日志）
 *
 * 为什么有它：一次真实的事故 —— 有人为了「让某个程序走代理」把 HTTP_PROXY 写进了
 * 用户级持久环境变量。于是一台机器上**每一个**读环境变量的程序都被裹进了代理；
 * 代理一停，连模型请求和两款游戏的登录器都一起报网络错误，而**网络本身完全健康**。
 * 症状极具误导性：不是超时，是几毫秒内的连接被拒。
 *
 * 判据（都是实测过的语义）：
 *   · 同一个代理名可能同时存在于「进程继承 / 用户级持久 / 程序自己的配置」三层，
 *     优先级与生效时机各不相同 —— 只查一层很容易得出"改了没用"的错误结论。
 *   · NO_PROXY=example.com 也会放行 api.example.com（后缀匹配）；CIDR 不被支持。
 *   · 环境变量是进程「出生时」继承的：改完必须重启那个进程，否则新值不生效。
 *
 * 只读，不修改任何东西。零依赖。
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { spawnSync } = require('child_process'), net = require('net');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'env';
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
const DEFAULT_URL = 'https://api.deepseek.com/v1/models';

function regQuery(key, value) {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('reg.exe', ['query', key, '/v', value], { encoding: 'buffer' });
  if (r.status !== 0 || !r.stdout) return null;
  const line = r.stdout.toString('latin1').split(/\r?\n/).find(l => l.includes(value));
  if (!line) return null;
  const parts = line.trim().split(/\s{2,}/);
  return parts.length >= 3 ? parts.slice(2).join('  ') : null;
}

function probeTcp(host, port, ms = 1500) {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = ok => { try { s.destroy(); } catch (e) { } resolve(ok); };
    s.setTimeout(ms);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

function proxyHostPort(v) {
  try { const u = new URL(v); return [u.hostname, Number(u.port || (u.protocol === 'https:' ? 443 : 80))]; }
  catch (e) { return null; }
}

async function cmdEnv() {
  console.log('== process env (what THIS process sees) ==');
  for (const n of PROXY_NAMES) console.log(`  ${n} = ${process.env[n] === undefined ? '(unset)' : JSON.stringify(process.env[n])}`);
  console.log(`  NODE_USE_ENV_PROXY = ${process.env.NODE_USE_ENV_PROXY || '(unset)'}   <- Node 24+ 读环境变量代理的开关`);
  console.log('\n== persisted layers (Windows registry) ==');
  if (process.platform === 'win32') {
    for (const n of PROXY_NAMES) {
      console.log(`  ${n}  User=${JSON.stringify(regQuery('HKCU\\Environment', n))}  Machine=${JSON.stringify(regQuery('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', n))}`);
    }
    console.log('\n== WinINET system proxy (what Chromium/Edge read) ==');
    const IS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    console.log(`  ProxyEnable = ${regQuery(IS, 'ProxyEnable')}`);
    console.log(`  ProxyServer = ${regQuery(IS, 'ProxyServer')}`);
  } else {
    console.log('  (skipped: not Windows)');
  }
  console.log('\n== is the configured proxy actually alive? ==');
  const hp = proxyHostPort(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '');
  if (!hp) console.log('  (no usable proxy URL in env)');
  else console.log(`  ${hp[0]}:${hp[1]} listening = ${await probeTcp(hp[0], hp[1])}`);
  console.log('\n判据：NO_PROXY 里没有的域名 ⇒ 该域名的一切出站都走代理 ⇒ 代理一停就断。');
  console.log('      只查一层变量是不够的 —— 「进程继承 / 用户级 / 机器级」三层都要看。');
}

function runProbe(url, clean) {
  const env = { ...process.env, NODE_USE_ENV_PROXY: '1' };
  if (clean) { for (const n of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[n]; env.NO_PROXY = '*'; }
  const r = spawnSync(process.execPath, [__filename, '__probe', url], { env, encoding: 'utf8', timeout: 25000 });
  return (r.stdout || '').trim() + (r.stderr ? '\n  stderr: ' + r.stderr.trim().split('\n')[0] : '');
}

async function cmdRoute() {
  const url = argv[1] || DEFAULT_URL;
  const hp = proxyHostPort(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '');
  console.log(`target      : ${url}`);
  console.log(`HTTP_PROXY  : ${process.env.HTTP_PROXY || '(unset)'}`);
  console.log(`HTTPS_PROXY : ${process.env.HTTPS_PROXY || '(unset)'}`);
  console.log(`NO_PROXY    : ${process.env.NO_PROXY || '(unset)'}`);
  if (hp) console.log(`proxy alive : ${await probeTcp(hp[0], hp[1])}`);
  console.log('\n[1] as the current environment routes it:');
  console.log('    ' + runProbe(url, false).replace(/\n/g, '\n    '));
  console.log('\n[2] forced direct (proxy vars removed) — is the endpoint reachable without any proxy?');
  console.log('    ' + runProbe(url, true).replace(/\n/g, '\n    '));
  console.log('\n判读：[1] 失败而 [2] 成功 ⇒ 有代理在挡路，而且没人监听它（或 NO_PROXY 缺该域名）。');
}

function inflateMultiFrame(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const parts = []; let s = buf.indexOf(MAGIC);
  while (s >= 0 && s < buf.length) {
    const n = buf.indexOf(MAGIC, s + 4), e = n < 0 ? buf.length : n;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(s, e))); } catch (x) { }
    s = n;
  }
  return Buffer.concat(parts).toString('utf8');
}
function walk(dir, out) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of es) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); }
  return out;
}

/* 只在 DSH 里有意义：它的会话日志（多帧 zstd）记录着每一次工具调用。 */
function cmdWrites() {
  const LIMIT = parseInt(flag('--limit', '10'), 10);
  const sessions = path.join(os.homedir(), '.dsh', 'sessions');
  if (!fs.existsSync(sessions)) {
    console.log(`未找到 DSH 会话目录：${sessions}（writes 子命令只对 DSH 有效）`);
    return;
  }
  const WRITE_RE = /SetEnvironmentVariable[\s\S]{0,140}(PROXY)|(PROXY)[\s\S]{0,140}SetEnvironmentVariable|reg(\.exe)?\s+add[\s\S]{0,200}Environment/i;
  const PROXY_RE = /(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/i;
  const files = walk(sessions, []).filter(f => /session\.v4\.jsonl(\.zstd)?$/.test(f));
  const hits = [];
  for (const f of files) {
    let text; try { const raw = fs.readFileSync(f); text = f.endsWith('.zstd') ? inflateMultiFrame(raw) : raw.toString('utf8'); } catch (e) { continue; }
    const sess = path.basename(path.dirname(f));
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
      if (!/^tool\//.test(ev.type || '')) continue;
      const blob = typeof ev.data?.arguments === 'string' ? ev.data.arguments : JSON.stringify(ev.data?.arguments || {});
      if (!PROXY_RE.test(blob) || !WRITE_RE.test(blob)) continue;
      hits.push({ t: ev.time || 0, when: ev.time ? new Date(ev.time).toLocaleString('sv-SE') : '?', sess, tool: ev.data?.name || ev.type });
    }
  }
  hits.sort((a, b) => b.t - a.t);
  console.log(`scanned ${files.length} session logs — ${hits.length} proxy-write tool call(s), newest first:`);
  for (const h of hits.slice(0, LIMIT)) console.log(`  [${h.when}] ${h.sess}  ${h.tool}`);
}

(async () => {
  if (cmd === '__probe') {
    const url = argv[1] || DEFAULT_URL, t0 = Date.now();
    try { const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); console.log(`OK http=${r.status} in ${Date.now() - t0}ms`); }
    catch (e) { console.log(`FAIL ${e.name}: ${String(e.message).split('\n')[0]} in ${Date.now() - t0}ms`); }
    return;
  }
  if (cmd === 'env') return cmdEnv();
  if (cmd === 'route') return cmdRoute();
  if (cmd === 'writes') return cmdWrites();
  console.log('usage: proxy-doctor.cjs env | route [url] | writes [--limit N]');
})();
