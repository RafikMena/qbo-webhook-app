import express from 'express';
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.post('/webhooks/qbo', (req, res) => {
  console.log('✅ Webhook received:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('QBO Webhook App is running');
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
