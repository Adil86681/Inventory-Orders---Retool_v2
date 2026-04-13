// Proxies requests to Gmail API
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { access_token } = req.body;

  if (!access_token) {
    return res.status(400).json({ error: 'Missing access_token' });
  }

  try {
    // Get unread messages from the last 7 days
    const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    const query = encodeURIComponent(`is:unread after:${sevenDaysAgo}`);

    const listResp = await fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=15`,
      {
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Accept': 'application/json'
        }
      }
    );

    const listData = await listResp.json();

    if (!listResp.ok) {
      return res.status(listResp.status).json(listData);
    }

    const messages = listData.messages || [];
    const totalUnread = listData.resultSizeEstimate || 0;

    // Fetch details for each message (subject, from, snippet)
    const detailed = [];
    for (const msg of messages.slice(0, 10)) {
      const msgResp = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        {
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'Accept': 'application/json'
          }
        }
      );

      if (msgResp.ok) {
        const msgData = await msgResp.json();
        const headers = msgData.payload?.headers || [];
        const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
        const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
        detailed.push({
          id: msg.id,
          from,
          subject,
          snippet: msgData.snippet || ''
        });
      }
    }

    return res.status(200).json({
      totalUnread,
      messages: detailed
    });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Gmail: ' + err.message });
  }
};
