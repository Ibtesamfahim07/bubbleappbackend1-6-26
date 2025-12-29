const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Notification = sequelize.define('Notification', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  type: {
    type: DataTypes.ENUM(
      'support_received',
      'bubble_goal_completed',
      'giveaway_received',
      'offer_accepted',
      'offer_rejected',
      'admin_message',
      'general'
    ),
    allowNull: false,
    defaultValue: 'general'
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false
  },
  body: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  data: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Additional data for the notification'
  },
  read: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'Whether user has read this notification'
  },
  sent: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'Whether FCM was sent successfully'
  },
  fcmMessageId: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'FCM message ID from Firebase'
  },
  error: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Error message if sending failed'
  }
}, {
  timestamps: true,
  tableName: 'notifications',
  indexes: [
    { fields: ['userId'] },
    { fields: ['read'] },
    { fields: ['type'] },
    { fields: ['createdAt'] }
  ]
});

module.exports = Notification;