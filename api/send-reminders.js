// api/send-reminders.js
// Vercel Cron — runs daily at 06:00 UTC = 6:00pm NZT (NZST, UTC+12)
// Fetches tomorrow's events from Supabase and sends push notifications

import webpush from 'web-push';

webpush.setVapidDetails(
  'mailto:' + process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SB_KEY,
    'Authorization': 'Bearer ' + SB_KEY
  };

  try {
    const nowUTC = new Date();
    const nztOffset = 12 * 60;
    const nztNow = new Date(nowUTC.getTime() + nztOffset * 60000);
    const tomorrow = new Date(nztNow);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);

    const dataRes = await fetch(`${SB_URL}/rest/v1/hub_data?select=data&limit=1&order=id.asc`, { headers });
    const dataJson = await dataRes.json();

    if (!dataJson || !dataJson.length) {
      return res.status(200).json({ sent: 0, reason: 'No hub data found' });
    }

    const events = (dataJson[0].data?.events?.[tomorrowStr]) || [];
    if (!events.length) {
      return res.status(200).json({ sent: 0, reason: 'No events tomorrow' });
    }

    const eventLines = events.map(e => {
      const timeStr = e.time ? formatTime(e.time) : '';
      return (timeStr ? timeStr + ' · ' : '') + e.text + (e.who ? ` (${e.who})` : '');
    });
    const body = eventLines.length === 1
      ? eventLines[0]
      : `${eventLines.length} events:\n` + eventLines.join('\n');

    const payload = JSON.stringify({ title: '📅 Tomorrow on Family Hub', body, url: '/' });

    const subRes = await fetch(`${SB_URL}/rest/v1/push_subscriptions?select=*`, { headers });
    const subscriptions = await subRes.json();

    if (!subscriptions || !subscriptions.length) {
      return res.status(200).json({ sent: 0, reason: 'No subscribers' });
    }

    let sent = 0, removed = 0;
    for (const row of subscriptions) {
      try {
        await webpush.sendNotification(row.subscription, payload);
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await fetch(`${SB_URL}/rest/v1/push_subscriptions?id=eq.${row.id}`, { method: 'DELETE', headers });
          removed++;
        } else {
          console.error('Push error for sub', row.id, err.message);
        }
      }
    }

    return res.status(200).json({ sent, removed, events: events.length, tomorrow: tomorrowStr });

  } catch (err) {
    console.error('send-reminders error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function formatTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'pm' : 'am';
  return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + ampm;
}
