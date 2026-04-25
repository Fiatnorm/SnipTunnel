/**
 * SnipTunnel v3 — Zero-State, Native Stream VLESS Proxy for Cloudflare Snippets
 * 全部数据转发使用 pipeTo()，零 JS 层数据搬运，零正则，零定时器，零内存池
 */
import { connect } from 'cloudflare:sockets';

// ======================== 配置 ========================
let UUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let DEFAULT_PROXYIP = '';
// =====================================================

// UUID 查找表：模块加载时初始化一次，后续 O(1) 查找
const HEX = Array.from({length:256}, (_,i) => (i+256).toString(16).substring(1));

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      return vlessWS(request, parseConfig(url));
    }
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /');
    return new Response('Hello Snippets', { headers: { 'Content-Type': 'text/plain; charset=UTF-8' } });
  }
};

// ==================== 零正则配置解析 ====================

function parseConfig(url) {
  const sp = url.searchParams;
  const path = url.pathname, lo = path.toLowerCase();
  let proxyIP = null, local = null, localType = null, global = null;

  // Query: ?proxyip=
  const qp = sp.get('proxyip');
  if (qp) proxyIP = addrObj(qp.indexOf(',') !== -1 ? pickRandom(qp) : qp);

  // Query: ?socks5= / ?http=
  const qs = sp.get('socks5'), qh = sp.get('http');
  if (qs || qh) {
    try {
      const c = parseSocks(qs || qh), t = qh ? 'http' : 'socks5';
      if (sp.has('globalproxy')) global = { type: t, cfg: c };
      else { local = c; localType = t; }
    } catch (_) {}
  }

  // Path: /socks5://... /http://...（全局代理）
  if (!global) {
    const pi = lo.indexOf('://');
    if (pi > 0) {
      const pre = lo.substring(1, pi);
      if (pre === 'socks5' || pre === 'socks' || pre === 'http' || pre === 'https') {
        try {
          let raw = path.substring(pi + 3);
          const slashIdx = raw.indexOf('/');
          if (slashIdx !== -1) raw = raw.substring(0, slashIdx);
          const hashIdx = raw.indexOf('#');
          if (hashIdx !== -1) raw = raw.substring(0, hashIdx);
          global = { type: pre.indexOf('sock') !== -1 ? 'socks5' : 'http', cfg: parseSocks(raw) };
          return { proxyIP, local, localType, global };
        } catch (_) {}
      }
    }
  }

  // Path: /proxyip=xxx /ip=xxx
  if (!proxyIP) {
    let r = extractPathVal(lo, path, '/proxyip=') || extractPathVal(lo, path, '/ip=');
    if (r) proxyIP = addrObj(r.indexOf(',') !== -1 ? pickRandom(r) : r);
  }

  // Path: /s5= /socks5= /http= /gs5= /ghttp=
  if (!local && !global) {
    const tags = ['/gs5=','/ghttp=','/s5=','/socks5=','/http='];
    for (const tag of tags) {
      const raw = extractPathVal(lo, path, tag);
      if (!raw) continue;
      try {
        const c = parseSocks(raw), t = tag.indexOf('http') !== -1 ? 'http' : 'socks5';
        if (tag.charAt(1) === 'g') global = { type: t, cfg: c };
        else { local = c; localType = t; }
      } catch (_) {}
      break;
    }
  }
  return { proxyIP, local, localType, global };
}

function extractPathVal(lo, path, tag) {
  const i = lo.indexOf(tag);
  if (i === -1) return null;
  let r = path.substring(i + tag.length);
  const s = r.indexOf('/'); if (s !== -1) r = r.substring(0, s);
  const q = r.indexOf('?'); if (q !== -1) r = r.substring(0, q);
  const h = r.indexOf('#'); if (h !== -1) r = r.substring(0, h);
  return r || null;
}

function pickRandom(csv) { const a = csv.split(','); return a[Math.floor(Math.random() * a.length)]; }

function addrObj(s) { const [a, p] = parseAP(s); return { address: a, port: p }; }

function parseAP(seg) {
  if (seg.charAt(0) === '[') {
    const ci = seg.indexOf(']');
    if (ci === -1) return [seg.substring(1), 443];
    const addr = seg.substring(1, ci);
    return seg.charAt(ci + 1) === ':' ? [addr, parseInt(seg.substring(ci + 2), 10) || 443] : [addr, 443];
  }
  // 多冒号 = IPv6 裸地址，整段作为地址
  const fc = seg.indexOf(':');
  if (fc !== -1 && seg.indexOf(':', fc + 1) !== -1) return [seg, 443];
  // 单冒号 = host:port
  return fc <= 0 ? [seg, 443] : [seg.substring(0, fc), parseInt(seg.substring(fc + 1), 10) || 443];
}

function parseSocks(raw) {
  const ai = raw.lastIndexOf('@');
  let user, pass, host, port;
  if (ai !== -1) {
    let auth = raw.substring(0, ai);
    const hp = raw.substring(ai + 1);
    if (auth.indexOf(':') === -1) {
      try { const d = atob(auth.replaceAll('%3D', '=')); if (d.indexOf(':') !== -1) auth = d; } catch (_) {}
    }
    const ci = auth.indexOf(':');
    if (ci !== -1) { user = auth.substring(0, ci); pass = auth.substring(ci + 1); }
    [host, port] = parseAP(hp); port = port || 1080;
  } else { [host, port] = parseAP(raw); port = port || 1080; }
  if (!host) throw new Error('bad proxy');
  return { username: user, password: pass, hostname: host, port };
}

// ==================== WS 入口 ====================

function vlessWS(request, config) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  // 将 WS 包装为 ReadableStream（EdgeTunnel 标准做法）
  const earlyData = request.headers.get('sec-websocket-protocol') || '';
  const wsReadable = makeWSReadable(server, earlyData);
  let remote = null, remoteWriter = null;

  const cleanup = () => {
    try { remoteWriter?.releaseLock(); } catch (_) {}
    try { remote?.close(); } catch (_) {}
  };

  // 核心双向管道：WS → WritableStream(首包解析+TCP连接) → remote
  wsReadable.pipeTo(new WritableStream({
    async write(chunk) {
      // 后续数据：持久化 writer 直写，无锁开销
      if (remoteWriter) {
        await remoteWriter.write(chunk);
        return;
      }
      // 首包：解析 VLESS
      const buf = new Uint8Array(chunk);
      const v = parseVLESS(buf);
      if (v.err) throw new Error(v.err);
      const respHdr = new Uint8Array([v.ver, 0]);
      const payload = buf.slice(v.dataIdx);

      // UDP 仅放行 DNS(53)，响应头与首包同帧
      if (v.isUDP) {
        if (v.port !== 53) throw new Error('UDP only for DNS');
        await dnsRelay(payload, server, respHdr);
        return;
      }

      // TCP：走 Fallback 链路连接
      const sock = await fallbackConnect(v.host, v.port, config);
      remote = sock;

      // 持久化 writer，写入首包载荷
      remoteWriter = sock.writable.getWriter();
      if (payload.byteLength > 0) await remoteWriter.write(payload);

      // 反向管道：remote.readable → pipeTo → WS（带 VLESS 响应头拼接）
      // 全程 pipeTo，零 JS 数据搬运
      pipeToWS(sock, server, respHdr);
    },
    close() { cleanup(); },
    abort() { cleanup(); }
  })).catch(() => { cleanup(); safeClose(server); });

  return new Response(null, { status: 101, webSocket: client });
}

// ==================== WS → ReadableStream ====================

function makeWSReadable(ws, earlyData) {
  return new ReadableStream({
    start(ctrl) {
      ws.addEventListener('message', e => ctrl.enqueue(e.data));
      ws.addEventListener('close', () => { try { ctrl.close(); } catch (_) {} });
      ws.addEventListener('error', e => { try { ctrl.error(e); } catch (_) {} });
      // Early Data（EdgeTunnel sec-websocket-protocol 标准）
      if (earlyData) {
        try {
          const b64 = earlyData.replaceAll('-', '+').replaceAll('_', '/');
          const bin = atob(b64);
          const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
          ctrl.enqueue(bytes.buffer);
        } catch (_) {}
      }
    }
  });
}

// ==================== Remote → WS 管道 (pipeTo) ====================

function pipeToWS(sock, ws, vlessHdr) {
  let headerSent = false;
  // 全程 pipeTo：remote.readable → WritableStream → ws.send
  // fallbackConnect 已通过 await opened 保证连接可用，无需重试
  sock.readable.pipeTo(new WritableStream({
    write(chunk) {
      if (ws.readyState !== 1) return;
      if (!headerSent) {
        // 首包拼接 VLESS 响应头（必须同帧）
        const merged = new Uint8Array(vlessHdr.byteLength + chunk.byteLength);
        merged.set(vlessHdr, 0);
        merged.set(new Uint8Array(chunk), vlessHdr.byteLength);
        ws.send(merged.buffer);
        headerSent = true;
      } else {
        ws.send(chunk);
      }
    },
    close() { safeClose(ws); },
    abort() { safeClose(ws); }
  })).catch(() => { safeClose(ws); try { sock.close(); } catch (_) {} });
}

// ==================== 智能回退连接链路 ====================

async function fallbackConnect(host, port, config) {
  const { global: gp, local, localType, proxyIP } = config;

  // Step 1: 全局代理最高优先
  if (gp) {
    return gp.type === 'socks5'
      ? await socks5Handshake(host, port, gp.cfg)
      : await httpHandshake(host, port, gp.cfg);
  }

  // Step 2: 尝试直连
  try {
    const s = connect({ hostname: host, port });
    await s.opened;
    return s;
  } catch (directErr) {
    // Step 3: 局部 SOCKS5/HTTP 代理
    if (local) {
      try {
        return localType === 'http'
          ? await httpHandshake(host, port, local)
          : await socks5Handshake(host, port, local);
      } catch (_) {}
    }
    // Step 4: ProxyIP
    const pip = proxyIP || (DEFAULT_PROXYIP ? addrObj(DEFAULT_PROXYIP) : null);
    if (pip) {
      try { const s = connect({ hostname: pip.address, port: pip.port }); await s.opened; return s; } catch (_) {}
    }
    // Step 5: 全部失败
    throw directErr;
  }
}

// ==================== DNS over TCP (DoT，不消耗子请求) ====================

async function dnsRelay(payload, ws, vlessHdr) {
  const sock = connect({ hostname: '8.8.4.4', port: 53 });
  const w = sock.writable.getWriter();
  await w.write(payload);
  w.releaseLock();
  // pipeTo：DNS 响应 → WS，首包拼接 VLESS 响应头（必须同帧）
  let headerSent = false;
  await sock.readable.pipeTo(new WritableStream({
    write(chunk) {
      if (ws.readyState !== 1) return;
      if (!headerSent && vlessHdr) {
        const m = new Uint8Array(vlessHdr.byteLength + chunk.byteLength);
        m.set(vlessHdr, 0);
        m.set(new Uint8Array(chunk), vlessHdr.byteLength);
        ws.send(m.buffer);
        headerSent = true;
      } else {
        ws.send(chunk);
      }
    }
  })).catch(() => {});
  try { sock.close(); } catch (_) {}
}

// ==================== SOCKS5 握手 ====================

async function socks5Handshake(host, port, cfg) {
  const { username, password, hostname, port: sp } = cfg;
  const sock = connect({ hostname, port: sp });
  const w = sock.writable.getWriter(), r = sock.readable.getReader();
  const enc = new TextEncoder();
  try {
    // 认证协商
    const hasAuth = username && password;
    await w.write(hasAuth ? new Uint8Array([5,2,0,2]) : new Uint8Array([5,1,0]));
    let res = (await r.read()).value;
    if (new Uint8Array(res)[1] === 0x02) {
      if (!hasAuth) throw new Error('S5 auth required');
      const ub = enc.encode(username), pb = enc.encode(password);
      await w.write(new Uint8Array([1, ub.length, ...ub, pb.length, ...pb]));
      res = (await r.read()).value;
      if (new Uint8Array(res)[1] !== 0) throw new Error('S5 auth fail');
    }
    // 连接请求（域名方式，兼容 IPv4/域名）
    const hb = enc.encode(host);
    await w.write(new Uint8Array([5,1,0,3, hb.length, ...hb, (port>>8)&0xff, port&0xff]));
    res = (await r.read()).value;
    if (new Uint8Array(res)[1] !== 0) throw new Error('S5 connect fail');
    w.releaseLock(); r.releaseLock();
    return sock;
  } catch (e) {
    try { w.releaseLock(); } catch (_) {}
    try { r.releaseLock(); } catch (_) {}
    try { sock.close(); } catch (_) {}
    throw e;
  }
}

// ==================== HTTP CONNECT 握手（含残余数据处理）====================

async function httpHandshake(host, port, cfg) {
  const { username, password, hostname, port: hp } = cfg;
  const sock = connect({ hostname, port: hp });
  const w = sock.writable.getWriter();

  let req = 'CONNECT ' + host + ':' + port + ' HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\n';
  if (username && password) req += 'Proxy-Authorization: Basic ' + btoa(username + ':' + password) + '\r\n';
  req += 'Connection: keep-alive\r\n\r\n';
  await w.write(new TextEncoder().encode(req));
  w.releaseLock();

  const reader = sock.readable.getReader();
  let buf = new Uint8Array(0);
  try {
    // 有限次读取握手响应（非数据转发循环）
    for (let i = 0; i < 10; i++) {
      const { value, done } = await reader.read();
      if (done) throw new Error('HTTP proxy closed');
      const tmp = new Uint8Array(buf.length + value.byteLength);
      tmp.set(buf); tmp.set(new Uint8Array(value), buf.length);
      buf = tmp;
      const txt = new TextDecoder().decode(buf);
      const endIdx = txt.indexOf('\r\n\r\n');
      if (endIdx === -1) continue;

      const firstLine = txt.substring(0, txt.indexOf('\r\n'));
      if (!(firstLine.startsWith('HTTP/1.1 2') || firstLine.startsWith('HTTP/1.0 2')))
        throw new Error('HTTP proxy refused: ' + firstLine);

      const hdrEnd = endIdx + 4;
      reader.releaseLock();

      // 残余数据处理：将粘连在握手响应后的数据塞入 TransformStream，再 pipeTo
      if (hdrEnd < buf.length) {
        const remaining = buf.slice(hdrEnd);
        const origReadable = sock.readable;
        const ts = new TransformStream();
        // 异步写入残余数据 + 续接原始流（全 pipeTo）
        (async () => {
          const tw = ts.writable.getWriter();
          await tw.write(remaining);
          tw.releaseLock();
          await origReadable.pipeTo(ts.writable);
        })().catch(() => { try { ts.writable.close(); } catch (_) {} });
        sock.readable = ts.readable;
      }
      return sock;
    }
    throw new Error('HTTP proxy response too large');
  } catch (e) {
    try { reader.releaseLock(); } catch (_) {}
    try { sock.close(); } catch (_) {}
    throw e;
  }
}

// ==================== VLESS 首包解析（纯二进制，无正则）====================

function parseVLESS(b) {
  if (b.byteLength < 24) return { err: 'short' };
  const ver = b[0];
  if (UUID && uuidHex(b, 1) !== UUID) return { err: 'uuid' };
  const oLen = b[17], ci = 18 + oLen, cmd = b[ci];
  if (cmd !== 1 && cmd !== 2) return { err: 'cmd' };
  const pi = ci + 1, port = (b[pi] << 8) | b[pi + 1];
  const ai = pi + 2, aType = b[ai];
  let host = '', vi = ai + 1, aLen;
  if (aType === 1) { aLen = 4; host = b[vi]+'.'+b[vi+1]+'.'+b[vi+2]+'.'+b[vi+3]; }
  else if (aType === 2) { aLen = b[vi]; vi++; host = new TextDecoder().decode(b.slice(vi, vi + aLen)); }
  else if (aType === 3) {
    aLen = 16; const s = [];
    for (let i = 0; i < 8; i++) s.push(((b[vi+i*2]<<8)|b[vi+i*2+1]).toString(16));
    host = s.join(':');
  } else return { err: 'addr' };
  if (host === 'speed.cloudflare.com') return { err: 'blocked' };
  return { ver, host, port, isUDP: cmd === 2, dataIdx: vi + aLen };
}

// UUID 比对：预构建查找表，零循环零 padStart
function uuidHex(b, o) {
  return HEX[b[o]]+HEX[b[o+1]]+HEX[b[o+2]]+HEX[b[o+3]]+'-'+
    HEX[b[o+4]]+HEX[b[o+5]]+'-'+HEX[b[o+6]]+HEX[b[o+7]]+'-'+
    HEX[b[o+8]]+HEX[b[o+9]]+'-'+
    HEX[b[o+10]]+HEX[b[o+11]]+HEX[b[o+12]]+HEX[b[o+13]]+HEX[b[o+14]]+HEX[b[o+15]];
}

function safeClose(ws) { try { if (ws.readyState <= 1) ws.close(); } catch (_) {} }