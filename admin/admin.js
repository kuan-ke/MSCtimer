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

    // 匯出目前房間計時：放在右上角「子母畫面」按鈕左邊（只有管理者看得到）
    const exportBtn = el('button', 'top-btn hidden', '📋 匯出計時');
    exportBtn.id = 'exportBtn';
    exportBtn.title = '把這間房間目前所有進行中的 CH 整理成文字，並複製到剪貼簿';
    exportBtn.addEventListener('click', exportTimers);
    const pip = document.getElementById('pipBtn');
    pip.parentNode.insertBefore(exportBtn, pip);
    A.exportBtn = exportBtn;

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
    if (A.exportBtn) A.exportBtn.classList.remove('hidden');
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

  // ---------- 匯出計時（管理者專用） ----------
  const EXPORT_STATE_LABEL = { appearing: '出現中', window: '重生區間', counting: '倒數中' };
  const EXPORT_STATE_ORDER = { appearing: 0, window: 1, counting: 2 };

  function buildExportText() {
    const now = Date.now() + clockOffset;
    const d = new Date(now);
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    const lines = [`【楓之谷｜團隊野王計時器】房間 ${myRoomPassword || ''} 計時匯出`, `匯出時間：${stamp}`, ''];
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
        if (ch.state === 'counting') remain = `距出生 ${formatMs(Math.max(0, minMs - elapsed))}`;
        else if (ch.state === 'window') remain = `距最大值 ${formatMs(Math.max(0, maxMs - elapsed))}`;
        else remain = elapsed >= maxMs ? `已超過最大值 +${formatMs(elapsed - maxMs)}` : `距最大值 ${formatMs(maxMs - elapsed)}`;
        items.push({ idx, state: ch.state, spawnAt, text:
          `  ${(EXPORT_STATE_LABEL[ch.state] || ch.state).padEnd(4, '　')}  ch.${String(idx + 1).padStart(2, ' ')}  出生 ${formatClock(spawnAt)}  ${remain}  （${ch.startedBy || '未知'}）` });
      });
      if (items.length === 0) return;
      items.sort((a, b) => (EXPORT_STATE_ORDER[a.state] ?? 9) - (EXPORT_STATE_ORDER[b.state] ?? 9) || a.spawnAt - b.spawnAt);
      lines.push(`■ ${tab.name}（${tab.minMinutes}～${tab.maxMinutes} 分）`);
      items.forEach((it) => lines.push(it.text));
      lines.push('');
      total += items.length;
    });

    if (total === 0) lines.push('目前沒有進行中的 CH');
    else lines.push(`共 ${total} 個進行中的 CH`);
    return { text: lines.join('\n'), stamp };
  }

  async function copyText(text, textarea) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try { textarea.focus(); textarea.select(); return document.execCommand('copy'); } catch (e2) { return false; }
    }
  }

  function exportTimers() {
    if (!joined) { showToast('請先進入一個房間'); return; }
    const { text, stamp } = buildExportText();

    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal');
    modal.style.width = 'min(640px, calc(100vw - 32px))';
    modal.appendChild(el('h3', '', '📋 目前房間計時'));
    const ta = el('textarea');
    ta.value = text;
    ta.readOnly = true;
    ta.style.cssText = 'width:100%;height:50vh;box-sizing:border-box;background:#0f172a;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;font-family:Consolas,ui-monospace,monospace;font-size:12px;line-height:1.5;white-space:pre;';
    modal.appendChild(ta);
    const btns = el('div', 'modal-buttons');
    btns.style.marginTop = '10px';
    const copyBtn = el('button', 'btn-primary', '複製');
    copyBtn.addEventListener('click', async () => showToast((await copyText(text, ta)) ? '已複製到剪貼簿' : '複製失敗，請手動全選複製'));
    const dlBtn = el('button', 'btn-secondary', '下載 .txt');
    dlBtn.addEventListener('click', () => {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `計時_${myRoomPassword || 'room'}_${stamp.replace(/[\/: ]/g, '')}.txt`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });
    const closeBtn = el('button', 'btn-secondary', '關閉');
    const close = () => overlay.remove();
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    btns.appendChild(dlBtn);
    btns.appendChild(closeBtn);
    btns.appendChild(copyBtn);
    modal.appendChild(btns);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // 打開的同時自動複製一次
    copyText(text, ta).then((ok) => showToast(ok ? '已複製到剪貼簿' : '請按「複製」或手動全選複製'));
  }

  function normalize(n) { return (n || '').trim().toLowerCase(); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
  else setTimeout(buildUI, 0);
})();
