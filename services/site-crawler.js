'use strict';

// ============================================================
// 3CIR SITE CRAWLER — Firecrawl-powered pricing & promo cache
// ============================================================
// Crawls 3cir.com services pages to extract:
//   - Current qualification pricing (including any sale prices)
//   - Active promotional banners or discount offers
//   - Key page content the chatbot references
//
// Data is cached in cached-site-data.json and refreshed:
//   - On server startup (non-blocking)
//   - Once daily via scheduled interval
//   - On demand via POST /refresh-cache
//
// Required env var: FIRECRAWL_API_KEY
// ============================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'cached-site-data.json');
const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1';

// Pages to crawl — ordered by priority
const CRAWL_PAGES = [
  { url: 'https://www.3cir.com/services/', label: 'services-home' },
  { url: 'https://www.3cir.com/', label: 'homepage' },
];

let cachedData = null;
let lastCrawl = null;
let isRefreshing = false;

// ============================================================
// CACHE LOAD — read from disk on module init
// ============================================================
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      cachedData = JSON.parse(raw);
      lastCrawl = cachedData.crawledAt ? new Date(cachedData.crawledAt) : null;
      console.log(`[Crawler] Cache loaded (crawled: ${lastCrawl ? lastCrawl.toLocaleString('en-AU') : 'unknown'})`);
    }
  } catch (err) {
    console.log('[Crawler] No existing cache file — will populate on first refresh');
  }
}

// ============================================================
// FIRECRAWL SCRAPE — single page via API
// ============================================================
async function scrapeWithFirecrawl(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await axios.post(`${FIRECRAWL_BASE}/scrape`, {
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      excludeTags: ['nav', 'footer', 'script', 'style', 'head'],
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    if (resp.data?.success && resp.data?.data?.markdown) {
      return resp.data.data.markdown;
    }
    console.log(`[Crawler] Firecrawl returned no markdown for ${url}: ${JSON.stringify(resp.data?.error || resp.data?.warning || '').substring(0, 100)}`);
    return null;
  } catch (err) {
    console.error(`[Crawler] Firecrawl error for ${url}: ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}

// ============================================================
// CONTENT ANALYSIS — extract pricing and promo signals
// ============================================================
function analyseContent(markdown, label) {
  if (!markdown) return { hasSale: false, promotions: [], prices: [], contentLength: 0 };

  const result = {
    hasSale: false,
    promotions: [],
    prices: [],
    contentLength: markdown.length,
  };

  const lower = markdown.toLowerCase();

  // Detect sale or promotional language
  const saleKeywords = ['sale', 'limited time', 'special offer', 'discount', 'save ', 'now only', 'was $', '% off', 'promo', 'reduced', 'flash sale', 'earlybird', 'early bird'];
  for (const kw of saleKeywords) {
    if (lower.includes(kw)) {
      result.hasSale = true;
      // Extract surrounding sentence for context
      const idx = lower.indexOf(kw);
      const start = Math.max(0, idx - 60);
      const end = Math.min(markdown.length, idx + 120);
      const snippet = markdown.substring(start, end).replace(/\n+/g, ' ').trim();
      if (snippet && !result.promotions.some(p => p.includes(kw))) {
        result.promotions.push(snippet);
      }
    }
  }

  // Extract all dollar price mentions
  const priceMatches = markdown.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
  result.prices = [...new Set(priceMatches)].slice(0, 30);

  return result;
}

// ============================================================
// MAIN REFRESH — crawl all pages and update cache
// ============================================================
async function refresh() {
  if (isRefreshing) {
    console.log('[Crawler] Refresh already in progress — skipping');
    return cachedData;
  }

  if (!process.env.FIRECRAWL_API_KEY) {
    console.log('[Crawler] FIRECRAWL_API_KEY not set — skipping crawl');
    return buildFallbackCache();
  }

  isRefreshing = true;
  console.log('[Crawler] Starting site crawl...');

  const result = {
    crawledAt: new Date().toISOString(),
    crawledDate: new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }),
    pages: {},
    hasActiveSale: false,
    allPromotions: [],
    summary: '',
  };

  for (const page of CRAWL_PAGES) {
    const markdown = await scrapeWithFirecrawl(page.url);
    const analysis = analyseContent(markdown, page.label);

    result.pages[page.label] = {
      url: page.url,
      ...analysis,
      crawledAt: new Date().toISOString(),
    };

    if (analysis.hasSale) {
      result.hasActiveSale = true;
      result.allPromotions.push(...analysis.promotions);
    }

    console.log(`[Crawler] ${page.url}: ${analysis.contentLength} chars, sale=${analysis.hasSale}, prices found=${analysis.prices.length}`);
  }

  // Deduplicate promotions
  result.allPromotions = [...new Set(result.allPromotions)].slice(0, 5);

  // Build summary for system prompt injection
  if (result.hasActiveSale && result.allPromotions.length > 0) {
    result.summary = `ACTIVE PROMOTIONS ON 3CIR.COM (as of ${result.crawledDate}):\n${result.allPromotions.join('\n')}\nMention these promotions when discussing pricing — they are live on the website right now.`;
  } else {
    result.summary = `Pricing confirmed current as of ${result.crawledDate}. No active sale promotions detected on 3cir.com. Standard pricing applies as listed below.`;
  }

  // Write to cache file
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2), 'utf8');
    console.log(`[Crawler] Cache saved — hasActiveSale=${result.hasActiveSale}`);
  } catch (err) {
    console.error(`[Crawler] Failed to save cache file: ${err.message}`);
  }

  cachedData = result;
  lastCrawl = new Date();
  isRefreshing = false;
  return result;
}

function buildFallbackCache() {
  const date = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  return {
    crawledAt: new Date().toISOString(),
    crawledDate: date,
    hasActiveSale: false,
    allPromotions: [],
    summary: `Standard pricing applies. Check 3cir.com for current offers.`,
  };
}

// ============================================================
// EXPORTS
// ============================================================
function getSummary() {
  if (!cachedData) return '';
  return cachedData.summary || '';
}

function getLastCrawl() {
  return lastCrawl;
}

function getCachedData() {
  return cachedData;
}

function hasActiveSale() {
  return cachedData?.hasActiveSale || false;
}

// Load from disk immediately on require
loadCache();

module.exports = {
  refresh,
  getSummary,
  getLastCrawl,
  getCachedData,
  hasActiveSale,
};
