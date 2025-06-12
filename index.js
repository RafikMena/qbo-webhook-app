import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import querystring from 'querystring';
import { connectToMongo } from './mongo.js';

import fs from 'fs';

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

  // Update the token file
  const current = readTokens();
  const newData = {
    ...current,
    access_token: updated.access_token,
    refresh_token: updated.refresh_token || current.refresh_token // use new if provided
  };

  fs.writeFileSync('./tokens.json', JSON.stringify(newData, null, 2));
  console.log('🔄 Access token refreshed.');

  return newData.access_token;
}

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

app.post('/webhooks/qbo', async (req, res) => {
  console.log('✅ Webhook received:', JSON.stringify(req.body, null, 2));
let { access_token: accessToken, refresh_token, realmId } = readTokens();

// Try the API call, refresh if token is invalid
try {
  const invoiceEvents = req.body.eventNotifications?.[0]?.dataChangeEvent?.entities || [];

  for (const event of invoiceEvents) {
    if (event.name === 'Invoice' && event.operation === 'Create') {
      const invoiceId = event.id;

      try {
        const response = await axios.get(
          `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/invoice/${invoiceId}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json'
            }
          }
        );

        const invoice = response.data;
        console.log('📄 Full Invoice:', JSON.stringify(invoice, null, 2));
      } catch (err) {
        if (err.response?.status === 401) {
          console.log('🔁 Token expired, refreshing...');
          accessToken = await refreshTokens(refresh_token);

          // Retry the request
          const retry = await axios.get(
            `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/invoice/${invoiceId}`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json'
              }
            }
          );

          const invoice = retry.data;
          console.log('📄 Full Invoice (after refresh):', JSON.stringify(invoice, null, 2));
        } else {
          throw err;
        }
      }
    }
  }

  res.sendStatus(200);
} catch (err) {
  console.error('❌ Failed to handle invoice event:', err.response?.data || err.message);
  res.status(500).send('Webhook failed');
}
});


app.get('/', (req, res) => {
  res.send('QBO Webhook App is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});



app.post('/api/quotes', async (req, res) => {
  const { customerName, customerEmail, siteAddress, date, products } = req.body;

  try {
    const db = await connectToMongo();

    // 1. Insert or get customer
    let customer = await db.collection('customers').findOne({ email: customerEmail });
    if (!customer) {
      const result = await db.collection('customers').insertOne({ name: customerName, email: customerEmail });
      customer = { _id: result.insertedId, name: customerName, email: customerEmail };
    }

    // 2. Insert or get site
    let site = await db.collection('sites').findOne({ customerId: customer._id, address: siteAddress });
    if (!site) {
      const result = await db.collection('sites').insertOne({ customerId: customer._id, address: siteAddress });
      site = { _id: result.insertedId, customerId: customer._id, address: siteAddress };
    }

    // 3. Insert quote
    await db.collection('quotes').insertOne({
      siteId: site._id,
      date,
      products
    });

    console.log(`✅ Quote stored for ${customerEmail} on ${date}`);
    res.status(200).send('Quote saved');
  } catch (err) {
    console.error('❌ Quote saving failed:', err.message);
    res.status(500).send('Failed to save quote');
  }
});


