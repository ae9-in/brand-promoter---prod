'use strict';

/**
 * bulkUploadHistoryRoutes.js — Admin History, Status, Preview, and Undo Endpoints.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { auth, requireRoles } = require('../middleware/auth');
const { getJobHistory, getJobById } = require('../lib/importJobRepository');
const { undoImport } = require('../lib/bulkUploadUndo');
const { getPreviewSession } = require('../lib/bulkUploadPreview');
const { validateFile } = require('../utils/fileValidator');

// Processors for confirmed execution
const candidateProc = require('../jobs/bulkCandidateUpload.processor');
const joinedProc = require('../jobs/bulkJoinedCandidateUpload.processor');
const offerProc = require('../jobs/bulkOfferLetterUpload.processor');
const interviewProc = require('../jobs/bulkInterviewUpload.processor');
const feedbackProc = require('../jobs/bulkFeedbackUpload.processor');

// SEC-007: Add fileFilter so the preview endpoint validates type (CSV/XLSX only),
// matching the protection applied in all other bulk upload routes.
const upload = multer({
  dest: path.join(__dirname, '..', '..', 'uploads', 'temp_preview'),
  limits: { fileSize: 15 * 1024 * 1024 }, // Match MAX_UPLOAD_BYTES
  fileFilter: (req, file, cb) => {
    try {
      validateFile(file, 'bulkData');
      cb(null, true);
    } catch (err) {
      cb(err);
    }
  },
});

/**
 * GET /api/bulk-upload/history
 * Admin-only: List recent bulk upload jobs across all flows.
 */
router.get('/history', auth, requireRoles(['SUPER_ADMIN', 'ADMIN']), async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const orgId = req.user.role === 'SUPER_ADMIN' ? (req.query.organizationId || null) : req.user.organizationId;
    const history = await getJobHistory(orgId, limit);
    res.json({ success: true, history });
  } catch (err) {
    // SEC-012: Do not expose internal error details to clients
    console.error('[BulkHistory] GET /history error:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve upload history' });
  }
});

/**
 * GET /api/bulk-upload/job/:jobId
 * Get detailed status, checkpoint, and metrics for a specific import job.
 */
router.get('/job/:jobId', auth, async (req, res) => {
  try {
    const job = await getJobById(req.params.jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: 'Import job not found' });
    }
    res.json({ success: true, job });
  } catch (err) {
    // SEC-012: Do not expose internal error details to clients
    console.error('[BulkHistory] GET /job/:jobId error:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve import job' });
  }
});

/**
 * DELETE /api/bulk-upload/undo/:jobId
 * Admin-only: Undo an import job by deleting its created records.
 */
router.delete('/undo/:jobId', auth, requireRoles(['SUPER_ADMIN', 'ADMIN']), async (req, res) => {
  try {
    const force = req.query.force === 'true' || req.body?.force === true;
    const result = await undoImport(req.params.jobId, {
      actorUserId: req.user.id,
      organizationId: req.user.organizationId,
      force,
    });
    const statusCode = result.status || (result.success ? 200 : 400);
    res.status(statusCode).json(result);
  } catch (err) {
    // SEC-012: Do not expose internal error details to clients
    console.error('[BulkHistory] DELETE /undo/:jobId error:', err);
    res.status(500).json({ success: false, message: 'Failed to undo import job' });
  }
});

/**
 * POST /api/bulk-upload/preview
 * Pre-flight dry run endpoint for validating imports before committing.
 */
router.post('/preview', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded for preview' });
    }

    const flowType = req.body.flowType || 'candidates';
    const filePath = req.file.path;
    const fileType = path.extname(req.file.originalname).toLowerCase();
    const jobId = `prev_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    let proc = candidateProc.processCandidateUpload;
    if (flowType === 'joined') proc = joinedProc.processJoinedCandidateUpload;
    else if (flowType === 'offer' || flowType === 'offer-letter') proc = offerProc.processOfferLetterUpload;
    else if (flowType === 'interviews' || flowType === 'interview-schedule') proc = interviewProc.processBulkInterviewUpload;
    else if (flowType === 'feedback' || flowType === 'interview-feedback') proc = feedbackProc.processBulkFeedbackUpload;

    const previewResult = await proc({
      jobId,
      filePath,
      fileType,
      uploadedBy: req.user.id,
      userRole: req.user.role,
      organizationId: req.user.organizationId,
      sourceFilename: req.file.originalname,
      preview: true,
      driveId: req.body.driveId || null,
      isDriveContext: !!req.body.driveId,
    });

    res.json(previewResult);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/bulk-upload/preview/confirm
 * Confirms and executes an import from a previously validated preview session.
 */
router.post('/preview/confirm', auth, async (req, res) => {
  try {
    const { previewToken } = req.body;
    if (!previewToken) {
      return res.status(400).json({ success: false, message: 'previewToken is required' });
    }

    const session = getPreviewSession(previewToken);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Preview session expired or not found. Please upload again.' });
    }

    const { options } = session;
    const realJobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    let proc = candidateProc.processCandidateUpload;
    if (options.flowType === 'joined') proc = joinedProc.processJoinedCandidateUpload;
    else if (options.flowType === 'offer' || options.flowType === 'offer-letter') proc = offerProc.processOfferLetterUpload;
    else if (options.flowType === 'interviews' || options.flowType === 'interview-schedule') proc = interviewProc.processBulkInterviewUpload;
    else if (options.flowType === 'feedback' || options.flowType === 'interview-feedback') proc = feedbackProc.processBulkFeedbackUpload;

    // Launch background processor
    proc({
      ...options,
      jobId: realJobId,
      preview: false,
    }).catch(err => console.error(`[BulkConfirm] Error on confirmed job ${realJobId}:`, err));

    res.status(202).json({
      success: true,
      jobId: realJobId,
      message: 'Import confirmed and processing in background.',
      statusUrl: `/api/bulk-upload/job/${realJobId}`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
