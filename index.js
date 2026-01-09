require('dotenv').config();
const express = require('express');
const os = require('os');
const sequelize = require('./config/database');
const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const getRoutes = require('./routes/get');
const makeRoutes = require('./routes/make');
const backRoutes = require('./routes/back');
const adminRoutes = require('./routes/admin');
const notificationRoutes = require('./routes/notification');
const NotificationScheduler = require('./schedulers/notificationScheduler');

// ✅ Import models for top user initialization
const { User, QueueTracker } = require('./models');
const { Op, literal } = require('sequelize');

const app = express();

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Request logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} - ${req.method} ${req.path}`);
  if (req.body && Object.keys(req.body).length > 0 && process.env.NODE_ENV !== 'production') {
    console.log('Body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

// Routes
app.use('/auth', authRoutes);
app.use('/wallet', walletRoutes);
app.use('/get', getRoutes);
app.use('/make', makeRoutes);
app.use('/back', backRoutes);
app.use('/admin', adminRoutes);
app.use('/notifications', notificationRoutes);

// Root endpoint
app.get('/', (req, res) => {
  const isProduction = process.env.NODE_ENV === 'production';
  res.json({ 
    message: 'API is running',
    environment: isProduction ? 'production' : 'development',
    platform: process.env.VERCEL ? 'vercel' : 'local',
    endpoints: {
      auth: '/auth (signup, login)',
      wallet: '/wallet',
      get: '/get (nearby)',
      make: '/make (request)',
      back: '/back (return)',
      admin: '/admin',
      notifications: '/notifications (fcm-token, test)'
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    platform: process.env.VERCEL ? 'vercel' : 'local'
  });
});

// Error handling
app.use((error, req, res, next) => {
  console.error('Error:', error);
  res.status(500).json({ 
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'production' ? 'Something went wrong' : error.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.originalUrl} not found` });
});

// Helper function for local network info
function getNetworkInfo() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  
  for (const name of Object.keys(interfaces)) {
    for (const interface of interfaces[name]) {
      if (interface.family === 'IPv4' && !interface.internal) {
        addresses.push({
          name: name,
          address: interface.address
        });
      }
    }
  }
  return addresses;
}

// ✅ NEW: Helper function to validate and fix slotProgress
function validateAndFixSlotProgress(slotProgress, queueSlots) {
  console.log('🔍 Validating slotProgress:', typeof slotProgress, slotProgress);
  
  let parsed = slotProgress;
  
  if (!parsed) {
    console.log('⚠️ slotProgress is null/undefined, initializing empty object');
    parsed = {};
  }
  
  let parseAttempts = 0;
  while (typeof parsed === 'string' && parseAttempts < 3) {
    parseAttempts++;
    try {
      parsed = JSON.parse(parsed);
      console.log(`✅ JSON parse attempt ${parseAttempts} succeeded`);
    } catch (e) {
      console.error(`❌ JSON parse attempt ${parseAttempts} failed:`, e.message);
      parsed = {};
      break;
    }
  }
  
  if (typeof parsed === 'string') {
    console.error('❌ slotProgress still a string after parsing, resetting');
    parsed = {};
  }
  
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('❌ slotProgress is not a valid object, resetting');
    parsed = {};
  }
  
  const keys = Object.keys(parsed);
  let isCorrupted = false;
  
  if (keys.length > queueSlots + 5) {
    console.error(`❌ CORRUPTION DETECTED: Too many keys (${keys.length}) for ${queueSlots} slots`);
    isCorrupted = true;
  }
  
  if (!isCorrupted) {
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === 'string' && value.length === 1 && isNaN(parseInt(value))) {
        console.error(`❌ CORRUPTION DETECTED: Key "${key}" has single char value "${value}"`);
        isCorrupted = true;
        break;
      }
    }
  }
  
  if (isCorrupted) {
    console.log('🔄 Resetting corrupted slotProgress to clean state');
    parsed = {};
  }
  
  const validProgress = {};
  const slots = parseInt(queueSlots) || 0;
  
  for (let i = 1; i <= slots; i++) {
    const key = i.toString();
    const value = parsed[key];
    
    if (typeof value === 'number' && !isNaN(value) && value >= 0 && value <= 400) {
      validProgress[key] = Math.floor(value);
    } else if (typeof value === 'string') {
      const num = parseInt(value, 10);
      if (!isNaN(num) && num >= 0 && num <= 400) {
        validProgress[key] = num;
      } else {
        validProgress[key] = 0;
      }
    } else {
      validProgress[key] = 0;
    }
  }
  
  console.log('✅ Validated slotProgress:', validProgress);
  return validProgress;
}

// ✅ NEW: Initialize top user flag function
async function updateTopUserFlag() {
  try {
    console.log('🔝 Calculating top user...');
    
    const queuedUsers = await User.findAll({ 
      where: { 
        queuePosition: { [Op.gt]: 0 },
        queueSlots: { [Op.gt]: 0 }
      },
      attributes: ['id', 'name', 'queuePosition', 'queueSlots', 'slotProgress']
    });
    
    if (queuedUsers.length === 0) {
      console.log('🔝 No users in queue');
      return;
    }
    
    let topUserId = null;
    let lowestIncompleteQueuePos = Infinity;
    
    // Find the user with the lowest incomplete queue position
    for (const user of queuedUsers) {
      const slotProgress = validateAndFixSlotProgress(user.slotProgress, user.queueSlots);
      
      // Get all queue positions for this user
      const queuePositions = Object.keys(slotProgress)
        .map(k => parseInt(k))
        .sort((a, b) => a - b);
      
      // Find the lowest incomplete queue position for this user
      for (const queuePos of queuePositions) {
        const progress = slotProgress[queuePos.toString()] || 0;
        
        if (progress < 400) {
          // This queue position is incomplete
          if (queuePos < lowestIncompleteQueuePos) {
            lowestIncompleteQueuePos = queuePos;
            topUserId = user.id;
          }
          break; // Only check the first incomplete position for this user
        }
      }
    }
    
    console.log(`🔝 Top user found: User ${topUserId} at Queue Position ${lowestIncompleteQueuePos}`);
    
    // Reset all users to isTopUser = 0
    await User.update({ isTopUser: 0 }, { where: { isTopUser: 1 } });
    
    // Set the top user flag
    if (topUserId) {
      await User.update({ isTopUser: 1 }, { where: { id: topUserId } });
      
      const topUser = queuedUsers.find(u => u.id === topUserId);
      console.log(`🔝 Set isTopUser=1 for ${topUser?.name || topUserId} (Queue #${lowestIncompleteQueuePos})`);
    }
    
  } catch (error) {
    console.error('🔝 Error updating top user flag:', error);
    throw error;
  }
}

// ✅ NEW: Initialize queue tracker
async function initializeQueueTracker() {
  try {
    console.log('🎯 Initializing queue tracker...');
    
    // Check if queue_tracker table exists and has a row
    const [tracker] = await sequelize.query(`
      SELECT * FROM queue_tracker WHERE id = 1
    `).catch(() => [null]);
    
    if (!tracker || tracker.length === 0) {
      console.log('📊 Queue tracker not found, creating...');
      
      // Find the current max queue position
      const maxQueuePos = await User.max('queuePosition', {
        where: { queuePosition: { [Op.gt]: 0 } }
      }) || 0;
      
      console.log(`📊 Current max queue position: ${maxQueuePos}`);
      
      // Create or update queue tracker
      await sequelize.query(`
        INSERT INTO queue_tracker (id, lastQueuePosition, updatedAt)
        VALUES (1, ${maxQueuePos}, NOW())
        ON DUPLICATE KEY UPDATE 
          lastQueuePosition = ${maxQueuePos},
          updatedAt = NOW()
      `);
      
      console.log(`✅ Queue tracker initialized with position ${maxQueuePos}`);
    } else {
      console.log('✅ Queue tracker already exists');
    }
  } catch (error) {
    console.error('❌ Error initializing queue tracker:', error);
    // Don't throw - allow server to start even if this fails
  }
}

// Database initialization
let dbInitialized = false;
const initializeDatabase = async () => {
  if (!dbInitialized) {
    try {
      await sequelize.authenticate();
      console.log('✅ Database connection established');
      
      // await sequelize.sync({ force: false, alter: false });
      console.log('✅ Database synchronized');
      
      // ✅ Initialize queue tracker
      await initializeQueueTracker();
      
      // ✅ Initialize top user flag
      await updateTopUserFlag();
      console.log('✅ Top user flag initialized');
      
      // Initialize notification scheduler (only for local, not Vercel)
      if (!process.env.VERCEL) {
        NotificationScheduler.init();
      }

      dbInitialized = true;
    } catch (err) {
      console.error('❌ Database error:', err);
      throw err;
    }
  }
};

// VERCEL: Export app for serverless
if (process.env.VERCEL) {
  // Initialize database on each request (Vercel serverless)
  app.use(async (req, res, next) => {
    try {
      await initializeDatabase();
      next();
    } catch (err) {
      res.status(500).json({ message: 'Database connection failed' });
    }
  });
  
  module.exports = app;
} 
// LOCAL: Start server on 0.0.0.0
else {
  const PORT = process.env.PORT || 3000;
  const HOST = '0.0.0.0'; // Critical for USB debugging
  
  initializeDatabase()
    .then(() => {
      app.listen(PORT, HOST, () => {
        const interfaces = getNetworkInfo();
        
        console.log('\n🚀 Server running on:');
        console.log(`   Local:    http://localhost:${PORT}`);
        
        if (interfaces.length > 0) {
          console.log(`   Network:  http://${interfaces[0].address}:${PORT}`);
          interfaces.forEach((iface, index) => {
            if (index > 0) {
              console.log(`             http://${iface.address}:${PORT}`);
            }
          });
        }
        
        console.log('\n📱 For USB Debugging (React Native):');
        console.log(`   1. Connect device via USB`);
        console.log(`   2. Run: adb reverse tcp:${PORT} tcp:${PORT}`);
        console.log(`   3. Use in app: http://localhost:${PORT}`);
        
        console.log('\n📋 Available endpoints:');
        console.log(`   GET  ${interfaces[0]?.address ? `http://${interfaces[0].address}:${PORT}` : `http://localhost:${PORT}`}/health`);
        console.log('   POST /auth/signup');
        console.log('   POST /auth/login');
        console.log('   GET  /get/nearby');
        console.log('   POST /notifications/fcm-token');
        console.log('   POST /notifications/test');
        
        console.log('\n✨ Ready for development!\n');
      });
    })
    .catch(err => {
      console.error('❌ Failed to start server:', err);
      process.exit(1);
    });
}
