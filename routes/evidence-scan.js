'use strict';

// =============================================================================
// 3CIR EVIDENCE PORTFOLIO AI PRE-SCANNER — API ENDPOINT
// routes/evidence-scan.js
//
// Express router that handles the /api/evidence-scan endpoint.
// Mount in server.js with: app.use(require('./routes/evidence-scan'));
//
// FIXES APPLIED:
// #2  — Added JSON session-based handler (widget sends sessionId, not file)
// #6  — Added rate limiting (5 scans per minute per IP)
// #7  — Safe GHL tagging via upsertContact instead of getContact+updateContact
// #9  — Clears file buffer from session after scanning to free memory
// #11 — Logs scan events to analytics webhook
// =============================================================================

const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const router = express.Router();
const { analyseEvidence, extractWordText, EVIDENCE_DOMAINS } = require('../services/evidence-scanner');

// FIX #6: Dedicated rate limiter for scans — 5 per minute per IP
// Each scan costs ~$0.02-0.05 in Claude API calls
const scanLimiter = rateLimit({
  windowMs: 60000,
  max: 5,
  message: { success: false, error: 'Too many scan requests. Please wait a moment before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// =============================================================================
// POST /api/evidence-scan
//
// FIX #2: Handles BOTH flows:
// A) JSON body with sessionId + qualCode (primary — file already in session)
// B) Multipart file upload (fallback — direct upload)
//
// Returns: JSON with prospect-facing summary
// Side effect: Sends full analysis to GHL as contact note
// =============================================================================

router.post('/api/evidence-scan', scanLimiter, async (req, res) => {
  const startTime = Date.now();

  try {
    let fileBuffer, mimeType, fileName, sessionId, qualCode, audience, session;

    // Detect request type
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('application/json')) {
      // === PRIMARY FLOW: Session-based (file already uploaded via /api/upload) ===
      sessionId = req.body.sessionId;
      qualCode = req.body.qualCode;
      audience = req.body.audience;

      if (!sessionId || !global._3cir_sessionCache) {
        return res.status(400).json({ success: false, error: 'Invalid session.' });
      }

      session = global._3cir_sessionCache.get(sessionId);
      if (!session) {
        return res.status(404).json({ success: false, error: 'Session expired. Please start a new conversation.' });
      }

      if (!session.uploadedFileBuffer) {
        return res.status(400).json({
          success: false,
          error: 'No file found in your session. Please upload a resume or service record first using the paperclip button.'
        });
      }

      fileBuffer = session.uploadedFileBuffer;
      mimeType = session.uploadedFileMime;
      fileName = session.uploadedFileName;
      audience = audience || session.audience;

      // Auto-detect qualCode from session if not provided
      if (!qualCode && session.qualsDiscussed && session.qualsDiscussed.length > 0) {
        qualCode = session.qualsDiscussed[session.qualsDiscussed.length - 1].code;
      }

    } else {
      // === FALLBACK: Direct request without session ===
      return res.status(400).json({
        success: false,
        error: 'Please upload your file first using the upload button in the chat, then request the evidence scan.'
      });
    }

    // Validate qualification code
    if (!qualCode) {
      return res.status(400).json({ success: false, error: 'No qualification specified for analysis. Please discuss a qualification first.' });
    }

    if (!EVIDENCE_DOMAINS[qualCode]) {
      return res.status(200).json({
        success: false,
        error: `Evidence scanning is not yet configured for ${qualCode}. Our assessor will review your document personally during your free RPL assessment.`,
        qualCode
      });
    }

    console.log(`[Evidence Scan] Starting: ${fileName} (${(fileBuffer.length / 1024).toFixed(1)}KB) against ${qualCode} for ${audience || 'public'}`);

    // For Word documents, extract text first
    if (mimeType === 'application/msword' ||
        mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const extractedText = await extractWordText(fileBuffer);
      fileBuffer = Buffer.from(extractedText, 'utf-8');
      mimeType = 'text/plain';
    }

    // Run the analysis
    const result = await analyseEvidence(
      fileBuffer,
      mimeType,
      fileName,
      qualCode,
      audience || 'public'
    );

    if (!result.success) {
      console.log(`[Evidence Scan] Analysis failed: ${result.error}`);
      return res.status(200).json(result);
    }

    // FIX #7: Send full analysis to GHL using safe approach
    if (session && session.contactId && global._3cir_ghl) {
      try {
        // Add the full analysis as a contact note
        await global._3cir_ghl.addNote(session.contactId, result.ghlNote);
        console.log(`[Evidence Scan] Full analysis sent to GHL contact ${session.contactId}`);

        // Tag via upsertContact (safe — doesn't require getContact/updateContact methods)
        await global._3cir_ghl.upsertContact({
          email: session.email || '',
          phone: session.phone || '',
          tags: ['evidence-pre-scanned'],
        }).catch(() => {});

      } catch (ghlErr) {
        console.error('[Evidence Scan] GHL note failed (non-blocking):', ghlErr.message);
      }
    }

    // FIX #9: Clear the file buffer from session to free memory
    if (session) {
      session.uploadedFileBuffer = null;
      session.evidenceScanned = true;
      session.evidenceScanScore = result.prospectSummary.score;
      session.evidenceScanQual = qualCode;
      global._3cir_sessionCache.set(sessionId, session);
    }

    // FIX #11: Log scan event to analytics
    const analyticsUrl = process.env.ANALYTICS_WEBHOOK_URL;
    if (analyticsUrl) {
      axios.post(analyticsUrl, {
        sessionId: sessionId,
        audience: audience || 'unknown',
        eventType: 'evidence_scan',
        qualCode: qualCode,
        qualName: result.qualName,
        score: result.prospectSummary.score,
        strongCount: result.fullAnalysis.strongCount || 0,
        moderateCount: result.fullAnalysis.moderateCount || 0,
        weakCount: result.fullAnalysis.weakCount || 0,
        noneCount: result.fullAnalysis.noneCount || 0,
        fileName: fileName,
        analysisTimeMs: result.analysisTimeMs,
        contactId: session?.contactId || null,
        leadCaptured: !!session?.contactId,
        timestamp: new Date().toISOString(),
      }, { timeout: 10000 }).catch(() => {});
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Evidence Scan] Complete in ${elapsed}ms. Score: ${result.prospectSummary.score}%`);

    // Return prospect-facing summary only
    return res.status(200).json({
      success: true,
      scan: result.prospectSummary,
      analysisTimeMs: elapsed
    });

  } catch (err) {
    console.error('[Evidence Scan] Unexpected error:', err);
    return res.status(500).json({
      success: false,
      error: 'The evidence analysis could not be completed right now. Our assessor will review your document personally during your free RPL assessment.'
    });
  }
});

// =============================================================================
// GET /api/evidence-scan/qualifications
//
// Returns the list of qualifications that have evidence scanning configured.
// Used by the widget to know which quals support scanning.
// =============================================================================

router.get('/api/evidence-scan/qualifications', (req, res) => {
  const quals = Object.entries(EVIDENCE_DOMAINS).map(([code, data]) => ({
    code,
    name: data.name,
    domainCount: data.domains.length
  }));

  res.json({
    success: true,
    count: quals.length,
    qualifications: quals
  });
});

module.exports = router;
