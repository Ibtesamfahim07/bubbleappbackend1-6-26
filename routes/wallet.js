// routes/wallet.js
const express = require('express');
const auth = require('../middleware/auth');
const { User, WalletTransaction } = require('../models');

const router = express.Router();
router.use(auth);

// routes/auth.js - Set first depositing user as queue position 1
// This should be in your deposit endpoint or when user gets bubbles first time

// Add this logic to routes/wallet.js deposit-bubbles endpoint
router.post('/deposit-bubbles', async (req, res) => {
  try {
    console.log('💰 Deposit request received');
    console.log('💰 User ID:', req.user.id);
    console.log('💰 Request body:', req.body);
    
    // ✅ FIXED: Accept both parameter names
    const bubbles = req.body.bubbles || req.body.bubbleCount;
    
    if (!bubbles || bubbles <= 0) {
      console.log('❌ Invalid bubble count:', bubbles);
      return res.status(400).json({ 
        success: false,
        message: 'Invalid bubble amount' 
      });
    }

    const user = await User.findByPk(req.user.id);
    
    if (!user) {
      console.log('❌ User not found:', req.user.id);
      return res.status(404).json({ 
        success: false,
        message: 'User not found' 
      });
    }
    
    console.log('💰 Current bubble count:', user.bubblesCount);
    console.log('💰 Adding:', bubbles);
    
    // Check if this is user's first deposit
    const wasFirstDeposit = user.bubblesCount === 0 && user.queuePosition === 0;
    
    // Update bubble count
    user.bubblesCount = (user.bubblesCount || 0) + parseInt(bubbles);
    
    // If first deposit, check if they should be queue position 1
    if (wasFirstDeposit) {
      const currentQueueOne = await User.findOne({
        where: { queuePosition: 1 }
      });
      
      // If no one is at position 1, make this user position 1
      if (!currentQueueOne) {
        user.queuePosition = 1;
        console.log(`✅ User ${user.name} set as Queue Position #1`);
      }
    }
    
    await user.save();
    
    console.log('✅ New bubble count:', user.bubblesCount);
    
    // Create transaction record
    await WalletTransaction.create({ 
      userId: user.id, 
      type: 'bubble_deposit', 
      amount: bubbles 
    });
    
    res.json({ 
      success: true,
      message: `${bubbles} bubbles deposited successfully`,
      bubblesCount: user.bubblesCount,
      queuePosition: user.queuePosition,
      depositedAmount: parseInt(bubbles)
    });
    
  } catch (error) {
    console.error('❌ Deposit error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error depositing bubbles',
      error: error.message 
    });
  }
});

router.post('/buy-bubbles', async (req, res) => {
  const { bubbles } = req.body;
  if (bubbles <= 0) {
    return res.status(400).json({ message: 'Invalid amount' });
  }
  
  const price = parseFloat(process.env.BUBBLE_PRICE || 1);
  const cost = bubbles * price;
  
  try {
    const user = await User.findByPk(req.user.id);
    
    if (parseFloat(user.walletBalance) < cost) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }
    
    user.walletBalance = parseFloat(user.walletBalance) - cost;
    user.bubblesCount += parseInt(bubbles);
    await user.save();
    
    await WalletTransaction.create({ 
      userId: user.id, 
      type: 'bubble_purchase', 
      amount: cost 
    });
    
    res.json({ 
      message: 'Bubbles purchased', 
      bubblesCount: user.bubblesCount, 
      walletBalance: user.walletBalance 
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

module.exports = router;


router.post('/buy-bubbles', async (req, res) => {
  const { bubbles } = req.body;
  if (bubbles <= 0) return res.status(400).json({ message: 'Invalid amount' });
  const price = parseFloat(process.env.BUBBLE_PRICE || 1);
  const cost = bubbles * price;
  try {
    const user = await User.findByPk(req.user.id);
    if (parseFloat(user.walletBalance) < cost) return res.status(400).json({ message: 'Insufficient balance' });
    user.walletBalance = parseFloat(user.walletBalance) - cost;
    user.bubblesCount += parseInt(bubbles);
    await user.save();
    await WalletTransaction.create({ userId: user.id, type: 'bubble_purchase', amount: cost });
    res.json({ message: 'Bubbles purchased', bubblesCount: user.bubblesCount, walletBalance: user.walletBalance });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

module.exports = router;