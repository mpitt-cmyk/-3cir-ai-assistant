(function() {
  'use strict';

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

  // Audience detection — robust with multiple path checks
  var pathname = window.location.pathname.toLowerCase();
  var audience = 'public';
  if (pathname.indexOf('/services') !== -1 || pathname.indexOf('/military') !== -1 || pathname.indexOf('/emergency') !== -1 || pathname.indexOf('/defence') !== -1 || pathname.indexOf('/defense') !== -1 || pathname.indexOf('/veteran') !== -1 || pathname.indexOf('/adf') !== -1) {
    audience = 'services';
  }
  var scriptTag = document.querySelector('script[src*="widget.js"]');
  if (scriptTag && scriptTag.getAttribute('data-audience')) audience = scriptTag.getAttribute('data-audience');

  console.log('[3CIR Widget v2.0] Audience: ' + audience + ' | Path: ' + pathname + ' | Theme: ' + (audience === 'services' ? 'GOLD' : 'GREEN'));

  // Logo URL — hosted on Render server in public/ folder
  var LOGO_URL = API_BASE + '/public/logo.jpg';
  var RPL_FORM_URL = audience === 'services' ? 'https://www.3cir.com/services/rpl-assessment-form/' : 'https://www.3cir.com/public/rpl-assessment-form/';

  // Theme — colours matched to website branding
  var T = audience === 'services'
    ? { primary: '#e9ae0b', headerBg: 'linear-gradient(135deg, #1A1A1A, #2A2A2A)', headerText: '#e9ae0b', userBubble: '#e9ae0b', userText: '#1A1A1A', botBubble: '#F5F5F5', botText: '#1A1A1A', avatar: '#e9ae0b', avatarText: '#1A1A1A', name: '3CIR Services', subtitle: 'RPL Consultant — Online now', fabFill: '#1A1A1A', sendFill: '#1A1A1A' }
    : { primary: '#1b8466', headerBg: 'linear-gradient(135deg, #1b8466, #146b52)', headerText: '#FFFFFF', userBubble: '#1b8466', userText: '#FFFFFF', botBubble: '#F5F5F5', botText: '#1A1A1A', avatar: '#1b8466', avatarText: '#FFFFFF', name: '3CIR', subtitle: 'RPL Consultant — Online now', fabFill: '#FFF', sendFill: '#FFF' };

  var sessionId = null, messages = [], isStreaming = false, widgetLoaded = false, bubbleDismissed = false, chatOpen = false, hasShownCta = false, hasShownRating = false;

  function saveSession() { if (sessionId) sessionStorage.setItem('3cir_sid', sessionId); }
  function loadSession() { return sessionStorage.getItem('3cir_sid'); }
  function clearSession() { sessionStorage.removeItem('3cir_sid'); }

  // P7: Abandoned chat
  function saveAbandonedData() {
    if (messages.length <= 1) return;
    try { localStorage.setItem('3cir_return', JSON.stringify({ lastTopic: getLastTopic(), audience: audience, messageCount: messages.length, timestamp: Date.now(), leadCaptured: !!localStorage.getItem('3cir_lead_captured') })); } catch (e) {}
  }
  function getReturnData() {
    try { var d = localStorage.getItem('3cir_return'); if (!d) return null; var p = JSON.parse(d); if (Date.now() - p.timestamp > 30*24*60*60*1000) { localStorage.removeItem('3cir_return'); return null; } if (p.leadCaptured) return null; return p; } catch (e) { return null; }
  }
  function getLastTopic() {
    var kw = ['leadership','management','business','whs','safety','project','hr','security','cyber','correctional','quality','entrepreneurship','marketing','government'];
    for (var i = messages.length-1; i >= 0; i--) { if (messages[i].role !== 'assistant') continue; var t = messages[i].content.toLowerCase(); for (var j = 0; j < kw.length; j++) { if (t.indexOf(kw[j]) !== -1) return kw[j].charAt(0).toUpperCase()+kw[j].slice(1); } }
    return 'RPL qualifications';
  }
  function markLeadCaptured() { try { localStorage.setItem('3cir_lead_captured','1'); } catch(e){} }

  // P8: Retargeting
  function fireQualInterestEvent(q) { if (typeof fbq==='function') try{fbq('trackCustom','QualInterest',{qualification:q,audience:audience})}catch(e){} if (typeof dataLayer!=='undefined'&&Array.isArray(dataLayer)) try{dataLayer.push({event:'qual_interest',qualification:q,audience:audience})}catch(e){} }
  function fireChatOpenEvent() { if (typeof fbq==='function') try{fbq('trackCustom','ChatOpen',{audience:audience,page:pathname})}catch(e){} if (typeof dataLayer!=='undefined'&&Array.isArray(dataLayer)) try{dataLayer.push({event:'chat_open',audience:audience})}catch(e){} }
  function fireLeadCapturedEvent() { if (typeof fbq==='function') try{fbq('track','Lead',{content_category:'AI Chatbot',audience:audience})}catch(e){} if (typeof dataLayer!=='undefined'&&Array.isArray(dataLayer)) try{dataLayer.push({event:'chatbot_lead',audience:audience})}catch(e){} }

  // ============================================================
  // INIT
  // ============================================================
  function init() { injectStyles(); createFloatingButton(); setupProactiveBubble(); setupExitIntent(); var saved = loadSession(); if (saved) sessionId = saved; }

  function injectStyles() {
    var css = document.createElement('style');
    css.textContent = `
      #cir-fab{position:fixed;bottom:24px;right:24px;width:64px;height:64px;border-radius:50%;background:${T.primary};border:none;cursor:pointer;z-index:99998;box-shadow:0 4px 16px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;transition:transform 0.2s}
      #cir-fab:hover{transform:scale(1.08)}
      #cir-fab svg{width:28px;height:28px;fill:${T.fabFill}}
      #cir-bubble{position:fixed;bottom:100px;right:24px;background:#fff;border:1px solid #ddd;border-radius:16px 16px 4px 16px;padding:12px 16px;font:14px/1.4 -apple-system,system-ui,sans-serif;color:#333;max-width:260px;z-index:99997;box-shadow:0 4px 12px rgba(0,0,0,0.12);cursor:pointer;animation:cirFadeIn 0.3s ease}
      #cir-bubble-x{position:absolute;top:4px;right:8px;cursor:pointer;color:#999;font-size:16px;line-height:1}
      @keyframes cirFadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      #cir-win{position:fixed;bottom:24px;right:24px;width:400px;height:620px;max-height:calc(100vh - 48px);border-radius:16px;overflow:hidden;z-index:99999;box-shadow:0 8px 32px rgba(0,0,0,0.2);display:none;flex-direction:column;font-family:-apple-system,system-ui,sans-serif;background:#fff;animation:cirFadeIn 0.3s ease}
      @media(max-width:420px){#cir-win{width:100vw;height:100vh;height:100dvh;max-height:100vh;max-height:100dvh;bottom:0;right:0;left:0;top:0;border-radius:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}#cir-header{padding-top:max(12px,env(safe-area-inset-top))}#cir-input-wrap{padding-bottom:max(12px,env(safe-area-inset-bottom))}#cir-header-close{font-size:28px;padding:8px;min-width:44px;min-height:44px;justify-content:center}.cir-header-btn{min-width:40px;min-height:40px;font-size:22px;justify-content:center}}
      #cir-header{background:${T.headerBg};padding:12px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0}
      #cir-header-logo{width:40px;height:40px;border-radius:50%;overflow:hidden;background:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;border:2px solid ${T.primary}}
      #cir-header-logo img{width:32px;height:32px;object-fit:contain}
      #cir-header-info{flex:1}
      #cir-header-name{color:${T.headerText};font-weight:700;font-size:15px}
      #cir-header-sub{color:${T.headerText};opacity:0.8;font-size:12px}
      .cir-header-btn{color:${T.headerText};text-decoration:none;font-size:18px;padding:4px;cursor:pointer;opacity:0.8;transition:opacity 0.15s;background:none;border:none;display:flex;align-items:center}
      .cir-header-btn:hover{opacity:1}
      #cir-header-close{font-size:22px}
      #cir-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;background:#FAFAFA}
      .cir-msg{display:flex;gap:8px;max-width:85%;animation:cirFadeIn 0.25s ease}
      .cir-msg-bot{align-self:flex-start}
      .cir-msg-user{align-self:flex-end;flex-direction:row-reverse}
      .cir-bub{padding:10px 14px;border-radius:16px;font-size:14px;line-height:1.5;word-wrap:break-word}
      .cir-msg-bot .cir-bub{background:${T.botBubble};color:${T.botText};border-bottom-left-radius:4px}
      .cir-msg-user .cir-bub{background:${T.userBubble};color:${T.userText};border-bottom-right-radius:4px}
      .cir-ts{font-size:11px;color:#999;text-align:center;margin:8px 0 4px}
      .cir-typing{display:flex;gap:4px;padding:10px 14px}
      .cir-typing span{width:8px;height:8px;border-radius:50%;background:#999;animation:cirBounce 1.2s infinite}
      .cir-typing span:nth-child(2){animation-delay:0.2s}
      .cir-typing span:nth-child(3){animation-delay:0.4s}
      @keyframes cirBounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-6px)}}
      #cir-qr{display:flex;flex-wrap:wrap;gap:6px;padding:8px 16px;background:#fff;border-top:1px solid #eee;flex-shrink:0}
      .cir-qr-btn{padding:6px 12px;border:1px solid #ddd;border-radius:20px;background:#fff;cursor:pointer;font-size:13px;color:#333;transition:all 0.15s}
      .cir-qr-btn:hover{border-color:${T.primary};color:${T.primary}}
      #cir-input-wrap{display:flex;gap:8px;padding:12px 16px;border-top:1px solid #eee;background:#fff;flex-shrink:0;align-items:center}
      #cir-attach{width:36px;height:36px;border:none;background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0.5;transition:opacity 0.15s;flex-shrink:0;padding:0}
      #cir-attach:hover{opacity:0.8}
      #cir-attach svg{width:20px;height:20px;fill:#666}
      #cir-mic{width:36px;height:36px;border:none;background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0.5;transition:all 0.2s;flex-shrink:0;padding:0;border-radius:50%}
      #cir-mic:hover{opacity:0.8}
      #cir-mic svg{width:20px;height:20px;fill:#666}
      #cir-mic.recording{opacity:1;background:rgba(204,0,0,0.1)}
      #cir-mic.recording svg{fill:#CC0000}
      @keyframes cirPulse{0%{box-shadow:0 0 0 0 rgba(204,0,0,0.3)}70%{box-shadow:0 0 0 8px rgba(204,0,0,0)}100%{box-shadow:0 0 0 0 rgba(204,0,0,0)}}
      #cir-mic.recording{animation:cirPulse 1.5s infinite}
      #cir-input{flex:1;border:1.5px solid #ddd;border-radius:24px;padding:10px 16px;font-size:14px;font-family:inherit;outline:none;resize:none;height:42px;transition:border-color 0.2s,opacity 0.2s}
      #cir-input:focus{border-color:${T.primary}}
      #cir-input:disabled{opacity:0.5}
      #cir-send{width:42px;height:42px;border-radius:50%;background:${T.primary};border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:opacity 0.2s;flex-shrink:0}
      #cir-send:disabled{opacity:0.4;cursor:not-allowed}
      #cir-send svg{width:18px;height:18px;fill:${T.sendFill}}
      .cir-cta-wrap{align-self:flex-start;max-width:85%;animation:cirFadeIn 0.3s ease;margin:4px 0}
      .cir-cta-btn{display:inline-block;padding:12px 24px;background:${T.primary};color:${audience==='services'?'#1A1A1A':'#FFFFFF'} !important;border-radius:24px;text-decoration:none !important;font-weight:700;font-size:14px;transition:transform 0.15s,box-shadow 0.15s;text-align:center}
      .cir-cta-btn:hover{transform:scale(1.03);box-shadow:0 4px 12px rgba(0,0,0,0.15);color:${audience==='services'?'#1A1A1A':'#FFFFFF'} !important}
      .cir-cta-btn:visited{color:${audience==='services'?'#1A1A1A':'#FFFFFF'} !important}
      .cir-file-msg{display:flex;gap:8px;align-items:center;padding:8px 12px;background:${audience === 'services' ? '#FFF8E1' : '#E8F5E9'};border-radius:12px;font-size:13px;color:${T.primary};margin:4px 0;max-width:85%;align-self:flex-end;animation:cirFadeIn 0.25s ease}
      .cir-file-msg svg{width:16px;height:16px;fill:${T.primary};flex-shrink:0}
      .cir-rating-wrap{display:flex;gap:12px;justify-content:center;padding:12px 0;animation:cirFadeIn 0.3s ease}
      .cir-rating-btn{width:44px;height:44px;border-radius:50%;border:2px solid #ddd;background:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:20px;transition:all 0.2s}
      .cir-rating-btn:hover{border-color:${T.primary};transform:scale(1.1)}
      .cir-rating-btn.selected{border-color:${T.primary};background:${T.primary};color:${audience==='services'?'#1A1A1A':'#FFF'}}
      .cir-rating-text{font-size:12px;color:#999;text-align:center;margin-top:4px}
      .cir-features-hint{background:${audience==='services'?'#2A2A2A':'#f0faf5'};border-radius:12px;padding:10px 14px;margin:4px 0 8px;font-size:12px;color:${audience==='services'?'#999':'#666'};line-height:1.6;animation:cirFadeIn 0.5s ease;max-width:90%;align-self:flex-start}
      .cir-features-hint span{font-weight:600;color:${T.primary}}
      .cir-email-prompt{display:flex;gap:6px;padding:8px 16px;background:#FFF9E6;border-top:1px solid #eee;flex-shrink:0;animation:cirFadeIn 0.3s ease;align-items:center}
      .cir-email-prompt input{flex:1;border:1.5px solid #ddd;border-radius:20px;padding:8px 14px;font-size:13px;outline:none}
      .cir-email-prompt input:focus{border-color:${T.primary}}
      .cir-email-prompt button{padding:8px 14px;border:none;background:${T.primary};color:${audience==='services'?'#1A1A1A':'#FFF'};border-radius:20px;font-size:13px;font-weight:600;cursor:pointer}
      #cir-dragover{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:100;display:none;align-items:center;justify-content:center;border-radius:16px}
      #cir-dragover-text{background:#fff;padding:20px 32px;border-radius:12px;font-size:16px;font-weight:600;color:${T.primary};border:3px dashed ${T.primary}}
    `;
    document.head.appendChild(css);
  }

  function createFloatingButton() {
    var btn = document.createElement('button');
    btn.id = 'cir-fab';
    btn.setAttribute('aria-label','Open chat');
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>';
    btn.onclick = toggleChat;
    document.body.appendChild(btn);
  }

  function setupProactiveBubble() {
    setTimeout(function() {
      if (chatOpen || bubbleDismissed) return;
      var ret = getReturnData();
      if (ret && ret.lastTopic) { showBubble("Welcome back! Last time you were asking about " + ret.lastTopic + ". Ready to pick up where we left off?"); return; }
      showBubble();
    }, 30000);
  }

  function showBubble(msg) {
    if (document.getElementById('cir-bubble') || chatOpen || bubbleDismissed) return;
    msg = msg || (audience === 'services' ? "Need help with your RPL options? Ask me anything." : "Want to know if your experience qualifies? Chat with us.");
    var div = document.createElement('div'); div.id = 'cir-bubble';
    div.innerHTML = '<span id="cir-bubble-x">&times;</span>' + msg;
    div.onclick = function(e) { if (e.target.id==='cir-bubble-x'){bubbleDismissed=true;div.remove();return;} div.remove();toggleChat(); };
    document.body.appendChild(div);
    setTimeout(function(){ if(div.parentNode) div.remove(); }, 10000);
  }

  function setupExitIntent() {
    var fired = false;
    document.addEventListener('mouseout', function(e) { if (fired||chatOpen||bubbleDismissed) return; if (e.clientY<5&&e.relatedTarget===null){fired=true;showBubble();} });
  }

  function toggleChat() {
    var bub = document.getElementById('cir-bubble'); if (bub) bub.remove();
    if (!widgetLoaded) { buildChatWindow(); widgetLoaded = true; }
    var win = document.getElementById('cir-win');

    // If closing after a real conversation (3+ messages) and no rating shown yet, show rating first
    if (chatOpen && !hasShownRating && messages.length >= 3 && messages.filter(function(m){return m.role==='user'}).length >= 1) {
      showSatisfactionRating();
      // Scroll to bottom so they see the rating
      scrollToBottom();
      return; // Don't close yet — let them rate first, then they can click X again
    }

    chatOpen = !chatOpen;
    win.style.display = chatOpen ? 'flex' : 'none';
    document.getElementById('cir-fab').style.display = chatOpen ? 'none' : 'flex';
    if (chatOpen) { fireChatOpenEvent(); if (messages.length === 0) startSession(); }
  }

  function buildChatWindow() {
    var win = document.createElement('div'); win.id = 'cir-win';
    win.innerHTML = `
      <div id="cir-header">
        <div id="cir-header-logo"><img src="${LOGO_URL}" alt="3CIR" onerror="this.parentNode.innerHTML='3C'"/></div>
        <div id="cir-header-info"><div id="cir-header-name">${T.name}</div><div id="cir-header-sub">${T.subtitle}</div></div>
        <button class="cir-header-btn" id="cir-email-btn" title="Email this conversation" aria-label="Email conversation">&#9993;</button>
        <a class="cir-header-btn" href="tel:1300517039" title="Call 1300 517 039" aria-label="Call us">&#9742;</a>
        <button class="cir-header-btn" id="cir-header-close" title="Close chat" aria-label="Close">&times;</button>
      </div>
      <div id="cir-msgs" style="position:relative">
        <div id="cir-dragover"><div id="cir-dragover-text">Drop your resume/CV here</div></div>
      </div>
      <div id="cir-qr"></div>
      <div id="cir-input-wrap">
        <button id="cir-attach" title="Upload resume or document" aria-label="Attach file">
          <svg viewBox="0 0 24 24"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
        </button>
        <input id="cir-input" type="text" placeholder="Type or tap mic to speak..." autocomplete="off"/>
        <button id="cir-mic" title="Speak your message" aria-label="Voice input" style="display:none">
          <svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
        </button>
        <button id="cir-send" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
      </div>
      <input id="cir-file-input" type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.txt" style="display:none"/>
    `;
    document.body.appendChild(win);

    document.getElementById('cir-header-close').onclick = toggleChat;
    document.getElementById('cir-send').onclick = sendMessage;
    document.getElementById('cir-input').addEventListener('keydown', function(e) { if (e.key==='Enter'&&!e.shiftKey&&!isStreaming){e.preventDefault();sendMessage();} });

    // File upload handlers
    document.getElementById('cir-attach').onclick = function() { document.getElementById('cir-file-input').click(); };
    document.getElementById('cir-file-input').addEventListener('change', function(e) { if (e.target.files.length > 0) uploadFile(e.target.files[0]); e.target.value = ''; });

    // Drag and drop on message area
    var msgsEl = document.getElementById('cir-msgs');
    var dragEl = document.getElementById('cir-dragover');
    msgsEl.addEventListener('dragover', function(e) { e.preventDefault(); dragEl.style.display = 'flex'; });
    msgsEl.addEventListener('dragleave', function(e) { if (e.target === msgsEl || e.target === dragEl) dragEl.style.display = 'none'; });
    msgsEl.addEventListener('drop', function(e) { e.preventDefault(); dragEl.style.display = 'none'; if (e.dataTransfer.files.length > 0) uploadFile(e.dataTransfer.files[0]); });

    // Email transcript button
    document.getElementById('cir-email-btn').onclick = showEmailPrompt;

    // Voice input — Web Speech API
    setupVoiceInput();
  }

  // ============================================================
  // VOICE INPUT — Speech to Text
  // ============================================================
  var speechRecognition = null;
  var isRecording = false;

  function setupVoiceInput() {
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.log('[3CIR Widget] Speech recognition not supported in this browser');
      return; // Mic button stays hidden — no speech support
    }

    // Show the mic button since browser supports it
    var micBtn = document.getElementById('cir-mic');
    if (micBtn) micBtn.style.display = 'flex';

    speechRecognition = new SpeechRecognition();
    speechRecognition.lang = 'en-AU';
    speechRecognition.interimResults = true;
    speechRecognition.continuous = false;
    speechRecognition.maxAlternatives = 1;

    var finalTranscript = '';

    speechRecognition.onresult = function(event) {
      var interim = '';
      finalTranscript = '';
      for (var i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      var input = document.getElementById('cir-input');
      if (input) input.value = finalTranscript || interim;
    };

    speechRecognition.onend = function() {
      isRecording = false;
      var micBtn = document.getElementById('cir-mic');
      if (micBtn) micBtn.classList.remove('recording');

      // If we got a final transcript, let the user review and send
      if (finalTranscript.trim()) {
        var input = document.getElementById('cir-input');
        if (input) {
          input.value = finalTranscript.trim();
          input.focus();
        }
      }
    };

    speechRecognition.onerror = function(event) {
      isRecording = false;
      var micBtn = document.getElementById('cir-mic');
      if (micBtn) micBtn.classList.remove('recording');

      if (event.error === 'not-allowed') {
        appendSystemMessage('Microphone access was denied. Please allow microphone access in your browser settings to use voice input.');
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        console.log('[3CIR Widget] Speech error: ' + event.error);
      }
    };

    // Click handler
    if (micBtn) {
      micBtn.onclick = function() {
        if (isStreaming) return;

        if (isRecording) {
          // Stop recording
          speechRecognition.stop();
          isRecording = false;
          micBtn.classList.remove('recording');
        } else {
          // Start recording
          try {
            finalTranscript = '';
            speechRecognition.start();
            isRecording = true;
            micBtn.classList.add('recording');
          } catch (e) {
            console.log('[3CIR Widget] Speech start error: ' + e.message);
          }
        }
      };
    }
  }

  // ============================================================
  // FILE UPLOAD
  // ============================================================
  async function uploadFile(file) {
    var maxSize = 5 * 1024 * 1024; // 5MB
    var allowed = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png', 'text/plain'];
    if (file.size > maxSize) { appendSystemMessage('File is too large. Maximum size is 5MB.'); return; }
    if (allowed.indexOf(file.type) === -1 && !file.name.match(/\.(pdf|doc|docx|jpg|jpeg|png|txt)$/i)) { appendSystemMessage('Please upload a PDF, Word document, or image file.'); return; }

    // Show file message in chat
    var sizeMB = (file.size / (1024*1024)).toFixed(1);
    appendFileMessage(file.name, sizeMB + 'MB');
    setStreaming(true);

    try {
      var formData = new FormData();
      formData.append('file', file);
      formData.append('sessionId', sessionId);

      var resp = await fetch(API_BASE + '/api/upload', { method: 'POST', body: formData });
      var result = await resp.json();

      if (result.ok) {
        appendMessage('assistant', "Thanks, I've received your " + file.name + ". Our team will review it as part of your RPL assessment. This is a great start — it helps us understand your background before the formal assessment.");
        messages.push({ role: 'assistant', content: "File received: " + file.name });
      } else {
        appendMessage('assistant', "I wasn't able to process that file. You can email it directly to info@3cir.com and our team will include it in your assessment.");
      }
    } catch (err) {
      appendMessage('assistant', "There was an issue uploading the file. You can email it to info@3cir.com instead.");
    }
    setStreaming(false);
  }

  function appendFileMessage(name, size) {
    var container = document.getElementById('cir-msgs');
    var div = document.createElement('div');
    div.className = 'cir-file-msg';
    div.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 2l5 5h-5V4zm-3 10v-2h4v2h-4zm6 4H8v-2h8v2z"/></svg>';
    div.innerHTML += '<span>' + name + ' (' + size + ')</span>';
    container.appendChild(div);
    scrollToBottom();
  }

  function appendSystemMessage(text) {
    var container = document.getElementById('cir-msgs');
    var div = document.createElement('div');
    div.style.cssText = 'font-size:12px;color:#999;text-align:center;margin:8px 0;';
    div.textContent = text;
    container.appendChild(div);
    scrollToBottom();
  }

  // ============================================================
  // RPL CTA BUTTON
  // ============================================================
  // ============================================================
  // FEATURES HINT — Shows after opening message
  // ============================================================
  var hasShownHint = false;
  function showFeaturesHint() {
    if (hasShownHint) return;
    hasShownHint = true;
    var container = document.getElementById('cir-msgs');
    var hint = document.createElement('div');
    hint.className = 'cir-features-hint';
    hint.innerHTML = '<span>\ud83d\udca1 Chat tips:</span> Type below or tap <span>\ud83c\udf99\ufe0f mic</span> to speak \u2022 Tap <span>\ud83d\udcce</span> to upload your resume/CV \u2022 Tap <span>\u2709\ufe0f</span> to email this conversation';
    container.appendChild(hint);
    scrollToBottom();
    // Auto-fade after 15 seconds
    setTimeout(function() { if (hint.parentNode) { hint.style.transition = 'opacity 0.5s'; hint.style.opacity = '0'; setTimeout(function() { if (hint.parentNode) hint.remove(); }, 500); } }, 15000);
  }

  // ============================================================
  // RPL CTA BUTTON
  // ============================================================
  function showRplCtaButton() {
    if (hasShownCta) return;
    hasShownCta = true;
    var container = document.getElementById('cir-msgs');
    var wrap = document.createElement('div');
    wrap.className = 'cir-cta-wrap';
    wrap.innerHTML = '<a class="cir-cta-btn" href="' + RPL_FORM_URL + '" target="_blank">Start Your Free RPL Assessment &rarr;</a>';
    container.appendChild(wrap);
    scrollToBottom();
  }

  // ============================================================
  // SATISFACTION RATING
  // ============================================================
  function showSatisfactionRating() {
    if (hasShownRating) return;
    hasShownRating = true;
    var container = document.getElementById('cir-msgs');

    var textDiv = document.createElement('div');
    textDiv.className = 'cir-rating-text';
    textDiv.textContent = 'How was your experience?';
    container.appendChild(textDiv);

    var wrap = document.createElement('div');
    wrap.className = 'cir-rating-wrap';

    var thumbsUp = document.createElement('button');
    thumbsUp.className = 'cir-rating-btn';
    thumbsUp.innerHTML = '&#128077;';
    thumbsUp.title = 'Great experience';
    thumbsUp.onclick = function() { submitRating('positive', thumbsUp, thumbsDown); };

    var thumbsDown = document.createElement('button');
    thumbsDown.className = 'cir-rating-btn';
    thumbsDown.innerHTML = '&#128078;';
    thumbsDown.title = 'Could be better';
    thumbsDown.onclick = function() { submitRating('negative', thumbsDown, thumbsUp); };

    wrap.appendChild(thumbsUp);
    wrap.appendChild(thumbsDown);
    container.appendChild(wrap);
    scrollToBottom();
  }

  async function submitRating(rating, selected, other) {
    selected.classList.add('selected');
    other.style.opacity = '0.3';
    selected.disabled = true;
    other.disabled = true;

    try {
      await fetch(API_BASE + '/api/rating', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, rating: rating }),
      });
    } catch (e) {}

    var container = document.getElementById('cir-msgs');
    var thanks = document.createElement('div');
    thanks.style.cssText = 'font-size:12px;color:#999;text-align:center;margin:8px 0;';
    thanks.textContent = rating === 'positive' ? 'Thanks for the feedback!' : 'Thanks — we\'ll use this to improve.';
    container.appendChild(thanks);
    scrollToBottom();
  }

  // ============================================================
  // EMAIL TRANSCRIPT
  // ============================================================
  function showEmailPrompt() {
    if (document.getElementById('cir-email-prompt')) return;
    var qr = document.getElementById('cir-qr');
    var prompt = document.createElement('div');
    prompt.id = 'cir-email-prompt';
    prompt.className = 'cir-email-prompt';
    prompt.innerHTML = '<div style="width:100%"><div style="display:flex;gap:6px;align-items:center"><input type="email" placeholder="Your email address" id="cir-email-input" style="flex:1;border:1.5px solid #ddd;border-radius:20px;padding:8px 14px;font-size:13px;outline:none"/><button id="cir-email-send" style="padding:8px 14px;border:none;background:' + T.primary + ';color:' + (audience === 'services' ? '#1A1A1A' : '#FFF') + ';border-radius:20px;font-size:13px;font-weight:600;cursor:pointer">Send</button></div><div style="font-size:10px;color:#999;margin-top:4px;padding:0 4px">Includes your conversation, qualification summary, and personalised evidence checklist.</div></div>';
    qr.parentNode.insertBefore(prompt, qr);

    document.getElementById('cir-email-send').onclick = async function() {
      var email = document.getElementById('cir-email-input').value.trim();
      if (!email || !email.match(/[\w.+-]+@[\w.-]+\.\w{2,}/)) { document.getElementById('cir-email-input').style.borderColor = '#CC0000'; return; }

      this.textContent = 'Sending...';
      this.disabled = true;

      try {
        var resp = await fetch(API_BASE + '/api/transcript', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, email: email }),
        });
        var result = await resp.json();
        prompt.innerHTML = '<span style="color:' + T.primary + ';font-size:13px;padding:4px 0">&#10003; Sent! Check your inbox for your conversation summary, evidence checklist, and next steps.</span>';
        setTimeout(function() { prompt.remove(); }, 5000);
      } catch (e) {
        prompt.innerHTML = '<span style="color:#CC0000;font-size:13px;padding:4px 0">Could not send — try emailing info@3cir.com</span>';
        setTimeout(function() { prompt.remove(); }, 5000);
      }
    };

    document.getElementById('cir-email-input').focus();
  }

  // ============================================================
  // SESSION & MESSAGING
  // ============================================================
  async function startSession() {
    var saved = loadSession();
    if (saved) {
      try { var resp = await fetchWithRetry(API_BASE+'/api/session/'+saved); if (resp.ok) { var data = await resp.json(); sessionId=data.sessionId; messages=data.messages||[]; renderAllMessages(); showQuickReplies(data.quickReplies||[]); return; } } catch(e){}
      clearSession();
    }
    try {
      var resp = await fetchWithRetry(API_BASE+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({referrerUrl:window.location.href})});
      var data = await resp.json(); sessionId=data.sessionId; saveSession();
      messages=[{role:'assistant',content:data.openingMessage}]; appendMessage('assistant',data.openingMessage); showQuickReplies(data.quickReplies||[]); showFeaturesHint();
    } catch(err) { appendMessage('assistant',"Our chat is temporarily offline. Please call us on 1300 517 039 or email info@3cir.com."); }
  }

  async function fetchWithRetry(url,opts,retries) {
    retries=retries||2;
    for (var i=0;i<=retries;i++) { try { var r=await fetch(url,opts||{}); if (r.ok||r.status<500) return r; if (i<retries) await sleep(2000); } catch(e){ if (i>=retries) throw e; await sleep(2000); } }
    throw new Error('Network error');
  }
  function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}

  async function sendMessage() {
    var input=document.getElementById('cir-input'); var text=(input.value||'').trim();
    if (!text||isStreaming) return;
    input.value=''; hideQuickReplies(); messages.push({role:'user',content:text}); appendMessage('user',text); setStreaming(true); showTyping();

    try {
      var resp = await fetch(API_BASE+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,sessionId:sessionId,pageUrl:window.location.href})});
      var newSid=resp.headers.get('X-New-Session-Id'); if(newSid){sessionId=newSid;saveSession();}
      hideTyping(); var botBubble=appendMessage('assistant',''); var fullReply='';
      var reader=resp.body.getReader(); var decoder=new TextDecoder(); var buffer='';

      while(true){
        var result=await reader.read(); if(result.done) break;
        buffer+=decoder.decode(result.value,{stream:true}); var lines=buffer.split('\n'); buffer=lines.pop()||'';
        for(var i=0;i<lines.length;i++){
          var line=lines[i].trim(); if(!line.startsWith('data: ')) continue;
          try{
            var evt=JSON.parse(line.substring(6));
            if(evt.type==='text'){fullReply+=evt.content;botBubble.textContent=stripMarkdown(fullReply);scrollToBottom();}
            else if(evt.type==='error'){botBubble.textContent=evt.content;fullReply=evt.content;}
            else if(evt.type==='done'){
              // Show RPL CTA button after quals are discussed
              if(evt.qualsDiscussed&&evt.qualsDiscussed>0) showRplCtaButton();
              // Fire retargeting events
              if(evt.qualsDiscussed&&evt.qualsDiscussed>0){
                var qkw=['leadership','management','business','whs','safety','project','hr','security','cyber','correctional','quality','diploma','certificate'];
                var rl=fullReply.toLowerCase();
                for(var q=0;q<qkw.length;q++){if(rl.indexOf(qkw[q])!==-1){fireQualInterestEvent(qkw[q].charAt(0).toUpperCase()+qkw[q].slice(1));break;}}
              }
              if(evt.leadCaptured){fireLeadCapturedEvent();markLeadCaptured();}
              // Show satisfaction rating after goodbye
              if(evt.conversationEnding) setTimeout(function(){showSatisfactionRating();},1500);
            }
          }catch(e){}
        }
      }
      if(fullReply) messages.push({role:'assistant',content:fullReply});
      saveAbandonedData();
    } catch(err) {
      hideTyping();
      var offline="Our chat is temporarily offline. Please call us on 1300 517 039 or email info@3cir.com.";
      appendMessage('assistant',offline); messages.push({role:'assistant',content:offline});
    }
    setStreaming(false);
  }

  // Strip markdown from bot responses (plain text only in chat)
  function stripMarkdown(text) {
    return text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/_([^_]+)_/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/^[-*+]\s+/gm, '• ');
  }

  function setStreaming(v){isStreaming=v;var input=document.getElementById('cir-input');var send=document.getElementById('cir-send');var attach=document.getElementById('cir-attach');var mic=document.getElementById('cir-mic');if(input)input.disabled=v;if(send)send.disabled=v;if(attach)attach.disabled=v;if(mic){mic.disabled=v;if(v&&isRecording&&speechRecognition){speechRecognition.stop();isRecording=false;mic.classList.remove('recording');}}}

  function appendMessage(role,text){
    var container=document.getElementById('cir-msgs');
    if(messages.length>0){var now=Date.now();if(!appendMessage._lt||now-appendMessage._lt>120000){var ts=document.createElement('div');ts.className='cir-ts';var d=new Date();ts.textContent=d.getHours()+':'+String(d.getMinutes()).padStart(2,'0');container.appendChild(ts);}appendMessage._lt=now;}
    var div=document.createElement('div');div.className='cir-msg cir-msg-'+(role==='user'?'user':'bot');
    var bub=document.createElement('div');bub.className='cir-bub';bub.textContent=role==='user'?text:stripMarkdown(text);
    div.appendChild(bub);container.appendChild(div);scrollToBottom();return bub;
  }

  function renderAllMessages(){var c=document.getElementById('cir-msgs');if(!c)return;var drag=document.getElementById('cir-dragover');c.innerHTML='';if(drag)c.appendChild(drag);else{var d=document.createElement('div');d.id='cir-dragover';d.innerHTML='<div id="cir-dragover-text">Drop your resume/CV here</div>';c.appendChild(d);}for(var i=0;i<messages.length;i++)appendMessage(messages[i].role,messages[i].content);}
  function showTyping(){var c=document.getElementById('cir-msgs');var d=document.createElement('div');d.id='cir-typing';d.className='cir-msg cir-msg-bot';d.innerHTML='<div class="cir-bub cir-typing"><span></span><span></span><span></span></div>';c.appendChild(d);scrollToBottom();}
  function hideTyping(){var e=document.getElementById('cir-typing');if(e)e.remove();}
  function showQuickReplies(items){var qr=document.getElementById('cir-qr');if(!qr||!items.length)return;qr.innerHTML='';items.forEach(function(text){var btn=document.createElement('button');btn.className='cir-qr-btn';btn.textContent=text;btn.onclick=function(){document.getElementById('cir-input').value=text;sendMessage();};qr.appendChild(btn);});}
  function hideQuickReplies(){var qr=document.getElementById('cir-qr');if(qr)qr.innerHTML='';}
  function scrollToBottom(){var el=document.getElementById('cir-msgs');if(el)el.scrollTop=el.scrollHeight;}

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
