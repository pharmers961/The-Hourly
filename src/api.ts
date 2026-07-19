// Supabase data layer for The Hourly. All reads map database rows into the
// app's existing Photo/User shapes so the UI is agnostic of the backend.
import { supabase, createAdminClient } from './supabase';
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
  profiles: { name: string } | null; // embedded so it resolves even if the commenter isn't in the currently viewed group
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
  metadata: PhotoMetadata | null;
  firebase_id: string | null;
  author: ProfileRow | null; // embedded so departed members' names still resolve in history
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
function describeError(prefix: string, err: unknown): Error {
  if (err && typeof err === 'object') {
    const parts: string[] = [];
    const anyErr = err as Record<string, unknown>;
    if (typeof anyErr.message === 'string') parts.push(anyErr.message);
    if (typeof anyErr.statusCode === 'string' || typeof anyErr.statusCode === 'number') parts.push(`status=${anyErr.statusCode}`);
    if (typeof anyErr.status === 'number') parts.push(`status=${anyErr.status}`);
    if (typeof anyErr.code === 'string') parts.push(`code=${anyErr.code}`);
    if (typeof anyErr.hint === 'string') parts.push(`hint=${anyErr.hint}`);
    if (typeof anyErr.details === 'string') parts.push(`details=${anyErr.details}`);
    if (parts.length > 0) return new Error(`${prefix}: ${parts.join(' | ')}`);
  }
  return new Error(`${prefix}: ${String(err)}`);
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

function mapPhotoRow(ph: PhotoRow): Photo {
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
    metadata: ph.metadata || undefined,
    comments: ph.comments
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(c => ({
        id: c.id,
        userId: c.profile_id,
        userName: c.profiles?.name.split(' ')[0] || 'Unknown',
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

// Used both to leave a group yourself and, if you're the owner, to remove
// someone else — the security policy decides which is allowed.
export async function removeGroupMember(groupId: string, profileId: string): Promise<void> {
  const { error } = await supabase.from('group_members').delete().eq('group_id', groupId).eq('profile_id', profileId);
  if (error) throw error;
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
    supabase.from('photo_groups').select('photos(*, author:profiles(*), comments(*, profiles(name)), reactions(*))').eq('group_id', groupId),
  ]);
  if (membersRes.error) throw membersRes.error;
  if (photoLinksRes.error) throw photoLinksRes.error;

  const profiles: Record<string, AppUser> = {};
  const memberIds: string[] = [];
  (membersRes.data as unknown as GroupMemberProfileRow[]).forEach(row => {
    if (row.profiles) {
      profiles[row.profiles.id] = mapProfileRow(row.profiles);
      memberIds.push(row.profiles.id);
    }
  });

  const photos: Photo[] = (photoLinksRes.data as unknown as PhotoGroupRow[])
    .filter(row => row.photos)
    .map(row => {
      // A photo's author may have left the group — keep their profile around
      // so their name still shows when browsing history
      if (row.photos!.author && !profiles[row.photos!.author.id]) {
        profiles[row.photos!.author.id] = mapProfileRow(row.photos!.author);
      }
      return mapPhotoRow(row.photos!);
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return { profiles, photos, memberIds };
}

export async function uploadPhotoToGroups(profileId: string, imageBlob: Blob, metadata: PhotoMetadata, groupIds: string[]): Promise<void> {
  if (groupIds.length === 0) throw new Error('Select at least one group to share this to.');

  const path = `${profileId}/${crypto.randomUUID()}.jpg`;
  const { error: uploadError } = await supabase.storage.from('photos').upload(path, imageBlob, {
    contentType: 'image/jpeg',
  });
  if (uploadError) throw describeError('storage upload failed', uploadError);

  const { data: photoRow, error: insertError } = await supabase
    .from('photos')
    .insert({ profile_id: profileId, taken_at: new Date().toISOString(), image_path: path, metadata })
    .select('id')
    .single();
  if (insertError) throw describeError('photo insert failed', insertError);

  const { error: linkError } = await supabase
    .from('photo_groups')
    .insert(groupIds.map(group_id => ({ photo_id: photoRow.id, group_id })));
  if (linkError) throw describeError('sharing to group failed', linkError);
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
  rows: { toProfileId: string; fromName: string; photoId: string; text: string; type: 'comment' | 'mention' }[]
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
    const { data } = await supabase.from('photos').select('image_path').eq('profile_id', profileId);
    const paths = (data || []).map(r => r.image_path as string).filter(Boolean);
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

// ---------------------------------------------------------------------------
// One-time Firebase -> Supabase import
// ---------------------------------------------------------------------------

// Fixed id of the group the pre-groups schema migration created to hold
// everyone's existing data (see supabase-schema.sql); newly-imported photos
// are shared into the same group so they stay visible under the same rules
// as everything else.
const LEGACY_GROUP_ID = '11111111-1111-1111-1111-111111111111';

export async function migrateFromFirebase(onProgress: (message: string) => void, serviceRoleKey: string): Promise<string> {
  // Bypasses row-level security entirely for this one-time admin operation;
  // never persisted, only held for the duration of this call
  const admin = createAdminClient(serviceRoleKey);

  onProgress('Connecting to Firebase...');
  const [{ db, auth }, { signInWithPopup, GoogleAuthProvider }, { collection, getDocs }] = await Promise.all([
    import('./firebase'),
    import('firebase/auth'),
    import('firebase/firestore'),
  ]);

  if (!auth.currentUser) {
    await signInWithPopup(auth, new GoogleAuthProvider());
  }

  onProgress('Reading Firebase data...');
  const [usersSnap, photosSnap] = await Promise.all([
    getDocs(collection(db, 'users')),
    getDocs(collection(db, 'photos')),
  ]);

  // Create or match a profile for every Firebase user
  const uidToProfileId: Record<string, string> = {};
  for (const userDoc of usersSnap.docs) {
    const u = userDoc.data() as { email?: string; name?: string; timezone?: string; settings?: UserSettings };
    const email = (u.email || '').toLowerCase();
    if (!email) continue;

    const { data: existing } = await admin
      .from('profiles')
      .select('id, firebase_uid, name')
      .or(`firebase_uid.eq.${userDoc.id},email.eq.${email}`)
      .limit(1);

    if (existing && existing.length > 0) {
      uidToProfileId[userDoc.id] = existing[0].id;
      // Adopt the real Firebase name/timezone: profiles created by a
      // magic-link sign-in before the import only have a name guessed
      // from the email address
      const updates: { firebase_uid?: string; name?: string; timezone?: string } = {};
      if (!existing[0].firebase_uid) updates.firebase_uid = userDoc.id;
      if (u.name) updates.name = u.name;
      if (u.timezone) updates.timezone = u.timezone;
      if (Object.keys(updates).length > 0) {
        await admin.from('profiles').update(updates).eq('id', existing[0].id);
      }
      // Make sure they're a member of the legacy group even if their
      // profile predates it (e.g. re-running this import later)
      await admin.from('group_members').upsert(
        { group_id: LEGACY_GROUP_ID, profile_id: existing[0].id, role: 'member' },
        { onConflict: 'group_id,profile_id', ignoreDuplicates: true }
      );
    } else {
      const { data: created, error } = await admin
        .from('profiles')
        .insert({
          email,
          name: u.name || 'Unknown',
          timezone: u.timezone || 'UTC',
          settings: u.settings || {},
          firebase_uid: userDoc.id,
        })
        .select('id')
        .single();
      if (error) throw error;
      uidToProfileId[userDoc.id] = created.id;
      await admin.from('group_members').upsert(
        { group_id: LEGACY_GROUP_ID, profile_id: created.id, role: 'member' },
        { onConflict: 'group_id,profile_id', ignoreDuplicates: true }
      );
    }
  }

  // Skip photos that were already imported (idempotent re-runs)
  const { data: alreadyImported } = await admin.from('photos').select('firebase_id').not('firebase_id', 'is', null);
  const done = new Set((alreadyImported || []).map(r => r.firebase_id as string));

  let imported = 0;
  let skipped = 0;
  const total = photosSnap.docs.length;

  for (const photoDoc of photosSnap.docs) {
    if (done.has(photoDoc.id)) {
      skipped++;
      continue;
    }
    const p = photoDoc.data() as {
      userId: string;
      timestamp: string;
      imageUrl: string;
      metadata?: PhotoMetadata;
      comments?: { userId: string; text: string; timestamp: string }[];
      reactions?: Record<string, string[]>;
    };
    const profileId = uidToProfileId[p.userId];
    if (!profileId || !p.imageUrl) {
      skipped++;
      continue;
    }

    onProgress(`Importing photo ${imported + skipped + 1} of ${total}...`);

    const imageBlob = await (await fetch(p.imageUrl)).blob();
    const path = `migrated/${photoDoc.id}.jpg`;
    const { error: uploadError } = await admin.storage.from('photos').upload(path, imageBlob, {
      contentType: 'image/jpeg',
      upsert: true,
    });
    if (uploadError) {
      throw describeError('storage upload failed', uploadError);
    }

    const { data: photoRow, error: insertError } = await admin
      .from('photos')
      .insert({
        profile_id: profileId,
        taken_at: p.timestamp,
        image_path: path,
        metadata: p.metadata || null,
        firebase_id: photoDoc.id,
      })
      .select('id')
      .single();
    if (insertError) {
      throw describeError('photo insert failed', insertError);
    }

    await admin.from('photo_groups').upsert(
      { photo_id: photoRow.id, group_id: LEGACY_GROUP_ID },
      { onConflict: 'photo_id,group_id', ignoreDuplicates: true }
    );

    for (const c of p.comments || []) {
      const commentProfile = uidToProfileId[c.userId];
      if (!commentProfile) continue;
      await admin.from('comments').insert({
        photo_id: photoRow.id,
        profile_id: commentProfile,
        text: c.text,
        created_at: c.timestamp,
      });
    }
    for (const [emoji, uids] of Object.entries(p.reactions || {})) {
      for (const uid of uids) {
        const reactionProfile = uidToProfileId[uid];
        if (!reactionProfile) continue;
        await admin.from('reactions').upsert(
          { photo_id: photoRow.id, profile_id: reactionProfile, emoji },
          { onConflict: 'photo_id,profile_id,emoji', ignoreDuplicates: true }
        );
      }
    }
    imported++;
  }

  return `Imported ${imported} photo${imported === 1 ? '' : 's'}${skipped > 0 ? `, ${skipped} already present or skipped` : ''}.`;
}
