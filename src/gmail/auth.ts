/**
 * Gmail OAuth — one-time consent to mint a durable refresh token.
 *
 * Reader scope: READ-ONLY (gmail.readonly), matching the design — the Gmail
 * reader never writes or sends. Run once: `npm run gmail:auth`. It opens a
 * browser, you click "Allow", and the refresh token is saved to
 * .tokens/gmail.json (gitignored). The fetch script reuses that token forever;
 * you only re-run this if the token is revoked.
 */
import 'dotenv/config';
import { google } from 'googleapis';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const TOKEN_PATH = '.tokens/gmail.json';
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET in .env');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline', // ask Google for a refresh token
  prompt: 'consent', // force it even on a repeat run
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/oauth2callback')) {
    res.writeHead(404).end();
    return;
  }
  const code = new URL(req.url, REDIRECT_URI).searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('No code in callback.');
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    mkdirSync(dirname(TOKEN_PATH), { recursive: true });
    writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Gmail connected. You can close this tab and return to the terminal.');
    console.log(`\n✓ Saved refresh token → ${TOKEN_PATH}`);
    if (!tokens.refresh_token) {
      console.warn(
        '⚠ No refresh_token returned. Revoke the app at https://myaccount.google.com/permissions and re-run.',
      );
    }
    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500).end('Token exchange failed — see terminal.');
    console.error('Token exchange failed:', err);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`Redirect URI in use: ${REDIRECT_URI}`);
  console.log('Opening browser for Google consent…\n');
  console.log(`If it does not open, paste this URL manually:\n${authUrl}\n`);
  spawn('open', [authUrl]); // macOS
});
