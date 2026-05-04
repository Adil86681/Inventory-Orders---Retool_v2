// api/track.js — KeyDelivery proxy (runs server-side, no CORS issues)
// Uses Node's built-in https module — works on all Node versions (no fetch required)
const crypto = require('crypto');
const https  = require('https');

const API_KEY = process.env.KD_API_KEY;
const SECRET  = process.env.KD_SECRET;

function sign(bodyStr) {
  return crypto.createHash('md5').update(bodyStr + API_KEY + SECRET).digest('hex').toUpperCase();
}

function httpsPost(url, bodyStr, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from upstream: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, ...params } = req.body;

  const URLS = {
    detect: 'https://www.kd100.com/api/v1/carriers/detect',
    track:  'https://www.kd100.com/api/v1/tracking/realtime',
  };

  if (!URLS[action]) {
    return res.status(400).json({ error: 'Invalid action. Use "detect" or "track".' });
  }

  if (!API_KEY || !SECRET) {
    return res.status(500).json({ error: 'Missing KD_API_KEY or KD_SECRET environment variables.' });
  }

  const bodyStr = JSON.stringify(params);

  try {
    const data = await httpsPost(URLS[action], bodyStr, {
      'Content-Type': 'application/json',
      'API-Key': API_KEY,
      'signature': sign(bodyStr),
    });
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Upstream request failed: ' + err.message });
  }
};
