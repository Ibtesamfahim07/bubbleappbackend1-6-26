// models/MakeSetting.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const MakeSetting = sequelize.define('MakeSetting', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  category: {
    type: DataTypes.ENUM('Medical', 'Grocery', 'Education'),
    allowNull: false,
    unique: true
  },
  allowOnMake: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    comment: 'If true, users can spend this giveaway category bubbles on Make offers'
  },
  updatedByAdminId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'Users',
      key: 'id'
    },
    onDelete: 'SET NULL'
  },
  description: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Optional description for this setting'
  }
}, {
  tableName: 'make_settings',
  timestamps: true
});

module.exports = MakeSetting;