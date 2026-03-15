const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const url = require('url');

// --- CLI options ---
function getArg(flags) {
  for (const flag of flags) {
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  }
  return null;
}
const hasFlag = (flags) => flags.some(f => process.argv.includes(f));

const port = parseInt(getArg(['--port']) || '16000', 10);
const useAuth = hasFlag(['--auth']);
const useSSL = hasFlag(['--ssl']);
const sslCert = getArg(['--ssl-cert']);
const sslKey = getArg(['--ssl-key']);
const startCwd = getArg(['-w', '--cwd']) || process.env.HOME;

// --- Auth setup (only with --auth) ---
let db, JWT_SECRET, verifyToken;

let authMissingSecret = false;

if (useAuth) {
  JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    authMissingSecret = true;
  } else {
    const bcrypt = require('bcryptjs');
    const jwt = require('jsonwebtoken');
    const Database = require('better-sqlite3');

    db = new Database(path.join(__dirname, 'foxtty.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    )`);

    const JWT_EXPIRES = '1d';

    verifyToken = (token) => {
      try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
    };

    global._auth = { db, jwt, bcrypt, JWT_SECRET, JWT_EXPIRES };
  }
}

// --- Express ---
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/api/config', (req, res) => {
  res.json({ auth: useAuth, missingSecret: authMissingSecret });
});

if (useAuth && !authMissingSecret) {
  const { db, jwt, bcrypt, JWT_SECRET, JWT_EXPIRES } = global._auth;

  app.get('/api/status', (req, res) => {
    const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    res.json({ hasUsers: count > 0 });
  });

  app.post('/api/register', (req, res) => {
    const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    if (count > 0) {
      return res.status(403).json({ error: 'Registration closed. Users already exist.' });
    }
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required.' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters.' });
    }
    const hash = bcrypt.hashSync(password, 10);
    try {
      db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    } catch (e) {
      return res.status(409).json({ error: 'Username already exists.' });
    }
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ token });
  });

  app.get('/api/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ valid: false });
    }
    const token = authHeader.slice(7);
    if (verifyToken(token)) {
      res.json({ valid: true });
    } else {
      res.status(401).json({ valid: false });
    }
  });

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required.' });
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ token });
  });
}

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store');
  },
}));

let server;
if (useSSL) {
  const certPath = sslCert || path.join(__dirname, 'certs', 'cert.pem');
  const keyPath = sslKey || path.join(__dirname, 'certs', 'key.pem');
  server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app);
} else {
  server = http.createServer(app);
}
const wss = new WebSocketServer({ noServer: true });

// WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  if (useAuth && !authMissingSecret) {
    const parsed = url.parse(req.url, true);
    const token = parsed.query.token;
    if (!verifyToken(token)) {
      // Complete the upgrade, then close with 4001 so client knows auth failed
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(4001, 'Unauthorized');
      });
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// --- Multi-tab session management ---
const MAX_SCROLLBACK = 100000;
const sessions = new Map();
let nextId = 1;

function createSession() {
  const id = String(nextId++);
  const shell = process.env.SHELL || '/bin/bash';
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: startCwd,
    env: { ...process.env, PS1: '$ ' },
  });

  const session = { id, pty: ptyProcess, alive: true, scrollback: '' };
  sessions.set(id, session);

  ptyProcess.onData((data) => {
    session.scrollback += data;
    if (session.scrollback.length > MAX_SCROLLBACK) {
      session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK);
    }
    for (const client of wss.clients) {
      if (client.readyState === 1 && client._tabId === id) {
        try { client.send(JSON.stringify({ type: 'output', data })); } catch (e) {}
      }
    }
  });

  ptyProcess.onExit(() => {
    session.alive = false;
    const msg = '\r\n[Shell exited]\r\n';
    session.scrollback += msg;
    for (const client of wss.clients) {
      if (client.readyState === 1 && client._tabId === id) {
        try { client.send(JSON.stringify({ type: 'output', data: msg })); } catch (e) {}
      }
    }
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        try { client.send(JSON.stringify({ type: 'tab-exited', id })); } catch (e) {}
      }
    }
  });

  return session;
}

createSession();

function getTabList() {
  return Array.from(sessions.values()).map(s => ({ id: s.id, alive: s.alive }));
}

wss.on('connection', (ws) => {
  ws._tabId = null;
  ws.send(JSON.stringify({ type: 'tab-list', tabs: getTabList() }));

  ws.on('message', (raw) => {
    const str = raw.toString('utf8');
    if (str.includes('\x00')) return;

    const trimmed = str.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let cmd;
      try { cmd = JSON.parse(trimmed); } catch (e) { return; }

      if (cmd.type === 'switch') {
        const session = sessions.get(cmd.id);
        if (session) {
          ws._tabId = cmd.id;
          ws.send(JSON.stringify({ type: 'scrollback', data: session.scrollback }));
          ws.send(JSON.stringify({ type: 'tab-list', tabs: getTabList() }));
        }
        return;
      }

      if (cmd.type === 'new-tab') {
        const session = createSession();
        ws._tabId = session.id;
        const list = JSON.stringify({ type: 'tab-list', tabs: getTabList() });
        for (const client of wss.clients) {
          if (client.readyState === 1) {
            try { client.send(list); } catch (e) {}
          }
        }
        ws.send(JSON.stringify({ type: 'switched', id: session.id }));
        return;
      }

      if (cmd.type === 'close-tab') {
        const session = sessions.get(cmd.id);
        if (session) {
          if (session.alive) session.pty.kill();
          sessions.delete(cmd.id);
          if (ws._tabId === cmd.id) ws._tabId = null;
          const list = JSON.stringify({ type: 'tab-list', tabs: getTabList() });
          for (const client of wss.clients) {
            if (client.readyState === 1) {
              try { client.send(list); } catch (e) {}
            }
          }
        }
        return;
      }

      if (cmd.type === 'resize') {
        const session = sessions.get(ws._tabId);
        if (session && session.alive) session.pty.resize(cmd.cols, cmd.rows);
        return;
      }

      if (cmd.type === 'input') {
        const session = sessions.get(ws._tabId);
        if (session && session.alive) session.pty.write(cmd.data);
        return;
      }

      return;
    }

    const session = sessions.get(ws._tabId);
    if (session && session.alive) session.pty.write(str);
  });
});

server.listen(port, () => {
  const scheme = useSSL ? 'https' : 'http';
  console.log(`Server running at ${scheme}://localhost:${port}${useAuth ? ' (auth enabled)' : ''}`);
});
