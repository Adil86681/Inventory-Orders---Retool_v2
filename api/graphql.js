/**
 * Vercel Serverless Function — GraphQL Proxy
 *
 * Handles OAuth2 token management and proxies requests
 * to the Firstbase GraphQL API.
 *
 * POST /api/graphql  →  forwards to https://api.firstbasehq.com/graphql
 */

const fetch = require('node-fetch');

const AUTH_URL     = 'https://auth.firstbasehq.com/oauth2/default/v1/token';
const GRAPHQL_URL  = 'https://api.firstbasehq.com/graphql';
const CLIENT_ID    = process.env.FB_CLIENT_ID    || '0oau04j3bsve6vpjw5d7';
const CLIENT_SECRET = process.env.FB_CLIENT_SECRET || 'MiwE0mSx9MiCDT5sc9NRCfKM2svJ0dgGYQljA77dxd5CneM-JzfH_OKW6oP3fMGI';
const BASIC_AUTH   = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

// ─── Token Cache (persists across warm invocations) ─────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - 300000) {
    return cachedToken;
  }

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${BASIC_AUTH}`
    },
    body: 'grant_type=client_credentials&scope=firstbase:m2m:read-only'
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Token fetch failed: ' + JSON.stringify(data));
  }

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  return cachedToken;
}

// ─── Handler ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS headers for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const token = await getToken();

    const gqlRes = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const data = await gqlRes.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('[GraphQL Proxy Error]', err.message);
    return res.status(502).json({ errors: [{ message: err.message }] });
  }
};
