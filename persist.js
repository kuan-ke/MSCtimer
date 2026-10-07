// 房間資料永久保存（Upstash Redis，透過 REST API，不需要安裝額外套件）
//
// 在 Render 的 Environment 設定這兩個環境變數就會啟用：
//   UPSTASH_REDIS_REST_URL    例如 https://xxxx.upstash.io
//   UPSTASH_REDIS_REST_TOKEN  一長串的 token
// 沒設定時自動停用，網站照舊只存在記憶體（伺服器重開會清空）。
//
// 運作方式：
// - 房間有變動時標記為「待存」，3 秒內的多次變動合併成一次寫入（省 Upstash 的操作次數）
// - 伺服器關閉前（Render 重新部署 / 休眠時會送 SIGTERM）把所有待存的房間寫完
// - 伺服器啟動時把所有房間讀回來

const URL_ = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const ENABLED = !!(URL_ && TOKEN && typeof fetch === 'function');

const PREFIX = 'msctimer:';
const OLD_PREFIX = 'chtimer:'; // 舊版名稱：新的沒有資料時，會從舊的讀回來（之後都存成新名稱）
const INDEX_KEY = PREFIX + 'rooms';
const SAVE_DELAY_MS = 3000;

let serializeFn = null;
const dirty = new Map(); // roomId -> room
let timer = null;

// 全站「時間點」統計（管理者用）：每次擊殺一筆，存成 Redis list，最多保留 GLOBAL_KP_MAX 筆
const GLOBAL_KP_KEY = PREFIX + 'killpoints';
const GLOBAL_KP_MAX = 20000;
let pendingKp = []; // 還沒寫進 Upstash 的紀錄（JSON 字串）

async function call(cmd) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

async function pipeline(cmds) {
  if (cmds.length === 0) return [];
  const res = await fetch(URL_ + '/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error(json && json.error ? json.error : 'pipeline failed');
  return json.map((r) => {
    if (r && r.error) throw new Error(r.error);
    return r ? r.result : null;
  });
}

function init(serialize) {
  serializeFn = serialize;
  if (ENABLED) console.log('[保存] 已啟用 Upstash，房間資料會永久保存');
  else console.log('[保存] 未設定 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN，房間只存在記憶體');
}

// 讀回所有房間（回傳序列化後的物件陣列）
async function loadAll() {
  if (!ENABLED) return [];
  let prefix = PREFIX;
  let ids = (await call(['SMEMBERS', INDEX_KEY])) || [];
  if (ids.length === 0) {
    const oldIds = (await call(['SMEMBERS', OLD_PREFIX + 'rooms'])) || [];
    if (oldIds.length) { ids = oldIds; prefix = OLD_PREFIX; module.exports.loadedFromLegacy = true; console.log('[保存] 從舊名稱的資料讀回房間'); }
  }
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const values = (await call(['MGET', ...chunk.map((id) => prefix + 'room:' + id)])) || [];
    values.forEach((v, j) => {
      if (!v) return;
      try { out.push(JSON.parse(v)); } catch (e) { console.error('[保存] 房間資料損壞，略過：', chunk[j]); }
    });
  }
  return out;
}

function markDirty(room) {
  if (!ENABLED || !room) return;
  dirty.set(room.id, room);
  if (!timer) timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, SAVE_DELAY_MS);
}

async function flush() {
  if (!ENABLED || (dirty.size === 0 && pendingKp.length === 0)) return;
  const rooms = Array.from(dirty.values());
  dirty.clear();
  const kps = pendingKp;
  pendingKp = [];
  const cmds = [];
  if (kps.length) {
    cmds.push(['RPUSH', GLOBAL_KP_KEY, ...kps]);
    cmds.push(['LTRIM', GLOBAL_KP_KEY, String(-GLOBAL_KP_MAX), '-1']);
  }
  rooms.forEach((room) => {
    cmds.push(['SET', PREFIX + 'room:' + room.id, JSON.stringify(serializeFn(room))]);
    cmds.push(['SADD', INDEX_KEY, room.id]);
  });
  try {
    await pipeline(cmds);
  } catch (e) {
    console.error('[保存] 寫入失敗，稍後重試：', e.message);
    rooms.forEach((r) => { if (!dirty.has(r.id)) dirty.set(r.id, r); });
    pendingKp = kps.concat(pendingKp);
    if (!timer) timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, 15000);
  }
}

async function removeRoom(roomId) {
  if (!ENABLED) return;
  dirty.delete(roomId);
  try {
    await pipeline([['DEL', PREFIX + 'room:' + roomId], ['SREM', INDEX_KEY, roomId]]);
  } catch (e) {
    console.error('[保存] 刪除失敗：', e.message);
  }
}

// 新增一筆全站時間點紀錄（跟房間一起在 3 秒後批次寫入）
function pushKillPoint(entry) {
  if (!ENABLED) return;
  pendingKp.push(JSON.stringify(entry));
  if (!timer) timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, SAVE_DELAY_MS);
}

async function loadKillPoints() {
  if (!ENABLED) return [];
  const list = (await call(['LRANGE', GLOBAL_KP_KEY, '0', '-1'])) || [];
  const out = [];
  list.forEach((v) => { try { out.push(JSON.parse(v)); } catch (e) { /* 略過損壞的 */ } });
  return out;
}

async function clearKillPoints() {
  if (!ENABLED) return;
  pendingKp = [];
  await call(['DEL', GLOBAL_KP_KEY]);
}

module.exports = { ENABLED, init, loadAll, markDirty, flush, removeRoom, pushKillPoint, loadKillPoints, clearKillPoints, GLOBAL_KP_MAX, loadedFromLegacy: false };
