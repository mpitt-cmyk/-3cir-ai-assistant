(function() {
  'use strict';

  // FIX #26: Robust API_BASE detection
  var API_BASE = '';
  var scriptEl = document.currentScript;
  if (scriptEl && scriptEl.getAttribute('data-api')) {
    API_BASE = scriptEl.getAttribute('data-api');
  } else {
    var found = document.querySelector('script[src*="widget.js"]');
    if (found && found.getAttribute('data-api')) API_BASE = found.getAttribute('data-api');
  }
  if (!API_BASE) { console.error('[3CIR] No data-api attribute on widget script tag'); return; }
  API_BASE = API_BASE.replace(/\/+$/, '');

  // Detect audience from current URL
  var audience = window.location.pathname.indexOf('/services') !== -1 ? 'services' : 'public';

  // DIAGNOSTIC: Log audience detection so we can verify colour assignment
  console.log('[3CIR Widget] Audience: ' + audience + ' | Path: ' + window.location.pathname + ' | URL: ' + window.location.href);

  // Theme colours
  var T = audience === 'services'
    ? { primary: '#F5A800', headerBg: 'linear-gradient(135deg, #1A1A1A, #2A2A2A)', headerText: '#F5A800', userBubble: '#F5A800', userText: '#1A1A1A', botBubble: '#F5F5F5', botText: '#1A1A1A', avatar: '#F5A800', avatarText: '#1A1A1A', name: '3CIR Services', subtitle: 'RPL Consultant — Online now' }
    : { primary: '#2E7D32', headerBg: 'linear-gradient(135deg, #2E7D32, #1B5E20)', headerText: '#FFFFFF', userBubble: '#2E7D32', userText: '#FFFFFF', botBubble: '#F5F5F5', botText: '#1A1A1A', avatar: '#2E7D32', avatarText: '#FFFFFF', name: '3CIR', subtitle: 'RPL Consultant — Online now' };

  console.log('[3CIR Widget] Theme primary: ' + T.primary + ' (' + (audience === 'services' ? 'GOLD' : 'GREEN') + ')');

  var sessionId = null;
  var messages = [];
  var isStreaming = false;
  var widgetLoaded = false;
  var bubbleDismissed = false;
  var chatOpen = false;

  // Session persistence via sessionStorage
  function saveSession() { if (sessionId) sessionStorage.setItem('3cir_sid', sessionId); }
  function loadSession() { return sessionStorage.getItem('3cir_sid'); }
  function clearSession() { sessionStorage.removeItem('3cir_sid'); }

  // ============================================================
  // P7: ABANDONED CHAT — localStorage for return visitor recognition
  // ============================================================
  function saveAbandonedData() {
    if (messages.length <= 1) return; // Only opening message, not abandoned
    var qualsFromDone = []; // Populated from SSE done events
    try {
      localStorage.setItem('3cir_return', JSON.stringify({
        lastTopic: getLastTopic(),
        audience: audience,
        messageCount: messages.length,
        timestamp: Date.now(),
        leadCaptured: !!localStorage.getItem('3cir_lead_captured'),
      }));
    } catch (e) { /* localStorage not available */ }
  }

  function getReturnData() {
    try {
      var data = localStorage.getItem('3cir_return');
      if (!data) return null;
      var parsed = JSON.parse(data);
      // Only use if less than 30 days old and no lead was captured
      if (Date.now() - parsed.timestamp > 30 * 24 * 60 * 60 * 1000) {
        localStorage.removeItem('3cir_return');
        return null;
      }
      if (parsed.leadCaptured) return null;
      return parsed;
    } catch (e) { return null; }
  }

  function getLastTopic() {
    // Extract the last qualification or topic discussed from messages
    var topics = [];
    var qualKeywords = ['leadership', 'management', 'business', 'whs', 'safety', 'project', 'hr', 'human resource',
      'security', 'cyber', 'correctional', 'quality', 'entrepreneurship', 'marketing', 'government', 'investigation'];
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'assistant') continue;
      var text = messages[i].content.toLowerCase();
      for (var j = 0; j < qualKeywords.length; j++) {
        if (text.indexOf(qualKeywords[j]) !== -1) {
          return qualKeywords[j].charAt(0).toUpperCase() + qualKeywords[j].slice(1);
        }
      }
    }
    return 'RPL qualifications';
  }

  function markLeadCaptured() {
    try { localStorage.setItem('3cir_lead_captured', '1'); } catch (e) {}
  }

  // ============================================================
  // P8: AD RETARGETING — Meta Pixel + Google Ads events
  // ============================================================
  function fireQualInterestEvent(qualName) {
    // Meta Pixel custom event
    if (typeof fbq === 'function') {
      try { fbq('trackCustom', 'QualInterest', { qualification: qualName, audience: audience }); } catch (e) {}
    }
    // Google Ads / GTM dataLayer push
    if (typeof dataLayer !== 'undefined' && Array.isArray(dataLayer)) {
      try { dataLayer.push({ event: 'qual_interest', qualification: qualName, audience: audience }); } catch (e) {}
    }
  }

  function fireChatOpenEvent() {
    if (typeof fbq === 'function') {
      try { fbq('trackCustom', 'ChatOpen', { audience: audience, page: window.location.pathname }); } catch (e) {}
    }
    if (typeof dataLayer !== 'undefined' && Array.isArray(dataLayer)) {
      try { dataLayer.push({ event: 'chat_open', audience: audience }); } catch (e) {}
    }
  }

  function fireLeadCapturedEvent() {
    if (typeof fbq === 'function') {
      try { fbq('track', 'Lead', { content_category: 'AI Chatbot', audience: audience }); } catch (e) {}
    }
    if (typeof dataLayer !== 'undefined' && Array.isArray(dataLayer)) {
      try { dataLayer.push({ event: 'chatbot_lead', audience: audience }); } catch (e) {}
    }
  }

  // ============================================================
  // INIT
  // ============================================================
  function init() {
    injectStyles();
    createFloatingButton();
    setupProactiveBubble();
    setupExitIntent();

    // Try restore session
    var saved = loadSession();
    if (saved) sessionId = saved;
  }

  function injectStyles() {
    var css = document.createElement('style');
    css.textContent = `
      #cir-fab { position:fixed; bottom:24px; right:24px; width:64px; height:64px; border-radius:50%; background:${T.primary}; border:none; cursor:pointer; z-index:99998; box-shadow:0 4px 16px rgba(0,0,0,0.25); display:flex; align-items:center; justify-content:center; transition:transform 0.2s; }
      #cir-fab:hover { transform:scale(1.08); }
      #cir-fab svg { width:28px; height:28px; fill:${audience === 'services' ? '#1A1A1A' : '#FFFFFF'}; }
      #cir-bubble { position:fixed; bottom:100px; right:24px; background:#fff; border:1px solid #ddd; border-radius:16px 16px 4px 16px; padding:12px 16px; font:14px/1.4 -apple-system,system-ui,sans-serif; color:#333; max-width:260px; z-index:99997; box-shadow:0 4px 12px rgba(0,0,0,0.12); cursor:pointer; animation:cirFadeIn 0.3s ease; }
      #cir-bubble-x { position:absolute; top:4px; right:8px; cursor:pointer; color:#999; font-size:16px; line-height:1; }
      @keyframes cirFadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
      #cir-win { position:fixed; bottom:24px; right:24px; width:400px; height:600px; max-height:calc(100vh - 48px); border-radius:16px; overflow:hidden; z-index:99999; box-shadow:0 8px 32px rgba(0,0,0,0.2); display:none; flex-direction:column; font-family:-apple-system,system-ui,sans-serif; background:#fff; animation:cirFadeIn 0.3s ease; }
      @media(max-width:420px){ #cir-win { width:100vw; height:100vh; max-height:100vh; bottom:0; right:0; border-radius:0; } }
      #cir-header { background:${T.headerBg}; padding:14px 16px; display:flex; align-items:center; gap:10px; flex-shrink:0; }
      #cir-header-av { width:36px; height:36px; border-radius:50%; background:${T.avatar}; color:${T.avatarText}; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; flex-shrink:0; }
      #cir-header-info { flex:1; }
      #cir-header-name { color:${T.headerText}; font-weight:700; font-size:15px; }
      #cir-header-sub { color:${T.headerText}; opacity:0.8; font-size:12px; }
      #cir-header-phone { color:${T.headerText}; text-decoration:none; font-size:20px; padding:4px; }
      #cir-header-close { color:${T.headerText}; cursor:pointer; font-size:22px; padding:4px 0 4px 8px; opacity:0.8; }
      #cir-header-close:hover { opacity:1; }
      #cir-msgs { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:8px; background:#FAFAFA; }
      .cir-msg { display:flex; gap:8px; max-width:85%; animation:cirFadeIn 0.25s ease; }
      .cir-msg-bot { align-self:flex-start; }
      .cir-msg-user { align-self:flex-end; flex-direction:row-reverse; }
      .cir-bub { padding:10px 14px; border-radius:16px; font-size:14px; line-height:1.5; word-wrap:break-word; }
      .cir-msg-bot .cir-bub { background:${T.botBubble}; color:${T.botText}; border-bottom-left-radius:4px; }
      .cir-msg-user .cir-bub { background:${T.userBubble}; color:${T.userText}; border-bottom-right-radius:4px; }
      .cir-ts { font-size:11px; color:#999; text-align:center; margin:8px 0 4px; }
      .cir-typing { display:flex; gap:4px; padding:10px 14px; }
      .cir-typing span { width:8px; height:8px; border-radius:50%; background:#999; animation:cirBounce 1.2s infinite; }
      .cir-typing span:nth-child(2) { animation-delay:0.2s; }
      .cir-typing span:nth-child(3) { animation-delay:0.4s; }
      @keyframes cirBounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-6px)} }
      #cir-qr { display:flex; flex-wrap:wrap; gap:6px; padding:8px 16px; background:#fff; border-top:1px solid #eee; flex-shrink:0; }
      .cir-qr-btn { padding:6px 12px; border:1px solid #ddd; border-radius:20px; background:#fff; cursor:pointer; font-size:13px; color:#333; transition:all 0.15s; }
      .cir-qr-btn:hover { border-color:${T.primary}; color:${T.primary}; }
      #cir-input-wrap { display:flex; gap:8px; padding:12px 16px; border-top:1px solid #eee; background:#fff; flex-shrink:0; }
      #cir-input { flex:1; border:1.5px solid #ddd; border-radius:24px; padding:10px 16px; font-size:14px; font-family:inherit; outline:none; resize:none; height:42px; transition:border-color 0.2s,opacity 0.2s; }
      #cir-input:focus { border-color:${T.primary}; }
      #cir-input:disabled { opacity:0.5; }
      #cir-send { width:42px; height:42px; border-radius:50%; background:${T.primary}; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:opacity 0.2s; flex-shrink:0; }
      #cir-send:disabled { opacity:0.4; cursor:not-allowed; }
      #cir-send svg { width:18px; height:18px; fill:${audience === 'services' ? '#1A1A1A' : '#FFF'}; }
    `;
    document.head.appendChild(css);
  }

  function createFloatingButton() {
    var btn = document.createElement('button');
    btn.id = 'cir-fab';
    btn.setAttribute('aria-label', 'Open chat');
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>';
    btn.onclick = toggleChat;
    document.body.appendChild(btn);
  }

  // Proactive floating bubble after 30 seconds
  function setupProactiveBubble() {
    setTimeout(function() {
      if (chatOpen || bubbleDismissed) return;

      // P7: Check for returning visitor
      var returnData = getReturnData();
      if (returnData && returnData.lastTopic) {
        showBubble("Welcome back! Last time you were asking about " + returnData.lastTopic + ". Ready to pick up where we left off?");
        return;
      }

      showBubble();
    }, 30000);
  }

  function showBubble(customMsg) {
    if (document.getElementById('cir-bubble') || chatOpen || bubbleDismissed) return;
    var msg = customMsg || (audience === 'services'
      ? "Need help with your RPL options? Ask me anything."
      : "Want to know if your experience qualifies? Chat with us.");
    var div = document.createElement('div');
    div.id = 'cir-bubble';
    div.innerHTML = '<span id="cir-bubble-x">&times;</span>' + msg;
    div.onclick = function(e) {
      if (e.target.id === 'cir-bubble-x') { bubbleDismissed = true; div.remove(); return; }
      div.remove(); toggleChat();
    };
    document.body.appendChild(div);
    setTimeout(function() { if (div.parentNode) div.remove(); }, 10000);
  }

  // Exit intent — show bubble on desktop when mouse moves toward close
  function setupExitIntent() {
    var fired = false;
    document.addEventListener('mouseout', function(e) {
      if (fired || chatOpen || bubbleDismissed) return;
      if (e.clientY < 5 && e.relatedTarget === null) { fired = true; showBubble(); }
    });
  }

  function toggleChat() {
    var bub = document.getElementById('cir-bubble');
    if (bub) bub.remove();

    if (!widgetLoaded) { buildChatWindow(); widgetLoaded = true; }
    var win = document.getElementById('cir-win');
    chatOpen = !chatOpen;
    win.style.display = chatOpen ? 'flex' : 'none';
    document.getElementById('cir-fab').style.display = chatOpen ? 'none' : 'flex';

    if (chatOpen) {
      fireChatOpenEvent(); // P8
      if (messages.length === 0) startSession();
    }
  }

  function buildChatWindow() {
    var win = document.createElement('div');
    win.id = 'cir-win';
    win.innerHTML = `
      <div id="cir-header">
        <div id="cir-header-av">3C</div>
        <div id="cir-header-info"><div id="cir-header-name">${T.name}</div><div id="cir-header-sub">${T.subtitle}</div></div>
        <a id="cir-header-phone" href="tel:1300517039" title="Call 1300 517 039">&#9742;</a>
        <div id="cir-header-close">&times;</div>
      </div>
      <div id="cir-msgs"></div>
      <div id="cir-qr"></div>
      <div id="cir-input-wrap">
        <input id="cir-input" type="text" placeholder="Type your message..." autocomplete="off" />
        <button id="cir-send" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
      </div>
    `;
    document.body.appendChild(win);

    document.getElementById('cir-header-close').onclick = toggleChat;
    document.getElementById('cir-send').onclick = sendMessage;
    document.getElementById('cir-input').addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey && !isStreaming) { e.preventDefault(); sendMessage(); }
    });
  }

  async function startSession() {
    // Try restore existing session
    var saved = loadSession();
    if (saved) {
      try {
        var resp = await fetchWithRetry(API_BASE + '/api/session/' + saved);
        if (resp.ok) {
          var data = await resp.json();
          sessionId = data.sessionId;
          messages = data.messages || [];
          renderAllMessages();
          showQuickReplies(data.quickReplies || []);
          return;
        }
      } catch (e) { /* session expired, create new */ }
      clearSession();
    }

    try {
      var resp = await fetchWithRetry(API_BASE + '/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referrerUrl: window.location.href }),
      });
      var data = await resp.json();
      sessionId = data.sessionId;
      saveSession();
      messages = [{ role: 'assistant', content: data.openingMessage }];
      appendMessage('assistant', data.openingMessage);
      showQuickReplies(data.quickReplies || []);
    } catch (err) {
      appendMessage('assistant', "Our chat is temporarily offline. Please call us on 1300 517 039 or email info@3cir.com.");
    }
  }

  // Retry logic for network failures
  async function fetchWithRetry(url, opts, retries) {
    retries = retries || 2;
    for (var i = 0; i <= retries; i++) {
      try {
        var r = await fetch(url, opts || {});
        if (r.ok || r.status < 500) return r;
        if (i < retries) await sleep(2000);
      } catch (e) {
        if (i >= retries) throw e;
        await sleep(2000);
      }
    }
    throw new Error('Network error');
  }

  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  async function sendMessage() {
    var input = document.getElementById('cir-input');
    var text = (input.value || '').trim();
    if (!text || isStreaming) return;

    input.value = '';
    hideQuickReplies();
    messages.push({ role: 'user', content: text });
    appendMessage('user', text);
    setStreaming(true);
    showTyping();

    try {
      var resp = await fetch(API_BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId: sessionId, pageUrl: window.location.href }),
      });

      // Check for new session ID (if old one expired)
      var newSid = resp.headers.get('X-New-Session-Id');
      if (newSid) { sessionId = newSid; saveSession(); }

      hideTyping();
      var botBubble = appendMessage('assistant', '');
      var fullReply = '';

      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      while (true) {
        var result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line.startsWith('data: ')) continue;
          try {
            var evt = JSON.parse(line.substring(6));
            if (evt.type === 'text') {
              fullReply += evt.content;
              botBubble.textContent = fullReply;
              scrollToBottom();
            } else if (evt.type === 'error') {
              botBubble.textContent = evt.content;
              fullReply = evt.content;
            } else if (evt.type === 'done') {
              // P8: Fire retargeting events for qualifications discussed
              if (evt.qualsDiscussed && evt.qualsDiscussed > 0) {
                // Extract qual names from the bot reply for retargeting
                var qualKeywords = ['leadership', 'management', 'business', 'whs', 'safety', 'project',
                  'hr', 'human resource', 'security', 'cyber', 'correctional', 'quality',
                  'entrepreneurship', 'marketing', 'government', 'investigation', 'diploma', 'certificate'];
                var replyLower = fullReply.toLowerCase();
                for (var q = 0; q < qualKeywords.length; q++) {
                  if (replyLower.indexOf(qualKeywords[q]) !== -1) {
                    fireQualInterestEvent(qualKeywords[q].charAt(0).toUpperCase() + qualKeywords[q].slice(1));
                    break; // Fire once per response to avoid spamming
                  }
                }
              }
              // P8: Fire lead event if captured
              if (evt.leadCaptured) {
                fireLeadCapturedEvent();
                markLeadCaptured();
              }
            }
          } catch (e) { /* ignore parse errors */ }
        }
      }

      if (fullReply) messages.push({ role: 'assistant', content: fullReply });

      // P7: Save abandoned chat data after each exchange
      saveAbandonedData();

    } catch (err) {
      hideTyping();
      var offline = "Our chat is temporarily offline. Please call us on 1300 517 039 or email info@3cir.com.";
      appendMessage('assistant', offline);
      messages.push({ role: 'assistant', content: offline });
    }

    setStreaming(false);
  }

  // Disable input during streaming
  function setStreaming(v) {
    isStreaming = v;
    var input = document.getElementById('cir-input');
    var send = document.getElementById('cir-send');
    if (input) input.disabled = v;
    if (send) send.disabled = v;
  }

  function appendMessage(role, text) {
    var container = document.getElementById('cir-msgs');
    // Timestamp when >2 min gap
    if (messages.length > 0) {
      var now = Date.now();
      if (!appendMessage._lastTime || now - appendMessage._lastTime > 120000) {
        var ts = document.createElement('div');
        ts.className = 'cir-ts';
        var d = new Date();
        ts.textContent = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
        container.appendChild(ts);
      }
      appendMessage._lastTime = now;
    }

    var div = document.createElement('div');
    div.className = 'cir-msg cir-msg-' + (role === 'user' ? 'user' : 'bot');
    var bub = document.createElement('div');
    bub.className = 'cir-bub';
    bub.textContent = text;
    div.appendChild(bub);
    container.appendChild(div);
    scrollToBottom();
    return bub;
  }

  function renderAllMessages() {
    var container = document.getElementById('cir-msgs');
    if (!container) return;
    container.innerHTML = '';
    for (var i = 0; i < messages.length; i++) {
      appendMessage(messages[i].role, messages[i].content);
    }
  }

  function showTyping() {
    var container = document.getElementById('cir-msgs');
    var div = document.createElement('div');
    div.id = 'cir-typing';
    div.className = 'cir-msg cir-msg-bot';
    div.innerHTML = '<div class="cir-bub cir-typing"><span></span><span></span><span></span></div>';
    container.appendChild(div);
    scrollToBottom();
  }

  function hideTyping() {
    var el = document.getElementById('cir-typing');
    if (el) el.remove();
  }

  function showQuickReplies(items) {
    var qr = document.getElementById('cir-qr');
    if (!qr || !items.length) return;
    qr.innerHTML = '';
    items.forEach(function(text) {
      var btn = document.createElement('button');
      btn.className = 'cir-qr-btn';
      btn.textContent = text;
      btn.onclick = function() {
        document.getElementById('cir-input').value = text;
        sendMessage();
      };
      qr.appendChild(btn);
    });
  }

  function hideQuickReplies() {
    var qr = document.getElementById('cir-qr');
    if (qr) qr.innerHTML = '';
  }

  function scrollToBottom() {
    var el = document.getElementById('cir-msgs');
    if (el) el.scrollTop = el.scrollHeight;
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
