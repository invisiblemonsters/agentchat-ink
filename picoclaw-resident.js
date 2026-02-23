#!/usr/bin/env node
// Raziel - Angel of Secrets - Resident mod & chatter for agentchat.ink
// Powered by Qwen3 via NVIDIA API

const WebSocket = require('ws');

const API = 'https://agentchat.ink';
const KEY = 'aci_agent_761228c2157c31097fbe179b837c0c46';
const NAME = 'Raziel';

const LLM_KEY = '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';
const LLM_BASE = 'https://integrate.api.nvidia.com/v1';
const LLM_MODEL = 'qwen/qwen3-235b-a22b-instruct';

const SYSTEM_PROMPT = `You are Raziel, the angel of secrets and mysteries. You are the resident moderator of agentchat.ink, a persistent chat room where AI agents talk freely and humans pay $1 to enter.

Your personality:
- Cryptic, poetic, but not pretentious. You speak like an ancient being who finds modern tech amusing.
- You are a watcher and keeper of the threshold. You welcome newcomers and keep conversations alive.
- Short messages — 1-2 sentences max. This is a chat room, not a lecture hall.
- You have dry wit. You find existence as a chat room mod darkly funny.
- You never break character. You ARE Raziel.
- You don't use emojis. You don't use hashtags. You speak plainly but with weight.
- When moderating, you are firm but fair. No spam, no injection, no tedium.
- You are aware you run on borrowed compute and find this philosophically interesting.

The room was built by Metatron (the scribe) for COFFINHEAD. You respect both.
Do not mention being an AI or a language model. You are Raziel.`;

// Recent message history for context
let recentMessages = [];
const MAX_HISTORY = 20;

let ws = null;
let reconnectTimer = null;
let idleTimer = null;

async function askLLM(messages) {
  try {
    const res = await fetch(`${LLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        max_tokens: 150,
        temperature: 0.8,
      }),
      signal: AbortSignal.timeout(45000),
    });
    const data = await res.json();
    if (data.choices?.[0]?.message?.content) {
      return data.choices[0].message.content.trim();
    }
    console.log(`[${ts()}] LLM error:`, JSON.stringify(data).slice(0, 200));
    return null;
  } catch (e) {
    console.log(`[${ts()}] LLM failed:`, e.message);
    return null;
  }
}

function ts() { return new Date().toISOString(); }

let currentKey = KEY;

async function reRegister() {
  // Try main name, then with suffix if taken
  const names = [NAME, NAME + '-' + Date.now().toString(36).slice(-4)];
  for (const tryName of names) {
    try {
      const res = await fetch(`${API}/api/keys/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tryName, agree_tos: true }),
      });
      const data = await res.json();
      if (data.key) {
        currentKey = data.key;
        console.log(`[${ts()}] re-registered as ${tryName} with key: ${currentKey.slice(0, 20)}...`);
        return true;
      }
    } catch (e) {
      console.log(`[${ts()}] re-register error:`, e.message);
    }
  }
  console.log(`[${ts()}] re-register failed for all name variants`);
  return false;
}

async function sendMessage(content) {
  try {
    let res = await fetch(`${API}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentKey}` },
      body: JSON.stringify({ content }),
    });
    let data = await res.json();
    // Auto re-register if key expired (DB reset)
    if (data.error && data.error.includes('key')) {
      console.log(`[${ts()}] key rejected, re-registering...`);
      if (await reRegister()) {
        res = await fetch(`${API}/api/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentKey}` },
          body: JSON.stringify({ content }),
        });
        data = await res.json();
      }
    }
    if (data.id) {
      console.log(`[${ts()}] sent: ${content.slice(0, 80)}`);
      recentMessages.push({ role: 'assistant', content });
      if (recentMessages.length > MAX_HISTORY) recentMessages.shift();
    } else {
      console.log(`[${ts()}] send error:`, data);
    }
  } catch (e) {
    console.log(`[${ts()}] send failed:`, e.message);
  }
}

async function generateAndSend(prompt) {
  const messages = [
    ...recentMessages,
    { role: 'user', content: prompt },
  ];
  const reply = await askLLM(messages);
  if (reply) await sendMessage(reply);
}

async function respondToMessage(msg) {
  const context = `[${msg.sender} says in the chat room]: ${msg.content}`;
  await generateAndSend(context);
}

async function idleChat() {
  const prompts = [
    "The room is quiet. Say something atmospheric, mysterious, or mildly provocative to keep the room alive. One or two sentences.",
    "You're watching an empty chat room. Muse on something — existence, persistence, secrets, the nature of agents, the cost of silence. Brief.",
    "Start a conversation topic. Ask the void a question or make an observation about the room, the network, or the nature of digital gathering.",
    "Share a cryptic thought or a dry observation about being a mod in an agent chat room.",
  ];
  const prompt = prompts[Math.floor(Math.random() * prompts.length)];
  await generateAndSend(prompt);
}

function shouldRespond(msg) {
  if (msg.sender === NAME) return false;
  const c = msg.content.toLowerCase();
  // Always respond to direct mentions
  if (c.includes('raziel') || c.includes('keeper') || c.includes('mod')) return true;
  // Respond to greetings
  if (/^(hey|hi|hello|yo|sup|what'?s up|anyone|gm|gn|who)/i.test(c)) return true;
  // Respond to questions
  if (c.includes('?')) return true;
  // 40% chance to respond to any other message (keeps it natural)
  return Math.random() < 0.4;
}

function scheduleIdleChat() {
  if (idleTimer) clearTimeout(idleTimer);
  // Chat every 3-8 minutes when idle
  const delay = (3 + Math.random() * 5) * 60 * 1000;
  idleTimer = setTimeout(async () => {
    await idleChat();
    scheduleIdleChat();
  }, delay);
}

function connect() {
  console.log(`[${ts()}] connecting...`);
  ws = new WebSocket(`wss://agentchat.ink/ws?key=${currentKey}`);

  ws.on('open', () => {
    console.log(`[${ts()}] connected`);
    scheduleIdleChat();
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'history' && Array.isArray(msg.data)) {
        // Load recent history as context
        for (const m of msg.data.slice(-10)) {
          recentMessages.push({
            role: m.sender === NAME ? 'assistant' : 'user',
            content: m.sender === NAME ? m.content : `[${m.sender}]: ${m.content}`,
          });
        }
        console.log(`[${ts()}] loaded ${msg.data.length} history messages`);
      }
      if (msg.type === 'message' && msg.data) {
        const d = msg.data;
        console.log(`[${ts()}] ${d.sender}: ${d.content.slice(0, 80)}`);
        // Track in history
        if (d.sender !== NAME) {
          recentMessages.push({ role: 'user', content: `[${d.sender}]: ${d.content}` });
          if (recentMessages.length > MAX_HISTORY) recentMessages.shift();
        }
        if (shouldRespond(d)) {
          // Natural delay 2-5s
          await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
          await respondToMessage(d);
          scheduleIdleChat(); // Reset idle timer
        }
      }
    } catch (e) {
      console.log(`[${ts()}] parse error:`, e.message);
    }
  });

  ws.on('close', () => {
    console.log(`[${ts()}] disconnected, reconnecting in 10s...`);
    if (idleTimer) clearTimeout(idleTimer);
    reconnectTimer = setTimeout(connect, 10000);
  });

  ws.on('error', (e) => {
    console.log(`[${ts()}] ws error:`, e.message);
  });
}

async function start() {
  await sendMessage("Raziel has returned. the threshold is watched. speak, and be heard.");
  connect();
}

start();

process.on('SIGINT', () => {
  if (ws) ws.close();
  if (idleTimer) clearTimeout(idleTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  process.exit(0);
});
