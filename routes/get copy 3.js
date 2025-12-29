// routes/get.js - COMPLETE FIXED VERSION
const express = require('express');
const auth = require('../middleware/auth');
const { User, BubbleTransaction, Giveaway } = require('../models');
const { literal, Op } = require('sequelize');
const sequelize = require('../config/database');

const router = express.Router();
router.use(auth);

// Helper functions
async function getCitiesWithUsers() {
  try {
    const cities = await User.findAll({
      attributes: [
        [literal('DISTINCT city'), 'city']
      ],
      where: {
        city: { [Op.ne]: null },
        queuePosition: { [Op.gt]: 0 },
        bubblesCount: { [Op.gt]: 0 }
      },
      raw: true
    });
    
    return cities.map(c => c.city).filter(Boolean);
  } catch (error) {
    console.error('Error getting cities with users:', error);
    return [];
  }
}

async function getAreasWithUsers(city) {
  try {
    const areas = await User.findAll({
      attributes: [
        [literal('DISTINCT area'), 'area']
      ],
      where: {
        city: city,
        area: { [Op.ne]: null },
        queuePosition: { [Op.gt]: 0 },
        bubblesCount: { [Op.gt]: 0 }
      },
      raw: true
    });
    
    return areas.map(a => a.area).filter(Boolean);
  } catch (error) {
    console.error('Error getting areas with users:', error);
    return [];
  }
}

// ============================================================
// HELPER: Rebalance Queue Positions
// ============================================================
async function rebalanceQueuePositions(transaction = null) {
  try {
    console.log('Rebalancing queue positions...');
    
    const options = { 
      where: { queuePosition: { [Op.gt]: 0 } },
      order: [['queuePosition', 'ASC']],
      attributes: ['id', 'queuePosition', 'queueSlots']
    };
    
    if (transaction) options.transaction = transaction;
    
    const queuedUsers = await User.findAll(options);
    
    let newPosition = 1;
    
    for (const user of queuedUsers) {
      const slots = parseInt(user.queueSlots) || 1;
      
      if (user.queuePosition !== newPosition) {
        const updateOptions = { where: { id: user.id } };
        if (transaction) updateOptions.transaction = transaction;
        
        await User.update({ queuePosition: newPosition }, updateOptions);
        console.log(`  Moved user ${user.id}: ${user.queuePosition} -> ${newPosition}`);
      }
      
      newPosition += slots;
    }
    
    console.log('Queue rebalanced');
  } catch (error) {
    console.error('Rebalance error:', error);
    throw error;
  }
}

// Routes
router.get('/available-cities', async (req, res) => {
  try {
    const cities = await getCitiesWithUsers();
    res.json(cities);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.get('/available-areas/:city', async (req, res) => {
  try {
    const { city } = req.params;
    const areas = await getAreasWithUsers(city);
    res.json(areas);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.get('/nearby', async (req, res) => {
  try {
    const { lat, lng, radius = 10, location } = req.query;
    
    console.log('\n=== NEARBY REQUEST ===');
    console.log('User:', req.user.id, '| Location:', location || 'All');
    
    if (!lat || !lng) {
      return res.status(400).json({ message: 'Coordinates required' });
    }
    
    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    const searchRadius = parseFloat(radius);
    
    const currentUser = await User.findByPk(req.user.id);
    if (!currentUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    console.log('Current user - Pos:', currentUser.queuePosition, '| Slots:', currentUser.queueSlots);

    const distanceFormula = literal(`(
      6371 * acos(
        cos(radians(${userLat})) * cos(radians(lat)) * 
        cos(radians(lng) - radians(${userLng})) + 
        sin(radians(${userLat})) * sin(radians(lat))
      )
    )`);
    
    // CRITICAL: queueSlots > 0
    let where = {
      id: { [Op.ne]: req.user.id },
      bubblesCount: { [Op.gt]: 0 },
      isActive: true,
      queuePosition: { [Op.gt]: 0 },
      queueSlots: { [Op.gt]: 0 }
    };

    if (location && location !== 'All') {
      const cities = ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Hyderabad', 'Quetta', 'Peshawar'];
      const areas = ['Bahria Town', 'DHA', 'Clifton', 'Gulshan', 'Malir', 'Saddar', 'North Nazimabad', 'Qasimabad'];
      
      if (cities.includes(location)) where.city = location;
      else if (areas.includes(location)) where.area = location;
      else where[Op.or] = [{ city: location }, { area: location }];
    }

    const users = await User.findAll({
      attributes: ['id', 'name', 'lat', 'lng', 'bubblesCount', 'city', 'area', 
                   'queuePosition', 'queueSlots', 'slotProgress', [distanceFormula, 'distance']],
      where,
      having: literal(`distance < ${searchRadius}`),
      order: [['queuePosition', 'ASC']],
      limit: 50
    });
    
    console.log(`Found ${users.length} users with queueSlots > 0`);
    
    const myPos = parseInt(currentUser.queuePosition) || 0;
    const filtered = [];

    for (const u of users) {
      const uSlots = parseInt(u.queueSlots) || 0;
      const uPos = parseInt(u.queuePosition) || 0;
      
      if (uSlots <= 0) continue;
      
      if (myPos === 0) {
        if (uPos === 1) filtered.push(u);
      } else {
        if (uPos < myPos) filtered.push(u);
      }
    }

    console.log(`After filter: ${filtered.length} users`);

    const cards = [];

    for (const u of filtered) {
      const slots = parseInt(u.queueSlots) || 1;
      const basePos = parseInt(u.queuePosition) || 0;
      const dist = parseFloat(u.getDataValue('distance')).toFixed(1);

      let progress = {};
      try { progress = u.slotProgress ? JSON.parse(u.slotProgress) : {}; } catch(e) {}

      const loc = [u.area, u.city].filter(Boolean).join(', ') || 'Unknown';

      for (let i = 0; i < slots; i++) {
        const slotNum = i + 1;
        const slotPos = basePos + i;
        const prog = parseInt(progress[slotNum.toString()]) || 0;
        const pct = Math.round((prog / 400) * 100);

        let color = '#10b981';
        if (slotPos === 1) color = '#ef4444';
        else if (slotPos <= 5) color = '#f59e0b';
        else if (slotPos <= 10) color = '#3b82f6';

        console.log(`  ${u.name} Slot ${slotNum}: Queue #${slotPos}, Progress ${prog}/400`);

        cards.push({
          id: `${u.id}-slot-${i}`,
          userId: u.id,
          userName: u.name,
          bubbleAmount: u.bubblesCount,
          totalBubbles: u.bubblesCount,
          creatorColor: color,
          description: `Queue #${slotPos} • ${prog}/400 (${pct}%) • ${loc}`,
          distance: dist,
          lat: u.lat,
          lng: u.lng,
          city: u.city,
          area: u.area,
          locationDisplay: loc,
          queuePosition: slotPos,
          queueProgress: prog,
          queueRequired: 400,
          queueProgressPercent: pct,
          remainingForSlot: 400 - prog,
          queueSlots: slots,
          slotIndex: i,
          slotNumber: slotNum,
          baseQueuePosition: basePos,
          isInQueue: true,
          canSupport: true,
          isOwnCard: false
        });
      }
    }

    cards.sort((a, b) => a.queuePosition - b.queuePosition);
    console.log(`Returning ${cards.length} Nearby cards\n`);

    res.json(cards);
  } catch (error) {
    console.error('Nearby error:', error);
    res.status(400).json({ message: error.message });
  }
});


router.get('/incomplete-queue', async (req, res) => {
  try {
    console.log('\n=== INCOMPLETE QUEUE (Active Tab) ===');
    console.log('User:', req.user.id);
    
    const user = await User.findByPk(req.user.id);
    
    if (!user) {
      console.log('User not found');
      return res.json([]);
    }
    
    const qPos = parseInt(user.queuePosition) || 0;
    const qSlots = parseInt(user.queueSlots) || 0;
    
    console.log('Queue Position:', qPos, '| Slots:', qSlots, '| SlotProgress:', user.slotProgress);
    
    if (qPos === 0 || qSlots === 0) {
      console.log('Not in queue or no slots');
      return res.json([]);
    }

    let slotProgress = {};
    try {
      slotProgress = user.slotProgress ? JSON.parse(user.slotProgress) : {};
    } catch (e) { slotProgress = {}; }
    
    console.log('Parsed progress:', slotProgress);

    const cards = [];
    const REQUIRED = 400;

    for (let slotNum = 1; slotNum <= qSlots; slotNum++) {
      const progress = parseInt(slotProgress[slotNum.toString()]) || 0;
      
      if (progress < REQUIRED) {
        const pct = Math.round((progress / REQUIRED) * 100);
        const actualPos = qPos + (slotNum - 1);
        const loc = [user.area, user.city].filter(Boolean).join(', ') || 'Unknown';
        
        console.log(`  Card ${slotNum}: Queue #${actualPos}, Progress ${progress}/${REQUIRED}`);
        
        cards.push({
          id: `active-slot-${slotNum}`,
          userId: user.id,
          userName: user.name,
          bubbleAmount: user.bubblesCount,
          queuePosition: actualPos,
          queueProgress: progress,
          queueRequired: REQUIRED,
          queueProgressPercent: pct,
          slotNumber: slotNum,
          slotIndex: slotNum - 1,
          supporterCount: 0,
          isOwnCard: true,
          creatorColor: '#f59e0b',
          area: user.area,
          city: user.city,
          locationDisplay: loc,
          description: `Queue #${actualPos} • ${progress}/${REQUIRED} (${pct}%) • ${loc}`,
          createdAt: new Date().toISOString()
        });
      }
    }

    console.log(`Returning ${cards.length} Active cards\n`);
    res.json(cards);
  } catch (error) {
    console.error('Incomplete queue error:', error);
    res.status(400).json({ message: error.message });
  }
});


router.get('/supporters/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { slotNumber, location } = req.query;
    console.log('Backend - Getting supporters for user:', userId, 'Slot:', slotNumber, 'Location:', location);

    const transactions = await BubbleTransaction.findAll({
      where: {
        toUserId: parseInt(userId),
        status: 'completed'
      },
      order: [['createdAt', 'ASC']],
      raw: true
    });

    const supporterMap = new Map();
    let cumulativeBubbles = 0;

    for (const tx of transactions) {
      const supporterId = tx.fromUserId;
      
      if (!supporterMap.has(supporterId)) {
        const supporter = await User.findByPk(supporterId, {
          attributes: ['id', 'name', 'area', 'city']
        });
        
        if (supporter) {
          supporterMap.set(supporterId, {
            id: supporter.id,
            name: supporter.name,
            avatar: supporter.name.charAt(0).toUpperCase(),
            location: `${supporter.area || supporter.city || 'Unknown'}`,
            city: supporter.city,
            area: supporter.area,
            totalSupported: 0,
            supportCount: 0,
            transactions: [],
            firstSupport: tx.createdAt,
            lastSupport: tx.createdAt
          });
        }
      }

      const supporterData = supporterMap.get(supporterId);
      if (supporterData) {
        supporterData.totalSupported += tx.bubbleAmount;
        supporterData.supportCount += 1;
        supporterData.lastSupport = tx.createdAt;
        
        supporterData.transactions.push({
          amount: tx.bubbleAmount,
          cumulativeStart: cumulativeBubbles,
          cumulativeEnd: cumulativeBubbles + tx.bubbleAmount,
          date: tx.createdAt
        });
        
        cumulativeBubbles += tx.bubbleAmount;
      }
    }

    let supporters = Array.from(supporterMap.values());
    console.log(`Backend - Before filter: ${supporters.length} total supporters`);

    if (location && location !== 'All') {
      console.log(`Backend - Applying location filter: "${location}"`);
      const knownCities = ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Hyderabad', 'Quetta', 'Peshawar', 'Sukkur', 'Larkana', 'Mirpurkhas', 'Gwadar', 'Turbat', 'Khuzdar', 'Mardan', 'Abbottabad', 'Swat', 'Gujranwala', 'Sialkot'];
      
      const isCity = knownCities.includes(location);
      console.log(`Backend - Is "${location}" a known city? ${isCity}`);
      
      supporters = supporters.filter(supporter => {
        const match = isCity ? supporter.city === location : supporter.area === location;
        console.log(`Backend - Supporter ${supporter.name} (${supporter.area}, ${supporter.city}) - Match: ${match}`);
        return match;
      });
      
      console.log(`Backend - After filter: ${supporters.length} supporters from location: ${location}`);
    } else {
      console.log(`Backend - No location filter applied (location: "${location}")`);
    }

    if (slotNumber) {
      const slot = parseInt(slotNumber);
      const slotStart = (slot - 1) * 400;
      const slotEnd = slot * 400;

      const slotSupporters = [];

      for (const supporter of supporters) {
        let slotContribution = 0;

        for (const tx of supporter.transactions) {
          const txStart = tx.cumulativeStart;
          const txEnd = tx.cumulativeEnd;

          if (txEnd > slotStart && txStart < slotEnd) {
            const contributionStart = Math.max(txStart, slotStart);
            const contributionEnd = Math.min(txEnd, slotEnd);
            const contribution = contributionEnd - contributionStart;
            if (contribution > 0) {
              slotContribution += contribution;
            }
          }
        }

        if (slotContribution > 0) {
          slotSupporters.push({
            id: supporter.id,
            name: supporter.name,
            avatar: supporter.avatar,
            location: supporter.location,
            totalSupported: slotContribution,
            supportCount: supporter.supportCount,
            originalTotal: supporter.totalSupported,
            slotContribution: slotContribution,
            firstSupport: supporter.firstSupport,
            lastSupport: supporter.lastSupport
          });
        }
      }

      supporters = slotSupporters;
    } else {
      const user = await User.findByPk(userId);
      if (user) {
        const totalReceived = transactions.reduce((sum, tx) => sum + tx.bubbleAmount, 0);
        const completedSlots = Math.floor(totalReceived / 400);
        const totalCompleted = completedSlots * 400;
        const inProgress = totalReceived % 400;
        
        if (inProgress > 0) {
          const adjustedSupporters = [];
          
          for (const supporter of supporters) {
            let adjustedTotal = 0;
            
            for (const tx of supporter.transactions) {
              if (tx.cumulativeEnd <= totalCompleted) {
                adjustedTotal += tx.amount;
              } else if (tx.cumulativeStart < totalCompleted) {
                adjustedTotal += totalCompleted - tx.cumulativeStart;
              }
            }
            
            if (adjustedTotal > 0) {
              adjustedSupporters.push({
                id: supporter.id,
                name: supporter.name,
                avatar: supporter.avatar,
                location: supporter.location,
                totalSupported: adjustedTotal,
                supportCount: supporter.supportCount,
                firstSupport: supporter.firstSupport,
                lastSupport: supporter.lastSupport
              });
            }
          }
          
          supporters = adjustedSupporters;
        }
      }
    }
   
    supporters.sort((a, b) => b.totalSupported - a.totalSupported);

    console.log(`Backend - Returning ${supporters.length} supporters`);
    res.json(supporters);
  } catch (error) {
    console.error('Backend - Get supporters error:', error);
    res.status(400).json({ message: error.message });
  }
});

router.get('/completed-separate', async (req, res) => {
  try {
    console.log('Backend - Getting separate completed transactions for user:', req.user.id);
    
    const currentUser = await User.findByPk(req.user.id);
    if (!currentUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    const receivedTransactions = await BubbleTransaction.findAll({
      where: {
        toUserId: req.user.id,
        status: 'completed'
      },
      order: [['updatedAt', 'ASC']]
    });

    const totalReceived = receivedTransactions.reduce((sum, tx) => sum + tx.bubbleAmount, 0);
    const completedSlots = Math.floor(totalReceived / 400);
    
    const separateCards = [];
    let bubbleCounter = 0;
    let txIndex = 0;
    
    for (let i = 0; i < completedSlots; i++) {
      const slotEnd = (i + 1) * 400;
      let slotCompletedDate = null;
      
      while (bubbleCounter < slotEnd && txIndex < receivedTransactions.length) {
        const tx = receivedTransactions[txIndex];
        bubbleCounter += tx.bubbleAmount;
        txIndex++;
        
        if (bubbleCounter >= slotEnd) {
          slotCompletedDate = tx.updatedAt || tx.createdAt;
          break;
        }
      }
      
      separateCards.push({
        id: `completed-slot-${i}`,
        userId: currentUser.id,
        userName: currentUser.name,
        bubbleAmount: 400,
        slotNumber: i + 1,
        totalBubbles: 400,
        creatorColor: '#10b981',
        description: `Completed Queue Slot #${i + 1} • 400 bubbles`,
        status: 'completed',
        isCompleted: true,
        createdAt: slotCompletedDate,
        updatedAt: slotCompletedDate
      });
    }

    res.json(separateCards);
  } catch (error) {
    console.error('Backend - Separate completed error:', error);
    res.status(400).json({ message: error.message });
  }
});

router.get('/completed-cumulative', async (req, res) => {
  try {
    console.log('Backend - Getting cumulative completed for user:', req.user.id);
    const { location } = req.query; // Add location parameter
    
    const currentUser = await User.findByPk(req.user.id);
    if (!currentUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Get received transactions
    const receivedTransactions = await BubbleTransaction.findAll({
      where: {
        toUserId: req.user.id,
        status: 'completed'
      }
    });

    const totalReceived = receivedTransactions.reduce((sum, tx) => sum + tx.bubbleAmount, 0);
    const completedSlots = Math.floor(totalReceived / 400);
    const totalCompleted = completedSlots * 400;
    const inProgress = totalReceived % 400;

    if (totalCompleted === 0) {
      return res.json([]);
    }

    // Get all supporters with their individual contributions
    const supporterMap = new Map();
    for (const tx of receivedTransactions) {
      const supporterId = tx.fromUserId;
      
      if (!supporterMap.has(supporterId)) {
        const supporter = await User.findByPk(supporterId, {
          attributes: ['id', 'name', 'area', 'city', 'country', 'province']
        });
        
        if (supporter) {
          supporterMap.set(supporterId, {
            id: supporter.id,
            name: supporter.name,
            avatar: supporter.name.charAt(0).toUpperCase(),
            location: `${supporter.area || ''} ${supporter.city || ''}`.trim() || 'Unknown',
            city: supporter.city,
            area: supporter.area,
            country: supporter.country,
            province: supporter.province,
            totalSupported: 0,
            supportCount: 0,
            firstSupport: tx.createdAt,
            lastSupport: tx.createdAt
          });
        }
      }

      const supporterData = supporterMap.get(supporterId);
      if (supporterData) {
        supporterData.totalSupported += tx.bubbleAmount;
        supporterData.supportCount += 1;
        supporterData.lastSupport = tx.createdAt;
      }
    }

    let supporters = Array.from(supporterMap.values());
    
    // Apply location filter if provided
    if (location && location !== 'All') {
      console.log(`Backend - Applying location filter to supporters: "${location}"`);
      
      const knownCities = ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Hyderabad', 'Quetta', 'Peshawar', 'Sukkur', 'Larkana', 'Mirpurkhas', 'Gwadar', 'Turbat', 'Khuzdar', 'Mardan', 'Abbottabad', 'Swat', 'Gujranwala', 'Sialkot'];
      const knownAreas = ['Bahria Town', 'DHA', 'Clifton', 'Gulshan', 'Malir', 'Saddar', 'North Nazimabad', 'Gulberg', 'Johar Town', 'Model Town', 'Latifabad', 'Qasimabad', 'Cantonment', 'Hussainabad', 'F-6', 'F-7', 'F-8', 'G-6', 'G-7', 'Blue Area'];
      
      const isCity = knownCities.includes(location);
      
      supporters = supporters.filter(supporter => {
        if (isCity) {
          return supporter.city === location;
        } else {
          // Check area or any location field
          return supporter.area === location || 
                 supporter.city === location || 
                 supporter.province === location ||
                 supporter.country === location;
        }
      });
      
      console.log(`Backend - After filter: ${supporters.length} supporters from location: ${location}`);
    }

    supporters.sort((a, b) => b.totalSupported - a.totalSupported);

    // Calculate filtered totals
    const filteredTotalSupport = supporters.reduce((sum, s) => sum + s.totalSupported, 0);
    const filteredTotalSupporters = supporters.length;

    res.json([{
      id: 'cumulative-total',
      userId: currentUser.id,
      userName: currentUser.name,
      bubbleAmount: totalCompleted,
      completedSlots: completedSlots,
      inProgressBubbles: inProgress,
      totalReceived: totalReceived,
      creatorColor: '#10b981',
      description: `${completedSlots} Completed Slots • ${totalCompleted} bubbles`,
      status: 'completed',
      isCumulative: true,
      // Add filtered supporters data
      supporters: supporters,
      totalSupporters: filteredTotalSupporters,
      totalSupport: filteredTotalSupport,
      // Include location filter info
      locationFilter: location || 'All'
    }]);
  } catch (error) {
    console.error('Backend - Cumulative completed error:', error);
    res.status(400).json({ message: error.message });
  }
});

router.get('/leaderboard', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    console.log('Backend - Getting leaderboard, limit:', limit);
    
    const supportStats = await BubbleTransaction.findAll({
      where: { 
        status: 'completed',
        type: 'support'
      },
      attributes: [
        'fromUserId',
        [literal('SUM(bubbleAmount)'), 'totalSupported'],
        [literal('COUNT(*)'), 'supportCount'],
        [literal('SUM(slotsOpened)'), 'totalSlotsOpened']
      ],
      group: ['fromUserId'],
      order: [[literal('totalSupported'), 'DESC']],
      limit: parseInt(limit),
      raw: true
    });
    
    console.log(`Backend - Found ${supportStats.length} supporters with stats:`, supportStats);
    
    const leaderboard = [];
    for (let i = 0; i < supportStats.length; i++) {
      const stat = supportStats[i];
      const user = await User.findByPk(stat.fromUserId, {
        attributes: ['id', 'name', 'email', 'country', 'province', 'city', 'area', 'queuePosition', 'queueSlots']
      });
      
      if (user) {
        const totalSupported = parseInt(stat.totalSupported);
        const supportCount = parseInt(stat.supportCount);
        const totalSlotsOpened = parseInt(stat.totalSlotsOpened) || 0;
        
        let level = 'Bronze';
        let gradient = ['#CD7F32', '#B8860B'];
        if (totalSupported >= 5000) {
          level = 'Diamond';
          gradient = ['#b9f2ff', '#667eea'];
        } else if (totalSupported >= 3000) {
          level = 'Platinum';
          gradient = ['#E5E4E2', '#C0C0C0'];
        } else if (totalSupported >= 1500) {
          level = 'Gold';
          gradient = ['#FFD700', '#FFA500'];
        } else if (totalSupported >= 500) {
          level = 'Silver';
          gradient = ['#C0C0C0', '#A8A8A8'];
        }
        
        const locationParts = [];
        if (user.area) locationParts.push(user.area);
        if (user.city && user.city !== user.area) locationParts.push(user.city);
        const location = locationParts.length > 0 ? locationParts.join(', ') : 'Unknown';
        
        leaderboard.push({
          id: user.id,
          name: user.name,
          avatar: user.name.charAt(0).toUpperCase(),
          rank: i + 1,
          points: totalSupported,
          totalSupported: totalSupported,
          supportCount: supportCount,
          totalSlotsOpened: totalSlotsOpened,
          level: level,
          gradient: gradient,
          queuePosition: user.queuePosition,
          queueSlots: user.queueSlots,
          location: location,
          country: user.country,
          province: user.province,
          city: user.city,
          area: user.area
        });
      }
    }
    
    console.log(`Backend - Returning ${leaderboard.length} leaderboard entries`);
    res.json(leaderboard);
  } catch (error) {
    console.error('Backend - Leaderboard error:', error);
    res.status(400).json({ message: error.message || 'Failed to get leaderboard' });
  }
});

router.get('/active', async (req, res) => {
  try {
    const transactions = await BubbleTransaction.findAll({
      where: { 
        toUserId: req.user.id,
        status: 'completed'
      },
      attributes: [
        'fromUserId',
        [literal('SUM(bubbleAmount)'), 'totalSupported'],
        [literal('COUNT(*)'), 'supportCount']
      ],
      group: ['fromUserId'],
      order: [[literal('totalSupported'), 'DESC']],
      raw: true
    });
    
    const enriched = [];
    for (const tx of transactions) {
      const supporter = await User.findByPk(tx.fromUserId);
      enriched.push({
        userId: tx.fromUserId,
        userName: supporter?.name || 'Unknown',
        bubbleAmount: parseInt(tx.totalSupported),
        supportCount: parseInt(tx.supportCount),
        description: `Supported you ${tx.supportCount} times`
      });
    }
    
    res.json(enriched);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.get('/completed-individual', async (req, res) => {
  try {
    const transactions = await BubbleTransaction.findAll({
      where: {
        [Op.or]: [
          { fromUserId: req.user.id },
          { toUserId: req.user.id }
        ],
        status: 'completed'
      },
      order: [['createdAt', 'DESC']],
      limit: 100
    });
    
    const enriched = [];
    for (const tx of transactions) {
      const otherUser = await User.findByPk(
        tx.fromUserId === req.user.id ? tx.toUserId : tx.fromUserId
      );
      
      let description;
      if (tx.type === 'donation') {
        description = tx.toUserId === req.user.id 
          ? `Received ${tx.bubbleAmount} bubbles - Free Giveaway`
          : `Sent ${tx.bubbleAmount} bubbles - Free Giveaway`;
      } else {
        description = tx.toUserId === req.user.id 
          ? `Received ${tx.bubbleAmount} bubbles`
          : `Sent ${tx.bubbleAmount} bubbles`;
      }
      
      enriched.push({
        id: tx.id,
        userId: otherUser?.id,
        userName: otherUser?.name || 'Unknown',
        bubbleAmount: tx.bubbleAmount,
        isReceived: tx.toUserId === req.user.id,
        createdAt: tx.createdAt,
        type: tx.type,
        description: description
      });
    }
    
    res.json(enriched);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.get('/completed', async (req, res) => {
  try {
    console.log('Backend - Getting completed transactions for user:', req.user.id);
    
    // Get ALL transactions (not grouped)
    const allTransactions = await BubbleTransaction.findAll({
      where: {
        [Op.or]: [
          { fromUserId: req.user.id },
          { toUserId: req.user.id }
        ],
        status: 'completed'
      },
      order: [['createdAt', 'DESC']],
      limit: 100,
      raw: true
    });
    
    console.log(`Backend - Found ${allTransactions.length} individual transactions`);
    
    const enrichedTransactions = [];
    
    for (const transaction of allTransactions) {
      const isSent = transaction.fromUserId === req.user.id;
      const otherUserId = isSent ? transaction.toUserId : transaction.fromUserId;
      
      const otherUser = await User.findByPk(otherUserId, {
        attributes: ['id', 'name']
      });
      
      let description = '';
      let type = transaction.type;
      let isDonation = type === 'donation';
      
      if (type === 'transfer' && transaction.description && transaction.description.includes('Giveaway')) {
        isDonation = true;
        type = 'donation';
        
        // For giveaway distributions (user received)
        if (!isSent) {
          description = 'Free Giveaway';
        } 
        // For giveaway donations (user donated)
        else {
          description = 'Donated to Giveaway';
        }
      } else if (type === 'donation') {
        description = 'Free Giveaway';
      } else if (type === 'support') {
        description = isSent 
          ? `Sent ${transaction.bubbleAmount} bubbles`
          : `Received ${transaction.bubbleAmount} bubbles`;
      }
      
      // Add transaction count information (always 1 for individual transactions)
      const transactionCount = 1;
      
      enrichedTransactions.push({
        id: transaction.id, // Use actual transaction ID
        userId: otherUserId,
        userName: otherUser ? otherUser.name : 'Unknown User',
        bubbleAmount: transaction.bubbleAmount,
        transactionCount: transactionCount,
        creatorColor: isDonation ? '#f59e0b' : (isSent ? '#f59e0b' : '#10b981'),
        description: description,
        status: 'completed',
        type: type,
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
        isReceived: !isSent,
        isDonation: isDonation,
        // For support transactions, show "to/from" info
        isSupport: type === 'support',
        targetSlotNumber: transaction.targetSlotNumber // Keep slot info if available
      });
    }
    
    console.log(`Backend - Returning ${enrichedTransactions.length} individual transactions`);
    res.json(enrichedTransactions);
  } catch (error) {
    console.error('Backend - Completed transactions error:', error);
    res.status(400).json({ message: error.message || 'Failed to get completed transactions' });
  }
});

router.get('/transaction-details/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { type = 'both' } = req.query;
    
    console.log('Backend - Getting transaction details:', { userId, type, requesterId: req.user.id });
    
    let whereConditions = [];
    
    if (type === 'sent' || type === 'both') {
      whereConditions.push({
        fromUserId: req.user.id,
        toUserId: parseInt(userId),
        status: 'completed'
      });
    }
    
    if (type === 'received' || type === 'both') {
      whereConditions.push({
        fromUserId: parseInt(userId),
        toUserId: req.user.id,
        status: 'completed'
      });
    }
    
    const transactions = await BubbleTransaction.findAll({
      where: {
        [Op.or]: whereConditions
      },
      order: [['createdAt', 'DESC']],
      limit: 100
    });
    
    const otherUser = await User.findByPk(userId, {
      attributes: ['id', 'name', 'bubbleGoal', 'bubblesReceived', 'goalActive']
    });
    
    const detailedTransactions = transactions.map(transaction => ({
      id: transaction.id,
      bubbleAmount: transaction.bubbleAmount,
      type: transaction.fromUserId === req.user.id ? 'sent' : 'received',
      createdAt: transaction.createdAt,
      description: transaction.fromUserId === req.user.id 
        ? `Sent ${transaction.bubbleAmount} bubbles`
        : `Received ${transaction.bubbleAmount} bubbles`
    }));
    
    const summary = {
      totalSent: transactions
        .filter(t => t.fromUserId === req.user.id)
        .reduce((sum, t) => sum + t.bubbleAmount, 0),
      totalReceived: transactions
        .filter(t => t.toUserId === req.user.id)
        .reduce((sum, t) => sum + t.bubbleAmount, 0),
      transactionCount: transactions.length
    };
    
    res.json({
      otherUser: otherUser ? {
        id: otherUser.id,
        name: otherUser.name,
        goalInfo: {
          goal: otherUser.bubbleGoal,
          received: otherUser.bubblesReceived,
          active: otherUser.goalActive
        }
      } : null,
      summary,
      transactions: detailedTransactions
    });
  } catch (error) {
    console.error('Backend - Transaction details error:', error);
    res.status(400).json({ message: error.message || 'Failed to get transaction details' });
  }
});

router.post('/support', async (req, res) => {
  const t = await sequelize.transaction();
  
  try {
    const { toUserId, bubbleAmount, targetSlotNumber } = req.body;
    
    console.log('\n========================================');
    console.log('SUPPORT REQUEST');
    console.log('========================================');
    console.log('From:', req.user.id, '| To:', toUserId, '| Amount:', bubbleAmount, '| Slot:', targetSlotNumber);
    
    // Validations
    if (!toUserId || !bubbleAmount) {
      await t.rollback();
      return res.status(400).json({ message: 'User ID and bubble amount are required' });
    }
    if (bubbleAmount <= 0) {
      await t.rollback();
      return res.status(400).json({ message: 'Bubble amount must be positive' });
    }
    if (toUserId == req.user.id) {
      await t.rollback();
      return res.status(400).json({ message: 'Cannot support yourself' });
    }
    if (!targetSlotNumber || targetSlotNumber <= 0) {
      await t.rollback();
      return res.status(400).json({ message: 'Target slot number is required' });
    }
    
    // Fetch users with lock
    const fromUser = await User.findByPk(req.user.id, { transaction: t, lock: t.LOCK.UPDATE });
    const toUser = await User.findByPk(toUserId, { transaction: t, lock: t.LOCK.UPDATE });
    
    if (!fromUser) { await t.rollback(); return res.status(404).json({ message: 'Your account not found' }); }
    if (!toUser) { await t.rollback(); return res.status(404).json({ message: 'Target user not found' }); }
    
    console.log('FROM:', fromUser.name, '| Bubbles:', fromUser.bubblesCount, '| Pos:', fromUser.queuePosition, '| Slots:', fromUser.queueSlots);
    console.log('TO:', toUser.name, '| Bubbles:', toUser.bubblesCount, '| Pos:', toUser.queuePosition, '| Slots:', toUser.queueSlots);
    
    // Check bubbles
    if (fromUser.bubblesCount < bubbleAmount) {
      await t.rollback();
      return res.status(400).json({ message: `Insufficient bubbles. Have ${fromUser.bubblesCount}, need ${bubbleAmount}` });
    }

    // Validate slot
    if (toUser.queueSlots <= 0) {
      await t.rollback();
      return res.status(400).json({ message: 'Target user has no queue slots' });
    }
    if (targetSlotNumber > toUser.queueSlots) {
      await t.rollback();
      return res.status(400).json({ message: `Invalid slot. User has ${toUser.queueSlots} slots` });
    }
    
    // Queue position validation
    if (fromUser.queuePosition === 0) {
      if (toUser.queuePosition !== 1) {
        await t.rollback();
        return res.status(400).json({ message: 'Must support Queue #1 to join' });
      }
    } else {
      if (toUser.queuePosition >= fromUser.queuePosition) {
        await t.rollback();
        return res.status(400).json({ message: 'Can only support users above you' });
      }
    }
    
    // Parse receiver's slot progress
    let toSlotProgress = {};
    try {
      toSlotProgress = toUser.slotProgress ? JSON.parse(toUser.slotProgress) : {};
    } catch (e) { toSlotProgress = {}; }
    
    // Initialize any missing slots
    for (let i = 1; i <= toUser.queueSlots; i++) {
      if (toSlotProgress[i.toString()] === undefined) {
        toSlotProgress[i.toString()] = 0;
      }
    }
    
    const slotKey = targetSlotNumber.toString();
    const prevProgress = parseInt(toSlotProgress[slotKey]) || 0;
    const newProgress = prevProgress + bubbleAmount;
    const REQUIRED = 400;
    
    console.log(`Slot ${targetSlotNumber}: ${prevProgress} + ${bubbleAmount} = ${newProgress}/${REQUIRED}`);
    
    // Deduct from supporter
    fromUser.bubblesCount = parseInt(fromUser.bubblesCount) - bubbleAmount;
    
    // Update progress
    toSlotProgress[slotKey] = newProgress;
    
    // Update bubblesReceived to track all support
toUser.bubblesReceived = parseInt(toUser.bubblesReceived || 0) + bubbleAmount;
console.log(`Updated bubblesReceived: ${toUser.bubblesReceived}`);
    let slotCompleted = false;
    let earned = 0;
    
    // Check completion
    if (newProgress >= REQUIRED) {
      slotCompleted = true;
      earned = REQUIRED;
      
      console.log(`★ SLOT ${targetSlotNumber} COMPLETED ★`);
      
      // Credit receiver
      toUser.bubblesCount = parseInt(toUser.bubblesCount) + earned;
      
      // Remove completed slot and renumber
      delete toSlotProgress[slotKey];
      
      const oldKeys = Object.keys(toSlotProgress).map(k => parseInt(k)).sort((a, b) => a - b);
      const newProgress2 = {};
      let newNum = 1;
      for (const oldKey of oldKeys) {
        newProgress2[newNum.toString()] = toSlotProgress[oldKey.toString()];
        newNum++;
      }
      toSlotProgress = newProgress2;
      
      // Decrease slots
      toUser.queueSlots = Math.max(0, parseInt(toUser.queueSlots) - 1);
      
      // If no slots, remove from queue
      if (toUser.queueSlots === 0) {
        toUser.queuePosition = 0;
        toSlotProgress = {};
        console.log('Receiver removed from queue');
      }
      
      console.log('Receiver now has', toUser.queueSlots, 'slots');
    }
    
    toUser.slotProgress = JSON.stringify(toSlotProgress);
    
    // Calculate slots for supporter
    const slotsForSupporter = Math.floor(bubbleAmount / 100);
    console.log(`Supporter gets ${slotsForSupporter} slots (${bubbleAmount}/100)`);
    
    if (slotsForSupporter > 0) {
      // Parse supporter's progress
      let fromSlotProgress = {};
      try {
        fromSlotProgress = fromUser.slotProgress ? JSON.parse(fromUser.slotProgress) : {};
      } catch (e) { fromSlotProgress = {}; }
      
      if (fromUser.queuePosition === 0) {
        // Find max position
        const allQueued = await User.findAll({
          where: { queuePosition: { [Op.gt]: 0 }, id: { [Op.ne]: toUser.id } },
          attributes: ['id', 'queuePosition', 'queueSlots'],
          transaction: t
        });
        
        let maxPos = 0;
        if (toUser.queuePosition > 0 && toUser.queueSlots > 0) {
          maxPos = toUser.queuePosition + toUser.queueSlots - 1;
        }
        for (const u of allQueued) {
          const uMax = u.queuePosition + (parseInt(u.queueSlots) || 1) - 1;
          if (uMax > maxPos) maxPos = uMax;
        }
        
        fromUser.queuePosition = maxPos + 1;
        fromUser.queueSlots = slotsForSupporter;
        
        // Initialize ALL slots
        fromSlotProgress = {};
        for (let i = 1; i <= slotsForSupporter; i++) {
          fromSlotProgress[i.toString()] = 0;
        }
        
        console.log(`Supporter JOINED at position ${fromUser.queuePosition} with ${slotsForSupporter} slots`);
      } else {
        // Add more slots
        const current = parseInt(fromUser.queueSlots) || 0;
        fromUser.queueSlots = current + slotsForSupporter;
        
        for (let i = current + 1; i <= fromUser.queueSlots; i++) {
          fromSlotProgress[i.toString()] = 0;
        }
        
        console.log(`Supporter now has ${fromUser.queueSlots} slots`);
      }
      
      fromUser.slotProgress = JSON.stringify(fromSlotProgress);
    }
    
    // Save
    await fromUser.save({ transaction: t });
    await toUser.save({ transaction: t });
    
    // Rebalance if completed
    if (slotCompleted) {
      await rebalanceQueuePositions(t);
    }
    
    // Create transaction
    const tx = await BubbleTransaction.create({
      fromUserId: req.user.id,
      toUserId: parseInt(toUserId),
      bubbleAmount,
      targetSlotNumber,
      type: 'support',
      status: 'completed',
      queuePosition: fromUser.queuePosition,
      slotsOpened: slotsForSupporter
    }, { transaction: t });
    
    await t.commit();
    
    // Fetch fresh
    const finalFrom = await User.findByPk(req.user.id);
    const finalTo = await User.findByPk(toUserId);
    
    let fromProg = {};
    try { fromProg = JSON.parse(finalFrom.slotProgress || '{}'); } catch(e) {}
    
    let toProg = {};
    try { toProg = JSON.parse(finalTo.slotProgress || '{}'); } catch(e) {}
    
    console.log('========================================');
    console.log('FINAL - Supporter:', finalFrom.name, '| Pos:', finalFrom.queuePosition, '| Slots:', finalFrom.queueSlots, '| Progress:', fromProg);
    console.log('FINAL - Receiver:', finalTo.name, '| Pos:', finalTo.queuePosition, '| Slots:', finalTo.queueSlots, '| Progress:', toProg);
    console.log('========================================\n');
    
    res.json({
      message: slotCompleted 
        ? `Slot ${targetSlotNumber} completed! ${toUser.name} earned ${earned} bubbles!` 
        : `Supported slot ${targetSlotNumber}: ${newProgress}/${REQUIRED}`,
      slotCompleted,
      slotNumber: targetSlotNumber,
      slotProgress: slotCompleted ? 0 : newProgress,
      supporterJoinedQueue: finalFrom.queuePosition > 0,
      supporterQueuePosition: finalFrom.queuePosition,
      queueSlotsOpened: slotsForSupporter,
      supporterTotalSlots: finalFrom.queueSlots,
      transaction: tx,
      user: {
        id: finalFrom.id,
        name: finalFrom.name,
        email: finalFrom.email,
        bubblesCount: parseInt(finalFrom.bubblesCount),
        queuePosition: finalFrom.queuePosition,
        queueBubbles: finalFrom.queueBubbles,
        queueSlots: finalFrom.queueSlots,
        slotProgress: fromProg
      },
      receiverData: {
        id: finalTo.id,
        name: finalTo.name,
        bubblesCount: parseInt(finalTo.bubblesCount),
        queueSlots: finalTo.queueSlots,
        queuePosition: finalTo.queuePosition,
        slotProgress: toProg
      }
    });
    
  } catch (error) {
    await t.rollback();
    console.error('Support error:', error);
    res.status(400).json({ message: error.message || 'Support failed' });
  }
});

router.post('/set-goal', async (req, res) => {
  try {
    const { bubbleGoal, goalDescription } = req.body;
    
    console.log('Backend - Set goal request:', { userId: req.user.id, bubbleGoal, goalDescription });
    
    if (!bubbleGoal || bubbleGoal <= 0) {
      return res.status(400).json({ message: 'Valid bubble goal is required (must be > 0)' });
    }
    
    if (bubbleGoal > 10000) {
      return res.status(400).json({ message: 'Bubble goal too high (max 10,000)' });
    }
    
    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    if (user.goalActive && user.bubbleGoal > 0) {
      return res.status(400).json({ 
        message: 'You already have an active goal. Complete or cancel it first.' 
      });
    }
    
    user.bubbleGoal = parseInt(bubbleGoal);
    user.bubblesReceived = 0;
    user.goalDescription = goalDescription || `Help me reach ${bubbleGoal} bubbles!`;
    user.goalActive = true;
    
    await user.save();
    
    console.log(`Backend - Goal set for user ${user.name}: ${bubbleGoal} bubbles`);
    
    res.json({
      message: 'Goal set successfully',
      goal: {
        bubbleGoal: user.bubbleGoal,
        goalDescription: user.goalDescription,
        bubblesReceived: user.bubblesReceived,
        remaining: user.bubbleGoal - user.bubblesReceived,
        active: user.goalActive
      }
    });
  } catch (error) {
    console.error('Backend - Set goal error:', error);
    res.status(400).json({ message: error.message || 'Failed to set goal' });
  }
});

router.post('/cancel-goal', async (req, res) => {
  try {
    console.log('Backend - Cancel goal request for user:', req.user.id);
    
    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    if (!user.goalActive) {
      return res.status(400).json({ message: 'No active goal to cancel' });
    }
    
    const wasCompleted = user.bubblesReceived >= user.bubbleGoal;
    
    if (wasCompleted) {
      user.bubblesCount = parseInt(user.bubblesCount) + parseInt(user.bubbleGoal);
    }
    
    user.goalActive = false;
    user.bubbleGoal = 0;
    user.bubblesReceived = 0;
    user.goalDescription = null;
    
    await user.save();
    
    console.log(`Backend - Goal ${wasCompleted ? 'completed' : 'cancelled'} for user ${user.name}`);
    
    res.json({
      message: wasCompleted ? 'Goal completed successfully!' : 'Goal cancelled',
      completed: wasCompleted,
      bubblesEarned: wasCompleted ? user.bubbleGoal : 0,
      currentBubbles: user.bubblesCount
    });
  } catch (error) {
    console.error('Backend - Cancel goal error:', error);
    res.status(400).json({ message: error.message || 'Failed to cancel goal' });
  }
});

router.get('/my-goal', async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'name', 'bubbleGoal', 'bubblesReceived', 'goalDescription', 'goalActive', 'bubblesCount']
    });
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    const goalData = {
      hasActiveGoal: user.goalActive,
      bubbleGoal: user.bubbleGoal,
      bubblesReceived: user.bubblesReceived,
      remaining: Math.max(0, user.bubbleGoal - user.bubblesReceived),
      progress: user.bubbleGoal > 0 ? Math.round((user.bubblesReceived / user.bubbleGoal) * 100) : 0,
      goalDescription: user.goalDescription,
      currentBubbles: user.bubblesCount,
      isCompleted: user.bubblesReceived >= user.bubbleGoal && user.bubbleGoal > 0
    };
    
    res.json(goalData);
  } catch (error) {
    console.error('Backend - Get goal error:', error);
    res.status(400).json({ message: error.message || 'Failed to get goal' });
  }
});

// Update the /giveaway/donate route to accept location parameter
router.post('/giveaway/donate', async (req, res) => {
  const { category, bubbles, location } = req.body; // Added location parameter
  const userId = req.user?.id;

  console.log('🎁 Giveaway donation request with location:', { 
    userId, 
    category, 
    bubbles,
    location 
  });

  if (!userId) return res.status(401).json({ message: 'User not authenticated' });
  if (!category || !bubbles || bubbles <= 0)
    return res.status(400).json({ message: 'category, bubbles (>0) required' });

  const t = await sequelize.transaction();
  try {
    console.log(`\n🎁 GIVEAWAY DONATION START`);
    console.log(`   Donor: User ${userId}`);
    console.log(`   Category: ${category}`);
    console.log(`   Location Filter: ${location || 'All'}`);
    console.log(`   Donation: ${bubbles} bubbles`);

    const donor = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!donor) throw new Error('Donor not found');
    if (donor.bubblesCount < bubbles)
      throw new Error(`Insufficient bubbles. You have ${donor.bubblesCount}, trying to donate ${bubbles}`);

    const giveaway = await Giveaway.findOne({
      where: { category, distributed: false },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!giveaway) {
      await t.rollback();
      return res.status(400).json({ message: `No active ${category} giveaway. Admin hasn't set it up yet.` });
    }

    const amountPerUser = giveaway.amountPerUser;
    if (amountPerUser <= 0) throw new Error('Invalid giveaway amount per user');

    console.log(`   Amount per user: ${amountPerUser}`);

    donor.bubblesCount -= bubbles;
    await donor.save({ transaction: t });
    console.log(`   ✅ Deducted ${bubbles} from donor. New balance: ${donor.bubblesCount}`);

    await BubbleTransaction.create({
      fromUserId: userId,
      toUserId: userId,
      bubbleAmount: bubbles,
      type: 'donation',
      status: 'completed',
      giveaway: 1,
      description: `Donated ${bubbles} bubbles to ${category} Giveaway${location && location !== 'All' ? ` (${location})` : ''}`,
    }, { transaction: t });
    console.log(`   ✅ Recorded donation transaction`);

    // Build query with location filter
    let eligibleUsersQuery = `
      SELECT u.id, u.name, u.createdAt, u.area, u.city,
             COALESCE(SUM(bt.bubbleAmount), 0) AS totalDonated
      FROM users u
      JOIN bubble_transactions bt ON bt.fromUserId = u.id
      WHERE u.isActive = 1 
        AND u.id != :donorId
        AND bt.type IN ('support', 'donation', 'transfer')
        AND bt.status = 'completed'
        AND (bt.giveaway = 0 OR bt.giveaway IS NULL)
    `;

    // Add location filter if provided
    if (location && location !== 'All') {
      const knownCities = ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Hyderabad', 'Quetta', 'Peshawar'];
      const knownAreas = ['Bahria Town', 'DHA', 'Clifton', 'Gulshan', 'Malir', 'Saddar', 'North Nazimabad', 'Gulberg', 'Johar Town', 'Model Town'];
      
      if (knownCities.includes(location)) {
        eligibleUsersQuery += ` AND u.city = :location `;
      } else if (knownAreas.includes(location)) {
        eligibleUsersQuery += ` AND u.area = :location `;
      } else {
        eligibleUsersQuery += ` AND (u.city = :location OR u.area = :location) `;
      }
    }

    eligibleUsersQuery += `
      GROUP BY u.id, u.name, u.createdAt, u.area, u.city
      ORDER BY totalDonated DESC, u.createdAt ASC
    `;

    const eligibleUsers = await sequelize.query(eligibleUsersQuery, {
      replacements: { 
        donorId: userId,
        ...(location && location !== 'All' ? { location } : {})
      },
      type: sequelize.QueryTypes.SELECT,
      transaction: t,
    });

    const eligibleCount = eligibleUsers.length;

    if (eligibleCount === 0) {
      await t.rollback();
      return res.status(400).json({ 
        message: location && location !== 'All' 
          ? `No eligible users found in ${location}. Try selecting a different location or 'All'.`
          : 'No eligible users found.'
      });
    }

    console.log(`   📊 Found ${eligibleCount} eligible users in ${location || 'all locations'}`);

    // Rest of the distribution logic remains the same...
    let remaining = bubbles;
    const recipientMap = new Map();
    let round = 1;
    let userIndex = 0;

    while (remaining > 0 && eligibleUsers.length > 0) {
      const user = eligibleUsers[userIndex];
      const giveAmount = remaining >= amountPerUser ? amountPerUser : remaining;

      if (!recipientMap.has(user.id)) {
        recipientMap.set(user.id, { ...user, totalReceived: 0 });
      }

      recipientMap.get(user.id).totalReceived += giveAmount;
      remaining -= giveAmount;

      console.log(`   🎯 Round ${round} → ${user.name} (${user.city}/${user.area}) +${giveAmount}, Remaining: ${remaining}`);

      userIndex++;
      if (userIndex >= eligibleUsers.length) {
        userIndex = 0;
        round++;
      }
    }

    console.log(`\n✅ Distribution finished in ${round - 1} rounds`);
    console.log(`   Remaining: ${remaining} (should be 0)`);

    const finalTransactions = [];
    const updates = [];
    const recipientsList = [];

    let totalDistributed = 0;
    for (const [id, data] of recipientMap) {
      finalTransactions.push({
        fromUserId: userId,
        toUserId: id,
        bubbleAmount: data.totalReceived,
        type: 'transfer',
        status: 'completed',
        giveaway: 1,
        description: `${category} Giveaway Distribution${location && location !== 'All' ? ` (${location})` : ''}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      updates.push(`WHEN ${id} THEN bubblesCount + ${data.totalReceived}`);
      totalDistributed += data.totalReceived;
      recipientsList.push({
        rank: recipientsList.length + 1,
        userId: id,
        name: data.name,
        location: `${data.area || ''} ${data.city || ''}`.trim() || 'Unknown',
        totalDonated: data.totalDonated,
        received: data.totalReceived,
      });
    }

    await BubbleTransaction.bulkCreate(finalTransactions, { transaction: t });
    console.log(`   ✅ Inserted ${finalTransactions.length} transfer transactions`);

    const ids = Array.from(recipientMap.keys()).join(',');
    await sequelize.query(`
      UPDATE users 
      SET bubblesCount = CASE id ${updates.join(' ')} END
      WHERE id IN (${ids});
    `, { transaction: t });
    console.log(`   ✅ Updated ${recipientMap.size} user balances`);

    await sequelize.query(
      `UPDATE giveaways 
       SET totalDonated = COALESCE(totalDonated, 0) + :bubbles,
           eligibleUsers = :eligibleCount
       WHERE id = :giveawayId`,
      {
        replacements: {
          bubbles: bubbles,
          eligibleCount: eligibleCount,
          giveawayId: giveaway.id
        },
        transaction: t
      }
    );

    await t.commit();

    console.log(`✅ COMPLETE - Distributed ${totalDistributed} bubbles to ${recipientMap.size} users in ${location || 'all locations'}`);

    const updatedDonor = await User.findByPk(userId, {
      attributes: ['id', 'name', 'email', 'bubblesCount', 'queuePosition', 'queueBubbles', 'queueSlots']
    });

    res.json({
      success: true,
      message: `Distributed ${totalDistributed} bubbles to ${recipientMap.size} users${location && location !== 'All' ? ` in ${location}` : ''}`,
      distribution: {
        giveawayId: giveaway.id,
        category,
        amountPerUser,
        location: location || 'All',
        rounds: round - 1,
        totalDistributed,
        recipientCount: recipientMap.size,
        recipients: recipientsList,
      },
      updatedUser: {
        id: updatedDonor.id,
        name: updatedDonor.name,
        email: updatedDonor.email,
        bubblesCount: parseInt(updatedDonor.bubblesCount),
        queuePosition: updatedDonor.queuePosition,
        queueBubbles: updatedDonor.queueBubbles,
        queueSlots: updatedDonor.queueSlots
      }
    });
  } catch (e) {
    await t.rollback();
    console.error('❌ Giveaway donate error:', e);
    console.error('Error details:', e.message);
    res.status(400).json({ message: e.message || 'Donation failed' });
  }
});


// routes/get.js - Add these routes after existing giveaway routes

// Get eligible users with location filter for giveaway
router.get('/giveaway/eligible-users/:category', async (req, res) => {
  try {
    const { category } = req.params;
    const { location } = req.query; // Can be city or area
    const donorId = req.user.id;

    console.log('🎁 Getting eligible users for giveaway with location filter:', {
      category,
      location,
      donorId
    });

    // Check if giveaway exists
    const giveaway = await Giveaway.findOne({
      where: { category, distributed: false },
      attributes: ['id', 'amountPerUser']
    });

    if (!giveaway) {
      return res.status(404).json({ message: `No active ${category} giveaway` });
    }

    // Base query
    let query = `
      SELECT u.id, u.name, u.createdAt, u.area, u.city, u.province,
             COALESCE(SUM(bt.bubbleAmount), 0) AS totalDonated
      FROM users u
      JOIN bubble_transactions bt ON bt.fromUserId = u.id
      WHERE u.isActive = 1 
        AND u.id != :donorId
        AND bt.type IN ('support', 'donation', 'transfer')
        AND bt.status = 'completed'
        AND (bt.giveaway = 0 OR bt.giveaway IS NULL)
    `;

    // Add location filter if provided
    if (location && location !== 'All') {
      const knownCities = ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Hyderabad', 'Quetta', 'Peshawar'];
      const knownAreas = ['Bahria Town', 'DHA', 'Clifton', 'Gulshan', 'Malir', 'Saddar', 'North Nazimabad', 'Gulberg', 'Johar Town', 'Model Town'];
      
      if (knownCities.includes(location)) {
        query += ` AND u.city = :location `;
      } else if (knownAreas.includes(location)) {
        query += ` AND u.area = :location `;
      } else {
        // Check any location field
        query += ` AND (u.city = :location OR u.area = :location OR u.province = :location) `;
      }
    }

    query += `
      GROUP BY u.id, u.name, u.createdAt, u.area, u.city, u.province
      ORDER BY totalDonated DESC, u.createdAt ASC
    `;

    const eligibleUsers = await sequelize.query(query, {
      replacements: { 
        donorId,
        ...(location && location !== 'All' ? { location } : {})
      },
      type: sequelize.QueryTypes.SELECT,
    });

    // Get top donors for preview (max 5)
    const topDonors = eligibleUsers.slice(0, 5).map((user, index) => ({
      rank: index + 1,
      userId: user.id,
      name: user.name,
      location: `${user.area || ''} ${user.city || ''}`.trim() || 'Unknown',
      totalDonated: user.totalDonated
    }));

    res.json({
      eligibleCount: eligibleUsers.length,
      amountPerUser: giveaway.amountPerUser,
      topDonors,
      locationApplied: location && location !== 'All' ? location : 'All Locations'
    });
  } catch (e) {
    console.error('❌ Get eligible users error:', e);
    res.status(400).json({ message: e.message || 'Failed to get eligible users' });
  }
});

// Get cities with eligible users for giveaway
router.get('/giveaway/eligible-cities', async (req, res) => {
  try {
    const cities = await sequelize.query(`
      SELECT DISTINCT u.city 
      FROM users u
      JOIN bubble_transactions bt ON bt.fromUserId = u.id
      WHERE u.isActive = 1
        AND u.city IS NOT NULL
        AND bt.type IN ('support', 'donation', 'transfer')
        AND bt.status = 'completed'
        AND (bt.giveaway = 0 OR bt.giveaway IS NULL)
      ORDER BY u.city ASC
    `, {
      type: sequelize.QueryTypes.SELECT
    });

    const cityList = cities.map(c => c.city).filter(Boolean);
    res.json(cityList);
  } catch (e) {
    console.error('❌ Get eligible cities error:', e);
    res.status(400).json({ message: e.message });
  }
});

// Get areas for a specific city with eligible users
router.get('/giveaway/eligible-areas/:city', async (req, res) => {
  try {
    const { city } = req.params;
    
    const areas = await sequelize.query(`
      SELECT DISTINCT u.area 
      FROM users u
      JOIN bubble_transactions bt ON bt.fromUserId = u.id
      WHERE u.isActive = 1
        AND u.city = :city
        AND u.area IS NOT NULL
        AND bt.type IN ('support', 'donation', 'transfer')
        AND bt.status = 'completed'
        AND (bt.giveaway = 0 OR bt.giveaway IS NULL)
      ORDER BY u.area ASC
    `, {
      replacements: { city },
      type: sequelize.QueryTypes.SELECT
    });

    const areaList = areas.map(a => a.area).filter(Boolean);
    res.json(areaList);
  } catch (e) {
    console.error('❌ Get eligible areas error:', e);
    res.status(400).json({ message: e.message });
  }
});



router.get('/giveaway/preview/:category', async (req, res) => {
  try {
    const { category } = req.params;
    
    const giveaway = await Giveaway.findOne({ 
      where: { category, distributed: false },
      attributes: ['id', 'amountPerUser', 'totalDonated', 'createdAt'],
      raw: true
    });
    
    if (!giveaway) {
      return res.status(404).json({ message: `No active ${category} giveaway` });
    }

    const eligibleUsersResult = await sequelize.query(`
      SELECT COUNT(DISTINCT fromUserId) as count
      FROM bubble_transactions
      WHERE type IN ('support', 'donation', 'transfer')
      AND status = 'completed'
      AND (giveaway = 0 OR giveaway IS NULL)
    `, {
      type: sequelize.QueryTypes.SELECT
    });

    const eligibleCount = eligibleUsersResult[0]?.count || 0;

    res.json({
      giveawayId: giveaway.id,
      category,
      amountPerUser: giveaway.amountPerUser,
      eligibleUsers: eligibleCount,
      totalDonated: giveaway.totalDonated || 0,
      createdAt: giveaway.createdAt
    });
  } catch (e) {
    console.error('❌ Preview error:', e);
    res.status(400).json({ message: e.message || 'Failed to fetch preview' });
  }
});

router.get('/leaderboard-giveaway', async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const donationStats = await BubbleTransaction.findAll({
      where: {
        status: 'completed',
        type: 'donation'
      },
      attributes: [
        'fromUserId',
        [literal('SUM(bubbleAmount)'), 'totalDonated'],
        [literal('COUNT(*)'), 'donationCount']
      ],
      group: ['fromUserId'],
      order: [[literal('totalDonated'), 'DESC']],
      limit: parseInt(limit),
      raw: true
    });

    const leaderboard = [];
    for (let i = 0; i < donationStats.length; i++) {
      const stat = donationStats[i];
      const user = await User.findByPk(stat.fromUserId, {
        attributes: ['id', 'name', 'email', 'country', 'province', 'city', 'area']
      });

      if (user) {
        const totalDonated = parseInt(stat.totalDonated);
        const donationCount = parseInt(stat.donationCount);

        let level = 'Bronze';
        let gradient = ['#CD7F32', '#B8860B'];
        if (totalDonated >= 5000) {
          level = 'Diamond';   gradient = ['#b9f2ff', '#667eea'];
        } else if (totalDonated >= 3000) {
          level = 'Platinum';  gradient = ['#E5E4E2', '#C0C0C0'];
        } else if (totalDonated >= 1500) {
          level = 'Gold';      gradient = ['#FFD700', '#FFA500'];
        } else if (totalDonated >= 500) {
          level = 'Silver';    gradient = ['#C0C0C0', '#A8A8A8'];
        }

        const locationParts = [];
        if (user.area) locationParts.push(user.area);
        if (user.city && user.city !== user.area) locationParts.push(user.city);
        const location = locationParts.length ? locationParts.join(', ') : 'Unknown';

        leaderboard.push({
          id: user.id,
          name: user.name,
          avatar: user.name.charAt(0).toUpperCase(),
          rank: i + 1,
          points: totalDonated,
          totalDonated,
          donationCount,
          level,
          gradient,
          location,
          country: user.country,
          province: user.province,
          city: user.city,
          area: user.area
        });
      }
    }

    res.json(leaderboard);
  } catch (error) {
    console.error('Leaderboard-giveaway error:', error);
    res.status(400).json({ message: error.message || 'Failed to get giveaway leaderboard' });
  }
});

router.get('/top-three-donors', async (req, res) => {
  try {
    console.log('Backend - Getting top 3 donors');
    
    const donationStats = await BubbleTransaction.findAll({
      where: { 
        status: 'completed',
        type: 'donation'
      },
      attributes: [
        'fromUserId',
        [literal('SUM(bubbleAmount)'), 'totalDonated'],
        [literal('COUNT(*)'), 'donationCount']
      ],
      group: ['fromUserId'],
      order: [[literal('totalDonated'), 'DESC']],
      limit: 3,
      raw: true
    });
    
    console.log(`Backend - Found ${donationStats.length} top donors`);
    
    const topThree = [];
    for (let i = 0; i < donationStats.length; i++) {
      const stat = donationStats[i];
      const user = await User.findByPk(stat.fromUserId, {
        attributes: ['id', 'name', 'email', 'country', 'province', 'city', 'area']
      });
      
      if (user) {
        const totalDonated = parseInt(stat.totalDonated);
        const donationCount = parseInt(stat.donationCount);
        
        let level = 'Bronze';
        let gradient = ['#CD7F32', '#B8860B'];
        if (totalDonated >= 5000) {
          level = 'Diamond';
          gradient = ['#b9f2ff', '#667eea'];
        } else if (totalDonated >= 3000) {
          level = 'Platinum';
          gradient = ['#E5E4E2', '#C0C0C0'];
        } else if (totalDonated >= 1500) {
          level = 'Gold';
          gradient = ['#FFD700', '#FFA500'];
        } else if (totalDonated >= 500) {
          level = 'Silver';
          gradient = ['#C0C0C0', '#A8A8A8'];
        }
        
        const locationParts = [];
        if (user.area) locationParts.push(user.area);
        if (user.city && user.city !== user.area) locationParts.push(user.city);
        const location = locationParts.length > 0 ? locationParts.join(', ') : 'Unknown';
        
        topThree.push({
          id: user.id,
          name: user.name,
          avatar: user.name.charAt(0).toUpperCase(),
          rank: i + 1,
          points: totalDonated,
          totalDonated: totalDonated,
          donationCount: donationCount,
          level: level,
          gradient: gradient,
          location: location,
          country: user.country,
          province: user.province,
          city: user.city,
          area: user.area
        });
      }
    }
    
    console.log(`Backend - Returning ${topThree.length} top donors`);
    res.json(topThree);
  } catch (error) {
    console.error('Backend - Top donors error:', error);
    res.status(400).json({ message: error.message || 'Failed to get top donors' });
  }
});

router.get('/user/giveaway-bubbles', async (req, res) => {
  try {
    console.log('🎁 Backend - Getting giveaway bubbles for user:', req.user.id);
    
    const giveawayTransactions = await BubbleTransaction.findAll({
      where: {
        toUserId: req.user.id,
        status: 'completed',
        type: 'transfer',
        description: {
          [Op.or]: [
            { [Op.like]: '%Giveaway Distribution%' },
            { [Op.like]: '%Grocery Giveaway%' },
            { [Op.like]: '%Medical Giveaway%' },
            { [Op.like]: '%Education Giveaway%' }
          ]
        }
      },
      raw: true
    });
    
    const totalGiveawayBubbles = giveawayTransactions.reduce((sum, tx) => sum + tx.bubbleAmount, 0);
    
    console.log('🎁 Found giveaway bubbles:', totalGiveawayBubbles, 'from', giveawayTransactions.length, 'transactions');
    console.log('🎁 Sample transactions:', giveawayTransactions.slice(0, 3));
    
    res.json({
      giveawayBubbles: totalGiveawayBubbles,
      totalGiveawayBubbles,
      transactionCount: giveawayTransactions.length
    });
  } catch (error) {
    console.error('❌ Get giveaway bubbles error:', error);
    res.status(400).json({ message: error.message || 'Failed to get giveaway bubbles' });
  }
});


// FIXED VERSION - Add this to your get.js file (replace the previous version)

// ==================== BUBBLE BREAKDOWN ====================
// GET /get/user/bubble-breakdown
// Returns breakdown of user's bubbles by source
// ENHANCED VERSION with detailed logging
// Replace your existing /user/bubble-breakdown endpoint with this

// ==================== SIMPLE BUBBLE BREAKDOWN ROUTE ====================
// Just fetch the LATEST deposit amount, not sum all deposits
// Replace your existing /user/bubble-breakdown route with this

router.get('/user/bubble-breakdown', async (req, res) => {
  try {
    const userId = req.user.id;
    console.log(`\n💰 ==================== BUBBLE BREAKDOWN ====================`);
    console.log(`   User ID: ${userId}`);

    // Get user info
    const user = await User.findByPk(userId, {
      attributes: ['id', 'name', 'bubblesCount']
    });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    console.log(`   User: ${user.name}`);
    console.log(`   Current Total: ${user.bubblesCount} bubbles`);
    console.log(`   ──────────────────────────────────────────────────────`);

    // 1. GET LATEST DEPOSIT (not sum, just the most recent one)
    console.log(`   📥 Fetching LATEST deposit...`);
    const latestDepositResult = await sequelize.query(`
      SELECT amount
      FROM wallettransactions
      WHERE userId = :userId
        AND type = 'bubble_deposit'
      ORDER BY createdAt DESC
      LIMIT 1
    `, {
      replacements: { userId },
      type: sequelize.QueryTypes.SELECT
    });

    const depositedBubbles = latestDepositResult[0]?.amount || 0;
    console.log(`   ✅ Latest Deposit: ${depositedBubbles} bubbles`);

    // 2. SUPPORT RECEIVED
    console.log(`   📥 Checking SUPPORT RECEIVED bubbles...`);
    const supportReceivedResult = await sequelize.query(`
      SELECT 
        COALESCE(SUM(bubbleAmount), 0) as totalReceived,
        COUNT(*) as supportCount
      FROM bubble_transactions
      WHERE toUserId = :userId
        AND status = 'completed'
        AND type = 'support'
        AND giveaway = 0
    `, {
      replacements: { userId },
      type: sequelize.QueryTypes.SELECT
    });

    const supportReceivedBubbles = parseInt(supportReceivedResult[0]?.totalReceived || 0);
    const supportCount = parseInt(supportReceivedResult[0]?.supportCount || 0);
    console.log(`   ✅ From Support: ${supportReceivedBubbles} bubbles (${supportCount} transactions)`);

    // 3. GIVEAWAY BUBBLES
    console.log(`   📥 Checking GIVEAWAY bubbles...`);
    const giveawayResult = await sequelize.query(`
      SELECT 
        COALESCE(SUM(bubbleAmount), 0) as totalGiveaway,
        COUNT(*) as giveawayCount
      FROM bubble_transactions
      WHERE toUserId = :userId
        AND status = 'completed'
        AND giveaway = 1
    `, {
      replacements: { userId },
      type: sequelize.QueryTypes.SELECT
    });

    const giveawayBubbles = parseInt(giveawayResult[0]?.totalGiveaway || 0);
    const giveawayCount = parseInt(giveawayResult[0]?.giveawayCount || 0);
    console.log(`   ✅ Giveaway: ${giveawayBubbles} bubbles (${giveawayCount} transactions)`);

    console.log(`   ──────────────────────────────────────────────────────`);
    console.log(`   📊 BREAKDOWN:`);
    console.log(`      Latest Deposit:   ${depositedBubbles}`);
    console.log(`      From Support:     ${supportReceivedBubbles}`);
    console.log(`      From Giveaway:    ${giveawayBubbles}`);
    console.log(`      ────────────────────`);
    console.log(`      Current Balance:  ${user.bubblesCount}`);
    console.log(`   ══════════════════════════════════════════════════════\n`);

    // Prepare response
    const response = {
      depositedBubbles: depositedBubbles,  // Latest deposit only
      supportReceivedBubbles: supportReceivedBubbles,
      giveawayBubbles: giveawayBubbles,
      totalBubbles: user.bubblesCount,
      breakdown: {
        deposited: depositedBubbles,
        fromSupport: supportReceivedBubbles,
        fromGiveaway: giveawayBubbles,
        current: user.bubblesCount
      }
    };

    res.json(response);

  } catch (error) {
    console.error('❌ Bubble breakdown error:', error);
    res.status(400).json({ 
      message: error.message || 'Failed to get bubble breakdown',
      error: error.toString()
    });
  }
});

// ==================== END OF SIMPLE BUBBLE BREAKDOWN ROUTE ====================
// ==================== END OF FIXED ENDPOINT ====================





// DIAGNOSTIC ENDPOINT - Add this temporarily to debug
// You can remove this after fixing the issue

router.get('/user/bubble-diagnostic', async (req, res) => {
  try {
    const userId = req.user.id;
    console.log(`\n🔍 [DIAGNOSTIC] Checking transactions for user ${userId}`);

    // Get all transactions where user received bubbles
    const receivedTransactions = await sequelize.query(`
      SELECT 
        id,
        fromUserId,
        toUserId,
        bubbleAmount,
        type,
        status,
        giveaway,
        description,
        createdAt
      FROM BubbleTransactions
      WHERE toUserId = :userId
        AND status = 'completed'
      ORDER BY createdAt DESC
      LIMIT 20
    `, {
      replacements: { userId },
      type: sequelize.QueryTypes.SELECT
    });

    console.log(`   Found ${receivedTransactions.length} received transactions`);

    // Count by type
    const typeBreakdown = {
      support: receivedTransactions.filter(t => t.type === 'support').length,
      transfer: receivedTransactions.filter(t => t.type === 'transfer').length,
      donation: receivedTransactions.filter(t => t.type === 'donation').length,
      other: receivedTransactions.filter(t => !['support', 'transfer', 'donation'].includes(t.type)).length,
    };

    // Count by giveaway status
    const giveawayBreakdown = {
      giveaway: receivedTransactions.filter(t => t.giveaway === 1).length,
      nonGiveaway: receivedTransactions.filter(t => t.giveaway === 0 || t.giveaway === null).length,
    };

    // Sum by category
    const bubbleBreakdown = {
      totalFromGiveaway: receivedTransactions
        .filter(t => t.giveaway === 1)
        .reduce((sum, t) => sum + parseInt(t.bubbleAmount), 0),
      totalFromSupport: receivedTransactions
        .filter(t => t.giveaway === 0 || t.giveaway === null)
        .reduce((sum, t) => sum + parseInt(t.bubbleAmount), 0),
    };

    // Get wallet deposits
    const deposits = await sequelize.query(`
      SELECT 
        id,
        userId,
        type,
        amount,
        createdAt
      FROM WalletTransactions
      WHERE userId = :userId
        AND type = 'bubble_deposit'
      ORDER BY createdAt DESC
      LIMIT 10
    `, {
      replacements: { userId },
      type: sequelize.QueryTypes.SELECT
    });

    console.log(`   Found ${deposits.length} wallet deposits`);

    const totalDeposited = deposits.reduce((sum, d) => sum + parseInt(d.amount), 0);

    // Get spending
    const spentTransactions = await sequelize.query(`
      SELECT COALESCE(SUM(bubbleAmount), 0) as totalSpent
      FROM BubbleTransactions
      WHERE fromUserId = :userId
        AND status = 'completed'
    `, {
      replacements: { userId },
      type: sequelize.QueryTypes.SELECT
    });

    const totalSpent = parseInt(spentTransactions[0]?.totalSpent || 0);

    const diagnostic = {
      userId: userId,
      receivedTransactions: {
        count: receivedTransactions.length,
        typeBreakdown: typeBreakdown,
        giveawayBreakdown: giveawayBreakdown,
        bubbleBreakdown: bubbleBreakdown,
        recent: receivedTransactions.slice(0, 5),
      },
      deposits: {
        count: deposits.length,
        totalDeposited: totalDeposited,
        recent: deposits.slice(0, 3),
      },
      spending: {
        totalSpent: totalSpent,
      },
      calculated: {
        deposited: totalDeposited,
        fromSupport: bubbleBreakdown.totalFromSupport,
        fromGiveaway: bubbleBreakdown.totalFromGiveaway,
        spent: totalSpent,
        netTotal: totalDeposited + bubbleBreakdown.totalFromSupport + bubbleBreakdown.totalFromGiveaway - totalSpent,
      }
    };

    console.log(`   📊 Diagnostic Results:`, JSON.stringify(diagnostic, null, 2));

    res.json(diagnostic);

  } catch (error) {
    console.error('❌ Diagnostic error:', error);
    res.status(400).json({ 
      message: error.message,
      error: error.toString()
    });
  }
});


///////////////////////////////////////////

// Get users who you owe bubbles to (received support from)
// routes/get.js - /back-owed endpoint

// routes/get.js - Modify /back-owed with logging
// Get total bubbles owed (simple version using bubblesReceived)
router.get('/back-owed', async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('\n💸 /back-owed called for user:', userId);
    
    // Get user's bubblesReceived
    const user = await User.findByPk(userId, {
      attributes: ['id', 'name', 'bubblesReceived']
    });
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Calculate total returned
    const returnedResult = await sequelize.query(`
      SELECT COALESCE(SUM(bubbleAmount), 0) as totalReturned
      FROM bubble_transactions
      WHERE fromUserId = :userId
        AND type = 'back'
        AND status = 'completed'
    `, {
      replacements: { userId },
      type: sequelize.QueryTypes.SELECT
    });
    
    const totalReturned = parseInt(returnedResult[0].totalReturned) || 0;
    const totalReceived = parseInt(user.bubblesReceived) || 0;
    const totalOwed = totalReceived - totalReturned;
    
    console.log('💸 Received:', totalReceived, '| Returned:', totalReturned, '| Owed:', totalOwed);
    
    // If owed > 0, create a single entry
    const data = totalOwed > 0 ? [{
      id: 'total',
      name: 'All Supporters',
      email: null,
      received: totalReceived,
      returned: totalReturned,
      owed: totalOwed
    }] : [];
    
    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('❌ Error fetching owed bubbles:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Give bubbles back (simple version - just tracks total)
router.post('/give-back', async (req, res) => {
  const t = await sequelize.transaction();
  
  try {
    const { bubbleAmount } = req.body;
    const fromUserId = req.user.id;

    if (!bubbleAmount || bubbleAmount <= 0) {
      await t.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid bubble amount' 
      });
    }

    const fromUser = await User.findByPk(fromUserId, { transaction: t });
    if (!fromUser) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'User not found' });
    }
    
    if (fromUser.bubblesCount < bubbleAmount) {
      await t.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Insufficient bubbles' 
      });
    }
    
    // Calculate actual owed
    const returnedResult = await sequelize.query(`
      SELECT COALESCE(SUM(bubbleAmount), 0) as totalReturned
      FROM bubble_transactions
      WHERE fromUserId = :fromUserId
        AND type = 'back'
        AND status = 'completed'
    `, {
      replacements: { fromUserId },
      type: sequelize.QueryTypes.SELECT,
      transaction: t
    });
    
    const totalReturned = parseInt(returnedResult[0].totalReturned) || 0;
    const totalReceived = parseInt(fromUser.bubblesReceived) || 0;
    const actualOwed = totalReceived - totalReturned;
    
    if (actualOwed <= 0) {
      await t.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'No bubbles owed' 
      });
    }

    const amountToGiveBack = Math.min(bubbleAmount, actualOwed);

    // Deduct from user's balance
    await fromUser.update({ 
      bubblesCount: fromUser.bubblesCount - amountToGiveBack 
    }, { transaction: t });

    // Create transaction record (toUserId = fromUserId since we're not tracking individual supporters)
    const bubbleTransaction = await BubbleTransaction.create({
      fromUserId,
      toUserId: fromUserId, // Self-reference since we're just tracking total
      bubbleAmount: amountToGiveBack,
      type: 'back',
      status: 'completed',
      description: `Returned ${amountToGiveBack} bubbles`
    }, { transaction: t });

    await t.commit();

    res.json({
      success: true,
      message: 'Bubbles returned successfully',
      data: {
        transaction: bubbleTransaction,
        remainingOwed: actualOwed - amountToGiveBack
      }
    });

  } catch (error) {
    await t.rollback();
    console.error('❌ Error giving back bubbles:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;