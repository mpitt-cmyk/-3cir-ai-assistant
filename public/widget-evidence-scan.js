// =============================================================================
// 3CIR EVIDENCE PRE-SCANNER — WIDGET INTEGRATION
// widget-evidence-scan.js
//
// This file contains the widget-side code for:
// 1. Triggering the evidence scan after file upload
// 2. Displaying the scan results as a visual card in the chat
//
// INTEGRATION: Add these functions to the existing widget.js
// The scan is triggered by the chatbot's response containing a trigger marker,
// OR by a button in the chat after upload + qual + contact conditions are met.
// =============================================================================

// =============================================================================
// SCAN TRIGGER LOGIC
// Call this after each /api/chat response to check if the bot is offering a scan
// =============================================================================

function checkForScanTrigger(botMessage, sessionData) {
  // The bot will naturally offer the scan in conversation.
  // When the user agrees, we detect it and call the scan endpoint.
  // This is handled by adding a "Scan My Evidence" button after the bot's offer.

  // Check if conditions are met for showing the scan button
  const hasFile = sessionData.uploadedFiles && sessionData.uploadedFiles.length > 0;
  const hasQual = sessionData.qualsDiscussed && sessionData.qualsDiscussed.length > 0;
  const hasContact = sessionData.email || sessionData.phone;

  return hasFile && hasQual && hasContact;
}

// =============================================================================
// SCAN BUTTON RENDERER
// Inserts a "Scan My Evidence" button into the chat after the bot offers
// =============================================================================

function renderScanButton(container, sessionId, qualCode, qualName, audience, apiBase) {
  const btnWrap = document.createElement('div');
  btnWrap.style.cssText = 'display:flex;justify-content:center;padding:8px 0;';

  const btn = document.createElement('button');
  btn.textContent = '\uD83D\uDD0D Scan My Evidence';
  btn.style.cssText = `
    background: linear-gradient(135deg, ${audience === 'services' ? '#e9ae0b' : '#1b8466'}, ${audience === 'services' ? '#d49a00' : '#156b52'});
    color: #fff;
    border: none;
    border-radius: 24px;
    padding: 12px 28px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    transition: transform 0.15s, box-shadow 0.15s;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  btn.onmouseenter = () => {
    btn.style.transform = 'translateY(-1px)';
    btn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
  };
  btn.onmouseleave = () => {
    btn.style.transform = '';
    btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
  };

  btn.onclick = () => {
    btn.disabled = true;
    btn.textContent = 'Analysing your evidence...';
    btn.style.opacity = '0.7';
    btn.style.cursor = 'default';

    // Show the loading animation
    const loadingCard = renderScanLoading(container, audience);

    // Call the scan endpoint
    triggerEvidenceScan(sessionId, qualCode, audience, apiBase)
      .then(result => {
        // Remove loading card
        if (loadingCard && loadingCard.parentNode) {
          loadingCard.parentNode.removeChild(loadingCard);
        }
        // Remove button
        if (btnWrap.parentNode) {
          btnWrap.parentNode.removeChild(btnWrap);
        }
        // Render results
        if (result.success) {
          renderScanResults(container, result.scan, audience);
        } else {
          renderScanError(container, result.error, audience);
        }
      })
      .catch(err => {
        if (loadingCard && loadingCard.parentNode) {
          loadingCard.parentNode.removeChild(loadingCard);
        }
        btn.textContent = 'Scan Failed — Try Again';
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        console.error('[Evidence Scan] Error:', err);
      });
  };

  btnWrap.appendChild(btn);
  container.appendChild(btnWrap);
  return btnWrap;
}

// =============================================================================
// LOADING ANIMATION
// Shows while the scan is running (~15-30 seconds)
// =============================================================================

function renderScanLoading(container, audience) {
  const accent = audience === 'services' ? '#e9ae0b' : '#1b8466';

  const card = document.createElement('div');
  card.style.cssText = `
    background: linear-gradient(135deg, #f8f9fa, #ffffff);
    border: 2px solid ${accent};
    border-radius: 16px;
    padding: 24px;
    margin: 12px 0;
    text-align: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  card.innerHTML = `
    <div style="margin-bottom:16px;">
      <div style="display:inline-block;width:40px;height:40px;border:3px solid #e0e0e0;border-top:3px solid ${accent};border-radius:50%;animation:3cir-spin 0.8s linear infinite;"></div>
    </div>
    <div style="font-size:16px;font-weight:600;color:#1a1a1a;margin-bottom:8px;">Analysing your evidence...</div>
    <div style="font-size:13px;color:#666;">Checking your experience against qualification requirements. This takes about 30 seconds.</div>
    <style>@keyframes 3cir-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style>
  `;

  container.appendChild(card);
  return card;
}

// =============================================================================
// RESULTS CARD RENDERER
// The main visual display of scan results — this is the WOW moment
// =============================================================================

function renderScanResults(container, scan, audience) {
  const accent = audience === 'services' ? '#e9ae0b' : '#1b8466';
  const accentLight = audience === 'services' ? '#fef9e7' : '#e8f8f5';
  const score = scan.score;

  // Determine score colour
  let scoreColour, scoreBg;
  if (score >= 80) { scoreColour = '#27ae60'; scoreBg = '#d4efdf'; }
  else if (score >= 60) { scoreColour = '#2980b9'; scoreBg = '#d6eaf8'; }
  else if (score >= 40) { scoreColour = '#f39c12'; scoreBg = '#fef9e7'; }
  else { scoreColour = '#e74c3c'; scoreBg = '#fadbd8'; }

  // Build the score ring (SVG circle)
  const circumference = 2 * Math.PI * 42;
  const dashOffset = circumference - (score / 100) * circumference;

  const card = document.createElement('div');
  card.style.cssText = `
    background: #ffffff;
    border: 2px solid ${accent};
    border-radius: 16px;
    padding: 0;
    margin: 12px 0;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 4px 16px rgba(0,0,0,0.08);
  `;

  // Header bar
  const header = document.createElement('div');
  header.style.cssText = `
    background: ${accent};
    padding: 12px 20px;
    display: flex;
    align-items: center;
    gap: 8px;
  `;
  header.innerHTML = `
    <span style="font-size:18px;">\uD83D\uDD0D</span>
    <span style="color:#fff;font-size:14px;font-weight:600;letter-spacing:0.3px;">EVIDENCE PRE-SCAN RESULTS</span>
  `;
  card.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.style.cssText = 'padding: 20px;';

  // Score + Qualification row
  const scoreRow = document.createElement('div');
  scoreRow.style.cssText = 'display:flex;align-items:center;gap:20px;margin-bottom:20px;';

  // Score circle
  scoreRow.innerHTML = `
    <div style="flex-shrink:0;position:relative;width:96px;height:96px;">
      <svg width="96" height="96" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r="42" fill="none" stroke="#e8e8e8" stroke-width="6"/>
        <circle cx="48" cy="48" r="42" fill="none" stroke="${scoreColour}" stroke-width="6"
          stroke-linecap="round"
          stroke-dasharray="${circumference}"
          stroke-dashoffset="${dashOffset}"
          transform="rotate(-90 48 48)"
          style="transition: stroke-dashoffset 1.5s ease-out;"/>
      </svg>
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;">
        <div style="font-size:28px;font-weight:700;color:${scoreColour};line-height:1;">${score}%</div>
        <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">match</div>
      </div>
    </div>
    <div style="flex:1;">
      <div style="font-size:13px;color:#666;margin-bottom:4px;">${scan.qualCode}</div>
      <div style="font-size:16px;font-weight:600;color:#1a1a1a;line-height:1.3;">${scan.qualName}</div>
      <div style="font-size:13px;color:${scoreColour};margin-top:6px;font-weight:500;">${scan.confidenceText}</div>
    </div>
  `;
  body.appendChild(scoreRow);

  // Strengths
  if (scan.strengths && scan.strengths.length > 0) {
    const strengthsSection = document.createElement('div');
    strengthsSection.style.cssText = `
      background: #d4efdf;
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 12px;
    `;
    strengthsSection.innerHTML = `
      <div style="font-size:12px;font-weight:600;color:#1e8449;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">\u2705 Your Strengths</div>
      ${scan.strengths.map(s => `<div style="font-size:14px;color:#1a1a1a;padding:3px 0;"\u2022 ${s}</div>`).join('')}
    `;
    body.appendChild(strengthsSection);
  }

  // Gaps
  if (scan.gaps && scan.gaps.length > 0) {
    const gapsSection = document.createElement('div');
    gapsSection.style.cssText = `
      background: #fef9e7;
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 16px;
    `;
    gapsSection.innerHTML = `
      <div style="font-size:12px;font-weight:600;color:#b7950b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">\uD83D\uDCCB Areas to Strengthen</div>
      ${scan.gaps.map(g => `<div style="font-size:14px;color:#1a1a1a;padding:3px 0;">\u2022 ${g}</div>`).join('')}
    `;
    body.appendChild(gapsSection);
  }

  // CTA
  const cta = document.createElement('div');
  cta.style.cssText = `
    background: ${accentLight};
    border-radius: 10px;
    padding: 14px 16px;
    text-align: center;
  `;
  cta.innerHTML = `
    <div style="font-size:14px;color:#333;line-height:1.5;">${scan.callToAction}</div>
  `;
  body.appendChild(cta);

  // Disclaimer
  const disclaimer = document.createElement('div');
  disclaimer.style.cssText = 'font-size:11px;color:#aaa;text-align:center;margin-top:12px;';
  disclaimer.textContent = 'Preliminary AI analysis only. Training and assessment delivered under a third-party arrangement with Asset College (RTO 31718).';
  body.appendChild(disclaimer);

  card.appendChild(body);
  container.appendChild(card);

  // Scroll to results
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  return card;
}

// =============================================================================
// ERROR DISPLAY
// =============================================================================

function renderScanError(container, errorMessage, audience) {
  const accent = audience === 'services' ? '#e9ae0b' : '#1b8466';

  const card = document.createElement('div');
  card.style.cssText = `
    background: #fff;
    border: 2px solid #e0e0e0;
    border-radius: 12px;
    padding: 16px;
    margin: 12px 0;
    text-align: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;
  card.innerHTML = `
    <div style="font-size:14px;color:#666;margin-bottom:8px;">${errorMessage || 'The evidence scan could not be completed right now.'}</div>
    <div style="font-size:13px;color:${accent};">Submit the free RPL assessment form and Matt will review your document personally.</div>
  `;

  container.appendChild(card);
  return card;
}

// =============================================================================
// API CALL — TRIGGER THE SCAN
// =============================================================================

async function triggerEvidenceScan(sessionId, qualCode, audience, apiBase) {
  // Get the most recently uploaded file from the session
  const sessionRes = await fetch(`${apiBase}/api/session/${sessionId}`);
  const sessionData = await sessionRes.json();

  if (!sessionData.uploadedFiles || sessionData.uploadedFiles.length === 0) {
    return { success: false, error: 'No file found to analyse.' };
  }

  // The file is in server memory — we need to re-upload it to the scan endpoint
  // OR we can use the session-based approach where the server reads the stored buffer
  //
  // Approach: POST to /api/evidence-scan with sessionId only (server reads stored file)
  const response = await fetch(`${apiBase}/api/evidence-scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      qualCode,
      audience
    })
  });

  return await response.json();
}

// =============================================================================
// ALTERNATIVE: SESSION-BASED SCAN (no re-upload needed)
//
// If the server stores the file buffer in the session (recommended approach),
// use this simpler endpoint that just takes sessionId + qualCode.
// Add this JSON body endpoint alongside the multer endpoint in routes/evidence-scan.js
// =============================================================================

/*
// Add to routes/evidence-scan.js:

router.post('/api/evidence-scan', express.json(), async (req, res) => {
  const { sessionId, qualCode, audience } = req.body;

  // If this is a JSON request (not multipart), use stored file from session
  if (sessionId && !req.file) {
    const session = sessionCache.get(sessionId);
    if (!session || !session.uploadedFileBuffer) {
      return res.status(400).json({
        success: false,
        error: 'No file found in your session. Please upload a document first.'
      });
    }

    const result = await analyseEvidence(
      session.uploadedFileBuffer,
      session.uploadedFileMime,
      session.uploadedFileName,
      qualCode,
      audience || session.audience
    );

    // ... rest of response handling
  }
});
*/

// =============================================================================
// EXPORTS (for use in widget.js)
// =============================================================================

// These functions should be integrated into the existing widget.js:
// 1. checkForScanTrigger — call after each bot response
// 2. renderScanButton — insert after bot offers the scan
// 3. renderScanResults — display the results card
// 4. triggerEvidenceScan — make the API call

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    checkForScanTrigger,
    renderScanButton,
    renderScanLoading,
    renderScanResults,
    renderScanError,
    triggerEvidenceScan
  };
}
