import express from 'express';
import cors from 'cors';
import cookieSession from 'cookie-session';
import multer from 'multer';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Database setup
const dbFile = join(__dirname, 'db.json');
const db = new Low(new JSONFile(dbFile), { users: [], files: [], sessions: [] });
await db.read();

const app = express();

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json());
app.use(cookieSession({
  name: 'session',
  keys: [process.env.JWT_SECRET || 'secret'],
  maxAge: 7 * 24 * 60 * 60 * 1000
}));

const upload = multer({ storage: multer.memoryStorage() });

// Helper: Simple encryption
const encrypt = (text) => {
  const cipher = crypto.createCipher('aes-256-cbc', process.env.SESSION_ENCRYPT_KEY);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
};

const decrypt = (text) => {
  const decipher = crypto.createDecipher('aes-256-cbc', process.env.SESSION_ENCRYPT_KEY);
  let decrypted = decipher.update(text, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

// Store active Telegram clients
const clients = new Map();

const getClient = async (userId, encryptedSession) => {
  if (clients.has(userId)) {
    return clients.get(userId);
  }
  
  const sessionString = decrypt(encryptedSession);
  const client = new TelegramClient(
    new StringSession(sessionString),
    parseInt(process.env.TG_API_ID),
    process.env.TG_API_HASH,
    { connectionRetries: 5 }
  );
  
  await client.connect();
  clients.set(userId, client);
  
  // Cleanup after 10 minutes
  setTimeout(() => {
    if (clients.has(userId)) {
      client.disconnect();
      clients.delete(userId);
    }
  }, 600000);
  
  return client;
};

// AUTH ROUTES

// Send OTP
app.post('/auth/send-code', async (req, res) => {
  try {
    const { phone } = req.body;
    
    const tempClient = new TelegramClient(
      new StringSession(''),
      parseInt(process.env.TG_API_ID),
      process.env.TG_API_HASH
    );
    
    await tempClient.connect();
    
    const result = await tempClient.sendCode({
      phoneNumber: phone,
      settings: { _: 'codeSettings' }
    });
    
    const session = tempClient.session.save();
    
    // Temporarily store session
    const requestId = Date.now().toString();
    db.data.sessions = db.data.sessions || [];
    db.data.sessions.push({
      requestId,
      phone,
      session: encrypt(session),
      phoneCodeHash: result.phoneCodeHash
    });
    await db.write();
    
    res.json({ requestId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Verify OTP
app.post('/auth/verify-code', async (req, res) => {
  try {
    const { requestId, code } = req.body;
    
    const sessionData = db.data.sessions.find(s => s.requestId === requestId);
    if (!sessionData) {
      return res.status(400).json({ error: 'Session expired' });
    }
    
    const tempClient = new TelegramClient(
      new StringSession(decrypt(sessionData.session)),
      parseInt(process.env.TG_API_ID),
      process.env.TG_API_HASH
    );
    
    await tempClient.connect();
    
    const result = await tempClient.signInUser({
      phoneNumber: sessionData.phone,
      phoneCode: code,
      phoneCodeHash: sessionData.phoneCodeHash
    });
    
    const finalSession = tempClient.session.save();
    
    // Save user
    const userId = 'user_' + Date.now();
    db.data.users.push({
      id: userId,
      phone: sessionData.phone,
      encryptedSession: encrypt(finalSession),
      firstName: result.firstName,
      lastName: result.lastName
    });
    
    // Remove temp session
    db.data.sessions = db.data.sessions.filter(s => s.requestId !== requestId);
    await db.write();
    
    // Set cookie
    req.session.userId = userId;
    
    res.json({ success: true, userId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Check auth
app.get('/auth/me', (req, res) => {
  if (req.session.userId) {
    const user = db.data.users.find(u => u.id === req.session.userId);
    res.json({ loggedIn: true, user });
  } else {
    res.json({ loggedIn: false });
  }
});

// Logout
app.post('/auth/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

// FILE ROUTES

// Upload file
app.post('/files/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
    
    const user = db.data.users.find(u => u.id === req.session.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    
    const client = await getClient(user.id, user.encryptedSession);
    
    // Upload to Saved Messages
    const result = await client.sendFile('me', {
      file: req.file.buffer,
      caption: req.file.originalname,
      workers: 4
    });
    
    // Save to DB
    const fileId = 'file_' + Date.now();
    db.data.files.push({
      id: fileId,
      userId: user.id,
      filename: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      telegramMessageId: result.id,
      visibility: 'private',
      createdAt: new Date().toISOString()
    });
    await db.write();
    
    res.json({ success: true, fileId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Get user's files
app.get('/files', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  
  const files = db.data.files.filter(f => f.userId === req.session.userId);
  res.json({ files });
});

// Stream file
app.get('/files/:id/stream', async (req, res) => {
  try {
    const file = db.data.files.find(f => f.id === req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    
    // Check access
    if (file.visibility === 'private' && file.userId !== req.session.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const user = db.data.users.find(u => u.id === file.userId);
    const client = await getClient(user.id, user.encryptedSession);
    
    const message = await client.getMessages('me', { ids: [file.telegramMessageId] });
    if (!message.length || !message[0].media) {
      return res.status(404).json({ error: 'File not found on Telegram' });
    }
    
    const buffer = await client.downloadMedia(message[0].media);
    
    res.setHeader('Content-Type', file.mimetype);
    res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
    res.send(buffer);
    
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Delete file
app.delete('/files/:id', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  
  const fileIndex = db.data.files.findIndex(f => f.id === req.params.id && f.userId === req.session.userId);
  if (fileIndex === -1) return res.status(404).json({ error: 'File not found' });
  
  // Optionally delete from Telegram too
  // const file = db.data.files[fileIndex];
  // const user = db.data.users.find(u => u.id === file.userId);
  // const client = await getClient(user.id, user.encryptedSession);
  // await client.deleteMessages('me', [file.telegramMessageId]);
  
  db.data.files.splice(fileIndex, 1);
  await db.write();
  
  res.json({ success: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
