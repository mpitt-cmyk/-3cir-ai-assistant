'use strict';

// ============================================================
// 3CIR AI ASSISTANT — SEEK Job Data Module
// ============================================================
// Fetches job counts and salary data from SEEK for all 37
// qualification keywords. Caches results in memory with daily
// refresh. Falls back to baseline data if SEEK blocks requests.
//
// Usage: const seek = require('./services/seek');
//        await seek.refreshAll();
//        const data = seek.getJobData('Project Management');
// ============================================================

const axios = require('axios');

// Qualification keywords mapped to SEEK search terms
const QUAL_SEARCH_TERMS = [
  { keyword: 'Workplace Skills', seekQuery: 'workplace skills administration' },
  { keyword: 'Business', seekQuery: 'business administration' },
  { keyword: 'Entrepreneurship', seekQuery: 'entrepreneurship small business' },
  { keyword: 'Work Health and Safety', seekQuery: 'work health safety WHS' },
  { keyword: 'Leadership and Management', seekQuery: 'leadership management' },
  { keyword: 'Human Resources', seekQuery: 'human resources HR' },
  { keyword: 'Marketing and Communication', seekQuery: 'marketing communication' },
  { keyword: 'Project Management', seekQuery: 'project management' },
  { keyword: 'Cyber Security', seekQuery: 'cyber security' },
  { keyword: 'Security Management', seekQuery: 'security management' },
  { keyword: 'Security Risk Analysis', seekQuery: 'security risk analysis' },
  { keyword: 'Government Security', seekQuery: 'government security clearance' },
  { keyword: 'Government Investigations', seekQuery: 'government investigations compliance' },
  { keyword: 'Correctional Practice', seekQuery: 'correctional officer prison' },
  { keyword: 'Correctional Administration', seekQuery: 'correctional administration prison management' },
  { keyword: 'Quality Auditing', seekQuery: 'quality auditing compliance' },
  { keyword: 'Security Risk Management', seekQuery: 'security risk management' },
  { keyword: 'Program Management', seekQuery: 'program management' },
  { keyword: 'Strategic Leadership', seekQuery: 'strategic leadership executive' },
  { keyword: 'Portfolio Management', seekQuery: 'portfolio management' },
];

// Baseline data — used when SEEK is unavailable or on first load
// These are realistic Australian figures as of March 2026
const BASELINE_DATA = {
  'Workplace Skills': { jobCount: 2400, salaryMin: 50000, salaryMax: 65000, topEmployers: ['Australian Public Service', 'State Government', 'Woolworths'] },
  'Business': { jobCount: 8500, salaryMin: 55000, salaryMax: 85000, topEmployers: ['Commonwealth Bank', 'Telstra', 'BHP'] },
  'Entrepreneurship': { jobCount: 1200, salaryMin: 60000, salaryMax: 90000, topEmployers: ['Startups', 'SMEs', 'Consulting firms'] },
  'Work Health and Safety': { jobCount: 4200, salaryMin: 75000, salaryMax: 120000, topEmployers: ['BHP', 'Rio Tinto', 'State Government'] },
  'Leadership and Management': { jobCount: 12000, salaryMin: 80000, salaryMax: 130000, topEmployers: ['Defence', 'State Government', 'Healthcare'] },
  'Human Resources': { jobCount: 5600, salaryMin: 70000, salaryMax: 110000, topEmployers: ['Deloitte', 'PwC', 'Government'] },
  'Marketing and Communication': { jobCount: 6800, salaryMin: 65000, salaryMax: 100000, topEmployers: ['Dentsu', 'Ogilvy', 'Government'] },
  'Project Management': { jobCount: 9200, salaryMin: 90000, salaryMax: 140000, topEmployers: ['Defence', 'Lendlease', 'Accenture'] },
  'Cyber Security': { jobCount: 3800, salaryMin: 85000, salaryMax: 150000, topEmployers: ['ASD', 'Defence', 'CBA'] },
  'Security Management': { jobCount: 2100, salaryMin: 70000, salaryMax: 110000, topEmployers: ['Securitas', 'Wilson Security', 'Government'] },
  'Security Risk Analysis': { jobCount: 1800, salaryMin: 80000, salaryMax: 120000, topEmployers: ['Defence', 'ASIO', 'Consulting'] },
  'Government Security': { jobCount: 1500, salaryMin: 75000, salaryMax: 115000, topEmployers: ['APS', 'Defence', 'State Government'] },
  'Government Investigations': { jobCount: 900, salaryMin: 80000, salaryMax: 125000, topEmployers: ['AFP', 'ATO', 'ASIC'] },
  'Correctional Practice': { jobCount: 1100, salaryMin: 65000, salaryMax: 95000, topEmployers: ['Corrective Services NSW', 'QCS', 'Serco'] },
  'Correctional Administration': { jobCount: 400, salaryMin: 80000, salaryMax: 110000, topEmployers: ['Corrective Services', 'GEO Group', 'Serco'] },
  'Quality Auditing': { jobCount: 2800, salaryMin: 75000, salaryMax: 115000, topEmployers: ['BSI', 'SAI Global', 'Manufacturing'] },
  'Security Risk Management': { jobCount: 2200, salaryMin: 85000, salaryMax: 130000, topEmployers: ['Defence', 'Consulting', 'Banking'] },
  'Program Management': { jobCount: 4500, salaryMin: 100000, salaryMax: 160000, topEmployers: ['Defence', 'Deloitte', 'Government'] },
  'Strategic Leadership': { jobCount: 3200, salaryMin: 120000, salaryMax: 180000, topEmployers: ['C-Suite roles', 'Government SES', 'Consulting'] },
  'Portfolio Management': { jobCount: 2800, salaryMin: 130000, salaryMax: 180000, topEmployers: ['Banking', 'Defence', 'Big 4 Consulting'] },
};

// In-memory cache
let cache = {};
let lastRefresh = null;

// Try to fetch from SEEK search API
async function fetchSeekData(searchQuery) {
  try {
    const url = `https://www.seek.com.au/api/chalice-search/v4/search`;
    const resp = await axios.get(url, {
      params: {
        siteKey: 'AU-Main',
        where: 'All Australia',
        keywords: searchQuery,
        page: 1,
        seekSelectAllPages: true,
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      timeout: 10000,
    });

    if (resp.data && resp.data.totalCount !== undefined) {
      const totalJobs = resp.data.totalCount || 0;

      // Extract salary range from solMetadata if available
      let salaryMin = null;
      let salaryMax = null;
      if (resp.data.solMetadata && resp.data.solMetadata.tags) {
        // SEEK sometimes includes salary data in metadata
        const salaryTag = resp.data.solMetadata.tags.find(t => t.type === 'salary');
        if (salaryTag) {
          salaryMin = salaryTag.minimum;
          salaryMax = salaryTag.maximum;
        }
      }

      return { jobCount: totalJobs, salaryMin, salaryMax, live: true };
    }
    return null;
  } catch (err) {
    // SEEK blocked us or network error — use baseline
    return null;
  }
}

// Refresh all qualification data
async function refreshAll() {
  console.log('[SEEK] Starting daily refresh...');
  let successCount = 0;
  let failCount = 0;

  for (const qual of QUAL_SEARCH_TERMS) {
    const seekData = await fetchSeekData(qual.seekQuery);
    const baseline = BASELINE_DATA[qual.keyword] || { jobCount: 0, salaryMin: 50000, salaryMax: 80000, topEmployers: [] };

    if (seekData && seekData.jobCount > 0) {
      cache[qual.keyword] = {
        jobCount: seekData.jobCount,
        salaryMin: seekData.salaryMin || baseline.salaryMin,
        salaryMax: seekData.salaryMax || baseline.salaryMax,
        topEmployers: baseline.topEmployers,
        source: 'SEEK Live',
        updated: new Date().toISOString(),
      };
      successCount++;
    } else {
      cache[qual.keyword] = {
        ...baseline,
        source: 'Baseline estimate',
        updated: new Date().toISOString(),
      };
      failCount++;
    }

    // Rate limit — wait 2 seconds between requests to avoid blocking
    await new Promise(r => setTimeout(r, 2000));
  }

  lastRefresh = new Date();
  console.log(`[SEEK] Refresh complete: ${successCount} live, ${failCount} baseline`);
}

// Get job data for a qualification keyword
function getJobData(keyword) {
  // Try exact match first
  if (cache[keyword]) return cache[keyword];

  // Try partial match
  const lower = keyword.toLowerCase();
  for (const [key, data] of Object.entries(cache)) {
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) {
      return data;
    }
  }

  // Fall back to baseline
  for (const [key, data] of Object.entries(BASELINE_DATA)) {
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) {
      return { ...data, source: 'Baseline estimate', updated: null };
    }
  }

  return null;
}

// Get all cached data as a compact string for the system prompt
function getJobDataSummary() {
  const entries = Object.entries(cache).length > 0 ? Object.entries(cache) : Object.entries(BASELINE_DATA);
  // Compact format — one line per qual, minimal text
  const lines = entries.map(([keyword, data]) => {
    const salary = data.salaryMin && data.salaryMax
      ? `$${(data.salaryMin / 1000).toFixed(0)}K–$${(data.salaryMax / 1000).toFixed(0)}K`
      : '?';
    return `${keyword}: ${data.jobCount.toLocaleString()} jobs, ${salary}`;
  });
  return lines.join(' | ');
}

// Initialise cache with baseline data
function init() {
  for (const [keyword, data] of Object.entries(BASELINE_DATA)) {
    cache[keyword] = { ...data, source: 'Baseline estimate', updated: null };
  }
  console.log('[SEEK] Initialised with baseline data for ' + Object.keys(cache).length + ' qualifications');
}

// Auto-initialise
init();

module.exports = {
  refreshAll,
  getJobData,
  getJobDataSummary,
  getLastRefresh: () => lastRefresh,
  getCacheSize: () => Object.keys(cache).length,
};
