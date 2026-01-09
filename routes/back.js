// routes/back.js - UPDATED WITH NOTIFICATIONS
const express = require('express');
const auth = require('../middleware/auth');
const { BubbleTransaction, User } = require('../models');
const NotificationService = require('../services/notificationService');
const { Op } = require('sequelize');

const router = express.Router();
router.use(auth);

// PAY BACK - When you return money to someone who supported you
router.post('/pay', async (req, res) => {
  const { transactionId } = req.body;
  try {
    // Get transaction with user details
    const transaction = await BubbleTransaction.findByPk(transactionId, {
      include: [
        {
          association: 'fromUser',  // Original supporter (will receive payback)
          attributes: ['id', 'name', 'fcmToken']
        },
        {
          association: 'toUser',    // You (the one paying back)
          attributes: ['id', 'name']
        }
      ]
    });
    
    if (!transaction || transaction.toUserId !== req.user.id || transaction.type !== 'support' || transaction.status !== 'pending') {
      return res.status(400).json({ message: 'Invalid transaction for payback' });
    }
    
    const payer = await User.findByPk(req.user.id); // You (original recipient)
    const receiver = await User.findByPk(transaction.fromUserId); // Original supporter
    const amount = transaction.bubbleAmount;
    
    if (payer.bubblesCount < amount) {
      return res.status(400).json({ message: 'Insufficient bubbles' });
    }
    
    // Perform the payback transaction
    payer.bubblesCount -= amount;
    receiver.bubblesCount += amount;
    await payer.save();
    await receiver.save();
    
    transaction.status = 'paidback';
    await transaction.save();
    
    // Create payback transaction record
    const paybackTransaction = await BubbleTransaction.create({
      fromUserId: req.user.id,
      toUserId: transaction.fromUserId,
      bubbleAmount: amount,
      type: 'payback',
      status: 'completed',
      description: `Payback of ${amount} bubbles to ${receiver.name}`
    });

    console.log(`💰 Payback: ${payer.name} paid ${amount} bubbles to ${receiver.name}`);

    // 🔔 NOTIFICATION 1: Send to RECEIVER (original supporter gets paid back)
    try {
      console.log(`🔔 Sending payback notification to ${receiver.name} (ID: ${receiver.id})`);
      
      const notificationResult = await NotificationService.sendToUser(receiver.id, {
        title: '💸 Payback Received!',
        body: `${payer.name} paid you back ${amount} bubbles!`,
        type: 'payback_received',
        data: {
          fromUserId: payer.id,
          fromUserName: payer.name,
          amount: amount.toString(),
          transactionId: paybackTransaction.id.toString(),
          action: 'payback_received'
        }
      });
      
      console.log(`✅ Payback notification sent successfully. Notification ID: ${notificationResult.dbNotification?.id}`);
      
    } catch (notifError) {
      console.error('❌ Payback notification failed:', notifError.message);
      // Don't fail the whole request if notification fails
    }

    // 🔔 NOTIFICATION 2: Send to PAYER (you get confirmation)
    try {
      const confirmationResult = await NotificationService.sendToUser(payer.id, {
        title: '✅ Payback Sent!',
        body: `You successfully paid back ${amount} bubbles to ${receiver.name}`,
        type: 'payback_sent',
        data: {
          toUserId: receiver.id,
          toUserName: receiver.name,
          amount: amount.toString(),
          transactionId: paybackTransaction.id.toString(),
          action: 'payback_sent'
        }
      });
      
      console.log(`✅ Payback confirmation sent. Notification ID: ${confirmationResult.dbNotification?.id}`);
      
    } catch (notifError) {
      console.error('❌ Payback confirmation notification failed:', notifError.message);
    }

    res.json({ 
      success: true,
      message: 'Paid back successfully',
      amount: amount,
      toUser: {
        id: receiver.id,
        name: receiver.name
      },
      transactionId: paybackTransaction.id,
      notifications: {
        sentToReceiver: true,
        sentToPayer: true
      }
    });
    
  } catch (error) {
    console.error('Payback error:', error);
    res.status(400).json({ 
      success: false,
      message: error.message,
      error: error.toString()
    });
  }
});

// DONATE - When you mark your support as a donation
router.post('/donate', async (req, res) => {
  const { transactionId } = req.body;
  try {
    const transaction = await BubbleTransaction.findByPk(transactionId, {
      include: [
        {
          association: 'toUser',  // The person who received your support
          attributes: ['id', 'name', 'fcmToken']
        }
      ]
    });
    
    if (!transaction || transaction.fromUserId !== req.user.id || transaction.type !== 'support' || transaction.status !== 'pending') {
      return res.status(400).json({ message: 'Invalid transaction for donation' });
    }
    
    const donor = await User.findByPk(req.user.id);
    
    transaction.type = 'donation';
    transaction.status = 'donated';
    await transaction.save();

    console.log(`🎁 Donation: ${donor.name} marked ${transaction.bubbleAmount} bubbles as donation to ${transaction.toUser?.name}`);

    // 🔔 NOTIFICATION: Send to RECEIVER about donation
    try {
      console.log(`🔔 Sending donation notification to ${transaction.toUser?.name} (ID: ${transaction.toUserId})`);
      
      const notificationResult = await NotificationService.sendToUser(transaction.toUserId, {
        title: '🎁 Donation Received!',
        body: `${donor.name} donated ${transaction.bubbleAmount} bubbles to you!`,
        type: 'donation_received',
        data: {
          fromUserId: donor.id,
          fromUserName: donor.name,
          amount: transaction.bubbleAmount.toString(),
          transactionId: transaction.id.toString(),
          action: 'donation_received'
        }
      });
      
      console.log(`✅ Donation notification sent successfully. Notification ID: ${notificationResult.dbNotification?.id}`);
      
    } catch (notifError) {
      console.error('❌ Donation notification failed:', notifError.message);
    }

    res.json({ 
      success: true,
      message: 'Marked as donation successfully',
      amount: transaction.bubbleAmount,
      toUser: {
        id: transaction.toUserId,
        name: transaction.toUser?.name
      },
      notificationSent: true
    });
    
  } catch (error) {
    console.error('Donation error:', error);
    res.status(400).json({ 
      success: false,
      message: error.message 
    });
  }
});

// GET: View all pending paybacks (people who owe you money)
router.get('/pending-paybacks', async (req, res) => {
  try {
    const pendingPaybacks = await BubbleTransaction.findAll({
      where: {
        toUserId: req.user.id,
        type: 'support',
        status: 'pending'
      },
      include: [
        {
          association: 'fromUser',
          attributes: ['id', 'name', 'bubblesCount']
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    const totalOwed = pendingPaybacks.reduce((sum, tx) => sum + tx.bubbleAmount, 0);

    res.json({
      success: true,
      count: pendingPaybacks.length,
      totalOwed: totalOwed,
      pendingPaybacks: pendingPaybacks.map(tx => ({
        id: tx.id,
        fromUserId: tx.fromUserId,
        fromUserName: tx.fromUser?.name,
        fromUserBubbles: tx.fromUser?.bubblesCount,
        amount: tx.bubbleAmount,
        createdAt: tx.createdAt,
        description: tx.description,
        canPayback: tx.fromUser?.bubblesCount >= tx.bubbleAmount
      }))
    });
    
  } catch (error) {
    console.error('Get pending paybacks error:', error);
    res.status(400).json({ 
      success: false,
      message: error.message 
    });
  }
});

// GET: View your payback history
router.get('/payback-history', async (req, res) => {
  try {
    const paybackHistory = await BubbleTransaction.findAll({
      where: {
        [Op.or]: [
          { fromUserId: req.user.id, type: 'payback', status: 'completed' },
          { toUserId: req.user.id, type: 'payback', status: 'completed' }
        ]
      },
      include: [
        {
          association: 'fromUser',
          attributes: ['id', 'name']
        },
        {
          association: 'toUser',
          attributes: ['id', 'name']
        }
      ],
      order: [['createdAt', 'DESC']],
      limit: 50
    });

    const sent = [];
    const received = [];
    
    paybackHistory.forEach(tx => {
      const isSent = tx.fromUserId === req.user.id;
      const entry = {
        id: tx.id,
        otherUserId: isSent ? tx.toUserId : tx.fromUserId,
        otherUserName: isSent ? tx.toUser?.name : tx.fromUser?.name,
        amount: tx.bubbleAmount,
        type: isSent ? 'sent' : 'received',
        createdAt: tx.createdAt,
        description: tx.description
      };
      
      if (isSent) {
        sent.push(entry);
      } else {
        received.push(entry);
      }
    });

    const totalSent = sent.reduce((sum, tx) => sum + tx.amount, 0);
    const totalReceived = received.reduce((sum, tx) => sum + tx.amount, 0);

    res.json({
      success: true,
      summary: {
        totalSent: totalSent,
        totalReceived: totalReceived,
        net: totalReceived - totalSent,
        sentCount: sent.length,
        receivedCount: received.length
      },
      sent: sent,
      received: received
    });
    
  } catch (error) {
    console.error('Get payback history error:', error);
    res.status(400).json({ 
      success: false,
      message: error.message 
    });
  }
});

// GET: Check if user has any pending paybacks
router.get('/has-pending-paybacks', async (req, res) => {
  try {
    const pendingCount = await BubbleTransaction.count({
      where: {
        toUserId: req.user.id,
        type: 'support',
        status: 'pending'
      }
    });

    res.json({
      success: true,
      hasPending: pendingCount > 0,
      pendingCount: pendingCount
    });
    
  } catch (error) {
    console.error('Check pending paybacks error:', error);
    res.status(400).json({ 
      success: false,
      message: error.message 
    });
  }
});

module.exports = router;