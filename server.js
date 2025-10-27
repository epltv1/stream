const express = require('express');
const http = require('http');
const session = require('express-session');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Sessions
app.use(session({
  secret: 'slamdrix-secret-key', // CHANGE IN PRODUCTION
  resave: false,
  saveUninitialized: true
}));

// DB Path
const dbPath = path.join(__dirname, 'streams.db');
console.log(`DB Path: ${dbPath}`);

// Ensure DB directory is writable
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, '');
  fs.chmodSync(dbPath, 0o666); // Make writable for owner/group
}

// DB
let db;
try {
  db = new sqlite3.Database(dbPath);
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS streams (id TEXT PRIMARY KEY, title TEXT, m3u8 TEXT, active INTEGER DEFAULT 1)`);
    db.run(`CREATE TABLE IF NOT EXISTS viewers (stream_id TEXT, socket_id TEXT, UNIQUE(stream_id, socket_id))`);
  });
  console.log('DB connected successfully');
} catch (err) {
  console.error('DB Connection Error:', err.message);
}

app.use(express.json());
app.use(express.static('public'));

// Auth Middleware
function isAuthenticated(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/');
}

// Embed Lock (Updated for www.futbol-x.site)
function restrictEmbed(req, res, next) {
  const referer = req.get('Referer') || '';
  const allowedDomains = ['futbol-x.site', 'www.futbol-x.site', '45.33.127.60'];
  const isAllowed = !referer || allowedDomains.some(domain => referer.includes(domain));
  if (isAllowed) {
    return next();
  }
  res.status(403).send('Embedding restricted to futbol-x.site');
}

// Login
app.get('/', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'slamdrix') {
    req.session.loggedIn = true;
    res.json({ success: true, redirect: '/dashboard' });
  } else {
    res.json({ success: false, message: 'Wrong username or password' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Dashboard
app.get('/dashboard', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Streams
app.get('/streams', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'streams.html'));
});

// List Streams
app.get('/api/streams', isAuthenticated, (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  db.all(`SELECT id, title FROM streams WHERE active = 1`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Start Stream
app.post('/api/streams', isAuthenticated, (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  const { title, m3u8 } = req.body;
  const id = uuidv4().slice(0, 8); // Unique 8-char ID
  db.run(`INSERT INTO streams (id, title, m3u8, active) VALUES (?, ?, ?, 1)`, [id, title, m3u8], function(err) {
    if (err) {
      console.error('Insert Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    console.log(`New stream created: ID=${id}, m3u8=${m3u8}`); // Debug log
    res.json({ id, embedUrl: `http://45.33.127.60/embed/${id}.php` });
  });
});

// Stop Stream
app.delete('/api/streams/:id', isAuthenticated, (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  db.run(`UPDATE streams SET active = 0 WHERE id = ?`, [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Get Stream (Improved logging)
app.get('/api/streams/:id', (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  console.log(`Fetching stream ID: ${req.params.id}`); // Debug
  db.get(`SELECT * FROM streams WHERE id = ? AND active = 1`, [req.params.id], (err, row) => {
    if (err) {
      console.error(`DB fetch error for ${req.params.id}:`, err.message);
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      console.log(`Stream ${req.params.id} not found or inactive`);
      return res.status(404).json({ error: "Stream not found or inactive" });
    }
    console.log(`Stream fetched: ${row.title}`); // Debug
    res.json(row);
  });
});

// Embed (PHP-style URL, Updated CORS for www.)
app.get('/embed/:id.php', restrictEmbed, (req, res) => {
  const id = req.params.id;
  console.log(`Embed request for ID: ${id}`); // Debug
  res.set('Access-Control-Allow-Origin', 'https://futbol-x.site, https://www.futbol-x.site');
  res.set('Access-Control-Allow-Origin', '*'); // Fallback for direct
  res.set('X-Frame-Options', 'ALLOWALL'); // Allow iframes broadly but Referer checks
  res.sendFile(path.join(__dirname, 'public', 'embed.html'));
});

// Smart Proxy (Direct if possible, fallback to full proxy)
app.get('/proxy/:streamId', async (req, res) => {
  if (!db) return res.status(500).send("Database not available");
  const stream = await new Promise(r => db.get(`SELECT m3u8 FROM streams WHERE id = ? AND active = 1`, [req.params.streamId], (e, row) => r(row)));
  if (!stream) return res.status(404).send("Stream not found or inactive");
  const originalM3u8 = stream.m3u8;
  console.log(`Proxying m3u8: ${originalM3u8}`); // Debug
  try {
    // Try direct fetch first (no proxy if CORS allows)
    const directResponse = await fetch(originalM3u8, { method: 'HEAD', mode: 'cors' });
    if (directResponse.ok) {
      console.log('Direct m3u8 accessible, serving directly');
      const text = await fetch(originalM3u8).then(r => r.text());
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(text);
    }
  } catch (directErr) {
    console.log(`Direct failed (likely CORS): ${directErr.message}, falling back to proxy`);
  }
  // Full proxy fallback
  try {
    const response = await fetch(originalM3u8, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let text = await response.text();
    // Proxy segments only if needed
    text = text.replace(/(https?:\/\/[^\s"']+)/g, (url) => `/proxy-url?url=${encodeURIComponent(url)}`);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(text);
  } catch (e) {
    console.error(`Proxy error for ${originalM3u8}:`, e.message);
    res.status(500).send("Failed to load stream");
  }
});

app.get('/proxy-url', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing URL");
  try {
    const response = await fetch(decodeURIComponent(url), { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    res.send(Buffer.from(buffer));
  } catch (e) {
    console.error(`Proxy-url error for ${url}:`, e.message);
    res.status(500).send("Failed to load segment");
  }
});

// Socket.IO
io.on('connection', (socket) => {
  socket.on('join-stream', (streamId) => {
    socket.join(streamId);
    if (db) db.run(`INSERT OR REPLACE INTO viewers (stream_id, socket_id) VALUES (?, ?)`, [streamId, socket.id]);
    updateViewers(streamId);
  });

  socket.on('disconnect', () => {
    if (db) db.run(`DELETE FROM viewers WHERE socket_id = ?`, [socket.id], () => {
      socket.rooms.forEach(room => {
        if (room !== socket.id) updateViewers(room);
      });
    });
  });
});

function updateViewers(streamId) {
  if (!db) return;
  db.get(`SELECT COUNT(*) as count FROM viewers WHERE stream_id = ?`, [streamId], (err, row) => {
    if (!err) io.to(streamId).emit('viewer-count', row.count || 0);
  });
}

server.listen(3000, () => console.log('Server on :3000'));
