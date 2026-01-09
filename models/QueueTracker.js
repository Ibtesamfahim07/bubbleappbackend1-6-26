// models/QueueTracker.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const QueueTracker = sequelize.define('QueueTracker', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  lastQueuePosition: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: 'Last assigned queue position globally'
  }
}, {
  tableName: 'queue_tracker',
  timestamps: true,
  updatedAt: 'updatedAt',
  createdAt: false
});

module.exports = QueueTracker;