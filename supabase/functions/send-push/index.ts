// The Hourly: send-push Edge Function.
//
// Called by database triggers whenever a row lands in `nudges` or
// `notifications`. Looks up the recipient's push subscriptions and delivers a
// Web Push to each of their devices — this is what reaches a phone with the
// app closed.
//
// Deploy from the Supabase dashboard (Edge Functions -> Deploy a new function,
// name it exactly `send-push`, paste this file) with JWT verification turned
// OFF — the triggers call it without a user token. Security holds anyway:
// the payload is never trusted, only the row id is taken from it and the row
// is re-fetched server-side, so a forged call can at worst re-announce a real
// row it would need an unguessable UUID to name.
//
// Required secret (Edge Functions -> Secrets): VAPID_PRIVATE_KEY

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const VAPID_PUBLIC_KEY = 'BEf8PMYqrBti4hXR0lGAj5A1o1VoZo2PTAh5P0QBQgzSu8Wn-4zO79QkY0WGL_vPSomijpkndxJ8X5X2oCOMdDk';
const VAPID_SUBJECT = 'mailto:akram.aboukhalil@gmail.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, Deno.env.get('VAPID_PRIVATE_KEY') ?? '');

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

Deno.serve(async (req) => {
  let payload: { table?: string; record?: { id?: string } };
  try {
    payload = await req.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const table = payload.table;
  const rowId = payload.record?.id;
  if (!rowId || (table !== 'nudges' && table !== 'notifications')) {
    return new Response('ignored', { status: 200 });
  }

  let toProfileId: string;
  let title: string;
  let body: string;
  let tag: string;

  if (table === 'nudges') {
    const { data: row } = await supabase
      .from('nudges')
      .select('to_profile_id, from_profile_id')
      .eq('id', rowId)
      .maybeSingle();
    // Row already gone => the recipient's open app consumed it via realtime;
    // no push needed. Also covers forged ids.
    if (!row) return new Response('no row', { status: 200 });
    const { data: sender } = await supabase
      .from('profiles')
      .select('name')
      .eq('id', row.from_profile_id)
      .maybeSingle();
    toProfileId = row.to_profile_id;
    title = 'The Hourly: Nudge!';
    body = `${sender?.name?.split(' ')[0] || 'Someone'} nudged you to capture your moment!`;
    tag = 'nudge';
  } else {
    const { data: row } = await supabase
      .from('notifications')
      .select('to_profile_id, from_name, text, type')
      .eq('id', rowId)
      .maybeSingle();
    if (!row) return new Response('no row', { status: 200 });
    toProfileId = row.to_profile_id;
    title = 'The Hourly';
    if (row.type === 'like') {
      body = `${row.from_name} reacted ${row.text || '❤️'} to your photo`;
      tag = 'like';
    } else {
      body =
        row.type === 'mention'
          ? `${row.from_name} mentioned you: ${row.text || ''}`
          : `${row.from_name} commented on your photo: ${row.text || ''}`;
      tag = 'comment';
    }
  }

  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('profile_id', toProfileId);

  if (!subs || subs.length === 0) return new Response('no subscriptions', { status: 200 });

  const message = JSON.stringify({ title, body, tag, url: '/' });
  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        message
      )
    )
  );

  // Prune subscriptions the push service says are dead (uninstalled /
  // permission revoked), so we stop sending to them.
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const statusCode = r.status === 'rejected' ? (r.reason as { statusCode?: number })?.statusCode : undefined;
    if (statusCode === 404 || statusCode === 410) {
      await supabase.from('push_subscriptions').delete().eq('endpoint', subs[i].endpoint);
    }
  }

  const sent = results.filter((r) => r.status === 'fulfilled').length;
  return new Response(`sent ${sent}/${subs.length}`, { status: 200 });
});
