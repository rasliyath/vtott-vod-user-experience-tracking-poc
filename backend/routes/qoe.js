const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const QoESession = require('../models/QoESession');
const QoEEvent = require('../models/QoEEvent');

// ✅ POST - Start new session
router.post('/session/start', async (req, res) => {
  try {
    const { sessionId, userId, videoId, videoTitle, deviceInfo, networkType, cdnEndpoint, applicationId } = req.body;
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
      applicationId: applicationId || null,
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
      status: 'active',
      playerType: req.body.playerType || 'youtube'
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
    const { userId, videoId, eventType, eventData, applicationId } = req.body;
    const userAgent = req.get('user-agent') || 'unknown';
    const ip = req.ip || req.connection.remoteAddress || 'unknown';

    let finalUserId = userId;
    if (!finalUserId || finalUserId === 'anonymous' || finalUserId === 'null') {
      finalUserId = crypto.createHash('md5').update(`${ip}-${userAgent}`).digest('hex').substring(0, 12);
      finalUserId = `web_${finalUserId}`;
    }

    // Only store critical events
    const criticalEvents = [
      'buffering_start',
      'buffering_end',
      'quality_change',
      'error',
      'crash',
      'playback_error',
      'network_error',
      'network_recovery',
      'loading_error',
      'initialization_error'
    ];

    if (!criticalEvents.includes(eventType)) {
      return res.status(400).json({
        success: false,
        error: `Invalid event type: ${eventType}. Only critical events are stored.`
      });
    }

    // Create the event document
    const newEvent = new QoEEvent({
      sessionId,
      applicationId: applicationId || null,
      userId: finalUserId,
      videoId,
      eventType,
      eventData
    });

    await newEvent.save();

    // ✅ FIXED: Persist to current session document for real-time dashboard updates
    const session = await QoESession.findOne({ sessionId });
    if (session) {
      // Define error and crash event types
      const isError = ['error', 'playback_error', 'network_error', 'loading_error', 'initialization_error'].includes(eventType);
      const isCrash = eventType === 'crash';

      // ==================== HANDLE ALL ERROR TYPES ====================
      if (isError || isCrash) {
        console.log(`🔴 Processing ${isCrash ? 'CRASH' : 'ERROR'} event: ${eventType}`);

        // 1. Add to recordedErrors (rich metadata) - ALL errors go here
        session.addRecordedError(
          eventData.type || eventType,
          eventData.errorMessage || eventData.message || 'Unknown error',
          eventData.errorCode || eventData.code || '0',
          eventData.videoTime || eventData.atVideoTime || 0,
          eventData.severity || (isCrash ? 'critical' : 'normal')
        );

        // 2. Add to playbackErrors (legacy array used by some dashboard components)
        session.playbackErrors.push({
          code: String(eventData.errorCode || eventData.code || '0'),
          message: eventData.errorMessage || eventData.message || 'Unknown error',
          timestamp: new Date(),
          atVideoTime: eventData.videoTime || eventData.atVideoTime || 0
        });

        // 3. If it's a crash, ALSO add to recordedCrashes
        if (isCrash) {
          session.addRecordedCrash(
            eventData.type || 'app_crash',
            eventData.message || 'Application crash',
            eventData.severity || 'critical'
          );
          console.log(`🚨 Crash also recorded in recordedCrashes`);
        }

        // 4. Update total error metrics
        session.totalErrors = (session.totalErrors || 0) + 1;

        console.log(`✅ Error metrics updated: totalErrors=${session.totalErrors}, recordedErrorCount=${session.recordedErrorCount}, recordedCrashCount=${session.recordedCrashCount}`);
      }
      // ==================== HANDLE BUFFERING ====================
      else if (eventType === 'buffering_end') {
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
        console.log(`⏳ Buffering event recorded: duration=${eventData.duration}s, total=${session.totalBufferingCount}`);
      }
      // ==================== HANDLE QUALITY CHANGES ====================
      else if (eventType === 'quality_change') {
        session.qualityChanges.push({
          timestamp: new Date(),
          fromQuality: eventData.fromQuality || 'unknown',
          toQuality: eventData.toQuality || 'unknown',
          atVideoTime: eventData.videoTime || 0
        });
        session.totalQualityChanges = (session.totalQualityChanges || 0) + 1;
        session.finalQuality = eventData.toQuality;
        console.log(`📺 Quality change recorded: ${eventData.fromQuality} → ${eventData.toQuality}`);
      }

      await session.save();
      console.log(`🔗 Event metrics linked to session ${sessionId}`);
    } else {
      console.warn(`⚠️ Session ${sessionId} not found - event recorded but not linked`);
    }

    console.log(`✅ Event recorded: ${eventType} for session ${sessionId}`);

    res.status(201).json({
      success: true,
      data: newEvent
    });

  } catch (error) {
    console.error('❌ Error recording event:', error);
    if (error.name === 'ValidationError') {
      console.error('⚠️ Validation details:', JSON.stringify(error.errors, null, 2));
    }
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
      finalQuality,
      startupTime, // NEW
      avgBitrate,  // NEW
      maxBitrate   // NEW
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

    session.endTime = endTime;
    session.totalSessionDuration = totalSessionDuration;

    session.totalWatchDuration = totalWatchDuration;
    session.completedPercentage = completedPercentage;
    session.lastPlaybackPosition = lastPlaybackPosition;

    // Save Deep Metrics
    if (startupTime) session.startupTime = startupTime;
    if (avgBitrate) session.avgBitrate = avgBitrate;
    if (maxBitrate) session.maxBitrate = maxBitrate;

    // Update Buffering Stats
    session.bufferingEvents = bufferingEvents; // Overwrite with client-side calculated events

    // Define as local variables for use in findOneAndUpdate
    const totalBufferingTime = bufferingEvents.reduce((sum, e) => sum + (e.duration || 0), 0);
    const totalBufferingCount = bufferingEvents.length;

    session.totalBufferingTime = totalBufferingTime;
    session.totalBufferingCount = totalBufferingCount;

    const bufferingPercentage = totalSessionDuration > 0
      ? parseFloat(((totalBufferingTime / totalSessionDuration) * 100).toFixed(2))
      : 0;
    session.bufferingPercentage = bufferingPercentage;

    // Update Quality Change Stats
    session.qualityChanges = qualityChanges; // Overwrite with client-side calculated changes
    session.totalQualityChanges = qualityChanges.length;
    session.finalQuality = finalQuality;

    // Update Error Stats
    session.playbackErrors = playbackErrors; // Overwrite with client-side calculated errors
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
    console.log(`📊 Final error counts: totalErrors=${updatedSession.totalErrors}, recordedErrors=${updatedSession.recordedErrorCount}, crashes=${updatedSession.recordedCrashCount}`);

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
    const { startDate, endDate, userId, videoId, error, applicationId } = req.query;

    console.log('📊 Fetching analytics with filters:', {
      startDate,
      endDate,
      userId,
      videoId,
      error,
      applicationId
    });

    // Build date filter
    let dateFilter = {};

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);

      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        console.warn('⚠️ Invalid date format provided');
        return res.status(400).json({
          success: false,
          error: 'Invalid date format. Use YYYY-MM-DD format.',
          example: 'startDate=2025-01-19&endDate=2025-12-31'
        });
      }

      start.setHours(0, 0, 0, 0);
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
      start.setHours(0, 0, 0, 0);
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

    const query = {
      ...dateFilter
    };

    // ✅ FIX: Don't filter by status - include ALL sessions
    // Remove this line: query.status = { $in: ['active', 'completed', 'abandoned', 'error'] };

    if (userId) query.userId = userId;
    if (videoId) query.videoId = videoId;
    if (applicationId) query.applicationId = applicationId;
    if (error) {
      query['playbackErrors.message'] = error;
    }

    console.log('🔍 Query:', JSON.stringify(query, null, 2));

    const sessions = await QoESession.find(query);

    console.log(`✅ Found ${sessions.length} sessions matching criteria`);

    // Log player types found
    const playerTypesFound = [...new Set(sessions.map(s => s.playerType || 'youtube'))];
    console.log(`🎮 Player types in results:`, playerTypesFound);

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
          playerTypeBreakdown: {},
          dateRange: {
            from: startDate || 'All time',
            to: endDate || 'Today',
            sessionsFound: 0
          },
          availableFilters: {
            users: [],
            videos: []
          }
        }
      });
    }

    // Aggregated metrics
    const totalEvents = sessions.length;
    const activeSessions = sessions.filter(s => s.status === 'active').length;
    const finishedSessions = sessions.filter(s => s.status !== 'active');
    const totalFinishedCount = finishedSessions.length;

    const totalBufferingEvents = sessions.reduce((sum, s) => sum + (s.totalBufferingCount || 0), 0);
    const totalBufferingTime = sessions.reduce((sum, s) => sum + (s.totalBufferingTime || 0), 0);

    const totalRecordedErrors = sessions.reduce((sum, s) => {
      const explicitErrors = (s.recordedErrorCount || 0);
      const reportedPlaybackErrors = (s.playbackErrors?.length || 0);
      return sum + Math.max(explicitErrors, reportedPlaybackErrors);
    }, 0);

    const totalRecordedCrashes = sessions.reduce((sum, s) => sum + (s.recordedCrashCount || 0), 0);

    const sessionsWithErrors = sessions.filter(s =>
      (s.totalErrors || 0) > 0 ||
      (s.recordedErrorCount || 0) > 0 ||
      (s.recordedCrashCount || 0) > 0 ||
      (s.playbackErrors?.length || 0) > 0
    ).length;

    const totalErrors = sessions.reduce((sum, s) => sum + (s.totalErrors || 0), 0);
    const totalQualityChanges = sessions.reduce((sum, s) => sum + (s.totalQualityChanges || 0), 0);
    const totalWatchDuration = sessions.reduce((sum, s) => sum + (s.totalWatchDuration || 0), 0);

    const totalSessionDuration = sessions.reduce((sum, s) => sum + (s.totalSessionDuration || 0), 0);
    const bufferingPercentage = totalSessionDuration > 0
      ? parseFloat(((totalBufferingTime / totalSessionDuration) * 100).toFixed(2))
      : 0;

    const errorPercentage = totalEvents > 0
      ? parseFloat(((sessionsWithErrors / totalEvents) * 100).toFixed(2))
      : 0;

    const avgWatchDuration = totalFinishedCount > 0
      ? parseFloat((totalWatchDuration / totalFinishedCount).toFixed(2))
      : 0;

    // User List
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

    // Video List
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

    // Breakdowns
    const deviceBreakdown = {};
    const networkBreakdown = {};
    const errorTypeBreakdown = {};
    const errorMessageBreakdown = {};

    // ✅ FIX: Properly build playerTypeBreakdown
    const playerTypeBreakdown = {};

    const errorTypeSessions = {};
    const errorMessageSessions = {};

    const statusBreakdown = {
      completed: 0,
      abandoned: 0
    };

    sessions.forEach(s => {
      if (s.status === 'completed') statusBreakdown.completed++;
      else if (s.status === 'abandoned') statusBreakdown.abandoned++;

      const device = s.deviceType || 'unknown';
      deviceBreakdown[device] = (deviceBreakdown[device] || 0) + 1;

      const network = s.networkType || 'unknown';
      networkBreakdown[network] = (networkBreakdown[network] || 0) + 1;

      // ✅ FIX: Count player types with proper fallback
      const playerType = s.playerType || 'youtube';
      playerTypeBreakdown[playerType] = (playerTypeBreakdown[playerType] || 0) + 1;

      console.log(`📊 Session ${s.sessionId}: playerType = ${playerType}`);

      if (s.playbackErrors) {
        s.playbackErrors.forEach(e => {
          const message = e.message || `Error ${e.code}` || 'unknown';
          if (!errorMessageSessions[message]) {
            errorMessageSessions[message] = new Set();
          }
          errorMessageSessions[message].add(s.sessionId);
        });
      }

      if (s.recordedErrors) {
        s.recordedErrors.forEach(e => {
          const type = e.type || 'unknown';
          if (!errorTypeSessions[type]) {
            errorTypeSessions[type] = new Set();
          }
          errorTypeSessions[type].add(s.sessionId);
        });
      }
      if (s.recordedCrashes) {
        s.recordedCrashes.forEach(c => {
          const type = c.type || 'crash';
          if (!errorTypeSessions[type]) {
            errorTypeSessions[type] = new Set();
          }
          errorTypeSessions[type].add(s.sessionId);
        });
      }
    });

    // Convert sets to counts
    Object.entries(errorTypeSessions).forEach(([type, sessions]) => {
      errorTypeBreakdown[type] = sessions.size;
    });

    Object.entries(errorMessageSessions).forEach(([msg, sessions]) => {
      errorMessageBreakdown[msg] = sessions.size;
    });

    console.log('🎮 Final playerTypeBreakdown:', playerTypeBreakdown);

    const analytics = {
      totalEvents,
      totalBufferingEvents,
      bufferingPercentage,
      totalErrors,
      recordedErrors: totalRecordedErrors,
      recordedCrashes: totalRecordedCrashes,
      errorPercentage,
      userCount: userList.length,
      videoCount: videoList.length,
      totalQualityChanges,
      avgWatchDuration,
      deviceBreakdown,
      networkTypeBreakdown: networkBreakdown,
      topErrorMessages: errorMessageBreakdown,
      topErrorTypes: errorTypeBreakdown,
      playerTypeBreakdown, // ✅ Now properly populated
      userList,
      videoList,
      statusBreakdown,
      liveSessions: activeSessions,
      availableFilters: {
        users: userList.map(u => ({ id: u.userId, label: u.userId })),
        videos: videoList.map(v => ({ id: v.videoId, label: v.title }))
      },
      dateRange: {
        from: startDate || 'All time',
        to: endDate || 'Today',
        sessionsFound: totalEvents
      }
    };

    console.log(`✅ Analytics generated with ${totalRecordedErrors} errors and ${totalRecordedCrashes} crashes`);
    console.log(`🎮 Player types returned:`, Object.keys(playerTypeBreakdown));

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
    const { startDate, endDate, applicationId } = req.query;

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

    const query = {
      videoId,
      status: { $in: ['completed', 'abandoned'] },
      ...dateFilter
    };

    if (applicationId) {
      query.applicationId = applicationId;
    }

    const sessions = await QoESession.find(query);

    if (sessions.length === 0) {
      return res.json({
        success: true,
        data: {
          message: 'No sessions found for this video in the selected date range'
        }
      });
    }

    const totalSessions = sessions.length;
    const avgWatchDuration = (sessions.reduce((sum, s) => sum + (s.totalWatchDuration || 0), 0) / totalSessions).toFixed(2);
    const avgCompletedPercentage = (sessions.reduce((sum, s) => sum + (s.completedPercentage || 0), 0) / totalSessions).toFixed(2);
    const avgBufferingPercentage = (sessions.reduce((sum, s) => sum + (s.bufferingPercentage || 0), 0) / totalSessions).toFixed(2);
    const avgErrorRate = (sessions.reduce((sum, s) => sum + (s.errorRate || 0), 0) / totalSessions).toFixed(2);
    const avgQoEScore = (sessions.reduce((sum, s) => sum + (s.qoeScore || 0), 0) / totalSessions).toFixed(2);

    const deviceBreakdown = {};
    sessions.forEach(s => {
      deviceBreakdown[s.deviceType] = (deviceBreakdown[s.deviceType] || 0) + 1;
    });

    const networkBreakdown = {};
    sessions.forEach(s => {
      networkBreakdown[s.networkType] = (networkBreakdown[s.networkType] || 0) + 1;
    });

    const errorBreakdown = {};
    sessions.forEach(s => {
      s.playbackErrors.forEach(e => {
        const key = e.message || `Error ${e.code}` || 'unknown';
        errorBreakdown[key] = (errorBreakdown[key] || 0) + 1;
      });
    });

    const playerTypeBreakdown = {};
    sessions.forEach(s => {
      const type = s.playerType || 'youtube';
      playerTypeBreakdown[type] = (playerTypeBreakdown[type] || 0) + 1;
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
      playerTypeBreakdown, // NEW
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