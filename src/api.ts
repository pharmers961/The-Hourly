// Supabase data layer for The Hourly. All reads map database rows into the
// app's existing Photo/User shapes so the UI is agnostic of the backend.
import { supabase } from './supabase';
import { Photo, User as AppUser, PhotoMetadata, UserSettings } from './types';

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
  metadata: PhotoMetadata | null;
  firebase_id: string | null;
  comments: CommentRow[];
  reactions: ReactionRow[];
}

export interface AppData {
  profiles: Record<string, AppUser>;
  photos: Photo[];
}

export function publicPhotoUrl(imagePath: string): string {
  return supabase.storage.from('photos').getPublicUrl(imagePath).data.publicUrl;
}

export async function fetchAllData(): Promise<AppData> {
  const [profilesRes, photosRes] = await Promise.all([
    supabase.from('profiles').select('*'),
    supabase.from('photos').select('*, comments(*), reactions(*)').order('taken_at', { ascending: true }),
  ]);
  if (profilesRes.error) throw profilesRes.error;
  if (photosRes.error) throw photosRes.error;

  const profiles: Record<string, AppUser> = {};
  (profilesRes.data as ProfileRow[]).forEach(row => {
    profiles[row.id] = {
      id: row.id,
      name: row.name || 'Unknown',
      timezone: row.timezone || 'UTC',
      lastActive: row.last_active || undefined,
      settings: row.settings && Object.keys(row.settings).length > 0 ? (row.settings as UserSettings) : undefined,
    };
  });

  const photos: Photo[] = (photosRes.data as PhotoRow[]).map(row => {
    const reactions: Record<string, string[]> = {};
    row.reactions.forEach(r => {
      (reactions[r.emoji] ||= []).push(r.profile_id);
    });
    return {
      id: row.id,
      userId: row.profile_id,
      timestamp: row.taken_at,
      imageUrl: publicPhotoUrl(row.image_path),
      imagePath: row.image_path,
      metadata: row.metadata || undefined,
      comments: row.comments
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
  });

  return { profiles, photos };
}

export async function ensureProfile(timezone: string): Promise<AppUser & { email: string }> {
  const { data, error } = await supabase.rpc('ensure_profile', { p_timezone: timezone });
  if (error) throw error;
  const row = data as ProfileRow;
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    lastActive: row.last_active || undefined,
    settings: row.settings && Object.keys(row.settings).length > 0 ? (row.settings as UserSettings) : undefined,
    email: row.email,
  };
}

export async function sendMagicLink(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
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

export async function uploadPhoto(profileId: string, imageBlob: Blob, metadata: PhotoMetadata): Promise<void> {
  const path = `${profileId}/${crypto.randomUUID()}.jpg`;
  const { error: uploadError } = await supabase.storage.from('photos').upload(path, imageBlob, {
    contentType: 'image/jpeg',
  });
  if (uploadError) throw uploadError;
  const { error } = await supabase.from('photos').insert({
    profile_id: profileId,
    taken_at: new Date().toISOString(),
    image_path: path,
    metadata,
  });
  if (error) throw error;
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

export async function deleteAccount(profileId: string, myPhotos: Photo[]): Promise<void> {
  // Best-effort removal of image files (storage ownership may block files
  // uploaded by the migration; orphaned files are harmless)
  const paths = myPhotos.map(p => p.imagePath).filter((p): p is string => !!p);
  if (paths.length > 0) {
    await supabase.storage.from('photos').remove(paths).then(() => undefined, () => undefined);
  }
  // Deleting the profile cascades to photos, comments, reactions, nudges,
  // and notifications
  const { error } = await supabase.from('profiles').delete().eq('id', profileId);
  if (error) throw error;
  await supabase.auth.signOut();
}

export interface RealtimeHandlers {
  onDataChange: () => void;
  onNudge: (fromProfileId: string) => void;
  onNotification: (n: { from_name: string; text: string | null; type: string }) => void;
}

export function subscribeRealtime(profileId: string, handlers: RealtimeHandlers): () => void {
  const channel = supabase
    .channel('the-hourly')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'photos' }, handlers.onDataChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, handlers.onDataChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, handlers.onDataChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, handlers.onDataChange)
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

export async function migrateFromFirebase(onProgress: (message: string) => void): Promise<string> {
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

    const { data: existing } = await supabase
      .from('profiles')
      .select('id, firebase_uid')
      .or(`firebase_uid.eq.${userDoc.id},email.eq.${email}`)
      .limit(1);

    if (existing && existing.length > 0) {
      uidToProfileId[userDoc.id] = existing[0].id;
      if (!existing[0].firebase_uid) {
        await supabase.from('profiles').update({ firebase_uid: userDoc.id }).eq('id', existing[0].id);
      }
    } else {
      const { data: created, error } = await supabase
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
    }
  }

  // Skip photos that were already imported (idempotent re-runs)
  const { data: alreadyImported } = await supabase.from('photos').select('firebase_id').not('firebase_id', 'is', null);
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
    const { error: uploadError } = await supabase.storage.from('photos').upload(path, imageBlob, {
      contentType: 'image/jpeg',
      upsert: true,
    });
    if (uploadError) throw uploadError;

    const { data: photoRow, error: insertError } = await supabase
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
    if (insertError) throw insertError;

    for (const c of p.comments || []) {
      const commentProfile = uidToProfileId[c.userId];
      if (!commentProfile) continue;
      await supabase.from('comments').insert({
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
        await supabase.from('reactions').upsert(
          { photo_id: photoRow.id, profile_id: reactionProfile, emoji },
          { onConflict: 'photo_id,profile_id,emoji', ignoreDuplicates: true }
        );
      }
    }
    imported++;
  }

  return `Imported ${imported} photo${imported === 1 ? '' : 's'}${skipped > 0 ? `, ${skipped} already present or skipped` : ''}.`;
}
