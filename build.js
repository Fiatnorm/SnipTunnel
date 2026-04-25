/**
 * build.js — 多态混淆构建脚本 v2
 * 
 * 正确的执行顺序：
 *   1. 函数顺序打乱（改变 AST → 改变 terser 的 mangle 分配）
 *   2. Terser 极致压缩（toplevel mangle → 单字母函数名）
 *   3. 后处理：字符串分割 + 数字十六进制化（terser 无法还原）
 *   4. 签名注入
 * 
 * 用法: node build.js
 */
const fs = require('fs');
const { minify } = require('terser');

const SRC = 'snippet.js';
const OUT = 'snippet.min.js';

const ALPHA_ALL = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const randChar = (s) => s[Math.floor(Math.random() * s.length)];
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// ============ Pre-Terser: 函数顺序打乱 ============
// 改变 AST 结构 → terser 的 mangle 分配顺序随之改变 → 变量名每次不同
function shuffleFunctions(code) {
  const funcRegex = /^function \w+\(/gm;
  const funcBlocks = [];
  let match;
  while ((match = funcRegex.exec(code)) !== null) {
    const start = match.index;
    let depth = 0, end = start, inBody = false;
    for (; end < code.length; end++) {
      if (code[end] === '{') { depth++; inBody = true; }
      if (code[end] === '}') { depth--; if (inBody && depth === 0) { end++; break; } }
    }
    while (end < code.length && code[end] === '\n') end++;
    funcBlocks.push({ start, end, text: code.substring(start, end) });
  }

  if (funcBlocks.length >= 6) {
    const tail = funcBlocks.slice(-6);
    for (let i = tail.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tail[i], tail[j]] = [tail[j], tail[i]];
    }
    const allTail = funcBlocks.slice(-6);
    const startPos = allTail[0].start;
    const endPos = allTail[allTail.length - 1].end;
    code = code.substring(0, startPos) + tail.map(b => b.text).join('\n') + code.substring(endPos);
  }
  return code;
}

// ============ Post-Terser: 字符串分割 ============
// 在 terser 输出后执行，terser 无法再折叠
// 使用正则兼容 terser 可能输出的单引号/双引号/反引号
function postSplitStrings(code) {
  const targets = [
    'Hello Snippets',
    'UDP only for DNS',
    'speed.cloudflare.com',
    'sec-websocket-protocol',
    'S5 auth required',
    'S5 auth fail',
    'S5 connect fail',
    'HTTP proxy closed',
    'Connection: keep-alive',
    'HTTP proxy refused: ',
    'HTTP proxy response too large',
    'bad proxy',
    'Proxy-Authorization: Basic ',
    'text/plain; charset=UTF-8',
  ];

  let count = 0;
  for (const str of targets) {
    if (str.length < 4) continue;
    // 转义正则特殊字符，兼容任意引号类型
    const escaped = str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(['"\'\`])(${escaped})\\1`);
    code = code.replace(regex, (match, quote, content) => {
      const splitAt = randInt(1, content.length - 2);
      const left = content.substring(0, splitAt);
      const right = content.substring(splitAt);
      count++;
      return `${quote}${left}${quote}+${quote}${right}${quote}`;
    });
  }
  return { code, count };
}

// ============ Post-Terser: 数字十六进制化 ============
// 使用词边界正则，兼容 terser 可能翻转的比较顺序（如 53!==a）
// 0x35 和 53 在 JS 引擎中完全等价，零运行时开销
function postHexNumbers(code) {
  const rules = [
    { num: '53',   hex: '0x35' },
    { num: '443',  hex: '0x1bb' },
    { num: '1080', hex: '0x438' },
    { num: '256',  hex: '0x100' },
    { num: '24',   hex: '0x18' },
  ];

  let count = 0;
  for (const { num, hex } of rules) {
    // 词边界：前后不能是数字，避免 153→10x35 等误伤
    const regex = new RegExp('(?<![0-9])' + num + '(?![0-9])', 'g');
    const before = code;
    code = code.replace(regex, () => { count++; return hex; });
  }
  return { code, count };
}

// ============ 主流程 ============
async function build() {
  let code = fs.readFileSync(SRC, 'utf-8');

  // ---- Step 1: 函数顺序打乱（Pre-Terser）----
  code = shuffleFunctions(code);

  // ---- Step 2: Terser 极致压缩 ----
  const result = await minify(code, {
    module: true,
    ecma: 2022,
    compress: {
      passes: 3,
      drop_console: true,
      toplevel: true,
      unsafe_math: true,
      ecma: 2022,
    },
    mangle: {
      toplevel: true,            // 顶级函数名 → 单字母
      reserved: ['fetch'],       // 保留 CF Worker 入口
    },
    output: { comments: false, ecma: 2022 }
  });

  if (result.error) {
    console.error('Terser error:', result.error);
    process.exit(1);
  }

  let out = result.code;
  const terserSize = Buffer.byteLength(out, 'utf-8');

  // ---- Step 3: 字符串分割（Post-Terser）----
  const { code: c3, count: strCount } = postSplitStrings(out);
  out = c3;

  // ---- Step 4: 数字十六进制化（Post-Terser）----
  const { code: c4, count: numCount } = postHexNumbers(out);
  out = c4;

  // ---- Step 5: 签名 + 尾部填充 ----
  const sig = Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 16).toString(16)).join('');
  const tail = '/*' + Array.from({ length: randInt(4, 12) }, () =>
    randChar(ALPHA_ALL)).join('') + '*/';
  const finalCode = `/*${sig}*/` + out + tail;

  fs.writeFileSync(OUT, finalCode, 'utf-8');

  const srcSize = fs.statSync(SRC).size;
  const outSize = Buffer.byteLength(finalCode, 'utf-8');
  const saved = ((srcSize - outSize) / srcSize * 100).toFixed(1);

  console.log('✅ 构建完成');
  console.log(`   原始: ${srcSize} bytes (${SRC})`);
  console.log(`   Terser: ${terserSize} bytes`);
  console.log(`   最终: ${outSize} bytes (${OUT})`);
  console.log(`   节省: ${saved}%`);
  console.log(`   签名: ${sig}`);
  console.log(`   字符串分割: ${strCount} 处 (post-terser)`);
  console.log(`   数字十六进制: ${numCount} 处 (post-terser)`);
}

build().catch(err => { console.error(err); process.exit(1); });
