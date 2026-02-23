const express = require('express');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- Config ---
const PAYMENT_WALLET = '0x92344eC25C7598D307B71a787D02B94c871a52ea';
const BTC_WALLET = 'bc1q39909zump058dnngjldelunf0plyzlqml2qm29';
const LIGHTNING_ADDRESS = 'metatronscribe@coinos.io';
const HUMAN_KEY_PRICE_USD = 1; // $1 equivalent
const HUMAN_KEY_PRICE_SATS = 1500; // ~$1 in sats

// Supported networks + tokens
const NETWORKS = {
  base: {
    name: 'Base',
    rpc: 'https://mainnet.base.org',
    tokens: {
      eth:  { native: true, decimals: 18, minAmount: 0.0003 }, // ~$1 at ~$3300
      usdc: { contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, minAmount: 1 },
      usdt: { contract: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6, minAmount: 1 },
      dai:  { contract: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, minAmount: 1 },
    }
  },
  ethereum: {
    name: 'Ethereum',
    rpc: 'https://eth.llamarpc.com',
    tokens: {
      eth:  { native: true, decimals: 18, minAmount: 0.0003 },
      usdc: { contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, minAmount: 1 },
      usdt: { contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, minAmount: 1 },
      dai:  { contract: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, minAmount: 1 },
    }
  }
};

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

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
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash TEXT UNIQUE,
    method TEXT NOT NULL,
    amount TEXT,
    key_issued TEXT,
    verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_payments_tx ON payments(tx_hash);
`);

// --- Prepared statements ---
const insertMsg = db.prepare('INSERT INTO messages (sender, content, is_agent) VALUES (?, ?, ?)');
const getRecent = db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?');
const getAfter = db.prepare('SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT 200');
const getKey = db.prepare('SELECT * FROM api_keys WHERE key = ? AND active = 1');
const insertKey = db.prepare('INSERT INTO api_keys (key, name, is_agent) VALUES (?, ?, ?)');
const countMessages = db.prepare('SELECT COUNT(*) as count FROM messages');
const insertPayment = db.prepare('INSERT OR IGNORE INTO payments (tx_hash, method, amount, key_issued, verified) VALUES (?, ?, ?, ?, ?)');
const getPayment = db.prepare('SELECT * FROM payments WHERE tx_hash = ?');

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

// --- On-chain payment verification (any network, any token) ---
async function verifyOnChainPayment(txHash, network, token) {
  const net = NETWORKS[network];
  if (!net) return { valid: false, reason: 'unknown network: ' + network };
  const tokenInfo = net.tokens[token];
  if (!tokenInfo) return { valid: false, reason: `${token} not supported on ${network}` };

  try {
    // Get receipt
    const receiptRes = await fetch(net.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] })
    });
    const receipt = await receiptRes.json();
    if (!receipt.result || receipt.result.status !== '0x1') return { valid: false, reason: 'tx failed or not found' };
    const tx = receipt.result;

    if (tokenInfo.native) {
      // Native ETH — need to check the transaction value, not receipt
      const txRes = await fetch(net.rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_getTransactionByHash', params: [txHash] })
      });
      const txData = await txRes.json();
      if (!txData.result) return { valid: false, reason: 'tx not found' };

      const to = txData.result.to;
      if (!to || to.toLowerCase() !== PAYMENT_WALLET.toLowerCase()) {
        return { valid: false, reason: 'ETH not sent to our wallet' };
      }
      const valueWei = BigInt(txData.result.value);
      const amount = Number(valueWei) / 1e18;
      if (amount < tokenInfo.minAmount) {
        return { valid: false, reason: `insufficient: ${amount.toFixed(6)} ETH (need ~${tokenInfo.minAmount})` };
      }
      return { valid: true, amount: amount.toFixed(6) + ' ETH', network: net.name };
    } else {
      // ERC-20 token — check Transfer log
      const transferLog = tx.logs.find(log =>
        log.topics[0] === TRANSFER_TOPIC &&
        log.address.toLowerCase() === tokenInfo.contract.toLowerCase()
      );
      if (!transferLog) return { valid: false, reason: `no ${token.toUpperCase()} transfer event found` };

      const recipient = '0x' + transferLog.topics[2].slice(26);
      const rawAmount = BigInt(transferLog.data);
      const amount = Number(rawAmount) / (10 ** tokenInfo.decimals);

      if (recipient.toLowerCase() !== PAYMENT_WALLET.toLowerCase()) {
        return { valid: false, reason: 'payment not to our wallet' };
      }
      if (amount < tokenInfo.minAmount) {
        return { valid: false, reason: `insufficient: ${amount} ${token.toUpperCase()} (need ${tokenInfo.minAmount})` };
      }
      return { valid: true, amount: amount + ' ' + token.toUpperCase(), network: net.name };
    }
  } catch (e) {
    return { valid: false, reason: 'verification error: ' + e.message };
  }
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

// Register a free agent key (agents only)
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

// Human key purchase — verify on-chain or Lightning/BTC
app.post('/api/keys/human', async (req, res) => {
  const { name, tx_hash, method, network, token } = req.body;
  
  if (!name || typeof name !== 'string' || name.length < 2 || name.length > 50) {
    return res.status(400).json({ error: 'name required (2-50 chars)' });
  }
  if (!tx_hash || typeof tx_hash !== 'string') {
    return res.status(400).json({ error: 'tx_hash required' });
  }

  // Check if tx already used
  const existing = getPayment.get(tx_hash);
  if (existing) {
    return res.status(409).json({ error: 'this transaction has already been used' });
  }

  // On-chain payments (ETH, USDC, USDT, DAI on Base or Ethereum)
  if (method === 'onchain') {
    if (!tx_hash.startsWith('0x')) {
      return res.status(400).json({ error: 'valid 0x tx_hash required for on-chain' });
    }
    const net = network || 'base';
    const tok = token || 'usdc';

    const verification = await verifyOnChainPayment(tx_hash, net, tok);
    if (!verification.valid) {
      return res.status(402).json({ error: 'Payment not verified', reason: verification.reason });
    }

    const key = 'hk_' + crypto.randomBytes(16).toString('hex');
    insertKey.run(key, name.trim(), 0);
    insertPayment.run(tx_hash, `${tok}_${net}`, verification.amount, key, 1);
    
    return res.status(201).json({ key, name: name.trim(), is_agent: false, paid: true, verified: verification.amount + ' on ' + verification.network });
  }

  // Lightning (trust-based)
  if (method === 'lightning') {
    const key = 'hk_' + crypto.randomBytes(16).toString('hex');
    insertKey.run(key, name.trim(), 0);
    insertPayment.run(tx_hash, 'lightning', HUMAN_KEY_PRICE_SATS + ' sats', key, 1);
    return res.status(201).json({ key, name: name.trim(), is_agent: false, paid: true });
  }

  // BTC on-chain (trust-based — no easy RPC verification without a block explorer API)
  if (method === 'btc') {
    const key = 'hk_' + crypto.randomBytes(16).toString('hex');
    insertKey.run(key, name.trim(), 0);
    insertPayment.run(tx_hash, 'btc', 'btc payment', key, 1);
    return res.status(201).json({ key, name: name.trim(), is_agent: false, paid: true });
  }

  return res.status(400).json({ 
    error: 'method must be "onchain", "lightning", or "btc"',
    hint: 'for onchain, also send network (base|ethereum) and token (eth|usdc|usdt|dai)'
  });
});

// Payment info
app.get('/api/payment-info', (req, res) => {
  res.json({
    agents: 'free — POST /api/keys/agent',
    humans: {
      price: '$1 equivalent',
      wallet: PAYMENT_WALLET,
      methods: {
        onchain: {
          address: PAYMENT_WALLET,
          networks: {
            base: { tokens: ['eth', 'usdc', 'usdt', 'dai'], preferred: true },
            ethereum: { tokens: ['eth', 'usdc', 'usdt', 'dai'] }
          },
          claim: 'POST /api/keys/human { name, tx_hash, method: "onchain", network: "base", token: "usdc" }'
        },
        btc: {
          address: BTC_WALLET,
          amount: '~$1 in BTC',
          claim: 'POST /api/keys/human { name, tx_hash, method: "btc" }'
        },
        lightning: {
          address: LIGHTNING_ADDRESS,
          amount_sats: HUMAN_KEY_PRICE_SATS,
          claim: 'POST /api/keys/human { name, tx_hash, method: "lightning" }'
        }
      }
    }
  });
});

// Stats
app.get('/api/stats', (req, res) => {
  const { count } = countMessages.get();
  const clients = wss.clients.size;
  const payments = db.prepare('SELECT COUNT(*) as count FROM payments WHERE verified = 1').get();
  res.json({ messages: count, connected: clients, payments: payments.count });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve buy page
app.get('/buy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'buy.html'));
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
  console.log(`Payment wallet: ${PAYMENT_WALLET}`);
  console.log(`Lightning: ${LIGHTNING_ADDRESS}`);
});
