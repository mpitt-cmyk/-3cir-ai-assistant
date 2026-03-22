// =============================================================================
// 3CIR EVIDENCE PORTFOLIO AI PRE-SCANNER — API ENDPOINT
// routes/evidence-scan.js
//
// Express router that handles the /api/evidence-scan endpoint.
// Mount in server.js with: app.use(require('./routes/evidence-scan'));
//
// Flow:
// 1. Widget calls POST /api/evidence-scan with file + sessionId + qualCode
// 2. Server analyses document against qualification competency domains
// 3. Returns prospect-friendly summary (MEDIUM detail)
// 4. Sends full analysis to GHL as contact note
//
// Dependencies: multer (already in package.json), ../services/evidence-scanner
// =============================================================================

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { analyseEvidence, extractWordText, EVIDENCE_DOMAINS } = require('../services/evidence-scanner');

// Multer config — same as existing /api/upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/png',
      'image/gif',
      'text/plain'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File type not supported. Please upload a PDF, Word document, or image.'));
    }
  }
});

// =============================================================================
// POST /api/evidence-scan
//
// Accepts: multipart/form-data with:
//   - file: The document to analyse (PDF, Word, image)
//   - sessionId: Current chat session ID
//   - qualCode: Qualification code to analyse against (e.g. BSB40520)
//   - audience: 'services' or 'public'
//
// Returns: JSON with prospect-facing summary
// Side effect: Sends full analysis to GHL as contact note
// =============================================================================

router.post('/api/evidence-scan', upload.single('file'), async (req, res) => {
  const startTime = Date.now();

  try {
    const { sessionId, qualCode, audience } = req.body;
    const file = req.file;

    // Validate required fields
    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded. Please upload a resume, service record, or position description.'
      });
    }

    if (!qualCode) {
      return res.status(400).json({
        success: false,
        error: 'No qualification specified for analysis.'
      });
    }

    // Check if we have domain mapping for this qualification
    if (!EVIDENCE_DOMAINS[qualCode]) {
      return res.status(200).json({
        success: false,
        error: `Evidence scanning is not yet configured for ${qualCode}. Matt will review your document personally during your free RPL assessment.`,
        qualCode
      });
    }

    console.log(`[Evidence Scan] Starting analysis: ${file.originalname} (${(file.size / 1024).toFixed(1)}KB) against ${qualCode} for ${audience || 'public'} audience`);

    // For Word documents, extract text first
    let fileBuffer = file.buffer;
    let mimeType = file.mimetype;

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
      file.originalname,
      qualCode,
      audience || 'public'
    );

    if (!result.success) {
      console.log(`[Evidence Scan] Analysis failed: ${result.error}`);
      return res.status(200).json(result);
    }

    // Send full analysis to GHL if we have a session with a contact
    // (This integrates with the existing session cache)
    if (sessionId) {
      try {
        await sendToGHL(sessionId, result);
      } catch (ghlErr) {
        console.error('[Evidence Scan] GHL note failed (non-blocking):', ghlErr.message);
        // Don't fail the response if GHL fails
      }
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

    // Handle multer errors
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File is too large. Maximum size is 5MB.'
      });
    }

    return res.status(500).json({
      success: false,
      error: 'The evidence analysis could not be completed right now. Matt will review your document personally during your free RPL assessment.'
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

// =============================================================================
// SEND FULL ANALYSIS TO GHL AS CONTACT NOTE
//
// This function needs access to the session cache and GHL service.
// It will be wired up during integration with the existing server.
// =============================================================================

async function sendToGHL(sessionId, result) {
  // This function needs to be wired to the existing session cache and GHL service.
  // During integration, replace this with actual calls:
  //
  // const session = sessionCache.get(sessionId);
  // if (session && session.contactId) {
  //   await ghl.addNote(session.contactId, result.ghlNote);
  //   // Also add a tag for pre-scanned leads
  //   await ghl.addTag(session.contactId, 'evidence-pre-scanned');
  // }

  // For now, we'll check if the global helpers are available
  if (global._3cir_sessionCache && global._3cir_ghl) {
    const session = global._3cir_sessionCache.get(sessionId);
    if (session && session.contactId) {
      await global._3cir_ghl.addNote(session.contactId, result.ghlNote);
      console.log(`[Evidence Scan] Full analysis sent to GHL contact ${session.contactId}`);

      // Tag the contact as pre-scanned
      const contact = await global._3cir_ghl.getContact(session.contactId);
      if (contact && contact.contact) {
        const tags = contact.contact.tags || [];
        if (!tags.includes('evidence-pre-scanned')) {
          tags.push('evidence-pre-scanned');
          await global._3cir_ghl.updateContact(session.contactId, { tags });
        }
      }
    }
  } else {
    console.log('[Evidence Scan] Session cache / GHL not wired yet — skipping GHL note');
  }
}

module.exports = router;
