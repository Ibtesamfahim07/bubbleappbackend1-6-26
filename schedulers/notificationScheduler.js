// schedulers/notificationScheduler.js
const cron = require('node-cron');
const { User, BubbleTransaction, Notification } = require('../models');
const NotificationService = require('../services/notificationService');
const sequelize = require('../config/database');
const { Op } = require('sequelize');

class NotificationScheduler {
  
  /**
   * Initialize all scheduled jobs
   */
  static init() {
    console.log('🔔 Notification Scheduler initialized');
    
    // Run payback reminder every day at 10:00 AM
    cron.schedule('0 10 * * *', async () => {
      console.log('⏰ Running daily payback reminder...');
      await this.sendPaybackReminders();
    });

    // Run payback reminder every day at 6:00 PM
    cron.schedule('0 18 * * *', async () => {
      console.log('⏰ Running evening payback reminder...');
      await this.sendPaybackReminders();
    });

    // Process any scheduled notifications every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
      await NotificationService.processScheduledNotifications();
    });

    console.log('✅ Notification schedules registered');
  }

  /**
   * Send payback reminders to users who owe bubbles
   */
  static async sendPaybackReminders() {
    try {
      // Get all users who have received support
      const usersWithDebt = await sequelize.query(`
        SELECT 
          u.id,
          u.name,
          u.bubblesReceived,
          u.bubblesCount,
          COALESCE(SUM(bt.bubbleAmount), 0) as totalReturned
        FROM users u
        LEFT JOIN bubble_transactions bt ON bt.fromUserId = u.id 
          AND bt.type = 'back' 
          AND bt.status = 'completed'
        WHERE u.bubblesReceived > 0
          AND u.isActive = 1
          AND u.fcmToken IS NOT NULL
        GROUP BY u.id, u.name, u.bubblesReceived, u.bubblesCount
        HAVING (u.bubblesReceived - COALESCE(SUM(bt.bubbleAmount), 0)) > 0
          AND u.bubblesCount >= 10
      `, {
        type: sequelize.QueryTypes.SELECT
      });

      console.log(`📋 Found ${usersWithDebt.length} users with pending payback`);

      for (const user of usersWithDebt) {
        const owed = user.bubblesReceived - user.totalReturned;
        const canPayback = Math.min(owed, user.bubblesCount);

        if (canPayback >= 10) {
          await NotificationService.sendToUser(user.id, {
            title: '💰 Time to Give Back!',
            body: `You have ${user.bubblesCount} bubbles and owe ${owed}. Return some to help others!`,
            type: 'general',
            data: {
              action: 'payback_reminder',
              owedAmount: owed.toString(),
              availableBubbles: user.bubblesCount.toString()
            }
          });

          console.log(`✅ Sent payback reminder to ${user.name} (owes: ${owed})`);
        }
      }

      return { success: true, notified: usersWithDebt.length };
    } catch (error) {
      console.error('❌ Payback reminder error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send notification when user receives support
   */
  static async notifySupportReceived(toUserId, fromUserName, bubbleAmount, slotNumber) {
    try {
      await NotificationService.sendToUser(toUserId, {
        title: '🎉 Support Received!',
        body: `${fromUserName} sent you ${bubbleAmount} bubbles for Slot #${slotNumber}!`,
        type: 'support_received',
        data: {
          fromUserName,
          bubbleAmount: bubbleAmount.toString(),
          slotNumber: slotNumber.toString(),
          action: 'support_received'
        }
      });
      console.log(`✅ Support notification sent to user ${toUserId}`);
    } catch (error) {
      console.error('❌ Support notification error:', error);
    }
  }

  /**
   * Send notification when user receives giveaway
   */
  static async notifyGiveawayReceived(userId, category, amount) {
    try {
      await NotificationService.sendToUser(userId, {
        title: '🎁 Giveaway Received!',
        body: `You received ${amount} bubbles from ${category} Giveaway!`,
        type: 'giveaway_received',
        data: {
          category,
          amount: amount.toString(),
          action: 'giveaway_received'
        }
      });
      console.log(`✅ Giveaway notification sent to user ${userId}`);
    } catch (error) {
      console.error('❌ Giveaway notification error:', error);
    }
  }

  /**
   * Send notification when admin supports user
   */
  static async notifyAdminSupport(userId, adminName, bubbleAmount, slotNumber) {
    try {
      await NotificationService.sendToUser(userId, {
        title: '⭐ Admin Support!',
        body: `Admin  sent you ${bubbleAmount} bubbles for Slot #${slotNumber}!`,
        type: 'admin_message',
        data: {
          adminName,
          bubbleAmount: bubbleAmount.toString(),
          slotNumber: slotNumber.toString(),
          action: 'admin_support'
        }
      });
      console.log(`✅ Admin support notification sent to user ${userId}`);
    } catch (error) {
      console.error('❌ Admin support notification error:', error);
    }
  }

  /**
   * Send notification when admin approves offer request
   */
  static async notifyOfferApproved(userId, brandName, shortfallAmount) {
    try {
      await NotificationService.sendToUser(userId, {
        title: '✅ Offer Approved!',
        body: `Your offer at ${brandName} has been approved! `,
        type: 'offer_accepted',
        data: {
          brandName,
          shortfallAmount: shortfallAmount.toString(),
          action: 'offer_approved'
        }
      });
      console.log(`✅ Offer approval notification sent to user ${userId}`);
    } catch (error) {
      console.error('❌ Offer approval notification error:', error);
    }
  }

  /**
   * Send notification when admin rejects offer request
   */
  static async notifyOfferRejected(userId, brandName) {
    try {
      await NotificationService.sendToUser(userId, {
        title: '❌ Offer Not Approved',
        body: `Your offer request at ${brandName} was not approved.`,
        type: 'offer_rejected',
        data: {
          brandName,
          action: 'offer_rejected'
        }
      });
      console.log(`✅ Offer rejection notification sent to user ${userId}`);
    } catch (error) {
      console.error('❌ Offer rejection notification error:', error);
    }
  }
}

module.exports = NotificationScheduler;