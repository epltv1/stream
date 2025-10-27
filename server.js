const express = require('express');
const http = require('http');
const session = require('express-session');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Sessions
app.use(session({
  secret: 'slamdrix-secret-key', // CHANGE IN PRODUCTION
  resave: false,
  saveUninitialized: true
}));

// DB
const db = new sqlite3.Database('streams.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS streams (id TEXT PRIMARY KEY, title TEXT, m3u8 TEXT, active INTEGER DEFAULT 1)`);
  db.run(`CREATE TABLE IF NOT EXISTS viewers (stream_id TEXT, socket_id TEXT)`);
});

app.use(express.json());
app.use(express.static('public'));

// Middleware: Auth
function isAuthenticated(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/');
}

// Middleware: Embed Lock
function restrictEmbed(req, res, next) {
  const referer = req.get('Referer') || '';
  if (!referer || referer.includes('futbol-x.site') || referer.includes('45.33.127.60')) {
    return next();
  }
  res.status(403).send('Embedding restricted to futbol-x.site');
}

// Login page
app.get('/', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login POST
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'slamdrix') {
    req.session.loggedIn = true;
    res.json({ success: true, redirect: '/dashboard' });
  } else {
    res.json({ success: false, message: 'Wrong username or password' });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Dashboard
app.get('/dashboard', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Streams page
app.get('/streams', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'streams.html'));
});

// List active streams
app.get('/api/streams', isAuthenticated, (req, res) => {
  db.all(`SELECT id, title FROM streams WHERE active = 1`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Start stream
app.post('/api/streams', isAuthenticated, (req, res) => {
  const { title, m3u8 } = req.body;
  const id = Date.now().toString(36);
  db.run(`INSERT INTO streams (id, title, m3u8, active) VALUES (?, ?, ?, 1)`, [id, title, m3u8], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id, embedUrl: `http://45.33.127.60/embed/${id}` });
  });
});

// Stop stream
app.delete('/api/streams/:id', isAuthenticated, (req, res) => {
  db.run(`UPDATE streams SET active = 0 WHERE id = ?`, [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Get stream
app.get('/api/streams/:id', (req, res) => {
  db.get(`SELECT * FROM streams WHERE id = ? AND active = 1`, [req.params.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });
});

// Embed page (public with restrictions)
app.get('/embed/:id', restrictEmbed, (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://futbol-x.site');
  res.set('X-Frame-Options', 'ALLOW-FROM https://futbol-x.site');
  res.sendFile(path.join(__dirname, 'public', 'embed.html'));
});

// CORS Proxy (improved error handling)
app.get('/proxy/:streamId', async (req, res) => {
  const stream = await new Promise(r => db.get(`SELECT m3u8 FROM streams WHERE id = ? AND active = 1`, [req.params.streamId], (e, row) => r(row)));
  if (!stream) return res.status(404).send("Stream not found or inactive");
  try {
    const response = await fetch(stream.m3u8, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let text = await response.text();
    text = text.replace(/(https?:\/\/[^\s"']+)/g, (url) => `/proxy-url?url=${encodeURIComponent(url)}`);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(text);
  } catch (e) {
    console.error(`Proxy error for ${stream.m3u8}:`, e.message);
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
    db.run(`INSERT INTO viewers (stream_id, socket_id) VALUES (?, ?)`, [streamId, socket.id]);
    updateViewers(streamId);
  });

  socket.on('disconnect', () => {
    db.run(`DELETE FROM viewers WHERE socket_id = ?`, [socket.id], () => {
      socket.rooms.forEach(room => {
        if (room !== socket.id) updateViewers(room);
      });
    });
  });
});

function updateViewers(streamId) {
  db.get(`SELECT COUNT(*) as count FROM viewers WHERE stream_id = ?`, [streamId], (err, row) => {
    if (!err) io.to(streamId).emit('viewer-count', row.count || 0);
  });
}

server.listen(3000, () => console.log('Server on :3000'));
