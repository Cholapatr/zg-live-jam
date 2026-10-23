// Shared client-side helpers for ZG Live Jam

function getClientId() {
  let id = localStorage.getItem('zg_client_id');
  if (!id) {
    id = 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('zg_client_id', id);
  }
  return id;
}

function getMyVotes() {
  try {
    return JSON.parse(localStorage.getItem('zg_my_votes') || '{}');
  } catch (e) {
    return {};
  }
}

function setMyVote(songId, voteType) {
  const votes = getMyVotes();
  if (voteType) votes[songId] = voteType;
  else delete votes[songId];
  localStorage.setItem('zg_my_votes', JSON.stringify(votes));
}

// A lightweight "who am I" identity for guests, so votes can show names.
function getGuestName() {
  return localStorage.getItem('zg_guest_name') || '';
}
function setGuestName(name) {
  if (name && name.trim()) localStorage.setItem('zg_guest_name', name.trim());
  if (typeof renderJoinName === 'function') renderJoinName();
}
// The name this person joined the event with, shown next to the "N join"
// presence widget in the header (only while an event is joined).
function renderJoinName() {
  const widget = document.getElementById('presence-widget');
  if (!widget) return;
  let chip = document.getElementById('join-name-chip');
  const name = getGuestName();
  if (!getEventName() || !name) { if (chip) chip.remove(); return; }
  if (!chip) {
    chip = document.createElement('span');
    chip.id = 'join-name-chip';
    chip.className = 'join-name-chip';
    widget.parentNode.insertBefore(chip, widget);
  }
  chip.textContent = '🙋 ' + name;
  chip.title = 'ชื่อที่คุณใช้เข้าร่วม Event นี้';
}
// Ask once (and remember) so votes can be attributed to a name. Cancel/blank
// still lets them vote — they'll just show up as "ไม่ระบุชื่อ". This is a
// fallback safety net for the rare case someone reaches a vote without ever
// going through confirmGuestNameForJoin() below (e.g. cleared localStorage
// mid-session) — normally the name is already set by then.
function ensureGuestName() {
  let n = getGuestName();
  if (!n) {
    const typed = prompt('ขอชื่อคุณหน่อยครับ (ให้รู้ว่าใครอยากฟัง/ร้องเพลงไหน)') || '';
    if (typed.trim()) { setGuestName(typed); n = getGuestName(); }
  }
  return n;
}

// Musician page's own display name — kept separate from the general guest
// name (via "เปลี่ยน" on that page) in case someone wants a different name
// specifically for the นักดนตรี role. confirmGuestNameForJoin() below
// re-syncs it to the guest name every time someone joins an event, though,
// so it doesn't go stale across events unless they've overridden it.
function getMyName() { return localStorage.getItem('zg_musician_name') || ''; }
function setMyName(n) { if (n && n.trim()) localStorage.setItem('zg_musician_name', n.trim()); }

// Musician roles (checkboxes on the Musician page) — also reset to a
// sensible default ("ช่วยร้อง") every time someone joins an event, same as
// the name, and just as editable afterward from that page.
function getMyRoles() {
  try { return JSON.parse(localStorage.getItem('zg_musician_roles') || '[]'); }
  catch (e) { return []; }
}
function setMyRoles(arr) { localStorage.setItem('zg_musician_roles', JSON.stringify(arr || [])); }

// Asks for (or re-confirms) a display name right when joining an event, so
// presence never has to fall back to a generic "ผู้ร่วมงาน" placeholder.
// Suggests the person's logged-in account name if they're signed in
// (still editable — they can type something else), otherwise whatever name
// this device already has saved. Returns true when they press Join, false on
// Cancel (they changed their mind — the caller must NOT join the event).
// Also syncs the musician-page name to match, so a fresh name entered when
// joining a new event shows up there too instead of a stale one.
async function confirmGuestNameForJoin(eventName) {
  let suggested = getGuestName();
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (data.loggedIn && data.user && data.user.name) suggested = data.user.name;
    // ZyGen Event: prefer the Thai nickname (first name) from Employee Master Data.
    if (getMode() === 'zygen' && data.loggedIn && data.employeeDisplayName) suggested = data.employeeDisplayName;
  } catch (e) { /* not logged in / offline — fall back to existing device name */ }
  const typed = await askJoinName(eventName, suggested || '');
  if (typed === null) return false; // "Cancel" — changed their mind, don't join
  if (typed.trim()) setGuestName(typed);
  setMyName(getGuestName());
  setMyRoles(['🎶 ช่วยร้อง']);
  return true;
}

// Centered pop-up: "join this event as <name>?" — resolves to the typed name
// when they press Join, or null on Cancel / Esc / click outside.
function askJoinName(eventName, suggested) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg modal-center';
    bg.style.zIndex = '120';
    bg.innerHTML = `
      <div class="modal">
        <h2 style="margin-top:0;">เข้าร่วม Event</h2>
        <div class="small-note" id="jn-event" style="margin-bottom:10px;"></div>
        <label>ชื่อของคุณ (ให้คนอื่นใน Event นี้รู้จักคุณ)</label>
        <input type="text" id="jn-name" maxlength="60" />
        <div class="btn-row" style="margin-top:14px;">
          <button type="button" id="jn-cancel" style="flex:1;">Cancel</button>
          <button type="button" id="jn-join" class="btn-blue" style="flex:1;">Join</button>
        </div>
      </div>`;
    document.body.appendChild(bg);
    bg.querySelector('#jn-event').textContent = eventName || '';
    const input = bg.querySelector('#jn-name');
    input.value = suggested || '';
    const done = (v) => { document.removeEventListener('keydown', onKey); bg.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
    bg.querySelector('#jn-join').addEventListener('click', () => done(input.value));
    bg.querySelector('#jn-cancel').addEventListener('click', () => done(null));
    bg.addEventListener('click', (e) => { if (e.target === bg) done(null); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } });
    input.focus(); input.select();
  });
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function chordUrl(title, artist) {
  const q = [title, artist].filter(Boolean).join(' ');
  return 'https://www.dochord.com/?s=' + encodeURIComponent(q);
}

// Turn a bare dochord song number (e.g. "22975") or a full dochord.com link
// into a canonical direct link, entirely client-side — no network call, no
// "verification" against dochord (it blocks automated requests, so we just
// trust what the person copied from the site themselves).
function buildDochordUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return `https://www.dochord.com/${s}/`;
  try {
    const u = new URL(s);
    if (/(^|\.)dochord\.com$/i.test(u.hostname)) {
      const m = u.pathname.match(/(\d+)/);
      return m ? `https://www.dochord.com/${m[1]}/` : s;
    }
  } catch (e) { /* not a valid URL */ }
  return null;
}

// Updates the shared top nav to show song counts, e.g. "Request List (12)".
function updateNavCounts(state) {
  const songCount = (state.songs || []).length;
  const showCount = (state.nextShow || []).length;
  document.querySelectorAll('nav.tabs a[href="index.html"]').forEach(a => {
    a.textContent = `🎶 Request List (${songCount})`;
  });
  document.querySelectorAll('nav.tabs a[href="nextshow.html"]').forEach(a => {
    a.textContent = `📋 Next Show List (${showCount})`;
  });
}

// ---- Event selection (Request List / Next Show List are scoped per event) ----
function getEventId() { return localStorage.getItem('zg_event_id') || ''; }
function getEventName() { return localStorage.getItem('zg_event_name') || ''; }
function setEvent(id, name, mode, status) {
  localStorage.setItem('zg_event_id', id);
  localStorage.setItem('zg_event_name', name || '');
  if (mode !== undefined) localStorage.setItem('zg_event_mode', mode === 'open' ? 'open' : 'approve');
  if (status !== undefined) localStorage.setItem('zg_event_status', status === 'history' ? 'history' : 'open');
}
function clearEvent() {
  localStorage.removeItem('zg_event_id');
  localStorage.removeItem('zg_event_name');
  localStorage.removeItem('zg_event_mode');
  localStorage.removeItem('zg_event_status');
}
// 'history' = a finished event opened just to look back (view-only).
function getEventStatus() { return localStorage.getItem('zg_event_status') === 'history' ? 'history' : 'open'; }
// On the pages people use inside an event (not Admin), a history event is
// view-only: add/vote/answer/queue controls are hidden (CSS body.is-history)
// and a banner says so. The server refuses those actions anyway.
function applyHistoryUi() {
  const page = location.pathname.split('/').pop();
  const viewOnlyPage = ['index.html', 'nextshow.html', 'musician.html'].includes(page);
  const on = viewOnlyPage && getEventStatus() === 'history' && !!getEventId();
  document.body.classList.toggle('is-history', on);
  let bar = document.getElementById('history-banner');
  if (!on) { if (bar) bar.remove(); return; }
  if (!bar) {
    const hdr = document.querySelector('header.top');
    if (!hdr) return;
    bar = document.createElement('div');
    bar.id = 'history-banner';
    bar.className = 'history-banner';
    bar.textContent = '📜 Event นี้เป็นประวัติ (History) — ดูย้อนหลังได้ ไม่สามารถเพิ่ม/โหวตเพลงได้ (แก้ไขชื่อเพลงที่พิมพ์ผิดได้)';
    hdr.insertAdjacentElement('afterend', bar);
  }
}
// 'open' = "Everybody can set next show list" (no Request List page),
// 'approve' = "Approve First" (the original mode).
function getEventMode() { return localStorage.getItem('zg_event_mode') === 'open' ? 'open' : 'approve'; }
// In 'open' events the Request List tab doesn't exist — requests are made on
// the Next Show List page and go straight into the queue.
function applyEventModeNav() {
  const hide = getEventMode() === 'open';
  document.querySelectorAll('nav.tabs a[href="index.html"]').forEach((a) => { a.style.display = hide ? 'none' : ''; });
}
// Call at the top of any page whose content is scoped to one event (Request
// List, Next Show List, นักดนตรี). Sends the person to events.html to pick
// one if they haven't yet. Returns '' (falsy) when redirecting, so callers
// can bail out early instead of trying to load data with no event selected.
function requireEvent() {
  const id = getEventId();
  if (!id) {
    location.href = 'events.html';
    return '';
  }
  return id;
}
// Shared header identity: the H1 (id="event-title") shows the current
// event's name — or "Select event to join.." before one is picked — instead
// of a fixed "ZG Live Jam" title. The old per-page title/tagline now lives
// in the smaller line below it. A "Leave Event" link (id="leave-event-link",
// optional — admin.html doesn't have one) clears the selection; the 4-item
// event nav (id="event-nav", optional) is hidden until an event is joined.
function renderEventHeader() {
  const titleEl = document.getElementById('event-title');
  const leaveEl = document.getElementById('leave-event-link');
  const navEl = document.getElementById('event-nav');
  const name = getEventName();
  if (titleEl) {
    titleEl.textContent = name || 'Select event to join..';
    // Before an event is joined, the title itself doubles as a link to the
    // event picker — no event means there's otherwise no way back to it.
    titleEl.classList.toggle('event-title-link', !name);
    if (!titleEl.dataset.wired) {
      titleEl.dataset.wired = '1';
      titleEl.addEventListener('click', () => {
        if (!getEventName()) location.href = 'events.html';
      });
    }
  }
  if (navEl) navEl.style.display = name ? '' : 'none';
  applyEventModeNav();
  renderJoinName();
  applyHistoryUi();
  if (leaveEl) {
    leaveEl.style.display = name ? '' : 'none';
    if (!leaveEl.dataset.wired) {
      leaveEl.dataset.wired = '1';
      leaveEl.addEventListener('click', (e) => {
        e.preventDefault();
        if (confirm('ออกจาก Event นี้ และกลับไปหน้าเลือก Event ใช่หรือไม่?')) leaveEvent();
      });
    }
  }
}

// ---- Presence (who's live-connected to this event right now) ----
// Purely a live snapshot from the server (never stored anywhere) — a page
// just announces itself once connected, and re-announces automatically on
// every reconnect (the Socket.IO client does this on its own after a drop,
// e.g. WiFi hiccup) since the server-side socket id changes each time.
let _presenceSocket = null;
let _presenceList = [];
let _presenceStatus = localStorage.getItem('zg_presence_status') === 'online' ? 'online' : 'physical';

function getPresenceStatus() { return _presenceStatus; }

function setPresenceStatus(status) {
  _presenceStatus = status === 'online' ? 'online' : 'physical';
  localStorage.setItem('zg_presence_status', _presenceStatus);
  if (_presenceSocket && _presenceSocket.connected) {
    _presenceSocket.emit('presence-status', { status: _presenceStatus });
  }
}

// Cached once per page load — whether this browser is currently logged in,
// and to which account. Used to tell the server "I'm logged in" as part of
// presence-join, so "Share My Favourite" can tell whether a present friend
// is actually reachable (logged in) before trying to deliver to them.
let _myUserIdFetched = false;
let _myUserId = null;
async function getMyUserId() {
  if (_myUserIdFetched) return _myUserId;
  _myUserIdFetched = true;
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    _myUserId = (data.loggedIn && data.user) ? data.user.id : null;
  } catch (e) { _myUserId = null; }
  return _myUserId;
}

// Call once per page, right after `const socket = io();`, on any
// event-scoped page that has <div id="presence-widget"> in its header.
function initPresence(socket) {
  _presenceSocket = socket;
  const announce = async () => {
    const eventId = getEventId();
    if (!eventId) return;
    if (getEventStatus() === 'history') return; // just browsing history — not "in" the event
    const userId = await getMyUserId();
    socket.emit('presence-join', {
      eventId,
      clientId: getClientId(),
      name: getGuestName() || 'ผู้ร่วมงาน',
      status: _presenceStatus,
      userId,
    });
  };
  socket.on('connect', announce);
  socket.on('reaction', showReaction);
  socket.on('chat-message', showChatToast);
  socket.on('presence-changed', (list) => {
    _presenceList = Array.isArray(list) ? list : [];
    renderPresenceWidget();
  });
  if (socket.connected) announce();
}

// Tells the server to drop this person from the list right away, instead of
// waiting for their socket to disconnect — used when explicitly leaving an
// event via the "Leave" link.
function presenceLeaveNow() {
  if (_presenceSocket && _presenceSocket.connected) _presenceSocket.emit('presence-leave');
  _presenceList = [];
  renderPresenceWidget();
}

function renderPresenceWidget() {
  const el = document.getElementById('presence-widget');
  if (!el) return;
  const list = _presenceList;
  const total = list.length;
  const onlineCount = list.filter((p) => p.status === 'online').length;
  const physicalCount = total - onlineCount;
  const expanded = el.dataset.expanded === '1';
  const myStatus = getPresenceStatus();
  el.innerHTML = `
    <button type="button" class="presence-badge" id="presence-toggle">
      <span class="presence-dot"></span>
      <span>${total} join · 📍${physicalCount} 🏠${onlineCount}</span>
      <span>${expanded ? '▲' : '▼'}</span>
    </button>
    ${expanded ? `
    <div class="presence-panel">
      <div class="small-note" style="margin:0 0 6px;">สถานะของคุณ</div>
      <div class="presence-status-row">
        <button type="button" data-mystatus="physical" class="${myStatus === 'physical' ? 'selected' : ''}">📍 อยู่ในงาน</button>
        <button type="button" data-mystatus="online" class="${myStatus === 'online' ? 'selected' : ''}">🏠 ออนไลน์</button>
      </div>
      ${total ? list.map((p) => `<div class="presence-person">${p.status === 'online' ? '🏠' : '📍'} ${escapeHtml(p.name)}</div>`).join('') : '<div class="empty">ยังไม่มีใคร join</div>'}
    </div>` : ''}
  `;
  document.getElementById('presence-toggle').addEventListener('click', () => {
    el.dataset.expanded = expanded ? '0' : '1';
    renderPresenceWidget();
  });
  if (expanded) {
    el.querySelectorAll('button[data-mystatus]').forEach((b) => {
      b.addEventListener('click', () => setPresenceStatus(b.dataset.mystatus));
    });
  }
  // If the page has <datalist id="presence-names-list">, keep it in sync too
  // — that's what powers "who to ask to sing" autocomplete inputs.
  populateNameDatalist('presence-names-list', list.map((p) => p.name));
}

// Current live list of names in this event (for "ขอให้ใครร้อง" pickers).
function getPresenceNames() { return _presenceList.map((p) => p.name); }

// Fills a <datalist> with one <option> per name (deduped) so a text input
// with list="<id>" offers autocomplete suggestions while still accepting
// free text for anyone not in the list.
function populateNameDatalist(datalistId, names) {
  const dl = document.getElementById(datalistId);
  if (!dl) return;
  const unique = [...new Set((names || []).filter(Boolean))];
  dl.innerHTML = unique.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
}

// ---- Inbox (per-person notifications for "ขอให้คนอื่นร้อง") ----
// Persisted server-side (unlike presence) and delivered live via a private
// Socket.IO room the server puts this clientId's socket(s) into as part of
// presence-join — so this only works on pages that also call initPresence().
let _inboxSocket = null;
let _inboxItems = [];
let _inboxEventId = '';
let _inboxClientId = '';

async function loadInbox() {
  _inboxEventId = getEventId();
  _inboxClientId = getClientId();
  if (!_inboxEventId || !_inboxClientId) return;
  try {
    const res = await fetch(`/api/inbox?eventId=${encodeURIComponent(_inboxEventId)}&clientId=${encodeURIComponent(_inboxClientId)}`);
    if (!res.ok) return;
    const data = await res.json();
    _inboxItems = data.items || [];
    renderInboxWidget();
  } catch (e) { /* offline or server hiccup — badge just stays as-is */ }
}

// Call once per page, right after initPresence(socket), on any page that has
// <div id="inbox-widget"> in its header.
function initInbox(socket) {
  _inboxSocket = socket;
  loadInbox();
  socket.on('connect', loadInbox);
  socket.on('inbox-new', (item) => {
    if (item.eventId !== getEventId() || item.toClientId !== getClientId()) return;
    if (!_inboxItems.some((i) => i.id === item.id)) _inboxItems.unshift(item);
    renderInboxWidget();
    let msg;
    if (item.kind === 'request') msg = `📥 ${item.fromName || 'มีคน'} ขอให้คุณร้อง "${item.songTitle}"`;
    else if (item.kind === 'favshare') msg = `📥 ${item.fromName || 'มีคน'} แชร์เพลงโปรดให้คุณ (${(item.favorites || []).length} เพลง)`;
    else msg = `📥 ${item.fromName || 'มีคน'} ตอบกลับคำขอเพลง "${item.songTitle}"`;
    showToast(msg);
  });
  socket.on('inbox-updated', (item) => {
    if (item.eventId !== getEventId()) return;
    const idx = _inboxItems.findIndex((i) => i.id === item.id);
    if (idx >= 0) _inboxItems[idx] = item; else _inboxItems.unshift(item);
    renderInboxWidget();
  });
  // Admin cleared this event's songs (Clear all Request List / Reset the
  // stage) — old inbox items would just be pointing at songs that no
  // longer exist, so drop them here too instead of waiting for a reload.
  socket.on('inbox-cleared', (data) => {
    if (!data || data.eventId !== getEventId()) return;
    _inboxItems = [];
    renderInboxWidget();
  });
}

const INBOX_STATUS_LABEL = {
  'yes-solo': '✅ ร้องได้',
  'yes-together': '🤝 ร้องด้วยกันนะ',
  no: '🙏 ขอบคุณที่ชวน แต่ไม่พร้อม',
};

// Small inline dropdown right under the bell — sized to its content (like
// the presence panel), not a full-screen modal, so a handful of messages
// doesn't take over the whole page.
function renderInboxWidget() {
  const el = document.getElementById('inbox-widget');
  if (!el) return;
  const unread = _inboxItems.filter((i) => !i.read).length;
  const expanded = el.dataset.expanded === '1';
  el.innerHTML = `
    <button type="button" class="inbox-bell" id="inbox-bell-btn">📥${unread ? `<span class="inbox-badge">${unread}</span>` : ''}</button>
    ${expanded ? `
    <div class="inbox-panel">
      ${_inboxItems.length ? _inboxItems.map(inboxItemHtml).join('') : '<div class="empty" style="padding:16px 4px;">ยังไม่มีข้อความ</div>'}
    </div>` : ''}
  `;
  document.getElementById('inbox-bell-btn').addEventListener('click', () => {
    const willExpand = el.dataset.expanded !== '1';
    el.dataset.expanded = willExpand ? '1' : '0';
    renderInboxWidget();
    if (willExpand) markInboxRead();
  });
  if (expanded) {
    el.querySelectorAll('button[data-respond]').forEach((btn) => {
      btn.addEventListener('click', () => respondInbox(btn.dataset.respond, btn.dataset.answer));
    });
    el.querySelectorAll('button[data-favshare-view]').forEach((btn) => {
      btn.addEventListener('click', () => openFavShareModal(btn.dataset.favshareView));
    });
  }
}

function inboxItemHtml(item) {
  const time = new Date(item.createdAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  if (item.kind === 'request') {
    return `
    <div class="inbox-item ${item.read ? '' : 'unread'}">
      <div class="inbox-item-head">
        <b>${escapeHtml(item.fromName || 'ไม่ระบุชื่อ')}</b> ขอให้คุณร้อง <b>${escapeHtml(item.songTitle)}</b>
        <span class="inbox-time">${time}</span>
      </div>
      ${item.status === 'pending' ? `
      <div class="btn-row" style="margin-top:8px;">
        <button data-respond="${item.id}" data-answer="yes-solo">✅ ร้องได้</button>
        <button data-respond="${item.id}" data-answer="yes-together">🤝 ร้องด้วยกันนะ</button>
        <button data-respond="${item.id}" data-answer="no">🙏 ไม่พร้อม</button>
      </div>` : `<div class="small-note" style="margin-top:6px;">คุณตอบไปแล้ว: ${INBOX_STATUS_LABEL[item.status] || ''}</div>`}
    </div>`;
  }
  if (item.kind === 'favshare') {
    const expired = Date.now() > item.expiresAt;
    const favs = item.favorites || [];
    return `
    <div class="inbox-item ${item.read ? '' : 'unread'}">
      <div class="inbox-item-head">
        <b>${escapeHtml(item.fromName || 'ไม่ระบุชื่อ')}</b> แชร์เพลงโปรดให้คุณ (${favs.length} เพลง)
        <span class="inbox-time">${time}</span>
      </div>
      ${expired ? `<div class="small-note" style="margin-top:6px;">⌛ หมดอายุแล้ว (แชร์ไว้เกิน 3 วัน)</div>` : `
      <div class="btn-row" style="margin-top:8px;">
        <button data-favshare-view="${item.id}">👀 ดูรายชื่อเพลง</button>
      </div>`}
    </div>`;
  }
  return `
  <div class="inbox-item ${item.read ? '' : 'unread'}">
    <div class="inbox-item-head">
      <b>${escapeHtml(item.fromName || 'ไม่ระบุชื่อ')}</b> ตอบกลับคำขอเพลง <b>${escapeHtml(item.songTitle)}</b>
      <span class="inbox-time">${time}</span>
    </div>
    <div class="small-note" style="margin-top:6px;">${INBOX_STATUS_LABEL[item.status] || ''}</div>
  </div>`;
}

// ---- "Favourite ของ <ชื่อคนแชร์>" modal ----
// Opened from a favshare inbox item's "ดูรายชื่อเพลง" button. Built and
// injected into the DOM on first use (rather than living as static markup
// in every page) since the inbox widget itself is shared across four
// different pages (index/nextshow/musician/admin) via this one file.
// Copies one song at a time so the recipient can pick and choose, instead of
// an all-or-nothing bulk import.
function ensureFavShareModal() {
  if (document.getElementById('favshare-modal-bg')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="modal-bg" id="favshare-modal-bg" style="display:none;">
      <div class="modal">
        <button class="close-x" id="favshare-modal-close">✕</button>
        <h2 id="favshare-modal-title">⭐ Favourite</h2>
        <div id="favshare-modal-list"></div>
        <button id="favshare-modal-done" style="width:100%; margin-top:14px;">ปิดหน้าต่างนี้</button>
      </div>
    </div>`;
  document.body.appendChild(div.firstElementChild);
  document.getElementById('favshare-modal-close').addEventListener('click', closeFavShareModal);
  document.getElementById('favshare-modal-done').addEventListener('click', closeFavShareModal);
  document.getElementById('favshare-modal-bg').addEventListener('click', (e) => {
    if (e.target.id === 'favshare-modal-bg') closeFavShareModal();
  });
}
function closeFavShareModal() {
  const el = document.getElementById('favshare-modal-bg');
  if (el) el.style.display = 'none';
}

async function openFavShareModal(itemId) {
  const item = _inboxItems.find((i) => i.id === itemId);
  if (!item) return;
  ensureFavShareModal();

  // Check which of the shared songs the recipient already has, so those
  // rows can show as already-added instead of an active copy button.
  let myKeys = new Set();
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (data.loggedIn) {
      myKeys = new Set((data.favorites || []).map((f) => (f.title + '|' + (f.artist || '')).toLowerCase()));
    }
  } catch (e) { /* best-effort — worst case a row's button just tries and no-ops */ }

  document.getElementById('favshare-modal-title').textContent = `⭐ Favourite ของ ${item.fromName || 'ไม่ระบุชื่อ'}`;
  renderFavShareModalList(item, myKeys);
  document.getElementById('favshare-modal-bg').style.display = 'flex';
}

function renderFavShareModalList(item, myKeys) {
  const el = document.getElementById('favshare-modal-list');
  const favs = item.favorites || [];
  if (!favs.length) { el.innerHTML = '<div class="empty">ไม่มีเพลงโปรดในรายการนี้</div>'; return; }
  el.innerHTML = favs.map((f, idx) => {
    const key = (f.title + '|' + (f.artist || '')).toLowerCase();
    const already = myKeys.has(key);
    const chordLink = f.chordUrl ? `<a href="${f.chordUrl}" target="_blank" rel="noopener" class="link-out" style="margin-top:0;">↗ ดูคอร์ด</a>` : '';
    return `
    <div class="card fav-card">
      <div class="fav-row">
        <div class="fav-info">
          <div class="fav-title">${escapeHtml(f.title)}</div>
          <div class="fav-sub">${escapeHtml(f.artist || 'ไม่ระบุศิลปิน')}${chordLink ? ' · ' + chordLink : ''}</div>
        </div>
        <div class="fav-actions">
          ${already
            ? `<button class="btn-favshare-added" style="pointer-events:none;">✓ มีอยู่แล้ว</button>`
            : `<button class="btn-favshare-add" data-favshare-copy-one="${idx}">+ Add to My Favorite</button>`}
        </div>
      </div>
    </div>`;
  }).join('');
  el.querySelectorAll('button[data-favshare-copy-one]').forEach((btn) => {
    btn.addEventListener('click', () => copyOneFavShareSong(item.id, parseInt(btn.dataset.favshareCopyOne, 10), btn));
  });
}

async function copyOneFavShareSong(itemId, index, btn) {
  btn.disabled = true;
  try {
    const res = await fetch(`/api/inbox/${itemId}/copy-favorites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'เกิดข้อผิดพลาด'); btn.disabled = false; return; }
    btn.disabled = false;
    btn.classList.remove('btn-favshare-add');
    btn.classList.add('btn-favshare-added');
    btn.style.pointerEvents = 'none';
    btn.textContent = '✓ มีอยู่แล้ว';
    showToast(data.imported > 0 ? 'คัดลอกเข้ารายการโปรดแล้ว ⭐' : 'เพลงนี้อยู่ในรายการโปรดของคุณอยู่แล้ว');
  } catch (e) {
    showToast('เกิดข้อผิดพลาด');
    btn.disabled = false;
  }
}

async function respondInbox(id, answer) {
  try {
    const res = await fetch(`/api/inbox/${id}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: getClientId(), response: answer }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'เกิดข้อผิดพลาด'); return; }
    const idx = _inboxItems.findIndex((i) => i.id === id);
    if (idx >= 0) _inboxItems[idx] = data.item;
    renderInboxWidget();
    showToast('ส่งคำตอบแล้ว ✓');
  } catch (e) {
    showToast('เกิดข้อผิดพลาด');
  }
}
async function markInboxRead() {
  if (!_inboxItems.some((i) => !i.read)) return;
  _inboxItems.forEach((i) => { i.read = true; });
  renderInboxWidget();
  try {
    await fetch('/api/inbox/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: _inboxEventId, clientId: _inboxClientId }),
    });
  } catch (e) { /* best-effort — badge already cleared locally */ }
}

// True on any page that only makes sense within a joined event (Request
// List, Next Show List, นักดนตรี, Admin). The bare "/" root is now the cover
// page (home.html, where people pick Any Event / ZyGen Event), which needs
// no event — so only the explicit filenames count here.
function pageRequiresEvent() {
  const p = location.pathname;
  return ['index.html', 'nextshow.html', 'musician.html', 'admin.html'].some((name) => p.endsWith(name));
}

// ---- Mode chosen on the cover page (home.html) ----
// 'any' = Any Event, 'zygen' = ZyGen Event. Both work as guest; this is just
// remembered per device so ZyGen-only features can branch on it later.
function getMode() {
  const m = localStorage.getItem('zg_mode');
  return m === 'zygen' ? 'zygen' : 'any';
}
function getModeLabel() {
  return getMode() === 'zygen' ? 'ZyGen Event' : 'Any Event';
}

// ---- Page chrome shared by every inner page: mode theme + Home button ----
// ZyGen Event mode shows one of the cover pictures as the page background
// and as a banner behind the header (one picture per browser session, so it
// doesn't change from page to page). Any Event mode keeps the original plain
// navy look. Every inner page also gets a "🏠 Home" pill next to the logo to
// go back out to the cover page (home.html, served at "/").
const ZY_COVERS = [1,2,3,4,5,6,7,8,9,10,11,12,13,15]
  .map((n) => `/assets/cover/cover-${String(n).padStart(2, '0')}.jpg`);

const IN_FRAME = window.self !== window.top; // true inside the watch.html shell

// Turn a live link into something we can put in an <iframe>, or null when the
// platform can't be embedded (Teams, Zoom, …) — then only "open separately" shows.
function liveEmbedUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
  let id = '';
  if (host === 'youtu.be') id = u.pathname.slice(1);
  else if (host === 'youtube.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else { const m = u.pathname.match(/^\/(live|embed|shorts)\/([\w-]{6,})/); if (m) id = m[2]; }
  }
  if (id && /^[\w-]{6,}$/.test(id)) return `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1&rel=0`;
  if (host === 'facebook.com' || host === 'fb.watch') {
    return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false&autoplay=true`;
  }
  return null;
}

// Red "LIVE" bar under the header of the joined event when Admin has switched
// Live Broadcast on (link set on live.html). Polled every 30s. Two actions:
// open the stream in a separate window, or watch inside this site (watch.html:
// video on one half, the normal app on the other half).
function initLiveBanner() {
  const hdr = document.querySelector('header.top');
  const id = getEventId();
  if (IN_FRAME || !hdr || !id || getEventStatus() === 'history' || document.getElementById('live-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'live-banner';
  bar.className = 'live-banner';
  bar.style.display = 'none';
  hdr.insertAdjacentElement('afterend', bar);
  const tick = async () => {
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(id)}/live`);
      if (!r.ok) return;
      const l = await r.json();
      if (l.on && /^https?:\/\//i.test(l.url)) {
        bar.innerHTML = '';
        const t = document.createElement('span');
        t.className = 'live-banner-text';
        t.textContent = `🔴 กำลัง Live อยู่${l.label ? ' — ' + l.label : ''}`;
        const a = document.createElement('a');
        a.href = l.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = '↗ ดูผ่านหน้าต่างแยก';
        bar.append(t, a);
        if (liveEmbedUrl(l.url)) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = '▶ ดูในเว็บนี้';
          b.onclick = () => {
            const page = location.pathname.split('/').pop() || 'index.html';
            location.href = 'watch.html?p=' + encodeURIComponent(page);
          };
          bar.append(b);
        }
        bar.style.display = '';
      } else bar.style.display = 'none';
    } catch (e) { /* offline */ }
  };
  tick();
  setInterval(tick, 30000);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initLiveBanner);
else initLiveBanner();

// ---- Live chat (UI lives in watch.html) ----
// Read fresh from localStorage: the watch shell and the page inside its frame
// are separate scripts, so either may have changed the choice.
function currentPresenceStatus() { return localStorage.getItem('zg_presence_status') === 'online' ? 'online' : 'physical'; }
function sendChat(text) {
  if (!_presenceSocket || !_presenceSocket.connected || !getEventId()) return false;
  _presenceSocket.emit('chat-send', { eventId: getEventId(), text, name: getGuestName() || 'ผู้ร่วมงาน', where: currentPresenceStatus() });
  return true;
}
// People not in the watch view still see chat lines pass by (same little feed
// as reactions). The watch shell turns this off — it shows its own chat panel.
function showChatToast(m) {
  if (IN_FRAME || window.ZG_SUPPRESS_CHAT_TOAST || !m || m.eventId !== getEventId() || !document.body) return;
  let box = document.getElementById('reaction-feed');
  if (!box) { box = document.createElement('div'); box.id = 'reaction-feed'; box.className = 'reaction-feed'; document.body.appendChild(box); }
  const row = document.createElement('div');
  row.className = 'reaction-row';
  row.textContent = `💬 ${m.name}${m.where === 'online' ? ' · ทางบ้าน' : ''}: ${m.text.length > 80 ? m.text.slice(0, 80) + '…' : m.text}`;
  box.appendChild(row);
  while (box.children.length > 5) box.removeChild(box.firstChild);
  setTimeout(() => row.remove(), 8000);
}

// ---- Emoji reactions ----
const REACTION_EMOJIS = ['❤️', '👍', '👏', '🔥', '🎉', '😆', '🎸', '🤟'];
function sendReaction(emoji) {
  if (!_presenceSocket || !_presenceSocket.connected || !getEventId()) return;
  _presenceSocket.emit('reaction', { eventId: getEventId(), emoji, name: getGuestName() || 'ผู้ร่วมงาน', where: currentPresenceStatus() });
}
// Floating emoji + a small "who pressed what" feed, bottom-left of any page.
// (Skipped inside the watch.html frame — the shell shows it once for both.)
function showReaction(r) {
  if (IN_FRAME || !r || r.eventId !== getEventId() || !document.body) return;
  let box = document.getElementById('reaction-feed');
  if (!box) {
    box = document.createElement('div');
    box.id = 'reaction-feed';
    box.className = 'reaction-feed';
    document.body.appendChild(box);
  }
  const row = document.createElement('div');
  row.className = 'reaction-row';
  row.textContent = `${r.emoji} ${r.name}${r.where === 'online' ? ' · ทางบ้าน' : ''}`;
  box.appendChild(row);
  while (box.children.length > 5) box.removeChild(box.firstChild);
  setTimeout(() => row.remove(), 6000);
  const fl = document.createElement('div');
  fl.className = 'reaction-float';
  fl.textContent = r.emoji;
  fl.style.left = (10 + Math.random() * 80) + 'vw';
  document.body.appendChild(fl);
  setTimeout(() => fl.remove(), 3000);
}

// Who am I (login + roles)? One /api/me call per page, shared by callers.
let _myAuthPromise = null;
function getMyAuth() {
  if (!_myAuthPromise) {
    _myAuthPromise = fetch('/api/me').then((r) => r.json()).catch(() => ({ loggedIn: false, roles: {} }));
  }
  return _myAuthPromise;
}

function initPageChrome() {
  if (!document.body) return;
  if (getMode() === 'zygen' && !document.body.classList.contains('theme-zygen')) {
    // Background changes every 15 minutes. The slot comes from the clock, so
    // every page (and every device) shows the same picture at the same time.
    const slotIdx = () => Math.floor(Date.now() / (15 * 60 * 1000)) % ZY_COVERS.length;
    const applyCover = () => document.body.style.setProperty('--zy-cover', `url("${ZY_COVERS[slotIdx()]}")`);
    document.body.classList.add('theme-zygen');
    applyCover();
    let shown = slotIdx();
    setInterval(() => { if (slotIdx() !== shown) { shown = slotIdx(); applyCover(); } }, 30 * 1000);
    const bg = document.createElement('div');
    bg.className = 'zy-bg';
    document.body.insertBefore(bg, document.body.firstChild);
  }
  const row = document.querySelector('header.top .brand-row');
  if (row && !row.querySelector('.home-link')) {
    const a = document.createElement('a');
    a.href = '/';
    a.className = 'home-link';
    a.title = 'ออกไปหน้าแรก (เลือกโหมดใหม่)';
    a.textContent = '🚪 Exit';
    if (IN_FRAME) a.target = '_top';
    const logo = row.querySelector('img.brand-logo');
    row.insertBefore(a, logo || null);
  }
  // ZyGen mode: an account whose "ผู้ใช้ทั่วไป" role was switched off in the Role
  // page gets a notice instead of the app (Super Admin is never blocked).
  if (getMode() === 'zygen') {
    getMyAuth().then((me) => {
      if (me && me.loggedIn && me.roles && me.roles.general === false) {
        const ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;z-index:100;background:rgba(5,15,35,.95);display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:#fff';
        ov.innerHTML = '<div class="card" style="max-width:420px">บัญชีนี้ไม่มีสิทธิ์ใช้งานทั่วไปของ ZyGen Event<br><small style="color:var(--text-dim)">กรุณาติดต่อ Super Admin เพื่อขอสิทธิ์</small><br><br>' +
          '<a class="btn" href="/auth/logout?from=/">ออกจากระบบ</a></div>';
        document.body.appendChild(ov);
      }
    });
  }
  // ZyGen mode only: the logo opens a small hidden menu (first item: Master Data).
  const logo = row && row.querySelector('img.brand-logo');
  if (logo && !logo.dataset.menu) {
    logo.dataset.menu = '1';
    const wrap = document.createElement('div');
    wrap.className = 'logo-menu-wrap';
    logo.parentNode.insertBefore(wrap, logo);
    wrap.appendChild(logo);
    logo.style.cursor = 'pointer';
    const menu = document.createElement('div');
    menu.className = 'logo-menu';
    menu.innerHTML = '<a href="events.html"' + (IN_FRAME ? ' target="_top"' : '') + '>🏠 Home</a>';
    getMyAuth().then((me) => {
      const r = (me && me.roles) || {};
      if (getMode() === 'zygen' && r.djadmin) menu.insertAdjacentHTML('beforeend', '<a href="employees.html">🗂 Master Data</a>');
      if (getMode() === 'zygen' && r.superadmin) menu.insertAdjacentHTML('beforeend', '<a href="role.html">🔑 Role</a>');
      if (r.djadmin) menu.insertAdjacentHTML('beforeend', '<a href="spotify.html">🎧 Spotify Playlist</a>');
      menu.insertAdjacentHTML('beforeend', '<a href="friends.html">👥 Public Playlist</a>');
      menu.insertAdjacentHTML('beforeend', '<a href="live.html">🔴 Live Broadcast</a>');
      menu.insertAdjacentHTML('beforeend', '<div class="logo-menu-who">' + (me && me.loggedIn
        ? 'ล็อกอิน: ' + escapeHtml([me.user.email].concat(me.user.altEmails || []).filter((v, i, a) => v && a.indexOf(v) === i).join(', ') || '(ไม่มีอีเมล)')
        : 'ยังไม่ได้ล็อกอิน') + '</div>');
    });
    wrap.appendChild(menu);
    logo.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
    document.addEventListener('click', () => menu.classList.remove('open'));
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPageChrome);
else initPageChrome();

// Clears the joined event. Pages that require one (Request List, Next Show
// List, นักดนตรี, Admin) send the person back to events.html; pages that
// don't (Favourite, Event list itself) just re-render in place.
function leaveEvent() {
  presenceLeaveNow();
  clearEvent();
  if (pageRequiresEvent()) {
    location.href = 'events.html';
    return;
  }
  renderEventHeader();
  if (typeof window.onLeaveEvent === 'function') window.onLeaveEvent();
}

// Same per-provider icon used on login.html's provider buttons, reused here
// so the little icon in front of a logged-in person's name hints at which
// account they signed in with (Google vs Microsoft vs LINE) at a glance.
const AUTH_PROVIDER_ICON = {
  microsoft: '🟦',
  google: '🟢',
  line: '💬',
};

// Shared login-status bar. Expects an element with id="auth-bar" in the
// page header. Fetches /api/me and shows either a login prompt or the
// signed-in user's name + logout — either way also links to ⭐ Favourite,
// which lives here (top-right) rather than as its own nav tab.
async function renderAuthBar() {
  const el = document.getElementById('auth-bar');
  if (!el) return;
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (data.loggedIn) {
      const favCount = (data.favorites || []).length;
      // The signed-in name is deliberately not shown here (it is in the logo menu); just Favourite + Sign out.
      el.innerHTML = `<a href="favorites.html">⭐ Favourite (${favCount})</a> · ` +
        `<a href="/auth/logout?from=${encodeURIComponent(location.pathname)}">Sign out</a>`;
    } else {
      el.innerHTML = `<a href="favorites.html">⭐ Favourite</a> · ` +
        `<a href="login.html?from=${encodeURIComponent(location.pathname)}">เข้าสู่ระบบ</a>`;
    }
  } catch (e) {
    el.innerHTML = '';
  }
}

// Guards against stale content from the browser's back/forward cache. Pages
// that require an event (Request List, Next Show List, Musician, Admin)
// normally redirect to events.html the moment they load with no event
// joined — but a bfcache restore (e.g. pressing the browser Back button)
// skips that check entirely and shows the frozen old page as-is, which can
// look like leftover song data hanging around on what should be the event
// picker. Forcing a reload on a persisted pageshow re-runs that check fresh.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  if (pageRequiresEvent() && !getEventId()) location.reload();
});

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}


// Spotify block for a playlist: (link button) + scannable Spotify Code image + save button.
// The image comes through our server; if that fails the browser tries Spotify directly.
function spotifyBlockHtml(url, noLink) {
  const m = String(url || '').match(/playlist\/([A-Za-z0-9]{22})/);
  if (!m) return '';
  const id = m[1];
  const direct = 'https://scannables.scdn.co/uri/plain/png/021d44/white/640/spotify:playlist:' + id;
  const fail = "if(!this.dataset.t){this.dataset.t=1;this.src='" + direct + "';}else{this.parentNode.innerHTML='<span class=\\'small-note\\'>โหลดรูป Spotify Code ไม่ได้ในตอนนี้</span>';}";
  return '<div class="spotify-block">' +
    (noLink ? '' : '<a class="btn-spotify-link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">🎧 เปิดใน Spotify</a>') +
    '<div class="spotify-code"><img src="/api/spotify-code/' + id + '" alt="Spotify Code" onerror="' + fail + '" />' +
    '<a class="link-out" href="/api/spotify-code/' + id + '?dl=1" download="spotify-code.png">⬇ บันทึกรูป Spotify Code</a></div></div>';
}


// ---- History events: add a song to my Favourite / to a playlist (playlists are the same ones as in Favourite) ----
function historySongActionsHtml(songId) {
  if (getEventStatus() !== 'history') return '';
  return '<span class="hist-actions">' +
    '<button type="button" class="hist-fav" data-hfav="' + songId + '">⭐ <span class="hl">Add to </span>Favourite</button>' +
    '<button type="button" class="hist-pl" data-hpl="' + songId + '">📁 <span class="hl">Add to </span>Playlist</button></span>';
}
async function histNeedLogin() {
  const me = await getMyAuth();
  if (me && me.loggedIn) return true;
  showToast('ต้องเข้าสู่ระบบก่อน');
  setTimeout(() => { location.href = 'login.html?from=' + encodeURIComponent(location.pathname); }, 900);
  return false;
}
async function histPost(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showToast(data.error || 'ทำรายการไม่สำเร็จ'); return null; }
  return data;
}
async function histAddFavourite(songId) {
  if (!(await histNeedLogin())) return null;
  const d = await histPost('/api/songs/' + encodeURIComponent(songId) + '/to-favourite');
  if (d) showToast(d.existed ? '⭐ มีใน Favourite ของคุณอยู่แล้ว' : '⭐ เพิ่มใน Favourite แล้ว');
  return d;
}
async function histOpenPlaylistModal(songId) {
  if (!(await histNeedLogin())) return;
  const res0 = await fetch('/api/songs/' + encodeURIComponent(songId) + '/playlists');
  const d0 = await res0.json().catch(() => ({}));
  if (!res0.ok) { showToast(d0.error || 'โหลด Playlist ไม่ได้'); return; }
  const pls = d0.playlists || [];
  const checked = new Set(pls.filter(p => p.has).map(p => p.id));
  let bg = document.getElementById('hist-pl-bg');
  if (bg) bg.remove();
  bg = document.createElement('div');
  bg.id = 'hist-pl-bg'; bg.className = 'modal-bg modal-center'; bg.style.display = 'flex';
  bg.innerHTML = '<div class="modal"><button class="close-x" id="hpl-x">✕</button>' +
    '<h2 style="margin-top:0;">📁 Add to Playlist</h2>' +
    '<div class="small-note" style="margin-bottom:8px;">เลือก Playlist ที่จะใส่เพลงนี้ (Playlist เดียวกับในหน้า Favourite) ไม่ต้องเพิ่มเข้า ⭐ Favourite ก่อน</div>' +
    '<div class="pl-pick-list">' + (pls.length ? pls.map(p => '<label class="pl-pick-row"><input type="checkbox" data-plid="' + p.id + '"' + (checked.has(p.id) ? ' checked' : '') + ' /><span><b>' + escapeHtml(p.name) + '</b> <span class="small-note">' + (p.visibility === 'public' ? '🌐 Public' : '🔒 Private') + '</span></span></label>').join('') : '<div class="empty">ยังไม่มี Playlist</div>') + '</div>' +
    '<button type="button" id="hpl-newbtn" style="width:100%;margin-top:10px;">＋ สร้าง Playlist ใหม่…</button>' +
    '<div class="btn-row" style="margin-top:14px;"><button id="hpl-cancel" style="flex:1;">ยกเลิก</button><button class="btn-blue" id="hpl-save" style="flex:1;">บันทึก</button></div></div>';
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('#hpl-x').onclick = close; bg.querySelector('#hpl-cancel').onclick = close;
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  bg.querySelectorAll('input[data-plid]').forEach(cb => cb.addEventListener('change', () => { if (cb.checked) checked.add(cb.dataset.plid); else checked.delete(cb.dataset.plid); }));
  const url = '/api/songs/' + encodeURIComponent(songId) + '/playlists';
  bg.querySelector('#hpl-save').onclick = async () => {
    const r = await histPost(url, { playlistIds: [...checked] });
    if (!r) return;
    close(); showToast('📁 บันทึกลง Playlist แล้ว');
  };
  // Second pop-up: create a brand-new playlist (name + Private/Public), finished in its own window.
  bg.querySelector('#hpl-newbtn').onclick = () => {
    const nb = document.createElement('div');
    nb.className = 'modal-bg modal-center'; nb.style.display = 'flex'; nb.style.zIndex = '1200';
    nb.innerHTML = '<div class="modal"><button class="close-x" id="hnp-x">✕</button>' +
      '<h2 style="margin-top:0;">＋ สร้าง Playlist ใหม่</h2>' +
      '<label>ชื่อ Playlist *</label><input type="text" id="hnp-name" maxlength="60" placeholder="เช่น เพลงร้องคาราโอเกะ, เพลงช้า" />' +
      '<label style="display:block;margin-top:8px;">การมองเห็น</label>' +
      '<div class="btn-row" id="hnp-vis"><button type="button" data-vis="private" class="selected">🔒 Private (เห็นคนเดียว)</button><button type="button" data-vis="public">🌐 Public (เพื่อนดูได้)</button></div>' +
      '<div class="small-note" style="margin-top:6px;">เพลงนี้จะถูกใส่ใน Playlist ใหม่ให้อัตโนมัติ</div>' +
      '<div class="btn-row" style="margin-top:14px;"><button id="hnp-cancel" style="flex:1;">ยกเลิก</button><button class="btn-blue" id="hnp-create" style="flex:1;">สร้าง</button></div></div>';
    document.body.appendChild(nb);
    let vis = 'private';
    const closeNb = () => nb.remove();
    nb.querySelector('#hnp-x').onclick = closeNb; nb.querySelector('#hnp-cancel').onclick = closeNb;
    nb.querySelectorAll('#hnp-vis button').forEach(b => b.addEventListener('click', () => { vis = b.dataset.vis; nb.querySelectorAll('#hnp-vis button').forEach(x => x.classList.toggle('selected', x === b)); }));
    nb.querySelector('#hnp-name').focus();
    nb.querySelector('#hnp-create').onclick = async () => {
      const name = nb.querySelector('#hnp-name').value.trim();
      if (!name) { showToast('กรุณาใส่ชื่อ Playlist'); return; }
      const r = await histPost(url, { playlistIds: [...checked], newName: name, visibility: vis });
      if (!r) return;
      closeNb(); close(); showToast('📁 สร้าง Playlist "' + name + '" และเพิ่มเพลงแล้ว');
    };
  };
}
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('button[data-hfav]');
  if (a) { histAddFavourite(a.dataset.hfav); return; }
  const p = e.target.closest && e.target.closest('button[data-hpl]');
  if (p) histOpenPlaylistModal(p.dataset.hpl);
});


// ---- Edit a song of an event (fix a typo) — shared by Next Show List etc. ----
function songEditBtnHtml(s) {
  return '<button type="button" class="btn-song-edit" title="แก้ไขเพลงนี้" data-sedit="' + escapeHtml(s.id) + '" data-t="' + escapeHtml(s.title || '') + '" data-a="' + escapeHtml(s.artist || '') + '" data-c="' + escapeHtml(s.chordUrl || s.chordId || '') + '" data-st="' + escapeHtml(s.adminStatus || '') + '">✏️</button>';
}
function openSongEditModal(btn) {
  if (btn.dataset.st === 'checked') { alert('Admin แก้ไขแล้ว ตอนนี้ไม่สามารถแก้ไขได้ด้วยตนเองได้ ถ้าต้องการแก้ไข ให้แจ้ง Admin'); return; }
  const id = btn.dataset.sedit;
  let bg = document.getElementById('song-edit-bg'); if (bg) bg.remove();
  bg = document.createElement('div');
  bg.id = 'song-edit-bg'; bg.className = 'modal-bg modal-center'; bg.style.display = 'flex'; bg.style.zIndex = '1200';
  bg.innerHTML = '<div class="modal"><button class="close-x" id="se-x">✕</button><h2 style="margin-top:0;">แก้ไขเพลง</h2>' +
    '<div class="small-note" style="margin-bottom:10px;">(ถ้าคุณไม่ได้เป็นคนขอเพลงนี้ กรุณาอย่าแก้ไขข้อมูลของคนอื่น)</div>' +
    '<label>ชื่อเพลง *</label><input type="text" id="se-title" />' +
    '<label>ศิลปิน</label><input type="text" id="se-artist" />' +
    '<label>หมายเลข/ลิงก์คอร์ด dochord (ไม่บังคับ)</label><input type="text" id="se-chord" placeholder="เช่น 378192 หรือ https://www.dochord.com/378192/" />' +
    '<div class="btn-row" style="margin-top:14px;"><button id="se-cancel" style="flex:1;">ยกเลิก</button><button class="primary" id="se-save" style="flex:1;">บันทึกการแก้ไข</button></div></div>';
  document.body.appendChild(bg);
  bg.querySelector('#se-title').value = btn.dataset.t; bg.querySelector('#se-artist').value = btn.dataset.a; bg.querySelector('#se-chord').value = btn.dataset.c;
  const close = () => bg.remove();
  bg.querySelector('#se-x').onclick = close; bg.querySelector('#se-cancel').onclick = close;
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  bg.querySelector('#se-save').onclick = async () => {
    const title = bg.querySelector('#se-title').value.trim();
    if (!title) { showToast('กรุณาใส่ชื่อเพลง'); return; }
    const chordInput = bg.querySelector('#se-chord').value.trim();
    let chordUrl = '';
    if (chordInput) {
      chordUrl = buildDochordUrl(chordInput) || '';
      if (!chordUrl) { showToast('รูปแบบหมายเลข/ลิงก์ dochord ไม่ถูกต้อง ลองใหม่หรือเว้นว่างไว้'); return; }
    }
    const res = await fetch('/api/songs/' + encodeURIComponent(id) + '/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, artist: bg.querySelector('#se-artist').value.trim(), chordUrl, chordId: '' }) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.existing) { alert('มีคนขอเพลงนี้ไปแล้ว (รหัสคอร์ดตรงกัน)\n\nชื่อเพลง: ' + data.existing.title + '\nเสนอโดย: ' + (data.existing.requestedBy || 'ไม่ระบุชื่อ')); return; }
    if (!res.ok) { showToast(data.error || 'แก้ไขไม่สำเร็จ'); return; }
    close(); showToast('แก้ไขแล้ว ✓');
  };
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('button[data-sedit]');
  if (b) openSongEditModal(b);
});
