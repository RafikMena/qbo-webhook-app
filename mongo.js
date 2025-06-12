// mongo.js
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {});

let cachedDb = null;

export async function connectToMongo() {
  if (cachedDb) return cachedDb;

  try {
    await client.connect();
    db = client.db('qbo-webhook-app'); // explicitly use your DB name
    cachedDb = db;
    console.log('✅ Connected to MongoDB');
    return db;
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    throw err;
  }
}
