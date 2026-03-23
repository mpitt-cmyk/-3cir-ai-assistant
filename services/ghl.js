'use strict';

const axios = require('axios');
const GHL_BASE = 'https://rest.gohighlevel.com/v1';

class GHLClient {
  constructor() {
    this.maxRetries = 2;
  }

  // FIX #2: Read API key per-request, not at module load
  _getKey() {
    const key = process.env.GHL_API_KEY;
    if (!key) throw new Error('GHL_API_KEY not set');
    return key;
  }

  // FIX #12: No trailing slashes on endpoints. FIX #17: Retry on 429/5xx
  async _request(method, endpoint, data = null) {
    const url = `${GHL_BASE}${endpoint.replace(/\/+$/, '')}`;
    let lastErr = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const config = {
          method,
          url,
          headers: { 'Authorization': `Bearer ${this._getKey()}`, 'Content-Type': 'application/json' },
          timeout: 15000,
        };
        if (data) config.data = data;
        const resp = await axios(config);
        return { ok: true, data: resp.data };
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        if ((status === 429 || status >= 500) && attempt < this.maxRetries) {
          await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
          continue;
        }
        const msg = err.response?.data ? JSON.stringify(err.response.data).substring(0, 300) : err.message;
        console.error(`[GHL] ${method} ${endpoint} failed: ${status || 'network'} — ${msg}`);
        return { ok: false, status, error: msg };
      }
    }
    return { ok: false, error: lastErr?.message || 'Max retries' };
  }

  // FIX #9: Normalise Australian phone numbers to +61 format
  normalisePhone(phone) {
    if (!phone) return '';
    let p = phone.replace(/[\s\-()]/g, '');
    if (p.startsWith('0')) p = '+61' + p.substring(1);
    else if (p.startsWith('61') && !p.startsWith('+')) p = '+' + p;
    return p;
  }

  // FIX #11: Contact dedup — search by email/phone before creating
  async findContact(email, phone) {
    if (email) {
      const r = await this._request('GET', `/contacts?query=${encodeURIComponent(email)}&locationId=${process.env.GHL_LOCATION_ID}`);
      if (r.ok && r.data.contacts?.length > 0) return r.data.contacts[0];
    }
    if (phone) {
      const norm = this.normalisePhone(phone);
      const r = await this._request('GET', `/contacts?query=${encodeURIComponent(norm)}&locationId=${process.env.GHL_LOCATION_ID}`);
      if (r.ok && r.data.contacts?.length > 0) return r.data.contacts[0];
    }
    return null;
  }

  async upsertContact({ firstName, lastName, email, phone, source, tags = [] }) {
    try {
      const normPhone = this.normalisePhone(phone);
      const existing = await this.findContact(email, normPhone);

      if (existing) {
        // FIX #11: Deduplicate tags before updating
        const allTags = [...new Set([...(existing.tags || []), ...tags])];
        await this._request('PUT', `/contacts/${existing.id}`, { tags: allTags });
        console.log(`[GHL] Updated existing contact: ${existing.id}`);
        return { ok: true, contactId: existing.id, isNew: false };
      }

      const r = await this._request('POST', '/contacts', {
        locationId: process.env.GHL_LOCATION_ID,
        firstName: firstName || '',
        lastName: lastName || '',
        email: email || '',
        phone: normPhone || '',
        source: source || 'AI Chatbot',
        tags,
      });

      if (r.ok) {
        const id = r.data.contact?.id;
        console.log(`[GHL] Created contact: ${id}`);
        return { ok: true, contactId: id, isNew: true };
      }
      return { ok: false, error: r.error };
    } catch (err) {
      console.error(`[GHL] upsertContact error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  // FIX: GHL v1 requires pipeline ID in URL path, not just in body
  // Auto-discovers first stage if GHL_STAGE_NEW_ENQUIRIES not set
  async createOpportunity(contactId, { title, stageId, monetaryValue, source }) {
    try {
      const pipelineId = process.env.GHL_PIPELINE_ID;
      if (!pipelineId) {
        console.error('[GHL] GHL_PIPELINE_ID not set — cannot create opportunity');
        return { ok: false, error: 'Pipeline ID not configured' };
      }

      // Resolve stage ID: explicit > env var > auto-discover first stage
      let resolvedStageId = stageId || process.env.GHL_STAGE_NEW_ENQUIRIES;
      if (!resolvedStageId) {
        // Auto-discover: fetch pipeline stages and use the first one
        if (!this._cachedFirstStageId) {
          const pipeline = await this._request('GET', `/pipelines/${pipelineId}`);
          if (pipeline.ok && pipeline.data?.stages?.length > 0) {
            this._cachedFirstStageId = pipeline.data.stages[0].id;
            console.log(`[GHL] Auto-discovered first stage: ${pipeline.data.stages[0].name} (${this._cachedFirstStageId})`);
          }
        }
        resolvedStageId = this._cachedFirstStageId;
      }

      if (!resolvedStageId) {
        console.error('[GHL] Cannot create opportunity — no stage ID available');
        return { ok: false, error: 'No stage ID available' };
      }

      const r = await this._request('POST', `/pipelines/${pipelineId}/opportunities`, {
        title: title || 'AI Chatbot Lead',
        status: 'open',
        pipelineId: pipelineId,
        pipelineStageId: resolvedStageId,
        locationId: process.env.GHL_LOCATION_ID,
        contactId,
        monetaryValue: monetaryValue || 0,
        source: source || 'AI Chatbot',
      });
      if (r.ok) console.log(`[GHL] Created opportunity for ${contactId}`);
      else console.error(`[GHL] Opportunity creation failed for ${contactId}: ${r.error}`);
      return r;
    } catch (err) {
      console.error(`[GHL] createOpportunity error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  async addNote(contactId, body) {
    return this._request('POST', `/contacts/${contactId}/notes`, { body });
  }

  async addTags(contactId, tags) {
    if (!tags?.length) return { ok: true };
    return this._request('POST', `/contacts/${contactId}/tags`, { tags });
  }
}

module.exports = new GHLClient();
