// =============================================================================
// 3CIR EVIDENCE PORTFOLIO AI PRE-SCANNER
// services/evidence-scanner.js
//
// Analyses uploaded documents (resume, service record, position description)
// against qualification competency domains and returns:
// - Prospect-facing: % score + general strengths/gaps (MEDIUM detail)
// - GHL-facing: Full domain-by-domain analysis (FULL detail for Matt)
//
// Integration: Called by /api/evidence-scan endpoint
// Requires: @anthropic-ai/sdk (already in package.json)
// =============================================================================

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// =============================================================================
// QUALIFICATION EVIDENCE DOMAIN MAPPINGS
// These define what competency areas the AI looks for in each qualification.
// Grouped by qualification family to keep it manageable.
// =============================================================================

const EVIDENCE_DOMAINS = {
  // --- LEADERSHIP & MANAGEMENT ---
  'BSB40520': {
    name: 'Certificate IV in Leadership and Management',
    domains: [
      'Team leadership and supervision',
      'Operational planning and organising',
      'Workplace communication and presentations',
      'Risk identification and management',
      'Budget and resource management',
      'Performance management and feedback',
      'Workplace health and safety responsibilities'
    ]
  },
  'BSB50420': {
    name: 'Diploma of Leadership and Management',
    domains: [
      'Strategic and operational leadership',
      'Team development and mentoring',
      'Organisational change management',
      'Advanced communication and negotiation',
      'Financial planning and budgeting',
      'Risk management frameworks',
      'Project planning and delivery',
      'Workforce planning'
    ]
  },
  'BSB60420': {
    name: 'Advanced Diploma of Leadership and Management',
    domains: [
      'Senior strategic leadership',
      'Organisational development and governance',
      'Complex stakeholder management',
      'Business planning and strategy execution',
      'Advanced financial management',
      'Innovation and continuous improvement',
      'Policy development and compliance',
      'Executive decision-making'
    ]
  },

  // --- BUSINESS ---
  'BSB20120': {
    name: 'Certificate II in Workplace Skills',
    domains: [
      'Basic workplace communication',
      'Teamwork and cooperation',
      'Using workplace technology',
      'Following workplace procedures',
      'Basic problem solving'
    ]
  },
  'BSB30120': {
    name: 'Certificate III in Business',
    domains: [
      'Business communication (written and verbal)',
      'Customer service',
      'Using business technology',
      'Record keeping and administration',
      'Workplace safety awareness',
      'Time management and prioritisation'
    ]
  },
  'BSB40120': {
    name: 'Certificate IV in Business',
    domains: [
      'Business administration and coordination',
      'Customer and stakeholder relationships',
      'Document management and reporting',
      'Team coordination and support',
      'Financial record keeping',
      'Workplace compliance'
    ]
  },
  'BSB50120': {
    name: 'Diploma of Business',
    domains: [
      'Business operations management',
      'Strategic planning participation',
      'Financial management and reporting',
      'Human resources coordination',
      'Compliance and governance',
      'Stakeholder engagement',
      'Risk and quality management'
    ]
  },
  'BSB60120': {
    name: 'Advanced Diploma of Business',
    domains: [
      'Senior business operations',
      'Strategic business development',
      'Advanced financial analysis',
      'Governance and regulatory compliance',
      'Organisational performance management',
      'Market analysis and business intelligence'
    ]
  },

  // --- WORK HEALTH & SAFETY ---
  'BSB30719': {
    name: 'Certificate III in Work Health and Safety',
    domains: [
      'WHS legislation and compliance awareness',
      'Hazard identification',
      'Risk assessment basics',
      'Incident reporting',
      'Workplace inspections',
      'Safety communication'
    ]
  },
  'BSB41419': {
    name: 'Certificate IV in Work Health and Safety',
    domains: [
      'WHS legislation and standards',
      'Risk assessment and control',
      'Incident investigation',
      'Safety management systems',
      'Consultation and communication',
      'Hazard management',
      'Emergency response planning'
    ]
  },
  'BSB51319': {
    name: 'Diploma of Work Health and Safety',
    domains: [
      'WHS management system implementation',
      'Advanced risk management',
      'WHS auditing and compliance',
      'Injury management and return to work',
      'Emergency management',
      'WHS training and education',
      'Contractor safety management',
      'Data analysis and reporting'
    ]
  },
  'BSB60619': {
    name: 'Advanced Diploma of Work Health and Safety',
    domains: [
      'Strategic WHS management',
      'WHS governance and policy development',
      'Advanced auditing and compliance frameworks',
      'Organisational WHS culture development',
      'Complex risk management',
      'Legal compliance and prosecution awareness',
      'WHS performance measurement'
    ]
  },

  // --- PROJECT MANAGEMENT ---
  'BSB40920': {
    name: 'Certificate IV in Project Management Practice',
    domains: [
      'Project planning and scheduling',
      'Scope management',
      'Budget and cost management',
      'Stakeholder communication',
      'Risk identification in projects',
      'Quality control',
      'Team coordination'
    ]
  },
  'BSB50820': {
    name: 'Diploma of Project Management',
    domains: [
      'Project lifecycle management',
      'Advanced project planning and scheduling',
      'Budget and financial management',
      'Stakeholder and contract management',
      'Risk management frameworks',
      'Quality assurance systems',
      'Team leadership in project environments',
      'Reporting and governance'
    ]
  },
  'BSB60720': {
    name: 'Advanced Diploma of Program Management',
    domains: [
      'Program governance and strategy',
      'Multi-project coordination',
      'Advanced stakeholder management',
      'Program risk and issue management',
      'Benefits realisation',
      'Resource and portfolio management',
      'Organisational change through programs'
    ]
  },

  // --- HUMAN RESOURCES ---
  'BSB40420': {
    name: 'Certificate IV in Human Resource Management',
    domains: [
      'Recruitment and onboarding',
      'Employee relations',
      'Performance management processes',
      'Training and development coordination',
      'WHS responsibilities in HR',
      'HR administration and record keeping',
      'Payroll and entitlements awareness'
    ]
  },
  'BSB50320': {
    name: 'Diploma of Human Resource Management',
    domains: [
      'Strategic HR planning',
      'Workforce planning and development',
      'Employee and industrial relations',
      'Performance management systems',
      'Recruitment strategy',
      'WHS management from HR perspective',
      'Organisational development',
      'HR policy development'
    ]
  },

  // --- ENTREPRENEURSHIP ---
  'BSB30220': {
    name: 'Certificate III in Entrepreneurship and New Business',
    domains: [
      'Business idea development',
      'Market research basics',
      'Financial literacy',
      'Marketing and sales fundamentals',
      'Business planning',
      'Innovation and creativity'
    ]
  },
  'BSB40320': {
    name: 'Certificate IV in Entrepreneurship and New Business',
    domains: [
      'Business model development',
      'Market analysis and strategy',
      'Financial planning and management',
      'Marketing and digital presence',
      'Legal and regulatory requirements',
      'Innovation and product development',
      'Business networking'
    ]
  },

  // --- MARKETING ---
  'BSB40820': {
    name: 'Certificate IV in Marketing and Communication',
    domains: [
      'Marketing strategy and planning',
      'Digital marketing and social media',
      'Content creation and communication',
      'Market research and analysis',
      'Brand management',
      'Customer engagement',
      'Campaign management'
    ]
  },

  // --- QUALITY AUDITING ---
  'BSB50920': {
    name: 'Diploma of Quality Auditing',
    domains: [
      'Audit planning and execution',
      'Quality management systems (ISO standards)',
      'Compliance monitoring',
      'Report writing and findings',
      'Corrective action management',
      'Risk-based auditing',
      'Stakeholder communication in audits'
    ]
  },

  // --- SECURITY ---
  'CPP40719': {
    name: 'Certificate IV in Security Management',
    domains: [
      'Security operations management',
      'Risk assessment and threat analysis',
      'Emergency and crisis management',
      'Personnel management in security',
      'Legal and regulatory compliance',
      'Security technology systems',
      'Report writing and incident management'
    ]
  },
  'CPP41519': {
    name: 'Certificate IV in Security Risk Analysis',
    domains: [
      'Security risk methodology',
      'Threat and vulnerability assessment',
      'Physical security measures',
      'Information security awareness',
      'Risk treatment and mitigation',
      'Stakeholder consultation',
      'Report writing and recommendations'
    ]
  },
  'CPP50619': {
    name: 'Diploma of Security Risk Management',
    domains: [
      'Strategic security management',
      'Enterprise risk management',
      'Security audit and compliance',
      'Crisis and business continuity management',
      'Advanced threat assessment',
      'Security policy and governance',
      'Personnel and contractor security',
      'Technology and cyber awareness'
    ]
  },

  // --- GOVERNMENT ---
  'PSP40316': {
    name: 'Certificate IV in Government Security',
    domains: [
      'Government security frameworks and legislation',
      'Personnel security and vetting',
      'Physical security management',
      'Information and ICT security',
      'Security risk assessment',
      'Incident response and reporting',
      'Protective security policy'
    ]
  },
  'PSP40416': {
    name: 'Certificate IV in Government Investigations',
    domains: [
      'Investigation planning and methodology',
      'Evidence collection and management',
      'Interview and statement techniques',
      'Legal and regulatory frameworks',
      'Report writing for investigations',
      'Ethical conduct in investigations'
    ]
  },
  'PSP50316': {
    name: 'Diploma of Government Security',
    domains: [
      'Advanced government security policy',
      'Security governance and compliance',
      'Advanced risk assessment methodologies',
      'Counter-intelligence awareness',
      'Critical infrastructure protection',
      'Security culture development',
      'International security cooperation'
    ]
  },
  'PSP50416': {
    name: 'Diploma of Government Investigations',
    domains: [
      'Complex investigation management',
      'Advanced evidence analysis',
      'Legal proceedings and prosecution support',
      'Covert and sensitive investigations',
      'Intelligence analysis',
      'Investigation team management',
      'Cross-agency coordination'
    ]
  },

  // --- CORRECTIONS ---
  'CSC40122': {
    name: 'Certificate IV in Correctional Practice',
    domains: [
      'Offender management and supervision',
      'Security operations in corrections',
      'Behavioural management',
      'Case management and reporting',
      'Emergency response in correctional settings',
      'Legal and ethical responsibilities',
      'Cultural awareness and diversity'
    ]
  },
  'CSC50122': {
    name: 'Diploma of Correctional Administration',
    domains: [
      'Correctional facility management',
      'Advanced offender management',
      'Policy and compliance in corrections',
      'Staff management and development',
      'Risk management in corrections',
      'Rehabilitation program coordination',
      'Stakeholder and community engagement'
    ]
  },

  // --- CYBER SECURITY ---
  '22603VIC': {
    name: 'Certificate IV in Cyber Security',
    domains: [
      'Network security fundamentals',
      'Threat identification and monitoring',
      'Security incident response',
      'Access control and authentication',
      'Security policy and compliance',
      'Risk assessment in ICT',
      'Digital forensics basics'
    ]
  },

  // --- GRADUATE DIPLOMAS ---
  'BSB80120': {
    name: 'Graduate Diploma of Management (Learning)',
    domains: [
      'Organisational learning strategy',
      'Advanced leadership and management',
      'Learning program design and evaluation',
      'Workforce capability development',
      'Strategic planning and governance',
      'Research and evidence-based practice'
    ]
  },
  'BSB80220': {
    name: 'Graduate Diploma of Strategic Leadership',
    domains: [
      'Strategic organisational leadership',
      'Governance and board-level management',
      'Complex stakeholder engagement',
      'Organisational transformation',
      'Executive decision-making',
      'Strategic financial management',
      'Innovation and organisational culture'
    ]
  },
  'BSB80320': {
    name: 'Graduate Diploma of Senior Executive Management',
    domains: [
      'C-suite leadership and governance',
      'Strategic business planning',
      'Executive financial management',
      'Complex change management',
      'Industry and market leadership',
      'Stakeholder and board relations',
      'Organisational sustainability'
    ]
  }
};

// =============================================================================
// ANALYSIS PROMPT BUILDER
// Constructs the Claude prompt for document analysis
// =============================================================================

function buildAnalysisPrompt(qualCode, qualName, domains, audience) {
  const discountNote = audience === 'services'
    ? 'This person is military/emergency services (25% discount applies).'
    : 'This person is from the general public.';

  return `You are an expert RPL (Recognition of Prior Learning) evidence analyst for 3CIR, an Australian RPL provider operating under Asset College (RTO 31718).

TASK: Analyse the uploaded document against the competency domains for ${qualCode} ${qualName}.

COMPETENCY DOMAINS TO ASSESS:
${domains.map((d, i) => `${i + 1}. ${d}`).join('\n')}

${discountNote}

INSTRUCTIONS:
1. Read the entire document carefully
2. For EACH competency domain, assess the evidence level:
   - STRONG: Clear, direct evidence of skills/experience in this area
   - MODERATE: Some evidence or transferable experience
   - WEAK: Minimal or indirect evidence
   - NONE: No evidence found
3. Calculate an overall match percentage (weighted average: STRONG=100%, MODERATE=60%, WEAK=20%, NONE=0%)
4. Identify the top 3 strongest areas
5. Identify the top 3 gaps (weakest areas)
6. Note any particularly impressive evidence or experience
7. Note the person's approximate years of experience if detectable

RESPOND IN THIS EXACT JSON FORMAT (no markdown, no backticks, just raw JSON):
{
  "overallScore": 82,
  "totalDomains": 7,
  "strongCount": 4,
  "moderateCount": 2,
  "weakCount": 1,
  "noneCount": 0,
  "domainResults": [
    {
      "domain": "Team leadership and supervision",
      "rating": "STRONG",
      "evidenceFound": "10 years managing teams of 15-30 personnel in operational environments",
      "specificExamples": ["Led platoon of 30 soldiers", "Managed cross-functional team of 15"]
    }
  ],
  "topStrengths": [
    "Team leadership and supervision — extensive direct leadership experience",
    "Operational planning — demonstrated through multiple deployment planning roles",
    "Risk management — formal training and practical application in high-risk environments"
  ],
  "topGaps": [
    "Budget and resource management — no specific financial management evidence found",
    "Workplace health and safety — limited formal WHS documentation",
    "Performance management — no evidence of formal appraisal processes"
  ],
  "yearsExperience": "approximately 12 years",
  "notableEvidence": "Extensive military leadership experience with formal training in risk assessment and operational planning. Strong candidate.",
  "recommendedAdditionalEvidence": [
    "Position descriptions showing budget responsibility",
    "Any WHS training certificates or induction records",
    "Performance review templates or examples"
  ],
  "overallAssessment": "Strong candidate for RPL. The military background provides excellent evidence for most competency domains. Minor gaps in financial management and formal WHS documentation could be addressed with supplementary evidence."
}

Be thorough but realistic. Do not inflate scores. If the document is a brief resume with limited detail, reflect that honestly — a 1-page resume will naturally score lower than a detailed service record or position description. This analysis will be used by an experienced RPL assessor (Matt) for his personal review, so accuracy matters more than positivity.

Australian English throughout. Use 'recognised' not 'recognized', 'organisation' not 'organization', etc.`;
}

// =============================================================================
// PROSPECT-FACING SUMMARY BUILDER (MEDIUM DETAIL)
// Shows % score + general strengths/gaps without unit-level detail
// =============================================================================

function buildProspectSummary(analysis, qualCode, qualName, audience) {
  const score = analysis.overallScore;
  const strengths = analysis.topStrengths || [];
  const gaps = analysis.topGaps || [];

  // Determine confidence level text
  let confidenceText;
  if (score >= 80) {
    confidenceText = 'Strong candidate — your experience aligns well with this qualification.';
  } else if (score >= 60) {
    confidenceText = 'Good candidate — your experience covers most areas, with some gaps that are common and easy to address.';
  } else if (score >= 40) {
    confidenceText = 'Possible candidate — you have relevant experience in several areas, but may need additional evidence or a gap training conversation.';
  } else {
    confidenceText = 'This qualification may require additional evidence or some gap training. A personal review by our assessor will give you a clear picture.';
  }

  // Format strengths as general areas (no unit codes, no detailed mapping)
  const strengthsList = strengths.map(s => {
    // Extract just the domain name before the dash
    const parts = s.split(' — ');
    return parts[0].trim();
  });

  const gapsList = gaps.map(g => {
    const parts = g.split(' — ');
    return parts[0].trim();
  });

  return {
    score,
    qualCode,
    qualName,
    confidenceText,
    strengths: strengthsList.slice(0, 3),
    gaps: gapsList.slice(0, 3),
    callToAction: score >= 40
      ? 'Submit your free RPL assessment form and Matt will do a thorough personal review within 24–48 hours.'
      : 'We recommend booking a quick chat with Matt to discuss your options — there may be alternative qualifications that are a better fit.'
  };
}

// =============================================================================
// GHL NOTE BUILDER (FULL DETAIL FOR MATT)
// Complete domain-by-domain analysis as a GHL contact note
// =============================================================================

function buildGHLNote(analysis, qualCode, qualName, fileName) {
  const lines = [
    `AI EVIDENCE PRE-SCAN — ${qualCode} ${qualName}`,
    `Document: ${fileName}`,
    `Overall Score: ${analysis.overallScore}%`,
    `Domains: ${analysis.strongCount} Strong, ${analysis.moderateCount} Moderate, ${analysis.weakCount} Weak, ${analysis.noneCount} None`,
    `Experience: ${analysis.yearsExperience || 'Not determined'}`,
    '',
    '--- DOMAIN RESULTS ---'
  ];

  if (analysis.domainResults) {
    for (const dr of analysis.domainResults) {
      lines.push(`[${dr.rating}] ${dr.domain}`);
      if (dr.evidenceFound) lines.push(`  Evidence: ${dr.evidenceFound}`);
      if (dr.specificExamples && dr.specificExamples.length > 0) {
        lines.push(`  Examples: ${dr.specificExamples.join('; ')}`);
      }
    }
  }

  lines.push('');
  lines.push('--- TOP STRENGTHS ---');
  (analysis.topStrengths || []).forEach(s => lines.push(`+ ${s}`));

  lines.push('');
  lines.push('--- GAPS ---');
  (analysis.topGaps || []).forEach(g => lines.push(`- ${g}`));

  lines.push('');
  lines.push('--- RECOMMENDED ADDITIONAL EVIDENCE ---');
  (analysis.recommendedAdditionalEvidence || []).forEach(r => lines.push(`* ${r}`));

  lines.push('');
  lines.push(`--- ASSESSOR NOTES ---`);
  lines.push(analysis.overallAssessment || '');
  lines.push('');
  lines.push(`Notable: ${analysis.notableEvidence || 'None'}`);
  lines.push('');
  lines.push('(Generated by 3CIR AI Evidence Pre-Scanner)');

  return lines.join('\n');
}

// =============================================================================
// MAIN ANALYSIS FUNCTION
// =============================================================================

async function analyseEvidence(fileBuffer, mimeType, fileName, qualCode, audience) {
  // Validate qualification code
  const qualData = EVIDENCE_DOMAINS[qualCode];
  if (!qualData) {
    // If we don't have a specific mapping, use a generic business assessment
    return {
      success: false,
      error: `Qualification ${qualCode} does not have evidence domain mapping configured yet. Matt will assess this manually.`,
      qualCode,
      qualName: qualCode
    };
  }

  const qualName = qualData.name;
  const domains = qualData.domains;

  // Build the analysis prompt
  const analysisPrompt = buildAnalysisPrompt(qualCode, qualName, domains, audience);

  // Prepare the message content based on file type
  const messageContent = [];

  if (mimeType === 'application/pdf') {
    // Send PDF directly as a document
    messageContent.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: fileBuffer.toString('base64')
      }
    });
  } else if (mimeType.startsWith('image/')) {
    // Send images directly
    messageContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType,
        data: fileBuffer.toString('base64')
      }
    });
  } else {
    // For Word docs and other text files, try to extract text
    // We send as a text block — mammoth extraction happens in the caller if needed
    const textContent = fileBuffer.toString('utf-8');
    messageContent.push({
      type: 'text',
      text: `DOCUMENT CONTENT (extracted from ${fileName}):\n\n${textContent}`
    });
  }

  // Add the analysis instruction
  messageContent.push({
    type: 'text',
    text: analysisPrompt
  });

  try {
    console.log(`[Evidence Scanner] Analysing ${fileName} against ${qualCode} ${qualName}`);
    const startTime = Date.now();

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: messageContent
      }]
    });

    const elapsed = Date.now() - startTime;
    console.log(`[Evidence Scanner] Analysis completed in ${elapsed}ms`);

    // Parse the JSON response
    const responseText = response.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('');

    // Clean potential markdown formatting
    const cleanJson = responseText
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    let analysis;
    try {
      analysis = JSON.parse(cleanJson);
    } catch (parseErr) {
      // Try to salvage truncated JSON
      console.error('[Evidence Scanner] JSON parse error, attempting salvage:', parseErr.message);
      const salvaged = salvageJson(cleanJson);
      if (salvaged) {
        analysis = salvaged;
      } else {
        return {
          success: false,
          error: 'Analysis completed but results could not be parsed. Matt will review manually.',
          rawResponse: responseText.substring(0, 500)
        };
      }
    }

    // Build both outputs
    const prospectSummary = buildProspectSummary(analysis, qualCode, qualName, audience);
    const ghlNote = buildGHLNote(analysis, qualCode, qualName, fileName);

    return {
      success: true,
      prospectSummary,
      ghlNote,
      fullAnalysis: analysis,
      qualCode,
      qualName,
      fileName,
      analysisTimeMs: elapsed
    };

  } catch (apiErr) {
    console.error('[Evidence Scanner] Claude API error:', apiErr.message);
    return {
      success: false,
      error: 'The evidence analysis could not be completed right now. Matt will review your document personally.',
      apiError: apiErr.message
    };
  }
}

// =============================================================================
// JSON SALVAGE PARSER (handles truncated responses)
// =============================================================================

function salvageJson(text) {
  try {
    // Try adding closing braces/brackets
    let attempt = text;
    const openBraces = (attempt.match(/{/g) || []).length;
    const closeBraces = (attempt.match(/}/g) || []).length;
    const openBrackets = (attempt.match(/\[/g) || []).length;
    const closeBrackets = (attempt.match(/\]/g) || []).length;

    for (let i = 0; i < openBrackets - closeBrackets; i++) attempt += ']';
    for (let i = 0; i < openBraces - closeBraces; i++) attempt += '}';

    return JSON.parse(attempt);
  } catch {
    return null;
  }
}

// =============================================================================
// WORD DOCUMENT TEXT EXTRACTION (using mammoth if available)
// Falls back to raw buffer toString if mammoth not installed
// =============================================================================

async function extractWordText(fileBuffer) {
  try {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    return result.value;
  } catch {
    // mammoth not installed — return raw text attempt
    console.warn('[Evidence Scanner] mammoth not available for Word extraction, using raw text');
    return fileBuffer.toString('utf-8').replace(/[^\x20-\x7E\n\r\t]/g, ' ');
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  analyseEvidence,
  extractWordText,
  EVIDENCE_DOMAINS,
  buildProspectSummary,
  buildGHLNote
};
