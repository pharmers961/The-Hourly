// Supabase data layer for The Hourly. All reads map database rows into the
// app's existing Photo/User shapes so the UI is agnostic of the backend.
import { supabase, vapidPublicKey } from './supabase';
import { Photo, User as AppUser, PhotoMetadata, UserSettings, Group } from './types';

interface ProfileRow {
  id: string;
  auth_id: string | null;
  email: string;
  name: string;
  timezone: string;
  last_active: string | null;
  settings: UserSettings | Record<string, never>;
  firebase_uid: string | null;
}

interface CommentRow {
  id: string;
  photo_id: string;
  profile_id: string;
  text: string;
  created_at: string;
}

interface ReactionRow {
  photo_id: string;
  profile_id: string;
  emoji: string;
}

interface PhotoRow {
  id: string;
  profile_id: string;
  taken_at: string;
  image_path: string;
  thumb_path: string | null;
  metadata: PhotoMetadata | null;
  firebase_id: string | null;
  comments: CommentRow[];
  reactions: ReactionRow[];
}

interface GroupRow {
  id: string;
  name: string;
  invite_code: string;
}

// Supabase error objects carry more than .message (status, code, hint) but
// their shape differs between the storage client and PostgREST client;
// surface everything present so failures are diagnosable from the toast text
// alone, without needing devtools access.
function describeError(prefix: string, err: unknown, extra = ''): Error {
  if (err && typeof err === 'object') {
    const parts: string[] = [];
    const anyErr = err as Record<string, unknown>;
    if (typeof anyErr.message === 'string') parts.push(anyErr.message);
    if (typeof anyErr.statusCode === 'string' || typeof anyErr.statusCode === 'number') parts.push(`status=${anyErr.statusCode}`);
    if (typeof anyErr.status === 'number') parts.push(`status=${anyErr.status}`);
    if (typeof anyErr.code === 'string') parts.push(`code=${anyErr.code}`);
    if (typeof anyErr.hint === 'string') parts.push(`hint=${anyErr.hint}`);
    if (typeof anyErr.details === 'string') parts.push(`details=${anyErr.details}`);
    if (parts.length > 0) return new Error(`${prefix}: ${parts.join(' | ')}${extra}`);
  }
  return new Error(`${prefix}: ${String(err)}${extra}`);
}

function mapProfileRow(row: ProfileRow): AppUser {
  return {
    id: row.id,
    name: row.name || 'Unknown',
    timezone: row.timezone || 'UTC',
    lastActive: row.last_active || undefined,
    settings: row.settings && Object.keys(row.settings).length > 0 ? (row.settings as UserSettings) : undefined,
  };
}

function mapPhotoRow(ph: PhotoRow, profiles: Record<string, AppUser>): Photo {
  const reactions: Record<string, string[]> = {};
  ph.reactions.forEach(r => {
    (reactions[r.emoji] ||= []).push(r.profile_id);
  });
  return {
    id: ph.id,
    userId: ph.profile_id,
    timestamp: ph.taken_at,
    imageUrl: publicPhotoUrl(ph.image_path),
    imagePath: ph.image_path,
    thumbUrl: ph.thumb_path ? publicPhotoUrl(ph.thumb_path) : undefined,
    metadata: ph.metadata || undefined,
    comments: ph.comments
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(c => ({
        id: c.id,
        userId: c.profile_id,
        userName: profiles[c.profile_id]?.name.split(' ')[0] || 'Unknown',
        text: c.text,
        timestamp: c.created_at,
      })),
    reactions: Object.keys(reactions).length > 0 ? reactions : undefined,
  };
}

export interface AppData {
  profiles: Record<string, AppUser>;
  photos: Photo[];
  memberIds: string[];
}

export function publicPhotoUrl(imagePath: string): string {
  return supabase.storage.from('photos').getPublicUrl(imagePath).data.publicUrl;
}

// ---------------------------------------------------------------------------
// Auth / profile
// ---------------------------------------------------------------------------

export async function ensureProfile(timezone: string, name?: string): Promise<AppUser & { email: string }> {
  const { data, error } = await supabase.rpc('ensure_profile', { p_timezone: timezone, p_name: name || null });
  if (error) throw error;
  const row = data as ProfileRow;
  return { ...mapProfileRow(row), email: row.email };
}

export async function sendMagicLink(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
}

export async function signInWithGoogle(): Promise<void> {
  // On success this navigates the browser away to Google's consent screen;
  // there is nothing to await after that beyond surfacing a setup error
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
}

export async function updateLastActive(profileId: string): Promise<void> {
  await supabase.from('profiles').update({ last_active: new Date().toISOString() }).eq('id', profileId);
}

export async function saveProfileSettings(profileId: string, settings: UserSettings): Promise<void> {
  const { error } = await supabase.from('profiles').update({ settings }).eq('id', profileId);
  if (error) throw error;
}

export async function saveProfileName(profileId: string, name: string): Promise<void> {
  const { error } = await supabase.from('profiles').update({ name }).eq('id', profileId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

interface GroupMembershipRow {
  role: 'owner' | 'member';
  groups: GroupRow | null;
}

export async function fetchMyGroups(profileId: string): Promise<Group[]> {
  const { data, error } = await supabase
    .from('group_members')
    .select('role, groups(id, name, invite_code)')
    .eq('profile_id', profileId);
  if (error) throw error;
  return (data as unknown as GroupMembershipRow[])
    .filter(row => row.groups)
    .map(row => ({ id: row.groups!.id, name: row.groups!.name, inviteCode: row.groups!.invite_code, role: row.role }));
}

export async function createGroup(name: string): Promise<Group> {
  const { data, error } = await supabase.rpc('create_group', { p_name: name });
  if (error) throw error;
  const row = data as GroupRow;
  return { id: row.id, name: row.name, inviteCode: row.invite_code, role: 'owner' };
}

export async function joinGroupByCode(code: string): Promise<Group> {
  const { data, error } = await supabase.rpc('join_group_by_code', { p_code: code });
  if (error) throw error;
  const row = data as GroupRow;
  return { id: row.id, name: row.name, inviteCode: row.invite_code, role: 'member' };
}

export async function renameGroup(groupId: string, name: string): Promise<void> {
  const { error } = await supabase.from('groups').update({ name }).eq('id', groupId);
  if (error) throw error;
}

export async function regenerateInviteCode(groupId: string): Promise<string> {
  const { data, error } = await supabase.rpc('regenerate_invite_code', { p_group_id: groupId });
  if (error) throw error;
  return data as string;
}

// Used both to leave a group yourself and, as an admin, to remove another
// (non-creator) member — the security policy decides which is allowed.
export async function removeGroupMember(groupId: string, profileId: string): Promise<void> {
  const { error } = await supabase.from('group_members').delete().eq('group_id', groupId).eq('profile_id', profileId);
  if (error) throw error;
}

// Creator-only: hand the creator role to another member.
export async function transferOwnership(groupId: string, newOwnerProfileId: string): Promise<void> {
  const { error } = await supabase.rpc('transfer_ownership', { p_group_id: groupId, p_new_owner: newOwnerProfileId });
  if (error) throw error;
}

// Retroactively shares the caller's own photos from sourceGroupId into
// targetGroupId. Returns how many photos were newly linked.
export async function importMyPhotos(sourceGroupId: string, targetGroupId: string): Promise<number> {
  const { data, error } = await supabase.rpc('import_my_photos', { p_source_group_id: sourceGroupId, p_target_group_id: targetGroupId });
  if (error) throw describeError('import failed', error);
  return (data as number) || 0;
}

export async function deleteGroup(groupId: string): Promise<void> {
  const { error } = await supabase.from('groups').delete().eq('id', groupId);
  if (error) throw error;
}

export async function fetchGroupMemberRoles(groupId: string): Promise<{ profileId: string; role: 'owner' | 'member' }[]> {
  const { data, error } = await supabase.from('group_members').select('profile_id, role').eq('group_id', groupId);
  if (error) throw error;
  return (data || []).map(r => ({ profileId: r.profile_id as string, role: r.role as 'owner' | 'member' }));
}

// Cheap, indexed check independent of any group's photo list — used to
// decide whether the capture button should be enabled this hour, which is a
// global (not per-group) state: one capture, shared to chosen groups.
export async function hasCapturedThisHour(profileId: string, hourStartIso: string): Promise<boolean> {
  const { data, error } = await supabase.from('photos').select('id').eq('profile_id', profileId).gte('taken_at', hourStartIso).limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}

// ---------------------------------------------------------------------------
// Photos, comments, reactions (scoped to one group at a time)
// ---------------------------------------------------------------------------

interface GroupMemberProfileRow {
  profiles: ProfileRow | null;
}

interface PhotoGroupRow {
  photos: PhotoRow | null;
}

export async function fetchGroupData(groupId: string): Promise<AppData> {
  const [membersRes, photoLinksRes] = await Promise.all([
    supabase.from('group_members').select('profiles(*)').eq('group_id', groupId),
    supabase.from('photo_groups').select('photos(*, comments(*), reactions(*))').eq('group_id', groupId),
  ]);
  if (membersRes.error) throw describeError('fetch members failed', membersRes.error);
  if (photoLinksRes.error) throw describeError('fetch photos failed', photoLinksRes.error);

  const profiles: Record<string, AppUser> = {};
  const memberIds: string[] = [];
  (membersRes.data as unknown as GroupMemberProfileRow[]).forEach(row => {
    if (row.profiles) {
      profiles[row.profiles.id] = mapProfileRow(row.profiles);
      memberIds.push(row.profiles.id);
    }
  });

  const photoRows = (photoLinksRes.data as unknown as PhotoGroupRow[])
    .filter(row => row.photos)
    .map(row => row.photos!);

  // Photo/comment authors who have since left the group won't be in the
  // members lookup above — fetch those separately so their names still
  // resolve when browsing history
  const neededIds = new Set<string>();
  photoRows.forEach(p => {
    neededIds.add(p.profile_id);
    p.comments.forEach(c => neededIds.add(c.profile_id));
  });
  const missingIds = [...neededIds].filter(id => !profiles[id]);
  if (missingIds.length > 0) {
    const { data: extra, error } = await supabase.from('profiles').select('*').in('id', missingIds);
    if (error) throw describeError('fetch departed members failed', error);
    (extra as ProfileRow[] || []).forEach(p => { profiles[p.id] = mapProfileRow(p); });
  }

  const photos: Photo[] = photoRows
    .map(row => mapPhotoRow(row, profiles))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return { profiles, photos, memberIds };
}

// A retried queued upload re-sends the same storage path; "already there"
// means the previous attempt got that far, which is success for this step.
function isDuplicateUpload(err: unknown): boolean {
  const anyErr = err as { statusCode?: string | number; message?: string } | null;
  return anyErr?.statusCode === 409 || anyErr?.statusCode === '409' || /already exists|duplicate/i.test(anyErr?.message || '');
}

export async function uploadPhotoToGroups(
  profileId: string,
  imageBlob: Blob,
  thumbBlob: Blob | null,
  metadata: PhotoMetadata,
  groupIds: string[],
  // takenAt: backfills the original capture time for offline-queued uploads.
  // baseName: stable storage name so a retried queued upload doesn't orphan a
  // file per attempt.
  opts?: { takenAt?: string; baseName?: string }
): Promise<void> {
  if (groupIds.length === 0) throw new Error('Select at least one group to share this to.');

  const baseName = opts?.baseName || crypto.randomUUID();
  const path = `${profileId}/${baseName}.jpg`;
  const { error: uploadError } = await supabase.storage.from('photos').upload(path, imageBlob, {
    contentType: 'image/jpeg',
  });
  if (uploadError && !isDuplicateUpload(uploadError)) throw describeError('storage upload failed', uploadError);

  // Thumbnail is best-effort: the matrix falls back to the full image when
  // absent, so a thumb failure should never block the capture.
  let thumbPath: string | null = null;
  if (thumbBlob) {
    const candidate = `${profileId}/${baseName}_t.jpg`;
    const { error: thumbError } = await supabase.storage.from('photos').upload(candidate, thumbBlob, {
      contentType: 'image/jpeg',
    });
    if (!thumbError || isDuplicateUpload(thumbError)) thumbPath = candidate;
    else console.warn('Thumbnail upload failed:', thumbError);
  }

  // Insert + group-share happen server-side (create_photo RPC), which resolves
  // the profile from the session rather than trusting a client-passed id, and
  // bypasses RLS — so this can't fail with a photos RLS violation.
  const baseParams = {
    p_image_path: path,
    p_metadata: metadata,
    p_group_ids: groupIds,
    p_thumb_path: thumbPath,
  };
  const { error } = await supabase.rpc(
    'create_photo',
    opts?.takenAt ? { ...baseParams, p_taken_at: opts.takenAt } : baseParams
  );
  if (error) {
    // Database not yet updated with the p_taken_at parameter: deliver the
    // photo anyway at upload time rather than failing the queued capture.
    if (opts?.takenAt && (error.code === 'PGRST202' || /p_taken_at/.test(error.message || ''))) {
      const { error: retryError } = await supabase.rpc('create_photo', baseParams);
      if (retryError) throw describeError('photo insert failed', retryError);
      return;
    }
    throw describeError('photo insert failed', error);
  }
}

// Whether this person has ever posted a photo at all — drives the first-run
// onboarding prompt for freshly joined members.
export async function hasEverCaptured(profileId: string): Promise<boolean> {
  const { data, error } = await supabase.from('photos').select('id').eq('profile_id', profileId).limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}

export async function addComment(photoId: string, profileId: string, text: string): Promise<void> {
  const { error } = await supabase.from('comments').insert({ photo_id: photoId, profile_id: profileId, text });
  if (error) throw error;
}

export async function deleteComment(commentId: string): Promise<void> {
  const { error } = await supabase.from('comments').delete().eq('id', commentId);
  if (error) throw error;
}

export async function setReaction(photoId: string, profileId: string, emoji: string, on: boolean): Promise<void> {
  if (on) {
    const { error } = await supabase.from('reactions').upsert(
      { photo_id: photoId, profile_id: profileId, emoji },
      { onConflict: 'photo_id,profile_id,emoji', ignoreDuplicates: true }
    );
    if (error) throw error;
  } else {
    const { error } = await supabase.from('reactions').delete()
      .eq('photo_id', photoId).eq('profile_id', profileId).eq('emoji', emoji);
    if (error) throw error;
  }
}

export async function sendNudges(fromProfileId: string, toProfileIds: string[], hourKey: string): Promise<void> {
  if (toProfileIds.length === 0) return;
  const { error } = await supabase.from('nudges').insert(
    toProfileIds.map(to => ({ from_profile_id: fromProfileId, to_profile_id: to, hour_key: hourKey }))
  );
  if (error) throw error;
}

export async function sendNotifications(
  rows: { toProfileId: string; fromName: string; photoId: string; text: string; type: 'comment' | 'mention' | 'like' }[]
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase.from('notifications').insert(
    rows.map(r => ({ to_profile_id: r.toProfileId, from_name: r.fromName, photo_id: r.photoId, text: r.text, type: r.type }))
  );
  if (error) throw error;
}

export async function deleteAccount(profileId: string): Promise<void> {
  // Best-effort removal of image files, fetched fresh (not from whatever
  // group happens to be selected in the UI) so cleanup covers every group.
  // Storage ownership may block files uploaded by the migration; orphaned
  // files are harmless either way.
  try {
    const { data } = await supabase.from('photos').select('image_path, thumb_path').eq('profile_id', profileId);
    const paths = (data || []).flatMap(r => [r.image_path as string, r.thumb_path as string | null]).filter((p): p is string => !!p);
    if (paths.length > 0) {
      await supabase.storage.from('photos').remove(paths).then(() => undefined, () => undefined);
    }
  } catch (err) {
    console.warn('Failed to list photos for cleanup:', err);
  }
  // Deleting the profile cascades to photos, comments, reactions, nudges,
  // notifications, and group memberships. Note: if this profile was the sole
  // owner of a group with other members, that group is left ownerless (no
  // one can rename it, regenerate its invite link, or delete it) — a rare
  // edge case not handled automatically.
  const { error } = await supabase.from('profiles').delete().eq('id', profileId);
  if (error) throw error;
  await supabase.auth.signOut();
}

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Subscribes this browser/device to Web Push and records the subscription so
// the send-push Edge Function can reach it. Safe to call repeatedly (the
// endpoint upserts); quietly no-ops where push isn't available (e.g. an
// iPhone browser tab that hasn't been added to the home screen).
export async function registerPushSubscription(profileId: string): Promise<void> {
  if (!vapidPublicKey || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
    const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;
    await supabase.from('push_subscriptions').upsert(
      { profile_id: profileId, endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth },
      { onConflict: 'endpoint' }
    );
  } catch (err) {
    // Not fatal: in-app notifications still work without a push subscription
    console.warn('Push subscription failed:', err);
  }
}

// Nudges/notifications are delivered by push (app closed) or realtime (app
// open); either way, rows that have been sitting since before this session
// started have already served their purpose — clear them.
export async function clearMyPendingPings(profileId: string): Promise<void> {
  await supabase.from('nudges').delete().eq('to_profile_id', profileId).then(() => undefined, () => undefined);
  await supabase.from('notifications').delete().eq('to_profile_id', profileId).then(() => undefined, () => undefined);
}

export interface RealtimeHandlers {
  onDataChange: () => void;
  onGroupsChange: () => void;
  onNudge: (fromProfileId: string) => void;
  onNotification: (n: { from_name: string; text: string | null; type: string }) => void;
}

export function subscribeRealtime(profileId: string, handlers: RealtimeHandlers): () => void {
  const channel = supabase
    .channel('the-hourly')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'photos' }, handlers.onDataChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'photo_groups' }, handlers.onDataChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, handlers.onDataChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, handlers.onDataChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, handlers.onDataChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'groups' }, handlers.onGroupsChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'group_members' }, handlers.onGroupsChange)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'nudges', filter: `to_profile_id=eq.${profileId}` },
      (payload) => {
        const row = payload.new as { id: string; from_profile_id: string };
        handlers.onNudge(row.from_profile_id);
        // Nudges are transient pings: delete after delivery
        void supabase.from('nudges').delete().eq('id', row.id).then(() => undefined, () => undefined);
      }
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications', filter: `to_profile_id=eq.${profileId}` },
      (payload) => {
        const row = payload.new as { id: string; from_name: string; text: string | null; type: string };
        handlers.onNotification(row);
        void supabase.from('notifications').delete().eq('id', row.id).then(() => undefined, () => undefined);
      }
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

