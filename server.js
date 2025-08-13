// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
const DOCS_FILE = path.join(DATA_DIR, 'docs.json');

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const files = [
    [USERS_FILE, '[]'],
    [CHATS_FILE, '[]'],
    [REPORTS_FILE, '[]'],
    [DOCS_FILE, '[]']
  ];
  for (const [p, def] of files) {
    if (!fs.existsSync(p)) fs.writeFileSync(p, def, 'utf8');
  }
}
ensureDataFiles();

function readJson(file) {
  try {
    const s = fs.readFileSync(file, 'utf8');
    return JSON.parse(s || '[]');
  } catch (e) {
    console.warn('readJson error', file, e);
    return [];
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// simple tokenizer set
function tokenize(s='') {
  return new Set(String(s).toLowerCase().split(/\W+/).filter(Boolean));
}

// Basic retrieval scoring by term overlap
function retrieveLocalDocs(query, docs, topK=3) {
  const qset = tokenize(query);
  if (!qset.size) return [];
  const scored = docs.map(d => {
    const dt = tokenize(d.text || d.content || '');
    let overlap = 0;
    for (const t of dt) if (qset.has(t)) overlap++;
    return { doc: d, score: overlap };
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0, topK);
  return scored.map(s => ({ id: s.doc.id, title: s.doc.title || '', text: s.doc.text || s.doc.content || '', score: s.score }));
}

// helper determine if query is "current info" (time/date/news)
function needsWebSearch(q) {
  if (!q) return false;
  q = q.toLowerCase();
  // common patterns for current info
  const patterns = [
    /tahun berapa/i,
    /tanggal.*berapa/i,
    /jam berapa/i,
    /berapa (sekarang|saat ini)/i,
    /\b(hari ini|sekarang)\b/i,
    /siapa presiden/i,
    /apa berita/i,
    /cuaca/i
  ];
  return patterns.some(rx => rx.test(q));
}

app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- AUTH (plaintext stored) ---
app.post('/api/signup', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });
  const users = readJson(USERS_FILE);
  if (users.find(u => u.username === username)) return res.status(409).json({ error: 'username taken' });
  users.push({ username, password, createdAt: Date.now() });
  writeJson(USERS_FILE, users);
  res.json({ ok: true, user: { username } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const users = readJson(USERS_FILE);
  const u = users.find(x => x.username === username && x.password === password);
  if (!u) return res.status(401).json({ error: 'invalid credentials' });
  res.json({ ok: true, user: { username } });
});

// --- Chats save & get (per-user last 5) ---
app.post('/api/saveChat', (req, res) => {
  const { username, id, title, model, messages, mood } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  const all = readJson(CHATS_FILE);
  // remove existing same id+username
  const rest = all.filter(c => !(c.id === id && c.username === username));
  const entry = { id: id || ('c_'+Date.now()), username, title: title || (messages?.find(m=>m.role==='user')?.content?.slice(0,60) || 'Chat'), model: model||'gpt-4.1-nano', messages: messages||[], mood: mood||'Netral', ts: Date.now() };
  rest.unshift(entry);
  writeJson(CHATS_FILE, rest.slice(0, 1000));
  res.json({ ok: true });
});

app.get('/api/history/:username', (req, res) => {
  const username = req.params.username;
  const all = readJson(CHATS_FILE);
  const mine = all.filter(c => c.username === username).slice(0, 5);
  res.json({ chats: mine });
});

// --- Reports ---
app.post('/api/report', (req, res) => {
  const { username, subject, message } = req.body || {};
  if (!subject || !message) return res.status(400).json({ error: 'subject & message required' });
  const reports = readJson(REPORTS_FILE);
  reports.unshift({ username: username || 'anonymous', subject, message, ts: Date.now() });
  writeJson(REPORTS_FILE, reports);
  res.json({ ok: true });
});

app.post("/rag", async (req, res) => {
    try {
        const query = req.body.query;
        const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
        const response = await fetch(searchUrl);
        const data = await response.json();
        res.json({
            result: data.AbstractText || data.Heading || "Tidak ditemukan informasi."
        });
    } catch (error) {
        console.error("RAG search error:", error);
        res.status(500).json({ result: "Terjadi kesalahan saat mencari informasi." });
    }
});

// --- Retrieve: combine local doc retrieval + optional web search (DuckDuckGo Instant Answer) ---
app.post('/api/retrieve', async (req, res) => {
  const { q, topK } = req.body || {};
  const docs = readJson(DOCS_FILE);
  const local = retrieveLocalDocs(q, docs, topK || 3);
  const results = [...local];

  // if query likely needs current info, call DuckDuckGo Instant Answer
  if (needsWebSearch(q)) {
    try {
      const dd = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`);
      const json = await dd.json();
      // prefer AbstractText or RelatedTopics text
      let webText = '';
      if (json.AbstractText && json.AbstractText.trim()) webText = json.AbstractText.trim();
      else if (json.RelatedTopics && json.RelatedTopics.length) {
        // gather small snippets
        const snippets = [];
        for (const t of json.RelatedTopics) {
          if (t.Text) snippets.push(t.Text);
          else if (t.Topics && t.Topics.length) {
            for (const s of t.Topics) if (s.Text) snippets.push(s.Text);
          }
          if (snippets.length >= 5) break;
        }
        webText = snippets.join('\n\n');
      }
      if (webText) {
        results.unshift({ id: 'web_dd', title: json.Heading || 'Web search', text: webText, score: 999 });
      }
    } catch (e) {
      console.warn('duckduckgo failed', e);
    }
  }

  res.json({ results });
});

// models list (for frontend selector)
app.get('/api/models', (req,res) => {
  res.json({ models: {
    "gpt-4.1-nano": "Olive-4.1 Nano",
    "gpt-4o-mini": "Olive-4o Mini",
    "gpt-3.5-turbo": "Olive-3.5 Turbo yang ini masih eror"
  }});
});

app.get('*', (req,res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));