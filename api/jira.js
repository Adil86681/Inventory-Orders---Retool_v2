module.exports = async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { domain, email, token, path, method, body } = req.body;

  if (!domain || !email || !token || !path) {
    return res.status(400).json({ error: 'Missing required fields: domain, email, token, path' });
  }

  const url = `https://${domain}${path}`;
  const auth = Buffer.from(`${email}:${token}`).toString('base64');

  try {
    const fetchOptions = {
      method: method || 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    };

    if (body && (method === 'POST' || method === 'PUT')) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
    const text = await response.text();

    // Try to parse as JSON, otherwise return the raw text as an error
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(response.status || 502).json({
        error: `Jira returned a non-JSON response (HTTP ${response.status}). This may mean the API path is incorrect for your Jira instance.`,
        raw: text.substring(0, 500)
      });
    }

    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Jira: ' + err.message });
  }
};
