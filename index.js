import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import querystring from 'querystring';

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

const authBase = ENVIRONMENT === 'sandbox'
  ? 'https://sandbox.qbo.intuit.com'
  : 'https://app.qbo.intuit.com';

// Step 1: Redirect user to QuickBooks login
app.get('/connect', (req, res) => {
  const scope = 'com.intuit.quickbooks.accounting';
  const redirect = `${authUrl}?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scope}&state=12345`;
  res.redirect(redirect);
});

// Step 2: Handle QuickBooks callback
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
    console.log('✅ Access Token:', tokens.access_token);
    console.log('🛠 Refresh Token:', tokens.refresh_token);

    res.send('Authorization complete. Tokens received. ✅');
  } catch (err) {
    console.error('❌ Token exchange failed:', err.response?.data || err.message);
    res.status(500).send('Auth failed');
  }
});

// Optional: webhook test endpoint
app.post('/webhooks/qbo', (req, res) => {
  console.log('✅ Webhook received:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('QBO Webhook App is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
