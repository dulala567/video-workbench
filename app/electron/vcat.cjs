// 发布到账号：连接本机「小V猫」的 MCP 接口。
// 小V猫没有公开它的工具名和参数，所以这里不写死：连上后读取工具列表，
// 按名字/描述自动挑出「账号列表」和「发布作品」工具，按参数名自动对照字段，用户可以在界面上改。
const fs = require('fs');
const path = require('path');
const { store } = require('./store.cjs');

let client = null;
let connInfo = null; // { url, transport, tools, serverName }

async function sdk() {
  return {
    Client: require('@modelcontextprotocol/sdk/client/index.js').Client,
    StreamableHTTPClientTransport: require('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport,
    SSEClientTransport: require('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport,
  };
}

async function tryConnect(url, kind, token) {
  const { Client, StreamableHTTPClientTransport, SSEClientTransport } = await sdk();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const u = new URL(url);
  const transport =
    kind === 'sse'
      ? new SSEClientTransport(u, { requestInit: { headers }, eventSourceInit: { fetch: (i, init) => fetch(i, { ...init, headers: { ...(init?.headers || {}), ...headers } }) } })
      : new StreamableHTTPClientTransport(u, { requestInit: { headers } });
  const c = new Client({ name: 'video-workbench', version: '0.2.0' }, { capabilities: {} });
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('连接超时')), 4000));
  await Promise.race([c.connect(transport), timer]);
  return c;
}

async function connect({ port, token }) {
  await disconnect();
  const base = Number(port) || 3199;
  const errors = [];
  // 小V猫默认 3199，找不到时会往后几个端口
  for (let p = base; p < base + 5; p++) {
    for (const [suffix, kind] of [
      ['/mcp', 'http'],
      ['/', 'http'],
      ['/sse', 'sse'],
    ]) {
      const url = `http://127.0.0.1:${p}${suffix}`;
      try {
        const c = await tryConnect(url, kind, token);
        const { tools } = await c.listTools();
        client = c;
        connInfo = { url, transport: kind, serverName: c.getServerVersion()?.name || '', tools };
        return describe();
      } catch (e) {
        const msg = String(e.message || e);
        errors.push(`${url}：${msg}`);
        if (/401|403|unauthor|forbidden|token/i.test(msg)) {
          throw new Error(`连上了 ${url}，但令牌被拒绝。请在小V猫里重新「复制令牌」，并确认勾选了「内容发布」写入权限。`);
        }
      }
    }
  }
  const refused = errors.every((e) => /ECONNREFUSED|fetch failed|超时/i.test(e));
  throw new Error(refused ? `在 127.0.0.1:${base}~${base + 4} 没找到小V猫。请确认小V猫已打开，并在「设置 → MCP 接入」里启用了 MCP。` : '连接失败：\n' + errors.slice(0, 4).join('\n'));
}

async function disconnect() {
  try {
    await client?.close();
  } catch {}
  client = null;
  connInfo = null;
}

// ---------- 自动识别工具和参数 ----------
const text = (t) => `${t.name} ${t.title || ''} ${t.description || ''}`.toLowerCase();
function guessAccountTool(tools) {
  const score = (t) => {
    const s = text(t);
    let n = 0;
    if (/account|账号|帐号/.test(s)) n += 3;
    if (/list|get|query|获取|列表|查询/.test(s)) n += 2;
    if (/publish|发布|comment|评论|私信|message|monitor|监控/.test(s)) n -= 3;
    return n;
  };
  return [...tools].sort((a, b) => score(b) - score(a)).find((t) => score(t) >= 3)?.name || '';
}
function guessPublishTool(tools) {
  const score = (t) => {
    const s = text(t);
    let n = 0;
    if (/publish|发布|upload|post/.test(s)) n += 3;
    if (/video|作品|视频|work/.test(s)) n += 2;
    if (/comment|评论|私信|message|monitor|监控|list|查询|status|状态/.test(s)) n -= 3;
    return n;
  };
  return [...tools].sort((a, b) => score(b) - score(a)).find((t) => score(t) >= 3)?.name || '';
}

// 字段来源：界面上的下拉选项
const SOURCES = {
  file: '视频文件路径',
  files: '视频文件路径（数组）',
  title: '标题',
  desc: '描述 / 正文',
  descWithTags: '描述 + 话题（#话题 拼在末尾）',
  tags: '话题（数组）',
  tagsText: '话题（逗号分隔文本）',
  accountId: '账号 ID',
  accountIds: '账号 ID（数组，一次发多个账号）',
  platform: '账号平台',
  schedule: '定时发布时间',
  cover: '封面图片路径',
  skip: '不填',
  const: '固定值',
};

function guessSource(name, prop = {}) {
  const n = name.toLowerCase();
  const isArr = prop.type === 'array';
  if (/account|账号/.test(n)) return isArr || /ids|list/.test(n) ? 'accountIds' : 'accountId';
  if (/platform|平台/.test(n)) return 'platform';
  if (/cover|封面|thumb/.test(n)) return 'cover';
  if (/video|file|path|文件|视频|media/.test(n)) return isArr ? 'files' : 'file';
  if (/title|标题/.test(n)) return 'title';
  if (/tag|topic|话题|hashtag/.test(n)) return isArr ? 'tags' : 'tagsText';
  if (/desc|content|caption|text|正文|描述|文案/.test(n)) return 'desc';
  if (/time|schedule|定时|date/.test(n)) return 'schedule';
  return 'skip';
}

function autoMapping(tool) {
  const props = tool?.inputSchema?.properties || {};
  const out = {};
  for (const [k, v] of Object.entries(props)) out[k] = { source: guessSource(k, v), value: '' };
  return out;
}

function describe() {
  if (!connInfo) return { connected: false };
  const s = store.getSettings().publish;
  const tools = connInfo.tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema }));
  const accountTool = tools.find((t) => t.name === s.accountTool)?.name || guessAccountTool(tools);
  const publishTool = tools.find((t) => t.name === s.toolName)?.name || guessPublishTool(tools);
  const pt = tools.find((t) => t.name === publishTool);
  const saved = s.mapping?.[publishTool];
  return {
    connected: true,
    url: connInfo.url,
    serverName: connInfo.serverName,
    tools,
    accountTool,
    publishTool,
    mapping: saved && Object.keys(saved).length ? saved : autoMapping(pt),
    sources: SOURCES,
  };
}

// ---------- 调用 ----------
function resultText(r) {
  return (r?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}
function parseJsonLoose(t) {
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/[[{][\s\S]*[\]}]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
  }
  return null;
}
function findArray(o, depth = 0) {
  if (Array.isArray(o) && o.some((x) => x && typeof x === 'object')) return o;
  if (!o || typeof o !== 'object' || depth > 4) return null;
  for (const v of Object.values(o)) {
    const r = findArray(v, depth + 1);
    if (r) return r;
  }
  return null;
}
const pickKey = (o, re) => {
  const k = Object.keys(o).find((x) => re.test(x));
  return k ? o[k] : undefined;
};

async function call(name, args) {
  if (!client) throw new Error('还没连接小V猫');
  const r = await client.callTool({ name, arguments: args });
  const t = resultText(r);
  if (r.isError) throw new Error(t || '小V猫返回错误');
  return { text: t, structured: r.structuredContent };
}

async function listAccounts(toolName, args = {}) {
  const r = await call(toolName, args);
  const data = r.structured ?? parseJsonLoose(r.text);
  const arr = findArray(data) || [];
  return {
    raw: r.text.slice(0, 2000),
    accounts: arr.map((a, i) => ({
      id: String(pickKey(a, /^(id|accountId|account_id|uid|userId|user_id)$/i) ?? i),
      name: String(pickKey(a, /^(name|nickname|nickName|accountName|account_name|userName|title)$/i) ?? `账号 ${i + 1}`),
      platform: String(pickKey(a, /^(platform|platformName|platform_name|type|channel|source)$/i) ?? ''),
      status: String(pickKey(a, /^(status|state|online|loginStatus|login_status)$/i) ?? ''),
      raw: a,
    })),
  };
}

function buildArgs(mapping, item, accounts) {
  const args = {};
  for (const [k, m] of Object.entries(mapping || {})) {
    const tags = item.tags || [];
    const v = {
      file: item.file,
      files: [item.file],
      title: item.title,
      desc: item.desc,
      descWithTags: [item.desc, tags.map((t) => '#' + t).join(' ')].filter(Boolean).join(' '),
      tags,
      tagsText: tags.join(','),
      accountId: accounts[0]?.id,
      accountIds: accounts.map((a) => a.id),
      platform: accounts[0]?.platform,
      schedule: item.schedule || undefined,
      cover: item.cover || undefined,
      skip: undefined,
      const: (() => {
        try {
          return JSON.parse(m.value);
        } catch {
          return m.value;
        }
      })(),
    }[m.source];
    if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) args[k] = v;
  }
  return args;
}

const sleep = (ms, signal) =>
  new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(new Error('已取消'))), { once: true });
  });

// 发布任务：一条视频发到选中的账号。参数里账号是数组就一次调用，否则逐个账号调用。
async function handler(job, ctx) {
  const { item, accounts, toolName, mapping, interval } = job.input;
  if (!client) throw new Error('小V猫未连接（打开「发布到账号」页点「连接」）');
  if (!fs.existsSync(item.file)) throw new Error('视频文件不存在：' + item.file);
  const batch = Object.values(mapping).some((m) => m.source === 'accountIds');
  const groups = batch ? [accounts] : accounts.map((a) => [a]);
  const results = [];
  for (let i = 0; i < groups.length; i++) {
    ctx.progress(i / groups.length, `发布到 ${groups[i].map((a) => a.name).join('、')}`);
    const r = await call(toolName, buildArgs(mapping, item, groups[i]));
    results.push({ accounts: groups[i].map((a) => a.name), reply: r.text.slice(0, 500) });
    if (i < groups.length - 1 && interval) await sleep(interval * 1000, ctx.signal);
  }
  ctx.progress(1, '已提交');
  // 和下一条视频之间留间隔，避免平台判定频繁发布
  if (interval) await sleep(interval * 1000, ctx.signal).catch(() => {});
  return { file: item.file, results };
}

module.exports = { connect, disconnect, describe, listAccounts, call, handler, buildArgs, autoMapping };
