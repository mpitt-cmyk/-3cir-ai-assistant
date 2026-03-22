'use strict';

// =============================================================================
// 3CIR EVIDENCE PORTFOLIO AI PRE-SCANNER
// services/evidence-scanner.js
//
// FIXES APPLIED:
// #1  — SDK import matches server.js pattern (Anthropic.default)
// #3  — Graduate Diploma codes match system-prompt.js exactly
// #8  — Timeout on Claude analysis calls (45 seconds)
// #10 — Documented duplicate PSP40316/PSP40416 key limitation
// =============================================================================

// FIX #1: Match the SDK import pattern used in server.js
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// FIX #8: Timeout for Claude analysis calls
const ANALYSIS_TIMEOUT_MS = 45000;

// =============================================================================
// QUALIFICATION EVIDENCE DOMAIN MAPPINGS
// NOTE (FIX #10): PSP40316 and PSP40416 have stream variants in system-prompt.js
// (Fraud Control, Personnel Vetting, Regulatory Compliance) but JS objects only
// allow one value per key. The base domains cover all streams.
// =============================================================================

const EVIDENCE_DOMAINS = {
  'BSB40520': { name: 'Certificate IV in Leadership and Management', domains: ['Team leadership and supervision','Operational planning and organising','Workplace communication and presentations','Risk identification and management','Budget and resource management','Performance management and feedback','Workplace health and safety responsibilities'] },
  'BSB50420': { name: 'Diploma of Leadership and Management', domains: ['Strategic and operational leadership','Team development and mentoring','Organisational change management','Advanced communication and negotiation','Financial planning and budgeting','Risk management frameworks','Project planning and delivery','Workforce planning'] },
  'BSB60420': { name: 'Advanced Diploma of Leadership and Management', domains: ['Senior strategic leadership','Organisational development and governance','Complex stakeholder management','Business planning and strategy execution','Advanced financial management','Innovation and continuous improvement','Policy development and compliance','Executive decision-making'] },
  'BSB20120': { name: 'Certificate II in Workplace Skills', domains: ['Basic workplace communication','Teamwork and cooperation','Using workplace technology','Following workplace procedures','Basic problem solving'] },
  'BSB30120': { name: 'Certificate III in Business', domains: ['Business communication (written and verbal)','Customer service','Using business technology','Record keeping and administration','Workplace safety awareness','Time management and prioritisation'] },
  'BSB40120': { name: 'Certificate IV in Business', domains: ['Business administration and coordination','Customer and stakeholder relationships','Document management and reporting','Team coordination and support','Financial record keeping','Workplace compliance'] },
  'BSB50120': { name: 'Diploma of Business', domains: ['Business operations management','Strategic planning participation','Financial management and reporting','Human resources coordination','Compliance and governance','Stakeholder engagement','Risk and quality management'] },
  'BSB60120': { name: 'Advanced Diploma of Business', domains: ['Senior business operations','Strategic business development','Advanced financial analysis','Governance and regulatory compliance','Organisational performance management','Market analysis and business intelligence'] },
  'BSB30719': { name: 'Certificate III in Work Health and Safety', domains: ['WHS legislation and compliance awareness','Hazard identification','Risk assessment basics','Incident reporting','Workplace inspections','Safety communication'] },
  'BSB41419': { name: 'Certificate IV in Work Health and Safety', domains: ['WHS legislation and standards','Risk assessment and control','Incident investigation','Safety management systems','Consultation and communication','Hazard management','Emergency response planning'] },
  'BSB51319': { name: 'Diploma of Work Health and Safety', domains: ['WHS management system implementation','Advanced risk management','WHS auditing and compliance','Injury management and return to work','Emergency management','WHS training and education','Contractor safety management','Data analysis and reporting'] },
  'BSB60619': { name: 'Advanced Diploma of Work Health and Safety', domains: ['Strategic WHS management','WHS governance and policy development','Advanced auditing and compliance frameworks','Organisational WHS culture development','Complex risk management','Legal compliance and prosecution awareness','WHS performance measurement'] },
  'BSB40920': { name: 'Certificate IV in Project Management Practice', domains: ['Project planning and scheduling','Scope management','Budget and cost management','Stakeholder communication','Risk identification in projects','Quality control','Team coordination'] },
  'BSB50820': { name: 'Diploma of Project Management', domains: ['Project lifecycle management','Advanced project planning and scheduling','Budget and financial management','Stakeholder and contract management','Risk management frameworks','Quality assurance systems','Team leadership in project environments','Reporting and governance'] },
  'BSB60720': { name: 'Advanced Diploma of Program Management', domains: ['Program governance and strategy','Multi-project coordination','Advanced stakeholder management','Program risk and issue management','Benefits realisation','Resource and portfolio management','Organisational change through programs'] },
  'BSB40420': { name: 'Certificate IV in Human Resource Management', domains: ['Recruitment and onboarding','Employee relations','Performance management processes','Training and development coordination','WHS responsibilities in HR','HR administration and record keeping','Payroll and entitlements awareness'] },
  'BSB50320': { name: 'Diploma of Human Resource Management', domains: ['Strategic HR planning','Workforce planning and development','Employee and industrial relations','Performance management systems','Recruitment strategy','WHS management from HR perspective','Organisational development','HR policy development'] },
  'BSB30220': { name: 'Certificate III in Entrepreneurship and New Business', domains: ['Business idea development','Market research basics','Financial literacy','Marketing and sales fundamentals','Business planning','Innovation and creativity'] },
  'BSB40320': { name: 'Certificate IV in Entrepreneurship and New Business', domains: ['Business model development','Market analysis and strategy','Financial planning and management','Marketing and digital presence','Legal and regulatory requirements','Innovation and product development','Business networking'] },
  'BSB40820': { name: 'Certificate IV in Marketing and Communication', domains: ['Marketing strategy and planning','Digital marketing and social media','Content creation and communication','Market research and analysis','Brand management','Customer engagement','Campaign management'] },
  'BSB50920': { name: 'Diploma of Quality Auditing', domains: ['Audit planning and execution','Quality management systems (ISO standards)','Compliance monitoring','Report writing and findings','Corrective action management','Risk-based auditing','Stakeholder communication in audits'] },
  'CPP40719': { name: 'Certificate IV in Security Management', domains: ['Security operations management','Risk assessment and threat analysis','Emergency and crisis management','Personnel management in security','Legal and regulatory compliance','Security technology systems','Report writing and incident management'] },
  'CPP41519': { name: 'Certificate IV in Security Risk Analysis', domains: ['Security risk methodology','Threat and vulnerability assessment','Physical security measures','Information security awareness','Risk treatment and mitigation','Stakeholder consultation','Report writing and recommendations'] },
  'CPP50619': { name: 'Diploma of Security Risk Management', domains: ['Strategic security management','Enterprise risk management','Security audit and compliance','Crisis and business continuity management','Advanced threat assessment','Security policy and governance','Personnel and contractor security','Technology and cyber awareness'] },
  'PSP40316': { name: 'Certificate IV in Government Security', domains: ['Government security frameworks and legislation','Personnel security and vetting','Physical security management','Information and ICT security','Security risk assessment','Incident response and reporting','Protective security policy'] },
  'PSP40416': { name: 'Certificate IV in Government Investigations', domains: ['Investigation planning and methodology','Evidence collection and management','Interview and statement techniques','Legal and regulatory frameworks','Report writing for investigations','Ethical conduct in investigations'] },
  'PSP50316': { name: 'Diploma of Government Security', domains: ['Advanced government security policy','Security governance and compliance','Advanced risk assessment methodologies','Counter-intelligence awareness','Critical infrastructure protection','Security culture development','International security cooperation'] },
  'PSP50416': { name: 'Diploma of Government Investigations', domains: ['Complex investigation management','Advanced evidence analysis','Legal proceedings and prosecution support','Covert and sensitive investigations','Intelligence analysis','Investigation team management','Cross-agency coordination'] },
  'CSC40122': { name: 'Certificate IV in Correctional Practice', domains: ['Offender management and supervision','Security operations in corrections','Behavioural management','Case management and reporting','Emergency response in correctional settings','Legal and ethical responsibilities','Cultural awareness and diversity'] },
  'CSC50122': { name: 'Diploma of Correctional Administration', domains: ['Correctional facility management','Advanced offender management','Policy and compliance in corrections','Staff management and development','Risk management in corrections','Rehabilitation program coordination','Stakeholder and community engagement'] },
  '22603VIC': { name: 'Certificate IV in Cyber Security', domains: ['Network security fundamentals','Threat identification and monitoring','Security incident response','Access control and authentication','Security policy and compliance','Risk assessment in ICT','Digital forensics basics'] },
  // FIX #3: Graduate Diploma codes now match system-prompt.js exactly
  'BSB80120': { name: 'Graduate Diploma of Management (Learning)', domains: ['Organisational learning strategy','Advanced leadership and management','Learning program design and evaluation','Workforce capability development','Strategic planning and governance','Research and evidence-based practice'] },
  'BSB80220': { name: 'Graduate Diploma of Portfolio Management', domains: ['Portfolio governance and strategy','Multi-program coordination and oversight','Strategic investment decision-making','Benefits realisation management','Organisational change through portfolios','Executive stakeholder management','Resource allocation across programs'] },
  'BSB80320': { name: 'Graduate Diploma of Strategic Leadership', domains: ['Strategic organisational leadership','Governance and board-level management','Complex stakeholder engagement','Organisational transformation','Executive decision-making','Strategic financial management','Innovation and organisational culture'] },
};

function buildAnalysisPrompt(qualCode, qualName, domains, audience) {
  var discountNote = audience === 'services'
    ? 'This person is military/emergency services (25% discount applies).'
    : 'This person is from the general public.';

  return 'You are an expert RPL (Recognition of Prior Learning) evidence analyst for 3CIR, an Australian RPL provider operating under Asset College (RTO 31718).\n\nTASK: Analyse the uploaded document against the competency domains for ' + qualCode + ' ' + qualName + '.\n\nCOMPETENCY DOMAINS TO ASSESS:\n' + domains.map(function(d, i) { return (i + 1) + '. ' + d; }).join('\n') + '\n\n' + discountNote + '\n\nINSTRUCTIONS:\n1. Read the entire document carefully\n2. For EACH competency domain, assess the evidence level:\n   - STRONG: Clear, direct evidence of skills/experience in this area\n   - MODERATE: Some evidence or transferable experience\n   - WEAK: Minimal or indirect evidence\n   - NONE: No evidence found\n3. Calculate an overall match percentage (weighted average: STRONG=100%, MODERATE=60%, WEAK=20%, NONE=0%)\n4. Identify the top 3 strongest areas\n5. Identify the top 3 gaps (weakest areas)\n6. Note any particularly impressive evidence or experience\n7. Note the person\'s approximate years of experience if detectable\n\nRESPOND IN THIS EXACT JSON FORMAT (no markdown, no backticks, just raw JSON):\n{"overallScore":82,"totalDomains":7,"strongCount":4,"moderateCount":2,"weakCount":1,"noneCount":0,"domainResults":[{"domain":"Team leadership and supervision","rating":"STRONG","evidenceFound":"10 years managing teams","specificExamples":["Led platoon of 30 soldiers"]}],"topStrengths":["Team leadership - extensive direct leadership experience","Operational planning - demonstrated through deployments","Risk management - formal training and practical application"],"topGaps":["Budget management - no specific financial evidence found","WHS - limited formal documentation","Performance management - no evidence of formal appraisals"],"yearsExperience":"approximately 12 years","notableEvidence":"Extensive military leadership experience.","recommendedAdditionalEvidence":["Position descriptions showing budget responsibility","WHS training certificates","Performance review templates"],"overallAssessment":"Strong candidate for RPL."}\n\nBe thorough but realistic. Do not inflate scores. A 1-page resume will naturally score lower than a detailed service record. This analysis will be used by an experienced RPL assessor, so accuracy matters more than positivity.\n\nAustralian English throughout.';
}

function buildProspectSummary(analysis, qualCode, qualName, audience) {
  var score = analysis.overallScore;
  var strengths = analysis.topStrengths || [];
  var gaps = analysis.topGaps || [];

  var confidenceText;
  if (score >= 80) confidenceText = 'Strong candidate \u2014 your experience aligns well with this qualification.';
  else if (score >= 60) confidenceText = 'Good candidate \u2014 your experience covers most areas, with some gaps that are common and easy to address.';
  else if (score >= 40) confidenceText = 'Possible candidate \u2014 you have relevant experience in several areas, but may need additional evidence or a gap training conversation.';
  else confidenceText = 'This qualification may require additional evidence or some gap training. A personal review by our assessor will give you a clear picture.';

  function extractDomain(s) {
    var sep = [' \u2014 ', ' — ', ' - '];
    for (var i = 0; i < sep.length; i++) {
      var idx = s.indexOf(sep[i]);
      if (idx > 0) return s.substring(0, idx).trim();
    }
    return s.trim();
  }

  // FIX #4: No staff names — use "our senior assessor"
  return {
    score: score,
    qualCode: qualCode,
    qualName: qualName,
    confidenceText: confidenceText,
    strengths: strengths.slice(0, 3).map(extractDomain),
    gaps: gaps.slice(0, 3).map(extractDomain),
    callToAction: score >= 40
      ? 'Submit your free RPL assessment form and our senior assessor will do a thorough personal review within 24\u201348 hours.'
      : 'We recommend booking a quick chat to discuss your options \u2014 there may be alternative qualifications that are a better fit for your background.'
  };
}

function buildGHLNote(analysis, qualCode, qualName, fileName) {
  var lines = [
    'AI EVIDENCE PRE-SCAN \u2014 ' + qualCode + ' ' + qualName,
    'Document: ' + fileName,
    'Overall Score: ' + analysis.overallScore + '%',
    'Domains: ' + (analysis.strongCount||0) + ' Strong, ' + (analysis.moderateCount||0) + ' Moderate, ' + (analysis.weakCount||0) + ' Weak, ' + (analysis.noneCount||0) + ' None',
    'Experience: ' + (analysis.yearsExperience || 'Not determined'),
    '',
    '--- DOMAIN RESULTS ---'
  ];
  if (analysis.domainResults) {
    for (var i = 0; i < analysis.domainResults.length; i++) {
      var dr = analysis.domainResults[i];
      lines.push('[' + dr.rating + '] ' + dr.domain);
      if (dr.evidenceFound) lines.push('  Evidence: ' + dr.evidenceFound);
      if (dr.specificExamples && dr.specificExamples.length > 0) lines.push('  Examples: ' + dr.specificExamples.join('; '));
    }
  }
  lines.push('');
  lines.push('--- TOP STRENGTHS ---');
  (analysis.topStrengths || []).forEach(function(s) { lines.push('+ ' + s); });
  lines.push('');
  lines.push('--- GAPS ---');
  (analysis.topGaps || []).forEach(function(g) { lines.push('- ' + g); });
  lines.push('');
  lines.push('--- RECOMMENDED ADDITIONAL EVIDENCE ---');
  (analysis.recommendedAdditionalEvidence || []).forEach(function(r) { lines.push('* ' + r); });
  lines.push('');
  lines.push('--- ASSESSOR NOTES ---');
  lines.push(analysis.overallAssessment || '');
  lines.push('');
  lines.push('Notable: ' + (analysis.notableEvidence || 'None'));
  lines.push('');
  lines.push('(Generated by 3CIR AI Evidence Pre-Scanner)');
  return lines.join('\n');
}

async function analyseEvidence(fileBuffer, mimeType, fileName, qualCode, audience) {
  var qualData = EVIDENCE_DOMAINS[qualCode];
  if (!qualData) {
    return { success: false, error: 'Qualification ' + qualCode + ' does not have evidence domain mapping configured yet. Our assessor will review this manually during your free RPL assessment.', qualCode: qualCode, qualName: qualCode };
  }

  var qualName = qualData.name;
  var domains = qualData.domains;
  var analysisPrompt = buildAnalysisPrompt(qualCode, qualName, domains, audience);

  var messageContent = [];
  if (mimeType === 'application/pdf') {
    messageContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') } });
  } else if (mimeType.startsWith('image/')) {
    messageContent.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: fileBuffer.toString('base64') } });
  } else {
    var textContent = fileBuffer.toString('utf-8');
    if (!textContent || textContent.trim().length < 20) {
      return { success: false, error: 'The document appears to be empty or could not be read. Please try uploading a PDF version instead.', qualCode: qualCode, qualName: qualName };
    }
    messageContent.push({ type: 'text', text: 'DOCUMENT CONTENT (extracted from ' + fileName + '):\n\n' + textContent });
  }
  messageContent.push({ type: 'text', text: analysisPrompt });

  try {
    console.log('[Evidence Scanner] Analysing ' + fileName + ' against ' + qualCode + ' ' + qualName);
    var startTime = Date.now();

    // FIX #8: Timeout via AbortController
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, ANALYSIS_TIMEOUT_MS);

    var response;
    try {
      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: messageContent }]
      }, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }

    var elapsed = Date.now() - startTime;
    console.log('[Evidence Scanner] Analysis completed in ' + elapsed + 'ms');

    var responseText = response.content.filter(function(c) { return c.type === 'text'; }).map(function(c) { return c.text; }).join('');
    var cleanJson = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    var analysis;
    try {
      analysis = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error('[Evidence Scanner] JSON parse error, attempting salvage:', parseErr.message);
      var salvaged = salvageJson(cleanJson);
      if (salvaged) {
        analysis = salvaged;
      } else {
        return { success: false, error: 'Analysis completed but results could not be processed. Our assessor will review your document personally.', rawResponse: responseText.substring(0, 500) };
      }
    }

    // Validate score
    if (typeof analysis.overallScore !== 'number' || analysis.overallScore < 0 || analysis.overallScore > 100) {
      analysis.overallScore = Math.max(0, Math.min(100, Math.round(analysis.overallScore || 0)));
    }

    var prospectSummary = buildProspectSummary(analysis, qualCode, qualName, audience);
    var ghlNote = buildGHLNote(analysis, qualCode, qualName, fileName);

    return { success: true, prospectSummary: prospectSummary, ghlNote: ghlNote, fullAnalysis: analysis, qualCode: qualCode, qualName: qualName, fileName: fileName, analysisTimeMs: elapsed };

  } catch (apiErr) {
    if (apiErr.name === 'AbortError') {
      console.error('[Evidence Scanner] Analysis timed out after ' + ANALYSIS_TIMEOUT_MS + 'ms');
      return { success: false, error: 'The analysis is taking longer than expected. Our assessor will review your document personally during your free RPL assessment.', apiError: 'timeout' };
    }
    console.error('[Evidence Scanner] Claude API error:', apiErr.message);
    return { success: false, error: 'The evidence analysis could not be completed right now. Our assessor will review your document personally.', apiError: apiErr.message };
  }
}

function salvageJson(text) {
  try {
    var attempt = text.replace(/,\s*([}\]])/g, '$1');
    var ob = (attempt.match(/{/g) || []).length;
    var cb = (attempt.match(/}/g) || []).length;
    var oq = (attempt.match(/\[/g) || []).length;
    var cq = (attempt.match(/\]/g) || []).length;
    for (var i = 0; i < oq - cq; i++) attempt += ']';
    for (var j = 0; j < ob - cb; j++) attempt += '}';
    return JSON.parse(attempt);
  } catch (e) { return null; }
}

async function extractWordText(fileBuffer) {
  try {
    var mammoth = require('mammoth');
    var result = await mammoth.extractRawText({ buffer: fileBuffer });
    return result.value;
  } catch (err) {
    console.warn('[Evidence Scanner] mammoth not available:', err.message);
    return fileBuffer.toString('utf-8').replace(/[^\x20-\x7E\n\r\t]/g, ' ');
  }
}

module.exports = { analyseEvidence: analyseEvidence, extractWordText: extractWordText, EVIDENCE_DOMAINS: EVIDENCE_DOMAINS, buildProspectSummary: buildProspectSummary, buildGHLNote: buildGHLNote };
