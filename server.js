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
if (!db.inbox) db.inbox = [];
if (!db.roles) db.roles = {}; // employeeId -> { musician: bool, djadmin: bool }
// One-time tidy-up: older versions stored "ไม่ระบุ" as if it were an answer.
// It now means "clear my answer", so drop any leftovers.
(db.songs || []).forEach((sg) => {
  Object.keys(sg.musicianResponses || {}).forEach((name) => {
    const r = sg.musicianResponses[name];
    if ((r && r.level === 'ไม่ระบุ') || r === 'ไม่ระบุ') delete sg.musicianResponses[name];
  });
});

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

// Events belong to one mode of the app: 'any' (Any Event) or 'zygen'
// (ZyGen Event). Events created before modes existed have no scope and are
// treated as ZyGen events (that's what they were all used for).
function eventScope(e) {
  return e && e.scope === 'any' ? 'any' : 'zygen';
}

// 'approve' (default, original behaviour): requests wait in the Request List
// for admin to curate the Next Show List. 'open': every request goes straight
// into the Next Show List and anyone can reorder / remove / mark played.
function eventMode(e) { return e && e.mode === 'open' ? 'open' : 'approve'; }
// 'open' (default) = a live / upcoming event people take part in;
// 'history' = finished event kept for looking back (nothing can be added).
function eventStatus(e) { return e && e.status === 'history' ? 'history' : 'open'; }
const HISTORY_MSG = 'Event นี้เป็นประวัติ (History) ดูย้อนหลังได้อย่างเดียว ไม่สามารถเพิ่มหรือแก้ไขเพลงได้';
// For public song routes /api/songs/:id/… — refuse when the song's event is history.
function blockHistorySong(req, res, next) {
  const sg = findSong(req.params.id);
  const ev = sg && findEvent(sg.eventId);
  if (ev && eventStatus(ev) === 'history') return res.status(403).json({ error: HISTORY_MSG, history: true });
  next();
}

function publicEvent(e) {
  return {
    id: e.id,
    name: e.name,
    scope: eventScope(e),
    mode: eventMode(e),
    status: eventStatus(e),
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
    live: publicLive(e),
  };
}

// Live Broadcast link (set on the Live Broadcast page). Only http(s) URLs are
// accepted so a stored value can never be a javascript: link.
function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, n)) : dflt;
}
function publicLive(e) {
  const l = e.live || {};
  return {
    on: !!(l.on && l.url), url: l.url || '', label: l.label || '',
    chatMaxLen: clampInt(l.chatMaxLen, 10, 1000, 200),       // max characters per chat message
    chatIntervalSec: clampNum(l.chatIntervalSec, 0, 60, 1),  // min seconds between one person's messages
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
    if (level !== 'ไม่ระบุ' && summary[level] !== undefined) summary[level]++;
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
    const e = entry && typeof entry === 'object' ? entry : { level: entry, role: '' };
    if (e.level === 'ไม่ระบุ') return; // "ไม่ระบุ" means no answer — never shown
    musicianResponses[name] = e;
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

function findOrCreateUser({ provider, providerUserId, name, email, altEmails }) {
  let user = db.users.find((u) => u.provider === provider && u.providerUserId === providerUserId);
  if (!user) {
    user = { id: newId(), provider, providerUserId, name: name || '', email: email || '', favorites: [], createdAt: Date.now() };
    db.users.push(user);
  } else {
    if (name) user.name = name;
    if (email) user.email = email;
    if (!user.favorites) user.favorites = [];
  }
  if (Array.isArray(altEmails) && altEmails.length) user.altEmails = altEmails;
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
// Bare "/" (e.g. what the QR code links to) is the cover page where people
// pick Any Event / ZyGen Event. Must be registered BEFORE express.static,
// otherwise static would serve index.html (the Request List) for "/" first.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});
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
    user: { id: user.id, name: user.name, email: user.email, altEmails: user.altEmails || [], provider: user.provider },
    favorites: user.favorites || [],
    playlists: userPlaylists(user),
    roles: userRoles(user),
    employeeDisplayName: employeeDisplayNameFor(user),
    providers: enabledProviderList(),
  });
});

// ---------- Spotify playlist generator ----------
// One shared Spotify account (a Premium one, connected once by the Super Admin)
// creates playlists for people's public ZG Live Jam playlists. The resulting
// link is stored on that playlist and shown to everyone on the Public Playlist
// page. Nobody else needs to log in to Spotify. Registered before /auth/:provider.
const SPOTIFY_ID = () => process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_SECRET = () => process.env.SPOTIFY_CLIENT_SECRET;
// Spotify only accepts https or http://127.0.0.1 while Microsoft login wants http://localhost,
// so locally the callback can live on a different host (SPOTIFY_REDIRECT_URI) than APP_BASE_URL.
const SPOTIFY_REDIRECT = () => process.env.SPOTIFY_REDIRECT_URI || `${APP_BASE_URL}/auth/spotify/callback`;
const SPOTIFY_SCOPE = 'playlist-modify-public playlist-modify-private';
const spotifyConfigured = () => !!(SPOTIFY_ID() && SPOTIFY_SECRET());
let spotifyAccess = { token: '', exp: 0 };

async function spotifyTokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(SPOTIFY_ID() + ':' + SPOTIFY_SECRET()).toString('base64'),
    },
    body: new URLSearchParams(params).toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error_description || d.error || 'Spotify token error');
  return d;
}
async function spotifyAccessToken() {
  if (spotifyAccess.token && Date.now() < spotifyAccess.exp - 30000) return spotifyAccess.token;
  if (!db.spotify || !db.spotify.refreshToken) throw new Error('ยังไม่ได้เชื่อมต่อ Spotify (Super Admin ต้องกด Connect Spotify ก่อน)');
  const d = await spotifyTokenRequest({ grant_type: 'refresh_token', refresh_token: db.spotify.refreshToken });
  if (d.refresh_token) { db.spotify.refreshToken = d.refresh_token; saveDb(); }
  spotifyAccess = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return spotifyAccess.token;
}
async function spotifyApi(method, path, body) {
  const token = await spotifyAccessToken();
  const r = await fetch('https://api.spotify.com/v1' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((d.error && d.error.message) || ('Spotify error ' + r.status));
    e.status = r.status; throw e;
  }
  return d;
}

app.get('/auth/spotify/connect', (req, res) => {
  if (!reqRoles(req).superadmin) return res.status(403).send('ต้องเป็น Super Admin');
  if (!spotifyConfigured()) return res.status(404).send('ยังไม่ได้ตั้งค่า SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET ใน .env');
  // The state is a signed, short-lived token (issued only to a Super Admin), so the callback
  // needs no cookie — it may arrive on another host (127.0.0.1) than the login (localhost).
  const state = signToken({ spotify: true, exp: Date.now() + 10 * 60 * 1000 });
  res.redirect('https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: SPOTIFY_ID(), response_type: 'code', redirect_uri: SPOTIFY_REDIRECT(), scope: SPOTIFY_SCOPE, state,
  }).toString());
});

app.get('/auth/spotify/callback', async (req, res) => {
  try {
    const sd = verifyToken(String(req.query.state || ''));
    if (!sd || !sd.spotify || !req.query.code) throw new Error('state ไม่ถูกต้อง / ถูกปฏิเสธ ลองใหม่อีกครั้ง');
    const d = await spotifyTokenRequest({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: SPOTIFY_REDIRECT() });
    db.spotify = { refreshToken: d.refresh_token, connectedAt: Date.now() };
    spotifyAccess = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
    try {
      const me = await spotifyApi('GET', '/me');
      db.spotify.userName = me.display_name || me.id; db.spotify.userUrl = (me.external_urls && me.external_urls.spotify) || '';
    } catch (e) { /* name is optional */ }
    saveDb();
    res.redirect(`${APP_BASE_URL}/spotify.html?connected=1`);
  } catch (e) {
    res.status(400).send('เชื่อมต่อ Spotify ไม่สำเร็จ: ' + String(e.message || e));
  }
});

app.get('/api/spotify/status', requireDjAdminRole, (req, res) => {
  res.json({
    configured: spotifyConfigured(), connected: !!(db.spotify && db.spotify.refreshToken),
    accountName: (db.spotify && db.spotify.userName) || '', superadmin: !!reqRoles(req).superadmin,
    redirectUri: SPOTIFY_REDIRECT(),
  });
});

// Every public playlist of every user (for the admin to pick from).
app.get('/api/spotify/playlists', requireDjAdminRole, (req, res) => {
  const out = [];
  db.users.forEach((u) => {
    userPlaylists(u).filter((p) => p.visibility === 'public' && p.songIds.length).forEach((p) => {
      out.push({ uid: u.id, pid: p.id, ownerName: ownerDisplayName(u), name: p.name, songCount: p.songIds.length, spotifyUrl: p.spotifyUrl || '' });
    });
  });
  out.sort((a, b) => a.ownerName.localeCompare(b.ownerName, 'th') || a.name.localeCompare(b.name, 'th'));
  res.json({ playlists: out });
});

function spotifyCandidate(t) {
  return {
    uri: t.uri, name: t.name, artists: (t.artists || []).map((a) => a.name).join(', '),
    album: (t.album && t.album.name) || '', image: (t.album && t.album.images && t.album.images.length ? t.album.images[t.album.images.length - 1].url : ''),
    url: (t.external_urls && t.external_urls.spotify) || '',
  };
}
async function spotifySearchSong(title, artist) {
  const clean = (s) => String(s || '').replace(/["“”]/g, ' ').trim();
  const tries = [];
  if (artist) tries.push(`track:${clean(title)} artist:${clean(artist)}`);
  tries.push(`${clean(title)} ${clean(artist)}`.trim());
  for (const q of tries) {
    const d = await spotifyApi('GET', '/search?' + new URLSearchParams({ q, type: 'track', limit: '5' }).toString());
    const items = (d.tracks && d.tracks.items) || [];
    if (items.length) return items.map(spotifyCandidate);
  }
  return [];
}

// Step 1: search Spotify for each song, return candidates (admin reviews them).
app.post('/api/spotify/match', requireDjAdminRole, async (req, res) => {
  try {
    const found = findPublicPlaylist(String((req.body || {}).uid || ''), String((req.body || {}).pid || ''));
    if (!found) return res.status(404).json({ error: 'ไม่พบ Playlist (อาจเปลี่ยนเป็น Private แล้ว)' });
    const songs = publicSongsOf(found.owner, found.pl);
    const items = [];
    for (const s of songs) {
      let candidates = [];
      try { candidates = await spotifySearchSong(s.title, s.artist); } catch (e) { if (e.status === 429 || /เชื่อมต่อ/.test(e.message)) throw e; }
      items.push({ title: s.title, artist: s.artist, candidates });
    }
    res.json({ name: found.pl.name, ownerName: ownerDisplayName(found.owner), items });
  } catch (e) {
    res.status(e.status === 429 ? 429 : 400).json({ error: e.status === 429 ? 'Spotify จำกัดการเรียกชั่วคราว ลองใหม่ในอีกสักครู่' : String(e.message || e) });
  }
});

// Step 2: create the playlist on the shared account and attach the link.
app.post('/api/spotify/create', requireDjAdminRole, async (req, res) => {
  try {
    const b = req.body || {};
    const found = findPublicPlaylist(String(b.uid || ''), String(b.pid || ''));
    if (!found) return res.status(404).json({ error: 'ไม่พบ Playlist' });
    const uris = (Array.isArray(b.uris) ? b.uris : []).filter((u) => /^spotify:track:[A-Za-z0-9]+$/.test(u));
    if (!uris.length) return res.status(400).json({ error: 'ไม่มีเพลงที่เลือก' });
    const name = String(b.name || found.pl.name).trim().slice(0, 100) || found.pl.name;
    const pl = await spotifyApi('POST', '/me/playlists', {
      name, public: true, description: `ZG Live Jam — Playlist ของ ${ownerDisplayName(found.owner)}`,
    });
    for (let i = 0; i < uris.length; i += 100) {
      await spotifyApi('POST', `/playlists/${pl.id}/items`, { uris: uris.slice(i, i + 100) });
    }
    const url = (pl.external_urls && pl.external_urls.spotify) || `https://open.spotify.com/playlist/${pl.id}`;
    const raw = findPlaylist(found.owner, found.pl.id);
    if (raw) { raw.spotifyUrl = url; saveDb(); }
    res.json({ ok: true, url, added: uris.length });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Parse / validate a Spotify playlist link (returns '' for empty, null for invalid).
function cleanSpotifyUrl(v) {
  const url = String(v || '').trim();
  if (!url) return '';
  const m = url.match(/^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]{22})/);
  return m ? `https://open.spotify.com/playlist/${m[1]}` : null;
}

// Spotify Code (the scannable sound-wave image) of a playlist, fetched from Spotify's
// code service and served from our own site so people can view / save it.
const spotifyCodeCache = new Map();
app.get('/api/spotify-code/:id', requireLogin, async (req, res) => {
  const id = String(req.params.id || '').replace(/\.png$/i, '');
  if (!/^[A-Za-z0-9]{22}$/.test(id)) return res.status(400).send('bad id');
  try {
    let buf = spotifyCodeCache.get(id);
    if (!buf) {
      const r = await fetch(`https://scannables.scdn.co/uri/plain/png/021d44/white/640/spotify:playlist:${id}`);
      if (!r.ok) throw new Error('code service ' + r.status);
      buf = Buffer.from(await r.arrayBuffer());
      if (spotifyCodeCache.size > 200) spotifyCodeCache.clear();
      spotifyCodeCache.set(id, buf);
    }
    res.set('Content-Type', 'image/png').set('Cache-Control', 'private, max-age=86400');
    if (req.query.dl) res.set('Content-Disposition', `attachment; filename="spotify-code-${id}.png"`);
    res.send(buf);
  } catch (e) {
    console.error('spotify-code failed:', e && e.message);
    res.status(502).send('สร้าง Spotify Code ไม่ได้');
  }
});

// Attach / replace / clear a Spotify link by hand.
app.post('/api/spotify/attach', requireDjAdminRole, (req, res) => {
  const b = req.body || {};
  const owner = db.users.find((u) => u.id === String(b.uid || ''));
  const raw = owner && findPlaylist(owner, String(b.pid || ''));
  if (!raw) return res.status(404).json({ error: 'ไม่พบ Playlist' });
  const url = String(b.url || '').trim();
  const clean = cleanSpotifyUrl(url);
  if (clean === null) return res.status(400).json({ error: 'ลิงก์ต้องเป็นลิงก์ Playlist จาก Spotify (https://open.spotify.com/playlist/…)' });
  raw.spotifyUrl = clean; saveDb();
  res.json({ ok: true });
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
        // Entra may put the work address in any of these; roles match on all.
        altEmails: [claims.email, claims.preferred_username, claims.upn].filter(Boolean).map((x) => String(x).toLowerCase()),
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
// Copy a song of an event (used on History events) into MY Favourite. Same title+artist = reuse it.
app.post('/api/songs/:id/to-favourite', requireLogin, (req, res) => {
  const sg = findSong(req.params.id);
  if (!sg) return res.status(404).json({ error: 'ไม่พบเพลงนี้' });
  req.user.favorites = req.user.favorites || [];
  const key = (t, a) => (String(t || '') + '|' + String(a || '')).trim().toLowerCase();
  const existing = req.user.favorites.find((f) => key(f.title, f.artist) === key(sg.title, sg.artist));
  if (existing) return res.json({ ok: true, existed: true, favId: existing.id, favoriteCount: req.user.favorites.length });
  const fav = { id: newId(), title: sg.title, artist: sg.artist || '', chordUrl: sg.chordUrl || '', chordId: sg.chordId || '', addedAt: Date.now() };
  req.user.favorites.push(fav);
  saveDb();
  res.json({ ok: true, existed: false, favId: fav.id, favoriteCount: req.user.favorites.length });
});

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

app.post('/api/playlists', requireLogin, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'ต้องใส่ชื่อ Playlist' });
  if (!req.user.playlists) req.user.playlists = [];
  if (req.user.playlists.length >= MAX_PLAYLISTS) return res.status(400).json({ error: `สร้าง Playlist ได้สูงสุด ${MAX_PLAYLISTS} รายการ` });
  const visibility = req.body && req.body.visibility === 'public' ? 'public' : 'private';
  const sUrl = cleanSpotifyUrl(req.body && req.body.spotifyUrl);
  if (sUrl === null) return res.status(400).json({ error: 'ลิงก์ Spotify ไม่ถูกต้อง (ต้องเป็น https://open.spotify.com/playlist/…)' });
  const p = { id: newId(), name, visibility, songIds: [], spotifyUrl: sUrl, createdAt: Date.now() };
  req.user.playlists.push(p);
  saveDb();
  res.json({ ok: true, playlist: p, playlists: userPlaylists(req.user) });
});

app.post('/api/playlists/:pid/edit', requireLogin, (req, res) => {
  const p = findPlaylist(req.user, req.params.pid);
  if (!p) return res.status(404).json({ error: 'ไม่พบ Playlist' });
  const { name, visibility } = req.body || {};
  if (name !== undefined) {
    const n = String(name).trim().slice(0, 60);
    if (!n) return res.status(400).json({ error: 'ต้องใส่ชื่อ Playlist' });
    p.name = n;
  }
  if (visibility === 'public' || visibility === 'private') p.visibility = visibility;
  if (req.body && req.body.spotifyUrl !== undefined) {
    const sUrl = cleanSpotifyUrl(req.body.spotifyUrl);
    if (sUrl === null) return res.status(400).json({ error: 'ลิงก์ Spotify ไม่ถูกต้อง (ต้องเป็น https://open.spotify.com/playlist/…)' });
    p.spotifyUrl = sUrl;
  }
  saveDb();
  res.json({ ok: true, playlists: userPlaylists(req.user) });
});

app.post('/api/playlists/:pid/delete', requireLogin, (req, res) => {
  if (!findPlaylist(req.user, req.params.pid)) return res.status(404).json({ error: 'ไม่พบ Playlist' });
  req.user.playlists = req.user.playlists.filter((p) => p.id !== req.params.pid);
  saveDb();
  res.json({ ok: true, playlists: userPlaylists(req.user) });
});

// Replace the songs of one playlist: favIds = the chosen favourites (order kept).
app.post('/api/playlists/:pid/songs', requireLogin, (req, res) => {
  const p = findPlaylist(req.user, req.params.pid);
  if (!p) return res.status(404).json({ error: 'ไม่พบ Playlist' });
  const valid = new Set((req.user.favorites || []).map((f) => f.id));
  const ids = Array.isArray(req.body && req.body.favIds) ? req.body.favIds : [];
  p.songIds = [...new Set(ids.filter((id) => valid.has(id)))];
  saveDb();
  res.json({ ok: true, playlists: userPlaylists(req.user) });
});

// ---------- Public playlists of other people ----------
// Only playlists their owner marked "public", only for signed-in people, and
// only name / artist / chord link of the songs (never e-mail or anything else).
function ownerDisplayName(u) {
  return employeeDisplayNameFor(u) || u.name || 'ผู้ใช้';
}
function publicSongsOf(owner, pl) {
  return pl.songIds.map((id) => (owner.favorites || []).find((f) => f.id === id)).filter(Boolean)
    .map((f) => ({ title: f.title, artist: f.artist || '', chordUrl: f.chordUrl || '', chordId: f.chordId || '' }));
}

app.get('/api/public-playlists', requireLogin, (req, res) => {
  const owners = [];
  db.users.forEach((u) => {
    if (u.id === req.user.id) return; // your own are in your Favourite page
    const pls = userPlaylists(u).filter((p) => p.visibility === 'public' && p.songIds.length);
    if (!pls.length) return;
    owners.push({
      userId: u.id,
      ownerName: ownerDisplayName(u),
      playlists: pls.map((p) => ({ id: p.id, name: p.name, spotifyUrl: p.spotifyUrl || '', songCount: p.songIds.length, songs: publicSongsOf(u, p).map((x) => ({ title: x.title, artist: x.artist })) })),
    });
  });
  owners.sort((a, b) => a.ownerName.localeCompare(b.ownerName, 'th'));
  res.json({ owners });
});

function findPublicPlaylist(userId, pid) {
  const owner = db.users.find((u) => u.id === userId);
  if (!owner) return null;
  const pl = userPlaylists(owner).find((p) => p.id === pid && p.visibility === 'public');
  return pl ? { owner, pl } : null;
}

app.get('/api/public-playlists/:uid/:pid', requireLogin, (req, res) => {
  const found = findPublicPlaylist(req.params.uid, req.params.pid);
  if (!found) return res.status(404).json({ error: 'ไม่พบ Playlist นี้ (อาจถูกเปลี่ยนเป็น Private แล้ว)' });
  const mine = new Set((req.user.favorites || []).map((f) => (f.title + '|' + (f.artist || '')).toLowerCase()));
  const songs = publicSongsOf(found.owner, found.pl).map((s) => ({ ...s, inMyFavourite: mine.has((s.title + '|' + s.artist).toLowerCase()) }));
  res.json({ ownerName: ownerDisplayName(found.owner), name: found.pl.name, spotifyUrl: found.pl.spotifyUrl || '', songs });
});

// Copy songs from a friend's public playlist into MY Favourite.
// body: { index } = one song · {} = all songs · { asPlaylist: true } = also make
// a new playlist of mine with those songs.
app.post('/api/public-playlists/:uid/:pid/copy', requireLogin, (req, res) => {
  const found = findPublicPlaylist(req.params.uid, req.params.pid);
  if (!found) return res.status(404).json({ error: 'ไม่พบ Playlist นี้ (อาจถูกเปลี่ยนเป็น Private แล้ว)' });
  let source = publicSongsOf(found.owner, found.pl);
  const { index, asPlaylist } = req.body || {};
  if (typeof index === 'number') {
    if (!source[index]) return res.status(400).json({ error: 'ไม่พบเพลงนี้' });
    source = [source[index]];
  }
  req.user.favorites = req.user.favorites || [];
  const keyOf = (f) => (f.title + '|' + f.artist).toLowerCase();
  const byKey = new Map(req.user.favorites.map((f) => [keyOf(f), f]));
  let added = 0;
  const idsForPlaylist = [];
  source.forEach((f) => {
    const key = keyOf(f);
    let fav = byKey.get(key);
    if (!fav) {
      fav = { id: newId(), title: f.title, artist: f.artist, chordUrl: f.chordUrl, chordId: f.chordId, addedAt: Date.now() };
      req.user.favorites.push(fav); byKey.set(key, fav); added++;
    }
    idsForPlaylist.push(fav.id);
  });
  let playlist = null;
  if (asPlaylist) {
    req.user.playlists = req.user.playlists || [];
    if (req.user.playlists.length >= MAX_PLAYLISTS) return res.status(400).json({ error: `สร้าง Playlist ได้สูงสุด ${MAX_PLAYLISTS} รายการ` });
    playlist = { id: newId(), name: (found.pl.name + ' (จาก ' + ownerDisplayName(found.owner) + ')').slice(0, 60), visibility: 'private', songIds: [...new Set(idsForPlaylist)], createdAt: Date.now() };
    req.user.playlists.push(playlist);
  }
  saveDb();
  res.json({ ok: true, added, playlistCreated: !!playlist });
});

// From a favourite's side: which playlists should this song be in?
app.post('/api/favorites/:favId/playlists', requireLogin, (req, res) => {
  if (!(req.user.favorites || []).some((f) => f.id === req.params.favId)) return res.status(404).json({ error: 'ไม่พบเพลงโปรดนี้' });
  const want = new Set(Array.isArray(req.body && req.body.playlistIds) ? req.body.playlistIds : []);
  (req.user.playlists || []).forEach((p) => {
    const has = (p.songIds || []).includes(req.params.favId);
    if (want.has(p.id) && !has) { p.songIds = (p.songIds || []).concat(req.params.favId); }
    if (!want.has(p.id) && has) { p.songIds = p.songIds.filter((id) => id !== req.params.favId); }
  });
  saveDb();
  res.json({ ok: true, playlists: userPlaylists(req.user) });
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

// "Share My Favourite" — sends a snapshot of the sender's current favourite
// list to a friend who is currently online (present in the given event AND
// logged in — checked via the live presence map, see findPresenceEntryByName
// below). Delivered through the same inbox system as "ขอให้คนอื่นร้อง", so it
// shows up in the recipient's inbox bell on whichever event page they're on.
// Expires 3 days after sharing (kept simple — no per-item "viewed once"
// tracking, just a timestamp checked when the recipient opens it).
const FAVSHARE_EXPIRY_MS = 1000 * 60 * 60 * 24 * 3;
app.post('/api/favorites/share', requireLogin, (req, res) => {
  const { eventId, targetName } = req.body || {};
  if (!eventId || !findEvent(eventId)) return res.status(404).json({ error: 'ไม่พบ Event นี้' });
  const trimmedTarget = String(targetName || '').trim();
  if (!trimmedTarget) return res.status(400).json({ error: 'กรุณาระบุชื่อเพื่อน' });
  if (!(req.user.favorites || []).length) return res.status(400).json({ error: 'คุณยังไม่มีเพลงโปรดให้แชร์' });

  const entry = findPresenceEntryByName(eventId, trimmedTarget);
  if (!entry) {
    return res.status(404).json({ error: `ไม่พบ "${trimmedTarget}" ใน Event นี้ตอนนี้ — ต้องออนไลน์อยู่ถึงจะแชร์ได้` });
  }
  if (!entry.userId) {
    return res.status(409).json({ notLoggedIn: true, error: `${trimmedTarget} ไม่ได้ล็อกอินเข้าระบบ จึงไม่สามารถแชร์ให้ได้ในตอนนี้` });
  }
  if (entry.userId === req.user.id) {
    return res.status(400).json({ error: 'ไม่สามารถแชร์ให้ตัวเองได้' });
  }

  const item = addInboxItem({
    eventId,
    kind: 'favshare',
    fromClientId: null,
    fromName: req.user.name || 'ไม่ระบุชื่อ',
    toClientId: entry.clientId,
    toUserId: entry.userId,
    toName: trimmedTarget,
    favorites: req.user.favorites.map((f) => ({ title: f.title, artist: f.artist || '', chordUrl: f.chordUrl || '', chordId: f.chordId || '' })),
    expiresAt: Date.now() + FAVSHARE_EXPIRY_MS,
  });
  res.json({ ok: true, item, sharedCount: req.user.favorites.length });
});

// Recipient copies a shared favourite list into their own — same
// title+artist merge/de-dupe rule as /api/favorites/import. Must be logged
// in as the exact account the item was addressed to (toUserId), and the
// 3-day window must not have passed yet. Pass `index` in the body to copy
// just that one song (the "ดูรายชื่อเพลง" modal copies one at a time so
// people can pick and choose); omit it to copy the whole shared list at once.
app.post('/api/inbox/:id/copy-favorites', requireLogin, (req, res) => {
  const item = db.inbox.find((i) => i.id === req.params.id);
  if (!item || item.kind !== 'favshare') return res.status(404).json({ error: 'ไม่พบข้อความนี้' });
  if (item.toUserId !== req.user.id) return res.status(403).json({ error: 'ไม่มีสิทธิ์คัดลอกข้อความนี้' });
  if (Date.now() > item.expiresAt) return res.status(410).json({ error: 'ข้อความนี้หมดอายุแล้ว' });

  const { index } = req.body || {};
  let source = item.favorites || [];
  if (typeof index === 'number') {
    const one = source[index];
    if (!one) return res.status(400).json({ error: 'ไม่พบเพลงนี้ในรายการที่แชร์มา' });
    source = [one];
  }

  req.user.favorites = req.user.favorites || [];
  const keyOf = (f) => (f.title + '|' + f.artist).toLowerCase();
  const existingKeys = new Set(req.user.favorites.map(keyOf));
  let addedCount = 0;
  source.forEach((f) => {
    const title = (f.title || '').trim();
    if (!title) return;
    const clean = { id: newId(), title, artist: (f.artist || '').trim(), chordUrl: f.chordUrl || '', chordId: f.chordId || '', addedAt: Date.now() };
    const key = keyOf(clean);
    if (!existingKeys.has(key)) { req.user.favorites.push(clean); existingKeys.add(key); addedCount++; }
  });
  saveDb();
  res.json({ ok: true, imported: addedCount, favorites: req.user.favorites });
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
  if (eventStatus(findEvent(eventId)) === 'history') return res.status(403).json({ error: HISTORY_MSG, history: true });
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
  if (eventMode(findEvent(eventId)) === 'open') db.nextShow.push({ songId: song.id, played: false });
  saveDb();
  broadcast();
  if (clientId) {
    maybeNotifyRequestOther({
      eventId, songId: song.id, songTitle: song.title, voteType, targetName,
      fromClientId: clientId, fromName: requesterName,
    });
  }
  res.json({ ok: true, song: publicSong(song) });
});

// ---------- Events ----------
// A "live event" (one outing/gig). Request List / Next Show List are always
// scoped to one event, via ?eventId= on reads or eventId in the body on
// writes. Favourites are intentionally NOT scoped to an event — they're
// personal and can be prepared before any specific event is picked.
app.get('/api/events/:id/live', (req, res) => {
  const ev = findEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'ไม่พบ Event' });
  res.json(publicLive(ev));
});

app.post('/api/admin/events/:id/live', checkPin, (req, res) => {
  const ev = findEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'ไม่พบ Event' });
  const { on, url, label, chatMaxLen, chatIntervalSec } = req.body || {};
  const u = String(url || '').trim();
  if (u && !/^https?:\/\/\S+$/i.test(u)) return res.status(400).json({ error: 'ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://' });
  if (on && !u) return res.status(400).json({ error: 'ต้องใส่ลิงก์ก่อนเปิด Live' });
  ev.live = {
    on: !!on, url: u.slice(0, 500), label: String(label || '').trim().slice(0, 100),
    chatMaxLen: clampInt(chatMaxLen, 10, 1000, 200),
    chatIntervalSec: clampNum(chatIntervalSec, 0, 60, 1),
    updatedAt: Date.now(),
  };
  saveDb();
  broadcast();
  res.json({ ok: true, live: publicLive(ev) });
});

app.get('/api/events', (req, res) => {
  // Earliest-created first, so the event list reads top-to-bottom in the
  // order the events were set up.
  // ?scope=any|zygen limits the list to that mode's events; no scope = all.
  const scope = req.query.scope === 'any' || req.query.scope === 'zygen' ? req.query.scope : null;
  const list = scope ? db.events.filter((e) => eventScope(e) === scope) : db.events;
  res.json({ events: [...list].sort((a, b) => a.createdAt - b.createdAt).map(publicEvent) });
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
    mode: body && body.mode === 'open' ? 'open' : (body && body.mode === 'approve' ? 'approve' : undefined),
    status: body && body.status === 'history' ? 'history' : (body && body.status === 'open' ? 'open' : undefined),
  };
}

app.post('/api/admin/events', checkPin, (req, res) => {
  const fields = readEventFields(req.body);
  if (!fields.name) return res.status(400).json({ error: 'ต้องระบุชื่อ Event' });
  const scope = req.body && req.body.scope === 'any' ? 'any' : 'zygen';
  const event = { id: newId(), ...fields, mode: fields.mode || 'approve', status: fields.status || 'open', scope, createdAt: Date.now() };
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
  if (fields.mode === undefined) delete fields.mode; // keep the current mode if none was sent
  if (fields.status === undefined) delete fields.status;
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
  if (eventStatus(findEvent(eventId)) === 'history') return res.status(403).json({ error: HISTORY_MSG, history: true });
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
  if (eventMode(findEvent(eventId)) === 'open') db.nextShow.push({ songId: song.id, played: false }); // straight into the queue
  saveDb();
  broadcast();
  if (clientId) {
    maybeNotifyRequestOther({
      eventId, songId: song.id, songTitle: song.title, voteType, targetName,
      fromClientId: clientId, fromName: (voterName || requestedBy || '').trim(),
    });
  }
  res.json({ ok: true, song: publicSong(song) });
});

// Vote (or change vote) on an existing song
app.post('/api/songs/:id/vote', blockHistorySong, (req, res) => {
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
  maybeNotifyRequestOther({
    eventId: song.eventId, songId: song.id, songTitle: song.title, voteType, targetName,
    fromClientId: clientId, fromName: (voterName || '').trim(),
  });
  res.json({ ok: true, song: publicSong(song) });
});

// Guests can remove their own mistaken/changed-mind request, but only while
// it hasn't gathered much interest yet — past the threshold, only admin can.
app.post('/api/songs/:id/self-delete', blockHistorySong, (req, res) => {
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
app.post('/api/songs/:id/edit', blockHistorySong, (req, res) => {
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
app.post('/api/songs/:id/musician-response', blockHistorySong, (req, res) => {
  const song = findSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'ไม่พบเพลงนี้' });
  const songEvent = findEvent(song.eventId);
  if (songEvent && eventScope(songEvent) === 'zygen' && !reqRoles(req).musician) {
    return res.status(403).json({ error: 'ต้องมีสิทธิ์ นักดนตรี' });
  }
  const { musicianName, level, role } = req.body || {};
  if (!musicianName || !String(musicianName).trim()) {
    return res.status(400).json({ error: 'ต้องระบุชื่อนักดนตรี' });
  }
  if (!MUSICIAN_LEVELS.includes(level)) {
    return res.status(400).json({ error: 'ค่าการตอบรับไม่ถูกต้อง' });
  }
  if (!song.musicianResponses) song.musicianResponses = {};
  if (level === 'ไม่ระบุ') {
    // "ไม่ระบุ" = take my answer back, as if I never clicked
    delete song.musicianResponses[String(musicianName).trim()];
  } else {
    song.musicianResponses[String(musicianName).trim()] = { level, role: (role || '').trim() };
  }
  saveDb();
  broadcast();
  res.json({ ok: true, song: publicSong(song) });
});

// ---------- Admin API (PIN protected) ----------
// ---------- Roles ----------
// A signed-in user is matched to an employee by e-mail (case-insensitive).
// Roles: superadmin (fixed by e-mail, can't be removed), djadmin (= may do
// what used to need the Admin PIN), musician (may use the Musician menu).
// Everyone else is a plain "general user". Super admin has every role plus
// access to the Role page.
const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || 'cholapatr@zygencenter.com').trim().toLowerCase();
// The old PIN still works, but only for Any Event. ZyGen Event needs the
// DJ Admin role. Set ALLOW_ADMIN_PIN=0 to make roles the only way everywhere.
const ALLOW_ADMIN_PIN = process.env.ALLOW_ADMIN_PIN !== '0';

function findEmployeeByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  return Object.values(empStore.employees).find((x) => x.isActive && x.email && String(x.email).toLowerCase() === e) || null;
}
function userRoles(user) {
  const none = { superadmin: false, djadmin: false, musician: false, general: false };
  if (!user) return none;
  const emails = [user.email, ...(user.altEmails || [])].map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
  if (!emails.length) return none;
  if (emails.includes(SUPER_ADMIN_EMAIL)) return { superadmin: true, djadmin: true, musician: true, general: true };
  let emp = null;
  for (const em of emails) { emp = findEmployeeByEmail(em); if (emp) break; }
  const r = (emp && db.roles[emp.employeeId]) || {};
  // general (ผู้ใช้ทั่วไป) is on by default; only an explicit `general:false` removes it.
  return { superadmin: false, djadmin: !!r.djadmin, musician: !!r.musician, general: r.general !== false };
}
// "ชื่อเล่นไทย (ชื่อจริงไทย)" of the employee whose e-mail matches this login, or ''.
function employeeDisplayNameFor(user) {
  if (!user) return '';
  const emails = [user.email, ...(user.altEmails || [])];
  let emp = null;
  for (const em of emails) { emp = findEmployeeByEmail(em); if (emp) break; }
  if (!emp) return '';
  const nick = String(emp.nicknameTh || '').trim();
  const first = String(emp.firstNameTh || '').trim();
  if (nick && first && nick !== first) return `${nick} (${first})`;
  return nick || first;
}
// ---------- Playlists (per person; built from their own Favourite songs) ----------
// user.playlists = [{ id, name, visibility: 'private'|'public', songIds: [favId…], createdAt }]
// Public ones will later be browsable by friends (separate page, not built yet).
const MAX_PLAYLISTS = 30;
function userPlaylists(user) {
  const favIds = new Set((user.favorites || []).map((f) => f.id));
  return (user.playlists || []).map((p) => ({
    id: p.id, name: p.name, visibility: p.visibility === 'public' ? 'public' : 'private',
    songIds: (p.songIds || []).filter((id) => favIds.has(id)), // drop songs removed from Favourite
    createdAt: p.createdAt, spotifyUrl: p.spotifyUrl || '',
  }));
}
function findPlaylist(user, id) { return (user.playlists || []).find((p) => p.id === id); }

function reqRoles(req) { return userRoles(getSessionUser(req)); }

function requireDjAdminRole(req, res, next) {
  if (!reqRoles(req).djadmin) return res.status(403).json({ error: 'ต้องมีสิทธิ์ DJ Admin' });
  next();
}
function requireSuperAdmin(req, res, next) {
  if (!reqRoles(req).superadmin) return res.status(403).json({ error: 'ต้องเป็น Super Admin' });
  next();
}

// Which mode does this admin request belong to? Looked up from the event
// (or song) it targets; the event-create call and login send `scope`.
// Unknown => treated as ZyGen (the stricter side: role required).
function requestScope(req) {
  const b = req.body || {};
  const q = req.query || {};
  const eid = b.eventId || q.eventId;
  let ev = eid ? findEvent(eid) : null;
  if (!ev && b.songId) { const sg = findSong(b.songId); if (sg) ev = findEvent(sg.eventId); }
  if (!ev && req.params && req.params.id) {
    ev = findEvent(req.params.id);
    if (!ev) { const sg = findSong(req.params.id); if (sg) ev = findEvent(sg.eventId); }
  }
  if (ev) return eventScope(ev);
  if (b.scope === 'any') return 'any';
  return 'zygen';
}
const NO_DJ_ADMIN = { error: 'คุณไม่มีสิทธิ DJ Admin — กรุณาไปขอสิทธิเป็น DJ Admin กับ Super Admin', noDjAdmin: true };

function checkPin(req, res, next) {
  if (reqRoles(req).djadmin) return next();
  if (requestScope(req) === 'zygen') return res.status(403).json(NO_DJ_ADMIN);
  // Any Event: the old PIN still works.
  const pin = (req.body && req.body.pin) || req.query.pin || req.headers['x-admin-pin'];
  if (ALLOW_ADMIN_PIN && pin === ADMIN_PIN) return next();
  return res.status(401).json({ error: 'PIN ไม่ถูกต้อง' });
}

app.post('/api/admin/login', (req, res) => {
  if (reqRoles(req).djadmin) return res.json({ ok: true, viaRole: true });
  if (requestScope(req) === 'zygen') return res.status(403).json(NO_DJ_ADMIN);
  const { pin } = req.body || {};
  if (!ALLOW_ADMIN_PIN || pin !== ADMIN_PIN) return res.status(401).json({ error: 'PIN ไม่ถูกต้อง' });
  res.json({ ok: true });
});

// Role page (super admin only): every active employee + their roles.
app.get('/api/admin/roles', requireSuperAdmin, (req, res) => {
  const list = Object.values(empStore.employees)
    .filter((e) => e.isActive && !e.redacted)
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId))
    .map((e) => {
      const r = db.roles[e.employeeId] || {};
      const isSuper = !!e.email && String(e.email).toLowerCase() === SUPER_ADMIN_EMAIL;
      return {
        employeeId: e.employeeId,
        nickname: e.nicknameTh || e.nickname || '',
        fullName: [e.firstNameTh, e.lastNameTh].filter(Boolean).join(' ') || [e.firstName, e.lastName].filter(Boolean).join(' '),
        email: e.email || '',
        superadmin: isSuper,
        general: isSuper || r.general !== false,
        musician: isSuper || !!r.musician,
        djadmin: isSuper || !!r.djadmin,
      };
    });
  res.json({ employees: list, superAdminEmail: SUPER_ADMIN_EMAIL });
});

// Save all pending checkbox changes at once (Save button on the Role page).
// changes: [{ employeeId, general, musician, djadmin }] — Super Admin rows are ignored.
app.post('/api/admin/roles/save', requireSuperAdmin, (req, res) => {
  const changes = Array.isArray(req.body && req.body.changes) ? req.body.changes : [];
  let n = 0;
  for (const c of changes) {
    const emp = empStore.employees[String(c && c.employeeId)];
    if (!emp) continue;
    if (emp.email && String(emp.email).toLowerCase() === SUPER_ADMIN_EMAIL) continue;
    const r = { general: c.general !== false, musician: !!c.musician, djadmin: !!c.djadmin };
    if (r.general && !r.musician && !r.djadmin) delete db.roles[emp.employeeId];
    else db.roles[emp.employeeId] = r;
    n++;
  }
  saveDb();
  res.json({ ok: true, saved: n });
});

// Queue edits (reorder / remove / played): PIN or DJ Admin as usual, EXCEPT in
// "Everybody can set next show list" events, where anyone in the event may.
function checkQueuePerm(req, res, next) {
  const b = req.body || {};
  let ev = b.eventId ? findEvent(b.eventId) : null;
  if (!ev && b.songId) { const sg = findSong(b.songId); if (sg) ev = findEvent(sg.eventId); }
  if (ev && eventMode(ev) === 'open' && eventStatus(ev) !== 'history') return next();
  return checkPin(req, res, next);
}

// Replace the Next Show List order (array of songIds) for one event — admin
// curates manually. Other events' queue entries are left untouched.
app.post('/api/admin/next-show', checkQueuePerm, (req, res) => {
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

app.post('/api/admin/next-show/remove', checkQueuePerm, (req, res) => {
  const { songId } = req.body || {};
  db.nextShow = db.nextShow.filter((i) => i.songId !== songId);
  saveDb();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/admin/next-show/played', checkQueuePerm, (req, res) => {
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
  clearInboxForEvent(eventId);
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
  clearInboxForEvent(eventId);
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

// ---------- Presence (who's live-connected to each event right now) ----------
// Purely in-memory, never persisted — it's inherently a snapshot of "who's
// connected this instant", reconstructed for free every time someone
// connects. Keyed by eventId -> clientId -> { name, status, sockets:Set }.
// The sockets Set (not a single socket id) is what makes multiple tabs on
// the same device collapse into one person instead of inflating the count.
const presence = new Map();

function getEventPresence(eventId) {
  if (!presence.has(eventId)) presence.set(eventId, new Map());
  return presence.get(eventId);
}

function presenceList(eventId) {
  const m = presence.get(eventId);
  if (!m) return [];
  return [...m.values()].map((p) => ({ name: p.name, status: p.status }));
}

// One-shot snapshot (not live) — used by pages that don't hold a live
// Socket.IO subscription for this specific event, e.g. the Favourite page's
// "ขอเพลงนี้" modal picks a target event from a dropdown that can differ
// from whichever event the person is actually joined to.
app.get('/api/events/:id/presence', (req, res) => {
  if (!findEvent(req.params.id)) return res.status(404).json({ error: 'ไม่พบ Event นี้' });
  res.json({ names: presenceList(req.params.id).map((p) => p.name) });
});

function broadcastPresence(eventId) {
  io.to('presence:' + eventId).emit('presence-changed', presenceList(eventId));
}

// Resolve a presence display name back to its full live entry (clientId +
// userId if that device is logged in) — exact match only (name came from the
// presence datalist, so it should match verbatim); duplicate names in the
// same event are an accepted edge case, resolves to whichever matching entry
// is encountered first. Used both for routing "ขอให้คนอื่นร้อง" requests and
// for checking whether a "Share My Favourite" target is actually reachable
// (present) and logged in.
function findPresenceEntryByName(eventId, name) {
  const m = presence.get(eventId);
  const target = String(name || '').trim();
  if (!m || !target) return null;
  for (const [clientId, entry] of m) {
    if (entry.name === target) return { clientId, name: entry.name, status: entry.status, userId: entry.userId || null };
  }
  return null;
}

function findClientIdByName(eventId, name) {
  const entry = findPresenceEntryByName(eventId, name);
  return entry ? entry.clientId : null;
}

function removeFromPresence(eventId, clientId, socketId) {
  if (!eventId || !clientId) return;
  const m = presence.get(eventId);
  if (!m) return;
  const entry = m.get(clientId);
  if (!entry) return;
  entry.sockets.delete(socketId);
  if (entry.sockets.size === 0) m.delete(clientId);
  if (m.size === 0) presence.delete(eventId);
}

// ---------- Inbox (per-person notifications for "ขอให้คนอื่นร้อง") ----------
// Unlike presence, this IS persisted — a notification should still be there
// waiting for someone the next time they open the app, not just while
// they're actively connected. Delivery is scoped to whoever a socket has
// declared itself as (via presence-join), using the same clientId that
// already identifies a person's votes/favourites on this device.
function publicInboxItem(item) {
  return item;
}

function inboxRoom(eventId, clientId) {
  return 'inbox:' + eventId + ':' + clientId;
}

function addInboxItem(fields) {
  const item = {
    id: newId(),
    read: false,
    status: 'pending',
    respondedAt: null,
    createdAt: Date.now(),
    ...fields,
  };
  db.inbox.push(item);
  saveDb();
  io.to(inboxRoom(item.eventId, item.toClientId)).emit('inbox-new', item);
  return item;
}

// Called whenever an admin wipes an event's songs (Clear all Request List /
// Reset the stage) — leftover inbox items would otherwise reference songIds
// that no longer exist. Not called for "Clear all Next Show List" alone,
// since that doesn't touch songs and the inbox items are still valid.
function clearInboxForEvent(eventId) {
  const before = db.inbox.length;
  db.inbox = db.inbox.filter((i) => i.eventId !== eventId);
  if (db.inbox.length !== before) io.emit('inbox-cleared', { eventId });
  return before !== db.inbox.length;
}

// Called after any vote/request write that might be a "ขอให้คนอื่นร้อง" —
// wrapped in try/catch so a problem here can never break the actual
// vote/request it's piggybacking on.
function maybeNotifyRequestOther({ eventId, songId, songTitle, voteType, targetName, fromClientId, fromName }) {
  try {
    if (voteType !== 'requestOther' || !fromClientId) return;
    const trimmedTarget = String(targetName || '').trim();
    if (!trimmedTarget) return;
    const toClientId = findClientIdByName(eventId, trimmedTarget);
    if (!toClientId || toClientId === fromClientId) return;
    addInboxItem({
      eventId,
      kind: 'request',
      songId,
      songTitle,
      fromClientId,
      fromName: (fromName || '').trim() || 'ไม่ระบุชื่อ',
      toClientId,
      toName: trimmedTarget,
    });
  } catch (e) {
    console.error('inbox notify error:', e);
  }
}

// Per-song list of "ขอให้คนอื่นร้อง" requests for an event — who asked,
// who they asked, and how (or whether) it was answered. Used by Admin to
// see every ask/response at a glance, so it can factor into queue
// decisions. Deliberately admin-facing only (not merged into the shared
// /api/state that guests' pages use) since it surfaces who responded and
// how, which is more than the existing public vote/target data reveals.
app.get('/api/events/:id/song-request-status', (req, res) => {
  if (!findEvent(req.params.id)) return res.status(404).json({ error: 'ไม่พบ Event นี้' });
  const items = db.inbox.filter((i) => i.eventId === req.params.id && i.kind === 'request' && i.songId);
  const bySong = {};
  items.forEach((i) => {
    if (!bySong[i.songId]) bySong[i.songId] = [];
    bySong[i.songId].push({
      fromName: i.fromName,
      toName: i.toName,
      status: i.status, // 'pending' | 'yes-solo' | 'yes-together' | 'no'
      createdAt: i.createdAt,
    });
  });
  Object.values(bySong).forEach((list) => list.sort((a, b) => a.createdAt - b.createdAt));
  res.json({ songs: bySong });
});

app.get('/api/inbox', (req, res) => {
  const { eventId, clientId } = req.query;
  if (!eventId || !clientId) return res.json({ items: [] });
  const items = db.inbox
    .filter((i) => i.eventId === eventId && i.toClientId === clientId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicInboxItem);
  res.json({ items });
});

app.post('/api/inbox/mark-read', (req, res) => {
  const { eventId, clientId } = req.body || {};
  if (!eventId || !clientId) return res.json({ ok: true });
  let changed = false;
  db.inbox.forEach((i) => {
    if (i.eventId === eventId && i.toClientId === clientId && !i.read) {
      i.read = true;
      changed = true;
    }
  });
  if (changed) saveDb();
  res.json({ ok: true });
});

// Respond to a "ขอให้คนอื่นร้อง" request: Yes ร้องได้ / Yes ร้องด้วยกันนะ / No
// ไม่พร้อม. Also creates a reply notification back to whoever asked.
app.post('/api/inbox/:id/respond', (req, res) => {
  const item = db.inbox.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'ไม่พบข้อความนี้' });
  const { clientId, response } = req.body || {};
  if (!clientId || item.toClientId !== clientId) {
    return res.status(403).json({ error: 'ไม่มีสิทธิ์ตอบข้อความนี้' });
  }
  if (item.kind !== 'request') {
    return res.status(400).json({ error: 'ข้อความนี้ไม่ใช่คำขอที่ต้องตอบ' });
  }
  if (!['yes-solo', 'yes-together', 'no'].includes(response)) {
    return res.status(400).json({ error: 'คำตอบไม่ถูกต้อง' });
  }
  if (item.status !== 'pending') {
    return res.status(409).json({ error: 'ตอบไปแล้ว', item: publicInboxItem(item) });
  }
  item.status = response;
  item.respondedAt = Date.now();
  saveDb();
  // Sync any other open tabs of the responder so they see it's answered too.
  io.to(inboxRoom(item.eventId, item.toClientId)).emit('inbox-updated', item);
  // Nudge everyone (incl. Admin, who isn't in this private inbox room) to
  // refetch — Admin uses this to highlight songs with a confirmed "yes".
  broadcast();
  // Let the original requester know what the answer was.
  if (item.fromClientId) {
    addInboxItem({
      eventId: item.eventId,
      kind: 'reply',
      songId: item.songId,
      songTitle: item.songTitle,
      fromClientId: item.toClientId,
      fromName: item.toName,
      toClientId: item.fromClientId,
      toName: item.fromName,
      status: response,
    });
  }
  res.json({ ok: true, item: publicInboxItem(item) });
});

// ---------- Socket.IO ----------
const chatLog = new Map(); // eventId -> last messages
const REACTION_EMOJIS = ['❤️', '👍', '👏', '🔥', '🎉', '😆', '🎸', '🤟'];
io.on('connection', (socket) => {
  socket.emit('state-changed');
  socket.data.presenceEventId = null;
  socket.data.presenceClientId = null;

  // Every handler below is wrapped in try/catch on purpose: an uncaught
  // throw inside a socket listener can crash the entire Node process (not
  // just this one connection), which would take Request List/Next Show
  // List/Admin down for everyone until Azure restarts the app. Presence is
  // a "nice to have" feature — it must never be able to bring the rest of
  // the app down with it.
  socket.on('presence-join', (payload) => {
    try {
      const { eventId, clientId, name, status, userId } = payload || {};
      if (!eventId || !clientId || !findEvent(eventId)) return;
      // Switching events (or first join): leave whatever room this socket
      // was previously counted under.
      if (socket.data.presenceEventId && socket.data.presenceEventId !== eventId) {
        socket.leave('presence:' + socket.data.presenceEventId);
        socket.leave(inboxRoom(socket.data.presenceEventId, socket.data.presenceClientId));
        removeFromPresence(socket.data.presenceEventId, socket.data.presenceClientId, socket.id);
        broadcastPresence(socket.data.presenceEventId);
      }
      socket.data.presenceEventId = eventId;
      socket.data.presenceClientId = clientId;
      socket.join('presence:' + eventId);
      socket.join(inboxRoom(eventId, clientId));
      const m = getEventPresence(eventId);
      const entry = m.get(clientId) || { name: '', status: 'physical', userId: null, sockets: new Set() };
      entry.name = String(name || 'ผู้ร่วมงาน').trim().slice(0, 60) || 'ผู้ร่วมงาน';
      entry.status = status === 'online' ? 'online' : 'physical';
      // Which account (if any) this device is logged in as right now — lets
      // "Share My Favourite" know whether a present friend can actually
      // receive/copy a shared list. Confirmed server-side (findOrCreateUser
      // owns db.users), not just trusted blindly, but we don't re-verify the
      // session here — client only sends its own /api/me result, and a stale/
      // forged userId at worst fails harmlessly at copy-time (requireLogin +
      // toUserId check there is the real gate).
      entry.userId = userId || null;
      entry.sockets.add(socket.id);
      m.set(clientId, entry);
      broadcastPresence(eventId);
    } catch (e) {
      console.error('presence-join error:', e);
    }
  });

  socket.on('presence-status', (payload) => {
    try {
      const eventId = socket.data.presenceEventId;
      const clientId = socket.data.presenceClientId;
      if (!eventId || !clientId) return;
      const m = presence.get(eventId);
      const entry = m && m.get(clientId);
      if (!entry) return;
      entry.status = (payload && payload.status === 'online') ? 'online' : 'physical';
      broadcastPresence(eventId);
    } catch (e) {
      console.error('presence-status error:', e);
    }
  });

  // Emoji reactions (❤️ 👏 …) — sent by anyone in the event (mainly people
  // watching the live stream from home) and shown to everyone in the event.
  socket.on('reaction', (p) => {
    try {
      const { eventId, emoji, name, where } = p || {};
      if (!REACTION_EMOJIS.includes(emoji) || !eventId || !findEvent(eventId)) return;
      const now = Date.now();
      if (now - (socket.data.lastReaction || 0) < 400) return; // anti-spam
      socket.data.lastReaction = now;
      io.to('presence:' + eventId).emit('reaction', {
        eventId, emoji,
        name: String(name || 'ผู้ร่วมงาน').trim().slice(0, 60) || 'ผู้ร่วมงาน',
        where: where === 'online' ? 'online' : 'physical',
        at: now,
      });
    } catch (e) {
      console.error('reaction error:', e);
    }
  });

  // Live chat (watch.html): short text messages shared with everyone in the
  // event. Kept in memory only (last 100 per event) — a restart clears them.
  socket.on('chat-send', (p) => {
    try {
      const { eventId, text, name, where } = p || {};
      if (!eventId || !findEvent(eventId) || socket.data.presenceEventId !== eventId) return;
      const cfg = publicLive(findEvent(eventId)); // per-event limits set on the Live Broadcast page
      const clean = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, cfg.chatMaxLen);
      if (!clean) return;
      const now = Date.now();
      if (now - (socket.data.lastChat || 0) < cfg.chatIntervalSec * 1000) return; // anti-spam
      socket.data.lastChat = now;
      const msg = {
        id: crypto.randomBytes(6).toString('hex'), eventId, text: clean,
        name: String(name || 'ผู้ร่วมงาน').trim().slice(0, 60) || 'ผู้ร่วมงาน',
        where: where === 'online' ? 'online' : 'physical', at: now,
      };
      const list = chatLog.get(eventId) || [];
      list.push(msg);
      if (list.length > 100) list.shift();
      chatLog.set(eventId, list);
      io.to('presence:' + eventId).emit('chat-message', msg);
    } catch (e) {
      console.error('chat-send error:', e);
    }
  });
  socket.on('chat-history', (p, cb) => {
    try {
      const eventId = p && p.eventId;
      if (typeof cb === 'function') cb(findEvent(eventId) ? (chatLog.get(eventId) || []).slice(-50) : []);
    } catch (e) {
      console.error('chat-history error:', e);
    }
  });

  socket.on('presence-leave', () => {
    try {
      const eventId = socket.data.presenceEventId;
      if (!eventId) return;
      socket.leave('presence:' + eventId);
      socket.leave(inboxRoom(eventId, socket.data.presenceClientId));
      removeFromPresence(eventId, socket.data.presenceClientId, socket.id);
      broadcastPresence(eventId);
      socket.data.presenceEventId = null;
      socket.data.presenceClientId = null;
    } catch (e) {
      console.error('presence-leave error:', e);
    }
  });

  socket.on('disconnect', () => {
    try {
      const eventId = socket.data.presenceEventId;
      if (!eventId) return;
      removeFromPresence(eventId, socket.data.presenceClientId, socket.id);
      broadcastPresence(eventId);
    } catch (e) {
      console.error('presence disconnect cleanup error:', e);
    }
  });
});

// ---------- Employee Master Data (synced from ZG SAP Sync Hub) ----------
// Read-only copy of the company's employee list, pulled from the Hub's
// EMPLOYEE interface. Kept in its own file (data/employees.json) rather than
// db.json because db.json is rewritten in full on every vote/request, and a
// few hundred employee rows would make every one of those writes heavier.
// Only the Hub's "employee:basic" scope fields are stored (no birth date,
// phone, etc.) — the app only needs names/group/position/email.
// The API key lives only in ZG_HUB_API_KEY and is only ever used here, on
// the server — never sent to the browser.
const EMP_FILE = path.join(__dirname, 'data', 'employees.json');
const HUB_BASE_URL = (process.env.ZG_HUB_BASE_URL || 'https://zgsapsynchub-ffemahc2b4hha5de.southeastasia-01.azurewebsites.net').replace(/\/$/, '');
const EMP_FIELDS = [
  'status', 'isActive', 'firstNameTh', 'lastNameTh', 'nicknameTh', 'firstName', 'lastName', 'nickname',
  'employeeGroup', 'employeeGroupName', 'positionId', 'positionDescription', 'email',
  'sapChangedAt', 'hubUpdatedAt', 'redacted',
];

function loadEmployeeStore() {
  try {
    const d = JSON.parse(fs.readFileSync(EMP_FILE, 'utf8'));
    return { employees: d.employees || {}, sync: d.sync || {} };
  } catch (e) {
    return { employees: {}, sync: {} };
  }
}
let empStore = loadEmployeeStore();
function saveEmployeeStore() {
  fs.mkdirSync(path.dirname(EMP_FILE), { recursive: true });
  fs.writeFileSync(EMP_FILE, JSON.stringify(empStore));
}

let empSyncRunning = false;

// Pulls from the Hub and upserts by employeeId. First run (or forceFull) =
// everything incl. resigned; later runs = only rows changed since the last
// successful sync (with a 5 minute overlap — upserts are idempotent, so the
// overlap only costs a few repeated rows and protects against clock skew).
// Resigned people stay in the list as inactive (never deleted), and a
// redacted row overwrites everything personal with the nulls the Hub sends.
// On any error the run is skipped and existing data is left untouched.
async function syncEmployees({ forceFull = false } = {}) {
  if (empSyncRunning) return { ok: false, error: 'กำลัง sync อยู่ รอสักครู่' };
  const apiKey = process.env.ZG_HUB_API_KEY;
  empStore.sync.lastAttemptAt = new Date().toISOString();
  if (!apiKey) {
    empStore.sync.lastError = 'ยังไม่ได้ตั้งค่า ZG_HUB_API_KEY';
    saveEmployeeStore();
    return { ok: false, error: empStore.sync.lastError };
  }
  empSyncRunning = true;
  const startedAt = new Date();
  try {
    let url = `${HUB_BASE_URL}/api/v1/employees?includeResigned=true`;
    const prev = empStore.sync.lastSuccessAt;
    if (!forceFull && prev) {
      url += `&updatedSince=${encodeURIComponent(new Date(new Date(prev).getTime() - 5 * 60 * 1000).toISOString())}`;
    }
    const res = await fetch(url, { headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.error || ''; } catch (e) { /* not json */ }
      throw new Error(`Hub ตอบกลับ ${res.status}${detail ? ' ' + detail : ''}`);
    }
    const body = await res.json();
    const rows = Array.isArray(body.data) ? body.data : [];
    const now = new Date().toISOString();
    let upserted = 0;
    for (const r of rows) {
      if (!r || !r.employeeId) continue;
      const rec = { employeeId: String(r.employeeId) };
      for (const f of EMP_FIELDS) rec[f] = r[f] === undefined ? null : r[f];
      rec.isActive = r.isActive !== false && r.status !== 'R';
      rec.lastSyncedAt = now;
      empStore.employees[rec.employeeId] = rec;
      upserted++;
    }
    empStore.sync.lastSuccessAt = startedAt.toISOString();
    empStore.sync.hubSyncedAt = body.syncedAt || null;
    empStore.sync.lastError = '';
    empStore.sync.lastCount = upserted;
    empStore.sync.lastMode = (!forceFull && prev) ? 'incremental' : 'full';
    saveEmployeeStore();
    return { ok: true, upserted, mode: empStore.sync.lastMode };
  } catch (e) {
    empStore.sync.lastError = e.name === 'TimeoutError' ? 'Hub ไม่ตอบกลับภายในเวลาที่กำหนด' : (e.message || 'sync ไม่สำเร็จ');
    saveEmployeeStore();
    console.error('Employee sync failed:', empStore.sync.lastError);
    return { ok: false, error: empStore.sync.lastError };
  } finally {
    empSyncRunning = false;
  }
}

function bangkokParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) };
}

// Daily job: checked every 10 minutes; runs once per Thai calendar day, any
// time after 03:00. A failed attempt is retried no sooner than an hour later.
function maybeRunDailyEmployeeSync() {
  if (!process.env.ZG_HUB_API_KEY) return;
  const nowTh = bangkokParts();
  if (nowTh.hour < 3) return;
  const last = empStore.sync.lastSuccessAt;
  if (last && bangkokParts(new Date(last)).date === nowTh.date) return;
  const lastTry = empStore.sync.lastAttemptAt;
  if (lastTry && Date.now() - new Date(lastTry).getTime() < 60 * 60 * 1000 && empStore.sync.lastError) return;
  syncEmployees();
}
setInterval(maybeRunDailyEmployeeSync, 10 * 60 * 1000);
setTimeout(maybeRunDailyEmployeeSync, 30 * 1000);

// Read-only list — Admin PIN required: this is personal data (names, email)
// and the app otherwise lets anyone in as a guest.
app.get('/api/admin/employees', requireDjAdminRole, (req, res) => {
  const list = Object.values(empStore.employees)
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId))
    .map((e) => ({
      employeeId: e.employeeId,
      isActive: e.isActive,
      redacted: !!e.redacted,
      firstNameTh: e.firstNameTh, lastNameTh: e.lastNameTh, nicknameTh: e.nicknameTh,
      firstName: e.firstName, lastName: e.lastName, nickname: e.nickname,
      employeeGroup: e.employeeGroup, employeeGroupName: e.employeeGroupName,
      positionId: e.positionId, positionDescription: e.positionDescription,
      email: e.email,
    }));
  res.json({
    employees: list,
    sync: {
      lastSuccessAt: empStore.sync.lastSuccessAt || null,
      lastAttemptAt: empStore.sync.lastAttemptAt || null,
      hubSyncedAt: empStore.sync.hubSyncedAt || null,
      lastError: empStore.sync.lastError || '',
      lastMode: empStore.sync.lastMode || '',
      running: empSyncRunning,
      configured: !!process.env.ZG_HUB_API_KEY,
    },
  });
});

app.post('/api/admin/employees/sync', requireDjAdminRole, async (req, res) => {
  const result = await syncEmployees({ forceFull: !!(req.body && req.body.full) });
  res.status(result.ok ? 200 : 502).json(result);
});

server.listen(PORT, () => {
  console.log(`ZG Live Jam server running on port ${PORT}`);
  console.log(`Admin PIN: ${ADMIN_PIN}`);
});
