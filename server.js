// ZG Live Jam - server.js
// Node.js + Express + Socket.IO backend for the company outing live-music request app.

const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

// Minimal built-in .env loader (no dotenv dependency, keeps npm install fast).
// Only fills in variables that aren't already set in the real environment,
// so real hosting env vars (Render, etc.) always win over a local .env file.
// Used for local testing convenience — just copy .env.example to .env.
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
})();

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1999';
const DB_FILE = path.join(__dirname, 'data', 'db.json');

const MUSICIAN_LEVELS = ['อยากเล่นมาก', 'เล่นได้', 'ลองดู', 'เล่นไม่ได้', 'ไม่ระบุ'];
const VOTE_TYPES = ['want', 'singMyself', 'requestOther']; // อยากฟัง / อยากร้อง / ขอให้คนอื่นร้อง
const SELF_DELETE_VOTE_LIMIT = 5; // above this many want+singMyself votes, only admin can delete

// ---------- Persistence ----------
function loadDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { songs: [], nextShow: [] };
  }
}

function saveDb() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDb();
if (!db.songs) db.songs = [];
if (!db.nextShow) db.nextShow = [];
if (!db.users) db.users = [];
if (!db.events) db.events = [];

// Migration: songs created before multi-event support get grouped into one
// auto-created "legacy" event, so no existing test data is silently lost or
// orphaned once every song is required to belong to an event.
(function migrateLegacyEventData() {
  const legacySongs = db.songs.filter((s) => !s.eventId);
  if (!legacySongs.length) return;
  let legacyEvent = db.events.find((e) => e.id === 'legacy');
  if (!legacyEvent) {
    legacyEvent = {
      id: 'legacy',
      name: 'Event เดิม (ก่อนมีระบบหลาย Event)',
      date: '', timeFrom: '', timeTo: '', location: '', mapsUrl: '',
      description: '', contactName: '', contactEmail: '', contactMobile: '',
      createdAt: Date.now(),
    };
    db.events.unshift(legacyEvent);
  }
  legacySongs.forEach((s) => { s.eventId = legacyEvent.id; });
  saveDb();
})();

// ---------- Helpers ----------
function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function findSong(id) {
  return db.songs.find((s) => s.id === id);
}

function findEvent(id) {
  return db.events.find((e) => e.id === id);
}

function publicEvent(e) {
  return {
    id: e.id,
    name: e.name,
    date: e.date || '',
    timeFrom: e.timeFrom || '',
    timeTo: e.timeTo || '',
    location: e.location || '',
    mapsUrl: e.mapsUrl || '',
    description: e.description || '',
    contactName: e.contactName || '',
    contactEmail: e.contactEmail || '',
    contactMobile: e.contactMobile || '',
    createdAt: e.createdAt,
  };
}

function emptyVotes() {
  return { want: [], singMyself: [], requestOther: [] };
}

// Remove any existing vote by this clientId on a song (across all vote types)
function clearVote(song, clientId) {
  song.votes.want = song.votes.want.filter((v) => v.clientId !== clientId);
  song.votes.singMyself = song.votes.singMyself.filter((v) => v.clientId !== clientId);
  song.votes.requestOther = song.votes.requestOther.filter((v) => v.clientId !== clientId);
}

function voteCounts(song) {
  return {
    want: song.votes.want.length,
    singMyself: song.votes.singMyself.length,
    requestOther: song.votes.requestOther.length,
    total: song.votes.want.length + song.votes.singMyself.length + song.votes.requestOther.length,
  };
}

// ---------- dochord.com link verification ----------
// dochord.com blocks automated search (?s=) and its REST API, but individual
// song pages (https://www.dochord.com/{id}/) are fetchable normally, and expose
// clean <meta name="wa-title"> / <meta name="wa-artist"> tags. We use that to
// verify a pasted dochord link is real and to auto-fill the official title/artist.
function fetchHtml(urlStr, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(urlStr);
    } catch (e) {
      return reject(new Error('invalid url'));
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return reject(new Error('invalid protocol'));
    }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(
      target,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ZGLiveJam/1.0; +https://zg-live-jam)',
          Accept: 'text/html',
        },
        timeout: 8000,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const nextUrl = new URL(res.headers.location, target).toString();
          return resolve(fetchHtml(nextUrl, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > 400000) req.destroy(); // safety cap
        });
        res.on('end', () => resolve(data));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function extractMeta(html, key) {
  const re1 = new RegExp(`<meta[^>]*(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i');
  const m1 = html.match(re1);
  if (m1) return m1[1];
  const re2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i');
  const m2 = html.match(re2);
  if (m2) return m2[1];
  return null;
}

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}

function isDochordUrl(str) {
  try {
    const u = new URL(str);
    return /(^|\.)dochord\.com$/i.test(u.hostname);
  } catch (e) {
    return false;
  }
}

// Accepts either a full dochord.com URL or a bare numeric song ID (the number
// at the end of a dochord link, e.g. "22975") and returns a canonical URL.
function buildDochordUrl(idOrUrl) {
  const s = String(idOrUrl || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return `https://www.dochord.com/${s}/`;
  if (isDochordUrl(s)) return s;
  return null;
}

function extractChordId(urlOrId) {
  const s = String(urlOrId || '').trim();
  if (/^\d+$/.test(s)) return s;
  try {
    const u = new URL(s);
    const m = u.pathname.match(/(\d+)/);
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

function musicianSummary(song) {
  const summary = {};
  MUSICIAN_LEVELS.forEach((l) => (summary[l] = 0));
  Object.values(song.musicianResponses || {}).forEach((entry) => {
    const level = entry && entry.level ? entry.level : entry; // tolerate legacy plain-string data
    if (summary[level] !== undefined) summary[level]++;
  });
  return summary;
}

function voterDetail(song) {
  const withName = (v) => (v.name && String(v.name).trim()) || 'ไม่ระบุชื่อ';
  return {
    want: song.votes.want.map(withName),
    singMyself: song.votes.singMyself.map(withName),
    requestOther: song.votes.requestOther.map((v) => ({ name: withName(v), target: v.targetName || '' })),
  };
}

function publicSong(song) {
  // Tolerate legacy musicianResponses where the value was a plain level string.
  const musicianResponses = {};
  Object.entries(song.musicianResponses || {}).forEach(([name, entry]) => {
    musicianResponses[name] = entry && typeof entry === 'object' ? entry : { level: entry, role: '' };
  });
  return {
    id: song.id,
    title: song.title,
    artist: song.artist || '',
    requestedBy: song.requestedBy || '',
    createdAt: song.createdAt,
    chordUrl: song.chordUrl || '',
    chordId: song.chordId || '',
    chordVerified: !!song.chordUrl,
    chordPending: !song.chordUrl && !!song.chordId,
    adminStatus: song.adminStatus || 'unchecked',
    votes: voteCounts(song),
    voters: voterDetail(song),
    requestOtherDetails: song.votes.requestOther.map((v) => v.targetName || ''),
    musicianResponses,
    musicianSummary: musicianSummary(song),
  };
}

// Request List / Next Show List are always scoped to one event.
function fullState(eventId) {
  const songs = db.songs.filter((s) => s.eventId === eventId);
  const songIds = new Set(songs.map((s) => s.id));
  return {
    songs: songs.map(publicSong),
    nextShow: db.nextShow
      .filter((item) => songIds.has(item.songId))
      .map((item) => ({ ...item, song: publicSong(findSong(item.songId)) }))
      .filter((item) => item.song),
  };
}

// ---------- Login (optional) ----------
// No new npm dependencies: sessions are a signed, httpOnly cookie (HMAC-SHA256
// over a JSON payload) verified with Node's built-in crypto, and OAuth is a
// plain Authorization-Code exchange using the built-in fetch (Node >= 18).
// If a person never logs in, everything above still works exactly as before —
// login only unlocks the optional Favourite List.
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-' + ADMIN_PIN;
const SESSION_COOKIE = 'zg_session';
const OAUTH_STATE_COOKIE = 'zg_oauth_state';
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 60; // 60 days — favourites are meant to survive weeks before the event
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}
function signToken(payloadObj) {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function isHttps(req) {
  return req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
}

function setCookie(req, res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  if (isHttps(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function clearCookie(req, res, name) {
  setCookie(req, res, name, '', 0);
}

function getSessionUser(req) {
  const data = verifyToken(parseCookies(req)[SESSION_COOKIE]);
  if (!data || !data.uid) return null;
  return db.users.find((u) => u.id === data.uid) || null;
}

function requireLogin(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' });
  req.user = user;
  next();
}

function findOrCreateUser({ provider, providerUserId, name, email }) {
  let user = db.users.find((u) => u.provider === provider && u.providerUserId === providerUserId);
  if (!user) {
    user = { id: newId(), provider, providerUserId, name: name || '', email: email || '', favorites: [], createdAt: Date.now() };
    db.users.push(user);
  } else {
    if (name) user.name = name;
    if (email) user.email = email;
    if (!user.favorites) user.favorites = [];
  }
  saveDb();
  return user;
}

// Each provider is only "enabled" (shown as a login option) once its Client
// ID/Secret env vars are actually set — lets the three be turned on one at a
// time as credentials are obtained, without breaking anything meanwhile.
const OAUTH_PROVIDERS = {
  microsoft: {
    label: 'Microsoft 365',
    enabled: () => !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET),
    authUrl: () => `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID || 'common'}/oauth2/v2.0/authorize`,
    tokenUrl: () => `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID || 'common'}/oauth2/v2.0/token`,
    clientId: () => process.env.MICROSOFT_CLIENT_ID,
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET,
    scope: 'openid profile email',
  },
  google: {
    label: 'Google',
    enabled: () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    authUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    scope: 'openid profile email',
  },
  line: {
    label: 'LINE',
    enabled: () => !!(process.env.LINE_CLIENT_ID && process.env.LINE_CLIENT_SECRET),
    authUrl: () => 'https://access.line.me/oauth2/v2.1/authorize',
    tokenUrl: () => 'https://api.line.me/oauth2/v2.1/token',
    clientId: () => process.env.LINE_CLIENT_ID,
    clientSecret: () => process.env.LINE_CLIENT_SECRET,
    scope: 'profile openid',
  },
};

function enabledProviderList() {
  return Object.entries(OAUTH_PROVIDERS)
    .filter(([, p]) => p.enabled())
    .map(([key, p]) => ({ key, label: p.label }));
}

// Decode an OIDC id_token's payload without verifying the signature — safe
// here because the token just arrived directly from the provider's own
// token endpoint over HTTPS (server-to-server), not from the browser.
function decodeIdTokenClaims(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (e) {
    return {};
  }
}

// ---------- App setup ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

function broadcast() {
  io.emit('state-changed');
}

// ---------- Login (optional OAuth) ----------
app.get('/api/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.json({ loggedIn: false, providers: enabledProviderList() });
  res.json({
    loggedIn: true,
    user: { id: user.id, name: user.name, email: user.email, provider: user.provider },
    favorites: user.favorites || [],
    providers: enabledProviderList(),
  });
});

// Registered before the /auth/:provider wildcard below, otherwise Express
// would match "logout" as a provider name and this route would never run.
app.get('/auth/logout', (req, res) => {
  clearCookie(req, res, SESSION_COOKIE);
  const from = typeof req.query.from === 'string' && req.query.from.startsWith('/') ? req.query.from : '/index.html';
  res.redirect(from);
});

app.get('/auth/:provider', (req, res) => {
  const p = OAUTH_PROVIDERS[req.params.provider];
  if (!p || !p.enabled()) {
    return res.status(404).send('ผู้ให้บริการเข้าสู่ระบบนี้ยังไม่ได้ตั้งค่าไว้');
  }
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${APP_BASE_URL}/auth/${req.params.provider}/callback`;
  const from = typeof req.query.from === 'string' && req.query.from.startsWith('/') ? req.query.from : '/favorites.html';
  const stateToken = signToken({ state, from, exp: Date.now() + 10 * 60 * 1000 });
  setCookie(req, res, OAUTH_STATE_COOKIE, stateToken, 600);
  const params = new URLSearchParams({
    client_id: p.clientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: p.scope,
    state,
  });
  res.redirect(`${p.authUrl()}?${params.toString()}`);
});

app.get('/auth/:provider/callback', async (req, res) => {
  const providerName = req.params.provider;
  const p = OAUTH_PROVIDERS[providerName];
  if (!p || !p.enabled()) {
    return res.status(404).send('ผู้ให้บริการเข้าสู่ระบบนี้ยังไม่ได้ตั้งค่าไว้');
  }
  const stateData = verifyToken(parseCookies(req)[OAUTH_STATE_COOKIE]);
  clearCookie(req, res, OAUTH_STATE_COOKIE);
  if (!stateData || stateData.state !== req.query.state) {
    return res.status(400).send('เซสชันเข้าสู่ระบบไม่ถูกต้องหรือหมดอายุ กรุณาลองเข้าสู่ระบบใหม่');
  }
  if (req.query.error) {
    return res.redirect(`/login.html?error=${encodeURIComponent(req.query.error_description || req.query.error)}`);
  }
  const redirectUri = `${APP_BASE_URL}/auth/${providerName}/callback`;
  try {
    const tokenRes = await fetch(p.tokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(req.query.code || ''),
        redirect_uri: redirectUri,
        client_id: p.clientId(),
        client_secret: p.clientSecret(),
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(tokenJson.error_description || tokenJson.error || 'token exchange failed');
    }

    let profile;
    if (providerName === 'line') {
      const profRes = await fetch('https://api.line.me/v2/profile', {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      const profJson = await profRes.json();
      profile = { providerUserId: profJson.userId, name: profJson.displayName || '', email: '' };
    } else {
      // Microsoft & Google both return an OIDC id_token carrying the profile claims
      const claims = decodeIdTokenClaims(tokenJson.id_token);
      profile = {
        providerUserId: claims.sub || '',
        name: claims.name || claims.preferred_username || '',
        email: claims.email || claims.preferred_username || '',
      };
    }
    if (!profile.providerUserId) throw new Error('no profile id returned');

    const user = findOrCreateUser({ provider: providerName, ...profile });
    const token = signToken({ uid: user.id, exp: Date.now() + SESSION_MAX_AGE_MS });
    setCookie(req, res, SESSION_COOKIE, token, Math.floor(SESSION_MAX_AGE_MS / 1000));
    res.redirect(stateData.from || '/favorites.html');
  } catch (e) {
    console.error('OAuth callback error (%s):', providerName, e.message);
    res.redirect(`/login.html?error=${encodeURIComponent('เข้าสู่ระบบไม่สำเร็จ ลองใหม่อีกครั้ง')}`);
  }
});

// ---------- Favourite List (requires login) ----------
// A favourite is just a saved song idea (title/artist/chord) a person picks
// ahead of time — separate from db.songs until they actually request it.
app.post('/api/favorites', requireLogin, (req, res) => {
  const { title, artist, chordUrl, chordId } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'ต้องระบุชื่อเพลง' });
  const verifiedUrl = chordUrl && isDochordUrl(chordUrl) ? String(chordUrl).trim() : '';
  const pendingId = !verifiedUrl && chordId ? String(chordId).trim().replace(/\D/g, '') : '';
  const finalChordId = verifiedUrl ? extractChordId(verifiedUrl) : pendingId;
  const fav = {
    id: newId(),
    title: String(title).trim(),
    artist: (artist || '').trim(),
    chordUrl: verifiedUrl,
    chordId: finalChordId,
    addedAt: Date.now(),
  };
  req.user.favorites = req.user.favorites || [];
  req.user.favorites.push(fav);
  saveDb();
  res.json({ ok: true, favorites: req.user.favorites });
});

// Fix a typo in your own favourite (title/artist/chord) — favourites have
// no admin-lock like Request List entries do, since they're private to you.
app.post('/api/favorites/:favId/edit', requireLogin, (req, res) => {
  const fav = (req.user.favorites || []).find((f) => f.id === req.params.favId);
  if (!fav) return res.status(404).json({ error: 'ไม่พบเพลงโปรดนี้' });
  const { title, artist, chordUrl, chordId } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'ต้องระบุชื่อเพลง' });
  const verifiedUrl = chordUrl && isDochordUrl(chordUrl) ? String(chordUrl).trim() : '';
  const pendingId = !verifiedUrl && chordId ? String(chordId).trim().replace(/\D/g, '') : '';
  const finalChordId = verifiedUrl ? extractChordId(verifiedUrl) : pendingId;
  fav.title = String(title).trim();
  fav.artist = (artist || '').trim();
  fav.chordUrl = verifiedUrl;
  fav.chordId = finalChordId;
  saveDb();
  res.json({ ok: true, favorites: req.user.favorites });
});

app.post('/api/favorites/:favId/remove', requireLogin, (req, res) => {
  req.user.favorites = (req.user.favorites || []).filter((f) => f.id !== req.params.favId);
  saveDb();
  res.json({ ok: true, favorites: req.user.favorites });
});

// Lets a person drag/​reorder their own Favourite List into whatever order
// they personally prefer. `order` is the full list of favourite IDs in the
// new order; anything not in it (shouldn't normally happen) is dropped to
// the end so nothing silently disappears.
app.post('/api/favorites/reorder', requireLogin, (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order ต้องเป็น array' });
  const current = req.user.favorites || [];
  const byId = new Map(current.map((f) => [f.id, f]));
  const reordered = order.filter((id) => byId.has(id)).map((id) => byId.get(id));
  current.forEach((f) => { if (!order.includes(f.id)) reordered.push(f); });
  req.user.favorites = reordered;
  saveDb();
  res.json({ ok: true, favorites: req.user.favorites });
});

// Import a previously exported Favourite List backup (the "Backup" button
// on favorites.html downloads the matching JSON). mode 'merge' adds any
// backup items not already present (matched by title+artist, case-
// insensitive) onto the end of the current list without touching what's
// already there; mode 'replace' discards the current list entirely and
// uses only what's in the backup. Malformed entries in the file (no title)
// are silently skipped rather than failing the whole import.
app.post('/api/favorites/import', requireLogin, (req, res) => {
  const { favorites, mode } = req.body || {};
  if (!Array.isArray(favorites)) return res.status(400).json({ error: 'ไฟล์ไม่ถูกต้อง (ไม่พบรายการเพลงโปรด)' });
  if (mode !== 'merge' && mode !== 'replace') return res.status(400).json({ error: 'mode ต้องเป็น merge หรือ replace' });

  const cleaned = [];
  for (const item of favorites) {
    const title = item && item.title ? String(item.title).trim() : '';
    if (!title) continue;
    const chordUrlIn = item.chordUrl;
    const chordIdIn = item.chordId;
    const verifiedUrl = chordUrlIn && isDochordUrl(chordUrlIn) ? String(chordUrlIn).trim() : '';
    const pendingId = !verifiedUrl && chordIdIn ? String(chordIdIn).trim().replace(/\D/g, '') : '';
    const finalChordId = verifiedUrl ? extractChordId(verifiedUrl) : pendingId;
    cleaned.push({
      id: newId(),
      title,
      artist: (item.artist || '').trim(),
      chordUrl: verifiedUrl,
      chordId: finalChordId,
      addedAt: Date.now(),
    });
  }
  if (!cleaned.length) return res.status(400).json({ error: 'ไม่พบเพลงโปรดที่ใช้ได้ในไฟล์นี้' });

  req.user.favorites = req.user.favorites || [];
  let addedCount = cleaned.length;
  if (mode === 'replace') {
    req.user.favorites = cleaned;
  } else {
    addedCount = 0;
    const keyOf = (f) => (f.title + '|' + f.artist).toLowerCase();
    const existingKeys = new Set(req.user.favorites.map(keyOf));
    cleaned.forEach((f) => {
      const key = keyOf(f);
      if (!existingKeys.has(key)) { req.user.favorites.push(f); existingKeys.add(key); addedCount++; }
    });
  }
  saveDb();
  res.json({ ok: true, favorites: req.user.favorites, imported: addedCount });
});

// Turns a saved favourite into a real, live Request List entry — same
// duplicate-chordId guard as adding a song normally applies.
app.post('/api/favorites/:favId/request', requireLogin, (req, res) => {
  const fav = (req.user.favorites || []).find((f) => f.id === req.params.favId);
  if (!fav) return res.status(404).json({ error: 'ไม่พบเพลงโปรดนี้' });
  const { clientId, voteType, targetName, voterName, eventId, confirmReplay } = req.body || {};
  if (!eventId || !findEvent(eventId)) {
    return res.status(400).json({ error: 'ไม่พบ Event นี้ กรุณาเลือก Event ก่อน' });
  }
  if (fav.chordId) {
    const dup = db.songs.find((s) => s.eventId === eventId && s.chordId && s.chordId === fav.chordId);
    if (dup) {
      const dupPlayed = !!db.nextShow.find((i) => i.songId === dup.id && i.played);
      if (dupPlayed && !confirmReplay) {
        return res.status(409).json({
          error: 'เพลงนี้เล่นไปแล้ว',
          alreadyPlayed: true,
          existing: { id: dup.id, title: dup.title, artist: dup.artist || '', requestedBy: dup.requestedBy || '', chordId: dup.chordId || '' },
        });
      }
      if (!dupPlayed) {
        return res.status(409).json({
          error: 'มีคนขอเพลงนี้ไปแล้ว',
          existing: { id: dup.id, title: dup.title, artist: dup.artist || '', requestedBy: dup.requestedBy || '', chordId: dup.chordId || '' },
        });
      }
    }
  }
  const requesterName = (voterName || req.user.name || '').trim();
  const song = {
    id: newId(),
    eventId,
    title: fav.title,
    artist: fav.artist || '',
    requestedBy: requesterName,
    chordUrl: fav.chordUrl || '',
    chordId: fav.chordId || '',
    adminStatus: 'unchecked',
    createdAt: Date.now(),
    votes: emptyVotes(),
    musicianResponses: {},
  };
  if (clientId && VOTE_TYPES.includes(voteType)) {
    song.votes[voteType].push({ clientId, name: requesterName, targetName: targetName || '' });
  }
  db.songs.push(song);
  saveDb();
  broadcast();
  res.json({ ok: true, song: publicSong(song) });
});

// ---------- Events ----------
// A "live event" (one outing/gig). Request List / Next Show List are always
// scoped to one event, via ?eventId= on reads or eventId in the body on
// writes. Favourites are intentionally NOT scoped to an event — they're
// personal and can be prepared before any specific event is picked.
app.get('/api/events', (req, res) => {
  // Earliest-created first, so the event list reads top-to-bottom in the
  // order the events were set up.
  res.json({ events: [...db.events].sort((a, b) => a.createdAt - b.createdAt).map(publicEvent) });
});

function readEventFields(body) {
  const { name, date, timeFrom, timeTo, location, mapsUrl, description, contactName, contactEmail, contactMobile } = body || {};
  return {
    name: (name || '').trim(),
    date: (date || '').trim(),
    timeFrom: (timeFrom || '').trim(),
    timeTo: (timeTo || '').trim(),
    location: (location || '').trim(),
    mapsUrl: (mapsUrl || '').trim(),
    description: (description || '').trim(),
    contactName: (contactName || '').trim(),
    contactEmail: (contactEmail || '').trim(),
    contactMobile: (contactMobile || '').trim(),
  };
}

app.post('/api/admin/events', checkPin, (req, res) => {
  const fields = readEventFields(req.body);
  if (!fields.name) return res.status(400).json({ error: 'ต้องระบุชื่อ Event' });
  const event = { id: newId(), ...fields, createdAt: Date.now() };
  db.events.push(event);
  saveDb();
  broadcast();
  res.json({ ok: true, event: publicEvent(event) });
});

app.post('/api/admin/events/:id/edit', checkPin, (req, res) => {
  const event = findEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'ไม่พบ Event นี้' });
  const fields = readEventFields(req.body);
  if (!fields.name) return res.status(400).json({ error: 'ต้องระบุชื่อ Event' });
  Object.assign(event, fields);
  saveDb();
  broadcast();
  res.json({ ok: true, event: publicEvent(event) });
});

// Permanently deletes an event AND every song request / show-queue entry
// that belongs to it. Favourites are untouched (they aren't tied to an
// event). PIN-gated same as everything else here — the frontend also makes
// the person re-enter the PIN as an extra confirmation step before calling
// this, since it's irreversible.
app.post('/api/admin/events/:id/delete', checkPin, (req, res) => {
  const event = findEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'ไม่พบ Event นี้' });
  const removeIds = new Set(db.songs.filter((s) => s.eventId === event.id).map((s) => s.id));
  db.songs = db.songs.filter((s) => s.eventId !== event.id);
  db.nextShow = db.nextShow.filter((item) => !removeIds.has(item.songId));
  db.events = db.events.filter((e) => e.id !== event.id);
  saveDb();
  broadcast();
  res.json({ ok: true });
});

// ---------- Public API ----------
app.get('/api/state', (req, res) => {
  const event = req.query.eventId && findEvent(req.query.eventId);
  if (!event) return res.status(404).json({ error: 'ไม่พบ Event นี้ กรุณาเลือก Event ใหม่' });
  res.json({ event: publicEvent(event), ...fullState(event.id) });
});

// Look up a pasted dochord.com song link server-side: confirms it's real and
// returns the official title/artist straight from dochord's own page metadata.
app.post('/api/chord-lookup', async (req, res) => {
  const { url, chordId } = req.body || {};
  const input = (url && String(url).trim()) || (chordId && String(chordId).trim());
  if (!input) {
    return res.status(400).json({ error: 'ต้องใส่ลิงก์หรือหมายเลขเพลงจาก dochord' });
  }
  const target = buildDochordUrl(input);
  if (!target) {
    return res.status(400).json({ error: 'รูปแบบไม่ถูกต้อง ต้องเป็นลิงก์ dochord.com หรือตัวเลขหมายเลขเพลง' });
  }
  const resolvedId = extractChordId(target);
  try {
    const html = await fetchHtml(target);
    const title = extractMeta(html, 'wa-title') || extractMeta(html, 'og:title');
    const artist = extractMeta(html, 'wa-artist');
    if (!title) {
      return res.status(404).json({ error: 'หาข้อมูลเพลงจากหมายเลข/ลิงก์นี้ไม่เจอ', chordId: resolvedId, chordUrl: target });
    }
    res.json({
      ok: true,
      title: decodeEntities(title),
      artist: decodeEntities(artist || ''),
      chordUrl: target,
      chordId: resolvedId,
    });
  } catch (e) {
    res.status(502).json({
      error: 'ตรวจสอบอัตโนมัติไม่สำเร็จตอนนี้ (เครือข่ายเซิร์ฟเวอร์อาจถูก dochord บล็อกชั่วคราว) — บันทึกหมายเลขไว้ก่อนได้ ทีมงานจะช่วยยืนยันทีหลัง',
      chordId: resolvedId,
      chordUrl: target,
    });
  }
});

// Add a new song request (with an optional initial vote from the requester).
// chordUrl = already server-verified link. chordId = unverified number the
// guest typed in, kept so admin can verify/fill it in later.
app.post('/api/songs', (req, res) => {
  const { title, artist, requestedBy, clientId, voteType, targetName, voterName, chordUrl, chordId, eventId, confirmReplay } = req.body || {};
  if (!eventId || !findEvent(eventId)) {
    return res.status(400).json({ error: 'ไม่พบ Event นี้ กรุณาเลือก Event ใหม่' });
  }
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'ต้องระบุชื่อเพลง' });
  }
  const verifiedUrl = chordUrl && isDochordUrl(chordUrl) ? String(chordUrl).trim() : '';
  const pendingId = !verifiedUrl && chordId ? String(chordId).trim().replace(/\D/g, '') : '';
  const newChordId = verifiedUrl ? extractChordId(verifiedUrl) : pendingId;

  // Block duplicate requests when the same dochord song number was already
  // submitted for this same event (the same song can be requested again for
  // a different event without tripping this guard).
  if (newChordId) {
    const dup = db.songs.find((s) => s.eventId === eventId && s.chordId && s.chordId === newChordId);
    if (dup) {
      const dupPlayed = !!db.nextShow.find((i) => i.songId === dup.id && i.played);
      // If the matching song was already performed, don't hard-block like a
      // normal duplicate — ask the guest to confirm they really want to
      // request it again (encore) before creating a fresh entry.
      if (dupPlayed && !confirmReplay) {
        return res.status(409).json({
          error: 'เพลงนี้เล่นไปแล้ว',
          alreadyPlayed: true,
          existing: {
            id: dup.id,
            title: dup.title,
            artist: dup.artist || '',
            requestedBy: dup.requestedBy || '',
            chordId: dup.chordId || '',
          },
        });
      }
      if (!dupPlayed) {
        return res.status(409).json({
          error: 'มีคนขอเพลงนี้ไปแล้ว',
          existing: {
            id: dup.id,
            title: dup.title,
            artist: dup.artist || '',
            requestedBy: dup.requestedBy || '',
            chordId: dup.chordId || '',
          },
        });
      }
      // else: dupPlayed && confirmReplay — fall through and create a fresh
      // request entry (encore), leaving the old played entry untouched.
    }
  }

  const song = {
    id: newId(),
    eventId,
    title: String(title).trim(),
    artist: (artist || '').trim(),
    requestedBy: (requestedBy || '').trim(),
    chordUrl: verifiedUrl,
    chordId: newChordId,
    adminStatus: 'unchecked',
    createdAt: Date.now(),
    votes: emptyVotes(),
    musicianResponses: {},
  };
  if (clientId && VOTE_TYPES.includes(voteType)) {
    const name = (voterName || requestedBy || '').trim();
    song.votes[voteType].push({ clientId, name, targetName: targetName || '' });
  }
  db.songs.push(song);
  saveDb();
  broadcast();
  res.json({ ok: true, song: publicSong(song) });
});

// Vote (or change vote) on an existing song
app.post('/api/songs/:id/vote', (req, res) => {
  const song = findSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'ไม่พบเพลงนี้' });
  const { clientId, voteType, targetName, voterName } = req.body || {};
  if (!clientId) return res.status(400).json({ error: 'ขาด clientId' });
  clearVote(song, clientId);
  if (voteType && VOTE_TYPES.includes(voteType)) {
    song.votes[voteType].push({ clientId, name: (voterName || '').trim(), targetName: targetName || '' });
  }
  saveDb();
  broadcast();
  res.json({ ok: true, song: publicSong(song) });
});

// Guests can remove their own mistaken/changed-mind request, but only while
// it hasn't gathered much interest yet — past the threshold, only admin can.
app.post('/api/songs/:id/self-delete', (req, res) => {
  const song = findSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'ไม่พบเพลงนี้' });
  const interested = song.votes.want.length + song.votes.singMyself.length;
  if (interested > SELF_DELETE_VOTE_LIMIT) {
    return res.status(403).json({
      error: `เพลงที่มีคนอยากฟังหรืออยากร้องเกิน ${SELF_DELETE_VOTE_LIMIT} คนแล้ว ลบเองไม่ได้ ต้องแจ้งให้ admin เป็นคนลบ`,
    });
  }
  db.songs = db.songs.filter((s) => s.id !== req.params.id);
  db.nextShow = db.nextShow.filter((i) => i.songId !== req.params.id);
  saveDb();
  broadcast();
  res.json({ ok: true });
});

// Guests can fix a typo/mistake in their own request (title/artist/chord),
// but once admin has verified ("ตรวจสอบแล้ว") the entry it's locked — only
// admin can change it from that point on.
app.post('/api/songs/:id/edit', (req, res) => {
  const song = findSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'ไม่พบเพลงนี้' });
  if (song.adminStatus === 'checked') {
    return res.status(403).json({
      error: 'Admin แก้ไขแล้ว ตอนนี้ไม่สามารถแก้ไขได้ด้วยตนเองได้ ถ้าต้องการแก้ไข ให้แจ้ง Admin',
    });
  }
  const { title, artist, chordUrl, chordId } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'ต้องระบุชื่อเพลง' });
  }
  const verifiedUrl = chordUrl && isDochordUrl(chordUrl) ? String(chordUrl).trim() : '';
  const pendingId = !verifiedUrl && chordId ? String(chordId).trim().replace(/\D/g, '') : '';
  const newChordId = verifiedUrl ? extractChordId(verifiedUrl) : pendingId;

  if (newChordId) {
    const dup = db.songs.find((s) => s.id !== song.id && s.eventId === song.eventId && s.chordId && s.chordId === newChordId);
    if (dup) {
      return res.status(409).json({
        error: 'มีคนขอเพลงนี้ไปแล้ว',
        existing: {
          id: dup.id,
          title: dup.title,
          artist: dup.artist || '',
          requestedBy: dup.requestedBy || '',
          chordId: dup.chordId || '',
        },
      });
    }
  }

  song.title = String(title).trim();
  song.artist = (artist || '').trim();
  song.chordUrl = verifiedUrl;
  song.chordId = newChordId;
  if (song.adminStatus === 'wrong') song.adminStatus = 'unchecked';
  saveDb();
  broadcast();
  res.json({ ok: true, song: publicSong(song) });
});

// Musician quick response (with optional role e.g. guitar/drums/vocals)
app.post('/api/songs/:id/musician-response', (req, res) => {
  const song = findSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'ไม่พบเพลงนี้' });
  const { musicianName, level, role } = req.body || {};
  if (!musicianName || !String(musicianName).trim()) {
    return res.status(400).json({ error: 'ต้องระบุชื่อนักดนตรี' });
  }
  if (!MUSICIAN_LEVELS.includes(level)) {
    return res.status(400).json({ error: 'ค่าการตอบรับไม่ถูกต้อง' });
  }
  if (!song.musicianResponses) song.musicianResponses = {};
  song.musicianResponses[String(musicianName).trim()] = { level, role: (role || '').trim() };
  saveDb();
  broadcast();
  res.json({ ok: true, song: publicSong(song) });
});

// ---------- Admin API (PIN protected) ----------
function checkPin(req, res, next) {
  const pin = (req.body && req.body.pin) || req.query.pin || req.headers['x-admin-pin'];
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'PIN ไม่ถูกต้อง' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { pin } = req.body || {};
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'PIN ไม่ถูกต้อง' });
  res.json({ ok: true });
});

// Replace the Next Show List order (array of songIds) for one event — admin
// curates manually. Other events' queue entries are left untouched.
app.post('/api/admin/next-show', checkPin, (req, res) => {
  const { order, eventId } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order ต้องเป็น array' });
  if (!eventId || !findEvent(eventId)) return res.status(400).json({ error: 'ไม่พบ Event นี้' });
  const existingPlayed = {};
  db.nextShow.forEach((item) => (existingPlayed[item.songId] = item.played));
  const otherEventItems = db.nextShow.filter((item) => {
    const s = findSong(item.songId);
    return !s || s.eventId !== eventId;
  });
  const thisEventItems = order
    .filter((songId) => {
      const s = findSong(songId);
      return s && s.eventId === eventId;
    })
    .map((songId) => ({ songId, played: existingPlayed[songId] || false }));
  db.nextShow = otherEventItems.concat(thisEventItems);
  saveDb();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/admin/next-show/add', checkPin, (req, res) => {
  const { songId } = req.body || {};
  if (!findSong(songId)) return res.status(404).json({ error: 'ไม่พบเพลงนี้' });
  if (!db.nextShow.find((i) => i.songId === songId)) {
    db.nextShow.push({ songId, played: false });
  }
  saveDb();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/admin/next-show/remove', checkPin, (req, res) => {
  const { songId } = req.body || {};
  db.nextShow = db.nextShow.filter((i) => i.songId !== songId);
  saveDb();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/admin/next-show/played', checkPin, (req, res) => {
  const { songId, played } = req.body || {};
  const item = db.nextShow.find((i) => i.songId === songId);
  if (item) item.played = !!played;
  saveDb();
  broadcast();
  res.json({ ok: true });
});

// ---------- Special Tool: bulk-clear actions ----------
// All three are scoped to one event (eventId required in body) — other
// events' Request List / Next Show List data is left completely untouched.

// Clearing the Next Show List only empties the curated queue — the
// underlying song requests stay in the pool and can be re-added later.
app.post('/api/admin/next-show/clear-all', checkPin, (req, res) => {
  const { eventId } = req.body || {};
  if (!eventId || !findEvent(eventId)) return res.status(400).json({ error: 'ไม่พบ Event นี้' });
  db.nextShow = db.nextShow.filter((item) => {
    const s = findSong(item.songId);
    return !s || s.eventId !== eventId;
  });
  saveDb();
  broadcast();
  res.json({ ok: true });
});

// Clearing the Request List removes every song request in this event
// unconditionally. A song still queued in Next Show List can't be left
// behind half-deleted (that previously left an orphaned record that
// silently blocked re-adding the same chordId later as a "duplicate") — so
// this also clears this event's show queue entries.
app.post('/api/admin/songs/clear-all', checkPin, (req, res) => {
  const { eventId } = req.body || {};
  if (!eventId || !findEvent(eventId)) return res.status(400).json({ error: 'ไม่พบ Event นี้' });
  const removeIds = new Set(db.songs.filter((s) => s.eventId === eventId).map((s) => s.id));
  db.songs = db.songs.filter((s) => s.eventId !== eventId);
  db.nextShow = db.nextShow.filter((item) => !removeIds.has(item.songId));
  saveDb();
  broadcast();
  res.json({ ok: true });
});

// Full reset for one event — wipes both its request pool and show queue.
app.post('/api/admin/reset-stage', checkPin, (req, res) => {
  const { eventId } = req.body || {};
  if (!eventId || !findEvent(eventId)) return res.status(400).json({ error: 'ไม่พบ Event นี้' });
  const removeIds = new Set(db.songs.filter((s) => s.eventId === eventId).map((s) => s.id));
  db.songs = db.songs.filter((s) => s.eventId !== eventId);
  db.nextShow = db.nextShow.filter((item) => !removeIds.has(item.songId));
  saveDb();
  broadcast();
  res.json({ ok: true });
});

// Admin can retry auto-verification, or manually type in the confirmed
// title/artist/link for a song that came in with only a pending chord ID.
app.post('/api/admin/songs/:id/verify-chord', checkPin, async (req, res) => {
  const song = findSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'ไม่พบเพลงนี้' });
  const { retry, title, artist, chordUrl } = req.body || {};

  if (retry) {
    const target = buildDochordUrl(song.chordId || song.chordUrl);
    if (!target) return res.status(400).json({ error: 'ไม่มีหมายเลข/ลิงก์ dochord ให้ตรวจสอบ' });
    try {
      const html = await fetchHtml(target);
      const t = extractMeta(html, 'wa-title') || extractMeta(html, 'og:title');
      const a = extractMeta(html, 'wa-artist');
      if (!t) return res.status(404).json({ error: 'ยังหาข้อมูลเพลงจาก dochord ไม่เจอ' });
      song.chordUrl = target;
      song.chordId = extractChordId(target);
      song.title = decodeEntities(t);
      song.artist = decodeEntities(a || '');
      song.adminStatus = 'checked';
      saveDb();
      broadcast();
      return res.json({ ok: true, song: publicSong(song) });
    } catch (e) {
      return res.status(502).json({ error: 'เชื่อมต่อ dochord.com ไม่สำเร็จ ลองใหม่อีกครั้ง' });
    }
  }

  // Manual override by admin — this is the "ตรวจสอบแล้ว และบันทึก" action
  if (chordUrl) {
    if (!isDochordUrl(chordUrl)) return res.status(400).json({ error: 'ลิงก์ต้องเป็นของ dochord.com เท่านั้น' });
    song.chordUrl = String(chordUrl).trim();
    song.chordId = extractChordId(song.chordUrl);
  }
  if (title !== undefined && String(title).trim()) song.title = String(title).trim();
  if (artist !== undefined) song.artist = String(artist).trim();
  song.adminStatus = 'checked';
  saveDb();
  broadcast();
  res.json({ ok: true, song: publicSong(song) });
});

// Toggle a song's manual review status: unchecked / checked / wrong
app.post('/api/admin/songs/:id/status', checkPin, (req, res) => {
  const song = findSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'ไม่พบเพลงนี้' });
  const { status } = req.body || {};
  if (!['unchecked', 'checked', 'wrong'].includes(status)) {
    return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
  }
  song.adminStatus = status;
  saveDb();
  broadcast();
  res.json({ ok: true, song: publicSong(song) });
});

app.post('/api/admin/songs/:id/delete', checkPin, (req, res) => {
  db.songs = db.songs.filter((s) => s.id !== req.params.id);
  db.nextShow = db.nextShow.filter((i) => i.songId !== req.params.id);
  saveDb();
  broadcast();
  res.json({ ok: true });
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  socket.emit('state-changed');
});

server.listen(PORT, () => {
  console.log(`ZG Live Jam server running on port ${PORT}`);
  console.log(`Admin PIN: ${ADMIN_PIN}`);
});
