// =============================================================================
// 3CIR EVIDENCE PRE-SCANNER — WIDGET INTEGRATION
// public/widget-evidence-scan.js
//
// Widget-side code for displaying evidence scan results.
// Includes: scan button, loading animation, results card with score ring.
//
// FIX #5: Fixed broken HTML tags in strengths and gaps rendering
// =============================================================================

// =============================================================================
// SCAN TRIGGER CHECK
// Call after each /api/chat response to check if conditions are met
// =============================================================================

function checkForScanTrigger(botMessage, sessionData) {
  const hasFile = sessionData.uploadedFiles && sessionData.uploadedFiles.length > 0;
  const hasQual = sessionData.qualsDiscussed && sessionData.qualsDiscussed.length > 0;
  const hasContact = sessionData.email || sessionData.phone;
  return hasFile && hasQual && hasContact;
}

// =============================================================================
// SCAN BUTTON RENDERER
// =============================================================================

function renderScanButton(container, sessionId, qualCode, qualName, audience, apiBase) {
  const btnWrap = document.createElement('div');
  btnWrap.style.cssText = 'display:flex;justify-content:center;padding:8px 0;';

  const btn = document.createElement('button');
  btn.textContent = '\uD83D\uDD0D Scan My Evidence';
  btn.style.cssText =
    'background:linear-gradient(135deg,' + (audience === 'services' ? '#e9ae0b,#d49a00' : '#1b8466,#156b52') + ');' +
    'color:#fff;border:none;border-radius:24px;padding:12px 28px;font-size:15px;font-weight:600;' +
    'cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.15);transition:transform 0.15s,box-shadow 0.15s;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';

  btn.onmouseenter = function() {
    btn.style.transform = 'translateY(-1px)';
    btn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
  };
  btn.onmouseleave = function() {
    btn.style.transform = '';
    btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
  };

  btn.onclick = function() {
    btn.disabled = true;
    btn.textContent = 'Analysing your evidence...';
    btn.style.opacity = '0.7';
    btn.style.cursor = 'default';

    var loadingCard = renderScanLoading(container, audience);

    triggerEvidenceScan(sessionId, qualCode, audience, apiBase)
      .then(function(result) {
        if (loadingCard && loadingCard.parentNode) loadingCard.parentNode.removeChild(loadingCard);
        if (btnWrap.parentNode) btnWrap.parentNode.removeChild(btnWrap);
        if (result.success) {
          renderScanResults(container, result.scan, audience);
        } else {
          renderScanError(container, result.error, audience);
        }
      })
      .catch(function(err) {
        if (loadingCard && loadingCard.parentNode) loadingCard.parentNode.removeChild(loadingCard);
        btn.textContent = 'Scan Failed \u2014 Try Again';
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
// =============================================================================

function renderScanLoading(container, audience) {
  var accent = audience === 'services' ? '#e9ae0b' : '#1b8466';
  var card = document.createElement('div');
  card.style.cssText =
    'background:linear-gradient(135deg,#f8f9fa,#ffffff);border:2px solid ' + accent + ';' +
    'border-radius:16px;padding:24px;margin:12px 0;text-align:center;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';

  // Spinner + text
  var spinnerStyle = 'display:inline-block;width:40px;height:40px;border:3px solid #e0e0e0;' +
    'border-top:3px solid ' + accent + ';border-radius:50%;animation:_3cirSpin 0.8s linear infinite;';

  card.innerHTML =
    '<style>@keyframes _3cirSpin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style>' +
    '<div style="margin-bottom:16px;"><div style="' + spinnerStyle + '"></div></div>' +
    '<div style="font-size:16px;font-weight:600;color:#1a1a1a;margin-bottom:8px;">Analysing your evidence...</div>' +
    '<div style="font-size:13px;color:#666;">Checking your experience against qualification requirements. This takes about 30 seconds.</div>';

  container.appendChild(card);
  return card;
}

// =============================================================================
// RESULTS CARD — The WOW moment
// FIX #5: All HTML tags properly closed, bullet characters inside tags
// =============================================================================

function renderScanResults(container, scan, audience) {
  var accent = audience === 'services' ? '#e9ae0b' : '#1b8466';
  var accentLight = audience === 'services' ? '#fef9e7' : '#e8f8f5';
  var score = scan.score;

  // Score colour
  var scoreColour, scoreBg;
  if (score >= 80) { scoreColour = '#27ae60'; scoreBg = '#d4efdf'; }
  else if (score >= 60) { scoreColour = '#2980b9'; scoreBg = '#d6eaf8'; }
  else if (score >= 40) { scoreColour = '#f39c12'; scoreBg = '#fef9e7'; }
  else { scoreColour = '#e74c3c'; scoreBg = '#fadbd8'; }

  // Score ring SVG
  var circumference = 2 * Math.PI * 42;
  var dashOffset = circumference - (score / 100) * circumference;

  var card = document.createElement('div');
  card.style.cssText =
    'background:#ffffff;border:2px solid ' + accent + ';border-radius:16px;padding:0;' +
    'margin:12px 0;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'box-shadow:0 4px 16px rgba(0,0,0,0.08);';

  // Build inner HTML
  var html = '';

  // Header bar
  html += '<div style="background:' + accent + ';padding:12px 20px;display:flex;align-items:center;gap:8px;">';
  html += '<span style="font-size:18px;">\uD83D\uDD0D</span>';
  html += '<span style="color:#fff;font-size:14px;font-weight:600;letter-spacing:0.3px;">EVIDENCE PRE-SCAN RESULTS</span>';
  html += '</div>';

  // Body
  html += '<div style="padding:20px;">';

  // Score + Qualification row
  html += '<div style="display:flex;align-items:center;gap:20px;margin-bottom:20px;">';

  // Score circle SVG
  html += '<div style="flex-shrink:0;position:relative;width:96px;height:96px;">';
  html += '<svg width="96" height="96" viewBox="0 0 96 96">';
  html += '<circle cx="48" cy="48" r="42" fill="none" stroke="#e8e8e8" stroke-width="6"/>';
  html += '<circle cx="48" cy="48" r="42" fill="none" stroke="' + scoreColour + '" stroke-width="6" ';
  html += 'stroke-linecap="round" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + dashOffset + '" ';
  html += 'transform="rotate(-90 48 48)" style="transition:stroke-dashoffset 1.5s ease-out;"/>';
  html += '</svg>';
  html += '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;">';
  html += '<div style="font-size:28px;font-weight:700;color:' + scoreColour + ';line-height:1;">' + score + '%</div>';
  html += '<div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">match</div>';
  html += '</div></div>';

  // Qualification info
  html += '<div style="flex:1;">';
  html += '<div style="font-size:13px;color:#666;margin-bottom:4px;">' + escHtml(scan.qualCode) + '</div>';
  html += '<div style="font-size:16px;font-weight:600;color:#1a1a1a;line-height:1.3;">' + escHtml(scan.qualName) + '</div>';
  html += '<div style="font-size:13px;color:' + scoreColour + ';margin-top:6px;font-weight:500;">' + escHtml(scan.confidenceText) + '</div>';
  html += '</div></div>';

  // FIX #5: Strengths — properly closed tags with bullet inside
  if (scan.strengths && scan.strengths.length > 0) {
    html += '<div style="background:#d4efdf;border-radius:10px;padding:14px 16px;margin-bottom:12px;">';
    html += '<div style="font-size:12px;font-weight:600;color:#1e8449;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">\u2705 Your Strengths</div>';
    for (var i = 0; i < scan.strengths.length; i++) {
      html += '<div style="font-size:14px;color:#1a1a1a;padding:3px 0;">\u2022 ' + escHtml(scan.strengths[i]) + '</div>';
    }
    html += '</div>';
  }

  // FIX #5: Gaps — properly closed tags with bullet inside
  if (scan.gaps && scan.gaps.length > 0) {
    html += '<div style="background:#fef9e7;border-radius:10px;padding:14px 16px;margin-bottom:16px;">';
    html += '<div style="font-size:12px;font-weight:600;color:#b7950b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">\uD83D\uDCCB Areas to Strengthen</div>';
    for (var j = 0; j < scan.gaps.length; j++) {
      html += '<div style="font-size:14px;color:#1a1a1a;padding:3px 0;">\u2022 ' + escHtml(scan.gaps[j]) + '</div>';
    }
    html += '</div>';
  }

  // CTA
  html += '<div style="background:' + accentLight + ';border-radius:10px;padding:14px 16px;text-align:center;">';
  html += '<div style="font-size:14px;color:#333;line-height:1.5;">' + escHtml(scan.callToAction) + '</div>';
  html += '</div>';

  // Disclaimer
  html += '<div style="font-size:11px;color:#aaa;text-align:center;margin-top:12px;">';
  html += 'Preliminary AI analysis only. Training and assessment delivered under a third-party arrangement with Asset College (RTO 31718).';
  html += '</div>';

  html += '</div>'; // close body

  card.innerHTML = html;
  container.appendChild(card);

  // Scroll into view
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  return card;
}

// =============================================================================
// ERROR DISPLAY
// =============================================================================

function renderScanError(container, errorMessage, audience) {
  var accent = audience === 'services' ? '#e9ae0b' : '#1b8466';
  var card = document.createElement('div');
  card.style.cssText =
    'background:#fff;border:2px solid #e0e0e0;border-radius:12px;padding:16px;margin:12px 0;' +
    'text-align:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
  card.innerHTML =
    '<div style="font-size:14px;color:#666;margin-bottom:8px;">' + escHtml(errorMessage || 'The evidence scan could not be completed right now.') + '</div>' +
    '<div style="font-size:13px;color:' + accent + ';">Submit the free RPL assessment form and our senior assessor will review your document personally.</div>';
  container.appendChild(card);
  return card;
}

// =============================================================================
// API CALL — Trigger the scan (session-based, no re-upload needed)
// =============================================================================

function triggerEvidenceScan(sessionId, qualCode, audience, apiBase) {
  return fetch(apiBase + '/api/evidence-scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: sessionId,
      qualCode: qualCode,
      audience: audience
    })
  }).then(function(response) {
    return response.json();
  });
}

// =============================================================================
// HTML ESCAPE HELPER — prevents XSS from scan results
// =============================================================================

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// =============================================================================
// EXPORTS (for use in widget.js integration)
// =============================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    checkForScanTrigger: checkForScanTrigger,
    renderScanButton: renderScanButton,
    renderScanLoading: renderScanLoading,
    renderScanResults: renderScanResults,
    renderScanError: renderScanError,
    triggerEvidenceScan: triggerEvidenceScan
  };
}
