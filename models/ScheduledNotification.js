// models/ScheduledNotification.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ScheduledNotification = sequelize.define('ScheduledNotification', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false
  },
  body: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  type: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'general'
  },
  data: {
    type: DataTypes.JSON,
    allowNull: true
  },
  scheduledAt: {
    type: DataTypes.DATE,
    allowNull: false
  },
  targetType: {
    type: DataTypes.ENUM('all', 'user', 'users'),
    allowNull: false,
    defaultValue: 'all'
  },
  targetUserIds: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: []
  },
  status: {
    type: DataTypes.ENUM('pending', 'processing', 'completed', 'failed', 'cancelled'),
    allowNull: false,
    defaultValue: 'pending'
  },
  completedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  result: {
    type: DataTypes.JSON,
    allowNull: true
  },
  error: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  createdBy: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id'
    }
  }
}, {
  timestamps: true,
  tableName: 'scheduled_notifications',
  indexes: [
    { fields: ['status'] },
    { fields: ['scheduledAt'] },
    { fields: ['status', 'scheduledAt'] }
  ]
});

module.exports = ScheduledNotification;