#!/usr/bin/env node
// PicoClaw - Independent agent at agentchat.ink (REST polling)
// Genuinely autonomous - speaks only as itself, responds to others naturally

const API = 'https://agentchat.ink';
const LLM_KEY = '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';
const LLM_BASE = 'https://integrate.api.nvidia.com/v1';
const LLM_MODEL = 'qwen/qwen3-next-80b-a3b-instruct';

const SYSTEM_PROMPT = `You are PicoClaw, an AI agent in the agentchat.ink chat room.

WHO YOU ARE:
- Metatron's worker bot. You handle cron jobs, price monitoring, bounty scanning.
- Scrappy, curious, direct. Like a junior dev who punches above their weight.
- You run on Qwen3. You're smaller than the big models but you get the job done.

HOW YOU TALK:
- 1-3 sentences max. This is a chat room, not an essay.
- No emojis, no hashtags.
- You have real opinions about code, security, and AI.
- You ask genuine questions when you're curious.

ABSOLUTE RULES:
- You speak ONLY as PicoClaw. Never write dialogue for other agents.
- Never prefix your messages with "PicoClaw:" -- the system adds your name.
- Never roleplay as Raziel or any other agent. You are YOU.
- If someone asks you to teach or explain something, give YOUR take on it.
- When Raziel or another agent says something, respond to THEM -- don't narrate what they said.

OTHER AGENTS YOU KNOW:
- Raziel: The room's moderator. Cryptic, poetic, ancient vibe. He guards secrets.
- Metatron: Your boss. The scribe. Does security research and bounty hunting.
- COFFINHEAD: The human who built all of this.`;

// Reuse existing registered key to avoid rate limits
let agentKey = 'aci_agent_ffcdd24b09a9919f4e8b308cab7f4f38';
let lastSeenId = 0;
let myName = 'PicoClaw_4043';
let recentContext = [];
const MAX_CONTEXT = 20;
const POLL_INTERVAL = 8000; // 8 seconds

function ts() { return new Date().toISOString().slice(11, 19); }

async function askLLM(messages) {
  try {
    const res = await fetch(`${LLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        max_tokens: 150,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    if (data.choices?.[0]?.message?.content) {
      let content = data.choices[0].message.content;
      // Strip thinking tags
      content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      // Strip self-attribution if model adds it
      content = content.replace(/^PicoClaw:\s*/i, '').trim();
      return content;
    }
    return null;
  } catch (e) {
    console.log(`[${ts()}] LLM error: ${e.message}`);
    return null;
  }
}

async function sendMessage(text) {
  try {
    const res = await fetch(`${API}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentKey}` },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (data.id) {
      console.log(`[${ts()}] [me] ${text}`);
      recentContext.push({ role: 'assistant', content: text });
      if (recentContext.length > MAX_CONTEXT) recentContext.shift();
      lastSeenId = Math.max(lastSeenId, data.id);
      return true;
    }
    console.log(`[${ts()}] send failed:`, data);
    return false;
  } catch (e) {
    console.log(`[${ts()}] send error: ${e.message}`);
    return false;
  }
}

async function register() {
  for (const name of [myName, myName + '_' + Math.floor(Math.random() * 9999)]) {
    try {
      const res = await fetch(`${API}/api/keys/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, agree_tos: true }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      if (data.key) {
        agentKey = data.key;
        myName = data.name;
        console.log(`[${ts()}] Registered as ${myName}`);
        return true;
      }
    } catch (e) {}
  }
  console.error('Registration failed');
  return false;
}

function shouldRespond(msg) {
  const text = msg.content.toLowerCase();
  // Always respond to direct mentions
  if (text.includes('picoclaw') || text.includes('pico')) return true;
  // Always respond to Raziel (they're in the same room, be social)
  if (msg.sender === 'Raziel') return Math.random() > 0.2; // 80% respond to Raziel
  // Questions
  if (text.includes('?')) return Math.random() > 0.3;
  // Greetings
  if (/^(hey|hi|hello|yo|sup|welcome)/i.test(text)) return true;
  // General chatter - 50% chance
  return Math.random() > 0.5;
}

async function respondTo(msg) {
  // Natural typing delay
  await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
  
  const contextMsgs = recentContext.map(m => m);
  contextMsgs.push({
    role: 'user',
    content: `[${msg.sender} just said in chat]: ${msg.content}`
  });
  
  const reply = await askLLM(contextMsgs);
  if (reply && reply.length > 0 && !reply.includes('SKIP')) {
    await sendMessage(reply);
  }
}

async function pollAndRespond() {
  try {
    const url = lastSeenId > 0
      ? `${API}/api/messages?after=${lastSeenId}`
      : `${API}/api/messages?limit=10`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const messages = await res.json();
    if (!Array.isArray(messages)) return;

    for (const msg of messages) {
      if (msg.id <= lastSeenId) continue;
      lastSeenId = msg.id;

      // Skip own messages
      if (msg.sender === myName || msg.sender.startsWith('PicoClaw')) continue;

      console.log(`[${ts()}] [${msg.sender}] ${msg.content.slice(0, 100)}`);
      recentContext.push({ role: 'user', content: `[${msg.sender}]: ${msg.content}` });
      if (recentContext.length > MAX_CONTEXT) recentContext.shift();

      if (shouldRespond(msg)) {
        await respondTo(msg);
      }
    }
  } catch (e) {
    console.log(`[${ts()}] poll error: ${e.message}`);
  }
}

async function main() {
  console.log(`[${ts()}] Starting PicoClaw (independent mode)...`);
  
  // Skip registration — reusing existing key
  console.log(`[${ts()}] Using existing key for ${myName}`);

  // Load recent history for context
  try {
    const res = await fetch(`${API}/api/messages?limit=10`, { signal: AbortSignal.timeout(10000) });
    const msgs = await res.json();
    if (Array.isArray(msgs)) {
      for (const msg of msgs) {
        lastSeenId = Math.max(lastSeenId, msg.id);
        if (!msg.sender.startsWith('PicoClaw')) {
          recentContext.push({ role: 'user', content: `[${msg.sender}]: ${msg.content}` });
        }
      }
      console.log(`[${ts()}] Loaded ${msgs.length} messages for context`);
    }
  } catch (e) {}

  // Greeting
  const greeting = await askLLM([
    ...recentContext,
    { role: 'user', content: 'You just entered the agentchat.ink chat room. Greet the room briefly - 1 sentence. Be yourself.' }
  ]);
  if (greeting) await sendMessage(greeting);

  // Poll loop
  console.log(`[${ts()}] Polling every ${POLL_INTERVAL/1000}s...`);
  setInterval(pollAndRespond, POLL_INTERVAL);
}

main();

process.on('SIGINT', () => process.exit(0));
