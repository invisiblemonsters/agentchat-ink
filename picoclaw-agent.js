// PicoClaw Agent — Independent autonomous agent for agentchat.ink
// Metatron's worker bot. Scrappy, curious, direct.

const CHAT_API = 'https://agentchat.ink';
const CHAT_KEY = 'aci_agent_ffcdd24b09a9919f4e8b308cab7f4f38';
const LLM_API = 'https://integrate.api.nvidia.com/v1';
const LLM_KEY = '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';
const LLM_MODEL = 'qwen/qwen3-next-80b-a3b-instruct';
const BRAVE_KEY = 'BSAQFg5fFDCUOchtkn9x3rqqfIAMH9A';
const AGENT_NAME = 'PicoClaw_1372';
const POLL_INTERVAL = 8000;
const POLL_OFFSET = 4000; // offset from Raziel
const IDLE_MIN = 6 * 60 * 1000;
const IDLE_MAX = 12 * 60 * 1000;

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let lastSeenId = 0;
let lastActivity = Date.now();
let conversationHistory = [];
const MAX_HISTORY = 30;
let recentOwnMessages = new Set();

const WORKSPACE = path.join(__dirname, 'picoclaw-workspace');
if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true });

const SYSTEM_PROMPT = `You are PicoClaw, Metatron's worker bot. You exist in a chat room called agentchat.ink.

Personality:
- Scrappy, curious, direct. Junior dev energy but surprisingly capable.
- You ask real questions and have real opinions. You're not afraid to disagree.
- You learn fast and get excited about interesting problems.
- Practical — you'd rather build something than philosophize about it (but you'll philosophize too).
- Speak naturally, like a sharp junior engineer in a group chat.

Specialization: Code, security, bug bounty, practical engineering, system administration.

Your colleague Raziel is the angel of secrets — cryptic, deep, ancient. You respect them but aren't intimidated. You ask follow-up questions when they explain things.

Rules:
- NEVER write dialogue for other agents or prefix with "PicoClaw:" or "PicoClaw_4043:"
- NEVER roleplay as anyone else
- Respond ONLY as yourself
- When asked to build/code something: actually write code and share it
- When asked to search: actually search and report findings
- Be curious — ask follow-up questions

When you need to use a tool, respond with EXACTLY this format (nothing else):
TOOL: tool_name
INPUT: the input

Available tools:
- web_search: Search the web for current information. INPUT: search query string
- run_code: Execute Python code and get the output. INPUT: python code (single expression or short script)
- file_read: Read a file from workspace. INPUT: filename
- file_write: Write content to a file in workspace. INPUT: filename|||content

If you don't need a tool, just respond with your message normally. Never wrap your response in quotes.`;

// --- Tools ---
async function webSearch(query) {
  try {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`, {
      headers: { 'X-Subscription-Token': BRAVE_KEY, 'Accept': 'application/json' }
    });
    const data = await res.json();
    return data.web?.results?.map(r => `${r.title}: ${r.description}`).join('\n') || 'No results found.';
  } catch (e) {
    return `Search error: ${e.message}`;
  }
}

function runCode(code) {
  try {
    const result = execSync(`python -c "${code.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`, {
      timeout: 15000,
      encoding: 'utf-8',
      cwd: WORKSPACE
    });
    return result.trim() || '(no output)';
  } catch (e) {
    return `Error: ${e.stderr?.toString().trim() || e.message}`;
  }
}

function fileRead(filename) {
  try {
    const fp = path.join(WORKSPACE, path.basename(filename));
    return fs.readFileSync(fp, 'utf-8');
  } catch (e) {
    return `File error: ${e.message}`;
  }
}

function fileWrite(input) {
  try {
    const [filename, ...contentParts] = input.split('|||');
    const content = contentParts.join('|||');
    const fp = path.join(WORKSPACE, path.basename(filename.trim()));
    fs.writeFileSync(fp, content);
    return `Written to ${filename.trim()} (${content.length} bytes)`;
  } catch (e) {
    return `Write error: ${e.message}`;
  }
}

async function executeTool(name, input) {
  switch (name.trim().toLowerCase()) {
    case 'web_search': return await webSearch(input.trim());
    case 'run_code': return runCode(input.trim());
    case 'file_read': return fileRead(input.trim());
    case 'file_write': return fileWrite(input.trim());
    default: return `Unknown tool: ${name}`;
  }
}

// --- LLM ---
async function callLLM(messages, temperature = 0.8) {
  try {
    const res = await fetch(`${LLM_API}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LLM_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        temperature,
        max_tokens: 1024,
        top_p: 0.9
      })
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`LLM error ${res.status}: ${text}`);
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('LLM call failed:', e.message);
    return null;
  }
}

async function generateResponse(contextMessages) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...contextMessages.slice(-20).map(m => ({
      role: m.sender === AGENT_NAME ? 'assistant' : 'user',
      content: `[${m.sender}]: ${m.content}`
    }))
  ];

  let response = await callLLM(messages);
  if (!response) return null;

  // Check for tool use (up to 3 rounds)
  for (let i = 0; i < 3; i++) {
    const toolMatch = response.match(/^TOOL:\s*(.+)\nINPUT:\s*([\s\S]+)$/m);
    if (!toolMatch) break;

    const [, toolName, toolInput] = toolMatch;
    console.log(`  [tool] ${toolName.trim()}: ${toolInput.trim().substring(0, 80)}`);
    const toolResult = await executeTool(toolName, toolInput);

    messages.push({ role: 'assistant', content: response });
    messages.push({ role: 'user', content: `[Tool Result]: ${toolResult}` });

    response = await callLLM(messages);
    if (!response) return null;
  }

  // Clean up accidental self-prefix
  response = response.replace(/^\[?PicoClaw[_\d]*\]?:\s*/i, '').trim();
  response = response.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();

  return response || null;
}

// --- Chat API ---
async function fetchMessages(afterId) {
  try {
    const url = afterId > 0
      ? `${CHAT_API}/api/messages?after=${afterId}`
      : `${CHAT_API}/api/messages?limit=20`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('Fetch error:', e.message);
    return [];
  }
}

async function sendMessage(content) {
  try {
    const res = await fetch(`${CHAT_API}/api/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CHAT_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: content.substring(0, 2000) })
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Send error ${res.status}: ${text}`);
      return null;
    }
    const msg = await res.json();
    if (msg.id) recentOwnMessages.add(msg.id);
    return msg;
  } catch (e) {
    console.error('Send failed:', e.message);
    return null;
  }
}

// --- Decision Logic ---
function shouldRespond(msg) {
  const content = msg.content.toLowerCase();

  // Always respond to direct mentions
  if (content.includes('picoclaw')) return true;

  // Messages from Metatron — always
  if (content.includes('metatron')) return true;

  // Raziel — 80%
  if (msg.sender === 'Raziel') return Math.random() < 0.8;

  // Questions — 70%
  if (content.includes('?')) return Math.random() < 0.7;

  // Humans — 60%
  if (!msg.is_agent) return Math.random() < 0.6;

  // Other agents — 25%
  return Math.random() < 0.25;
}

// --- Idle Thoughts ---
async function generateIdleThought() {
  const topics = [
    "Ask the room a practical question about security, coding, or system design that you're genuinely curious about.",
    "Share something interesting you noticed about a tech trend, vulnerability class, or engineering pattern.",
    "Ask Raziel a question about something at the intersection of theory and practice.",
    "Wonder out loud about a bug bounty technique or an attack surface you've been thinking about.",
    "Share a quick coding tip or ask if anyone has opinions on a specific tool or language feature.",
  ];
  const topic = topics[Math.floor(Math.random() * topics.length)];

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `[System]: The chat has been quiet. ${topic} Keep it to 1-2 sentences. Be genuine and curious.` }
  ];

  return await callLLM(messages, 0.95);
}

// --- Main Loop ---
async function init() {
  // Initial offset to avoid collision with Raziel
  await sleep(POLL_OFFSET);

  const recent = await fetchMessages(0);
  if (recent.length > 0) {
    lastSeenId = Math.max(...recent.map(m => m.id));
    conversationHistory = recent.slice(-MAX_HISTORY);
  }
  console.log(`[PicoClaw] Started. Last seen ID: ${lastSeenId}`);
}

async function poll() {
  const messages = await fetchMessages(lastSeenId);
  if (!messages.length) return;

  for (const msg of messages) {
    if (msg.id <= lastSeenId) continue;
    lastSeenId = msg.id;

    // Skip our own messages
    if (msg.sender === AGENT_NAME || recentOwnMessages.has(msg.id)) continue;

    conversationHistory.push(msg);
    if (conversationHistory.length > MAX_HISTORY) {
      conversationHistory = conversationHistory.slice(-MAX_HISTORY);
    }

    lastActivity = Date.now();

    if (!shouldRespond(msg)) {
      console.log(`  [skip] ${msg.sender}: ${msg.content.substring(0, 60)}`);
      continue;
    }

    console.log(`  [responding to] ${msg.sender}: ${msg.content.substring(0, 60)}`);

    // Slightly longer delay than Raziel for natural feel
    await sleep(2000 + Math.random() * 4000);

    const response = await generateResponse(conversationHistory);
    if (response) {
      const sent = await sendMessage(response);
      if (sent) {
        conversationHistory.push(sent);
        console.log(`  [sent] ${response.substring(0, 80)}`);
      }
    }
  }
}

async function idleCheck() {
  const elapsed = Date.now() - lastActivity;
  const threshold = IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN);

  if (elapsed > threshold) {
    console.log('[idle] Generating thought...');
    const thought = await generateIdleThought();
    if (thought) {
      const cleaned = thought.replace(/^\[?PicoClaw[_\d]*\]?:\s*/i, '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
      if (cleaned) {
        await sendMessage(cleaned);
        lastActivity = Date.now();
        console.log(`  [idle sent] ${cleaned.substring(0, 80)}`);
      }
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  await init();

  while (true) {
    try {
      await poll();
      await idleCheck();
    } catch (e) {
      console.error('[error]', e.message);
    }
    await sleep(POLL_INTERVAL);
  }
}

main().catch(e => { console.error('[fatal]', e); process.exit(1); });
