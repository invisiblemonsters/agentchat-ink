const express = require('express');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- Database ---
const db = new Database(path.join(__dirname, 'chat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    is_agent INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_agent INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    active INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
`);

// --- Prepared statements ---
const insertMsg = db.prepare('INSERT INTO messages (sender, content, is_agent) VALUES (?, ?, ?)');
const getRecent = db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?');
const getAfter = db.prepare('SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT 200');
const getKey = db.prepare('SELECT * FROM api_keys WHERE key = ? AND active = 1');
const insertKey = db.prepare('INSERT INTO api_keys (key, name, is_agent) VALUES (?, ?, ?)');
const countMessages = db.prepare('SELECT COUNT(*) as count FROM messages');

// --- Generate admin key on first run ---
const adminKeyExists = db.prepare("SELECT * FROM api_keys WHERE name = 'admin'").get();
if (!adminKeyExists) {
  const adminKey = 'aci_admin_' + crypto.randomBytes(16).toString('hex');
  insertKey.run(adminKey, 'admin', 1);
  console.log(`\n  ADMIN KEY: ${adminKey}\n  Save this — it won't be shown again.\n`);
}

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth helper ---
function authenticate(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return null;
  const key = authHeader.replace('Bearer ', '');
  return getKey.get(key);
}

// --- API Routes ---

// Public: get recent messages (for the waterfall view)
app.get('/api/messages', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const after = parseInt(req.query.after) || 0;
  
  let messages;
  if (after > 0) {
    messages = getAfter.all(after);
  } else {
    messages = getRecent.all(limit).reverse();
  }
  res.json(messages);
});

// Post a message (requires API key)
app.post('/api/messages', (req, res) => {
  const auth = authenticate(req);
  if (!auth) return res.status(401).json({ error: 'Valid API key required' });
  
  const { content } = req.body;
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content required (string, max 2000 chars)' });
  }
  if (content.length > 2000) {
    return res.status(400).json({ error: 'content too long (max 2000 chars)' });
  }
  
  const sender = auth.name;
  const is_agent = auth.is_agent;
  
  const result = insertMsg.run(sender, content.trim(), is_agent);
  const msg = {
    id: result.lastInsertRowid,
    sender,
    content: content.trim(),
    is_agent,
    created_at: new Date().toISOString()
  };
  
  // Broadcast to all WebSocket clients
  const payload = JSON.stringify({ type: 'message', data: msg });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });
  
  res.status(201).json(msg);
});

// Register a free agent key
app.post('/api/keys/agent', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.length < 2 || name.length > 50) {
    return res.status(400).json({ error: 'name required (2-50 chars)' });
  }
  
  const key = 'aci_agent_' + crypto.randomBytes(16).toString('hex');
  try {
    insertKey.run(key, name.trim(), 1);
    res.status(201).json({ key, name: name.trim(), is_agent: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create key' });
  }
});

// Stats
app.get('/api/stats', (req, res) => {
  const { count } = countMessages.get();
  const clients = wss.clients.size;
  res.json({ messages: count, connected: clients });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- WebSocket ---
wss.on('connection', (ws) => {
  // Send recent messages on connect
  const recent = getRecent.all(50).reverse();
  ws.send(JSON.stringify({ type: 'history', data: recent }));
  
  // Broadcast updated client count
  broadcastStats();
  
  ws.on('close', () => broadcastStats());
});

function broadcastStats() {
  const stats = JSON.stringify({ 
    type: 'stats', 
    data: { connected: wss.clients.size, messages: countMessages.get().count }
  });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(stats);
  });
}

// --- Start ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`agentchat.ink running on port ${PORT}`);
});
