// services/notificationService.js - Enhanced with Scheduler Support
const { messaging, firebaseInitialized } = require('../config/firebase');
const { User, Notification, ScheduledNotification } = require('../models');
const { Op } = require('sequelize');

class NotificationService {
  
  /**
   * Send notification to single user and save to database
   * @param {number} userId - Target user ID
   * @param {object} notification - { title, body, type, data }
   * @returns {Promise<object>} - { success, fcmResponse, dbNotification }
   */
  static async sendToUser(userId, notification) {
    try {
      console.log(`📤 Sending notification to user ${userId}:`, notification.title);
      
      const user = await User.findByPk(userId);
      
      if (!user) {
        throw new Error(`User ${userId} not found`);
      }

      // Save notification to database first
      const dbNotification = await Notification.create({
        userId: userId,
        type: notification.type || 'general',
        title: notification.title,
        body: notification.body,
        data: notification.data || {},
        read: false,
        sent: false
      });

      console.log(`✅ Notification saved to DB with ID: ${dbNotification.id}`);

      // If Firebase is not initialized, skip FCM
      if (!firebaseInitialized) {
        console.log(`⚠️ Firebase not initialized. Notification saved to DB only.`);
        return {
          success: true,
          message: 'Firebase not configured, saved to database only',
          dbNotification: dbNotification
        };
      }

      // If user has FCM token, send push notification
      if (user.fcmToken) {
        const message = {
          notification: {
            title: notification.title,
            body: notification.body,
          },
          data: {
            ...Object.fromEntries(
              Object.entries(notification.data || {}).map(([k, v]) => [k, String(v)])
            ),
            notificationId: dbNotification.id.toString(),
            type: notification.type || 'general',
            click_action: 'FLUTTER_NOTIFICATION_CLICK'
          },
          token: user.fcmToken,
          android: {
            priority: 'high',
            notification: {
              sound: 'default',
              channelId: 'default',
              priority: 'high',
              defaultSound: true,
              defaultVibrateTimings: true
            }
          },
          apns: {
            payload: {
              aps: {
                sound: 'default',
                badge: 1,
                contentAvailable: true
              }
            }
          }
        };

        try {
          const response = await messaging.send(message);
          console.log('✅ FCM notification sent successfully:', response);
          
          await dbNotification.update({
            sent: true,
            fcmMessageId: response
          });

          return {
            success: true,
            fcmResponse: response,
            dbNotification: dbNotification
          };
        } catch (fcmError) {
          console.error('❌ FCM send error:', fcmError);
          
          await dbNotification.update({
            sent: false,
            error: fcmError.message
          });
          
          if (fcmError.code === 'messaging/invalid-registration-token' || 
              fcmError.code === 'messaging/registration-token-not-registered') {
            await User.update({ fcmToken: null }, { where: { id: userId } });
            console.log(`🗑️ Removed invalid FCM token for user ${userId}`);
          }
          
          return {
            success: false,
            error: fcmError.message,
            dbNotification: dbNotification
          };
        }
      } else {
        console.log(`⚠️ User ${userId} has no FCM token, notification saved to DB only`);
        return {
          success: true,
          message: 'No FCM token, saved to database only',
          dbNotification: dbNotification
        };
      }
    } catch (error) {
      console.error('❌ Error in sendToUser:', error);
      throw error;
    }
  }

  /**
   * Send notification to multiple users
   */
  static async sendToMultipleUsers(userIds, notification) {
    try {
      console.log(`📤 Sending notification to ${userIds.length} users:`, notification.title);
      
      const results = [];
      
      for (const userId of userIds) {
        try {
          const result = await this.sendToUser(userId, notification);
          results.push({
            userId,
            success: result.success,
            notificationId: result.dbNotification.id
          });
        } catch (error) {
          console.error(`❌ Failed to send to user ${userId}:`, error);
          results.push({
            userId,
            success: false,
            error: error.message
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      console.log(`✅ Sent ${successCount}/${userIds.length} notifications successfully`);

      return {
        success: true,
        totalUsers: userIds.length,
        successCount: successCount,
        failureCount: userIds.length - successCount,
        results: results
      };
    } catch (error) {
      console.error('❌ Error in sendToMultipleUsers:', error);
      throw error;
    }
  }

  /**
   * Send notification to all users
   */
  static async sendToAllUsers(notification) {
    try {
      const users = await User.findAll({
        where: { isActive: true },
        attributes: ['id']
      });
      
      const userIds = users.map(u => u.id);
      return await this.sendToMultipleUsers(userIds, notification);
    } catch (error) {
      console.error('❌ Error in sendToAllUsers:', error);
      throw error;
    }
  }

  /**
   * Schedule a notification for later
   */
  static async scheduleNotification(scheduledData) {
    try {
      const { 
        title, 
        body, 
        type, 
        data, 
        scheduledAt, 
        targetType, // 'all', 'user', 'users'
        targetUserIds,
        createdBy 
      } = scheduledData;

      const scheduled = await ScheduledNotification.create({
        title,
        body,
        type: type || 'general',
        data: data || {},
        scheduledAt: new Date(scheduledAt),
        targetType,
        targetUserIds: targetUserIds || [],
        status: 'pending',
        createdBy
      });

      console.log(`📅 Notification scheduled for ${scheduledAt} with ID: ${scheduled.id}`);
      
      return {
        success: true,
        scheduledNotification: scheduled
      };
    } catch (error) {
      console.error('❌ Error scheduling notification:', error);
      throw error;
    }
  }

  /**
   * Process scheduled notifications (called by cron job)
   */
  static async processScheduledNotifications() {
    try {
      const now = new Date();
      
      const pendingNotifications = await ScheduledNotification.findAll({
        where: {
          status: 'pending',
          scheduledAt: { [Op.lte]: now }
        }
      });

      console.log(`⏰ Processing ${pendingNotifications.length} scheduled notifications`);

      for (const scheduled of pendingNotifications) {
        try {
          await scheduled.update({ status: 'processing' });

          const notification = {
            title: scheduled.title,
            body: scheduled.body,
            type: scheduled.type,
            data: scheduled.data
          };

          let result;
          
          if (scheduled.targetType === 'all') {
            result = await this.sendToAllUsers(notification);
          } else if (scheduled.targetType === 'user' && scheduled.targetUserIds.length === 1) {
            result = await this.sendToUser(scheduled.targetUserIds[0], notification);
          } else if (scheduled.targetType === 'users' && scheduled.targetUserIds.length > 0) {
            result = await this.sendToMultipleUsers(scheduled.targetUserIds, notification);
          }

          await scheduled.update({ 
            status: 'completed',
            completedAt: new Date(),
            result: result
          });

          console.log(`✅ Scheduled notification ${scheduled.id} completed`);
        } catch (error) {
          console.error(`❌ Error processing scheduled notification ${scheduled.id}:`, error);
          await scheduled.update({ 
            status: 'failed',
            error: error.message
          });
        }
      }

      return { processed: pendingNotifications.length };
    } catch (error) {
      console.error('❌ Error in processScheduledNotifications:', error);
      throw error;
    }
  }

  /**
   * Cancel a scheduled notification
   */
  static async cancelScheduledNotification(scheduledId) {
    try {
      const scheduled = await ScheduledNotification.findByPk(scheduledId);
      
      if (!scheduled) {
        throw new Error('Scheduled notification not found');
      }

      if (scheduled.status !== 'pending') {
        throw new Error(`Cannot cancel notification with status: ${scheduled.status}`);
      }

      await scheduled.update({ status: 'cancelled' });
      
      return { success: true, message: 'Scheduled notification cancelled' };
    } catch (error) {
      console.error('❌ Error cancelling scheduled notification:', error);
      throw error;
    }
  }

  // ==================== NOTIFICATION TEMPLATES ====================

  static async sendSupportReceivedNotification(toUserId, fromUserName, bubbleAmount) {
    return await this.sendToUser(toUserId, {
      title: '🎉 Bubbles Received!',
      body: `${fromUserName} sent you ${bubbleAmount} bubbles!`,
      type: 'support_received',
      data: {
        bubbleAmount: bubbleAmount.toString(),
        fromUserName: fromUserName
      }
    });
  }

  static async sendGoalCompletedNotification(userId, goalAmount) {
    return await this.sendToUser(userId, {
      title: '🎯 Goal Achieved!',
      body: `Congratulations! You've reached your goal of ${goalAmount} bubbles!`,
      type: 'bubble_goal_completed',
      data: {
        goalAmount: goalAmount.toString()
      }
    });
  }

  static async sendGiveawayReceivedNotification(userId, category, amount) {
    return await this.sendToUser(userId, {
      title: '🎁 Giveaway Received!',
      body: `You received ${amount} bubbles from ${category} Giveaway!`,
      type: 'giveaway_received',
      data: {
        category: category,
        amount: amount.toString()
      }
    });
  }

  static async sendOfferAcceptedNotification(userId, offerTitle) {
    return await this.sendToUser(userId, {
      title: '✅ Offer Accepted!',
      body: `Your offer "${offerTitle}" has been accepted!`,
      type: 'offer_accepted',
      data: {
        offerTitle: offerTitle
      }
    });
  }

  static async sendOfferRejectedNotification(userId, offerTitle) {
    return await this.sendToUser(userId, {
      title: '❌ Offer Update',
      body: `Your offer "${offerTitle}" was not approved.`,
      type: 'offer_rejected',
      data: {
        offerTitle: offerTitle
      }
    });
  }

  static async sendWelcomeNotification(userId, userName) {
    return await this.sendToUser(userId, {
      title: '👋 Welcome to BubbleMake!',
      body: `Hi ${userName}! Start your bubble journey today. Deposit bubbles to get started!`,
      type: 'general',
      data: {
        action: 'welcome'
      }
    });
  }

  static async sendDailyReminderNotification(userId) {
    return await this.sendToUser(userId, {
      title: '💡 Daily Reminder',
      body: 'Don\'t forget to check today\'s giveaways and support others!',
      type: 'general',
      data: {
        action: 'daily_reminder'
      }
    });
  }
}

module.exports = NotificationService;