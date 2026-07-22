// The Hourly: WhatsApp inbound webhook.
//
// Meta's WhatsApp Cloud API calls this for every message sent to The Hourly's
// WhatsApp number. Photos from a linked sender (profiles.whatsapp_phone) are
// downloaded from Meta, stored, and posted into all of that person's groups —
// filed under the moment the message was sent. The sender gets a WhatsApp
// reply confirming (or explaining) what happened.
//
// Deploy from the Supabase dashboard (Edge Functions -> Deploy new function,
// name it exactly `whatsapp-inbound`, paste this file) with JWT verification
// OFF — Meta calls it unauthenticated; security comes from the verify-token
// handshake plus the fact that senders must match a linked phone number.
//
// Required secrets (Edge Functions -> Secrets):
//   WHATSAPP_VERIFY_TOKEN   - any string you invent; pasted into Meta's
//                             webhook config so the handshake succeeds
//   WHATSAPP_ACCESS_TOKEN   - Cloud API access token (System User token)
//   WHATSAPP_PHONE_NUMBER_ID- the "Phone number ID" from Meta's API Setup page

import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

const VERIFY_TOKEN = Deno.env.get('WHATSAPP_VERIFY_TOKEN') ?? '';
const ACCESS_TOKEN = Deno.env.get('WHATSAPP_ACCESS_TOKEN') ?? '';
const PHONE_NUMBER_ID = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') ?? '';
const GRAPH = 'https://graph.facebook.com/v21.0';

async function reply(to: string, body: string): Promise<void> {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) return;
  try {
    await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
  } catch {
    // confirmation is best-effort
  }
}

interface WaMessage {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  image?: { id: string; mime_type?: string };
}

async function handleMessage(msg: WaMessage): Promise<string> {
  // Meta retries webhooks aggressively — dedupe on the message id
  const { error: dupErr } = await supabase.from('wa_processed_messages').insert({ id: msg.id });
  if (dupErr && dupErr.code === '23505') return 'duplicate';
  // any other dedupe failure (e.g. table missing): still process the photo

  const from = String(msg.from || '').replace(/\D/g, '');
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, timezone')
    .eq('whatsapp_phone', from)
    .maybeSingle();
  if (!profile) {
    await reply(msg.from, "This number isn't linked to a Hourly account yet. In the app: Settings → Profile & Display → WhatsApp Number.");
    return 'unlinked sender';
  }

  if (msg.type !== 'image' || !msg.image?.id) {
    await reply(msg.from, 'Send a photo and it will post to your Hourly groups automatically.');
    return 'not a photo';
  }

  // Two-step media fetch: id -> short-lived URL -> bytes (both need the token)
  const metaRes = await fetch(`${GRAPH}/${msg.image.id}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  if (!metaRes.ok) return `media lookup failed: ${metaRes.status}`;
  const media = await metaRes.json();
  const binRes = await fetch(media.url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!binRes.ok) return `media download failed: ${binRes.status}`;
  const bytes = new Uint8Array(await binRes.arrayBuffer());

  const path = `${profile.id}/${crypto.randomUUID()}.jpg`;
  const { error: upErr } = await supabase.storage
    .from('photos')
    .upload(path, bytes, { contentType: msg.image.mime_type || 'image/jpeg' });
  if (upErr) {
    await reply(msg.from, "That photo couldn't be saved — try sending it again.");
    return `storage upload failed: ${upErr.message}`;
  }

  // File it under the moment it was sent (WhatsApp strips EXIF anyway)
  const takenAt = msg.timestamp
    ? new Date(Number(msg.timestamp) * 1000).toISOString()
    : new Date().toISOString();

  const { data: photo, error: phErr } = await supabase
    .from('photos')
    .insert({ profile_id: profile.id, taken_at: takenAt, image_path: path })
    .select('id')
    .single();
  if (phErr || !photo) return `photo insert failed: ${phErr?.message}`;

  const { data: memberships } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('profile_id', profile.id);
  if (memberships && memberships.length > 0) {
    await supabase
      .from('photo_groups')
      .insert(memberships.map((m) => ({ photo_id: photo.id, group_id: m.group_id })));
  } else {
    await reply(msg.from, "Saved — but you're not in any Hourly group yet, so no one can see it. Join a group in the app first.");
    return 'no groups';
  }

  let hourLabel = '';
  try {
    hourLabel = new Date(takenAt).toLocaleTimeString('en-US', {
      hour: 'numeric',
      hour12: true,
      timeZone: profile.timezone || 'UTC',
    });
  } catch {
    hourLabel = new Date(takenAt).toISOString().slice(11, 16);
  }
  await reply(msg.from, `Got it — posted to your Hourly (${hourLabel} slot). 📸`);
  return 'ok';
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Meta's one-time webhook verification handshake
  if (req.method === 'GET') {
    if (
      url.searchParams.get('hub.mode') === 'subscribe' &&
      VERIFY_TOKEN &&
      url.searchParams.get('hub.verify_token') === VERIFY_TOKEN
    ) {
      return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
    }
    return new Response('forbidden', { status: 403 });
  }

  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  let payload: {
    entry?: { changes?: { value?: { messages?: WaMessage[] } }[] }[];
  };
  try {
    payload = await req.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const results: string[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) {
        try {
          results.push(await handleMessage(msg));
        } catch (err) {
          console.error('whatsapp-inbound error:', err);
          results.push('error');
        }
      }
    }
  }

  // Always 200 — Meta disables webhooks that keep failing
  return new Response(results.join(', ') || 'no messages', { status: 200 });
});
