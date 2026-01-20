const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const QoESession = require('../models/QoESession');
const QoEEvent = require('../models/QoEEvent');

// ✅ POST - Start new session
router.post('/session/start', async (req, res) => {
  try {
    const { sessionId, userId, videoId, videoTitle, deviceInfo, networkType, cdnEndpoint } = req.body;
    const userAgent = req.get('user-agent') || 'unknown';
    const ip = req.ip || req.connection.remoteAddress || 'unknown';

    // Generate unique ID from IP and User Agent if missing
    let finalUserId = userId;
    if (!finalUserId || finalUserId === 'anonymous' || finalUserId === 'null') {
      finalUserId = crypto.createHash('md5').update(`${ip}-${userAgent}`).digest('hex').substring(0, 12);
      finalUserId = `${deviceInfo?.type || 'web'}_${finalUserId}`;
    }

    const newSession = new QoESession({
      sessionId,
      userId: finalUserId,
      videoId,
      videoTitle,
      deviceType: deviceInfo?.type || 'desktop',
      osInfo: deviceInfo?.os,
      appVersion: deviceInfo?.appVersion,
      networkType: networkType || 'unknown',
      cdnEndpoint: cdnEndpoint || {},
      userAgent: req.get('user-agent'),
      ipAddress: ip,
      status: 'active'
    });

    const savedSession = await newSession.save();

    console.log(`✅ Session started: ${sessionId}`);

    res.status(201).json({
      success: true,
      sessionId: sessionId,
      data: savedSession
    });

  } catch (error) {
    console.error('❌ Error starting session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ POST - Record critical event
router.post('/session/:sessionId/event', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { userId, videoId, eventType, eventData } = req.body;
    const userAgent = req.get('user-agent') || 'unknown';
    const ip = req.ip || req.connection.remoteAddress || 'unknown';

    let finalUserId = userId;
    if (!finalUserId || finalUserId === 'anonymous' || finalUserId === 'null') {
      finalUserId = crypto.createHash('md5').update(`${ip}-${userAgent}`).digest('hex').substring(0, 12);
      finalUserId = `web_${finalUserId}`;
    }

    // Only store critical events
    const criticalEvents = [
      'buffering_start', 'buffering_end', 'quality_change',
      'error', 'playback_error', 'network_error', 'loading_error', 'initialization_error',
      'crash'
    ];

    if (!criticalEvents.includes(eventType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid event type. Only critical events are stored.'
      });
    }

    // Create the event document
    const newEvent = new QoEEvent({
      sessionId,
      userId: finalUserId,
      videoId,
      eventType,
      eventData
    });

    await newEvent.save();

    // ✅ NEW: Persist to current session document for real-time dashboard updates
    const session = await QoESession.findOne({ sessionId });
    if (session) {
      if (eventType === 'error' || eventType === 'playback_error' || eventType === 'network_error' || eventType === 'loading_error' || eventType === 'initialization_error') {
        session.addRecordedError(
          eventData.type || eventType,
          eventData.errorMessage || eventData.message || 'Unknown error',
          eventData.errorCode || eventData.code || '0',
          eventData.videoTime || 0,
          eventData.severity || (eventType === 'loading_error' || eventType === 'initialization_error' ? 'critical' : 'normal')
        );
      } else if (eventType === 'crash') {
        session.addRecordedCrash(
          eventData.type || 'app_crash',
          eventData.message || 'Application crash',
          eventData.severity || 'critical'
        );
      } else if (eventType === 'buffering_end') {
        // Update buffering metrics in session
        session.bufferingEvents.push({
          startTime: (eventData.videoTime || 0) - (eventData.duration || 0),
          endTime: eventData.videoTime || 0,
          duration: eventData.duration || 0,
          quality: eventData.quality || 'unknown',
          timestamp: new Date(),
          videoTime: eventData.videoTime || 0
        });
        session.totalBufferingTime = (session.totalBufferingTime || 0) + (eventData.duration || 0);
        session.totalBufferingCount = (session.totalBufferingCount || 0) + 1;
      } else if (eventType === 'quality_change') {
        // Update quality change metrics in session
        session.qualityChanges.push({
          timestamp: new Date(),
          fromQuality: eventData.fromQuality || 'unknown',
          toQuality: eventData.toQuality || 'unknown',
          atVideoTime: eventData.videoTime || 0
        });
        session.totalQualityChanges = (session.totalQualityChanges || 0) + 1;
        session.finalQuality = eventData.toQuality;
      }

      await session.save();
      console.log(`🔗 Event metrics linked to session ${sessionId}`);
    }

    console.log(`✅ Event recorded: ${eventType} for session ${sessionId}`);

    res.status(201).json({
      success: true,
      data: newEvent
    });

  } catch (error) {
    console.error('❌ Error recording event:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ POST - End session and calculate metrics
router.post('/session/:sessionId/end', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const {
      totalWatchDuration,
      completedPercentage,
      lastPlaybackPosition,
      bufferingEvents,
      qualityChanges,
      playbackErrors,
      finalQuality
    } = req.body;

    // Fetch session
    const session = await QoESession.findOne({ sessionId });

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    // Calculate metrics
    const endTime = new Date();
    const totalSessionDuration = Math.round((endTime - session.startTime) / 1000); // in seconds

    const totalBufferingTime = bufferingEvents.reduce((sum, e) => sum + (e.duration || 0), 0);
    const totalBufferingCount = bufferingEvents.length;
    const bufferingPercentage = totalSessionDuration > 0
      ? parseFloat(((totalBufferingTime / totalSessionDuration) * 100).toFixed(2))
      : 0;

    const totalErrorCount = playbackErrors.length;
    const errorRate = totalSessionDuration > 0
      ? parseFloat(((totalErrorCount / totalSessionDuration) * 100).toFixed(2))
      : 0;

    // Calculate QoE Score
    const qualityDropPenalty = qualityChanges.length > 3 ? 10 : qualityChanges.length * 3;
    const qoeScore = Math.max(0, Math.round(
      100 - (bufferingPercentage * 0.5) - (errorRate * 1) - qualityDropPenalty
    ));

    // Update session
    const updatedSession = await QoESession.findOneAndUpdate(
      { sessionId },
      {
        endTime,
        totalSessionDuration,
        totalWatchDuration,
        completedPercentage,
        lastPlaybackPosition,
        bufferingEvents,
        totalBufferingTime,
        totalBufferingCount,
        bufferingPercentage,
        qualityChanges,
        totalQualityChanges: qualityChanges.length,
        playbackErrors,
        totalErrors: totalErrorCount,
        errorRate,
        finalQuality,
        qoeScore,
        status: completedPercentage >= 90 ? 'completed' : 'abandoned',
        updatedAt: new Date()
      },
      { new: true }
    );

    console.log(`✅ Session ended: ${sessionId}, QoE Score: ${qoeScore}`);

    res.json({
      success: true,
      data: updatedSession
    });

  } catch (error) {
    console.error('❌ Error ending session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ GET - Get session details
router.get('/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await QoESession.findOne({ sessionId });

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    res.json({
      success: true,
      data: session
    });

  } catch (error) {
    console.error('❌ Error fetching session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ GET - Get overall analytics WITH DATE RANGE FILTERING
router.get('/analytics', async (req, res) => {
  try {
    // Extract parameters from query string
    const { startDate, endDate, userId, videoId, error } = req.query;

    console.log('📊 Fetching analytics with filters:', {
      startDate,
      endDate,
      userId,
      videoId,
      error
    });

    // Build date filter
    let dateFilter = {};

    if (startDate && endDate) {
      // Convert string dates to Date objects
      const start = new Date(startDate);
      const end = new Date(endDate);

      // Validate dates
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        console.warn('⚠️ Invalid date format provided');
        return res.status(400).json({
          success: false,
          error: 'Invalid date format. Use YYYY-MM-DD format.',
          example: 'startDate=2025-01-19&endDate=2025-12-31'
        });
      }

      // Normalize dates to avoid timezone issues

      start.setHours(0, 0, 0, 0);        // Set to START of day (00:00:00)

      // Set end date to END of day (23:59:59)
      end.setHours(23, 59, 59, 999);

      dateFilter = {
        startTime: {
          $gte: start,
          $lte: end
        }
      };

      console.log('📅 Date Filter Applied:', {
        from: start.toISOString(),
        to: end.toISOString(),
      });
    } else if (startDate) {
      const start = new Date(startDate);
      if (isNaN(start.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate format. Use YYYY-MM-DD format.'
        });
      }
      start.setHours(0, 0, 0, 0);  // Set to START of day
      dateFilter = {
        startTime: { $gte: start }
      };
    } else if (endDate) {
      const end = new Date(endDate);
      if (isNaN(end.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate format. Use YYYY-MM-DD format.'
        });
      }
      end.setHours(23, 59, 59, 999);
      dateFilter = {
        startTime: { $lte: end }
      };
    }

    // Combine status filter with dynamic filters
    const query = {
      ...dateFilter
    };

    // If no specific error filter, we still only want sessions that are "finalized" OR "active"
    // (excluding any potential legacy statuses if any)
    if (!query.status) {
      query.status = { $in: ['active', 'completed', 'abandoned', 'error'] };
    }

    if (userId) query.userId = userId;
    if (videoId) query.videoId = videoId;
    if (error) {
      // Filter sessions that have at least one playback error with this message
      query['playbackErrors.message'] = error;
    }

    console.log('🔍 Query:', JSON.stringify(query, null, 2));

    // Fetch sessions
    const sessions = await QoESession.find(query);

    console.log(`✅ Found ${sessions.length} sessions matching criteria`);

    if (sessions.length === 0) {
      return res.json({
        success: true,
        data: {
          totalEvents: 0,
          totalBufferingEvents: 0,
          bufferingPercentage: 0,
          totalErrors: 0,
          recordedErrors: 0,
          recordedCrashes: 0,
          errorPercentage: 0,
          userCount: 0,
          videoCount: 0,
          totalQualityChanges: 0,
          avgWatchDuration: 0,
          deviceBreakdown: {},
          networkTypeBreakdown: {},
          topErrorMessages: {},
          topErrorTypes: {},
          dateRange: {
            from: startDate || 'All time',
            to: endDate || 'Today',
            sessionsFound: 0
          }
        }
      });
    }

    // ==================== AGGREGATE METRICS ====================

    // Aggregated metrics
    const totalEvents = sessions.length;
    const activeSessions = sessions.filter(s => s.status === 'active').length;
    const finishedSessions = sessions.filter(s => s.status !== 'active');
    const totalFinishedCount = finishedSessions.length;

    const totalBufferingEvents = sessions.reduce((sum, s) => sum + (s.totalBufferingCount || 0), 0);
    const totalBufferingTime = sessions.reduce((sum, s) => sum + (s.totalBufferingTime || 0), 0);

    // Count errors - FIXED: Use stored session counts
    // Count errors - FIXED: Combine recorded events and playback errors for consistency
    const totalRecordedErrors = sessions.reduce((sum, s) => {
      const explicitErrors = (s.recordedErrorCount || 0);
      const reportedPlaybackErrors = (s.playbackErrors?.length || 0);
      return sum + Math.max(explicitErrors, reportedPlaybackErrors);
    }, 0);

    const totalRecordedCrashes = sessions.reduce((sum, s) => sum + (s.recordedCrashCount || 0), 0);

    // A session is "affected" if it has ANY error marker
    const sessionsWithErrors = sessions.filter(s =>
      (s.totalErrors || 0) > 0 ||
      (s.recordedErrorCount || 0) > 0 ||
      (s.recordedCrashCount || 0) > 0 ||
      (s.playbackErrors?.length || 0) > 0
    ).length;

    const totalErrors = sessions.reduce((sum, s) => sum + (s.totalErrors || 0), 0);
    const totalQualityChanges = sessions.reduce((sum, s) => sum + (s.totalQualityChanges || 0), 0);
    const totalWatchDuration = sessions.reduce((sum, s) => sum + (s.totalWatchDuration || 0), 0);

    // Calculate percentages
    const totalSessionDuration = sessions.reduce((sum, s) => sum + (s.totalSessionDuration || 0), 0);
    const bufferingPercentage = totalSessionDuration > 0
      ? parseFloat(((totalBufferingTime / totalSessionDuration) * 100).toFixed(2))
      : 0;

    // REDEFINED: Error percentage is now % of sessions affected by errors
    const errorPercentage = totalEvents > 0
      ? parseFloat(((sessionsWithErrors / totalEvents) * 100).toFixed(2))
      : 0;

    // Calculate averages based on FINISHED sessions only to avoid skewing
    const avgWatchDuration = totalFinishedCount > 0
      ? parseFloat((totalWatchDuration / totalFinishedCount).toFixed(2))
      : 0;

    // ==================== BREAKDOWNS ====================

    // Detailed User List
    const userMap = {};
    sessions.forEach(s => {
      if (!userMap[s.userId]) {
        userMap[s.userId] = {
          userId: s.userId,
          sessions: 0,
          platforms: new Set(),
          ipAddresses: new Set(),
          avgQoE: 0,
          lastActive: s.startTime,
          totalWatchTime: 0
        };
      }
      const u = userMap[s.userId];
      u.sessions += 1;
      u.platforms.add(s.deviceType || 'unknown');
      if (s.ipAddress) u.ipAddresses.add(s.ipAddress);
      u.totalWatchTime += (s.totalWatchDuration || 0);
      u.avgQoE += (s.qoeScore || 0);
      if (new Date(s.startTime) > new Date(u.lastActive)) {
        u.lastActive = s.startTime;
      }
    });

    const userList = Object.values(userMap).map(u => ({
      userId: u.userId,
      sessionCount: u.sessions,
      platforms: Array.from(u.platforms),
      ipAddresses: Array.from(u.ipAddresses),
      avgQoEScore: Math.round(u.avgQoE / u.sessions),
      lastActive: u.lastActive,
      totalWatchTime: u.totalWatchTime
    })).sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));

    // Detailed Video List
    const videoMap = {};
    sessions.forEach(s => {
      if (!videoMap[s.videoId]) {
        videoMap[s.videoId] = {
          videoId: s.videoId,
          title: s.videoTitle || 'Unknown Video',
          plays: 0,
          totalWatchTime: 0,
          totalErrors: 0,
          avgQoE: 0
        };
      }
      const v = videoMap[s.videoId];
      v.plays += 1;
      v.totalWatchTime += (s.totalWatchDuration || 0);
      v.totalErrors += (s.totalErrors || 0);
      v.avgQoE += (s.qoeScore || 0);
    });

    const videoList = Object.values(videoMap).map(v => ({
      videoId: v.videoId,
      title: v.title,
      playCount: v.plays,
      avgWatchDuration: Math.round(v.totalWatchTime / v.plays),
      errorRate: parseFloat(((v.totalErrors / v.plays)).toFixed(2)),
      avgQoEScore: Math.round(v.avgQoE / v.plays)
    })).sort((a, b) => b.playCount - a.playCount);


    // Aggregations
    const deviceBreakdown = {};
    const networkBreakdown = {};
    const errorTypeBreakdown = {};
    const errorUserMap = {}; // Unique users affected by each error

    const statusBreakdown = {
      completed: 0,
      abandoned: 0
    };

    sessions.forEach(s => {
      // Status breakdown
      if (s.status === 'completed') statusBreakdown.completed++;
      else if (s.status === 'abandoned') statusBreakdown.abandoned++;

      // Device breakdown
      const device = s.deviceType || 'unknown';
      deviceBreakdown[device] = (deviceBreakdown[device] || 0) + 1;

      // Network breakdown
      const network = s.networkType || 'unknown';
      networkBreakdown[network] = (networkBreakdown[network] || 0) + 1;

      // Error message breakdown (Count unique users affected)
      if (s.playbackErrors) {
        s.playbackErrors.forEach(e => {
          const message = e.message || `Error ${e.code}` || 'unknown';
          if (!errorUserMap[message]) {
            errorUserMap[message] = new Set();
          }
          errorUserMap[message].add(s.userId);
        });
      }

      // Error type breakdown (Technical errors/crashes)
      if (s.recordedErrors) {
        s.recordedErrors.forEach(e => {
          const type = e.type || 'unknown';
          errorTypeBreakdown[type] = (errorTypeBreakdown[type] || 0) + 1;
        });
      }
      if (s.recordedCrashes) {
        s.recordedCrashes.forEach(c => {
          const type = c.type || 'crash';
          errorTypeBreakdown[type] = (errorTypeBreakdown[type] || 0) + 1;
        });
      }
    });

    const errorMessageBreakdown = {};
    Object.entries(errorUserMap).forEach(([msg, users]) => {
      errorMessageBreakdown[msg] = users.size; // Store user count instead of raw event count
    });



    // ==================== BUILD RESPONSE ====================

    const analytics = {
      totalEvents,
      totalBufferingEvents,
      bufferingPercentage,
      totalErrors,
      recordedErrors: totalRecordedErrors,      // ← NEW
      recordedCrashes: totalRecordedCrashes,    // ← NEW
      errorPercentage,
      userCount: userList.length,
      videoCount: videoList.length,
      totalQualityChanges,
      avgWatchDuration,
      deviceBreakdown,
      networkTypeBreakdown: networkBreakdown,
      topErrorMessages: errorMessageBreakdown,
      topErrorTypes: errorTypeBreakdown,        // ← NEW
      userList,
      videoList,
      statusBreakdown,
      liveSessions: activeSessions          // ← NEW
    };

    // If no specific filters are applied, or even if they are, 
    // we want to provide the lists for the dropdowns
    // These come from ALL sessions (ignoring specific userId/videoId/error filters but respecting date)
    // Actually, it's better to fetch these from the current resulting sessions 
    // but the user might want to see ALL options available in that date range.

    // For now, let's use the ones found in the CURRENT query to populate "Available Filters"
    analytics.availableFilters = {
      users: userList.map(u => ({ id: u.userId, label: u.userId })),
      videos: videoList.map(v => ({ id: v.videoId, label: v.title }))
    };

    // Always include dateRange in response
    analytics.dateRange = {
      from: startDate || 'All time',
      to: endDate || 'Today',
      sessionsFound: totalEvents
    };

    console.log(`✅ Analytics generated:`, analytics);
    console.log(`📅 Date range in response:`, analytics.dateRange);

    res.json({
      success: true,
      data: analytics
    });

  } catch (error) {
    console.error('❌ Error generating analytics:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ GET - Get video analytics WITH DATE FILTERING
router.get('/video/:videoId/analytics', async (req, res) => {
  try {
    const { videoId } = req.params;
    const { startDate, endDate } = req.query;

    // Build date filter
    let dateFilter = {};

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);

      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid date format. Use YYYY-MM-DD format.'
        });
      }

      end.setHours(23, 59, 59, 999);

      dateFilter = {
        startTime: {
          $gte: start,
          $lte: end
        }
      };
    }

    // Fetch sessions with filter
    const sessions = await QoESession.find({
      videoId,
      status: { $in: ['completed', 'abandoned'] },
      ...dateFilter
    });

    if (sessions.length === 0) {
      return res.json({
        success: true,
        data: {
          message: 'No sessions found for this video in the selected date range'
        }
      });
    }

    // Aggregate metrics
    const totalSessions = sessions.length;
    const avgWatchDuration = (sessions.reduce((sum, s) => sum + (s.totalWatchDuration || 0), 0) / totalSessions).toFixed(2);
    const avgCompletedPercentage = (sessions.reduce((sum, s) => sum + (s.completedPercentage || 0), 0) / totalSessions).toFixed(2);
    const avgBufferingPercentage = (sessions.reduce((sum, s) => sum + (s.bufferingPercentage || 0), 0) / totalSessions).toFixed(2);
    const avgErrorRate = (sessions.reduce((sum, s) => sum + (s.errorRate || 0), 0) / totalSessions).toFixed(2);
    const avgQoEScore = (sessions.reduce((sum, s) => sum + (s.qoeScore || 0), 0) / totalSessions).toFixed(2);

    // Device breakdown
    const deviceBreakdown = {};
    sessions.forEach(s => {
      deviceBreakdown[s.deviceType] = (deviceBreakdown[s.deviceType] || 0) + 1;
    });

    // Network breakdown
    const networkBreakdown = {};
    sessions.forEach(s => {
      networkBreakdown[s.networkType] = (networkBreakdown[s.networkType] || 0) + 1;
    });

    // Error breakdown by message
    const errorBreakdown = {};
    sessions.forEach(s => {
      s.playbackErrors.forEach(e => {
        const key = e.message || `Error ${e.code}` || 'unknown';
        errorBreakdown[key] = (errorBreakdown[key] || 0) + 1;
      });
    });

    const analytics = {
      videoId,
      totalSessions,
      completionRate: ((sessions.filter(s => s.status === 'completed').length / totalSessions) * 100).toFixed(2),
      avgWatchDuration,
      avgCompletedPercentage,
      avgBufferingPercentage,
      avgErrorRate,
      avgQoEScore,
      deviceBreakdown,
      networkBreakdown,
      errorBreakdown,
      dateRange: {
        from: startDate || 'All time',
        to: endDate || 'Today',
        sessionsFound: totalSessions
      }
    };

    console.log(`✅ Video analytics for ${videoId}:`, analytics);

    res.json({
      success: true,
      data: analytics
    });

  } catch (error) {
    console.error('❌ Error generating video analytics:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;