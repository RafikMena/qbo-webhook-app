import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import querystring from 'querystring';
import { connectToMongo } from './mongo.js';
import fs from 'fs';

dotenv.config();
const app = express();
app.use(express.json());

const {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  ENVIRONMENT
} = process.env;

const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const authUrl = 'https://appcenter.intuit.com/connect/oauth2';

const apiBase = ENVIRONMENT === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';

console.log(`🛍 QBO Mode: ${ENVIRONMENT}`);

function normalizeProductName(raw) {
  if (!raw) return '';
  const input = raw.toLowerCase().trim();
  const aliasMap = [
    { pattern: /\b(87|unl|regular)\b/, normalized: '87' },
    { pattern: /\b(89)\b/, normalized: '89' },
    { pattern: /\b(91|premium)\b/, normalized: '91' },
    { pattern: /\b(rd99|renewable\s*diesel|rd\s*99)\b/, normalized: 'RD99' },
    { pattern: /\b(b20)\b/, normalized: 'B20' },
    { pattern: /\b(carb\s*diesel)\b/, normalized: 'CARB Diesel' },
  ];
  for (const { pattern, normalized } of aliasMap) {
    if (pattern.test(input)) return normalized;
  }
  return raw.trim();
}

function readTokens() {
  return JSON.parse(fs.readFileSync('./tokens.json', 'utf8'));
}

async function refreshTokens(refresh_token) {
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const response = await axios.post(tokenUrl, querystring.stringify({
    grant_type: 'refresh_token',
    refresh_token
  }), {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  const updated = response.data;
  const current = readTokens();
  const newData = {
    ...current,
    access_token: updated.access_token,
    refresh_token: updated.refresh_token || current.refresh_token
  };

  fs.writeFileSync('./tokens.json', JSON.stringify(newData, null, 2));
  console.log('🔄 Access token refreshed.');
  return newData.access_token;
}

app.get('/connect', (req, res) => {
  const scope = 'com.intuit.quickbooks.accounting';
  const redirect = `${authUrl}?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scope}&state=12345`;
  res.redirect(redirect);
});

app.get('/callback', async (req, res) => {
  const authCode = req.query.code;
  try {
    const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    const response = await axios.post(tokenUrl, querystring.stringify({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: REDIRECT_URI
    }), {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const tokens = response.data;
    res.send('Authorization complete. Tokens received. ✅');
  } catch (err) {
    console.error('❌ Token exchange failed:', err.response?.data || err.message);
    res.status(500).send('Auth failed');
  }
});
