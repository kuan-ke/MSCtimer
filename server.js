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
app.get(['/', '/index.html'], (req, res) => {
  fs.readFile(INDEX_PATH, 'utf8', (err, html) => {
    if (err) return res.status(500).send('Server error');
    res.set('Cache-Control', 'no-store');
    if (isAdminKey(req.query.admin)) {
      const tag = `<script src="/admin.js?k=${encodeURIComponent(req.query.admin)}"></script>\n`;
      html = html.replace('<script src="client.js"></script>', tag + '<script src="client.js"></script>');
    }
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
    startedBy: null      // 是誰觸發這次倒數的暱稱
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
  io.to(room.id).emit('state:update', { tabs: room.tabs, serverTime: Date.now() });
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
  io.to(room.id).emit('channels:update', { changes, serverTime: Date.now() });
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
  const n = normalizeName(socket.data.nickname);
  return room.mutedNicknames.has(n) || room.captainMuted.has(n);
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
  io.to(room.id).emit('log:new', entry);
}

function roomHasActiveChannels(room) {
  return room.tabs.some((t) => t.channels.some((c) => c.state !== 'idle'));
}

// 讓 socket 離開目前所在的房間（換房間或斷線時）
function leaveCurrentRoom(socket) {
  const room = getRoom(socket);
  if (!room) return;
  socket.leave(room.id);
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
          changed.push({ tabId: tab.id, channelIndex: idx });
        } else {
          const target = stateFor(elapsed, minMs, maxMs);
          if (STATE_ORDER[target] > STATE_ORDER[ch.state]) {
            ch.state = target;
            changed.push({ tabId: tab.id, channelIndex: idx });
            // 進入重生區間、進入出現中都會提醒
            io.to(room.id).emit('channelAlert', { tabId: tab.id, channelIndex: idx, kind: target });
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
    room.connectedUsers.set(socket.id, trimmedName);
    room.lastActive = Date.now();

    // 建立房間的人成為隊長（管理者隱身不當隊長；由管理者建立的房間，第一個進來的一般使用者成為隊長）
    if (!room.captainClientId && !socket.data.isAdmin && socket.data.clientId) {
      room.captainClientId = socket.data.clientId;
    }
    if (isCaptain(room, socket)) room.captainName = trimmedName; // 隊長回來時以目前暱稱更新
    if (created) persist.markDirty(room);

    socket.emit('join:ack', { nickname: trimmedName, created, captain: isCaptain(room, socket) });
    socket.emit('state:init', { tabs: room.tabs, serverTime: Date.now() });
    socket.emit('log:init', room.activityLog);
    if (socket.data.isAdmin) socket.emit('admin:mutedList', Array.from(room.mutedNicknames.values()));
    if (isCaptain(room, socket)) socket.emit('captain:muted', Array.from(room.captainMuted.values()));
    broadcastRoomInfo(room);
    broadcastUsers(room);
  });

  // ---------- 隊長：禁止 / 解除禁止隊員操作（只限這間房間，以暱稱判斷，離線再回來仍有效） ----------
  socket.on('captainMute', ({ nickname } = {}) => {
    const room = getRoom(socket);
    if (!room || !isCaptain(room, socket) || typeof nickname !== 'string' || !nickname.trim()) return;
    const n = normalizeName(nickname);
    if (n === normalizeName(socket.data.nickname)) return; // 不能禁止自己
    // 只能禁止目前在房間裡的隊員（不含隱身的管理者）
    const member = roomUserList(room).find((u) => !u.hidden && normalizeName(u.name) === n);
    if (!member) return;
    room.captainMuted.set(n, member.name);
    sendCaptainMuted(room);
    addLog(room, `隊長「${socket.data.nickname}」禁止「${member.name}」進行操作`, 'admin');
  });

  socket.on('captainUnmute', ({ nickname } = {}) => {
    const room = getRoom(socket);
    if (!room || !isCaptain(room, socket) || typeof nickname !== 'string') return;
    const n = normalizeName(nickname);
    const original = room.captainMuted.get(n);
    if (!original) return;
    room.captainMuted.delete(n);
    sendCaptainMuted(room);
    addLog(room, `隊長「${socket.data.nickname}」解除了「${original}」的操作禁止`, 'admin');
  });

  // 產生一組隨機房間密碼（符合規則，且不會跟目前已存在的房間重複）
  // ---------- 計時匯出 / 匯入（隊長才能用；隱身的管理者也能用，但不寫進操作紀錄） ----------
  function canTransferTimers(room) {
    return !!room && (socket.data.isAdmin || isCaptain(room, socket));
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

  // ---------- 隊長：修改自己或同房間其他人在此房間的暱稱 ----------
  socket.on('captainRename', ({ targetSocketId, newName } = {}) => {
    const room = getRoom(socket);
    if (!room || !isCaptain(room, socket)) return;
    const trimmed = (typeof newName === 'string' ? newName : '').trim().slice(0, 20);
    if (!trimmed) return;
    const targets = sameClientSocketsInRoom(room, targetSocketId).filter((t) => !t.data.isAdmin);
    if (targets.length === 0) return;
    const target = targets[0];
    const oldName = target.data.nickname;
    if (normalizeName(oldName) === normalizeName(trimmed) && oldName === trimmed) return;
    if (room.bannedNicknames.has(normalizeName(trimmed))) {
      socket.emit('error:toast', '這個暱稱已被移出此房間，不能使用');
      return;
    }
    if (isNicknameTaken(room, trimmed, target.id, false, target.data.clientId)) {
      socket.emit('error:toast', '這個暱稱在此房間已經有人在使用');
      return;
    }
    targets.forEach((t) => {
      t.data.nickname = trimmed;
      room.connectedUsers.set(t.id, trimmed);
      t.emit('forceNickname', trimmed);
    });
    transferNameState(room, target.data.clientId, oldName, trimmed); // 被禁止的人改名後仍維持禁止；隊長改名同步更新隊長名稱
    sendCaptainMuted(room);
    broadcastUsers(room);
    const self = target.data.clientId === socket.data.clientId;
    addLog(room, self
      ? `隊長「${oldName}」將自己的暱稱改為「${trimmed}」`
      : `隊長「${socket.data.nickname}」將「${oldName}」的暱稱改為「${trimmed}」`, 'admin');
  });

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
    addLog(room, `管理者禁止「${nickname}」進行任何操作`, 'admin');
  });

  socket.on('adminUnmuteUser', ({ nickname } = {}) => {
    const room = getRoom(socket);
    if (!room || !socket.data.isAdmin || !nickname) return;
    if (room.mutedNicknames.delete(normalizeName(nickname))) {
      broadcastAdminMutedList(room);
      addLog(room, `管理者解除了「${nickname}」的操作禁止`, 'admin');
    }
  });

  // 管理者移除成員：中斷連線 + 禁止該暱稱再進入此房間
  socket.on('adminRemoveUser', ({ targetSocketId, nickname } = {}) => {
    const room = getRoom(socket);
    if (!room || !socket.data.isAdmin || !nickname) return;

    room.bannedNicknames.add(normalizeName(nickname));
    sameClientSocketsInRoom(room, targetSocketId).forEach((t) => {
      t.emit('removedByAdmin');
      leaveCurrentRoom(t);
      t.disconnect(true);
    });
    room.connectedUsers.delete(targetSocketId);
    broadcastUsers(room);
    addLog(room, `管理者將「${nickname}」移出房間`, 'admin');
  });

  // 管理者刪除單筆操作紀錄
  socket.on('adminDeleteLogEntry', (logId) => {
    const room = getRoom(socket);
    if (!room || !socket.data.isAdmin) return;
    const idx = room.activityLog.findIndex((e) => e.id === logId);
    if (idx !== -1) {
      room.activityLog.splice(idx, 1);
      persist.markDirty(room);
      io.to(room.id).emit('log:remove', logId);
    }
  });

  // 管理者清空此房間全部操作紀錄
  socket.on('adminClearLog', () => {
    const room = getRoom(socket);
    if (!room || !socket.data.isAdmin) return;
    room.activityLog = [];
    io.to(room.id).emit('log:clear');
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
      addLog(room, `${nickname} 在「${tab.name}」啟動了 CH${channelIndex + 1} 倒數`, 'start');
    } else {
      ch.state = 'idle';
      ch.startTime = null;
      ch.startedBy = null;
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

    ch.customMin = null;
    ch.customMax = null;
    ch.state = 'counting';
    ch.startTime = Date.now();
    ch.startedBy = nickname;
    addLog(room, `${nickname} 擊殺了「${tab.name}」CH${channelIndex + 1}，重新開始倒數`, 'start');
    broadcastChannels(room, [{ tabId: tab.id, channelIndex }]); // 只送這一個 CH 的變化
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
    // CH 只存非待機的（大部分是待機），讓資料很小
    tabs: room.tabs.map((t) => {
      const ch = {};
      t.channels.forEach((c, i) => { if (c.state !== 'idle') ch[i] = c; });
      return { id: t.id, name: t.name, minMinutes: t.minMinutes, maxMinutes: t.maxMinutes, image: t.image, locked: t.locked, ch };
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

  const savedTabs = Array.isArray(data.tabs) ? data.tabs : [];
  const fillChannels = (tab, saved) => {
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
