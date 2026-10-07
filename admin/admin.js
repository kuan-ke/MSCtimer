// 管理者專用腳本。
// 這個檔案放在 public 資料夾之外，只有網址帶正確 ?admin=密鑰 時，伺服器才會把它插進頁面並允許下載；
// 一般使用者的 index.html / client.js 裡完全沒有任何管理者相關的程式碼。
//
// 載入順序：socket.io.js → admin.js（本檔）→ client.js
// 本檔先包裝 io()，讓 client.js 建立的連線在每次 joinRoom 之前都自動先送出管理者驗證（斷線重連也一樣），
// 之後再等頁面載入完成，加上管理者面板與各種管理按鈕。
(function () {
  const KEY = new URLSearchParams(window.location.search).get('admin');
  if (!KEY || typeof window.io !== 'function') return;

  const A = {
    isAdmin: false,
    rejected: false,
    rooms: [],
    muted: [],
    switchFrom: null, // 從「所有房間」切換前所在的房間密碼（切換失敗時還原）
    uiReady: false,
    socket: null
  };

  // ---------- 樣式 ----------
  const css = `
.admin-panel { background:#1a2540; border:1px solid #2a3a5c; color:var(--text); border-radius:8px; padding:6px 10px; font-size:12px; flex-shrink:0; display:flex; align-items:center; gap:10px; flex-wrap:wrap; max-height:150px; overflow-y:auto; }
.admin-panel-title { font-weight:700; color:#93c5fd; white-space:nowrap; }
.admin-user-list { display:flex; flex-wrap:wrap; gap:6px; }
.admin-user-row { display:flex; align-items:center; gap:4px; background:#0f1830; padding:3px 6px; border-radius:8px; border:1px solid #2a3a5c; }
.admin-user-row .u-name { font-weight:600; margin-right:2px; }
.admin-user-row button { border:none; background:#2a3a5c; color:var(--text); border-radius:5px; padding:2px 6px; cursor:pointer; font-size:11px; }
.admin-user-row button:hover { background:#3a4d78; }
.admin-user-row button.danger { background:#5b1a1a; color:#fca5a5; }
.admin-user-row button.danger:hover { background:#7f1d1d; }
.admin-rooms-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; flex-basis:100%; }
.admin-room-row.current { border-color:#8b5cf6; background:#221a3d; }
.admin-room-row .r-pw { font-family:ui-monospace,Menlo,Consolas,monospace; font-weight:700; color:#c4b5fd; }
.admin-room-row .r-meta { color:var(--text-dim); }
.log-del-btn { margin-left:auto; border:none; background:transparent; color:var(--text-faint); cursor:pointer; font-size:12px; padding:0 3px; flex-shrink:0; }
.log-del-btn:hover { color:var(--danger); }
.panel-title-row .top-btn { font-size:11px; padding:3px 8px; }
.admin-stats-btn { border:1px solid #6d28d9; background:#2e1065; color:#ede9fe; border-radius:6px; padding:2px 8px; font-size:12px; font-weight:700; cursor:pointer; }
.admin-stats-btn:hover { background:#4c1d95; }
.kps-overlay { position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:1000; display:flex; align-items:center; justify-content:center; padding:16px; }
.kps-box { background:#0b1222; border:1px solid #6d28d9; border-radius:10px; width:min(820px,100%); max-height:90vh; display:flex; flex-direction:column; color:var(--text); box-shadow:0 12px 40px rgba(0,0,0,.6); }
.kps-head { display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid #334155; flex-wrap:wrap; }
.kps-head h3 { margin:0; font-size:15px; color:#ddd6fe; margin-right:auto; }
.kps-head button { border:1px solid #475569; background:#1e293b; color:var(--text); border-radius:6px; padding:3px 10px; font-size:12px; cursor:pointer; }
.kps-head button.danger { border-color:#7f1d1d; color:#fca5a5; }
.kps-body { overflow:auto; padding:10px 14px 14px; font-size:12px; }
.kps-summary { margin-bottom:8px; color:var(--text-dim); line-height:1.7; }
.kps-table { width:100%; border-collapse:collapse; }
.kps-table th, .kps-table td { border-bottom:1px solid #1e293b; padding:5px 6px; text-align:center; white-space:nowrap; }
.kps-table th { color:#94a3b8; font-weight:600; position:sticky; top:0; background:#0b1222; }
.kps-table td.name { text-align:left; font-weight:700; }
.kps-table td.five { color:#86efac; font-weight:700; }
.kps-table td.four { color:#fcd34d; font-weight:700; }
.kps-table td.verdict { font-weight:700; }
.kps-dist { text-align:left !important; white-space:normal !important; color:var(--text-faint); font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; }
.kps-dist b { color:#c4b5fd; }
`;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ---------- 包裝 io()：攔截 client.js 建立的連線 ----------
  const originalIo = window.io;
  window.io = function (...args) {
    const s = originalIo.apply(this, args);
    setupSocket(s);
    return s;
  };
  Object.assign(window.io, originalIo);

  function setupSocket(s) {
    A.socket = s;
    const rawEmit = s.emit.bind(s);
    const rawOn = s.on.bind(s);

    // 每次進房前先驗證管理者身分 → 伺服器在加入房間時就把管理者當成隱身
    s.emit = function (ev, ...rest) {
      if (ev === 'joinRoom' && !A.rejected) rawEmit('adminAuth', KEY);
      return rawEmit(ev, ...rest);
    };

    // 管理者從「所有房間」切換失敗時，留在原本的房間，不跳出輸入視窗
    s.on = function (ev, fn) {
      if (ev === 'join:error') {
        return rawOn(ev, (payload) => {
          if (A.switchFrom !== null) {
            myRoomPassword = A.switchFrom;
            A.switchFrom = null;
            manualJoinPending = false;
            showToast('無法進入該房間：' + ((payload && payload.message) || ''));
            return;
          }
          fn(payload);
        });
      }
      return rawOn(ev, fn);
    };

    rawOn('adminAuth:result', (ok) => {
      if (ok) {
        A.isAdmin = true;
        renderAll();
      } else if (!A.rejected) {
        A.rejected = true;
        alert('管理者密鑰錯誤');
      }
    });
    rawOn('admin:rooms', (list) => { A.rooms = list || []; if (A.uiReady) renderRooms(); });
    rawOn('admin:mutedList', (list) => { A.muted = list || []; if (A.uiReady) { renderMuted(); renderUsers(); } });
    rawOn('users:update', () => { if (A.uiReady) setTimeout(renderUsers, 0); });
    rawOn('join:ack', () => { A.switchFrom = null; if (A.uiReady) setTimeout(renderRooms, 0); });
  }

  // ---------- 介面 ----------
  let panel, userListEl, mutedListEl, roomListEl, roomCountEl, editSelfBtn, clearLogBtn;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function buildUI() {
    panel = el('div', 'admin-panel hidden');
    panel.appendChild(el('span', 'admin-panel-title', '🔑 管理者：'));
    userListEl = el('div', 'admin-user-list');
    panel.appendChild(userListEl);
    const mt = el('span', 'admin-panel-title', '🚫 已禁止操作：');
    mt.style.marginLeft = '14px';
    panel.appendChild(mt);
    mutedListEl = el('div', 'admin-user-list');
    panel.appendChild(mutedListEl);
    const roomsRow = el('div', 'admin-rooms-row');
    const rt = el('span', 'admin-panel-title', '🏠 所有房間（');
    roomCountEl = el('span', '', '0');
    rt.appendChild(roomCountEl);
    rt.appendChild(document.createTextNode('）：'));
    roomsRow.appendChild(rt);
    roomListEl = el('div', 'admin-user-list');
    roomsRow.appendChild(roomListEl);
    panel.appendChild(roomsRow);
    const statsBtn = el('button', 'admin-stats-btn', '📊 全站時間點統計');
    statsBtn.title = '所有房間按「擊殺」的時間點，統計五分區間 / 四分區間';
    statsBtn.addEventListener('click', openKillStats);
    panel.appendChild(statsBtn);
    const lootBtn = el('button', 'admin-stats-btn', '🎁 全站戰利品統計');
    lootBtn.title = '擊殺 50 次以上的房間，各王的擊殺數與記錄到的戰利品';
    lootBtn.style.marginLeft = '6px';
    lootBtn.addEventListener('click', openLootStats);
    panel.appendChild(lootBtn);
    const topBar = document.querySelector('.top-bar');
    topBar.parentNode.insertBefore(panel, topBar.nextSibling);

    editSelfBtn = el('button', 'top-btn hidden', '✎');
    editSelfBtn.title = '管理者：修改自己的暱稱';
    editSelfBtn.addEventListener('click', () => {
      const newName = prompt('（管理者）修改您自己的暱稱：', myNickname || '');
      if (newName !== null && newName.trim()) A.socket.emit('setNickname', newName.trim().slice(0, 20));
    });
    const conn = document.getElementById('connStatus');
    conn.parentNode.insertBefore(editSelfBtn, conn);

    clearLogBtn = el('button', 'top-btn hidden', '清空紀錄');
    clearLogBtn.title = '清空全部操作紀錄';
    clearLogBtn.addEventListener('click', () => {
      if (confirm('確定要清空全部操作紀錄嗎？此動作無法復原。')) A.socket.emit('adminClearLog');
    });
    document.querySelector('.log-panel .panel-title-row').appendChild(clearLogBtn);

    // 暱稱旁顯示「隱身中」
    const origNick = updateNicknameDisplay;
    updateNicknameDisplay = function () {
      origNick();
      if (A.isAdmin && myNickname) {
        myNicknameDisplay.textContent += '（👻 隱身中）';
        myNicknameDisplay.title = '管理者不會出現在其他人的線上人數與名單中';
      }
    };

    // 操作紀錄每一筆加上刪除鈕
    const origRow = buildLogRow;
    buildLogRow = function (entry) {
      const row = origRow(entry);
      addDeleteBtn(row, entry.id);
      return row;
    };
    logListEl.querySelectorAll('.log-row').forEach((row) => addDeleteBtn(row, row.dataset.id));

    A.uiReady = true;
    renderAll();
  }

  function addDeleteBtn(row, id) {
    if (!A.isAdmin || row.querySelector('.log-del-btn')) return;
    const b = el('button', 'log-del-btn', '✕');
    b.title = '刪除這筆紀錄';
    b.addEventListener('click', () => A.socket.emit('adminDeleteLogEntry', id));
    row.appendChild(b);
  }

  function renderAll() {
    if (!A.uiReady || !A.isAdmin) return;
    panel.classList.remove('hidden');
    editSelfBtn.classList.remove('hidden');
    clearLogBtn.classList.remove('hidden');
    logListEl.querySelectorAll('.log-row').forEach((row) => addDeleteBtn(row, row.dataset.id));
    updateNicknameDisplay();
    renderUsers();
    renderMuted();
    renderRooms();
  }

  function renderUsers() {
    if (!A.uiReady || !A.isAdmin) return;
    userListEl.innerHTML = '';
    // 伺服器送來的線上名單本來就不含管理者，所以這裡就是房間內的其他使用者
    const players = onlineUsers || [];
    if (players.length === 0) {
      userListEl.innerHTML = '<span style="color:#64748b;">此房間目前沒有其他使用者</span>';
      return;
    }
    players.forEach((u) => {
      const row = el('div', 'admin-user-row');
      row.appendChild(el('span', 'u-name', u.name));

      const renameBtn = el('button', '', '改名');
      renameBtn.title = '修改此人的暱稱';
      renameBtn.addEventListener('click', () => {
        const newName = prompt(`修改「${u.name}」的暱稱：`, u.name);
        if (newName !== null && newName.trim()) {
          A.socket.emit('adminRenameUser', { targetSocketId: u.id, newName: newName.trim() });
        }
      });
      row.appendChild(renameBtn);

      const isMuted = A.muted.some((n) => normalize(n) === normalize(u.name));
      const muteBtn = el('button', '', isMuted ? '解除禁止' : '禁止操作');
      muteBtn.title = '禁止此人進行任何操作（點 CH、擊殺、右鍵回報、分頁編輯），已存在的倒數不受影響';
      muteBtn.addEventListener('click', () => {
        if (isMuted) A.socket.emit('adminUnmuteUser', { nickname: u.name });
        else if (confirm(`確定要禁止「${u.name}」進行任何操作嗎？`)) A.socket.emit('adminMuteUser', { nickname: u.name });
      });
      row.appendChild(muteBtn);

      const removeBtn = el('button', 'danger', '移除');
      removeBtn.title = '將此人移出房間';
      removeBtn.addEventListener('click', () => {
        if (confirm(`確定要將「${u.name}」移出房間嗎？此暱稱之後將無法再進入這個房間。`)) {
          A.socket.emit('adminRemoveUser', { targetSocketId: u.id, nickname: u.name });
        }
      });
      row.appendChild(removeBtn);

      userListEl.appendChild(row);
    });
  }

  function renderMuted() {
    if (!A.uiReady || !A.isAdmin) return;
    mutedListEl.innerHTML = '';
    if (A.muted.length === 0) {
      mutedListEl.innerHTML = '<span style="color:#64748b;">目前沒有被禁止的使用者</span>';
      return;
    }
    A.muted.forEach((name) => {
      const row = el('div', 'admin-user-row');
      row.appendChild(el('span', 'u-name', name));
      const btn = el('button', '', '解除禁止');
      btn.addEventListener('click', () => A.socket.emit('adminUnmuteUser', { nickname: name }));
      row.appendChild(btn);
      mutedListEl.appendChild(row);
    });
  }

  function renderRooms() {
    if (!A.uiReady || !A.isAdmin) return;
    roomCountEl.textContent = A.rooms.length;
    roomListEl.innerHTML = '';
    if (A.rooms.length === 0) {
      roomListEl.innerHTML = '<span style="color:#64748b;">目前沒有任何房間</span>';
      return;
    }
    A.rooms.forEach((r) => {
      const isCurrent = joined && r.password === myRoomPassword;
      const row = el('div', 'admin-user-row admin-room-row' + (isCurrent ? ' current' : ''));
      row.title = r.users.length ? `線上：${r.users.join('、')}` : '目前沒有人在線';
      row.appendChild(el('span', 'r-pw', r.password));
      row.appendChild(el('span', 'r-meta', `👥${r.users.length} ⏳${r.activeCount}`));
      if (isCurrent) {
        row.appendChild(el('span', 'r-meta', '（目前所在）'));
      } else {
        const go = el('button', '', '進入');
        go.title = '切換到這個房間';
        go.addEventListener('click', () => joinOtherRoom(r.password));
        row.appendChild(go);
      }
      roomListEl.appendChild(row);
    });
  }

  function joinOtherRoom(password) {
    if (!myNickname) {
      myRoomPassword = password;
      showNicknameOverlay();
      return;
    }
    A.switchFrom = joined ? myRoomPassword : null;
    myRoomPassword = password;
    manualJoinPending = true;
    A.socket.emit('joinRoom', { nickname: nicknameForRoom(password), password, clientId: myClientId });
  }

  // ---------- 全站時間點統計 ----------
  let kpsOverlay = null;
  function openKillStats() {
    if (!A.isAdmin) return;
    A.socket.emit('adminKillStats', (st) => {
      if (!st) return;
      if (kpsOverlay) kpsOverlay.remove();
      kpsOverlay = el('div', 'kps-overlay');
      kpsOverlay.addEventListener('click', (e) => { if (e.target === kpsOverlay) closeKillStats(); });
      const box = el('div', 'kps-box');
      const head = el('div', 'kps-head');
      head.appendChild(el('h3', '', '📊 全站時間點統計'));
      const refresh = el('button', '', '重新整理');
      refresh.addEventListener('click', openKillStats);
      const dl = el('button', '', '下載 CSV');
      dl.addEventListener('click', downloadKillCsv);
      const clr = el('button', 'danger', '清空統計');
      clr.addEventListener('click', () => {
        if (!confirm('確定要清空「全站」所有時間點統計嗎？此動作無法復原（各房間自己的紀錄表不受影響）。')) return;
        A.socket.emit('adminClearKillStats', () => { showToast('已清空全站時間點統計'); openKillStats(); });
      });
      const close = el('button', '', '關閉');
      close.addEventListener('click', closeKillStats);
      [refresh, dl, clr, close].forEach((b) => head.appendChild(b));
      box.appendChild(head);

      const body = el('div', 'kps-body');
      const t = st.total;
      const sum = el('div', 'kps-summary');
      const since = st.since ? new Date(st.since).toLocaleString() : '—';
      sum.innerHTML = '';
      sum.appendChild(document.createTextNode(
        `共 ${t.n} 筆（${st.rooms} 個房間，最多保留 ${st.max} 筆，最早一筆 ${since}）　` +
        `五分區間 ${t.five}　四分區間 ${t.four}（其中兩邊重疊 ${t.both}）　都不符合 ${t.none}　未到重生 ${t.early}`));
      sum.appendChild(el('br'));
      sum.appendChild(document.createTextNode('判斷：時間點在 5 分 / 4 分倍數的正負 30 秒內算符合；同時符合兩者（例如 0、20 分）時，五分、四分區間都 +1。分布 = 時間點落在第幾分鐘的筆數。'));
      body.appendChild(sum);

      const table = el('table', 'kps-table');
      const thead = el('tr');
      ['王', '筆數', '五分區間', '四分區間', '重疊（兩邊都算）', '都不符合', '未到重生', '傾向', '分布（分鐘:筆數）'].forEach((h) => thead.appendChild(el('th', '', h)));
      table.appendChild(thead);
      if (st.bosses.length === 0) {
        const tr = el('tr');
        const td = el('td', '', '還沒有任何紀錄');
        td.colSpan = 9;
        tr.appendChild(td);
        table.appendChild(tr);
      }
      st.bosses.forEach((b) => {
        const tr = el('tr');
        tr.appendChild(el('td', 'name', b.name));
        tr.appendChild(el('td', '', String(b.n)));
        tr.appendChild(el('td', 'five', String(b.five)));
        tr.appendChild(el('td', 'four', String(b.four)));
        tr.appendChild(el('td', '', String(b.both)));
        tr.appendChild(el('td', '', String(b.none)));
        tr.appendChild(el('td', '', String(b.early)));
        // 傾向只看「只符合一邊」的紀錄（重疊的兩邊都算，不影響比例判斷）
        const only5 = b.five - b.both, only4 = b.four - b.both;
        const decided = only5 + only4;
        let verdict = '資料不足';
        let color = '#64748b';
        if (decided >= 5) {
          const p5 = only5 / decided;
          if (p5 >= 0.7) { verdict = `五分區間（${Math.round(p5 * 100)}%）`; color = '#86efac'; }
          else if (p5 <= 0.3) { verdict = `四分區間（${Math.round((1 - p5) * 100)}%）`; color = '#fcd34d'; }
          else { verdict = '不明顯'; color = '#94a3b8'; }
        }
        const v = el('td', 'verdict', verdict);
        v.style.color = color;
        tr.appendChild(v);
        const dist = el('td', 'kps-dist');
        Object.keys(b.minutes).map(Number).sort((x, y) => x - y).forEach((m) => {
          const span = el('span');
          const strong = el('b', '', String(m));
          span.appendChild(strong);
          span.appendChild(document.createTextNode(`:${b.minutes[m]}　`));
          dist.appendChild(span);
        });
        tr.appendChild(dist);
        table.appendChild(tr);
      });
      body.appendChild(table);
      box.appendChild(body);
      kpsOverlay.appendChild(box);
      document.body.appendChild(kpsOverlay);
    });
  }
  // ---------- 全站戰利品統計 ----------
  function openLootStats() {
    if (!A.isAdmin) return;
    A.socket.emit('adminLootStats', (st) => {
      if (!st) return;
      if (kpsOverlay) kpsOverlay.remove();
      kpsOverlay = el('div', 'kps-overlay');
      kpsOverlay.addEventListener('click', (e) => { if (e.target === kpsOverlay) closeKillStats(); });
      const box = el('div', 'kps-box');
      const head = el('div', 'kps-head');
      head.appendChild(el('h3', '', '🎁 全站戰利品統計'));
      const refresh = el('button', '', '重新整理'); refresh.addEventListener('click', openLootStats);
      const dl = el('button', '', '下載 CSV');
      dl.addEventListener('click', () => A.socket.emit('adminLootCsv', (res) => {
        if (!res || typeof res.csv !== 'string') return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([res.csv], { type: 'text/csv;charset=utf-8' }));
        const d = new Date(); const p = (n) => String(n).padStart(2, '0');
        a.download = `MSCtimer-戰利品-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`;
        document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      }));
      const clr = el('button', 'danger', '清空統計');
      clr.addEventListener('click', () => {
        if (!confirm('確定要清空「全站」戰利品統計嗎？此動作無法復原（各房間自己的戰利品紀錄不受影響）。')) return;
        A.socket.emit('adminClearLootStats', () => { showToast('已清空全站戰利品統計'); openLootStats(); });
      });
      const close = el('button', '', '關閉'); close.addEventListener('click', closeKillStats);
      [refresh, dl, clr, close].forEach((b) => head.appendChild(b));
      box.appendChild(head);
      const body = el('div', 'kps-body');
      body.appendChild(el('div', 'kps-summary', `這是「全站」合計：所有房間中，某隻王擊殺達 ${st.minKills} 次以上的房間都會計入（目前 ${st.rooms} 間）。掉落率 = 記錄到的次數 ÷ 總擊殺次數，取決於大家有沒有確實記錄。發現有房間亂點，可在最下方「各房間明細」刪除並排除該房間。`));
      if (!st.bosses.length) body.appendChild(el('div', 'kps-summary', '目前還沒有達到門檻的房間。'));
      st.bosses.forEach((b) => {
        const t = el('table', 'kps-table');
        t.style.marginBottom = '14px';
        const h = el('tr');
        const th = el('th', '', `${b.name}　｜　${b.rooms} 間房間　｜　總擊殺 ${b.kills} 次　｜　記錄 ${b.items.reduce((a, x) => a + x.count, 0)} 件`);
        th.colSpan = 4; th.style.textAlign = 'left'; th.style.color = '#fde68a';
        h.appendChild(th); t.appendChild(h);
        const h2 = el('tr');
        ['', '道具', '記錄次數', '掉落率'].forEach((x) => h2.appendChild(el('th', '', x)));
        t.appendChild(h2);
        if (!b.items.length) { const tr = el('tr'); const td = el('td', '', '還沒有記錄任何戰利品'); td.colSpan = 4; tr.appendChild(td); t.appendChild(tr); }
        b.items.forEach((it) => {
          const tr = el('tr');
          const ic = el('td');
          const img = document.createElement('img'); img.src = `drops/icons/${it.id}.png`; img.style.maxWidth = '28px'; img.style.maxHeight = '28px'; img.onerror = () => img.remove();
          ic.appendChild(img); tr.appendChild(ic);
          tr.appendChild(el('td', 'name', it.name));
          tr.appendChild(el('td', 'five', String(it.count)));
          tr.appendChild(el('td', '', b.kills ? (it.count / b.kills * 100).toFixed(2) + '%' : '-'));
          t.appendChild(tr);
        });
        body.appendChild(t);
      });
      // 各房間明細：可單獨刪除（並排除，之後不再計入）
      const rt = el('table', 'kps-table');
      const rh = el('tr'); const rth = el('th', '', `各房間明細（${st.roomList.length} 間）`); rth.colSpan = 3; rth.style.textAlign = 'left'; rth.style.color = '#93c5fd'; rh.appendChild(rth); rt.appendChild(rh);
      const rh2 = el('tr'); ['房間', '各王：擊殺／記錄件數', ''].forEach((x) => rh2.appendChild(el('th', '', x))); rt.appendChild(rh2);
      if (!st.roomList.length) { const tr = el('tr'); const td = el('td', '', '沒有房間計入'); td.colSpan = 3; tr.appendChild(td); rt.appendChild(tr); }
      st.roomList.forEach((r) => {
        const tr = el('tr');
        tr.appendChild(el('td', 'name', r.password ? `密碼 ${r.password}` : `代號 ${r.key}（房間已不存在）`));
        tr.appendChild(el('td', 'kps-dist', r.bosses.map((b) => `${b.name}：${b.kills}／${b.items}`).join('　')));
        const td = el('td');
        const del = el('button', '', '刪除並排除');
        del.style.cssText = 'border:1px solid #7f1d1d;background:transparent;color:#fca5a5;border-radius:5px;padding:2px 8px;cursor:pointer;font-size:12px;';
        del.addEventListener('click', () => {
          if (!confirm(`確定要把「${r.password || r.key}」從全站戰利品統計刪除嗎？之後這間房間的紀錄也不會再計入（可在下方恢復）。`)) return;
          A.socket.emit('adminLootRemoveRoom', { key: r.key }, () => { showToast('已刪除並排除該房間'); openLootStats(); });
        });
        td.appendChild(del); tr.appendChild(td); rt.appendChild(tr);
      });
      body.appendChild(rt);
      if (st.excluded && st.excluded.length) {
        const et = el('table', 'kps-table'); et.style.marginTop = '12px';
        const eh = el('tr'); const eth = el('th', '', `已排除的房間（${st.excluded.length} 間，不計入統計）`); eth.colSpan = 2; eth.style.textAlign = 'left'; eth.style.color = '#fca5a5'; eh.appendChild(eth); et.appendChild(eh);
        st.excluded.forEach((r) => {
          const tr = el('tr');
          tr.appendChild(el('td', 'name', r.password ? `密碼 ${r.password}` : `代號 ${r.key}`));
          const td = el('td'); const rs = el('button', '', '恢復計入');
          rs.style.cssText = 'border:1px solid #475569;background:transparent;color:var(--text);border-radius:5px;padding:2px 8px;cursor:pointer;font-size:12px;';
          rs.addEventListener('click', () => A.socket.emit('adminLootRestoreRoom', { key: r.key }, () => { showToast('已恢復計入'); openLootStats(); }));
          td.appendChild(rs); tr.appendChild(td); et.appendChild(tr);
        });
        body.appendChild(et);
      }
      box.appendChild(body);
      kpsOverlay.appendChild(box);
      document.body.appendChild(kpsOverlay);
    });
  }

  function closeKillStats() { if (kpsOverlay) { kpsOverlay.remove(); kpsOverlay = null; } }
  function downloadKillCsv() {
    A.socket.emit('adminKillStatsCsv', (res) => {
      if (!res || typeof res.csv !== 'string') return;
      const blob = new Blob([res.csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      a.download = `MSCtimer-時間點-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });
  }

  function normalize(n) { return (n || '').trim().toLowerCase(); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
  else setTimeout(buildUI, 0);
})();
