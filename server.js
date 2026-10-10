const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Server } = require('socket.io');
const persist = require('./persist');

const app = express();
const server = http.createServer(app);
// perMessageDeflate：只壓縮 1KB 以上的訊息（例如進房時的完整狀態），小的變動訊息不壓縮
const io = new Server(server, { perMessageDeflate: { threshold: 1024 } });

const PORT = process.env.PORT || 3000;
const CHANNEL_COUNT = 60;
const APPEAR_HOLD_MS = 10 * 60 * 1000; // 超過最大值後，「出現中」再保留 10 分鐘才消失
const MAX_KILL_POINTS = 100; // 「時間點」紀錄最多保留筆數
const MAX_LOG = 500; // 每個房間的操作紀錄最多保留筆數（避免伺服器記憶體無限成長）
// 房間密碼規則：剛好 6 個字元，只能是英文大小寫或數字（大小寫視為不同）
const PASSWORD_RE = /^[A-Za-z0-9]{6}$/;
const MAX_ROOM_USERS = 10; // 每間房間最多幾個人（同一個瀏覽器開多個分頁只算一人；管理者不計入）
// 房間沒有任何人在線、也沒有任何進行中的 CH 超過這段時間，就自動刪除（釋放記憶體）
const EMPTY_ROOM_TTL_MS = 6 * 60 * 60 * 1000;

// 管理者密鑰：用來讓網站擁有者強制修改 / 禁止 / 移除別人（只對管理者「目前所在的房間」生效）。
// 建議在 Render 的環境變數設定 ADMIN_KEY，不要用預設值。
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-admin-key';

// ---------- 計時匯出 / 匯入的加密 ----------
// 匯入碼用 AES-256-GCM 加密，金鑰只存在伺服器（預設由 ADMIN_KEY 推導；也可另外設定環境變數 EXPORT_SECRET）。
// 沒有金鑰就無法解讀或竄改；改了 ADMIN_KEY / EXPORT_SECRET 之後，舊的匯入碼會失效。
const EXPORT_KEY = crypto.createHash('sha256').update('msctimer-export|' + (process.env.EXPORT_SECRET || ADMIN_KEY)).digest();
const EXPORT_PREFIX = 'MSCT1.';
const MAX_IMPORT_CODE_LEN = 200000;

function encryptExport(obj) {
  const plain = zlib.deflateRawSync(Buffer.from(JSON.stringify(obj), 'utf8'));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', EXPORT_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return EXPORT_PREFIX + Buffer.concat([iv, tag, enc]).toString('base64url');
}

function decryptExport(code) {
  if (typeof code !== 'string' || code.length > MAX_IMPORT_CODE_LEN) throw new Error('bad');
  const m = code.match(/MSCT1\.([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('bad');
  const buf = Buffer.from(m[1], 'base64url');
  if (buf.length < 29) throw new Error('bad');
  const decipher = crypto.createDecipheriv('aes-256-gcm', EXPORT_KEY, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  return JSON.parse(zlib.inflateRawSync(plain, { maxOutputLength: 5 * 1024 * 1024 }).toString('utf8'));
}

const fs = require('fs');

// 比對管理者密鑰（固定時間比較，避免被逐字猜測）
function isAdminKey(key) {
  if (typeof key !== 'string') return false;
  const a = Buffer.from(key);
  const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 首頁：只有網址帶正確 ?admin=密鑰 時，才在頁面裡插入管理者腳本；
// 一般使用者拿到的 index.html 跟 client.js 完全沒有任何管理者相關的程式碼。
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');

// 網站版本：依前端檔案內容算出來，每次部署有改檔案就會變。
// 1) 首頁裡的 client.js / style.css 網址會帶 ?v=版本，瀏覽器不會用到舊的快取檔案；
// 2) 連線時告訴瀏覽器目前版本，網頁開著期間伺服器更新了，就會顯示「網站已更新」提示。
const SITE_VERSION = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['index.html', 'client.js', 'style.css']) {
    try { h.update(fs.readFileSync(path.join(__dirname, 'public', f))); } catch (e) { /* ignore */ }
  }
  try { h.update(fs.readFileSync(path.join(__dirname, 'admin', 'admin.js'))); } catch (e) { /* ignore */ }
  return h.digest('hex').slice(0, 10);
})();
// 網站正式網址（Render 環境變數 SITE_URL，例如 https://msctimer.onrender.com；沒設定就用這次連線的網址）
function siteUrl(req) {
  const env = (process.env.SITE_URL || '').replace(/\/+$/, '');
  if (env) return env;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${req.get('host')}`;
}
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin.js\n\nSitemap: ${siteUrl(req)}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${siteUrl(req)}/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>\n`);
});

app.get(['/', '/index.html'], (req, res) => {
  fs.readFile(INDEX_PATH, 'utf8', (err, html) => {
    if (err) return res.status(500).send('Server error');
    res.set('Cache-Control', 'no-store');
    if (isAdminKey(req.query.admin)) {
      const tag = `<script src="/admin.js?k=${encodeURIComponent(req.query.admin)}"></script>\n`;
      html = html.replace('<script src="client.js"></script>', tag + '<script src="client.js"></script>');
    }
    // 搜尋引擎：Google Search Console 驗證碼（Render 環境變數 GOOGLE_SITE_VERIFICATION）、正式網址
    const extra = [];
    if (process.env.GOOGLE_SITE_VERIFICATION) extra.push(`<meta name="google-site-verification" content="${String(process.env.GOOGLE_SITE_VERIFICATION).replace(/"/g, '')}" />`);
    extra.push(`<link rel="canonical" href="${siteUrl(req)}/" />`);
    extra.push(`<meta property="og:url" content="${siteUrl(req)}/" />`);
    // 結構化資料：告訴 Google 網站名稱是 MSCtimer（搜尋結果上方顯示的網站名稱，不然會顯示成主機商 Render）
    extra.push(`<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'MSCtimer',
      alternateName: ['MSCtimer 楓之谷經典版團隊野王計時器', '楓之谷經典版團隊野王計時器'],
      url: siteUrl(req) + '/'
    })}</script>`);
    // 分享預覽圖要用完整網址，Discord / LINE / FB 才抓得到
    html = html.replace('<meta property="og:image" content="/images/', `<meta property="og:image" content="${siteUrl(req)}/images/`);
    html = html.replace('</head>', extra.join('\n') + '\n</head>');
    html = html
      .replace('<script src="client.js"></script>', `<script src="client.js?v=${SITE_VERSION}"></script>`)
      .replace('href="style.css"', `href="style.css?v=${SITE_VERSION}"`);
    res.type('html').send(html);
  });
});

// 管理者腳本放在 public 之外，密鑰正確才給，否則一律回 404（看起來就像不存在）
const ADMIN_JS_PATH = path.join(__dirname, 'admin', 'admin.js');
app.get('/admin.js', (req, res) => {
  if (!isAdminKey(req.query.k)) return res.status(404).send('Not Found');
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').sendFile(ADMIN_JS_PATH);
});

// 戰利品圖示：全部打包在 public/drops/icons.json（避免 GitHub 網頁上傳一次超過 100 個檔案），由這裡以 /drops/icons/道具編號.png 提供
let DROP_ICONS = {};
try { DROP_ICONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'drops', 'icons.json'), 'utf8')); } catch (e) { console.error('[戰利品] 讀不到 icons.json：', e.message); }
app.get('/drops/icons/:file', (req, res) => {
  const id = String(req.params.file || '').replace(/\.png$/, '');
  const b64 = DROP_ICONS[id];
  if (!b64) return res.status(404).end();
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=604800');
  res.send(Buffer.from(b64, 'base64'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

let nextTabId = 1;

// 預設 9 個分頁（王名 / 最小值 / 最大值 / 圖片檔名）
const BOSS_PRESETS = [
  { name: '紅寶王',     min: 45,  max: 45,  image: 'red-king.png' },
  { name: '樹妖王',     min: 45,  max: 45,  image: 'tree-demon-king.png' },
  { name: '巨居蟹',     min: 45,  max: 45,  image: 'giant-crab.png' },
  { name: '殭屍猴王',   min: 45,  max: 45,  image: 'zombie-monkey-king.png' },
  { name: '蘑菇王',     min: 40,  max: 60,  image: 'mushroom-king.png' },
  { name: '殭屍蘑菇王', min: 40,  max: 60,  image: 'zombie-mushroom-king.png' },
  { name: '沼澤巨鱷',   min: 45,  max: 45,  image: 'swamp-crocodile.png' },
  { name: '巴洛古',     min: 240, max: 360, image: 'barogu.png' },
  { name: '艾利傑(beta)', min: 45, max: 60,  image: 'elliget.png' },
  { name: '雪毛怪人(beta)', min: 45,  max: 60,  image: 'snow-fur-monster.png' }
];

function createChannel() {
  return {
    state: 'idle',      // idle | counting（倒數中）| window（重生區間：最小值～最大值）| appearing（出現中：超過最大值）
    startTime: null,    // server epoch ms
    customMin: null,    // null = 使用分頁預設值
    customMax: null,
    startedBy: null,     // 是誰觸發這次倒數的暱稱
    standby: null        // 「待命」：按下待命的人的暱稱（null = 沒人待命）
  };
}

function createTab(name, minMinutes, maxMinutes, image, locked) {
  const id = nextTabId++;
  return {
    id,
    name: (name && name.trim()) || `分頁 ${id}`,
    minMinutes: minMinutes || 45,
    maxMinutes: maxMinutes || 60,
    image: image || null,
    locked: !!locked, // 鎖定的分頁：無法刪除、無法修改最小值/最大值
    killCount: 0,     // 這隻王被按「擊殺」的次數
    channels: Array.from({ length: CHANNEL_COUNT }, createChannel)
  };
}

// ---------- 房間 ----------
// 相同「房間密碼」的人會進到同一個房間，共用同一份計時器。
// 房間以密碼的 SHA-256 雜湊當作 key；密碼原文只會傳給通過驗證的管理者（管理者面板的「所有房間」列表）。
const rooms = new Map(); // roomId -> room

function roomIdFromPassword(password) {
  return 'room:' + crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

function createRoom(id, password) {
  return {
    id,
    password,
    createdAt: Date.now(),
    // 每個新房間都有 9 個預設王分頁（固定鎖定，不可刪除、不可改時間範圍）
    tabs: BOSS_PRESETS.map((b) => createTab(b.name, b.min, b.max, b.image, true)),
    connectedUsers: new Map(),  // socket.id -> nickname
    bannedNicknames: new Set(), // 已被管理者移除、不可再進入此房間的暱稱（小寫）
    mutedNicknames: new Map(),  // 被禁止操作的使用者（小寫暱稱 -> 原始暱稱）
    activityLog: [],
    killPoints: [],   // 「時間點」紀錄：每次擊殺時王已重生多久（新的在前）
    loot: {},         // 「戰利品」紀錄：{ 王圖檔: { 道具編號: 次數 } }
    // 隊長：建立房間的人（以瀏覽器識別碼記住，重新整理、斷線重連後仍是隊長）
    captainClientId: null,
    captainName: null,           // 隊長目前的暱稱（隊長不在房間時也會顯示）
    captainMuted: new Map(),     // 被隊長禁止操作的隊員（小寫暱稱 -> 原始暱稱）
    lastActive: Date.now()
  };
}

function getRoom(socket) {
  const id = socket.data.roomId;
  return id ? rooms.get(id) : null;
}

function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

function findTab(room, tabId) {
  return room.tabs.find((t) => t.id === tabId);
}

// 管理者在房間裡是「隱身」的：不算在線上人數、不出現在名單，也不佔用暱稱
// （否則一般使用者輸入相同暱稱被擋下，就會發現房間裡有人）。
function isAdminSocketId(socketId) {
  const s = io.sockets.sockets.get(socketId);
  return !!(s && s.data.isAdmin);
}

// joiningIsAdmin = true 時（管理者自己要進房）連其他管理者的暱稱也一起比對；
// 一般使用者只跟一般使用者比對。
// 同一個瀏覽器（clientId 相同）的連線視為「同一個人」：重新整理時舊連線還沒被伺服器偵測到斷線，
// 或同時開兩個分頁，都不會被判定成「暱稱已有人使用」。
function clientIdOf(socketId) {
  const s = io.sockets.sockets.get(socketId);
  return (s && s.data.clientId) || null;
}

function isNicknameTaken(room, name, excludeSocketId, joiningIsAdmin, joiningClientId) {
  const norm = normalizeName(name);
  for (const [id, n] of room.connectedUsers.entries()) {
    if (id === excludeSocketId || normalizeName(n) !== norm) continue;
    if (joiningClientId && clientIdOf(id) === joiningClientId) continue; // 是自己（另一個分頁 / 舊連線）
    if (!joiningIsAdmin && isAdminSocketId(id)) continue;
    return true;
  }
  return false;
}

// 房間內的使用者名單（同一個瀏覽器、同暱稱、同身分的多條連線合併成一人）。
// 「是不是管理者」也是合併條件之一：同一個瀏覽器一個分頁當一般使用者、另一個分頁用 admin 網址時，
// 兩者分開計算，只有 admin 那個隱身，一般使用者照常顯示。
function roomUserList(room) {
  const seen = new Map();
  for (const [id, name] of room.connectedUsers.entries()) {
    const hidden = isAdminSocketId(id);
    const key = (clientIdOf(id) || id) + '|' + normalizeName(name) + '|' + (hidden ? 'admin' : 'user');
    if (!seen.has(key)) seen.set(key, { id, name, hidden });
  }
  return Array.from(seen.values());
}

function isCaptain(room, socket) {
  return !!room.captainClientId && !socket.data.isAdmin && socket.data.clientId === room.captainClientId;
}

// 房間目前「看得見的人數」（同一瀏覽器同暱稱只算一人，管理者不計入）
function visibleUserCount(room) {
  return roomUserList(room).filter((u) => !u.hidden).length;
}

// 跟 targetSocketId 同一個瀏覽器、同一個身分（一般 / 管理者）、在同一個房間的所有連線
// （管理者對一般使用者改名、移除時，不會波及同一個瀏覽器裡的管理者分頁）
function sameClientSocketsInRoom(room, targetSocketId) {
  const target = io.sockets.sockets.get(targetSocketId);
  if (!target || target.data.roomId !== room.id) return [];
  const cid = target.data.clientId;
  if (!cid) return [target];
  const targetIsAdmin = !!target.data.isAdmin;
  return Array.from(io.sockets.sockets.values()).filter(
    (s) => s.data.roomId === room.id && s.data.clientId === cid && !!s.data.isAdmin === targetIsAdmin
  );
}

// 完整狀態（整間房間所有分頁與 CH，約 60KB）：只在分頁增刪、改名、改時間範圍這類少見的操作時送
function broadcastState(room) {
  room.lastActive = Date.now();
  persist.markDirty(room);
  io.to(VIEW(room.id)).emit('state:update', { tabs: room.tabs, serverTime: Date.now() });
  scheduleAdminRooms();
}

// 只送有變動的 CH（每個約 100 bytes）：點 CH、擊殺、回報時間、自動轉換狀態時用，大幅減少流量
function broadcastChannels(room, refs) {
  room.lastActive = Date.now();
  const changes = [];
  refs.forEach(({ tabId, channelIndex }) => {
    const tab = room.tabs.find((t) => t.id === tabId);
    if (tab && tab.channels[channelIndex]) changes.push({ tabId, channelIndex, ch: tab.channels[channelIndex] });
  });
  if (changes.length === 0) return;
  persist.markDirty(room);
  io.to(VIEW(room.id)).emit('channels:update', { changes, serverTime: Date.now() });
  scheduleAdminRooms();
}

function broadcastUsers(room) {
  // 所有人（包含管理者自己）收到的都是同一份「看得見的人」名單，資料裡不會出現隱身相關的欄位
  const visible = roomUserList(room)
    .filter((u) => !u.hidden)
    .map(({ id, name }) => ({ id, name, captain: !!room.captainClientId && clientIdOf(id) === room.captainClientId }));
  io.to(room.id).emit('users:update', visible);
  scheduleAdminRooms();
}

// ---------- 管理者：所有房間列表 ----------
function buildAdminRoomList() {
  return Array.from(rooms.values())
    .map((room) => {
      let activeCount = 0;
      room.tabs.forEach((t) => t.channels.forEach((c) => { if (c.state !== 'idle') activeCount++; }));
      return {
        password: room.password,
        users: roomUserList(room).filter((u) => !u.hidden).map((u) => u.name),
        activeCount,
        createdAt: room.createdAt
      };
    })
    .sort((a, b) => b.users.length - a.users.length || b.activeCount - a.activeCount || b.createdAt - a.createdAt);
}

function sendAdminRooms(socket) {
  socket.emit('admin:rooms', buildAdminRoomList());
}

// 房間狀態變動時，稍微延遲合併後再推送給所有管理者（避免一秒內推很多次）
let adminRoomsTimer = null;
function scheduleAdminRooms() {
  if (adminRoomsTimer) return;
  adminRoomsTimer = setTimeout(() => {
    adminRoomsTimer = null;
    for (const [, s] of io.sockets.sockets) {
      if (s.data.isAdmin) sendAdminRooms(s);
    }
  }, 500);
}

function isMuted(room, socket) {
  if (socket.data.isAdmin) return false;
  const n = normalizeName(socket.data.nickname);
  return room.mutedNicknames.has(n) || room.captainMuted.has(n);
}

// 計時相關的資料（分頁、CH、擊殺、時間點、戰利品、操作紀錄、音效）只送到「可觀看」頻道；
// 被禁止操作的人不在這個頻道裡，所以完全收不到任何計時資料
function VIEW(roomId) { return roomId + '|view'; }

// 依目前禁止狀態，把 socket 放進 / 移出可觀看頻道，並同步畫面
function applyView(room, s, force) {
  const muted = isMuted(room, s);
  const viewing = s.data.viewing === room.id;
  if (!force && muted === !viewing) return;
  if (muted) {
    s.leave(VIEW(room.id));
    s.data.viewing = null;
    const by = room.mutedNicknames.has(normalizeName(s.data.nickname)) ? '管理者' : '隊長';
    s.emit('muted:state', { muted: true, by });
    s.emit('state:init', { tabs: [], serverTime: Date.now() });
    s.emit('log:init', []);
    s.emit('killpoint:init', []);
    s.emit('loot:init', {});
  } else {
    s.join(VIEW(room.id));
    s.data.viewing = room.id;
    s.emit('muted:state', { muted: false });
    s.emit('state:init', { tabs: room.tabs, serverTime: Date.now() });
    s.emit('log:init', room.activityLog);
    s.emit('killpoint:init', room.killPoints);
    s.emit('loot:init', room.loot || {});
  }
}

// 禁止名單有變動時，重新檢查房間內每個人
function refreshViews(room) {
  for (const [, s] of io.sockets.sockets) {
    if (s.data.roomId === room.id) applyView(room, s, false);
  }
}

// 依經過時間決定 CH 狀態：最小值前「倒數中」→ 最小值～最大值「重生區間」→ 超過最大值「出現中」
function stateFor(elapsed, minMs, maxMs) {
  if (elapsed < minMs) return 'counting';
  if (elapsed < maxMs) return 'window';
  return 'appearing';
}
const STATE_ORDER = { idle: 0, counting: 1, window: 2, appearing: 3 };

// 改名時，把「禁止操作」與「隊長名稱」一起轉移到新名字
function transferNameState(room, targetClientId, oldName, newName) {
  const o = normalizeName(oldName);
  const n = normalizeName(newName);
  for (const map of [room.mutedNicknames, room.captainMuted]) {
    if (map.has(o)) { map.delete(o); map.set(n, newName); }
  }
  broadcastAdminMutedList(room);
  refreshViews(room);
  if (room.captainClientId && targetClientId === room.captainClientId) room.captainName = newName;
  broadcastRoomInfo(room);
}

// 房間資訊（隊長名稱）給房間內所有人
function broadcastRoomInfo(room) {
  persist.markDirty(room);
  io.to(room.id).emit('room:info', { captainName: room.captainName });
}

// 隊長看到的「被隊長禁止操作」名單
function sendCaptainMuted(room) {
  persist.markDirty(room);
  const list = Array.from(room.captainMuted.values());
  for (const [, s] of io.sockets.sockets) {
    if (s.data.roomId === room.id && isCaptain(room, s)) s.emit('captain:muted', list);
  }
}

// 被禁止的人嘗試任何操作時，直接擋下並通知他
function guardMuted(room, socket) {
  if (isMuted(room, socket)) {
    socket.emit('error:muted');
    return true;
  }
  return false;
}

function broadcastAdminMutedList(room) {
  const info = Array.from(room.mutedNicknames.values());
  for (const [, s] of io.sockets.sockets) {
    if (s.data.isAdmin && s.data.roomId === room.id) s.emit('admin:mutedList', info);
  }
}

function addLog(room, message, type) {
  persist.markDirty(room);
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    time: Date.now(),
    message,
    type: type || 'user'
  };
  room.activityLog.unshift(entry);
  if (room.activityLog.length > MAX_LOG) room.activityLog.length = MAX_LOG;
  io.to(VIEW(room.id)).emit('log:new', entry);
}

// ---------- 戰利品 ----------
// 各王可記錄的道具（來自 public/drops/drops.json，遊戲的怪物圖鑑戰利品清單）
let DROPS = {};
try { DROPS = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'drops', 'drops.json'), 'utf8')); } catch (e) { console.error('[戰利品] 讀不到 drops.json：', e.message); }
const DROP_ITEMS = {};
Object.entries(DROPS).forEach(([img, b]) => { DROP_ITEMS[img] = new Map((b.drops || []).map((d) => [d.id, d.name])); });
const LOOT_MIN_KILLS = 10; // 房間這隻王擊殺達 10 次以上，才算進全站戰利品統計

// 全站戰利品統計：{ 房間代號: { 王圖檔: { k: 擊殺數, i: { 道具編號: 次數 }, t: 更新時間 } } }
// ---------- 贊助榜 ----------
// 由管理者手動登錄（PayPal / 歐付寶 / 綠界收到款項後，依贊助者備註的暱稱登錄）；每個月（台灣時間）一個排行榜
let donations = []; // [{ id, name, amount, msg, at, via }]
const DONATE_VIA = ['PayPal', '歐付寶', '綠界', '其他'];
const ANON_NAME = '匿名大大';
function monthKey(t) { return new Date(t + 8 * 3600000).toISOString().slice(0, 7); } // YYYY-MM（台灣時間）
function donateBoard(month) {
  const map = new Map();
  donations.filter((d) => monthKey(d.at) === month).sort((a, b) => a.at - b.at).forEach((d) => {
    // 匿名贊助：每一筆各自一行，不公開暱稱
    const k = d.anon ? 'anon:' + d.id : normalizeName(d.name);
    const e = map.get(k) || { name: d.anon ? ANON_NAME : d.name, anon: !!d.anon, amount: 0, msg: '', count: 0, last: 0 };
    e.amount += d.amount; e.count++; e.last = d.at; if (!d.anon) e.name = d.name;
    if (d.msg) e.msg = d.msg;
    map.set(k, e);
  });
  return Array.from(map.values()).sort((a, b) => b.amount - a.amount || a.last - b.last)
    .map(({ name, anon, amount, msg, count }) => ({ name, anon, amount, msg, count }));
}
function donateMonths() {
  const set = new Set(donations.map((d) => monthKey(d.at)));
  set.add(monthKey(Date.now()));
  return Array.from(set).sort().reverse();
}
function saveDonations() { persist.saveDonations(donations).catch((e) => console.error('[贊助] 儲存失敗：', e.message)); }
// 待確認的贊助：[{ id, code, name, amount, msg, via, at }]
let donatePending = [];
const DONATE_PENDING_MAX = 300;
function saveDonatePending() { persist.saveDonatePending(donatePending).catch((e) => console.error('[贊助] 儲存待確認失敗：', e.message)); }
function newDonateCode() {
  for (let i = 0; i < 50; i++) {
    const c = 'M' + String(Math.floor(1000 + Math.random() * 9000));
    if (!donatePending.some((d) => d.code === c)) return c;
  }
  return 'M' + Date.now().toString().slice(-6);
}
const donateIntentLog = new Map(); // clientId/socket -> 最近送出的時間（防洗版）

// ---------- PayPal 付款通知（IPN）：有人付款 → PayPal 主動通知網站 → 自動對應「待確認」並入榜 ----------
// 設定：PayPal 帳戶設定 → 網站付款 → 即時付款通知（IPN）→ 通知網址 https://你的網站/paypal/ipn
// 安全：收到的通知會原封不動送回 PayPal 驗證，PayPal 回覆 VERIFIED 才算數，所以無法偽造。
const IPN_VERIFY_URL = process.env.PAYPAL_IPN_SANDBOX === '1'
  ? 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr'
  : 'https://ipnpb.paypal.com/cgi-bin/webscr';
const PAYPAL_RECEIVER_EMAIL = (process.env.PAYPAL_RECEIVER_EMAIL || '').trim().toLowerCase();
const MATCH_WINDOW_MS = 6 * 3600000; // 只對應 6 小時內送出的「待確認」

// 依 IPN 的 charset 解碼（中文名字 / 備註可能不是 UTF-8）
function parseIpnBody(raw) {
  const pairs = raw.split('&').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return [i < 0 ? kv : kv.slice(0, i), i < 0 ? '' : kv.slice(i + 1)];
  });
  const cs = (pairs.find(([k]) => k === 'charset') || [])[1] || 'utf-8';
  let dec;
  try { dec = new TextDecoder(decodeURIComponent(cs).toLowerCase()); } catch (e) { dec = new TextDecoder('utf-8'); }
  const toStr = (v) => {
    const s0 = v.replace(/\+/g, ' ');
    const bytes = [];
    for (let i = 0; i < s0.length; i++) {
      if (s0[i] === '%' && /^[0-9a-fA-F]{2}$/.test(s0.slice(i + 1, i + 3))) { bytes.push(parseInt(s0.slice(i + 1, i + 3), 16)); i += 2; }
      else { const b = Buffer.from(s0[i], 'utf8'); for (const x of b) bytes.push(x); }
    }
    return dec.decode(Buffer.from(bytes));
  };
  const out = {};
  pairs.forEach(([k, v]) => { out[toStr(k)] = toStr(v); });
  return out;
}

function notifyAdmins(msg) {
  for (const [, s] of io.sockets.sockets) if (s.data.isAdmin) { s.emit('admin:donatePending', donatePending.length); if (msg) s.emit('error:toast', msg); }
}

// 處理一筆「已驗證」的 IPN（拆出來方便測試）
function handlePaypalPayment(f) {
  const status = String(f.payment_status || '');
  const txn = String(f.txn_id || '');
  // 退款 / 撤銷：把那筆贊助從榜上拿掉
  if (/^(Refunded|Reversed|Canceled_Reversal)$/i.test(status) && f.parent_txn_id) {
    const i = donations.findIndex((d) => d.txn === f.parent_txn_id);
    if (i >= 0) { const d = donations.splice(i, 1)[0]; saveDonations(); notifyAdmins(`↩ PayPal 退款：已將「${d.name}」NT$ ${d.amount} 從贊助榜移除`); }
    return 'refund';
  }
  if (status !== 'Completed' || !txn) return 'ignored';
  if (PAYPAL_RECEIVER_EMAIL && String(f.receiver_email || '').toLowerCase() !== PAYPAL_RECEIVER_EMAIL) return 'not-mine';
  if (donations.some((d) => d.txn === txn) || donatePending.some((d) => d.paid && d.paid.txn === txn)) return 'duplicate';

  const gross = Number(f.mc_gross);
  const currency = String(f.mc_currency || '');
  const memo = String(f.memo || f.custom || '').trim();
  const payer = `${f.first_name || ''} ${f.last_name || ''}`.trim() || String(f.payer_email || '');
  const now = Date.now();
  const open = donatePending.filter((p) => !p.paid && now - p.at < MATCH_WINDOW_MS);

  // 1) 備註裡有贊助代碼 → 直接對應；2) 台幣金額一樣 → 先找「已從付款頁返回」的，再找最早送出的
  let match = null;
  const codeM = memo.toUpperCase().match(/M\d{4}/);
  if (codeM) match = open.find((p) => p.code === codeM[0]) || null;
  if (!match && currency === 'TWD' && Number.isFinite(gross)) {
    const same = open.filter((p) => p.amount === Math.round(gross)).sort((a, b) => a.at - b.at);
    match = same.find((p) => p.returnedAt) || same[0] || null;
  }

  if (match) {
    donatePending.splice(donatePending.indexOf(match), 1);
    const amount = currency === 'TWD' && gross >= 1 ? Math.round(gross) : match.amount;
    donations.push({ id: match.id, name: match.name, anon: !!match.anon, amount, msg: match.msg, at: now, via: 'PayPal', txn, auto: true });
    saveDonatePending();
    saveDonations();
    notifyAdmins(`💖 PayPal 自動入榜：${match.anon ? '匿名' + (match.name ? `（${match.name}）` : '') : match.name} NT$ ${amount}`);
    return 'matched';
  }
  // 對應不到（沒先在網站填資料）→ 放進待確認，標示「已收款」，等管理者指定暱稱
  donatePending.push({
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    code: '',
    name: '',
    amount: currency === 'TWD' && gross >= 1 ? Math.round(gross) : 0,
    msg: memo.slice(0, 100),
    via: 'PayPal',
    at: now,
    paid: { txn, payer: payer.slice(0, 60), gross: f.mc_gross, currency }
  });
  saveDonatePending();
  notifyAdmins(`💰 收到 PayPal 款項 ${f.mc_gross} ${currency}（${payer}），但對應不到暱稱，請到贊助管理指定`);
  return 'unmatched';
}

app.post('/paypal/ipn', (req, res) => {
  let raw = '';
  req.setEncoding('latin1'); // 保留原始位元組，原封不動送回 PayPal 驗證
  req.on('data', (c) => { raw += c; if (raw.length > 100000) req.destroy(); });
  req.on('end', async () => {
    res.status(200).end(); // 先回 200，PayPal 才不會一直重送
    try {
      const vr = await fetch(IPN_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'MSCtimer-IPN' },
        body: Buffer.from('cmd=_notify-validate&' + raw, 'latin1')
      });
      const text = (await vr.text()).trim();
      if (text !== 'VERIFIED') { console.warn('[PayPal] IPN 驗證失敗：', text.slice(0, 40)); return; }
      const result = handlePaypalPayment(parseIpnBody(raw));
      console.log('[PayPal] IPN', result);
    } catch (e) {
      console.error('[PayPal] IPN 處理失敗：', e.message);
    }
  });
});
module.exports.__handlePaypalPayment = (f) => handlePaypalPayment(f);
module.exports.__parseIpnBody = parseIpnBody;

let globalLoot = {};
function roomShort(room) { return String(room.id).slice(-6); }
// 被管理者排除的房間（亂點等），之後不再計入：globalLoot._x = [房間代號…]
function lootExcluded() { if (!Array.isArray(globalLoot._x)) globalLoot._x = []; return globalLoot._x; }
function lootRooms() { return Object.keys(globalLoot).filter((k) => k !== '_x'); }
function updateGlobalLoot(room, image) {
  if (!DROP_ITEMS[image]) return;
  if (lootExcluded().includes(roomShort(room))) return;
  const tab = room.tabs.find((t) => t.locked && t.image === image);
  const kills = tab ? (tab.killCount || 0) : 0;
  const key = roomShort(room);
  if (kills >= LOOT_MIN_KILLS) {
    if (!globalLoot[key]) globalLoot[key] = {};
    globalLoot[key][image] = { k: kills, i: { ...(room.loot[image] || {}) }, t: Date.now() };
  } else if (globalLoot[key] && globalLoot[key][image]) {
    delete globalLoot[key][image];
    if (Object.keys(globalLoot[key]).length === 0) delete globalLoot[key];
  } else {
    return;
  }
  persist.markLootDirty(() => globalLoot);
}
function lootStats() {
  const bosses = {};
  lootRooms().forEach((rk) => {
    Object.entries(globalLoot[rk]).forEach(([img, v]) => {
      if (!bosses[img]) bosses[img] = { image: img, name: (DROPS[img] && DROPS[img].name) || img, rooms: 0, kills: 0, items: {} };
      const b = bosses[img];
      b.rooms++; b.kills += v.k || 0;
      Object.entries(v.i || {}).forEach(([id, c]) => { b.items[id] = (b.items[id] || 0) + c; });
    });
  });
  return Object.values(bosses).map((b) => ({
    ...b,
    items: Object.entries(b.items).map(([id, c]) => ({ id: Number(id), name: (DROP_ITEMS[b.image] && DROP_ITEMS[b.image].get(Number(id))) || id, count: c }))
      .sort((x, y) => y.count - x.count)
  })).sort((a, b) => b.kills - a.kills);
}
function lootCsv() {
  const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  const lines = ['王,參與房間數,總擊殺次數,道具編號,道具名稱,記錄掉落次數,掉落率(%)'];
  lootStats().forEach((b) => {
    if (b.items.length === 0) lines.push([q(b.name), b.rooms, b.kills, '', '', 0, ''].join(','));
    b.items.forEach((it) => lines.push([q(b.name), b.rooms, b.kills, it.id, q(it.name), it.count, b.kills ? (it.count / b.kills * 100).toFixed(2) : ''].join(',')));
  });
  return '\ufeff' + lines.join('\r\n');
}

// 全站時間點紀錄（新的在後）
let globalKillPoints = [];

// 判斷五分 / 四分區間（跟 client.js 的規則一樣：在 5 分 / 4 分倍數的正負 30 秒內算符合；兩者都符合時兩邊都 +1）
const KP_TOLERANCE_MS = 30 * 1000;
function kpFits(ms, stepMs) {
  const r = ((ms % stepMs) + stepMs) % stepMs;
  return r <= KP_TOLERANCE_MS || r >= stepMs - KP_TOLERANCE_MS;
}
function kpClass(ms) {
  if (ms < -KP_TOLERANCE_MS) return 'early';
  const f5 = kpFits(ms, 300000), f4 = kpFits(ms, 240000);
  if (f5 && f4) return 'both';
  if (f5) return 'five';
  if (f4) return 'four';
  return 'none';
}
function kpStats() {
  const byBoss = new Map();
  const rooms = new Set();
  const total = { five: 0, four: 0, both: 0, none: 0, early: 0, n: 0 };
  globalKillPoints.forEach((k) => {
    const key = k.i || k.b;
    if (!byBoss.has(key)) byBoss.set(key, { name: k.b, five: 0, four: 0, both: 0, none: 0, early: 0, n: 0, minutes: {} });
    const b = byBoss.get(key);
    b.name = k.b; // 用最新的王名
    const c = kpClass(k.m);
    b.n++; total.n++;
    if (c === 'both') { b.both++; total.both++; }
    if (c === 'five' || c === 'both') { b.five++; total.five++; }
    if (c === 'four' || c === 'both') { b.four++; total.four++; }
    if (c === 'none' || c === 'early') { b[c]++; total[c]++; }
    if (k.m >= 0) { const mi = Math.floor(k.m / 60000); b.minutes[mi] = (b.minutes[mi] || 0) + 1; }
    rooms.add(k.r);
  });
  return {
    total,
    rooms: rooms.size,
    since: globalKillPoints.length ? globalKillPoints[0].t : null,
    max: persist.GLOBAL_KP_MAX,
    bosses: Array.from(byBoss.values()).sort((a, b) => b.n - a.n)
  };
}
function kpCsv() {
  const label = { five: '五分區間', four: '四分區間', both: '五分＋四分區間', none: '都不符合', early: '未到重生' };
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (ms) => { const neg = ms < 0; const s = Math.floor(Math.abs(ms) / 1000); return (neg ? '-' : '') + pad(Math.floor(s / 60)) + ':' + pad(s % 60); };
  const when = (t) => { const d = new Date(t + 8 * 3600000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
  const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  const lines = ['擊殺時間(台灣),王,CH,時間點,時間點(秒),判斷,房間代號'];
  globalKillPoints.forEach((k) => {
    lines.push([q(when(k.t)), q(k.b), k.c, q(fmt(k.m)), Math.round(k.m / 1000), q(label[kpClass(k.m)]), q(k.r)].join(','));
  });
  return '\ufeff' + lines.join('\r\n');
}

// 「時間點」：記錄一次擊殺（ms = 擊殺當下的經過時間 − 最小值；負數代表還沒到重生時間就按了）
function addKillPoint(room, data) {
  // 全站統計（管理者用）：所有房間的每一筆都收集起來，房間清空也不影響
  const g = { t: data.at, b: data.tabName, i: data.image, c: data.channel, m: data.ms, r: String(room.id).slice(-6) };
  globalKillPoints.push(g);
  if (globalKillPoints.length > persist.GLOBAL_KP_MAX) globalKillPoints.splice(0, globalKillPoints.length - persist.GLOBAL_KP_MAX);
  persist.pushKillPoint(g);
  delete data.image;
  const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...data };
  room.killPoints.unshift(entry);
  if (room.killPoints.length > MAX_KILL_POINTS) room.killPoints.length = MAX_KILL_POINTS;
  persist.markDirty(room);
  io.to(VIEW(room.id)).emit('killpoint:new', entry);
}

function roomHasActiveChannels(room) {
  return room.tabs.some((t) => t.channels.some((c) => c.state !== 'idle'));
}

// 讓 socket 離開目前所在的房間（換房間或斷線時）
function leaveCurrentRoom(socket) {
  const room = getRoom(socket);
  if (!room) return;
  socket.leave(room.id);
  socket.leave(VIEW(room.id));
  socket.data.viewing = null;
  room.connectedUsers.delete(socket.id);
  room.lastActive = Date.now();
  socket.data.roomId = null;
  broadcastUsers(room);
}

// 每秒檢查所有房間所有 CH 是否跨過 min / max 門檻（自動觸發，不寫入操作紀錄）
// 流程：倒數中 -> (到最小值) 出現中 -> (到最大值後再保留 10 分鐘) 恢復待機
function tick() {
  const now = Date.now();

  for (const room of rooms.values()) {
    const changed = []; // 這一秒有變動的 CH

    for (const tab of room.tabs) {
      tab.channels.forEach((ch, idx) => {
        if (ch.state === 'idle' || ch.startTime === null) return;

        const minMs = (ch.customMin ?? tab.minMinutes) * 60000;
        const maxMs = (ch.customMax ?? tab.maxMinutes) * 60000;
        const elapsed = now - ch.startTime;

        if (elapsed >= maxMs + APPEAR_HOLD_MS) {
          ch.state = 'idle';
          ch.startTime = null;
          ch.startedBy = null;
          ch.standby = null;
          changed.push({ tabId: tab.id, channelIndex: idx });
        } else {
          const target = stateFor(elapsed, minMs, maxMs);
          if (STATE_ORDER[target] > STATE_ORDER[ch.state]) {
            ch.state = target;
            changed.push({ tabId: tab.id, channelIndex: idx });
            // 進入重生區間、進入出現中都會提醒
            io.to(VIEW(room.id)).emit('channelAlert', { tabId: tab.id, channelIndex: idx, kind: target });
          }
        }
      });
    }

    if (changed.length) broadcastChannels(room, changed);
  }
}

setInterval(tick, 1000);

// 每 10 分鐘清掉「沒人在線、也沒有進行中 CH」且閒置太久的房間
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    if (room.connectedUsers.size === 0 && !roomHasActiveChannels(room) && now - room.lastActive > EMPTY_ROOM_TTL_MS) {
      rooms.delete(id);
      persist.removeRoom(id);
      scheduleAdminRooms();
    }
  }
}, 10 * 60 * 1000);

io.on('connection', (socket) => {
  socket.emit('server:version', SITE_VERSION);
  // ---------- 進入房間（暱稱 + 房間密碼） ----------
  // 同一個密碼 = 同一個房間；密碼對應的房間不存在時會自動建立。
  socket.on('joinRoom', (payload) => {
    const { nickname, password, clientId } = payload || {};
    if (typeof clientId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(clientId)) socket.data.clientId = clientId;
    const trimmedName = (typeof nickname === 'string' ? nickname : '').trim().slice(0, 20);
    const pw = (typeof password === 'string' ? password : '').trim();

    if (!trimmedName) {
      socket.emit('join:error', { field: 'nickname', message: '請輸入暱稱' });
      return;
    }
    if (!pw) {
      socket.emit('join:error', { field: 'password', message: '請輸入房間密碼' });
      return;
    }
    if (!PASSWORD_RE.test(pw)) {
      socket.emit('join:error', { field: 'password', message: '房間密碼必須剛好 6 個字元，只能使用英文大小寫或數字' });
      return;
    }

    const roomId = roomIdFromPassword(pw);
    const existing = rooms.get(roomId);

    if (existing) {
      if (existing.bannedNicknames.has(normalizeName(trimmedName))) {
        socket.emit('join:error', { field: 'nickname', code: 'banned', message: '這個暱稱已被管理者移出此房間，請使用其他暱稱' });
        return;
      }
      if (isNicknameTaken(existing, trimmedName, socket.id, !!socket.data.isAdmin, socket.data.clientId)) {
        socket.emit('join:error', { field: 'nickname', code: 'taken', message: '這個暱稱在此房間已經有人在使用，請換一個' });
        return;
      }
      // 人數上限：管理者不受限制；已經在房間裡的同一個人（同瀏覽器、同暱稱，例如重新整理）也不會被擋
      if (!socket.data.isAdmin) {
        const alreadyIn = roomUserList(existing).some(
          (u) => !u.hidden && socket.data.clientId && clientIdOf(u.id) === socket.data.clientId && normalizeName(u.name) === normalizeName(trimmedName)
        );
        if (!alreadyIn && visibleUserCount(existing) >= MAX_ROOM_USERS) {
          socket.emit('join:error', { field: 'password', code: 'full', message: `這個房間已滿（最多 ${MAX_ROOM_USERS} 人），請稍後再試或換一個房間` });
          return;
        }
      }
    }

    // 如果原本在別的房間，先離開
    if (socket.data.roomId && socket.data.roomId !== roomId) leaveCurrentRoom(socket);

    const created = !existing;
    const room = existing || createRoom(roomId, pw);
    if (created) rooms.set(roomId, room);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.nickname = trimmedName;
    socket.data.joinedAt = Date.now();
    room.connectedUsers.set(socket.id, trimmedName);
    room.lastActive = Date.now();

    // 建立房間的人成為隊長（管理者隱身不當隊長；由管理者建立的房間，第一個進來的一般使用者成為隊長）
    if (!room.captainClientId && !socket.data.isAdmin && socket.data.clientId) {
      room.captainClientId = socket.data.clientId;
    }
    if (isCaptain(room, socket)) room.captainName = trimmedName; // 隊長回來時以目前暱稱更新
    if (created) persist.markDirty(room);

    socket.emit('join:ack', { nickname: trimmedName, created, captain: isCaptain(room, socket) });
    socket.data.viewing = null;
    applyView(room, socket, true);
    if (socket.data.isAdmin) socket.emit('admin:mutedList', Array.from(room.mutedNicknames.values()));
    if (isCaptain(room, socket)) socket.emit('captain:muted', Array.from(room.captainMuted.values()));
    broadcastRoomInfo(room);
    broadcastUsers(room);
  });

  // ---------- 隊長：禁止 / 解除禁止隊員操作（只限這間房間，以暱稱判斷，離線再回來仍有效） ----------
  socket.on('captainMute', ({ nickname } = {}) => {
    const room = getRoom(socket);
    if (!room || !isCaptain(room, socket) || isMuted(room, socket) || typeof nickname !== 'string' || !nickname.trim()) return;
    const n = normalizeName(nickname);
    if (n === normalizeName(socket.data.nickname)) return; // 不能禁止自己
    // 只能禁止目前在房間裡的隊員（不含隱身的管理者）
    const member = roomUserList(room).find((u) => !u.hidden && normalizeName(u.name) === n);
    if (!member) return;
    room.captainMuted.set(n, member.name);
    sendCaptainMuted(room);
    refreshViews(room);
    addLog(room, `隊長「${socket.data.nickname}」禁止「${member.name}」進行操作`, 'admin');
  });

  socket.on('captainUnmute', ({ nickname } = {}) => {
    const room = getRoom(socket);
    if (!room || !isCaptain(room, socket) || isMuted(room, socket) || typeof nickname !== 'string') return;
    const n = normalizeName(nickname);
    const original = room.captainMuted.get(n);
    if (!original) return;
    room.captainMuted.delete(n);
    sendCaptainMuted(room);
    refreshViews(room);
    addLog(room, `隊長「${socket.data.nickname}」解除了「${original}」的操作禁止`, 'admin');
  });

  // 產生一組隨機房間密碼（符合規則，且不會跟目前已存在的房間重複）
  // ---------- 計時匯出 / 匯入（隊長才能用；隱身的管理者也能用，但不寫進操作紀錄） ----------
  function canTransferTimers(room) {
    return !!room && (socket.data.isAdmin || isCaptain(room, socket)) && !isMuted(room, socket);
  }

  // 先問一下有沒有權限（按鈕大家都看得到，按下去才檢查）
  socket.on('timerTransfer:perm', (cb) => {
    if (typeof cb !== 'function') return;
    const room = getRoom(socket);
    cb({ ok: canTransferTimers(room) });
  });

  socket.on('exportTimers', (cb) => {
    if (typeof cb !== 'function') return;
    const room = getRoom(socket);
    if (!canTransferTimers(room)) return cb({ error: '只有隊長可以匯出計時' });
    let count = 0;
    const out = { v: 1, t: Date.now(), tabs: [] };
    room.tabs.forEach((tab) => {
      const ch = [];
      tab.channels.forEach((c, idx) => {
        if (c.state === 'idle' || c.startTime === null) return;
        ch.push([idx, c.startTime, c.startedBy || null, c.customMin ?? null, c.customMax ?? null]);
      });
      if (ch.length === 0) return;
      count += ch.length;
      // 預設王用圖片檔名對應（不同房間的分頁編號不一樣），自訂分頁用名稱對應
      out.tabs.push({ k: tab.locked && tab.image ? 'p:' + tab.image : 'c:' + tab.name, n: tab.name, mn: tab.minMinutes, mx: tab.maxMinutes, ch });
    });
    const code = encryptExport(out);
    if (!socket.data.isAdmin) addLog(room, `隊長「${socket.data.nickname}」匯出了目前房間的計時（${count} 個 CH）`, 'admin');
    cb({ code, count });
  });

  // 文字版時間表：內容由瀏覽器依當地時間產生，這裡只負責檢查權限與寫操作紀錄
  socket.on('exportTimersText', (cb) => {
    if (typeof cb !== 'function') return;
    const room = getRoom(socket);
    if (!canTransferTimers(room)) return cb({ error: '只有隊長可以匯出計時' });
    if (!socket.data.isAdmin) addLog(room, `隊長「${socket.data.nickname}」匯出了目前房間的時間表（文字）`, 'admin');
    cb({ ok: true });
  });

  socket.on('importTimers', ({ code } = {}, cb) => {
    if (typeof cb !== 'function') return;
    const room = getRoom(socket);
    if (!canTransferTimers(room)) return cb({ error: '只有隊長可以匯入計時' });
    if (guardMuted(room, socket)) return cb({ error: '您已被禁止操作' });
    let data;
    try { data = decryptExport(code); } catch (e) { return cb({ error: '匯入碼無效或已損毀（只能匯入本網站匯出的計時）' }); }
    if (!data || data.v !== 1 || !Array.isArray(data.tabs)) return cb({ error: '匯入碼格式不正確' });

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    // 匯入 = 取代整間房間目前的計時
    room.tabs.forEach((t) => { t.channels = Array.from({ length: CHANNEL_COUNT }, createChannel); });

    let count = 0;
    data.tabs.slice(0, 100).forEach((it) => {
      if (!it || typeof it.k !== 'string' || !Array.isArray(it.ch)) return;
      let tab;
      if (it.k.startsWith('p:')) {
        tab = room.tabs.find((t) => t.locked && t.image === it.k.slice(2));
      } else {
        const name = String(it.n || it.k.slice(2) || '').trim().slice(0, 30);
        if (!name) return;
        tab = room.tabs.find((t) => !t.locked && t.name === name);
        if (!tab) {
          const mn = Number(it.mn) > 0 ? Number(it.mn) : 45;
          const mx = Math.max(mn, Number(it.mx) > 0 ? Number(it.mx) : 60);
          tab = createTab(name, mn, mx, null, false);
          room.tabs.push(tab);
        }
      }
      if (!tab) return;
      it.ch.forEach((row) => {
        if (!Array.isArray(row)) return;
        const [idx, startTime, startedBy, cMin, cMax] = row;
        if (!Number.isInteger(idx) || idx < 0 || idx >= CHANNEL_COUNT) return;
        if (!Number.isFinite(startTime) || startTime > now + 7 * DAY || startTime < now - 30 * DAY) return;
        const ch = createChannel();
        ch.startTime = startTime;
        ch.startedBy = typeof startedBy === 'string' ? startedBy.slice(0, 20) : null;
        ch.customMin = Number.isFinite(cMin) && cMin > 0 ? cMin : null;
        ch.customMax = Number.isFinite(cMax) && cMax > 0 ? cMax : null;
        const minMs = (ch.customMin ?? tab.minMinutes) * 60000;
        const maxMs = (ch.customMax ?? tab.maxMinutes) * 60000;
        const elapsed = now - startTime;
        if (elapsed >= maxMs + APPEAR_HOLD_MS) return; // 已經過期的不匯入（維持待機）
        ch.state = stateFor(elapsed, minMs, maxMs);
        tab.channels[idx] = ch;
        count++;
      });
    });

    broadcastState(room);
    if (!socket.data.isAdmin) addLog(room, `隊長「${socket.data.nickname}」匯入了計時（${count} 個 CH，取代原本的計時）`, 'admin');
    cb({ ok: true, count });
  });

  socket.on('generateRoomPassword', (cb) => {
    if (typeof cb !== 'function') return;
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let attempt = 0; attempt < 50; attempt++) {
      let pw = '';
      for (let i = 0; i < 6; i++) pw += CHARS[crypto.randomInt(CHARS.length)];
      if (!rooms.has(roomIdFromPassword(pw))) return cb(pw);
    }
    cb(null);
  });

  socket.on('leaveRoom', () => {
    leaveCurrentRoom(socket);
  });

  // （隊長改名功能已移除：暱稱只能取一次，只有管理者可以修改）

  // 只用於管理者修改自己的暱稱（一般使用者暱稱設定後無法自行更改）
  socket.on('setNickname', (name) => {
    const room = getRoom(socket);
    if (!room || !socket.data.isAdmin) return;
    const trimmed = (name || '').trim().slice(0, 20);
    if (!trimmed) return;
    if (isNicknameTaken(room, trimmed, socket.id, true, socket.data.clientId)) {
      socket.emit('error:toast', '這個暱稱在此房間已經有人在使用');
      return;
    }
    socket.data.nickname = trimmed;
    room.connectedUsers.set(socket.id, trimmed);
    socket.emit('forceNickname', trimmed);
    broadcastUsers(room);
  });

  // ---------- 管理者驗證 ----------
  socket.on('adminAuth', (key) => {
    const ok = isAdminKey(key);
    socket.data.isAdmin = ok;
    socket.emit('adminAuth:result', ok);
    const room = getRoom(socket);
    if (ok && room) socket.emit('admin:mutedList', Array.from(room.mutedNicknames.values()));
    if (ok) sendAdminRooms(socket);
    if (room) broadcastUsers(room); // 驗證成功後立刻從其他人的線上名單消失
  });

  // 管理者強制修改「同房間、目前仍連線中」某個使用者的暱稱
  socket.on('adminRenameUser', ({ targetSocketId, newName } = {}) => {
    const room = getRoom(socket);
    if (!room || !socket.data.isAdmin) return;
    const trimmed = (newName || '').trim().slice(0, 20);
    if (!trimmed) return;
    const targets = sameClientSocketsInRoom(room, targetSocketId);
    if (targets.length === 0) return;

    const oldName = targets[0].data.nickname;
    targets.forEach((t) => {
      t.data.nickname = trimmed;
      room.connectedUsers.set(t.id, trimmed);
      t.emit('forceNickname', trimmed);
    });
    transferNameState(room, targets[0].data.clientId, oldName, trimmed);
    sendCaptainMuted(room);
    broadcastUsers(room);
    addLog(room, `管理者將「${oldName}」的暱稱改為「${trimmed}」`, 'admin');
  });

  // 管理者禁止 / 解除禁止某位使用者操作（依暱稱判斷，對方離線後重新連線也一樣有效；只限此房間）
  socket.on('adminMuteUser', ({ nickname } = {}) => {
    const room = getRoom(socket);
    if (!room || !socket.data.isAdmin || !nickname) return;
    room.mutedNicknames.set(normalizeName(nickname), nickname);
    broadcastAdminMutedList(room);
    refreshViews(room);
    addLog(room, `管理者禁止「${nickname}」進行任何操作`, 'admin');
  });

  socket.on('adminUnmuteUser', ({ nickname } = {}) => {
    const room = getRoom(socket);
    if (!room || !socket.data.isAdmin || !nickname) return;
    if (room.mutedNicknames.delete(normalizeName(nickname))) {
      broadcastAdminMutedList(room);
      refreshViews(room);
      addLog(room, `管理者解除了「${nickname}」的操作禁止`, 'admin');
    }
  });

  // 管理者移除成員：中斷連線 + 禁止該暱稱再進入此房間
  // 把某人（含同一瀏覽器的其他分頁）移出房間；ban=true 時此暱稱之後不能再進入
  function kickFromRoom(room, targetSocketId, by, ban, nickname) {
    if (ban && nickname) { room.bannedNicknames.add(normalizeName(nickname)); persist.markDirty(room); }
    sameClientSocketsInRoom(room, targetSocketId).forEach((t) => {
      if (ban) t.emit('removedByAdmin');
      else t.emit('kicked', { by });
      leaveCurrentRoom(t);
      t.disconnect(true);
    });
    room.connectedUsers.delete(targetSocketId);
    broadcastUsers(room);
  }

  // 管理者移出玩家：預設只移出（之後可用同暱稱再進來）；ban=true 為封鎖（此暱稱不能再進入）
  socket.on('adminRemoveUser', ({ targetSocketId, nickname, ban } = {}) => {
    const room = getRoom(socket);
    if (!room || !socket.data.isAdmin || !nickname) return;
    kickFromRoom(room, targetSocketId, '管理者', !!ban, nickname);
    addLog(room, ban ? `管理者封鎖了「${nickname}」（此暱稱無法再進入）` : `管理者將「${nickname}」移出房間`, 'admin');
  });

  // 管理者解除封鎖暱稱
  socket.on('adminUnbanUser', ({ nickname } = {}) => {
    const room = getRoom(socket);
    if (!room || !socket.data.isAdmin || typeof nickname !== 'string') return;
    if (room.bannedNicknames.delete(normalizeName(nickname))) {
      persist.markDirty(room);
      socket.emit('admin:bannedList', Array.from(room.bannedNicknames));
      addLog(room, `管理者解除封鎖「${nickname}」`, 'admin');
    }
  });
  socket.on('adminBannedList', (cb) => {
    const room = getRoom(socket);
    if (typeof cb !== 'function' || !room || !socket.data.isAdmin) return;
    cb(Array.from(room.bannedNicknames));
  });

  // 隊長移出隊員（之後可用同暱稱再進來；不能移出自己與管理者）
  socket.on('captainKick', ({ targetSocketId } = {}) => {
    const room = getRoom(socket);
    if (!room || !isCaptain(room, socket) || isMuted(room, socket)) return;
    const target = io.sockets.sockets.get(targetSocketId);
    if (!target || target.data.roomId !== room.id || target.data.isAdmin) return;
    if (target.data.clientId && target.data.clientId === socket.data.clientId) return;
    const name = target.data.nickname || '';
    kickFromRoom(room, targetSocketId, '隊長', false, name);
    addLog(room, `隊長「${socket.data.nickname}」將「${name}」移出房間`, 'admin');
  });

  // 管理者刪除單筆操作紀錄
  socket.on('adminDeleteLogEntry', (logId) => {
    const room = getRoom(socket);
    if (!room || !socket.data.isAdmin) return;
    const idx = room.activityLog.findIndex((e) => e.id === logId);
    if (idx !== -1) {
      room.activityLog.splice(idx, 1);
      persist.markDirty(room);
      io.to(VIEW(room.id)).emit('log:remove', logId);
    }
  });

  // 記錄一次戰利品（任何人；從「戰利品」目錄點道具）
  socket.on('lootRecord', ({ image, itemId } = {}, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const room = requireRoom();
    if (!room) return reply({ error: '無法記錄' });
    const id = Number(itemId);
    const items = DROP_ITEMS[image];
    if (!items || !items.has(id)) return reply({ error: '這不是這隻王的戰利品' });
    if (!room.loot[image]) room.loot[image] = {};
    const count = (room.loot[image][id] || 0) + 1;
    room.loot[image][id] = count;
    persist.markDirty(room);
    io.to(VIEW(room.id)).emit('loot:update', { image, itemId: id, count });
    addLog(room, `${socket.data.nickname} 記錄了「${(DROPS[image] && DROPS[image].name) || ''}」掉落：${items.get(id)}（第 ${count} 個）`, 'start');
    updateGlobalLoot(room, image);
    reply({ ok: true, count });
  });

  // 減少一次戰利品紀錄（記錯時用；任何人可操作，會寫進操作紀錄）
  socket.on('lootUndo', ({ image, itemId } = {}) => {
    const room = requireRoom();
    if (!room) return;
    const id = Number(itemId);
    if (!room.loot[image] || !room.loot[image][id]) return;
    const count = room.loot[image][id] - 1;
    if (count > 0) room.loot[image][id] = count; else delete room.loot[image][id];
    if (Object.keys(room.loot[image]).length === 0) delete room.loot[image];
    persist.markDirty(room);
    io.to(VIEW(room.id)).emit('loot:update', { image, itemId: id, count: Math.max(0, count) });
    const name = DROP_ITEMS[image] ? DROP_ITEMS[image].get(id) : id;
    addLog(room, `${socket.data.nickname} 將「${(DROPS[image] && DROPS[image].name) || ''}」的 ${name} 紀錄 -1`, 'stop');
    updateGlobalLoot(room, image);
  });

  // 清空本房間戰利品紀錄（隊長或管理者）
  socket.on('lootClear', (cb) => {
    const room = getRoom(socket);
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!canTransferTimers(room)) return reply({ error: '只有隊長可以清空戰利品紀錄' });
    const imgs = Object.keys(room.loot || {});
    room.loot = {};
    persist.markDirty(room);
    io.to(VIEW(room.id)).emit('loot:init', {});
    if (!socket.data.isAdmin) addLog(room, `${socket.data.nickname} 清空了戰利品紀錄`, 'user');
    // 這間房間在全站統計裡的資料也一起移除（避免擊殺數留著、掉落歸零造成掉率失真）
    const key = roomShort(room);
    if (globalLoot[key] && key !== '_x') { delete globalLoot[key]; persist.markLootDirty(() => globalLoot); }
    reply({ ok: true, cleared: imgs.length });
  });

  // 管理者：全站戰利品統計 / CSV / 清空
  socket.on('adminLootStats', (cb) => {
    if (typeof cb !== 'function' || !socket.data.isAdmin) return;
    // 各房間明細（給管理者單獨刪除）
    const byShort = new Map(); rooms.forEach((r) => byShort.set(roomShort(r), r));
    const roomList = lootRooms().map((rk) => {
      const r = byShort.get(rk);
      return {
        key: rk,
        password: r ? r.password : null,
        bosses: Object.entries(globalLoot[rk]).map(([img, v]) => ({
          name: (DROPS[img] && DROPS[img].name) || img, kills: v.k || 0,
          items: Object.values(v.i || {}).reduce((a, c) => a + c, 0), t: v.t
        }))
      };
    });
    const excluded = lootExcluded().map((rk) => ({ key: rk, password: byShort.get(rk) ? byShort.get(rk).password : null }));
    cb({ minKills: LOOT_MIN_KILLS, rooms: roomList.length, bosses: lootStats(), roomList, excluded });
  });
  // 管理者：從全站戰利品統計刪除某間房間，並排除（之後不再計入）；或恢復計入
  socket.on('adminLootRemoveRoom', ({ key } = {}, cb) => {
    if (!socket.data.isAdmin || typeof key !== 'string') return;
    delete globalLoot[key];
    const ex = lootExcluded();
    if (!ex.includes(key)) ex.push(key);
    persist.markLootDirty(() => globalLoot);
    if (typeof cb === 'function') cb({ ok: true });
  });
  socket.on('adminLootRestoreRoom', ({ key } = {}, cb) => {
    if (!socket.data.isAdmin || typeof key !== 'string') return;
    globalLoot._x = lootExcluded().filter((k) => k !== key);
    // 若房間還在，馬上把目前資料重新算進來
    const r = Array.from(rooms.values()).find((x) => roomShort(x) === key);
    if (r) Object.keys(DROP_ITEMS).forEach((img) => updateGlobalLoot(r, img));
    persist.markLootDirty(() => globalLoot);
    if (typeof cb === 'function') cb({ ok: true });
  });
  socket.on('adminLootCsv', (cb) => {
    if (typeof cb !== 'function' || !socket.data.isAdmin) return;
    cb({ csv: lootCsv() });
  });
  socket.on('adminClearLootStats', async (cb) => {
    if (!socket.data.isAdmin) return;
    globalLoot = {};
    try { await persist.clearLootStats(); } catch (e) { console.error('[保存] 清空戰利品統計失敗：', e.message); }
    if (typeof cb === 'function') cb({ ok: true });
  });

  // 清空「時間點」紀錄（隊長或管理者；隊長操作會寫進操作紀錄）
  socket.on('clearKillPoints', (cb) => {
    const room = getRoom(socket);
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!canTransferTimers(room)) return reply({ error: '只有隊長可以清空時間點紀錄' });
    room.killPoints = [];
    persist.markDirty(room);
    io.to(VIEW(room.id)).emit('killpoint:init', []);
    if (!socket.data.isAdmin) addLog(room, `${socket.data.nickname} 清空了時間點紀錄`, 'user');
    reply({ ok: true });
  });

  // 管理者：全站時間點統計 / 下載 CSV / 清空
  // ---------- 贊助榜（任何人都可以看；只有管理者可以登錄 / 刪除） ----------
  socket.on('donateBoard', ({ month } = {}, cb) => {
    if (typeof cb !== 'function') return;
    const months = donateMonths();
    const m = typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) ? month : monthKey(Date.now());
    cb({ month: m, current: monthKey(Date.now()), months, board: donateBoard(m) });
  });
  // 贊助者付款前先在網站填好：暱稱、金額、想說的話 → 拿到一組代碼，管理者對帳後確認入榜
  socket.on('donateIntent', ({ name, amount, msg, via, anon } = {}, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const n = (typeof name === 'string' ? name : '').trim().slice(0, 20);
    const amt = Math.round(Number(amount));
    if (!n && !anon) return reply({ error: '請輸入暱稱' });
    if (!Number.isFinite(amt) || amt < 1 || amt > 1000000) return reply({ error: '請輸入正確的金額' });
    const key = socket.data.clientId || socket.id;
    const now = Date.now();
    const recent = (donateIntentLog.get(key) || []).filter((t) => now - t < 10 * 60000);
    if (recent.length >= 5) return reply({ error: '送出太多次了，請稍後再試' });
    recent.push(now);
    donateIntentLog.set(key, recent);
    const entry = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      code: newDonateCode(),
      name: n, anon: !!anon, amount: amt,
      msg: (typeof msg === 'string' ? msg : '').trim().slice(0, 100),
      via: DONATE_VIA.includes(via) ? via : '其他',
      at: now
    };
    donatePending.push(entry);
    if (donatePending.length > DONATE_PENDING_MAX) donatePending.splice(0, donatePending.length - DONATE_PENDING_MAX);
    saveDonatePending();
    for (const [, s] of io.sockets.sockets) if (s.data.isAdmin) s.emit('admin:donatePending', donatePending.length);
    reply({ ok: true, code: entry.code });
  });

  // 贊助者從付款頁自動跳回網站（只是「可能已付款」的提示，任何人都能打開這個網址，所以不會自動入榜）
  socket.on('donateReturned', ({ code } = {}) => {
    if (typeof code !== 'string') return;
    const p = donatePending.find((d) => d.code === code);
    if (!p || p.returnedAt) return;
    p.returnedAt = Date.now();
    saveDonatePending();
    for (const [, s] of io.sockets.sockets) if (s.data.isAdmin) s.emit('admin:donatePending', donatePending.length);
  });

  socket.on('adminDonateList', (cb) => {
    if (typeof cb !== 'function' || !socket.data.isAdmin) return;
    cb({
      list: donations.slice().sort((a, b) => b.at - a.at).slice(0, 300),
      pending: donatePending.slice().sort((a, b) => b.at - a.at)
    });
  });
  // 確認待確認的贊助（可修正實際收到的金額）→ 入榜
  socket.on('adminDonateConfirm', ({ id, amount, name, anon } = {}, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!socket.data.isAdmin) return reply({ error: '沒有權限' });
    const i = donatePending.findIndex((d) => d.id === id);
    if (i < 0) return reply({ error: '找不到這筆' });
    const p = donatePending[i];
    const amt = amount === undefined ? p.amount : Math.round(Number(amount));
    if (!Number.isFinite(amt) || amt < 1 || amt > 1000000) return reply({ error: '金額不正確' });
    const nm = (typeof name === 'string' && name.trim() ? name.trim() : p.name || '').slice(0, 20);
    const isAnon = anon === undefined ? (!!p.anon || !nm) : !!anon;
    if (!nm && !isAnon) return reply({ error: '請輸入暱稱' });
    donatePending.splice(i, 1);
    const entry = { id: p.id, name: nm, anon: isAnon, amount: amt, msg: p.msg, at: Date.now(), via: p.via };
    if (p.paid) entry.txn = p.paid.txn;
    donations.push(entry);
    saveDonatePending();
    saveDonations();
    reply({ ok: true });
  });
  socket.on('adminDonatePendingDelete', ({ id } = {}, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!socket.data.isAdmin) return reply({ error: '沒有權限' });
    const i = donatePending.findIndex((d) => d.id === id);
    if (i < 0) return reply({ error: '找不到這筆' });
    donatePending.splice(i, 1);
    saveDonatePending();
    reply({ ok: true });
  });
  socket.on('adminDonateAdd', ({ name, amount, msg, at, via, anon } = {}, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!socket.data.isAdmin) return reply({ error: '沒有權限' });
    const n = (typeof name === 'string' ? name : '').trim().slice(0, 20);
    const amt = Math.round(Number(amount));
    if (!n && !anon) return reply({ error: '請輸入暱稱（或勾選匿名）' });
    if (!Number.isFinite(amt) || amt < 1 || amt > 1000000) return reply({ error: '金額不正確' });
    let t = Number(at);
    if (!Number.isFinite(t) || t <= 0 || t > Date.now() + 86400000) t = Date.now();
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: n, anon: !!anon || !n, amount: amt,
      msg: (typeof msg === 'string' ? msg : '').trim().slice(0, 100),
      at: t,
      via: DONATE_VIA.includes(via) ? via : '其他'
    };
    donations.push(entry);
    saveDonations();
    reply({ ok: true, entry });
  });
  socket.on('adminDonateDelete', ({ id } = {}, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!socket.data.isAdmin) return reply({ error: '沒有權限' });
    const i = donations.findIndex((d) => d.id === id);
    if (i < 0) return reply({ error: '找不到這筆' });
    donations.splice(i, 1);
    saveDonations();
    reply({ ok: true });
  });

  // 管理者：全站所有線上使用者（同一瀏覽器同暱稱的多個分頁只算一人；不含隱身的管理者）
  socket.on('adminOnlineUsers', (cb) => {
    if (typeof cb !== 'function' || !socket.data.isAdmin) return;
    const users = [];
    for (const room of rooms.values()) {
      roomUserList(room).filter((u) => !u.hidden).forEach((u) => {
        const s0 = io.sockets.sockets.get(u.id);
        const cid = s0 && s0.data.clientId;
        const same = Array.from(io.sockets.sockets.values()).filter((s) =>
          s.data.roomId === room.id && !s.data.isAdmin && (cid ? s.data.clientId === cid : s.id === u.id) && normalizeName(s.data.nickname) === normalizeName(u.name));
        const since = Math.min(...same.map((s) => s.data.joinedAt || Date.now()));
        users.push({
          name: u.name,
          room: room.password,
          captain: !!room.captainClientId && cid === room.captainClientId,
          muted: room.mutedNicknames.has(normalizeName(u.name)) ? 'admin' : (room.captainMuted.has(normalizeName(u.name)) ? 'captain' : null),
          tabs: same.length || 1,
          since
        });
      });
    }
    let lobby = 0;
    for (const [, s] of io.sockets.sockets) if (!s.data.isAdmin && !s.data.roomId) lobby++;
    users.sort((a, b) => a.room.localeCompare(b.room) || a.since - b.since);
    cb({ users, lobby, rooms: new Set(users.map((u) => u.room)).size, now: Date.now() });
  });

  socket.on('adminKillStats', (cb) => {
    if (typeof cb !== 'function' || !socket.data.isAdmin) return;
    cb(kpStats());
  });
  socket.on('adminKillStatsCsv', (cb) => {
    if (typeof cb !== 'function' || !socket.data.isAdmin) return;
    cb({ csv: kpCsv() });
  });
  socket.on('adminClearKillStats', async (cb) => {
    if (!socket.data.isAdmin) return;
    globalKillPoints = [];
    try { await persist.clearKillPoints(); } catch (e) { console.error('[保存] 清空時間點統計失敗：', e.message); }
    if (typeof cb === 'function') cb({ ok: true });
  });

  // 管理者清空此房間全部操作紀錄
  socket.on('adminClearLog', () => {
    const room = getRoom(socket);
    if (!room || !socket.data.isAdmin) return;
    room.activityLog = [];
    io.to(VIEW(room.id)).emit('log:clear');
    addLog(room, '管理者清空了所有操作紀錄', 'admin');
  });

  // 以下所有操作都必須先進入房間
  function requireRoom() {
    const room = getRoom(socket);
    if (!room || !socket.data.nickname) {
      socket.emit('error:needNickname');
      return null;
    }
    if (guardMuted(room, socket)) return null;
    return room;
  }

  // ---------- 分頁 ----------
  socket.on('addTab', (name) => {
    const room = requireRoom();
    if (!room) return;
    room.tabs.push(createTab(typeof name === 'string' ? name : '', 45, 60, null, false));
    broadcastState(room);
  });

  socket.on('removeTab', (tabId) => {
    const room = requireRoom();
    if (!room) return;
    const tab = findTab(room, tabId);
    if (!tab || tab.locked) return; // 鎖定的分頁不可刪除
    if (room.tabs.length <= 1) return;
    room.tabs = room.tabs.filter((t) => t.id !== tabId);
    broadcastState(room);
  });

  socket.on('renameTab', ({ tabId, name } = {}) => {
    const room = requireRoom();
    if (!room) return;
    const tab = findTab(room, tabId);
    if (tab && typeof name === 'string' && name.trim()) {
      tab.name = name.trim();
      broadcastState(room);
    }
  });

  socket.on('updateTabRange', ({ tabId, minMinutes, maxMinutes } = {}) => {
    const room = requireRoom();
    if (!room) return;
    const tab = findTab(room, tabId);
    if (!tab || tab.locked) return; // 鎖定的分頁不可修改最小值/最大值
    const min = Number(minMinutes);
    const max = Number(maxMinutes);
    if (Number.isFinite(min) && min > 0) tab.minMinutes = min;
    if (Number.isFinite(max) && max > 0) tab.maxMinutes = max;
    if (tab.maxMinutes < tab.minMinutes) tab.maxMinutes = tab.minMinutes;
    broadcastState(room);
  });

  // ---------- CH 左鍵：idle -> 開始計時；計時中再點 -> 手動提前重置 ----------
  socket.on('channelClick', ({ tabId, channelIndex } = {}) => {
    const room = requireRoom();
    if (!room) return;
    const nickname = socket.data.nickname;
    const tab = findTab(room, tabId);
    if (!tab) return;
    const ch = tab.channels[channelIndex];
    if (!ch) return;

    if (ch.state === 'idle') {
      ch.state = 'counting';
      ch.startTime = Date.now();
      ch.startedBy = nickname;
      ch.standby = null;
      addLog(room, `${nickname} 在「${tab.name}」啟動了 CH${channelIndex + 1} 倒數`, 'start');
    } else {
      ch.state = 'idle';
      ch.startTime = null;
      ch.startedBy = null;
      ch.standby = null;
      addLog(room, `${nickname} 手動停止了「${tab.name}」CH${channelIndex + 1} 的倒數`, 'stop');
    }
    broadcastChannels(room, [{ tabId: tab.id, channelIndex }]); // 只送這一個 CH 的變化
  });

  // ---------- 進行中頻道列表的「擊殺」按鈕：無論目前倒數中或出現中，立即重新開始倒數 ----------
  socket.on('channelKillNow', ({ tabId, channelIndex } = {}) => {
    const room = requireRoom();
    if (!room) return;
    const nickname = socket.data.nickname;
    const tab = findTab(room, tabId);
    if (!tab) return;
    const ch = tab.channels[channelIndex];
    if (!ch) return;

    // 記錄「時間點」：按下擊殺當下，王已經重生了多久（經過時間 − 最小值）
    const killNow = Date.now();
    if (ch.state !== 'idle' && ch.startTime !== null) {
      addKillPoint(room, {
        at: killNow,
        tabName: tab.name,
        image: tab.image || null,
        channel: channelIndex + 1,
        ms: (killNow - ch.startTime) - (ch.customMin ?? tab.minMinutes) * 60000,
        by: nickname
      });
    }

    ch.customMin = null;
    ch.customMax = null;
    ch.state = 'counting';
    ch.startTime = killNow;
    ch.startedBy = nickname;
    ch.standby = null;
    tab.killCount = (tab.killCount || 0) + 1;
    if (tab.locked && tab.image) updateGlobalLoot(room, tab.image);
    addLog(room, `${nickname} 擊殺了「${tab.name}」CH${channelIndex + 1}，重新開始倒數`, 'start');
    broadcastChannels(room, [{ tabId: tab.id, channelIndex }]); // 只送這一個 CH 的變化
    io.to(VIEW(room.id)).emit('tab:meta', { tabId: tab.id, killCount: tab.killCount });
    // 擊殺音效：整個房間一起播放同一個音效（80% 受傷、20% 死亡；伺服器決定，大家聽到的一樣）
    io.to(VIEW(room.id)).emit('killSound', { image: tab.image || null, kind: Math.random() < 0.8 ? 'damage' : 'die' });
  });

  // ---------- 待命：沒人待命時按下 → 顯示按的人的暱稱；已有人待命時再按一次 → 變回「待命」 ----------
  socket.on('channelStandby', ({ tabId, channelIndex } = {}) => {
    const room = requireRoom();
    if (!room) return;
    const tab = findTab(room, tabId);
    if (!tab) return;
    const ch = tab.channels[channelIndex];
    if (!ch || ch.state === 'idle') return;
    ch.standby = ch.standby ? null : socket.data.nickname;
    broadcastChannels(room, [{ tabId: tab.id, channelIndex }]);
  });

  // ---------- CH 右鍵：輸入王的「死亡時間」，從那個過去的時刻開始倒數 ----------
  // deathTimeEpoch：由前端（瀏覽器本地時區）算好的絕對時間戳記（毫秒），避免伺服器與使用者時區不同造成誤差
  // deathTimeLabel：純粹給操作紀錄顯示用的「HH:MM」文字
  // 傳 deathTimeEpoch = null 代表清除、恢復待機
  socket.on('channelSetCustom', ({ tabId, channelIndex, deathTimeEpoch, deathTimeLabel } = {}) => {
    const room = requireRoom();
    if (!room) return;
    const nickname = socket.data.nickname;
    const tab = findTab(room, tabId);
    if (!tab) return;
    const ch = tab.channels[channelIndex];
    if (!ch) return;

    if (deathTimeEpoch === null || deathTimeEpoch === undefined) {
      const wasActive = ch.state !== 'idle';
      ch.state = 'idle';
      ch.startTime = null;
      ch.customMin = null;
      ch.customMax = null;
      ch.startedBy = null;
      ch.standby = null;
      if (wasActive) {
        addLog(room, `${nickname} 透過右鍵重設了「${tab.name}」CH${channelIndex + 1}（恢復待機）`, 'stop');
        broadcastChannels(room, [{ tabId: tab.id, channelIndex }]); // 只送這一個 CH 的變化
      }
      return;
    }

    let deathMs = Number(deathTimeEpoch);
    if (!Number.isFinite(deathMs)) return;

    const now = Date.now();
    if (deathMs > now) {
      // 防呆：死亡時間不應該在未來（理論上前端已經處理過，這裡再保險一次）
      deathMs -= 24 * 60 * 60 * 1000;
    }

    // 死亡時間直接當作起算點，之後照分頁的最小值/最大值自動計算提醒與重置
    ch.customMin = null;
    ch.customMax = null;
    ch.state = 'counting';
    ch.startTime = deathMs;
    ch.startedBy = nickname;
    ch.standby = null;

    const label = typeof deathTimeLabel === 'string' ? deathTimeLabel.slice(0, 10) : '';
    addLog(room, `${nickname} 回報「${tab.name}」CH${channelIndex + 1} 的死亡時間為 ${label}，開始倒數`, 'start');
    broadcastChannels(room, [{ tabId: tab.id, channelIndex }]); // 只送這一個 CH 的變化
  });

  // ---------- CH 中鍵：輸入王的「重生時間」（絕對時刻，通常是未來） ----------
  // 重生時間 = 出生時間 = 起算點 + 最小值，所以起算點 = 重生時間 - 最小值；
  // 之後到重生時間變「出現中」，再照最大值 + 10 分鐘自動恢復待機。
  socket.on('channelSetSpawn', ({ tabId, channelIndex, spawnTimeEpoch, spawnTimeLabel } = {}) => {
    const room = requireRoom();
    if (!room) return;
    const nickname = socket.data.nickname;
    const tab = findTab(room, tabId);
    if (!tab) return;
    const ch = tab.channels[channelIndex];
    if (!ch) return;

    const spawnMs = Number(spawnTimeEpoch);
    if (!Number.isFinite(spawnMs)) return;
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    if (spawnMs > now + 7 * DAY || spawnMs < now - DAY) {
      socket.emit('error:toast', '重生時間必須在過去 1 天到未來 7 天之內');
      return;
    }

    ch.customMin = null;
    ch.customMax = null;
    ch.startTime = spawnMs - tab.minMinutes * 60000;
    ch.state = stateFor(now - ch.startTime, tab.minMinutes * 60000, tab.maxMinutes * 60000);
    ch.startedBy = nickname;
    ch.standby = null;

    const label = typeof spawnTimeLabel === 'string' ? spawnTimeLabel.slice(0, 20) : '';
    addLog(room, `${nickname} 設定「${tab.name}」CH${channelIndex + 1} 的重生時間為 ${label}，開始倒數`, 'start');
    broadcastChannels(room, [{ tabId: tab.id, channelIndex }]); // 只送這一個 CH 的變化
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
  });
});

// ---------- 永久保存（Upstash）：序列化 / 還原 ----------
const SAVED_LOG_LIMIT = 200; // 每間房間保存最近 200 筆操作紀錄

function serializeRoom(room) {
  return {
    v: 1,
    id: room.id,
    password: room.password,
    createdAt: room.createdAt,
    captainClientId: room.captainClientId,
    captainName: room.captainName,
    banned: Array.from(room.bannedNicknames),
    muted: Array.from(room.mutedNicknames.entries()),
    captainMuted: Array.from(room.captainMuted.entries()),
    log: room.activityLog.slice(0, SAVED_LOG_LIMIT),
    kp: room.killPoints,
    loot: room.loot || {},
    // CH 只存非待機的（大部分是待機），讓資料很小
    tabs: room.tabs.map((t) => {
      const ch = {};
      t.channels.forEach((c, i) => { if (c.state !== 'idle') ch[i] = c; });
      return { id: t.id, name: t.name, minMinutes: t.minMinutes, maxMinutes: t.maxMinutes, image: t.image, locked: t.locked, kc: t.killCount || 0, ch };
    })
  };
}

function restoreRoom(data) {
  if (!data || !data.id || !data.password) return null;
  const room = createRoom(data.id, data.password);
  room.createdAt = data.createdAt || Date.now();
  room.captainClientId = data.captainClientId || null;
  room.captainName = data.captainName || null;
  room.bannedNicknames = new Set(data.banned || []);
  room.mutedNicknames = new Map(data.muted || []);
  room.captainMuted = new Map(data.captainMuted || []);
  room.activityLog = Array.isArray(data.log) ? data.log : [];
  room.killPoints = Array.isArray(data.kp) ? data.kp.slice(0, MAX_KILL_POINTS) : [];
  room.loot = data.loot && typeof data.loot === 'object' ? data.loot : {};

  const savedTabs = Array.isArray(data.tabs) ? data.tabs : [];
  const fillChannels = (tab, saved) => {
    if (saved && Number.isFinite(saved.kc)) tab.killCount = saved.kc;
    if (!saved || !saved.ch) return;
    Object.entries(saved.ch).forEach(([i, c]) => {
      const idx = Number(i);
      if (tab.channels[idx] && c && typeof c === 'object') tab.channels[idx] = { ...createChannel(), ...c };
    });
  };
  // 預設王：以「目前程式裡」的設定為準（王名、時間範圍、順序更新後也會套用），計時資料用圖片檔名對回去
  const presetTabs = BOSS_PRESETS.map((b) => {
    const saved = savedTabs.find((t) => t.locked && t.image === b.image);
    const tab = createTab(b.name, b.min, b.max, b.image, true);
    if (saved && Number.isFinite(saved.id)) tab.id = saved.id;
    fillChannels(tab, saved);
    return tab;
  });
  // 自訂分頁照原樣還原
  const customTabs = savedTabs.filter((t) => !t.locked).map((saved) => {
    const tab = createTab(saved.name, saved.minMinutes, saved.maxMinutes, saved.image, false);
    if (Number.isFinite(saved.id)) tab.id = saved.id;
    fillChannels(tab, saved);
    return tab;
  });
  room.tabs = presetTabs.concat(customTabs);

  // 伺服器關著的期間時間照樣在走：依現在時間重新計算每個 CH 的狀態，過期的恢復待機
  const now = Date.now();
  room.tabs.forEach((tab) => tab.channels.forEach((ch) => {
    if (ch.state === 'idle' || ch.startTime === null) return;
    const minMs = (ch.customMin ?? tab.minMinutes) * 60000;
    const maxMs = (ch.customMax ?? tab.maxMinutes) * 60000;
    const elapsed = now - ch.startTime;
    if (elapsed >= maxMs + APPEAR_HOLD_MS) Object.assign(ch, createChannel());
    else ch.state = stateFor(elapsed, minMs, maxMs);
  }));
  room.lastActive = now;
  return room;
}

persist.init(serializeRoom);

async function start() {
  if (persist.ENABLED) {
    try {
      const saved = await Promise.race([
        persist.loadAll(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('讀取逾時')), 15000))
      ]);
      let maxTabId = nextTabId;
      saved.forEach((data) => {
        const room = restoreRoom(data);
        if (!room) return;
        rooms.set(room.id, room);
        room.tabs.forEach((t) => { if (t.id >= maxTabId) maxTabId = t.id + 1; });
      });
      nextTabId = Math.max(nextTabId, maxTabId);
      // 從舊名稱讀回的房間，馬上以新名稱存一份
      if (persist.loadedFromLegacy) rooms.forEach((room) => persist.markDirty(room));
      console.log(`[保存] 已從 Upstash 讀回 ${rooms.size} 間房間`);
      try {
        globalKillPoints = await persist.loadKillPoints();
        globalLoot = (await persist.loadLootStats()) || {};
        donations = (await persist.loadDonations()) || [];
        donatePending = (await persist.loadDonatePending()) || [];
        console.log(`[保存] 已讀回 ${donations.length} 筆贊助紀錄`);
        // 門檻調整後，已經達標的房間啟動時就補進全站統計
        rooms.forEach((r) => Object.keys(DROP_ITEMS).forEach((img) => updateGlobalLoot(r, img)));
        console.log(`[保存] 已讀回 ${globalKillPoints.length} 筆全站時間點紀錄`);
      } catch (e) {
        console.error('[保存] 讀取時間點統計失敗：', e.message);
      }
    } catch (e) {
      console.error('[保存] 讀取失敗，這次以空的狀態啟動：', e.message);
    }
  }
  server.listen(PORT, () => {
    console.log(`伺服器已啟動：http://localhost:${PORT}`);
  });
}

// Render 重新部署 / 休眠前會送 SIGTERM：先把還沒存的房間寫完再結束
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[保存] 收到 ${signal}，儲存中…`);
  try { await persist.flush(); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
