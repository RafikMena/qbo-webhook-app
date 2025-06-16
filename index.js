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



const authUrl = 'https://appcenter.intuit.com/connect/oauth2'; // ✅ always correct

const apiBase = ENVIRONMENT === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';


console.log(`🧭 QBO Mode: ${ENVIRONMENT}`);


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
      console.log('🔍 Sending token request with:', {
        grant_type: 'authorization_code',
        code: authCode,
        redirect_uri: REDIRECT_URI
      });

      console.log('🧾 Headers:', {
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      });

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
    res.send('Authorization complete. Tokens received. ✅');
  } catch (err) {
    console.error('❌ Token exchange failed:', err.response?.data || err.message);
    res.status(500).send('Auth failed');
  }
});

// Webhook for QuickBooks invoice creation
app.post('/webhooks/qbo', async (req, res) => {
  console.log('📩 Raw headers:', req.headers);
  console.log('📩 Raw body:', JSON.stringify(req.body, null, 2));
  console.log('✅ Webhook received:', JSON.stringify(req.body, null, 2));
  let { access_token: accessToken, refresh_token, realmId } = readTokens();

  try {
    const invoiceEvents = req.body.eventNotifications?.[0]?.dataChangeEvent?.entities || [];

    for (const event of invoiceEvents) {
      if (event.name === 'Invoice' && event.operation === 'Create') {
        const invoiceId = event.id;
        let invoice;

        try {
          const response = await axios.get(`${apiBase}/v3/company/${realmId}/invoice/${invoiceId}`, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json'
            }
          });
          invoice = response.data;
        } catch (err) {
          if (err.response?.status === 401) {
            console.log('🔁 Token expired, refreshing...');
            accessToken = await refreshTokens(refresh_token);
            const retry = await axios.get(`${apiBase}/v3/company/${realmId}/invoice/${invoiceId}`, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json'
              }
            });
            invoice = retry.data;
          } else {
            throw err;
          }
        }

        const db = await connectToMongo();
        const customerName = invoice.Invoice.CustomerRef?.name;
        const siteAddress = invoice.Invoice.BillAddr?.Line1;
        const txnDate = invoice.Invoice.TxnDate;

        if (!customerName || !siteAddress || !txnDate) {
          console.warn('⚠️ Missing required fields in invoice:', { customerName, siteAddress, txnDate });
          continue;
        }

        const customer = await db.collection('customers').findOne({ name: customerName });
        if (!customer) {
          console.warn(`⚠️ No customer found for ${customerName}`);
          continue;
        }

        const site = await db.collection('sites').findOne({ customerId: customer._id, address: siteAddress });
        if (!site) {
          console.warn(`⚠️ No site found for address: ${siteAddress}`);
          continue;
        }

        const quote = await db.collection('quotes').findOne({
          siteId: site._id,
          date: txnDate
        });

        if (!quote) {
          console.warn(`⚠️ No quote found for ${txnDate} at ${siteAddress}`);
          continue;
        }

        const updatedLineItems = [];

        for (const line of invoice.Invoice.Line || []) {
          const itemName = normalizeProductName(line?.SalesItemLineDetail?.ItemRef?.name || '');
          const matched = quote.products.find(p => normalizeProductName(p.name) === itemName);

          if (!matched) {
            console.warn(`❌ No matching product for "${itemName}" in quote`);
            continue;
          }

          const unitPrice = matched.price;
          const qty = line.SalesItemLineDetail?.Qty || 1;

          updatedLineItems.push({
            Amount: parseFloat((unitPrice * qty).toFixed(2)),
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: {
              ItemRef: line.SalesItemLineDetail.ItemRef,
              Qty: qty,
              UnitPrice: unitPrice
            }
          });
        }

        if (updatedLineItems.length === 0) {
          console.warn('⚠️ No matching products found to update invoice');
          continue;
        }

        try {
          await axios.post(`${apiBase}/v3/company/${realmId}/invoice?operation=update`, {
            Id: invoice.Invoice.Id,
            SyncToken: invoice.Invoice.SyncToken,
            Line: updatedLineItems
          }, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
              'Content-Type': 'application/json'
            }
          });
          console.log('✅ Invoice updated with quote prices');
        } catch (err) {
          const fault = err.response?.data?.fault;
          if (fault) {
            console.error('❌ QuickBooks error:');
            console.error(JSON.stringify(fault, null, 2));
          } else {
            console.error('❌ Failed to update invoice:', err.response?.data || err.message);
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

    let customer = await db.collection('customers').findOne({ email: customerEmail });
    if (!customer) {
      const result = await db.collection('customers').insertOne({ name: customerName, email: customerEmail });
      customer = { _id: result.insertedId, name: customerName, email: customerEmail };
    }

    let site = await db.collection('sites').findOne({ customerId: customer._id, address: siteAddress });
    if (!site) {
      const result = await db.collection('sites').insertOne({ customerId: customer._id, address: siteAddress });
      site = { _id: result.insertedId, customerId: customer._id, address: siteAddress };
    }

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
