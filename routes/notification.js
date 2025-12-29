const express = require('express');
const router = express.Router();
const { User, Notification } = require('../models');
const NotificationService = require('../services/notificationService');
const authMiddleware = require('../middleware/auth');
const { Op } = require('sequelize');

// ==================== FCM TOKEN MANAGEMENT ====================

// Update FCM token
router.post('/fcm-token', authMiddleware, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    const userId = req.user.id;

    if (!fcmToken) {
      return res.status(400).json({ error: 'FCM token is required' });
    }

    console.log(`📱 Updating FCM token for user ${userId}`);

    await User.update(
      { fcmToken },
      { where: { id: userId } }
    );

    res.json({ 
      success: true, 
      message: 'FCM token updated successfully' 
    });
  } catch (error) {
    console.error('Error updating FCM token:', error);
    res.status(500).json({ error: 'Failed to update FCM token' });
  }
});

// Remove FCM token (on logout)
router.delete('/fcm-token', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    console.log(`🗑️ Removing FCM token for user ${userId}`);

    await User.update(
      { fcmToken: null },
      { where: { id: userId } }
    );

    res.json({ 
      success: true, 
      message: 'FCM token removed successfully' 
    });
  } catch (error) {
    console.error('Error removing FCM token:', error);
    res.status(500).json({ error: 'Failed to remove FCM token' });
  }
});

// ==================== NOTIFICATION MANAGEMENT ====================

// Get user's notifications (paginated)
router.get('/my-notifications', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, unreadOnly = false } = req.query;
    
    const offset = (page - 1) * limit;
    
    let whereClause = { userId };
    if (unreadOnly === 'true') {
      whereClause.read = false;
    }

    const { count, rows: notifications } = await Notification.findAndCountAll({
      where: whereClause,
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: offset
    });

    const unreadCount = await Notification.count({
      where: { userId, read: false }
    });

    res.json({
      success: true,
      notifications,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(count / limit)
      },
      unreadCount
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Get unread notification count
router.get('/unread-count', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const count = await Notification.count({
      where: { userId, read: false }
    });

    res.json({
      success: true,
      unreadCount: count
    });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// Mark notification as read
router.put('/:id/read', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const notification = await Notification.findOne({
      where: { id, userId }
    });

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    await notification.update({ read: true });

    res.json({
      success: true,
      message: 'Notification marked as read',
      notification
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// Mark all notifications as read
router.put('/mark-all-read', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const updated = await Notification.update(
      { read: true },
      { where: { userId, read: false } }
    );

    res.json({
      success: true,
      message: 'All notifications marked as read',
      updatedCount: updated[0]
    });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ error: 'Failed to mark all notifications as read' });
  }
});

// Delete notification
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const notification = await Notification.findOne({
      where: { id, userId }
    });

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    await notification.destroy();

    res.json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

// Delete all read notifications
router.delete('/clear/read', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const deleted = await Notification.destroy({
      where: { userId, read: true }
    });

    res.json({
      success: true,
      message: 'All read notifications deleted',
      deletedCount: deleted
    });
  } catch (error) {
    console.error('Error deleting read notifications:', error);
    res.status(500).json({ error: 'Failed to delete read notifications' });
  }
});

// ==================== ADMIN/TEST ENDPOINTS ====================

// Send test notification
router.post('/test', authMiddleware, async (req, res) => {
  try {
    const { title, body, userId, type } = req.body;
    
    // Allow both admin and users to test their own notifications
    const targetUserId = userId || req.user.id;
    
    // If sending to another user, check admin role
    if (targetUserId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required to send to other users' });
    }

    const result = await NotificationService.sendToUser(targetUserId, {
      title: title || 'Test Notification',
      body: body || 'This is a test notification from the system',
      type: type || 'general',
      data: { test: true, sentAt: new Date().toISOString() }
    });

    res.json({ 
      success: true, 
      message: 'Test notification sent',
      result 
    });
  } catch (error) {
    console.error('Error sending test notification:', error);
    res.status(500).json({ error: 'Failed to send notification', details: error.message });
  }
});

// Send bulk test notification (admin only)
router.post('/test-bulk', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { userIds, title, body, type } = req.body;
    
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'userIds array is required' });
    }

    const result = await NotificationService.sendToMultipleUsers(userIds, {
      title: title || 'Bulk Test Notification',
      body: body || 'This is a bulk test notification',
      type: type || 'general',
      data: { test: true, sentAt: new Date().toISOString() }
    });

    res.json({ 
      success: true, 
      message: 'Bulk test notification sent',
      result 
    });
  } catch (error) {
    console.error('Error sending bulk test notification:', error);
    res.status(500).json({ error: 'Failed to send bulk notification', details: error.message });
  }
});

module.exports = router;