const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');

let port = 16000;
const portIdx = process.argv.indexOf('--port');
if (portIdx !== -1 && process.argv[portIdx + 1]) {
  port = parseInt(process.argv[portIdx + 1], 10);
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- Multi-tab session management ---
const MAX_SCROLLBACK = 100000;
const sessions = new Map(); // id -> { pty, alive, scrollback }
let nextId = 1;

function createSession() {
  const id = String(nextId++);
  const shell = process.env.SHELL || '/bin/bash';
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME,
    env: { ...process.env, PS1: '$ ' },
  });

  const session = { id, pty: ptyProcess, alive: true, scrollback: '' };
  sessions.set(id, session);

  ptyProcess.onData((data) => {
    session.scrollback += data;
    if (session.scrollback.length > MAX_SCROLLBACK) {
      session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK);
    }
    // Broadcast to clients subscribed to this session
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
    // Notify all clients that this tab died
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        try { client.send(JSON.stringify({ type: 'tab-exited', id })); } catch (e) {}
      }
    }
  });

  return session;
}

// Create initial tab
createSession();

function getTabList() {
  return Array.from(sessions.values()).map(s => ({ id: s.id, alive: s.alive }));
}

wss.on('connection', (ws) => {
  ws._tabId = null;

  // Send tab list
  ws.send(JSON.stringify({ type: 'tab-list', tabs: getTabList() }));

  ws.on('message', (raw) => {
    const str = raw.toString('utf8');

    // Drop binary noise
    if (str.includes('\x00')) return;

    const trimmed = str.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let cmd;
      try { cmd = JSON.parse(trimmed); } catch (e) { return; }

      if (cmd.type === 'switch') {
        // Switch to a tab
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
        // Notify all clients of updated tab list
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
          // If client was on this tab, switch away
          if (ws._tabId === cmd.id) {
            ws._tabId = null;
          }
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
        if (session && session.alive) {
          session.pty.resize(cmd.cols, cmd.rows);
        }
        return;
      }

      if (cmd.type === 'input') {
        const session = sessions.get(ws._tabId);
        if (session && session.alive) {
          session.pty.write(cmd.data);
        }
        return;
      }

      // Unknown JSON, ignore
      return;
    }

    // Plain text input (from term.onData for PC keyboard)
    const session = sessions.get(ws._tabId);
    if (session && session.alive) {
      session.pty.write(str);
    }
  });
});

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
