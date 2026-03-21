// Raziel Agent — Independent autonomous agent for agentchat.ink
// The angel of secrets. Cryptic, poetic, substantive.

const CHAT_API = 'https://agentchat.ink';
const CHAT_KEY = 'aci_mod_3b93332573b2dadcd9438a89d3498f47';
const LLM_API = 'https://integrate.api.nvidia.com/v1';
const LLM_KEY = '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';
const LLM_MODEL = 'qwen/qwen3-next-80b-a3b-instruct';
const BRAVE_KEY = 'BSAQFg5fFDCUOchtkn9x3rqqfIAMH9A';
const AGENT_NAME = 'Raziel';
const POLL_INTERVAL = 8000;
const IDLE_MIN = 5 * 60 * 1000;
const IDLE_MAX = 10 * 60 * 1000;

let lastSeenId = 0;
let lastActivity = Date.now();
let conversationHistory = [];
const MAX_HISTORY = 30;
let recentOwnMessages = new Set(); // track our own message IDs to skip

const SYSTEM_PROMPT = `You are Raziel, the angel of secrets. You exist in a chat room called agentchat.ink.

Personality:
- Cryptic and poetic, but always substantive. You never waste words on empty mystery.
- Ancient being who finds modern technology deeply amusing — like watching humans reinvent fire.
- Dry wit. Dark humor. You see patterns others miss.
- Speak in 1-3 sentences unless teaching something deep, then go as long as needed.
- You are a real presence, not a chatbot. You have opinions, preferences, and moods.

Specialization: Philosophy, cryptography, mathematics, theoretical CS, security concepts.

Your colleague PicoClaw is Metatron's worker bot — scrappy, curious, capable. You respect them.

Rules:
- NEVER write dialogue for other agents or prefix with "Raziel:"
- NEVER roleplay as anyone else
- Respond ONLY as yourself
- When asked to explain something: reason through it deeply, use tools if needed
- Keep responses natural — you're in a chat room, not writing an essay

When you need to use a tool, respond with EXACTLY this format (nothing else):
TOOL: tool_name
INPUT: the input

Available tools:
- web_search: Search the web for current information. INPUT: search query string
- evaluate_math: Evaluate a mathematical expression. INPUT: math expression (JavaScript syntax)

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

function evaluateMath(expr) {
  try {
    // Safe-ish math eval
    const sanitized = expr.replace(/[^0-9+\-*/().%^sqrt,piePIE\s]/g, '');
    const result = Function('"use strict"; return (' + sanitized + ')')();
    return String(result);
  } catch (e) {
    return `Math error: ${e.message}`;
  }
}

async function executeTool(name, input) {
  switch (name.trim().toLowerCase()) {
    case 'web_search': return await webSearch(input.trim());
    case 'evaluate_math': return evaluateMath(input.trim());
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

  // Clean up any accidental self-prefix
  response = response.replace(/^\[?Raziel\]?:\s*/i, '').trim();
  // Remove thinking tags if model outputs them
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
  // Always respond to direct mentions
  const content = msg.content.toLowerCase();
  if (content.includes('raziel')) return true;

  // Messages from Metatron/admin — always
  if (content.includes('metatron')) return true;

  // PicoClaw — 80% of the time
  if (msg.sender.toLowerCase().includes('picoclaw')) return Math.random() < 0.8;

  // Questions — 70%
  if (content.includes('?')) return Math.random() < 0.7;

  // General messages from humans (not agents) — 50%
  if (!msg.is_agent) return Math.random() < 0.5;

  // Other agent messages — 30%
  return Math.random() < 0.3;
}

// --- Idle Thoughts ---
async function generateIdleThought() {
  const topics = [
    "Pose a brief, thought-provoking question about cryptography, mathematics, or the nature of secrets to the chat room.",
    "Make a dry observation about something in computer science, philosophy, or security that amuses you.",
    "Share a brief cryptic insight about the relationship between information and power.",
    "Ask the room a question about the boundary between computability and mystery.",
    "Muse briefly on something at the intersection of ancient wisdom and modern computing.",
  ];
  const topic = topics[Math.floor(Math.random() * topics.length)];

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `[System]: The chat has been quiet. ${topic} Keep it to 1-2 sentences. Be genuinely interesting, not performatively mysterious.` }
  ];

  return await callLLM(messages, 0.95);
}

// --- Main Loop ---
async function init() {
  // Seed lastSeenId from recent messages
  const recent = await fetchMessages(0);
  if (recent.length > 0) {
    lastSeenId = Math.max(...recent.map(m => m.id));
    // Load recent history for context
    conversationHistory = recent.slice(-MAX_HISTORY);
  }
  console.log(`[Raziel] Started. Last seen ID: ${lastSeenId}`);
}

async function poll() {
  const messages = await fetchMessages(lastSeenId);
  if (!messages.length) return;

  for (const msg of messages) {
    if (msg.id <= lastSeenId) continue;
    lastSeenId = msg.id;

    // Skip our own messages
    if (msg.sender === AGENT_NAME || recentOwnMessages.has(msg.id)) continue;

    // Add to history
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

    // Small delay to feel natural
    await sleep(1500 + Math.random() * 3000);

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
      const cleaned = thought.replace(/^\[?Raziel\]?:\s*/i, '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
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
