// Vercel serverless function backing /join/<code> invite links.
//
// Chat apps (WhatsApp, iMessage, etc.) build link previews by fetching the
// URL and reading its meta tags — without running JavaScript. So invite
// links route here: this returns HTML whose Open Graph tags name the actual
// group ("Join our Hourly group — Cheesecake"), then immediately forwards
// real visitors into the app's normal ?join= flow.

const SUPABASE_URL = 'https://hnuznphuqpencmrtfrzv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_9DLbFs-iBeRbXkxVfCzqjQ_93FaUCXx';
const APP_URL = 'https://the-hourly.vercel.app';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default async function handler(req: any, res: any) {
  const rawCode = typeof req.query?.code === 'string' ? req.query.code : '';
  const code = rawCode.slice(0, 64);

  let groupName: string | null = null;
  if (code) {
    try {
      // get_group_preview is a SECURITY DEFINER RPC that returns only the
      // group's name for a valid invite code — safe for the anon key.
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_group_preview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ p_code: code }),
      });
      if (r.ok) {
        const data = await r.json();
        if (typeof data === 'string' && data.trim()) groupName = data.trim();
      }
    } catch {
      // fall through to the generic preview
    }
  }

  const title = groupName ? `Join our Hourly group — ${groupName}` : 'Join The Hourly';
  const description = groupName
    ? `You've been invited to "${groupName}" on The Hourly, a synchronized visual journal. Tap to join.`
    : 'A synchronized visual journal. Tap to join.';
  const target = `${APP_URL}/?join=${encodeURIComponent(code)}`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:image" content="${APP_URL}/icon-512.png">
  <meta property="og:url" content="${APP_URL}/join/${encodeURIComponent(code)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="The Hourly">
  <meta name="twitter:card" content="summary">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="0;url=${target}">
</head>
<body style="font-family: Georgia, serif; background: #F9F8F5; color: #1A1A1A; display: grid; place-items: center; height: 100vh; margin: 0;">
  <p><em>Taking you to The Hourly&hellip;</em></p>
  <script>window.location.replace(${JSON.stringify(target)});</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).send(html);
}
