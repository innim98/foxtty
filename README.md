# Foxtrot

Web terminal with a Korean input buffer. Designed to work around unstable Korean IME behavior in mobile browsers (especially iPhone Safari) when interacting directly with xterm.js.

## Features

- **Korean input buffer** — Stable Hangul IME composition via a standard `<input>` field
- **Persistent session** — Shell stays alive across browser reconnects
- **Special keys toolbar** — ESC, TAB, Ctrl combos, arrow keys, function keys, and more
- **Mobile optimized** — Virtual keyboard doesn't push content off screen
- **Dark theme** — Terminal-native look and feel

## Quick Start

```bash
npm install
node server.js
```

Open `http://localhost:16000` in your browser.

### Options

```bash
node server.js --port 8080   # Use a custom port
```

## Tech Stack

- **Backend**: Node.js, Express, ws, node-pty
- **Frontend**: xterm.js (CDN), single HTML file

## License

MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
