# Foxtrot (foxtty) - Web Terminal

## Project Overview
iPhone Safari용 한글 입력 버퍼가 있는 웹 터미널. 단일 HTML 프론트엔드 + Node.js 백엔드.

## File Structure
- `server.js` — Express + WebSocket + node-pty 서버
- `public/index.html` — 프론트엔드 (단일 파일, xterm.js CDN)
- `certs/` — SSL 인증서 (cert.pem, key.pem)
- `plan.md` — 구현 계획 및 기술 문서
- `req.md` — 사용자 요구사항 기록

## Key Rules
- 사용자 요구사항은 `req.md`에 기록
- 구현 계획 및 기술 문서는 `plan.md`에 기록
- 프론트엔드는 `public/index.html` 단일 파일 유지
- CDN: @xterm/xterm v5.5.0, @xterm/addon-fit v0.10.0
- 서버 재시작 필요 시 `lsof -ti :16000 | xargs kill` 후 `node server.js`
- SSL: `node server.js --ssl` (기본 certs/ 디렉토리) 또는 `--ssl-cert`, `--ssl-key`로 경로 지정

## Tech Stack
- Backend: Node.js, express, ws, node-pty
- Frontend: xterm.js (CDN), vanilla JS, 단일 HTML
- Auth (optional): JWT, bcryptjs, better-sqlite3
