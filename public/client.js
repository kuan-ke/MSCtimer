const socket = io();

const CHANNEL_COUNT = 60;
// 觸控裝置（手機 / 平板）：長按代替右鍵
const IS_TOUCH = (() => { try { return window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window; } catch (e) { return false; } })();
// 瀏覽器保存資料的名稱（舊版是 ch_timer_*，第一次載入新版時會自動搬過來）
(function migrateStorageKeys() {
  try {
    ['nickname', 'room_password', 'client_id', 'room_nicknames'].forEach((k) => {
      const oldKey = 'ch_timer_' + k;
      const newKey = 'msctimer_' + k;
      const v = localStorage.getItem(oldKey);
      if (v !== null && localStorage.getItem(newKey) === null) localStorage.setItem(newKey, v);
      if (v !== null) localStorage.removeItem(oldKey);
    });
  } catch (e) { /* ignore */ }
})();
const NICKNAME_KEY = 'msctimer_nickname';
// 暱稱改為「只能取一次」：舊版存下的暱稱（含隊長改過的房間暱稱）全部作廢，所有人重新取一次
const NICK_VERSION_KEY = 'msctimer_nick_v';
const NICK_VERSION = '2';
var needRenameNotice = false;
try {
  if (localStorage.getItem(NICK_VERSION_KEY) !== NICK_VERSION) {
    if (localStorage.getItem(NICKNAME_KEY) !== null) needRenameNotice = true;
    localStorage.removeItem(NICKNAME_KEY);
    localStorage.removeItem('msctimer_room_nicknames');
    localStorage.setItem(NICK_VERSION_KEY, NICK_VERSION);
  }
} catch (e) { /* ignore */ }

let tabs = [];
let currentTabId = null;
let clockOffset = 0; // serverTime - Date.now()
let myNickname = null;
let onlineUsers = []; // [{id, name}]

let modalContext = null; // { tabId, channelIndex }

// ---------- DOM refs ----------
const connStatusEl = document.getElementById('connStatus');
const tabsListEl = document.getElementById('tabsList');
const addTabBtn = document.getElementById('addTabBtn');
const minInput = document.getElementById('minInput');
const maxInput = document.getElementById('maxInput');
const gridEl = document.getElementById('grid');
const bossImageEl = document.getElementById('bossImage');
const bossNameEl = document.getElementById('bossName');
const statusListCountingEl = document.getElementById('statusListCounting');
const statusListAppearingEl = document.getElementById('statusListAppearing');
const SOON_THRESHOLD_MS = 5 * 60 * 1000; // 5 分鐘內視為「即將出現」
const logListEl = document.getElementById('logList');

const onlineCountEl = document.getElementById('onlineCount');
const onlineNamesEl = document.getElementById('onlineNames');

const myNicknameDisplay = document.getElementById('myNicknameDisplay');

const nicknameOverlay = document.getElementById('nicknameOverlay');
const nicknameInput = document.getElementById('nicknameInput');
const nicknameSubmitBtn = document.getElementById('nicknameSubmitBtn');
const nicknameError = document.getElementById('nicknameError');

const modalOverlay = document.getElementById('modalOverlay');
const modalHour = document.getElementById('modalHour');
const modalMinute = document.getElementById('modalMinute');
const modalTitle = document.getElementById('modalTitle');
const modalResetBtn = document.getElementById('modalResetBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalSaveBtn = document.getElementById('modalSaveBtn');
const rangeHintEl = document.getElementById('rangeHint');

// ---------- 進入房間：暱稱 + 房間密碼 ----------
// 暱稱設定後鎖定（無法自行更改）；房間密碼相同的人會進到同一個房間。
// 兩者都存在 localStorage，重新整理或斷線重連時會自動回到原本的房間。
const ROOM_KEY = 'msctimer_room_password';
const roomPasswordInput = document.getElementById('roomPasswordInput');
const togglePasswordBtn = document.getElementById('togglePasswordBtn');
const roomDisplay = document.getElementById('roomDisplay');
const roomPasswordText = document.getElementById('roomPasswordText');
const switchRoomBtn = document.getElementById('switchRoomBtn');

let myRoomPassword = null;
// 每個瀏覽器固定的識別碼：伺服器用它判斷「重新整理 / 重新連線的是同一個人」，
// 這樣重新整理時不會因為舊連線還沒斷而被判定「暱稱已有人使用」。
const CLIENT_ID_KEY = 'msctimer_client_id';
const myClientId = (() => {
  let id = null;
  try { id = localStorage.getItem(CLIENT_ID_KEY); } catch (e) { /* ignore */ }
  if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    try { localStorage.setItem(CLIENT_ID_KEY, id); } catch (e) { /* ignore */ }
  }
  return id;
})();
let joined = false;
let manualJoinPending = false; // 使用者手動按「進入房間」（用來決定要不要顯示「已建立 / 已進入」提示）
let showRoomPassword = false;

// 隊長圖示（取代原本的 👑）
function captainIcon(doc) {
  const img = (doc || document).createElement('img');
  img.src = 'images/captain.png';
  img.className = 'cap-icon';
  img.alt = '隊長';
  img.title = '隊長';
  return img;
}
function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function storageSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } }
function storageRemove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }

// 各房間專屬暱稱（隊長在某間房間幫你改的名字，只在那間房間有效）：{ 房間密碼: 暱稱 }
const ROOM_NICKS_KEY = 'msctimer_room_nicknames';
let roomNicks = {};
try { roomNicks = JSON.parse(storageGet(ROOM_NICKS_KEY) || '{}') || {}; } catch (e) { roomNicks = {}; }
function saveRoomNicks() { storageSet(ROOM_NICKS_KEY, JSON.stringify(roomNicks)); }
// 進某間房間要用的暱稱：有房間專屬暱稱就用它，否則用原本的暱稱
function nicknameForRoom(pw) {
  return (pw && roomNicks[pw]) || storageGet(NICKNAME_KEY) || myNickname;
}

let amCaptain = false; // 自己是不是目前房間的隊長
let captainMutedList = []; // （隊長才會收到）被隊長禁止操作的隊員暱稱
let roomCaptainName = null; // 這間房間的隊長暱稱（隊長不在房間時也會顯示）

function initNickname() {
  const savedName = storageGet(NICKNAME_KEY);
  const savedPw = storageGet(ROOM_KEY);
  if (savedName) myNickname = savedName;
  if (savedPw) myRoomPassword = savedPw;
  if (savedName && savedPw) myNickname = nicknameForRoom(savedPw);

  if (savedName && savedPw) {
    // 進站先選房間：暱稱鎖定不能改，密碼先帶入上次的房間；連線後會確認那間房間還在不在（見 checkLastRoom）
    let auto = false;
    try { auto = sessionStorage.getItem('msctimer_autorejoin') === '1'; } catch (e) { /* ignore */ }
    if (auto) hideNicknameOverlay(); // 網站更新後的重新整理：直接回到原本的房間
    else { showNicknameOverlay(); setLastRoomHint('🔎 正在確認上次的房間…', ''); }
  } else {
    showNicknameOverlay(needRenameNotice ? '暱稱規則更新：請重新取一次暱稱（之後就無法更改）' : undefined);
  }
  updateNicknameDisplay();
}

// 顯示「進入房間」彈窗。已經有鎖定的暱稱時，暱稱欄位會帶入並設為唯讀；
// unlockNickname = true 時（暱稱在該房間重複 / 被移除）讓使用者重新輸入暱稱。
function showNicknameOverlay(errorMsg, opts = {}) {
  nicknameOverlay.classList.remove('hidden');

  const lockName = !!myNickname && !opts.unlockNickname;
  nicknameInput.value = lockName ? myNickname : (opts.keepNicknameValue ? nicknameInput.value : '');
  nicknameInput.readOnly = lockName;
  document.getElementById('nicknameHint').textContent = lockName
    ? '您的暱稱已鎖定，無法自行更改。'
    : '⚠️ 暱稱只能取一次，取後無法更改，而且只屬於這個瀏覽器，請謹慎輸入。';
  document.getElementById('nicknameHint').classList.toggle('nick-warn', !lockName);

  if (!opts.keepPassword) roomPasswordInput.value = myRoomPassword || '';

  if (errorMsg) {
    nicknameError.textContent = errorMsg;
    nicknameError.classList.remove('hidden');
  } else {
    nicknameError.classList.add('hidden');
  }

  setTimeout(() => {
    if (opts.focus === 'password' || lockName) roomPasswordInput.focus();
    else nicknameInput.focus();
  }, 50);
}
// 進站選房間：顯示「上次的房間」狀態
function setLastRoomHint(text, cls) {
  const el = document.getElementById('lastRoomHint');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'last-room-hint' + (cls ? ' ' + cls : '') + (text ? '' : ' hidden');
}
function checkLastRoom(pw) {
  socket.emit('roomCheck', { password: pw }, (r) => {
    if (joined || nicknameOverlay.classList.contains('hidden')) return;
    if (r && r.exists) {
      setLastRoomHint(`✅ 上次的房間還在（目前 ${r.users} 人在線），按「進入房間」繼續；也可以輸入其他房間密碼。`, 'ok');
    } else {
      setLastRoomHint('⚠️ 上次的房間已經不存在了。輸入同一組密碼會建立新房間，也可以換一組密碼。', 'gone');
    }
  });
}
function hideNicknameOverlay() {
  nicknameOverlay.classList.add('hidden');
  setLastRoomHint('');
}

function submitNickname() {
  const pw = roomPasswordInput.value.trim();
  // 暱稱已鎖定時，進房用這間房間的專屬暱稱（如果有的話）
  const name = (nicknameInput.readOnly ? nicknameForRoom(pw) : nicknameInput.value).trim().slice(0, 20);
  if (!name) {
    nicknameInput.focus();
    return;
  }
  if (!/^[A-Za-z0-9]{6}$/.test(pw)) {
    nicknameError.textContent = '房間密碼必須剛好 6 個字元，只能使用英文大小寫或數字';
    nicknameError.classList.remove('hidden');
    roomPasswordInput.focus();
    return;
  }
  if (!nicknameInput.readOnly && !confirm(`暱稱只能取一次，取後無法更改。\n\n確定要使用「${name}」嗎？`)) {
    nicknameInput.focus();
    return;
  }
  manualJoinPending = true;
  // 被管理者移除時伺服器會中斷連線，這時要手動重新連線
  if (!socket.connected) socket.connect();
  socket.emit('joinRoom', { nickname: name, password: pw, clientId: myClientId });
  // 先不寫入 localStorage，等伺服器 join:ack 成功後才儲存（避免暱稱重複/被禁用卻鎖死）
  myRoomPassword = pw;
}

nicknameSubmitBtn.addEventListener('click', submitNickname);
nicknameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (!roomPasswordInput.value.trim()) roomPasswordInput.focus();
    else submitNickname();
  }
});
roomPasswordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitNickname();
});
// 輸入時自動濾掉英數字以外的字元（含空白、中文、符號），最多 6 碼
roomPasswordInput.addEventListener('input', () => {
  // 改成別的密碼時，「上次的房間」提示就不適用了
  if (roomPasswordInput.value.trim() !== (storageGet(ROOM_KEY) || '')) setLastRoomHint('');
  const cleaned = roomPasswordInput.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
  if (cleaned !== roomPasswordInput.value) roomPasswordInput.value = cleaned;
});
// 產生隨機房間密碼（由伺服器產生，保證符合規則且不跟現有房間重複）
document.getElementById('randomPasswordBtn').addEventListener('click', () => {
  if (!socket.connected) {
    showToast('尚未連線到伺服器，請稍候再試');
    return;
  }
  socket.emit('generateRoomPassword', (pw) => {
    if (!pw) {
      showToast('產生失敗，請再按一次');
      return;
    }
    roomPasswordInput.value = pw;
    roomPasswordInput.classList.remove('pw-masked'); // 直接顯示出來，方便記下來分享給隊友
    togglePasswordBtn.textContent = '隱藏';
    nicknameError.classList.add('hidden');
    roomPasswordInput.focus();
  });
});

togglePasswordBtn.addEventListener('click', () => {
  // 房間密碼不是帳號密碼：用一般文字欄位＋CSS 遮蔽，避免 Chrome 把它當成登入密碼並跳出「密碼外洩」警告
  const show = roomPasswordInput.classList.contains('pw-masked');
  roomPasswordInput.classList.toggle('pw-masked', !show);
  togglePasswordBtn.textContent = show ? '隱藏' : '顯示';
});

function updateNicknameDisplay() {
  myNicknameDisplay.textContent = myNickname ? `👤 ${myNickname}` : '';
  if (myNickname && amCaptain && joined) myNicknameDisplay.appendChild(captainIcon());
  myNicknameDisplay.title = myNickname ? `您的暱稱：${myNickname}${amCaptain && joined ? '（隊長）' : ''}` : '';
}

function updateRoomDisplay() {
  renderCaptainInfo();
  if (joined && myRoomPassword) {
    roomDisplay.classList.remove('hidden');
    switchRoomBtn.classList.remove('hidden');
    roomPasswordText.textContent = showRoomPassword ? myRoomPassword : '••••';
  } else {
    roomDisplay.classList.add('hidden');
    switchRoomBtn.classList.add('hidden');
  }
}

roomDisplay.addEventListener('click', () => {
  showRoomPassword = !showRoomPassword;
  updateRoomDisplay();
});

// 換房間：清掉記住的房間密碼後重新載入（暱稱保留），重新輸入密碼
switchRoomBtn.addEventListener('click', () => {
  if (!confirm('確定要離開目前的房間嗎？之後需要重新輸入房間密碼。')) return;
  socket.emit('leaveRoom');
  storageRemove(ROOM_KEY);
  window.location.reload();
});

socket.on('join:ack', ({ nickname, created, captain }) => {
  myNickname = nickname;
  joined = true;
  amCaptain = !!captain;
  if (!amCaptain) captainMutedList = [];
  if (!(myRoomPassword && roomNicks[myRoomPassword] === nickname)) {
    // 用的是一般暱稱（或剛重新輸入了新暱稱）：記成之後所有房間預設的暱稱
    storageSet(NICKNAME_KEY, nickname);
    if (myRoomPassword && roomNicks[myRoomPassword]) { delete roomNicks[myRoomPassword]; saveRoomNicks(); }
  }
  if (myRoomPassword) storageSet(ROOM_KEY, myRoomPassword);
  renderOnlineUsersBar();
  updateNicknameDisplay();
  updateRoomDisplay();
  hideNicknameOverlay();
  if (manualJoinPending) {
    showToast(created
      ? (amCaptain ? '已建立新房間，你是這間房間的隊長，把密碼分享給隊友就能一起使用' : '已建立新房間，把密碼分享給隊友就能一起使用')
      : '已進入房間');
  }
  manualJoinPending = false;
});

socket.on('join:error', ({ field, code, message }) => {
  joined = false;
  manualJoinPending = false;
  updateRoomDisplay();
  amCaptain = false;
  if (code === 'banned' || code === 'owned') {
    // 這個暱稱被移出此房間：解除暱稱鎖定，讓使用者換一個
    if (myRoomPassword && roomNicks[myRoomPassword]) { delete roomNicks[myRoomPassword]; saveRoomNicks(); }
    storageRemove(NICKNAME_KEY);
    myNickname = null;
    updateNicknameDisplay();
  }
  if (field === 'nickname') {
    showNicknameOverlay(message, { unlockNickname: true, focus: 'nickname' });
  } else {
    showNicknameOverlay(message, { keepPassword: true, focus: 'password', keepNicknameValue: true });
  }
});

// 伺服器管理者強制修改了「我」的暱稱
// 暱稱被改了（隊長或管理者），只在這間房間有效
socket.on('forceNickname', (name) => {
  myNickname = name;
  if (myRoomPassword) {
    if (name === storageGet(NICKNAME_KEY)) delete roomNicks[myRoomPassword];
    else roomNicks[myRoomPassword] = name;
    saveRoomNicks();
  }
  updateNicknameDisplay();
  renderOnlineUsersBar();
});

socket.on('removedByAdmin', () => {
  if (myRoomPassword && roomNicks[myRoomPassword]) { delete roomNicks[myRoomPassword]; saveRoomNicks(); }
  amCaptain = false;
  storageRemove(NICKNAME_KEY);
  myNickname = null;
  joined = false;
  updateNicknameDisplay();
  updateRoomDisplay();
  showNicknameOverlay('您已被管理者移出此房間，請使用其他暱稱，或輸入其他房間密碼', { unlockNickname: true });
});

// 被隊長或管理者移出（沒有封鎖）：保留暱稱，可以重新輸入密碼再進來
socket.on('kicked', ({ by } = {}) => {
  amCaptain = false;
  joined = false;
  updateNicknameDisplay();
  updateRoomDisplay();
  showNicknameOverlay(`您已被${by || '隊長'}移出此房間，可以重新進入，或輸入其他房間密碼`, { keepPassword: true });
});

socket.on('error:needNickname', () => {
  showNicknameOverlay();
});

socket.on('error:muted', () => showToast('您已被禁止操作'));

// 被禁止操作：看不到任何計時器（伺服器也不會再送計時資料），只顯示提示畫面
var amMuted = false;
socket.on('muted:state', ({ muted, by } = {}) => {
  amMuted = !!muted;
  document.body.classList.toggle('is-muted', amMuted);
  let screen = document.getElementById('mutedScreen');
  if (amMuted) {
    if (!screen) {
      screen = document.createElement('div');
      screen.id = 'mutedScreen';
      screen.className = 'muted-screen';
      const mainRow = document.querySelector('.main-row');
      mainRow.parentNode.insertBefore(screen, mainRow);
    }
    screen.innerHTML = '';
    const icon = document.createElement('div'); icon.className = 'muted-icon'; icon.textContent = '🚫';
    const t = document.createElement('div'); t.className = 'muted-title'; t.textContent = `您已被${by || '隊長'}禁止操作`;
    const d = document.createElement('div'); d.className = 'muted-desc'; d.textContent = '禁止期間無法查看計時器，也無法進行任何操作。請聯絡隊長解除，解除後畫面會自動恢復。';
    screen.append(icon, t, d);
    if (typeof pipWindow !== 'undefined' && pipWindow) { try { pipWindow.close(); } catch (e) { /* ignore */ } }
  } else if (screen) {
    screen.remove();
  }
});
socket.on('error:toast', (msg) => showToast(msg));

function showToast(msg, d) {
  const doc = (d && d.body) ? d : document; // 從子母畫面操作時，提示也顯示在子母畫面裡
  const t = doc.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  doc.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

// ---------- 贊助者專屬（新增自訂王、炫耀、霓虹介面） ----------
let mePerks = { supporter: false };
function isSupporterMe() { return !!mePerks.supporter; }
const THEME_KEY = 'msctimer_theme';
// pipWindow 在檔案後面才宣告（let），這裡用 try 包起來避免載入時就存取到而出錯
function getPipWin() { try { return pipWindow; } catch (e) { return null; } }
const THEMES = ['default', 'neon', 'snow'];
function currentTheme() {
  const t = storageGet(THEME_KEY);
  return isSupporterMe() && THEMES.includes(t) ? t : 'default';
}
function setThemeClass(root, t) {
  if (!root) return;
  root.classList.toggle('theme-neon', t === 'neon');
  root.classList.toggle('theme-snow', t === 'snow');
}
function applyTheme() {
  const t = currentTheme();
  setThemeClass(document.documentElement, t);
  const pw = getPipWin();
  if (pw && pw.document) setThemeClass(pw.document.documentElement, t);
  document.querySelectorAll('.theme-opt').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === t);
    b.classList.toggle('locked', b.dataset.theme !== 'default' && !isSupporterMe());
  });
}
function applyPerksUI() {
  addTabBtn.classList.toggle('perk-locked', !isSupporterMe());
  addTabBtn.title = isSupporterMe() ? '新增自訂王（贊助者專屬）' : '⭐ 新增自訂王：贊助者專屬功能';
  applyTheme();
  // 出現中「📦 戰利品」清單上的炫耀按鈕
  if (typeof renderLoot === 'function') { try { renderLoot(); } catch (e) { /* ignore */ } }
  // 戰利品目錄開著的話，掉落機率（贊助者專屬）也跟著更新
  try {
    if (dropsCurrent && !document.getElementById('dropsOverlay').classList.contains('hidden')) {
      const boss = dropsCurrent;
      renderDrops();
      loadLootRates(true).then(() => { if (dropsCurrent === boss) renderDrops(); });
    }
  } catch (e) { /* ignore */ }
}
let gotPerks = false;
socket.on('me:perks', (p) => {
  const was = isSupporterMe();
  const first = !gotPerks;
  gotPerks = true;
  mePerks = p || { supporter: false };
  applyPerksUI();
  if (!first && !was && isSupporterMe()) showToast('⭐ 你已經是贊助者了！可以使用新增自訂王、炫耀、霓虹／雪原介面，感謝支持 ❤️');
});
socket.on('perk:denied', (msg) => showToast('⭐ ' + (msg || '贊助者專屬功能')));
(function setupThemePicker() {
  const tb = document.getElementById('themeBtn');
  const pop = document.getElementById('themePop');
  if (!tb || !pop) return;
  tb.addEventListener('click', (e) => { e.stopPropagation(); pop.classList.toggle('hidden'); applyTheme(); });
  document.addEventListener('click', (e) => { if (!pop.contains(e.target) && e.target !== tb && !tb.contains(e.target)) pop.classList.add('hidden'); });
  pop.querySelectorAll('.theme-opt').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.theme;
    if (t !== 'default' && !isSupporterMe()) { showToast('⭐ 霓虹、雪原介面是贊助者專屬'); return; }
    storageSet(THEME_KEY, t);
    applyTheme();
    pop.classList.add('hidden');
  }));
  applyTheme();
})();

// 炫耀：全站跳出通知（主畫面與子母畫面都能用）
function bragItem(image, item, d) {
  if (!ensureNickname()) return;
  const toast = (m) => { showToast(m, d); if (d && d !== document) showToast(m); };
  if (!isSupporterMe()) { showToast('⭐ 炫耀是贊助者專屬功能', d); return; }
  const boss = (dropsData && dropsData[image] && dropsData[image].name) || '王';
  if (!((d && d.defaultView) || window).confirm(`要向全站炫耀「擊殺了${boss}後，獲得了 ${item.name}」嗎？`)) return;
  socket.emit('brag', { image, itemId: item.id }, (r) => {
    if (!r || r.error) { toast((r && r.error) || '炫耀失敗'); return; }
    if (typeof r.left === 'number') toast(`📣 已炫耀！今天還可以炫耀 ${r.left} 次`);
  });
}
// 全站炫耀通知：每則顯示 8 秒，同時有很多則就依序排隊播放
const BRAG_SHOW_MS = 8000;
const BRAG_QUEUE_MAX = 30;
const bragQueue = [];
let bragBusy = false;
function showBragIn(d, b, left) {
  if (!d || !d.body) return null;
  const box = d.createElement('div');
  box.className = 'brag-toast';
  const t1 = d.createElement('span');
  t1.textContent = `🎉 ${b.name} 擊殺了${b.boss}後，獲得了`;
  const ic = d.createElement('img');
  ic.src = `drops/icons/${b.itemId}.png`;
  ic.alt = '';
  ic.onerror = () => ic.remove();
  const nm = d.createElement('b');
  nm.textContent = b.item;
  const t2 = d.createElement('span');
  t2.textContent = '！大家一起恭喜他！';
  box.append(t1, ic, nm, t2);
  if (left > 0) {
    const q = d.createElement('small');
    q.className = 'brag-more';
    q.textContent = `（後面還有 ${left} 則）`;
    box.appendChild(q);
  }
  d.body.appendChild(box);
  // 子母畫面：高度對齊上方王的標籤列，只蓋住標籤、不擋到頻道
  if (d.documentElement.classList.contains('is-pip')) {
    const row = d.querySelector('.tabs-row');
    const r = row && row.getBoundingClientRect();
    if (r && r.height > 0) { box.style.top = r.top + 'px'; box.style.height = Math.max(26, r.height) + 'px'; }
    else box.style.height = '34px';
  }
  return box;
}
function playNextBrag() {
  if (bragBusy || !bragQueue.length) return;
  bragBusy = true;
  const b = bragQueue.shift();
  const boxes = [showBragIn(document, b, bragQueue.length)];
  const pw = getPipWin();
  if (pw && pw.document) boxes.push(showBragIn(pw.document, b, bragQueue.length));
  setTimeout(() => boxes.forEach((x) => x && x.classList.add('out')), BRAG_SHOW_MS - 300);
  setTimeout(() => {
    boxes.forEach((x) => x && x.remove());
    bragBusy = false;
    playNextBrag();
  }, BRAG_SHOW_MS);
}
socket.on('brag', (b) => {
  if (!b || !b.name) return;
  if (bragQueue.length >= BRAG_QUEUE_MAX) bragQueue.shift(); // 太多就丟掉最舊的，避免排太久
  bragQueue.push(b);
  playNextBrag();
});

// ---------- 管理者公告（畫面上方的公告列；按 ✕ 收起，有新公告會再出現） ----------
const ANNOUNCE_SEEN_KEY = 'msctimer_announce_closed';
let currentAnnounce = null;
function renderAnnounceText(el, text) {
  el.innerHTML = '';
  const urlRe = /(https?:\/\/[^\s<>"'）)]+)/g;
  let last = 0; let m;
  while ((m = urlRe.exec(text))) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = m[1]; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = m[1];
    el.appendChild(a);
    last = m.index + m[1].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}
function updateAnnounceBar() {
  const bar = document.getElementById('announceBar');
  const txt = document.getElementById('announceText');
  if (!bar || !txt) return;
  const a = currentAnnounce;
  if (!a || !a.text || storageGet(ANNOUNCE_SEEN_KEY) === a.id) { bar.classList.add('hidden'); return; }
  renderAnnounceText(txt, a.text);
  bar.classList.remove('hidden');
}
socket.on('announce', (a) => { currentAnnounce = a && a.text ? a : null; updateAnnounceBar(); });
(function setupAnnounce() {
  const c = document.getElementById('announceClose');
  if (c) c.addEventListener('click', () => {
    if (currentAnnounce) storageSet(ANNOUNCE_SEEN_KEY, currentAnnounce.id);
    updateAnnounceBar();
  });
})();

initNickname();

// ---------- 線上名單 ----------
socket.on('users:update', (list) => {
  onlineUsers = list;
  renderOnlineUsersBar();
});

// 線上名單：隊長名字後面有隊長圖示；自己是隊長時，每個名字旁邊有 ✎ 可以改暱稱（包含自己）
function renderOnlineUsersBar() {
  onlineCountEl.textContent = onlineUsers.length;
  const tgl = document.getElementById('onlineToggle');
  if (tgl) tgl.title = onlineUsers.map((u) => u.name + (u.captain ? '（隊長）' : '')).join('、') || '目前沒有人在線';
  onlineNamesEl.innerHTML = '';
  onlineUsers.forEach((u, i) => {
    if (i > 0) onlineNamesEl.appendChild(document.createTextNode('、'));
    const isMutedByMe = amCaptain && captainMutedList.some((n) => n.toLowerCase() === u.name.toLowerCase());
    const span = document.createElement('span');
    span.className = 'online-name' + (isMutedByMe ? ' muted' : '');
    span.textContent = u.name;
    if (u.captain) span.appendChild(captainIcon());
    if (isMutedByMe) span.appendChild(document.createTextNode('（已禁止）'));
    if (u.captain) span.title = '隊長';
    onlineNamesEl.appendChild(span);
    if (amCaptain && !u.captain) {
      const muteBtn = document.createElement('button');
      muteBtn.className = 'rename-btn';
      muteBtn.textContent = isMutedByMe ? '✅' : '🚫';
      muteBtn.title = isMutedByMe ? `解除「${u.name}」的操作禁止` : `禁止「${u.name}」操作（點 CH、擊殺、回報時間、編輯分頁）`;
      muteBtn.addEventListener('click', () => {
        if (isMutedByMe) socket.emit('captainUnmute', { nickname: u.name });
        else if (confirm(`確定要禁止「${u.name}」在這間房間進行任何操作嗎？`)) socket.emit('captainMute', { nickname: u.name });
      });
      onlineNamesEl.appendChild(muteBtn);
      const kickBtn = document.createElement('button');
      kickBtn.className = 'rename-btn';
      kickBtn.textContent = '🚪';
      kickBtn.title = `將「${u.name}」移出房間（之後仍可用同暱稱再進來）`;
      kickBtn.addEventListener('click', () => {
        if (confirm(`確定要將「${u.name}」移出房間嗎？\n（對方之後仍可用同樣暱稱再進入；要讓他不能操作請用 🚫 禁止操作）`)) socket.emit('captainKick', { targetSocketId: u.id });
      });
      onlineNamesEl.appendChild(kickBtn);
    }
  });

  // 隊長：已禁止、但目前不在線上的隊員，也可以在這裡解除
  if (amCaptain) {
    const offline = captainMutedList.filter((n) => !onlineUsers.some((u) => u.name.toLowerCase() === n.toLowerCase()));
    if (offline.length) {
      onlineNamesEl.appendChild(document.createTextNode('　｜🚫 已禁止（離線）：'));
      offline.forEach((n, i) => {
        if (i > 0) onlineNamesEl.appendChild(document.createTextNode('、'));
        const span = document.createElement('span');
        span.className = 'online-name muted';
        span.textContent = n;
        onlineNamesEl.appendChild(span);
        const b = document.createElement('button');
        b.className = 'rename-btn';
        b.textContent = '✅';
        b.title = `解除「${n}」的操作禁止`;
        b.addEventListener('click', () => socket.emit('captainUnmute', { nickname: n }));
        onlineNamesEl.appendChild(b);
      });
    }
  }
}

socket.on('captain:muted', (list) => {
  captainMutedList = list || [];
  renderOnlineUsersBar();
});

// 「此房間隊長為：XXX」— 隊長不在房間時也會一直顯示
socket.on('room:info', ({ captainName }) => {
  roomCaptainName = captainName || null;
  renderCaptainInfo();
});
function renderCaptainInfo() {
  const captainInfoEl = document.getElementById('captainInfo');
  if (joined && roomCaptainName) {
    captainInfoEl.textContent = '';
    captainInfoEl.appendChild(captainIcon());
    captainInfoEl.appendChild(document.createTextNode(`隊長：${roomCaptainName}`));
    captainInfoEl.classList.remove('hidden');
  } else {
    captainInfoEl.classList.add('hidden');
  }
}

// ---------- 計時匯出 / 匯入（按鈕大家都看得到，只有隊長能用） ----------
function askTimerPermission(onOk) {
  if (!joined) { showToast('請先進入房間'); return; }
  socket.emit('timerTransfer:perm', (res) => {
    if (res && res.ok) onOk();
    else showToast('只有隊長可以使用匯入／匯出計時');
  });
}

async function copyTextToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

function downloadTextFile(name, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// 匯出：不預覽，只確認一次；伺服器產生加密的匯入碼 → 下載 .txt 並複製到剪貼簿
function exportTimerKey() {
  {
    socket.emit('exportTimers', async (res) => {
      if (!res || res.error) { showToast((res && res.error) || '匯出失敗'); return; }
      const d = new Date(Date.now() + clockOffset);
      const p2 = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
      const fileText = `MSCtimer 計時匯入檔（請勿修改內容）\n匯出時間：${d.toLocaleString()}\n\n${res.code}\n`;
      downloadTextFile(`MSCtimer密鑰_${stamp}.txt`, fileText);
      const copied = await copyTextToClipboard(res.code);
      showToast(`已匯出 ${res.count} 個 CH 的計時${copied ? '（已下載檔案並複製匯入碼）' : '（已下載檔案）'}`);
    });
  }
}

const SITE_URL = 'https://msctimer.onrender.com/'; // 匯出時間表最下面附上的網站網址
// 文字版時間表（一開始的版本）：依王分組，每隻王底下依「出現中 → 重生區間 → 倒數中」排序
const EXPORT_STATE_LABEL = { appearing: '出現中', window: '重生區間', counting: '倒數中' };
const EXPORT_STATE_ORDER = { appearing: 0, window: 1, counting: 2 };

function buildTimerTable() {
  const now = Date.now() + clockOffset;
  const d = new Date(now);
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const fileStamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
  const lines = ['【MSCtimer｜楓之谷經典版｜團隊野王計時器】時間表', `匯出時間：${stamp}`, '']; // 不寫房間密碼，貼到公開頻道也安全
  let total = 0;
  (tabs || []).forEach((tab) => {
    const items = [];
    tab.channels.forEach((ch, idx) => {
      if (ch.state === 'idle' || ch.startTime === null) return;
      const minMs = (ch.customMin ?? tab.minMinutes) * 60000;
      const maxMs = (ch.customMax ?? tab.maxMinutes) * 60000;
      const elapsed = now - ch.startTime;
      const spawnAt = ch.startTime + minMs;
      let remain;
      if (ch.state === 'counting') remain = `距重生 ${formatMs(Math.max(0, minMs - elapsed))}`;
      else if (ch.state === 'window') remain = `距最大值 ${formatMs(Math.max(0, maxMs - elapsed))}`;
      else remain = elapsed >= maxMs ? `已超過最大值 +${formatMs(elapsed - maxMs)}` : `距最大值 ${formatMs(maxMs - elapsed)}`;
      items.push({ state: ch.state, spawnAt, text:
        `  ${(EXPORT_STATE_LABEL[ch.state] || ch.state).padEnd(4, '　')}  ch.${String(idx + 1).padStart(2, ' ')}  重生 ${formatClock(spawnAt)}  ${remain}  （${ch.startedBy || '未知'}）` });
    });
    if (items.length === 0) return;
    items.sort((a, b) => (EXPORT_STATE_ORDER[a.state] ?? 9) - (EXPORT_STATE_ORDER[b.state] ?? 9) || a.spawnAt - b.spawnAt);
    lines.push(`■ ${tab.name}（${tab.minMinutes}～${tab.maxMinutes} 分）`);
    items.forEach((it) => lines.push(it.text));
    lines.push('');
    total += items.length;
  });
  lines.push(total === 0 ? '目前沒有進行中的 CH' : `共 ${total} 個進行中的 CH`);
  lines.push('', `🔗 MSCtimer｜楓之谷經典版｜團隊野王計時器 ${SITE_URL}`);
  return { text: lines.join('\n') + '\n', total, fileStamp };
}

function exportTimerTable() {
  {
    socket.emit('exportTimersText', async (res) => {
      if (!res || res.error) { showToast((res && res.error) || '匯出失敗'); return; }
      const { text, total, fileStamp } = buildTimerTable();
      downloadTextFile(`MSCtimer時間表_${fileStamp}.txt`, text);
      const copied = await copyTextToClipboard(text);
      showToast(`已匯出時間表（${total} 個 CH）${copied ? '，並複製到剪貼簿' : ''}`);
    });
  }
}

// 「📋 匯出計時」：先檢查是不是隊長，再讓使用者選要匯出哪一種（選擇本身就是確認，不再另外詢問）
function openExportChooser() {
  askTimerPermission(() => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal export-modal">
        <h3>📋 匯出計時</h3>
        <p class="modal-note">要匯出目前房間的哪一種計時？會下載一個 .txt 檔並複製到剪貼簿。</p>
        <button class="export-choice" data-kind="key">
          <span class="export-choice-title">🔐 匯出密鑰</span>
          <span class="export-choice-desc">加密的匯入碼，可用「📥 匯入計時」匯入到任何房間</span>
        </button>
        <button class="export-choice" data-kind="table">
          <span class="export-choice-title">📝 匯出時間表</span>
          <span class="export-choice-desc">一目了然的文字時間表，方便貼到 Discord／LINE（只能看，不能匯入）</span>
        </button>
        <div class="modal-buttons"><button class="btn-secondary export-cancel">取消</button></div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.export-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('.export-choice').forEach((b) => b.addEventListener('click', () => {
      close();
      if (b.dataset.kind === 'key') exportTimerKey();
      else exportTimerTable();
    }));
  });
}

// 匯入：貼上匯入碼或選擇 .txt 檔 → 確認 → 取代這間房間目前所有的計時
function importTimers() {
  askTimerPermission(() => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal import-modal">
        <h3>📥 匯入計時</h3>
        <p class="modal-note">貼上本網站匯出的匯入碼，或選擇匯出的 .txt 檔。匯入後會<b>取代這間房間目前所有的計時</b>，已經過期的 CH 不會匯入。</p>
        <textarea class="import-text" placeholder="在這裡貼上匯入碼（MSCT1. 開頭）"></textarea>
        <label class="import-file-label">或選擇檔案：<input type="file" accept=".txt,text/plain" class="import-file" /></label>
        <div class="modal-buttons">
          <button class="btn-secondary import-cancel">取消</button>
          <button class="btn-primary import-ok">匯入</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const ta = overlay.querySelector('.import-text');
    const close = () => overlay.remove();
    overlay.querySelector('.import-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.import-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { ta.value = String(reader.result || ''); };
      reader.readAsText(f);
    });
    overlay.querySelector('.import-ok').addEventListener('click', () => {
      const m = ta.value.match(/MSCT1\.[A-Za-z0-9_-]+/);
      if (!m) { showToast('找不到匯入碼，請貼上本網站匯出的內容或選擇匯出檔'); return; }
      if (!confirm('匯入後會取代這間房間目前所有的計時，確定要匯入嗎？')) return;
      socket.emit('importTimers', { code: m[0] }, (res) => {
        if (!res || res.error) { showToast((res && res.error) || '匯入失敗'); return; }
        close();
        showToast(`已匯入 ${res.count} 個 CH 的計時`);
      });
    });
    setTimeout(() => ta.focus(), 50);
  });
}

{
  const exportBtnEl = document.getElementById('exportBtn');
  if (exportBtnEl) exportBtnEl.addEventListener('click', openExportChooser);
  const importBtnEl = document.getElementById('importBtn');
  if (importBtnEl) importBtnEl.addEventListener('click', importTimers);
}

// ---------- 網站版本：網頁開著期間伺服器更新了，提示重新整理 ----------
let knownSiteVersion = null;
socket.on('server:version', (v) => {
  if (!knownSiteVersion) { knownSiteVersion = v; return; }
  if (v !== knownSiteVersion) showUpdateBanner();
});
function showUpdateBanner() {
  if (document.getElementById('updateBanner')) return;
  const bar = document.createElement('div');
  bar.id = 'updateBanner';
  bar.className = 'update-banner';
  bar.textContent = '🔄 網站已更新，請重新整理以套用新版本 ';
  const btn = document.createElement('button');
  btn.textContent = '立即重新整理';
  btn.addEventListener('click', () => {
    try { if (joined) sessionStorage.setItem('msctimer_autorejoin', '1'); } catch (e) { /* ignore */ }
    window.location.reload();
  });
  bar.appendChild(btn);
  document.body.appendChild(bar);
}

// ---------- Socket connection status ----------
socket.on('connect', () => {
  socket.emit('hello', { clientId: myClientId }); // 讓伺服器把同一個瀏覽器的多個分頁算成一人（全站在線人數）
  connStatusEl.textContent = '已連線';
  connStatusEl.className = 'conn-status ok';
  // 斷線後重新連上：自動回到原本的房間；網站更新後的重新整理也直接回去
  let auto = false;
  try { auto = sessionStorage.getItem('msctimer_autorejoin') === '1'; sessionStorage.removeItem('msctimer_autorejoin'); } catch (e) { /* ignore */ }
  if (myNickname && myRoomPassword && (joined || (auto && storageGet(ROOM_KEY)))) {
    socket.emit('joinRoom', { nickname: myNickname, password: myRoomPassword, clientId: myClientId });
  } else if (!joined && myRoomPassword && !nicknameOverlay.classList.contains('hidden')) {
    checkLastRoom(myRoomPassword);
  }
});
socket.on('disconnect', () => {
  connStatusEl.textContent = '連線中斷，嘗試重新連線...';
  connStatusEl.className = 'conn-status err';
});

// ---------- Receiving state ----------
socket.on('state:init', handleState);

// 只有部分 CH 變動（大部分的更新都是這種）：直接改那幾個 CH，再刷新畫面，不重建整個網格
socket.on('channels:update', ({ changes, serverTime }) => {
  if (!Array.isArray(changes)) return;
  if (serverTime) clockOffset = serverTime - Date.now();
  let touched = false;
  changes.forEach(({ tabId, channelIndex, ch }) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || !tab.channels[channelIndex] || !ch) return;
    tab.channels[channelIndex] = ch;
    touched = true;
  });
  if (!touched) return;
  updateGridDisplay();
  renderStatusPanel();
});
socket.on('state:update', handleState);

function handleState(data) {
  clockOffset = data.serverTime - Date.now();
  tabs = data.tabs;

  if (!currentTabId || !tabs.find((t) => t.id === currentTabId)) {
    currentTabId = tabs.length ? tabs[0].id : null;
  }

  renderTabs();
  renderRangePanel();
  renderBossBanner();
  renderGrid();
  renderStatusPanel();
  renderKillCount();
}

// 提醒：進入重生區間（較低的「噹」一聲）、進入出現中（較高的「噹」兩聲）
socket.on('channelAlert', ({ tabId, channelIndex, kind }) => {
  if (tabId === currentTabId) {
    getActiveGridTargets().forEach((target) => {
      const btn = target.querySelector(`[data-idx="${channelIndex}"]`);
      if (btn) {
        btn.classList.add('flash');
        setTimeout(() => btn.classList.remove('flash'), 3000);
      }
    });
  }
  if (kind === 'window') {
    playBeep(660);
  } else {
    playBeep(880);
    setTimeout(() => playBeep(880), 400);
  }
});

// ---------- Activity log (persistent) ----------
socket.on('log:init', (entries) => {
  logListEl.innerHTML = '';
  if (!entries || entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'status-empty';
    empty.textContent = '尚無任何操作紀錄';
    logListEl.appendChild(empty);
    return;
  }
  entries.forEach((e) => logListEl.appendChild(buildLogRow(e)));
});

socket.on('log:new', (entry) => {
  const empty = logListEl.querySelector('.status-empty');
  if (empty) empty.remove();
  logListEl.insertBefore(buildLogRow(entry), logListEl.firstChild);
});

socket.on('log:remove', (logId) => {
  const row = logListEl.querySelector(`[data-id="${logId}"]`);
  if (row) row.remove();
  if (!logListEl.querySelector('.log-row')) {
    const empty = document.createElement('div');
    empty.className = 'status-empty';
    empty.textContent = '尚無任何操作紀錄';
    logListEl.appendChild(empty);
  }
});

socket.on('log:clear', () => {
  logListEl.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'status-empty';
  empty.textContent = '尚無任何操作紀錄';
  logListEl.appendChild(empty);
});

function buildLogRow(entry) {
  const row = document.createElement('div');
  row.className = 'log-row' + (entry.type === 'admin' ? ' sys' : '');
  row.dataset.id = entry.id;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = formatDateTime(entry.time);
  row.appendChild(time);

  const msg = document.createElement('span');
  msg.className = 'log-message';
  msg.textContent = entry.message;
  row.appendChild(msg);

  return row;
}

function formatDateTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------- Tabs ----------
// 切換分頁後，主畫面與子母畫面（若開啟）都要一起刷新
// 目前選的王的擊殺次數（主畫面圖例下方、子母畫面「本王／總頻道」左邊）
function renderKillCount() {
  const tab = getCurrentTab();
  const text = `擊殺：${(tab && tab.killCount) || 0} 次`;
  const main = document.getElementById('killCount');
  if (main) main.textContent = text;
  if (typeof pipDoc !== 'undefined' && pipDoc) {
    const pipEl = pipDoc.getElementById('pipKillCount');
    if (pipEl) pipEl.textContent = text;
  }
}

socket.on('tab:meta', ({ tabId, killCount }) => {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  tab.killCount = killCount;
  if (tabId === currentTabId) renderKillCount();
  if (typeof renderLoot === 'function' && roomLoot[tab.image]) renderLoot();
});

function refreshAfterTabSwitch() {
  renderKillCount();
  renderTabs();
  renderRangePanel();
  renderBossBanner();
  renderGrid();
  if (typeof renderStatusPanel === 'function') renderStatusPanel();
}

function renderTabs() {
  renderTabsInto(tabsListEl, false);
  if (pipTabsListEl) renderTabsInto(pipTabsListEl, true);
}

// compact = true：子母畫面用，只顯示王的圖示（沒有圖片的分頁才退回顯示文字），不顯示鎖頭/刪除鈕，節省橫向空間
// 進行中頻道每一列最左邊的王圖示。沒有圖片的自訂分頁、或圖片載入失敗時，改顯示分頁名稱第一個字的小徽章
function makeBossIcon(doc, image, name) {
  const badge = () => {
    const b = doc.createElement('span');
    b.className = 'status-thumb status-thumb-badge';
    b.textContent = (name || '?').trim().charAt(0) || '?';
    b.title = name || '';
    return b;
  };
  if (!image) return badge();
  const img = doc.createElement('img');
  img.className = 'status-thumb';
  img.alt = '';
  img.title = name || '';
  img.addEventListener('error', () => {
    if (img.dataset.fb !== '1') { img.dataset.fb = '1'; img.src = imageUrl(image); return; }
    if (img.parentNode) img.replaceWith(badge());
  });
  img.src = thumbUrl(image);
  return img;
}

function imageUrl(file) {
  return new URL(`images/${file}`, window.location.href).href;
}

// 小縮圖（分頁、進行中頻道列）用王的臉部特寫；沒有特寫圖時退回原本的大圖
function thumbUrl(file) {
  return new URL(`images/thumbs/${file}`, window.location.href).href;
}

function renderTabsInto(target, compact) {
  // 分頁沒變（同樣的王、名稱、目前選的那隻）就不重畫，避免圖示重新載入而閃爍
  const sig = (compact ? 'c' : 'n') + '|' + currentTabId + '|' + tabs.length + '|' +
    tabs.map((t) => [t.id, t.name, t.image, t.locked ? 1 : 0].join(',')).join(';');
  if (target.dataset.sig === sig) return;
  target.dataset.sig = sig;
  target.innerHTML = '';
  tabs.forEach((tab) => {
    const el = document.createElement('div');
    el.className = 'tab-item' + (tab.id === currentTabId ? ' active' : '') + (compact ? ' tab-item-compact' : '');
    el.title = tab.name;

    if (tab.image) {
      const img = target.ownerDocument.createElement('img');
      const full = imageUrl(tab.image);
      img.addEventListener('error', () => { if (img.src !== full) img.src = full; });
      img.src = thumbUrl(tab.image);
      img.className = 'tab-thumb';
      img.alt = tab.name;
      el.appendChild(img);
    }

    // 有圖片的王只顯示圖片（滑鼠移上去會顯示名稱），沒有圖片的自訂分頁才顯示文字
    if (tab.image) el.classList.add('tab-item-image');
    if (!tab.image) {
      const nameSpan = document.createElement('span');
      nameSpan.textContent = tab.name;
      el.appendChild(nameSpan);
    }

    if (!compact && tab.locked && !tab.image) {
      const lockSpan = document.createElement('span');
      lockSpan.className = 'tab-lock';
      lockSpan.textContent = '🔒';
      lockSpan.title = '固定王，無法刪除或修改時間範圍';
      el.appendChild(lockSpan);
    }

    if (!compact && !tab.locked && tabs.length > 1) {
      const closeBtn = document.createElement('span');
      closeBtn.textContent = '✕';
      closeBtn.className = 'close-btn';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`確定要刪除分頁「${tab.name}」嗎？`)) {
          socket.emit('removeTab', tab.id);
        }
      });
      el.appendChild(closeBtn);
    }

    el.addEventListener('click', () => {
      currentTabId = tab.id;
      refreshAfterTabSwitch();
    });

    el.addEventListener('dblclick', () => {
      const newName = prompt('輸入新的分頁名稱：', tab.name);
      if (newName !== null && newName.trim()) {
        socket.emit('renameTab', { tabId: tab.id, name: newName.trim() });
      }
    });

    target.appendChild(el);
  });
}

addTabBtn.addEventListener('click', () => {
  if (!isSupporterMe()) { showToast('⭐ 新增自訂王是贊助者專屬功能'); return; }
  const name = prompt('輸入新分頁名稱：', `分頁 ${tabs.length + 1}`);
  if (name !== null) {
    socket.emit('addTab', name.trim() || undefined);
  }
});

// ---------- Boss banner ----------
function renderBossBanner() {
  const tab = getCurrentTab();
  if (!tab) return;
  bossNameEl.textContent = tab.name;
  if (tab.image) {
    bossImageEl.src = `images/${tab.image}`;
    bossImageEl.alt = tab.name;
    bossImageEl.classList.remove('hidden');
  } else {
    bossImageEl.classList.add('hidden');
  }
  const dropsBtn = document.getElementById('dropsBtn');
  const hasDrops = !!(tab.image && DROP_BOSSES && DROP_BOSSES.has(tab.image));
  if (dropsBtn) dropsBtn.classList.toggle('hidden', !hasDrops);
  const lootHintEl = document.getElementById('lootHint'); // 沒有戰利品清單的自訂分頁就不顯示提示
  if (lootHintEl) lootHintEl.classList.toggle('hidden', !hasDrops);
  renderBossStats(hasDrops ? tab.image : null);
}

// 王的等級／血量／經驗／出沒地點（顯示在「戰利品」按鈕左邊）
function renderBossStats(image) {
  const el = document.getElementById('bossStats');
  if (!el) return;
  el.innerHTML = '';
  if (!image) return;
  loadDrops().then((d) => {
    const tab = getCurrentTab();
    if (!tab || tab.image !== image) return; // 期間切換了分頁
    const b = d[image];
    if (!b) return;
    el.innerHTML = '';
    const line1 = document.createElement('div');
    line1.className = 'boss-stats-main';
    [['Lv.', b.level], ['HP ', b.maxHP.toLocaleString()], ['經驗 ', b.exp.toLocaleString()]].forEach(([k, v]) => {
      const sp = document.createElement('span');
      sp.textContent = k + v;
      line1.appendChild(sp);
    });
    const line2 = document.createElement('div');
    line2.className = 'boss-stats-map';
    line2.textContent = '出沒：' + b.maps.join('、');
    line2.title = line2.textContent;
    el.appendChild(line1);
    el.appendChild(line2);
  }).catch(() => {});
}

// ---------- 王的掉落物（public/drops/drops.json，從遊戲的怪物圖鑑掉落清單整理；不含機率） ----------
var DROP_BOSSES = new Set(['red-king.png', 'tree-demon-king.png', 'giant-crab.png', 'zombie-monkey-king.png', 'mushroom-king.png',
  'zombie-mushroom-king.png', 'swamp-crocodile.png', 'barogu.png', 'elliget.png', 'snow-fur-monster.png']);
var dropsData = null;
let dropsFilter = '全部';
let dropsCurrent = null;
function loadDrops() {
  if (dropsData) return Promise.resolve(dropsData);
  return fetch('drops/drops.json', { cache: 'no-cache' }).then((r) => r.json()).then((d) => { dropsData = d; return d; });
}
// 全站掉落機率（歷史總計＋本週，所有房間總和；伺服器每 30 秒更新一次）
let lootRatesData = null;
let lootRatesAt = 0;
let dropsSortRate = false;
function loadLootRates(force) {
  if (!isSupporterMe()) { lootRatesData = null; return Promise.resolve(null); } // 贊助者專屬
  if (!force && lootRatesData && Date.now() - lootRatesAt < 30000) return Promise.resolve(lootRatesData);
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(lootRatesData); } }, 5000);
    socket.emit('lootRates', (r) => {
      if (done) return;
      done = true; clearTimeout(t);
      if (r && r.bosses) { lootRatesData = r; lootRatesAt = Date.now(); }
      resolve(lootRatesData);
    });
  });
}
function fmtRate(c, k) {
  if (!k) return '—';
  const p = c / k * 100;
  if (p === 0) return '0%';
  return (p >= 10 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toFixed(3)).replace(/\.?0+$/, '') + '%';
}
function bossRates(image) {
  const b = lootRatesData && lootRatesData.bosses && lootRatesData.bosses[image];
  return b || { all: { k: 0, rooms: 0, i: {} }, week: { k: 0, rooms: 0, i: {} } };
}
function renderRatesSum() {
  const el = document.getElementById('dropsRatesSum');
  if (!el) return;
  const image = getCurrentTab() && getCurrentTab().image;
  if (!isSupporterMe()) { el.innerHTML = ''; const l = document.createElement('span'); l.className = 'drops-rates-locked'; l.textContent = '🔒 📊 全站掉落機率（歷史／本週）為贊助者專屬功能'; el.appendChild(l); return; }
  if (!lootRatesData || !image) { el.textContent = '📊 掉落機率讀取中…'; return; }
  const r = bossRates(image);
  const wk = lootRatesData.week ? lootRatesData.week.slice(5).replace('-', '/') : '';
  el.innerHTML = '';
  const add = (txt, bold) => { const n = bold ? document.createElement('b') : document.createTextNode(txt); if (bold) n.textContent = txt; el.appendChild(n); };
  add('📊 全站統計　歷史：擊殺 '); add(r.all.k.toLocaleString(), true); add(` 次（${r.all.rooms} 間房）　本週（${wk} 起）：擊殺 `); add(r.week.k.toLocaleString(), true); add(' 次');
}
function openDrops() {
  const tab = getCurrentTab();
  if (!tab || !tab.image) return;
  loadDrops().then((d) => {
    const boss = d[tab.image];
    if (!boss) { showToast('這隻王沒有戰利品資料'); return; }
    dropsCurrent = boss;
    dropsFilter = '全部';
    document.getElementById('dropsSearch').value = '';
    document.getElementById('dropsBossImg').src = `images/${tab.image}`;
    document.getElementById('dropsBossName').textContent = boss.name;
    renderDrops();
    document.getElementById('dropsOverlay').classList.remove('hidden');
    loadLootRates().then(() => { if (dropsCurrent === boss) renderDrops(); });
  }).catch(() => showToast('戰利品資料讀取失敗'));
}
function renderDrops() {
  const boss = dropsCurrent;
  if (!boss) return;
  const q = document.getElementById('dropsSearch').value.trim().toLowerCase();
  const kinds = ['全部'].concat([...new Set(boss.drops.map((x) => x.kind))]);
  const fEl = document.getElementById('dropsFilters');
  fEl.innerHTML = '';
  kinds.forEach((k) => {
    const n = k === '全部' ? boss.drops.length : boss.drops.filter((x) => x.kind === k).length;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'drops-chip' + (k === dropsFilter ? ' active' : '');
    b.textContent = `${k} ${n}`;
    b.addEventListener('click', () => { dropsFilter = k; renderDrops(); });
    fEl.appendChild(b);
  });
  {
    const sb = document.createElement('button');
    sb.type = 'button';
    const vip = isSupporterMe();
    sb.className = 'drops-chip sort' + (vip && dropsSortRate ? ' active' : '') + (vip ? '' : ' locked');
    sb.textContent = '📊 依機率排序';
    sb.title = vip ? '依歷史掉落機率由高到低排列' : '⭐ 掉落機率是贊助者專屬功能';
    sb.addEventListener('click', () => {
      if (!isSupporterMe()) { showToast('⭐ 掉落機率是贊助者專屬功能'); return; }
      dropsSortRate = !dropsSortRate; renderDrops();
    });
    fEl.appendChild(sb);
  }
  renderRatesSum();
  const rates = bossRates(getCurrentTab() && getCurrentTab().image);
  const list = document.getElementById('dropsList');
  const keepScroll = list.scrollTop;
  list.innerHTML = '';
  const shown = boss.drops.filter((x) => (dropsFilter === '全部' || x.kind === dropsFilter) && (!q || x.name.toLowerCase().includes(q)));
  if (dropsSortRate && isSupporterMe()) shown.sort((a, b) => (rates.all.i[b.id] || 0) - (rates.all.i[a.id] || 0) || (rates.week.i[b.id] || 0) - (rates.week.i[a.id] || 0));
  document.getElementById('dropsCount').textContent = `戰利品 ${boss.drops.length} 項`;
  if (shown.length === 0) {
    const e = document.createElement('div');
    e.className = 'status-empty';
    e.textContent = '沒有符合的道具';
    list.appendChild(e);
  }
  shown.forEach((x) => {
    const row = document.createElement('div');
    row.className = 'drop-row';
    const ic = document.createElement('div');
    ic.className = 'drop-icon';
    if (x.icon) {
      const img = document.createElement('img');
      img.src = `drops/icons/${x.id}.png`;
      img.alt = x.name;
      img.loading = 'lazy';
      ic.appendChild(img);
    }
    const body = document.createElement('div');
    body.className = 'drop-body';
    const top = document.createElement('div');
    top.className = 'drop-top';
    const nm = document.createElement('span');
    nm.className = 'drop-name';
    nm.textContent = x.name;
    const cat = document.createElement('span');
    cat.className = 'drop-cat kind-' + x.kind;
    cat.textContent = x.cat || x.kind;
    top.appendChild(nm);
    top.appendChild(cat);
    body.appendChild(top);
    if (x.detail) {
      const det = document.createElement('div');
      det.className = 'drop-detail';
      det.textContent = x.detail;
      body.appendChild(det);
    }
    if (isSupporterMe()) {
      const rr = document.createElement('div');
      rr.className = 'drop-rates';
      [['all', '歷史', rates.all], ['week', '本週', rates.week]].forEach(([cls, label, r]) => {
        const c = r.i[x.id] || 0;
        const tag = document.createElement('span');
        tag.className = 'drop-rate ' + cls + (c ? '' : ' zero');
        tag.title = r.k ? `${label}：全站記錄掉落 ${c} 次 ÷ 擊殺 ${r.k} 次` : `${label}：還沒有足夠的擊殺紀錄`;
        tag.append(label + ' ');
        const bb = document.createElement('b');
        bb.textContent = fmtRate(c, r.k);
        tag.appendChild(bb);
        if (c) tag.append(`（${c}）`);
        rr.appendChild(tag);
      });
      body.appendChild(rr);
    }
    if (x.desc) {
      const ds = document.createElement('div');
      ds.className = 'drop-desc';
      ds.textContent = x.desc;
      body.appendChild(ds);
    }
    const image = getCurrentTab() && getCurrentTab().image;
    const n = image ? lootCountOf(image, x.id) : 0;
    const rec = buildLootStepper(document, image, x);
    row.title = `道具編號 ${x.id}｜按 ＋ 記錄一次掉落，按 － 減少一次`;
    row.appendChild(ic);
    row.appendChild(body);
    row.appendChild(rec);
    list.appendChild(row);
  });
  list.scrollTop = keepScroll;
}
(function bindDrops() {
  const btn = document.getElementById('dropsBtn');
  const ov = document.getElementById('dropsOverlay');
  if (!btn || !ov) return;
  btn.addEventListener('click', openDrops);
  document.getElementById('dropsClose').addEventListener('click', () => ov.classList.add('hidden'));
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.add('hidden'); });
  document.getElementById('dropsSearch').addEventListener('input', renderDrops);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ov.classList.add('hidden'); });
})();

// ---------- Range panel ----------
function getCurrentTab() {
  return tabs.find((t) => t.id === currentTabId);
}

function renderRangePanel() {
  const tab = getCurrentTab();
  if (!tab) return;
  minInput.value = tab.minMinutes;
  maxInput.value = tab.maxMinutes;
  minInput.disabled = !!tab.locked;
  maxInput.disabled = !!tab.locked;
  rangeHintEl.textContent = IS_TOUCH ? '點 CH 開始倒數，長按 CH 輸入死亡時間 / 重生時間' : '右鍵輸入死亡時間 或 中鍵輸入重生時間';
}

function submitRangeChange() {
  const tab = getCurrentTab();
  if (!tab) return;
  socket.emit('updateTabRange', {
    tabId: tab.id,
    minMinutes: minInput.value,
    maxMinutes: maxInput.value
  });
}

minInput.addEventListener('change', submitRangeChange);
maxInput.addEventListener('change', submitRangeChange);

// ---------- Grid ----------
// 回傳目前要渲染的所有網格容器（主畫面 + 子母畫面，若有開啟）
function getActiveGridTargets() {
  const targets = [gridEl];
  if (pipGridEl) targets.push(pipGridEl);
  return targets;
}

function renderGrid() {
  const tab = getCurrentTab();
  if (!tab) return;
  renderGridInto(gridEl, tab, false);
  if (pipGridEl) renderGridInto(pipGridEl, tab, true);
  updateGridDisplay();
}

// compact = true：子母畫面用，標籤只顯示數字（不顯示 "ch." 前綴），省空間、字體也較小
function renderGridInto(target, tab, compact) {
  target.innerHTML = '';
  for (let i = 0; i < CHANNEL_COUNT; i++) {
    const btn = document.createElement('div');
    btn.className = 'ch-btn';
    btn.dataset.idx = i;

    const label = document.createElement('div');
    label.className = 'ch-label';
    label.textContent = compact ? `${i + 1}` : `ch. ${i + 1}`;
    btn.appendChild(label);

    const timerEl = document.createElement('div');
    timerEl.className = 'ch-timer';
    btn.appendChild(timerEl);

    const spawnEl = document.createElement('div');
    spawnEl.className = 'ch-spawn';
    btn.appendChild(spawnEl);

    const whoEl = document.createElement('div');
    whoEl.className = 'ch-who';
    btn.appendChild(whoEl);

    // 手機：長按 CH ＝ 右鍵（輸入死亡時間；視窗裡也可以改輸入重生時間）
    let lpTimer = null;
    let lpFired = false;
    let lastTouch = 0;
    btn.addEventListener('touchstart', () => {
      lastTouch = Date.now();
      lpFired = false;
      clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        lpFired = true;
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) { /* ignore */ } }
        if (ensureNickname()) openModal(tab, i);
      }, 550);
    }, { passive: true });
    const cancelLp = () => clearTimeout(lpTimer);
    btn.addEventListener('touchmove', cancelLp, { passive: true });
    btn.addEventListener('touchcancel', cancelLp);
    btn.addEventListener('touchend', (e) => {
      clearTimeout(lpTimer);
      if (lpFired) e.preventDefault(); // 長按後不要再觸發一次點擊
    });

    btn.addEventListener('click', () => {
      if (lpFired) { lpFired = false; return; }
      if (!ensureNickname()) return;
      socket.emit('channelClick', { tabId: tab.id, channelIndex: i });
    });

    // 中鍵：輸入重生時間。mousedown 先擋掉瀏覽器的中鍵自動捲動
    btn.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    btn.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      if (!ensureNickname()) return;
      openSpawnModal(tab, i);
    });

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (Date.now() - lastTouch < 1500) return; // 手機長按由上面的長按處理，避免開兩次
      if (!ensureNickname()) return;
      openModal(tab, i);
    });

    target.appendChild(btn);
  }
}

function ensureNickname() {
  if (!myNickname || !joined) {
    showNicknameOverlay();
    return false;
  }
  return true;
}

function updateGridDisplay() {
  const tab = getCurrentTab();
  if (!tab) return;
  const now = Date.now() + clockOffset;

  getActiveGridTargets().forEach((target) => {
    tab.channels.forEach((ch, i) => {
      const btn = target.querySelector(`[data-idx="${i}"]`);
      if (!btn) return;
      const timerEl = btn.querySelector('.ch-timer');
      const spawnEl = btn.querySelector('.ch-spawn');
      const whoEl = btn.querySelector('.ch-who');

      btn.classList.remove('counting', 'window', 'appearing');

      if (ch.state === 'idle' || ch.startTime === null) {
        timerEl.textContent = '';
        spawnEl.textContent = '';
        whoEl.textContent = '';
        return;
      }

      const minMs = (ch.customMin ?? tab.minMinutes) * 60000;
      const maxMs = (ch.customMax ?? tab.maxMinutes) * 60000;
      const elapsed = now - ch.startTime;

      spawnEl.textContent = `🕒${formatClock(ch.startTime + minMs)}`; // 出生時間 = 最小值倒數結束的時刻
      whoEl.textContent = ch.startedBy ? `👤${ch.startedBy}` : '';

      if (ch.state === 'counting') {
        btn.classList.add('counting');
        timerEl.textContent = formatMs(Math.max(0, minMs - elapsed));
      } else if (ch.state === 'window') {
        btn.classList.add('window');
        timerEl.textContent = formatMs(Math.max(0, maxMs - elapsed)); // 距離最大值還有多久
      } else if (ch.state === 'appearing') {
        btn.classList.add('appearing');
        timerEl.textContent = appearingText(maxMs, elapsed);
      }
    });
  });
}

// 精準時刻 HH:MM:SS（24 小時制，使用者本地時區）
function formatClock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// 出現中：未到最大值 -> 顯示距離最大值的剩餘時間；超過最大值 -> 顯示 +已超過多久（伺服器會在 10 分鐘後移除）
function appearingText(maxMs, elapsed) {
  return elapsed >= maxMs ? `+${formatMs(elapsed - maxMs)}` : formatMs(maxMs - elapsed);
}

function formatMs(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---------- Status panel（本王 / 總頻道，分成 倒數中 / 出現中） ----------
let activeView = 'boss'; // 'boss' = 只看目前選的王；'all' = 總頻道（所有王）

function renderStatusPanel() {
  const now = Date.now() + clockOffset;
  const showAll = activeView === 'all';
  const countingRows = [];
  const windowRows = [];
  const appearingRows = [];

  tabs.forEach((tab) => {
    if (!showAll && tab.id !== currentTabId) return;
    tab.channels.forEach((ch, idx) => {
      if (ch.state === 'idle' || ch.startTime === null) return;
      const minMs = (ch.customMin ?? tab.minMinutes) * 60000;
      const maxMs = (ch.customMax ?? tab.maxMinutes) * 60000;
      const elapsed = now - ch.startTime;
      const spawnAt = ch.startTime + minMs; // 出生時間（最小值倒數結束的時刻）

      const base = {
        tabId: tab.id,
        tabName: tab.name,
        tabImage: tab.image,
        channelIndex: idx,
        who: ch.startedBy || '未知',
        standby: ch.standby || null,
        spawnAt
      };

      if (ch.state === 'counting') {
        const remainingMs = Math.max(0, minMs - elapsed);
        countingRows.push({ ...base, remainingMs, timeText: formatMs(remainingMs), soon: remainingMs <= SOON_THRESHOLD_MS });
      } else if (ch.state === 'window') {
        windowRows.push({ ...base, timeText: formatMs(Math.max(0, maxMs - elapsed)), inWindow: true, maxAt: ch.startTime + maxMs });
      } else if (ch.state === 'appearing') {
        appearingRows.push({ ...base, timeText: appearingText(maxMs, elapsed), overdue: elapsed >= maxMs, maxAt: ch.startTime + maxMs });
      }
    });
  });

  // 倒數中：最接近變成出現中的排最上面；出現中：最早變成出現中的排最上面
  countingRows.sort((a, b) => a.remainingMs - b.remainingMs);
  windowRows.sort((a, b) => a.spawnAt - b.spawnAt);
  appearingRows.sort((a, b) => a.spawnAt - b.spawnAt);
  // 出現中欄位：先列「出現中」（超過最大值），再列「重生區間」（綠色）
  const appearColumnRows = appearingRows.concat(windowRows);

  const emptyC = showAll ? '目前沒有倒數中的 CH' : '這隻王目前沒有倒數中的 CH';
  const emptyA = showAll ? '目前沒有出現中的 CH' : '這隻王目前沒有出現中的 CH';
  renderStatusColumn(statusListCountingEl, countingRows, emptyC, showAll);
  renderStatusColumn(statusListAppearingEl, appearColumnRows, emptyA, showAll);
  if (pipStatusCountingEl) renderStatusColumn(pipStatusCountingEl, countingRows, emptyC, showAll);
  if (pipStatusAppearingEl) renderStatusColumn(pipStatusAppearingEl, appearColumnRows, emptyA, showAll);
}

// 列表內容（哪些 CH、顏色、王名、暱稱…）沒變時，只更新每一列的時間文字，不重建整個列表；
// 這樣王的小圖示不會每秒被重新建立（不會閃爍），內容真的變動時才整個重畫。
function statusSignature(rows, showTabName, emptyText) {
  return (showTabName ? 'A' : 'B') + '|' + emptyText + '|' + rows.map((r) =>
    [r.tabId, r.channelIndex, r.who, r.spawnAt, r.tabImage, r.tabName, r.soon ? 1 : 0, r.inWindow ? 1 : 0, r.overdue ? 1 : 0, r.standby || '', r.maxAt || 0].join(',')
  ).join(';');
}

function renderStatusColumn(container, rows, emptyText, showTabName) {
  const doc = container.ownerDocument;
  const sig = statusSignature(rows, showTabName, emptyText);
  if (container.dataset.sig === sig) {
    const timeEls = container.querySelectorAll('.status-row .status-time');
    rows.forEach((r, i) => { if (timeEls[i] && timeEls[i].textContent !== r.timeText) timeEls[i].textContent = r.timeText; });
    return;
  }
  container.dataset.sig = sig;
  container.innerHTML = '';
  if (rows.length === 0) {
    const empty = doc.createElement('div');
    empty.className = 'status-empty';
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  rows.forEach((r) => {
    const row = doc.createElement('div');
    row.className = 'status-row' + (r.soon ? ' soon' : '') + (r.inWindow ? ' in-window' : '') + (r.overdue ? ' overdue-row' : '');

    // 王的小圖示（「本王」只顯示圖示，「總頻道」顯示圖示 + 王名）
    row.appendChild(makeBossIcon(doc, r.tabImage, r.tabName));

    if (showTabName) {
      const tag = doc.createElement('span');
      tag.className = 'status-tag';
      tag.textContent = r.tabName;
      row.appendChild(tag);
    }

    const chSpan = doc.createElement('span');
    chSpan.className = 'status-ch';
    chSpan.textContent = `ch. ${r.channelIndex + 1}`;
    row.appendChild(chSpan);

    const whoSpan = doc.createElement('span');
    whoSpan.className = 'status-who';
    whoSpan.textContent = `👤${r.who}`;
    row.appendChild(whoSpan);

    if (r.soon) {
      const soonTag = doc.createElement('span');
      soonTag.className = 'status-soon-tag';
      soonTag.textContent = '⚠即將出現';
      row.appendChild(soonTag);
    }

    const spawnSpan = doc.createElement('span');
    spawnSpan.className = 'status-spawn';
    if (r.maxAt) {
      // 出現中欄（重生區間／出現中）：顯示最晚重生時間＝死亡時間＋最大值
      spawnSpan.title = '最晚重生時間（死亡時間＋最大值）';
      spawnSpan.textContent = `最晚 ${formatClock(r.maxAt)}`;
    } else {
      // 倒數中欄：重生時間＝死亡時間＋最小值
      spawnSpan.title = '重生時間（死亡時間＋最小值，王最早會在這個時刻重生）';
      spawnSpan.textContent = `重生 ${formatClock(r.spawnAt)}`;
    }
    row.appendChild(spawnSpan);

    const timeSpan = doc.createElement('span');
    timeSpan.className = 'status-time' + (r.overdue ? ' overdue' : '');
    timeSpan.textContent = r.timeText;
    row.appendChild(timeSpan);

    const killBtn = doc.createElement('button');
    killBtn.className = 'kill-btn';
    killBtn.textContent = '擊殺';
    killBtn.title = '回報剛剛擊殺，重新開始倒數';
    killBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!ensureNickname()) return;
      socket.emit('channelKillNow', { tabId: r.tabId, channelIndex: r.channelIndex });
    });
    row.appendChild(killBtn);

    // 待命：沒人待命時顯示「待命」，按下後變成按的人的暱稱；再按一次變回「待命」
    const standbyBtn = doc.createElement('button');
    standbyBtn.className = 'standby-btn' + (r.standby ? ' taken' : '');
    standbyBtn.textContent = r.standby || '待命';
    standbyBtn.title = r.standby ? `「${r.standby}」待命中，再按一次取消` : '按下表示你在這個 CH 待命';
    standbyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!ensureNickname()) return;
      socket.emit('channelStandby', { tabId: r.tabId, channelIndex: r.channelIndex });
    });
    row.appendChild(standbyBtn);

    row.addEventListener('click', () => {
      currentTabId = r.tabId;
      refreshAfterTabSwitch();
      renderStatusPanel();
    });

    container.appendChild(row);
  });
}

setInterval(() => {
  updateGridDisplay();
  renderStatusPanel();
}, 1000);

// ---------- Modal (右鍵：回報死亡時間，手動輸入時/分，24 小時制) ----------
function pad2(n) { return String(n).padStart(2, '0'); }

function openModal(tab, channelIndex) {
  const ch = tab.channels[channelIndex];
  modalContext = { tabId: tab.id, channelIndex };
  modalTitle.textContent = `回報 CH${channelIndex + 1} 死亡時間`;

  // 預設帶入「現在」（使用者裝置的本地時間），代表王剛剛才死
  const now = new Date(Date.now() + clockOffset);
  modalHour.value = now.getHours();
  modalMinute.value = now.getMinutes();


  modalOverlay.classList.remove('hidden');
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  modalContext = null;
}

modalCancelBtn.addEventListener('click', closeModal);

modalSaveBtn.addEventListener('click', () => {
  if (!modalContext) return;

  const hh = Number(modalHour.value);
  const mm = Number(modalMinute.value);
  if (!Number.isInteger(hh) || hh < 0 || hh > 23 || !Number.isInteger(mm) || mm < 0 || mm > 59) {
    alert('請輸入正確的時間（時：0~23，分：0~59）');
    return;
  }

  // 在使用者自己的瀏覽器本地時區計算絕對時間戳記，避免伺服器與使用者時區不同造成誤差
  const nowLocal = new Date();
  const death = new Date(nowLocal.getFullYear(), nowLocal.getMonth(), nowLocal.getDate(), hh, mm, 0, 0);
  if (death.getTime() > nowLocal.getTime()) {
    death.setDate(death.getDate() - 1); // 該時刻還沒到 -> 視為昨天（死亡時間一定是過去式）
  }

  socket.emit('channelSetCustom', {
    tabId: modalContext.tabId,
    channelIndex: modalContext.channelIndex,
    deathTimeEpoch: death.getTime(),
    deathTimeLabel: `${pad2(hh)}:${pad2(mm)}`
  });
  closeModal();
});

modalResetBtn.addEventListener('click', () => {
  if (!modalContext) return;
  socket.emit('channelSetCustom', {
    tabId: modalContext.tabId,
    channelIndex: modalContext.channelIndex,
    deathTimeEpoch: null
  });
  closeModal();
});

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// 右鍵視窗裡的「改輸入重生時間」：給沒有滑鼠中鍵（例如筆電觸控板）的人用
document.getElementById('modalToSpawnBtn').addEventListener('click', () => {
  if (!modalContext) return;
  const tab = tabs.find((t) => t.id === modalContext.tabId);
  const idx = modalContext.channelIndex;
  closeModal();
  if (tab) openSpawnModal(tab, idx);
});

// ---------- Modal (中鍵：輸入重生時間，絕對時刻：月/日 時:分，預設為現在) ----------
const spawnOverlay = document.getElementById('spawnOverlay');
const spawnTitle = document.getElementById('spawnTitle');
const spawnMonth = document.getElementById('spawnMonth');
const spawnDay = document.getElementById('spawnDay');
const spawnHour = document.getElementById('spawnHour');
const spawnMinute = document.getElementById('spawnMinute');
const spawnPreview = document.getElementById('spawnPreview');
let spawnContext = null; // { tabId, channelIndex }

function openSpawnModal(tab, channelIndex) {
  spawnContext = { tabId: tab.id, channelIndex };
  spawnTitle.textContent = `輸入「${tab.name}」CH${channelIndex + 1} 重生時間`;
  const now = new Date(Date.now() + clockOffset);
  spawnMonth.value = now.getMonth() + 1;
  spawnDay.value = now.getDate();
  spawnHour.value = now.getHours();
  spawnMinute.value = now.getMinutes();
  updateSpawnPreview();
  spawnOverlay.classList.remove('hidden');
  setTimeout(() => { spawnHour.focus(); spawnHour.select(); }, 50);
}

function closeSpawnModal() {
  spawnOverlay.classList.add('hidden');
  spawnContext = null;
}

// 依輸入的 月/日 時:分 算出絕對時間（瀏覽器本地時區）；年份用今年，跨年時自動調整
function readSpawnDate() {
  const mo = Number(spawnMonth.value);
  const d = Number(spawnDay.value);
  const hh = Number(spawnHour.value);
  const mm = Number(spawnMinute.value);
  if (![mo, d, hh, mm].every(Number.isInteger)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  const now = new Date(Date.now() + clockOffset);
  let date = new Date(now.getFullYear(), mo - 1, d, hh, mm, 0, 0);
  if (date.getMonth() !== mo - 1) return null; // 例如 2/30 這種不存在的日期
  const HALF_YEAR = 182 * 24 * 60 * 60 * 1000;
  if (date.getTime() - now.getTime() > HALF_YEAR) date.setFullYear(date.getFullYear() - 1);
  else if (now.getTime() - date.getTime() > HALF_YEAR) date.setFullYear(date.getFullYear() + 1);
  return date;
}

function updateSpawnPreview() {
  const date = readSpawnDate();
  if (!date) {
    spawnPreview.textContent = '請輸入正確的日期與時間';
    return;
  }
  const diff = date.getTime() - (Date.now() + clockOffset);
  spawnPreview.textContent = diff >= 0
    ? `距離重生還有 ${formatMs(diff)}，儲存後此 CH 會倒數到這個時刻變成「出現中」。`
    : `這個時間已經過了 ${formatMs(-diff)}，儲存後此 CH 會直接變成「出現中」。`;
}

[spawnMonth, spawnDay, spawnHour, spawnMinute].forEach((el) => {
  el.addEventListener('input', updateSpawnPreview);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('spawnSaveBtn').click();
    if (e.key === 'Escape') closeSpawnModal();
  });
});

document.getElementById('spawnCancelBtn').addEventListener('click', closeSpawnModal);
spawnOverlay.addEventListener('click', (e) => {
  if (e.target === spawnOverlay) closeSpawnModal();
});

document.getElementById('spawnSaveBtn').addEventListener('click', () => {
  if (!spawnContext) return;
  const date = readSpawnDate();
  if (!date) {
    alert('請輸入正確的日期與時間（月 1~12、日 1~31、時 0~23、分 0~59）');
    return;
  }
  socket.emit('channelSetSpawn', {
    tabId: spawnContext.tabId,
    channelIndex: spawnContext.channelIndex,
    spawnTimeEpoch: date.getTime(),
    spawnTimeLabel: `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  });
  closeSpawnModal();
});

// ---------- 子母畫面（Picture-in-Picture，浮動在螢幕最上層的小視窗） ----------
const pipBtn = document.getElementById('pipBtn');
let pipWindow = null;
let pipDoc = null;
let pipTabsListEl = null;
let pipGridEl = null;
let pipStatusCountingEl = null;
let pipStatusAppearingEl = null;

pipBtn.addEventListener('click', openPip);

async function openPip() {
  if (amMuted) { showToast('您已被禁止操作'); return; }
  if (!('documentPictureInPicture' in window)) {
    alert('您的瀏覽器不支援子母畫面功能，請用電腦版 Chrome 或 Edge 開啟這個網站再試一次。');
    return;
  }
  if (pipWindow) {
    pipWindow.focus();
    return;
  }

  // 子母畫面預設尺寸：以原本的預設大小為基準，寬 x1.2、高 x1.4
  const rightRect = document.querySelector('.main-right').getBoundingClientRect();
  const aspect = rightRect.width / Math.max(1, rightRect.height);
  const baseHeight = Math.min(720, Math.max(380, Math.round((window.screen.height || 900) * 0.6)));
  const baseWidth = Math.max(260, Math.round(baseHeight * aspect));
  // 寬度：原本的 1.3 倍，且至少 460px，確保最上排能一次放下 10 隻王的圖示
  const targetWidth = Math.min(Math.max(Math.round(baseWidth * 1.3), 460), (window.screen.availWidth || 1600) - 40);
  const targetHeight = Math.min(Math.round(baseHeight * 1.4), (window.screen.availHeight || 900) - 40);

  try {
    pipWindow = await documentPictureInPicture.requestWindow({
      width: targetWidth,
      height: targetHeight
    });
  } catch (err) {
    alert('無法開啟子母畫面：' + err.message);
    pipWindow = null;
    return;
  }

  pipDoc = pipWindow.document;
  pipDoc.documentElement.classList.add('is-pip'); // 子母畫面不要套用手機版排版
  setThemeClass(pipDoc.documentElement, currentTheme());
  pipDoc.title = 'MSCtimer｜楓之谷經典版｜團隊野王計時器';

  // 套用跟主頁一樣的樣式表
  const link = pipDoc.createElement('link');
  link.rel = 'stylesheet';
  // 用跟主畫面同一個樣式表網址（含版本號），子母畫面也不會用到舊的快取
  const mainCss = document.querySelector('link[rel="stylesheet"]');
  link.href = mainCss ? mainCss.href : new URL('style.css', window.location.href).href;
  pipDoc.head.appendChild(link);

  pipDoc.body.classList.add('pip-body');

  pipDoc.body.innerHTML = `
    <div class="pip-root">
      <div class="tabs-row" id="pipTabsRow">
        <div class="tabs-list" id="pipTabsList"></div>
      </div>
      <div class="grid-wrapper">
        <div class="grid" id="pipGrid"></div>
      </div>
      <div class="panel active-panel" id="pipActivePanel">
        <div class="panel-title-row">
          <div class="panel-title">📋 進行中頻道</div>
          <div class="pip-title-right"><button type="button" class="loot-add-btn" id="pipLootAdd" title="記錄這隻王的戰利品掉落">＋戰利品</button><span class="kill-count" id="pipKillCount"></span><div class="view-toggle"><button data-view="boss">本王</button><button data-view="all">總頻道</button></div></div>
        </div>
        <div class="active-columns">
          <div class="active-sub-panel">
            <div class="sub-panel-title">⏳ 倒數中</div>
            <div id="pipStatusCounting" class="status-list scrollable"></div>
          </div>
          <div class="active-sub-panel">
            <div class="sub-panel-title appear-title"><span>🌟 出現中</span><span class="appear-tools"><button type="button" class="loot-btn" title="本房間記錄到的戰利品（在「📦 戰利品」目錄裡點道具即可記錄）">📦 戰利品</button><button type="button" class="killpoint-btn" title="每次按「擊殺」時，王已經重生了多久">⏱ 時間點</button></span></div>
            <div class="killpoint-pop hidden"></div>
            <div class="loot-pop hidden"></div>
            <div id="pipStatusAppearing" class="status-list scrollable"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  pipTabsListEl = pipDoc.getElementById('pipTabsList');
  pipGridEl = pipDoc.getElementById('pipGrid');
  pipStatusCountingEl = pipDoc.getElementById('pipStatusCounting');
  pipStatusAppearingEl = pipDoc.getElementById('pipStatusAppearing');
  bindViewToggle(pipDoc);
  bindKillPoints(pipDoc);
  bindLoot(pipDoc);
  pipDoc.getElementById('pipLootAdd').addEventListener('click', (e) => { e.stopPropagation(); openLootPicker(pipDoc); });

  pipWindow.addEventListener('pagehide', () => {
    pipWindow = null;
    pipDoc = null;
    pipTabsListEl = null;
    pipGridEl = null;
    pipStatusCountingEl = null;
    pipStatusAppearingEl = null;
  });

  // 立刻把目前的資料畫進子母畫面
  refreshAfterTabSwitch();
  renderStatusPanel();
}

// ---------- 本王 / 總頻道 切換鈕（主畫面與子母畫面共用同一個狀態） ----------
function bindViewToggle(root) {
  root.querySelectorAll('.view-toggle button').forEach((b) => {
    b.addEventListener('click', () => {
      activeView = b.dataset.view;
      syncViewToggles();
      renderStatusPanel();
    });
  });
  syncViewToggles();
}

function syncViewToggles() {
  [document, pipDoc].forEach((d) => {
    if (!d) return;
    d.querySelectorAll('.view-toggle button').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === activeView);
    });
  });
}

bindViewToggle(document);

// ---------- 「時間點」紀錄：每次擊殺時王已經重生多久（擊殺當下經過時間 − 最小值） ----------
// 例：殭屍蘑菇王 40~60 分，距離最晚還剩 15:00 時擊殺 → 05:00；超過最晚 00:02 時擊殺 → 20:02
let killPoints = [];

// 判斷「五分區間」或「四分區間」：時間點在 5 分 / 4 分倍數的正負 30 秒內就算符合
// 例：20:00 ±30 秒 → 五分區間（20 也是 4 的倍數，所以同時算四分區間，兩邊各 +1）；16:00 ±30 秒 → 四分區間
const KP_TOLERANCE_MS = 30 * 1000;
function fitsStep(ms, stepMs) {
  const r = ((ms % stepMs) + stepMs) % stepMs; // 離最近倍數多遠
  return r <= KP_TOLERANCE_MS || r >= stepMs - KP_TOLERANCE_MS;
}
function classifyKillPoint(ms) {
  if (ms < -KP_TOLERANCE_MS) return { key: 'early', five: false, four: false, text: '未到重生' };
  const five = fitsStep(ms, 5 * 60000);
  const four = fitsStep(ms, 4 * 60000);
  if (five && four) return { key: 'both', five, four };
  if (five) return { key: 'five', five, four };
  if (four) return { key: 'four', five, four };
  return { key: 'none', five, four, text: '都不符合', title: '離 5 分和 4 分倍數都超過 30 秒' };
}

function formatKillPoint(ms) {
  return ms >= 0 ? formatMs(ms) : '-' + formatMs(-ms);
}

function renderKillPointsInto(d) {
  if (!d) return;
  const pop = d.querySelector('.killpoint-pop');
  if (!pop) return;
  pop.innerHTML = '';
  const head = d.createElement('div');
  head.className = 'killpoint-head';
  const title = d.createElement('span');
  title.textContent = `時間點紀錄（${killPoints.length}）`;
  title.title = '擊殺當下，王已經重生了多久（死亡後經過的時間 − 最小值）';
  head.appendChild(title);
  const clearBtn = d.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'killpoint-clear';
  clearBtn.textContent = '清空';
  clearBtn.title = '只有隊長可以清空';
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!joined) return;
    if (!(d.defaultView || window).confirm('確定要清空所有時間點紀錄嗎？')) return;
    socket.emit('clearKillPoints', (res) => {
      if (!res || !res.ok) showToast((res && res.error) || '只有隊長可以清空時間點紀錄');
    });
  });
  head.appendChild(clearBtn);
  pop.appendChild(head);

  // 統計：五分區間 / 四分區間各幾筆（重疊的兩邊都算）—— 只有管理者看得到
  if (window.__mscAdmin) {
  const cnt = { five: 0, four: 0, none: 0, early: 0 };
  killPoints.forEach((k) => {
    const c = classifyKillPoint(k.ms);
    if (c.five) cnt.five++;
    if (c.four) cnt.four++;
    if (c.key === 'none') cnt.none++;
    if (c.key === 'early') cnt.early++;
  });
  const sum = d.createElement('div');
  sum.className = 'killpoint-sum';
  [['five', '五分區間'], ['four', '四分區間']].forEach(([key, label]) => {
    const b = d.createElement('span');
    b.className = 'kp-tag ' + key;
    b.textContent = `${label} ${cnt[key]} 筆`;
    sum.appendChild(b);
  });
  const other = cnt.none + cnt.early;
  if (other > 0) {
    const o = d.createElement('span');
    o.className = 'killpoint-sum-other';
    o.textContent = `其他 ${other} 筆`;
    o.title = `都不符合 ${cnt.none}、未到重生 ${cnt.early}`;
    sum.appendChild(o);
  }
  pop.appendChild(sum);
  }

  const list = d.createElement('div');
  list.className = 'killpoint-list';
  if (killPoints.length === 0) {
    const empty = d.createElement('div');
    empty.className = 'status-empty';
    empty.textContent = '還沒有紀錄，按「擊殺」時會自動記一筆';
    list.appendChild(empty);
  }
  killPoints.forEach((k) => {
    const row = d.createElement('div');
    row.className = 'killpoint-row';
    const name = d.createElement('span');
    name.className = 'killpoint-name';
    const boss = d.createElement('span');
    boss.className = 'killpoint-boss';
    boss.textContent = k.tabName;
    boss.title = k.tabName;
    const chEl = d.createElement('span');
    chEl.className = 'killpoint-ch';
    chEl.textContent = `ch.${k.channel}`;
    name.appendChild(boss);
    name.appendChild(chEl);
    const val = d.createElement('span');
    val.className = 'killpoint-val' + (k.ms < 0 ? ' early' : '');
    val.textContent = formatKillPoint(k.ms);
    const meta = d.createElement('span');
    meta.className = 'killpoint-meta';
    meta.textContent = `${formatClock(k.at)} ${k.by || ''}`;
    row.appendChild(name);
    row.appendChild(val);
    row.appendChild(meta);
    // 五分 / 四分區間的標籤只有管理者看得到
    if (window.__mscAdmin) {
    const c = classifyKillPoint(k.ms);
    const tags = d.createElement('span');
    tags.className = 'kp-tags';
    const addTag = (cls, text, title) => {
      const t = d.createElement('span');
      t.className = 'kp-tag ' + cls;
      t.textContent = text;
      if (title) t.title = title;
      tags.appendChild(t);
    };
    if (c.five) addTag('five', '五分區間', c.four ? '同時符合 5 分與 4 分倍數，兩邊都 +1' : '');
    if (c.four) addTag('four', '四分區間', c.five ? '同時符合 5 分與 4 分倍數，兩邊都 +1' : '');
    if (!c.five && !c.four) addTag(c.key, c.text, c.title);
    row.appendChild(tags);
    }
    list.appendChild(row);
  });
  pop.appendChild(list);
}

function renderKillPoints() {
  renderKillPointsInto(document);
  if (typeof pipDoc !== 'undefined' && pipDoc) renderKillPointsInto(pipDoc);
}

function bindKillPoints(d) {
  const btn = d.querySelector('.killpoint-btn');
  const pop = d.querySelector('.killpoint-pop');
  if (!btn || !pop) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeLootPop(d);
    pop.classList.toggle('hidden');
    btn.classList.toggle('active', !pop.classList.contains('hidden'));
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
  d.addEventListener('click', () => {
    pop.classList.add('hidden');
    btn.classList.remove('active');
  });
  renderKillPointsInto(d);
}

// ---------- 「戰利品」紀錄：本房間各王記錄到的掉落（在戰利品目錄點道具記錄） ----------
var roomLoot = {}; // { 王圖檔: { 道具編號: 次數 } }
function lootCountOf(image, id) { return (roomLoot[image] && roomLoot[image][id]) || 0; }
function closeLootPop(d) {
  const p = d.querySelector('.loot-pop'); const b = d.querySelector('.loot-btn');
  if (p) p.classList.add('hidden'); if (b) b.classList.remove('active');
}
function closeKillPointPop(d) {
  const p = d.querySelector('.killpoint-pop'); const b = d.querySelector('.killpoint-btn');
  if (p) p.classList.add('hidden'); if (b) b.classList.remove('active');
}
function renderLootInto(d) {
  if (!d) return;
  const pop = d.querySelector('.loot-pop');
  const btn = d.querySelector('.loot-btn');
  if (!pop) return;
  const total = Object.values(roomLoot).reduce((a, m) => a + Object.values(m).reduce((x, y) => x + y, 0), 0);
  if (btn) btn.textContent = total ? `📦 戰利品 ${total}` : '📦 戰利品';
  pop.innerHTML = '';
  const head = d.createElement('div');
  head.className = 'killpoint-head';
  const title = d.createElement('span');
  title.textContent = `本房間戰利品紀錄（${total}）`;
  head.appendChild(title);
  const clearBtn = d.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'killpoint-clear';
  clearBtn.textContent = '清空';
  clearBtn.title = '只有隊長可以清空';
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!joined) return;
    if (!(d.defaultView || window).confirm('確定要清空本房間所有戰利品紀錄嗎？')) return;
    socket.emit('lootClear', (res) => { if (!res || !res.ok) showToast((res && res.error) || '只有隊長可以清空戰利品紀錄'); });
  });
  head.appendChild(clearBtn);
  pop.appendChild(head);
  const list = d.createElement('div');
  list.className = 'killpoint-list';
  const imgs = Object.keys(roomLoot).filter((img) => Object.keys(roomLoot[img]).length);
  if (imgs.length === 0) {
    const empty = d.createElement('div');
    empty.className = 'status-empty';
    empty.textContent = '還沒有紀錄。打開王的「📦 戰利品」目錄，點道具即可記錄一次。';
    list.appendChild(empty);
  }
  const dd = dropsData;
  imgs.forEach((img) => {
    const boss = dd && dd[img];
    const tab = tabs.find((t) => t.image === img);
    const grp = d.createElement('div');
    grp.className = 'loot-group';
    const gh = d.createElement('div');
    gh.className = 'loot-group-head';
    gh.textContent = `${boss ? boss.name : (tab ? tab.name : img)}`;
    const kc = d.createElement('span');
    kc.className = 'loot-kills';
    kc.textContent = `擊殺 ${tab ? (tab.killCount || 0) : 0} 次`;
    gh.appendChild(kc);
    grp.appendChild(gh);
    Object.entries(roomLoot[img]).sort((a, b) => b[1] - a[1]).forEach(([id, c]) => {
      const info = boss && boss.drops.find((x) => String(x.id) === String(id));
      const row = d.createElement('div');
      row.className = 'loot-row';
      const ic = d.createElement('span');
      ic.className = 'loot-icon';
      if (info && info.icon) { const im = d.createElement('img'); im.src = `drops/icons/${id}.png`; im.alt = ''; ic.appendChild(im); }
      const nm = d.createElement('span');
      nm.className = 'loot-name';
      nm.textContent = info ? info.name : id;
      const cnt = d.createElement('span');
      cnt.className = 'loot-count';
      cnt.textContent = `×${c}`;
      const minus = d.createElement('button');
      minus.type = 'button';
      minus.className = 'loot-minus';
      minus.textContent = '−';
      minus.title = '記錯了？減少一次';
      minus.addEventListener('click', (e) => { e.stopPropagation(); socket.emit('lootUndo', { image: img, itemId: Number(id) }); });
      row.appendChild(ic); row.appendChild(nm); row.appendChild(cnt);
      {
        const brag = d.createElement('button');
        brag.type = 'button';
        brag.className = 'loot-brag' + (isSupporterMe() ? '' : ' locked');
        brag.title = isSupporterMe() ? '炫耀：向全站宣布你獲得了這個戰利品（贊助者專屬）' : '⭐ 炫耀是贊助者專屬功能';
        brag.textContent = '📣';
        brag.addEventListener('click', (e) => { e.stopPropagation(); bragItem(img, { id: Number(id), name: info ? info.name : id }, d); });
        row.appendChild(brag);
      }
      row.appendChild(minus);
      grp.appendChild(row);
    });
    list.appendChild(grp);
  });
  pop.appendChild(list);
}
function renderLoot() {
  renderLootInto(document);
  if (typeof pipDoc !== 'undefined' && pipDoc) renderLootInto(pipDoc);
  if (typeof dropsCurrent !== 'undefined' && dropsCurrent && !document.getElementById('dropsOverlay').classList.contains('hidden')) renderDrops();
  [document, typeof pipDoc !== 'undefined' ? pipDoc : null].forEach((d) => {
    const ov = d && d.querySelector('.loot-picker-ov');
    if (ov && ov._render) ov._render();
  });
}
function bindLoot(d) {
  const btn = d.querySelector('.loot-btn');
  const pop = d.querySelector('.loot-pop');
  if (!btn || !pop) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeKillPointPop(d);
    const opening = pop.classList.contains('hidden');
    pop.classList.toggle('hidden');
    btn.classList.toggle('active', opening);
    if (opening) loadDrops().then(() => renderLootInto(d)).catch(() => {});
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
  d.addEventListener('click', () => closeLootPop(d));
  renderLootInto(d);
}
bindLoot(document);

// 線上名單：收在「🟢 線上 N 人 ▾」裡，點開才顯示（讓上方工具列維持一列）
(function bindOnlinePop() {
  const t = document.getElementById('onlineToggle');
  const p = document.getElementById('onlinePop');
  if (!t || !p) return;
  t.addEventListener('click', (e) => { e.stopPropagation(); p.classList.toggle('hidden'); t.classList.toggle('active', !p.classList.contains('hidden')); });
  p.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { p.classList.add('hidden'); t.classList.remove('active'); });
})();

// 子母畫面用的「新增戰利品」挑選視窗（在該視窗內開啟；點道具記錄一次）
// 「－ 數字 ＋」戰利品記錄按鈕（主畫面戰利品目錄、子母畫面「＋戰利品」共用）
function buildLootStepper(d, image, item) {
  const n = image ? lootCountOf(image, item.id) : 0;
  const rec = d.createElement('div');
  rec.className = 'drop-rec drop-stepper' + (n ? ' has' : '');
  const minus = d.createElement('button');
  minus.type = 'button';
  minus.className = 'drop-step minus';
  minus.textContent = '－';
  minus.title = '記錯了，減少一次';
  minus.disabled = !n;
  const num = d.createElement('span');
  num.className = 'drop-num';
  num.textContent = String(n);
  const plus = d.createElement('button');
  plus.type = 'button';
  plus.className = 'drop-step plus';
  plus.textContent = '＋';
  plus.title = '記錄一次掉落';
  plus.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!ensureNickname() || !image) return;
    socket.emit('lootRecord', { image, itemId: item.id }, (res) => {
      if (res && res.ok) showToast(`已記錄：${item.name}（本房間第 ${res.count} 個）`);
      else showToast((res && res.error) || '記錄失敗');
    });
  });
  minus.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!ensureNickname() || !image || !lootCountOf(image, item.id)) return;
    socket.emit('lootUndo', { image, itemId: item.id });
  });
  rec.append(minus, num, plus);
  return rec;
}

function openLootPicker(d) {
  const tab = getCurrentTab();
  if (!tab || !tab.image || !DROP_BOSSES.has(tab.image)) { showToast('這隻王沒有戰利品資料'); return; }
  loadDrops().then((data) => {
    const boss = data[tab.image];
    if (!boss) return;
    let ov = d.querySelector('.loot-picker-ov');
    if (ov) ov.remove();
    ov = d.createElement('div');
    ov.className = 'loot-picker-ov';
    ov.dataset.image = tab.image;
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    const box = d.createElement('div');
    box.className = 'loot-picker';
    const head = d.createElement('div');
    head.className = 'loot-picker-head';
    head.innerHTML = '';
    const t = d.createElement('span'); t.textContent = `＋戰利品：${boss.name}`;
    const close = d.createElement('button'); close.type = 'button'; close.className = 'drops-close'; close.textContent = '✕';
    close.addEventListener('click', () => ov.remove());
    head.appendChild(t); head.appendChild(close);
    const search = d.createElement('input'); search.type = 'search'; search.placeholder = '搜尋道具名稱…'; search.className = 'loot-picker-search';
    const list = d.createElement('div'); list.className = 'loot-picker-list';
    box.appendChild(head); box.appendChild(search); box.appendChild(list);
    ov.appendChild(box);
    d.body.appendChild(ov);
    const render = () => {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      boss.drops.filter((x) => !q || x.name.toLowerCase().includes(q)).forEach((x) => {
        const row = d.createElement('div');
        row.className = 'loot-picker-row';
        const ic = d.createElement('span'); ic.className = 'loot-icon';
        if (x.icon) { const im = d.createElement('img'); im.src = `drops/icons/${x.id}.png`; im.alt = ''; ic.appendChild(im); }
        const nm = d.createElement('span'); nm.className = 'loot-name'; nm.textContent = x.name;
        row.appendChild(ic); row.appendChild(nm); row.appendChild(buildLootStepper(d, tab.image, x));
        list.appendChild(row);
      });
    };
    const render0 = render;
    ov._render = () => { const st = list.scrollTop; render0(); list.scrollTop = st; };
    search.addEventListener('input', render);
    render();
    search.focus();
  }).catch(() => showToast('戰利品資料讀取失敗'));
}
socket.on('loot:init', (data) => {
  roomLoot = data && typeof data === 'object' ? data : {};
  loadDrops().then(renderLoot).catch(renderLoot);
});
socket.on('loot:update', ({ image, itemId, count } = {}) => {
  if (!image) return;
  if (!roomLoot[image]) roomLoot[image] = {};
  if (count > 0) roomLoot[image][itemId] = count; else delete roomLoot[image][itemId];
  if (Object.keys(roomLoot[image]).length === 0) delete roomLoot[image];
  renderLoot();
});

bindKillPoints(document);

socket.on('killpoint:init', (list) => {
  killPoints = Array.isArray(list) ? list : [];
  renderKillPoints();
});

socket.on('killpoint:new', (entry) => {
  if (!entry) return;
  killPoints.unshift(entry);
  if (killPoints.length > 100) killPoints.length = 100;
  renderKillPoints();
});

// 擊殺音效音量：滑桿 0~100 對應實際音量 0~KILL_SOUND_MAX（最高 50%），預設 10%
const KILL_SOUND_MAX = 0.5;
const KILL_VOLUME_KEY = 'msctimer_kill_volume';
let killVolume = parseFloat(storageGet(KILL_VOLUME_KEY));
if (!Number.isFinite(killVolume) || killVolume < 0 || killVolume > KILL_SOUND_MAX) killVolume = 0.1;
// 提示音音量：滑桿 0~100 對應 0~ALERT_SOUND_MAX，預設 0.045（目前的音量）
const ALERT_SOUND_MAX = 0.15;
const ALERT_VOLUME_KEY = 'msctimer_alert_volume';
let alertVolume = parseFloat(storageGet(ALERT_VOLUME_KEY));
if (!Number.isFinite(alertVolume) || alertVolume < 0 || alertVolume > ALERT_SOUND_MAX) alertVolume = 0.045;

// ---------- 音效設定（擊殺音效 / 提示音 各自開關；只影響自己這台瀏覽器，會記住） ----------
const KILL_SOUND_KEY = 'msctimer_kill_sound';
const ALERT_SOUND_KEY = 'msctimer_alert_sound';
if (storageGet('msctimer_muted') === '1') { // 舊版「全站靜音」→ 兩個都關
  storageSet(KILL_SOUND_KEY, '0'); storageSet(ALERT_SOUND_KEY, '0'); storageSet('msctimer_muted', '0');
}
let killSoundOn = storageGet(KILL_SOUND_KEY) !== '0';
let alertSoundOn = storageGet(ALERT_SOUND_KEY) !== '0';
const soundBtn = document.getElementById('soundBtn');
const soundPop = document.getElementById('soundPop');
const optKillSound = document.getElementById('optKillSound');
const optAlertSound = document.getElementById('optAlertSound');
function renderSoundBtn() {
  if (!soundBtn) return;
  const icon = killSoundOn && alertSoundOn ? '🔊' : (!killSoundOn && !alertSoundOn ? '🔇' : '🔉');
  soundBtn.innerHTML = '';
  soundBtn.append(icon);
  const sl = document.createElement('span'); sl.className = 'btn-label'; sl.textContent = ' 音效';
  soundBtn.appendChild(sl);
  soundBtn.classList.toggle('muted', !killSoundOn && !alertSoundOn);
  soundBtn.title = `擊殺音效：${killSoundOn ? '開' : '關'}／提示音：${alertSoundOn ? '開' : '關'}`;
  if (optKillSound) optKillSound.checked = killSoundOn;
  if (optAlertSound) optAlertSound.checked = alertSoundOn;
}
if (soundBtn && soundPop) {
  soundBtn.addEventListener('click', (e) => { e.stopPropagation(); soundPop.classList.toggle('hidden'); });
  soundPop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => soundPop.classList.add('hidden'));
  optKillSound.addEventListener('change', () => {
    killSoundOn = optKillSound.checked; storageSet(KILL_SOUND_KEY, killSoundOn ? '1' : '0'); renderSoundBtn();
  });
  optAlertSound.addEventListener('change', () => {
    alertSoundOn = optAlertSound.checked; storageSet(ALERT_SOUND_KEY, alertSoundOn ? '1' : '0'); renderSoundBtn();
    if (alertSoundOn) playBeep(660); // 打開時試聽一下
  });
  const killVolumeEl = document.getElementById('killVolume');
  if (killVolumeEl) {
    killVolumeEl.value = String(Math.round(killVolume / KILL_SOUND_MAX * 100));
    killVolumeEl.addEventListener('input', () => {
      killVolume = Math.max(0, Math.min(KILL_SOUND_MAX, Number(killVolumeEl.value) / 100 * KILL_SOUND_MAX));
      storageSet(KILL_VOLUME_KEY, String(killVolume));
    });
    // 放開滑桿時試聽一下（擊殺音效有開才播）
    killVolumeEl.addEventListener('change', () => playKillSound('mushroom-king.png'));
  }
  const alertVolumeEl = document.getElementById('alertVolume');
  if (alertVolumeEl) {
    alertVolumeEl.value = String(Math.round(alertVolume / ALERT_SOUND_MAX * 100));
    alertVolumeEl.addEventListener('input', () => {
      alertVolume = Math.max(0, Math.min(ALERT_SOUND_MAX, Number(alertVolumeEl.value) / 100 * ALERT_SOUND_MAX));
      storageSet(ALERT_VOLUME_KEY, String(alertVolume));
    });
    alertVolumeEl.addEventListener('change', () => playBeep(660)); // 放開時試聽
  }
  renderSoundBtn();
}

// ---------- 擊殺音效：按「擊殺」時播放該王的受傷（80%）或死亡（20%）音效 ----------
const BOSS_SOUNDS = {
  'red-king.png': 'red-king',
  'tree-demon-king.png': 'tree-demon-king',
  'giant-crab.png': 'giant-crab',
  'zombie-monkey-king.png': 'zombie-monkey-king',
  'mushroom-king.png': 'mushroom-king',
  'zombie-mushroom-king.png': 'zombie-mushroom-king',
  'swamp-crocodile.png': 'swamp-crocodile',
  'barogu.png': 'barogu',
  'elliget.png': 'elliget',
  'snow-fur-monster.png': 'snow-fur-monster'
};
const killAudioCache = {};
// 房間裡任何人按「擊殺」，伺服器會通知整個房間播放（各自依自己的音效設定與音量）
socket.on('killSound', ({ image, kind } = {}) => playKillSound(image, kind));
function playKillSound(image, kindFromServer) {
  if (!killSoundOn) return;
  const key = image && BOSS_SOUNDS[String(image).split('/').pop()];
  if (!key) return; // 自訂的王沒有音效
  const kind = kindFromServer === 'die' || kindFromServer === 'damage' ? kindFromServer : (Math.random() < 0.8 ? 'damage' : 'die');
  const src = `/sounds/${key}-${kind}.mp3`;
  try {
    if (!killAudioCache[src]) { killAudioCache[src] = new Audio(src); killAudioCache[src].preload = 'auto'; }
    const a = killAudioCache[src].cloneNode();
    a.volume = killVolume;
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* 播放失敗就算了 */ }
}

// ---------- Sound alert ----------
let audioCtx = null;
function playBeep(freq) {
  if (!alertSoundOn) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq || 880;
    gain.gain.value = alertVolume; // 由音效設定的滑桿決定（預設 0.045）
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.35);
  } catch (e) {
    // 瀏覽器可能封鎖自動播放音效，忽略即可
  }
}

// ---------- 使用指南 ----------
(function setupGuide() {
  const overlay = document.getElementById('guideOverlay');
  const btn = document.getElementById('guideBtn');
  if (!overlay || !btn) return;
  const open = () => { overlay.classList.remove('hidden'); overlay.querySelector('.guide-body').scrollTop = 0; };
  const close = () => overlay.classList.add('hidden');
  btn.addEventListener('click', open);
  const joinBtn = document.getElementById('joinGuideBtn'); // 進入房間（輸入暱稱）視窗裡也有一顆
  if (joinBtn) joinBtn.addEventListener('click', open);
  document.getElementById('guideCloseBtn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close(); });
})();

// ---------- 更新日誌（有新的一筆時，按鈕上顯示小紅點，打開看過就消失） ----------
(function setupChangelog() {
  const overlay = document.getElementById('changelogOverlay');
  const btn = document.getElementById('changelogBtn');
  const dot = document.getElementById('changelogDot');
  if (!overlay || !btn) return;
  const first = overlay.querySelector('.cl-entry');
  const latest = first ? first.dataset.id : '';
  const KEY = 'msctimer_changelog_seen';
  if (dot && latest && storageGet(KEY) !== latest) dot.classList.remove('hidden');
  const open = () => {
    overlay.classList.remove('hidden');
    document.getElementById('changelogBody').scrollTop = 0;
    if (latest) storageSet(KEY, latest);
    if (dot) dot.classList.add('hidden');
  };
  const close = () => overlay.classList.add('hidden');
  btn.addEventListener('click', open);
  document.getElementById('changelogCloseBtn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close(); });
})();

// ---------- 贊助 ----------
// 收款連結：網址留空 = 還在審核中（按鈕會顯示「審核中」且不能點）
const DONATE_LINKS = [
  { name: '歐付寶', icon: '🟢', url: 'https://p.opay.tw/SQau5', qr: 'images/opay-qr.png', opayId: '2506114' },
  // 加上 pending: true 會變成「審核中」（按鈕灰掉不能按）
  { name: '綠界', icon: '🟩', url: 'https://p.ecpay.com.tw/060CC2F', qr: 'images/ecpay-qr.png', qrPhone: true },
  // PayPal 暫時停用（目前沒有海外贊助）。要恢復的話把下一行最前面的 // 拿掉
  // { name: 'PayPal', label: 'PayPal（海外信用卡）', icon: '💳', url: 'https://www.paypal.com/ncp/payment/LWHNMPF397KA4' }
];
(function setupDonate() {
  const overlay = document.getElementById('donateOverlay');
  const btn = document.getElementById('donateBtn');
  if (!overlay || !btn) return;
  const linksEl = document.getElementById('donateLinks');
  const boardEl = document.getElementById('donateBoard');
  const sel = document.getElementById('donateMonthSel');

  const nameIn = document.getElementById('donName');
  const amtIn = document.getElementById('donAmount');
  const msgIn = document.getElementById('donMsg');
  const anonIn = document.getElementById('donAnon');
  let savedName = '';
  anonIn.addEventListener('change', () => {
    if (anonIn.checked) { savedName = nameIn.value; nameIn.value = ''; } else if (!nameIn.value) nameIn.value = savedName;
    nameIn.disabled = anonIn.checked;
    nameIn.placeholder = anonIn.checked ? '匿名贊助（不用填）' : '要顯示在贊助榜上的名字';
  });
  const errEl = document.getElementById('donateError');
  const resEl = document.getElementById('donateResult');
  const showErr = (m) => { errEl.textContent = m; errEl.classList.toggle('hidden', !m); };

  DONATE_LINKS.forEach((l, i) => {
    if (l.pending) l = { ...l, url: '', qr: '' }; // 審核中：不提供連結與 QR Code
    // 掃碼付款（歐付寶 TWQR）：點了展開 QR Code，不另開頁面
    if (l.qr && !l.url) {
      const a = document.createElement('button');
      a.type = 'button';
      a.className = 'donate-link';
      a.textContent = `${i + 1}. ${l.icon} ${l.label || l.name}`;
      const tag = document.createElement('small');
      tag.textContent = '顯示 QR Code ▾';
      a.appendChild(tag);
      const box = document.createElement('div');
      box.className = 'donate-qr hidden';
      const img = document.createElement('img');
      img.alt = `${l.name} 收款 QR Code`;
      img.loading = 'lazy';
      const tip = document.createElement('div');
      tip.className = 'donate-qr-tip';
      tip.innerHTML = `用 <b>歐付寶、街口、全支付、台灣Pay、悠遊付、iPASS MONEY、icash Pay</b> 等 App 掃描付款（金額請自行輸入）。<br>用手機開網站的話：長按圖片儲存，再到 App 的「掃描」選擇從相簿讀取；或在歐付寶 App 轉帳給 <b>歐付寶 ID：${l.opayId}</b>。`;
      box.append(img, tip);
      a.addEventListener('click', () => {
        showErr('');
        const open = box.classList.toggle('hidden') === false;
        tag.textContent = open ? '收起 ▴' : '顯示 QR Code ▾';
        if (open && !img.src) img.src = l.qr;
        if (!open) return;
        const anon = anonIn.checked;
        const name = anon ? '' : nameIn.value.trim();
        const amount = amtIn.value.trim();
        const msg = msgIn.value.trim();
        if (!anon && !name && !amount && !msg) return; // 什麼都沒填：直接付款（不上榜）
        if ((!anon && !name) || !(Number(amount) >= 1)) {
          showErr(anon ? '匿名贊助也請填寫金額，才對得上款項' : '要上贊助榜的話，請填寫暱稱和金額（也可以勾選匿名；不想上榜可以全部留空，直接付款）');
          return;
        }
        submitIntent(l.name, false, true);
      });
      linksEl.append(a, box);
      return;
    }
    const a = document.createElement(l.url ? 'a' : 'span');
    a.className = 'donate-link' + (l.url ? '' : ' pending');
    if (l.url) { a.href = l.url; a.target = '_blank'; a.rel = 'noopener'; }
    a.textContent = `${i + 1}. ${l.icon} ${l.label || l.name}`;
    const tag = document.createElement('small');
    tag.textContent = l.url ? '前往付款 ↗' : '審核中';
    a.appendChild(tag);
    if (l.url) {
      a.addEventListener('click', (e) => {
        showErr('');
        const anon = anonIn.checked;
        const name = anon ? '' : nameIn.value.trim();
        const amount = amtIn.value.trim();
        const msg = msgIn.value.trim();
        if (!anon && !name && !amount && !msg) return; // 什麼都沒填：直接前往付款（不上榜）
        if ((!anon && !name) || !(Number(amount) >= 1)) {
          e.preventDefault();
          showErr(anon ? '匿名贊助也請填寫金額，才對得上款項' : '要上贊助榜的話，請填寫暱稱和金額（也可以勾選匿名；不想上榜可以全部留空，直接付款）');
          (!anon && !name ? nameIn : amtIn).focus();
          return;
        }
        // 讓瀏覽器照常開新分頁（不擋，避免被當成彈出視窗），同時把資料送到伺服器拿代碼
        submitIntent(l.name);
      });
    }
    linksEl.appendChild(a);

  });

  // 送出「我要贊助」的資料（暱稱／金額／留言）→ 拿到贊助代碼。同一份資料只送一次
  let lastSent = '';
  function submitIntent(via, quiet, isQr) {
    const anon = anonIn.checked;
    const name = anon ? '' : nameIn.value.trim();
    const amount = amtIn.value.trim();
    const msg = msgIn.value.trim();
    if ((!anon && !name) || !(Number(amount) >= 1)) return false;
    const sig = [anon, name, amount, msg, via].join('|');
    if (sig === lastSent) return true;
    lastSent = sig;
    const l = { name: via };
        socket.emit('donateIntent', { name, anon, amount: Number(amount), msg, via: l.name }, (r) => {
          if (!r || r.error) { lastSent = ''; showErr((r && r.error) || '送出失敗，請再試一次'); return; }
          storageSet('msctimer_donate_last', JSON.stringify({ code: r.code, name: anon ? '匿名' : name, amount: Number(amount), via: l.name, t: Date.now() }));
          resEl.innerHTML = '';
          const t = document.createElement('div');
          t.append('✅ 已送出！你的贊助代碼：');
          const b = document.createElement('b');
          b.className = 'donate-code';
          b.textContent = r.code;
          t.appendChild(b);
          const d = document.createElement('div');
          d.className = 'donate-result-sub';
          d.textContent = `${isQr ? `請掃描上方的 ${l.name} QR Code ` : quiet ? '請在 PayPal 視窗' : `請在剛打開的 ${l.name} 頁面`}付款 NT$ ${Number(amount).toLocaleString()}，備註欄可以填上代碼「${r.code}」。${l.name === 'PayPal' ? '付款完成後會自動登上贊助榜' : '作者確認後就會登上贊助榜'}，謝謝你 ❤️`;
          resEl.append(t, d);
          // 有 QR Code 的管道（歐付寶）：填好資料、按「前往付款」之後才提供掃碼付款
          const ql = DONATE_LINKS.find((x) => x.name === l.name && x.qr);
          if (ql) {
            const tg = document.createElement('button');
            tg.type = 'button';
            tg.className = 'donate-qr-toggle';
            const tgLabel = ql.qrPhone ? '📱 想用手機付款？掃 QR Code 在手機上開啟 ▾' : '📱 付款頁打不開？改用 App 掃 QR Code ▾';
            tg.textContent = tgLabel;
            const box = document.createElement('div');
            box.className = 'donate-qr hidden';
            const img = document.createElement('img');
            img.alt = `${ql.name} 收款 QR Code`;
            const tip = document.createElement('div');
            tip.className = 'donate-qr-tip';
            tip.innerHTML = ql.qrPhone
              ? `用手機相機掃描，就會在手機上打開綠界付款頁。付款 <b>NT$ ${Number(amount).toLocaleString()}</b>，備註填代碼「<b>${r.code}</b>」。`
              : `用 <b>歐付寶、街口、全支付、台灣Pay、悠遊付、iPASS MONEY、icash Pay</b> 等 App 掃描，付款 <b>NT$ ${Number(amount).toLocaleString()}</b>，備註填代碼「<b>${r.code}</b>」。<br>手機上可以長按圖片儲存，再到 App 的「掃描」選擇從相簿讀取。`;
            box.append(img, tip);
            tg.addEventListener('click', () => {
              const open = box.classList.toggle('hidden') === false;
              tg.textContent = open ? '📱 收起 QR Code ▴' : tgLabel;
              if (open && !img.src) img.src = ql.qr;
            });
            resEl.append(tg, box);
          }
          resEl.classList.remove('hidden');
        });
    return true;
  }

  const monthLabel = (m, cur) => {
    const [y, mo] = m.split('-');
    return `${y} 年 ${Number(mo)} 月${m === cur ? '（本月）' : ''}`;
  };
  function render(data) {
    sel.innerHTML = '';
    data.months.forEach((m) => {
      const o = document.createElement('option');
      o.value = m; o.textContent = monthLabel(m, data.current);
      if (m === data.month) o.selected = true;
      sel.appendChild(o);
    });
    boardEl.innerHTML = '';
    if (!data.board.length) {
      const p = document.createElement('div');
      p.className = 'donate-empty';
      p.textContent = data.month === data.current ? '這個月還沒有人上榜，成為第一位贊助者吧！' : '這個月沒有贊助紀錄';
      boardEl.appendChild(p);
      return;
    }
    data.board.forEach((d, i) => {
      const row = document.createElement('div');
      row.className = 'donate-row' + (i < 3 ? ' top' + (i + 1) : '');
      const rank = document.createElement('span');
      rank.className = 'donate-rank';
      rank.textContent = ['🥇', '🥈', '🥉'][i] || String(i + 1);
      const main = document.createElement('div');
      main.className = 'donate-main';
      const line = document.createElement('div');
      line.className = 'donate-line';
      const nm = document.createElement('span');
      nm.className = 'donate-name' + (d.anon ? ' anon' : '');
      nm.textContent = d.anon ? `🕶️ ${d.name}` : d.name;
      const amt = document.createElement('span');
      amt.className = 'donate-amt';
      amt.textContent = `NT$ ${d.amount.toLocaleString()}`;
      line.append(nm, amt);
      main.appendChild(line);
      if (d.msg) {
        const msg = document.createElement('div');
        msg.className = 'donate-say';
        msg.textContent = `「${d.msg}」`;
        main.appendChild(msg);
      }
      row.append(rank, main);
      boardEl.appendChild(row);
    });
  }
  function load(month) {
    boardEl.textContent = '讀取中…';
    socket.emit('donateBoard', { month }, (data) => { if (data) render(data); });
  }
  const open = () => {
    overlay.classList.remove('hidden');
    overlay.querySelector('.guide-body').scrollTop = 0;
    if (!nameIn.value && myNickname && !anonIn.checked) nameIn.value = myNickname;
    showErr('');
    load();
  };
  const close = () => overlay.classList.add('hidden');
  btn.addEventListener('click', open);
  sel.addEventListener('change', () => load(sel.value));

  // 從付款頁自動跳回來（PayPal 的 Auto-return URL 設成 https://網站/?donated=1；歐付寶「返回商店」設成 https://網站/?donated=opay；綠界設成 ?donated=ecpay）
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.has('donated')) {
      const retVia = (qs.get('donated') || '').toLowerCase(); // 1 / paypal = PayPal；opay = 歐付寶；ecpay = 綠界
      const fromOther = /opay|ecpay/.test(retVia);
      qs.delete('donated');
      history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : '') + location.hash);
      let last = null;
      try { last = JSON.parse(storageGet('msctimer_donate_last') || 'null'); } catch (e) { last = null; }
      if (last && Date.now() - last.t > 2 * 3600000) last = null; // 太久以前的不算
      open();
      resEl.innerHTML = '';
      const t = document.createElement('div');
      t.textContent = '🎉 感謝你的贊助！作者收到了會很開心 ❤️';
      const d = document.createElement('div');
      d.className = 'donate-result-sub';
      const auto = !fromOther && !!last && last.via === 'PayPal';
      d.textContent = last
        ? `你的贊助代碼「${last.code}」（${last.name}，NT$ ${last.amount.toLocaleString()}）。${auto ? 'PayPal 確認付款後會自動登上贊助榜（通常幾分鐘內）。' : '作者確認收款後就會幫你登上贊助榜。'}`
        : '如果想登上贊助榜，可以把暱稱和付款時間告訴作者，確認後會幫你補登。';
      resEl.append(t, d);
      resEl.classList.remove('hidden');
      setTimeout(() => resEl.scrollIntoView({ block: 'center' }), 100);
      if (last) {
        socket.emit('donateReturned', { code: last.code });
        storageRemove('msctimer_donate_last');
      }
    }
  } catch (e) { /* ignore */ }
  document.getElementById('donateCloseBtn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close(); });
})();

// ---------- 全站在線人數（只有數字，不顯示暱稱） ----------
socket.on('site:online', (n) => {
  const wrap = document.getElementById('siteOnline');
  const cnt = document.getElementById('siteOnlineCount');
  if (!wrap || !cnt || typeof n !== 'number') return;
  cnt.textContent = n;
  wrap.classList.remove('hidden');
});


// ---------- 聯絡作者（右上角與進入房間視窗左下角的 ✉️） ----------
(function setupContact() {
  const overlay = document.getElementById('contactOverlay');
  if (!overlay) return;
  const open = () => overlay.classList.remove('hidden');
  const close = () => overlay.classList.add('hidden');
  ['contactBtn', 'joinContactBtn'].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', open);
  });
  document.getElementById('contactCloseBtn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close(); });
})();
