// The Hourly: report-alert Edge Function.
//
// Called by the photo_reports_alert database trigger whenever someone reports a
// photo. It re-fetches the report server-side (the payload is untrusted — only
// the row id is taken from it) and notifies every admin, by:
//   1. Web Push to each admin device (reuses the same VAPID keys as send-push).
//   2. Email, via Resend, if a RESEND_API_KEY secret is set.
//
// Deploy from the Supabase dashboard (Edge Functions -> Deploy a new function,
// name it exactly `report-alert`, paste this file) with JWT verification turned
// OFF — the trigger calls it without a user token.
//
// Secrets (Edge Functions -> Secrets):
//   VAPID_PRIVATE_KEY   (required for push — same value as send-push uses)
//   RESEND_API_KEY      (optional — enables email; without it, only push is sent)
//   REPORT_ALERT_FROM   (optional — email "from"; defaults to Resend's sandbox)
//   APP_URL             (optional — used to deep-link the admin view in the email)

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const VAPID_PUBLIC_KEY = 'BEf8PMYqrBti4hXR0lGAj5A1o1VoZo2PTAh5P0QBQgzSu8Wn-4zO79QkY0WGL_vPSomijpkndxJ8X5X2oCOMdDk';
const VAPID_SUBJECT = 'mailto:akram.aboukhalil@gmail.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, Deno.env.get('VAPID_PRIVATE_KEY') ?? '');

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

const APP_URL = Deno.env.get('APP_URL') ?? 'https://the-hourly.vercel.app';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendEmail(to: string[], subject: string, html: string): Promise<void> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey || to.length === 0) return;
  const from = Deno.env.get('REPORT_ALERT_FROM') ?? 'The Hourly <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!res.ok) console.error('Resend error:', res.status, await res.text());
  } catch (err) {
    console.error('Email send failed:', err);
  }
}

Deno.serve(async (req) => {
  let payload: { record?: { id?: string } };
  try {
    payload = await req.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const reportId = payload.record?.id;
  if (!reportId) return new Response('ignored', { status: 200 });

  // Re-fetch the report from its id — never trust the payload beyond the id.
  const { data: report } = await supabase
    .from('photo_reports')
    .select('id, reason, created_at, photo_id, reporter_profile_id')
    .eq('id', reportId)
    .maybeSingle();
  if (!report) return new Response('no row', { status: 200 });

  const { data: photo } = await supabase
    .from('photos')
    .select('profile_id, taken_at')
    .eq('id', report.photo_id)
    .maybeSingle();

  const [{ data: reporter }, { data: uploader }] = await Promise.all([
    supabase.from('profiles').select('name').eq('id', report.reporter_profile_id).maybeSingle(),
    photo
      ? supabase.from('profiles').select('name').eq('id', photo.profile_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const reporterName = reporter?.name ?? 'Someone';
  const uploaderName = uploader?.name ?? 'a member';

  // Every admin.
  const { data: admins } = await supabase
    .from('profiles')
    .select('id, email')
    .eq('is_admin', true);
  if (!admins || admins.length === 0) return new Response('no admins', { status: 200 });

  const adminIds = admins.map((a) => a.id);
  const adminEmails = admins.map((a) => a.email).filter((e): e is string => !!e);

  // --- Push to every admin device ---
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .in('profile_id', adminIds);

  const message = JSON.stringify({
    title: 'The Hourly: Photo reported',
    body: `${reporterName} reported ${uploaderName}'s photo — ${report.reason}`,
    tag: `report-${report.id}`,
    url: '/?admin=1',
  });

  let pushed = 0;
  if (subs && subs.length > 0) {
    const results = await Promise.allSettled(
      subs.map((s) =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          message
        )
      )
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const statusCode = r.status === 'rejected' ? (r.reason as { statusCode?: number })?.statusCode : undefined;
      if (statusCode === 404 || statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', subs[i].endpoint);
      }
    }
    pushed = results.filter((r) => r.status === 'fulfilled').length;
  }

  // --- Email every admin ---
  const takenAt = photo?.taken_at ? new Date(photo.taken_at).toLocaleString() : 'unknown time';
  const html = `
    <div style="font-family: Georgia, serif; color: #1A1A1A; line-height: 1.6;">
      <h2 style="font-style: italic; font-weight: normal;">A photo was reported</h2>
      <p><strong>${escapeHtml(reporterName)}</strong> reported a photo by
         <strong>${escapeHtml(uploaderName)}</strong>.</p>
      <p><strong>Reason:</strong> ${escapeHtml(report.reason)}</p>
      <p><strong>Photo taken:</strong> ${escapeHtml(takenAt)}</p>
      <p style="margin-top: 24px;">
        <a href="${APP_URL}/?admin=1"
           style="background: #1A1A1A; color: #F9F8F5; padding: 12px 20px;
                  text-decoration: none; font-family: sans-serif; font-size: 12px;
                  letter-spacing: 0.1em; text-transform: uppercase;">
          Open admin to review
        </a>
      </p>
    </div>`;
  await sendEmail(adminEmails, `The Hourly: photo reported (${report.reason})`, html);

  return new Response(`notified ${admins.length} admin(s); pushed ${pushed}`, { status: 200 });
});
