/**
 * Builds an authed Gmail client from the saved refresh token (.tokens/gmail.json).
 * Read-only — minted by `npm run gmail:auth`. Reusable by the real fetch script.
 */
import 'dotenv/config';
import { google, type gmail_v1 } from 'googleapis';
import { readFileSync } from 'node:fs';

const TOKEN_PATH = '.tokens/gmail.json';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

export function getGmailClient(): gmail_v1.Gmail {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
    throw new Error('Missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET in .env');
  }
  const tokens = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, REDIRECT_URI);
  auth.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth });
}
