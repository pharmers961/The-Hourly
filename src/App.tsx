import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Camera, Thermometer, Activity, LogIn, LogOut, Bell, Download, Globe, X, Trash2, MapPin, Droplets, Share, ChevronLeft, ChevronRight, Settings, Heart, Calendar, Image as ImageIcon, Maximize, Clock, RefreshCw, Newspaper } from 'lucide-react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import html2canvas from 'html2canvas';
import { groupPhotosByHour, fetchEnvironmentalMetadata, compressImageToBlob, makeThumbnailBlob, getRelativeTime, extractExifGps } from './utils';
import { supabase, isSupabaseConfigured } from './supabase';
import * as api from './api';
import { Photo, User as AppUser, UserSettings, Group } from './types';

export default function App() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  // All profiles relevant to the current group: current members plus authors
  // of photos still in the group (who may have since left).
  const [users, setUsers] = useState<Record<string, AppUser>>({});
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [isCapturing, setIsCapturing] = useState(false);
  const [profile, setProfile] = useState<(AppUser & { email: string }) | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [isSendingLink, setIsSendingLink] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [isNudging, setIsNudging] = useState(false);
  const [referenceTimezone, setReferenceTimezone] = useState<string>('');
  const [newPhotoIds, setNewPhotoIds] = useState<Set<string>>(new Set());
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const [dismissedNudgeHour, setDismissedNudgeHour] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [openSettingsSection, setOpenSettingsSection] = useState<string>('profile');
  const [localLocationInput, setLocalLocationInput] = useState('');
  const [localNameInput, setLocalNameInput] = useState('');
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [isGeneratingCollage, setIsGeneratingCollage] = useState(false);
  const [isFullscreenPhoto, setIsFullscreenPhoto] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; message: string; type: 'error' | 'success' }[]>([]);
  const collageRef = useRef<HTMLDivElement>(null);

  // Weekly recap ("The Weekly")
  const [showRecap, setShowRecap] = useState(false);
  const [isSavingRecap, setIsSavingRecap] = useState(false);
  const recapRef = useRef<HTMLDivElement>(null);

  // Groups
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(() => localStorage.getItem('selectedGroupId'));
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [manageGroupName, setManageGroupName] = useState('');
  const [groupMemberRoles, setGroupMemberRoles] = useState<{ profileId: string; role: 'owner' | 'member' }[]>([]);
  const [importSourceGroupId, setImportSourceGroupId] = useState('');
  const [isImportingPhotos, setIsImportingPhotos] = useState(false);
  const [hasPendingInvite] = useState(() => !!(localStorage.getItem('pendingJoinCode') || new URLSearchParams(window.location.search).get('join')));

  // Multi-group capture picker
  const [pendingCaptureFile, setPendingCaptureFile] = useState<File | null>(null);
  const [captureGroupIds, setCaptureGroupIds] = useState<Set<string>>(new Set());

  // Preview of the photo about to be shared, shown in the group picker
  const pendingPreviewUrl = useMemo(
    () => (pendingCaptureFile ? URL.createObjectURL(pendingCaptureFile) : null),
    [pendingCaptureFile]
  );
  useEffect(() => {
    return () => {
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    };
  }, [pendingPreviewUrl]);

  // iPhones only deliver web push when the app is installed to the home
  // screen — surface that once to iOS users browsing in a plain tab.
  const [showIosHint, setShowIosHint] = useState(false);
  useEffect(() => {
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    if (isIos && !isStandalone && !localStorage.getItem('iosHintDismissed')) {
      setShowIosHint(true);
    }
  }, []);

  // Whether the user has captured a photo in the current real-world hour —
  // tracked globally (across all their groups), independent of which group
  // is currently selected, since one capture is shared to chosen groups.
  const [hasPostedThisHour, setHasPostedThisHour] = useState(false);

  const showToast = (message: string, type: 'error' | 'success' = 'error') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  };

  // Appends the real error text (Supabase errors are plain objects, not JS
  // Error instances, but api.ts wraps most of them via describeError so
  // .message is usually populated either way) so toasts are diagnosable
  // without needing devtools.
  const errDetail = (err: unknown): string => {
    const message = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : '';
    return message ? `: ${message.slice(0, 300)}` : '. Please try again.';
  };

  // Safety net: surface otherwise-silent crashes (e.g. a rejected promise
  // no local catch handles) as a toast instead of the app just appearing to
  // do nothing when a button is tapped
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      console.error('Unhandled error:', e.error || e.message);
      showToast(`Unexpected error: ${(e.error?.message || e.message || 'unknown').slice(0, 200)}`);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      console.error('Unhandled rejection:', e.reason);
      const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
      showToast(`Unexpected error: ${msg.slice(0, 200)}`);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  // Stash a ?join=<code> invite link immediately, before any auth redirect
  // has a chance to drop the query string, so joining still works after the
  // magic-link/Google round trip.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('join');
    if (code) localStorage.setItem('pendingJoinCode', code);
  }, []);

  // Compatibility shim: the UI below was written against Firebase's auth user
  // ({ uid, displayName }); keep that shape backed by the Supabase profile.
  const user = useMemo(
    () => (profile ? { uid: profile.id, displayName: profile.name } : null),
    [profile]
  );

  const initialPhotoLoaded = useRef(false);
  const photoEntryPushed = useRef(false);
  const lastNotifiedHour = useRef<number | null>(null);
  const knownPhotoIds = useRef<Set<string> | null>(null);
  const usersRef = useRef<Record<string, AppUser>>({});
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    'Notification' in window ? Notification.permission : 'default'
  );

  // Chrome on Android rejects `new Notification(...)` from a page outright —
  // mobile notifications must go through the service worker. Route through it
  // everywhere, with the constructor kept only as a desktop fallback.
  const showLocalNotification = (title: string, body: string) => {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const fallback = () => {
      try {
        new Notification(title, { body, icon: '/icon-192.png' });
      } catch {
        // no notification surface available; nothing else to do
      }
    };
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready
        .then(reg => reg.showNotification(title, { body, icon: '/icon-192.png', badge: '/icon-192.png' }))
        .catch(fallback);
    } else {
      fallback();
    }
  };

  const requestNotificationPermission = async () => {
    if ('Notification' in window) {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission === 'granted' && profile) {
        await api.registerPushSubscription(profile.id);
        showToast('Notifications enabled', 'success');
      }
    }
  };

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      // Supabase calls must be deferred out of the auth callback to avoid
      // deadlocking the auth client
      setTimeout(() => {
        if (session) {
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          api.ensureProfile(tz)
            .then(p => setProfile(p))
            .catch(err => {
              console.error('Failed to load profile:', err);
              showToast(`Failed to load your profile${errDetail(err)}`);
            })
            .finally(() => setIsAuthLoading(false));
        } else {
          setProfile(null);
          setIsAuthLoading(false);
        }
      }, 0);
    });
    return () => subscription.unsubscribe();
  }, []);

  // On sign-in: refresh this device's push subscription (endpoints rotate,
  // and each device registers itself) and clear pings that predate this
  // session — push already delivered them while the app was closed.
  useEffect(() => {
    if (!profile) return;
    if ('Notification' in window && Notification.permission === 'granted') {
      api.registerPushSubscription(profile.id);
    }
    api.clearMyPendingPings(profile.id);
  }, [profile?.id]);

  // Heartbeat: lastActive is otherwise only written at login, so without this
  // the 10-minute online check runs on stale data. Refresh it periodically
  // while the app is open (and whenever the tab regains focus).
  useEffect(() => {
    if (!profile) return;
    const heartbeat = () => {
      api.updateLastActive(profile.id).catch((err) => console.warn('Failed to update lastActive:', err));
    };
    const interval = setInterval(heartbeat, 5 * 60 * 1000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') heartbeat();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [profile?.id]);

  const refreshData = useCallback(async () => {
    if (!selectedGroupId) {
      setPhotos([]);
      setUsers({});
      setMemberIds([]);
      usersRef.current = {};
      return;
    }
    try {
      const data = await api.fetchGroupData(selectedGroupId);
      usersRef.current = data.profiles;
      setUsers(data.profiles);
      setMemberIds(data.memberIds);
      setPhotos(data.photos);

      if (knownPhotoIds.current) {
        // Pulse photos that arrived since the last refresh
        const freshIds = data.photos.filter(p => !knownPhotoIds.current!.has(p.id)).map(p => p.id);
        if (freshIds.length > 0) {
          setNewPhotoIds(prev => {
            const next = new Set(prev);
            freshIds.forEach(id => next.add(id));
            return next;
          });
          setTimeout(() => {
            setNewPhotoIds(prev => {
              const next = new Set(prev);
              freshIds.forEach(id => next.delete(id));
              return next;
            });
          }, 5000); // Pulse for 5 seconds
        }
      } else {
        // First load: honor a shared ?photo= deep link, otherwise land the
        // view on the current hour — that row is the whole point of the app
        const pId = new URLSearchParams(window.location.search).get('photo');
        if (pId) {
          const p = data.photos.find(x => x.id === pId);
          if (p) setSelectedPhoto(p);
        } else {
          setTimeout(() => {
            document.getElementById('current-hour-slot')?.scrollIntoView({ block: 'center' });
          }, 150);
        }
        initialPhotoLoaded.current = true;
      }
      knownPhotoIds.current = new Set(data.photos.map(p => p.id));
    } catch (err) {
      console.error('Failed to load data:', err);
      const detail = err instanceof Error && err.message ? `: ${err.message.slice(0, 300)}` : '';
      showToast(`Failed to load photos${detail}`);
    }
  }, [selectedGroupId]);

  const refreshGroups = useCallback(async () => {
    if (!profile) return;
    try {
      const myGroups = await api.fetchMyGroups(profile.id);
      setGroups(myGroups);
      setSelectedGroupId(prev => (prev && myGroups.some(g => g.id === prev) ? prev : (myGroups[0]?.id || null)));
    } catch (err) {
      console.error('Failed to load groups:', err);
      showToast(`Failed to load your groups${errDetail(err)}`);
    } finally {
      setGroupsLoaded(true);
    }
  }, [profile?.id]);

  const refreshHasPostedThisHour = useCallback(async () => {
    if (!profile) {
      setHasPostedThisHour(false);
      return;
    }
    const now = new Date();
    const hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).toISOString();
    try {
      setHasPostedThisHour(await api.hasCapturedThisHour(profile.id, hourStart));
    } catch (err) {
      console.error('Failed to check hourly capture status:', err);
    }
  }, [profile?.id]);

  // Persist the last-viewed group across reloads
  useEffect(() => {
    if (selectedGroupId) localStorage.setItem('selectedGroupId', selectedGroupId);
  }, [selectedGroupId]);

  // Load the signed-in user's groups, and complete a pending invite-link join
  const pendingJoinHandled = useRef(false);
  useEffect(() => {
    if (!profile) {
      setGroups([]);
      setGroupsLoaded(false);
      setSelectedGroupId(null);
      return;
    }

    const joinCode = pendingJoinHandled.current ? null : localStorage.getItem('pendingJoinCode');
    if (joinCode) {
      pendingJoinHandled.current = true;
      api.joinGroupByCode(joinCode)
        .then(async (group) => {
          localStorage.removeItem('pendingJoinCode');
          const url = new URL(window.location.href);
          url.searchParams.delete('join');
          window.history.replaceState({}, '', url.toString());
          await refreshGroups();
          setSelectedGroupId(group.id);
          showToast(`Joined "${group.name}"`, 'success');
        })
        .catch(err => {
          console.error('Failed to join group:', err);
          localStorage.removeItem('pendingJoinCode');
          showToast('That invite link is invalid or has expired.');
          refreshGroups();
        });
    } else {
      refreshGroups();
    }
  }, [profile?.id, refreshGroups]);

  useEffect(() => {
    refreshHasPostedThisHour();
  }, [refreshHasPostedThisHour]);

  useEffect(() => {
    if (!profile || !selectedGroupId) {
      setPhotos([]);
      setUsers({});
      setMemberIds([]);
      usersRef.current = {};
      knownPhotoIds.current = null;
      return;
    }

    knownPhotoIds.current = null; // reset pulse-tracking when switching groups
    refreshData();

    const unsubscribe = api.subscribeRealtime(profile.id, {
      onDataChange: () => {
        refreshData();
        refreshHasPostedThisHour();
      },
      onGroupsChange: () => {
        refreshGroups();
      },
      onNudge: (fromProfileId) => {
        if (usersRef.current[profile.id]?.settings?.notifyReminders === false) return;
        const fromName = usersRef.current[fromProfileId]?.name.split(' ')[0] || 'Someone';
        showLocalNotification('The Hourly: Nudge!', `${fromName} nudged you to capture your moment!`);
      },
      onNotification: (n) => {
        const mySettings = usersRef.current[profile.id]?.settings;
        if (n.type === 'like') {
          if (mySettings?.notifyLikes === false) return;
          showLocalNotification('The Hourly', `${n.from_name} reacted ${n.text || '❤️'} to your photo`);
          return;
        }
        if (mySettings?.notifyComments === false) return;
        showLocalNotification(
          'The Hourly',
          n.type === 'mention'
            ? `${n.from_name} mentioned you: ${n.text || ''}`
            : `${n.from_name} commented on your photo: ${n.text || ''}`
        );
      },
    });

    return unsubscribe;
  }, [profile?.id, selectedGroupId, notificationPermission, refreshData, refreshGroups, refreshHasPostedThisHour]);

  useEffect(() => {
    if (!initialPhotoLoaded.current) return;
    const url = new URL(window.location.href);
    const currentParam = url.searchParams.get('photo');

    if (selectedPhoto) {
      if (currentParam === selectedPhoto.id) return;
      url.searchParams.set('photo', selectedPhoto.id);
      if (currentParam) {
        // Switching between photos: don't stack an entry per photo
        window.history.replaceState({}, '', url.toString());
      } else {
        // Opening: push an entry so the system back gesture closes the
        // photo instead of leaving the site
        window.history.pushState({}, '', url.toString());
        photoEntryPushed.current = true;
      }
    } else if (currentParam) {
      if (photoEntryPushed.current) {
        // Closed via the UI: consume the entry we pushed when opening
        photoEntryPushed.current = false;
        window.history.back();
      } else {
        url.searchParams.delete('photo');
        window.history.replaceState({}, '', url.toString());
      }
    }
  }, [selectedPhoto]);

  useEffect(() => {
    const onPopState = () => {
      const pId = new URLSearchParams(window.location.search).get('photo');
      if (!pId) {
        photoEntryPushed.current = false;
        setSelectedPhoto(null);
        setIsFullscreenPhoto(false);
      } else {
        const p = photos.find(x => x.id === pId);
        if (p) setSelectedPhoto(p);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [photos]);

  useEffect(() => {
    if (selectedPhoto) {
      const updated = photos.find(p => p.id === selectedPhoto.id);
      if (updated && updated !== selectedPhoto) {
        setSelectedPhoto(updated);
      }
    }
  }, [photos, selectedPhoto]);

  const isSiblingOnline = (siblingId: string) => {
    // The current user is by definition online while using the app.
    if (user && user.uid === siblingId) return true;

    const dbUser = users[siblingId];
    if (dbUser && dbUser.lastActive) {
      const activeTime = new Date(dbUser.lastActive).getTime();
      const now = new Date().getTime();
      return (now - activeTime) <= 10 * 60 * 1000; // Active within last 10 minutes
    }
    return false;
  };

  const [currentTime, setCurrentTime] = useState(new Date());

  // Current members of the group — the people who can post going forward, get
  // nudged, appear in the timezone list, etc.
  const activeUsers: AppUser[] = useMemo(
    () => memberIds.map(id => users[id]).filter(Boolean),
    [memberIds, users]
  );

  // Everything "The Weekly" needs, computed from the selected group's last
  // 7 days (rolling window ending today).
  const recapData = useMemo(() => {
    if (!showRecap) return null;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    const weekPhotos = photos.filter(p => new Date(p.timestamp) >= start);

    const heartCount = (p: Photo) =>
      Object.values(p.reactions || {}).reduce((n, arr) => n + arr.length, 0);

    const days: { label: string; dayPhotos: Photo[] }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      days.push({
        label: d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
        dayPhotos: weekPhotos
          .filter(p => new Date(p.timestamp).toDateString() === d.toDateString())
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
      });
    }

    const hero =
      [...weekPhotos].sort(
        (a, b) => heartCount(b) - heartCount(a) || b.timestamp.localeCompare(a.timestamp)
      )[0] || null;

    const perPerson = activeUsers
      .map(u => {
        const mine = weekPhotos.filter(p => p.userId === u.id);
        return {
          user: u,
          count: mine.length,
          hearts: mine.reduce((n, p) => n + heartCount(p), 0),
          daysPosted: new Set(mine.map(p => new Date(p.timestamp).toDateString())).size,
        };
      })
      .sort((a, b) => b.count - a.count);

    const hourCounts: Record<number, number> = {};
    weekPhotos.forEach(p => {
      const h = new Date(p.timestamp).getHours();
      hourCounts[h] = (hourCounts[h] || 0) + 1;
    });
    const busiest = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0];
    const busiestHourLabel = busiest
      ? new Date(2000, 0, 1, Number(busiest[0])).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })
      : null;

    const totalHearts = weekPhotos.reduce((n, p) => n + heartCount(p), 0);
    const totalComments = weekPhotos.reduce((n, p) => n + (p.comments?.length || 0), 0);
    const rangeLabel = `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    return { weekPhotos, days, hero, perPerson, busiestHourLabel, totalHearts, totalComments, rangeLabel, heartCount };
  }, [showRecap, photos, activeUsers]);

  const handleSaveRecap = async () => {
    if (!recapRef.current) return;
    setIsSavingRecap(true);
    try {
      const canvas = await html2canvas(recapRef.current, {
        scale: 2,
        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-paper').trim() || '#F9F8F5',
        logging: false,
        useCORS: true
      });
      const link = document.createElement('a');
      link.download = `The-Hourly-Weekly-${new Date().toLocaleDateString().replace(/\//g, '-')}.jpg`;
      link.href = canvas.toDataURL('image/jpeg', 0.9);
      link.click();
    } catch (err) {
      console.error('Recap export failed', err);
      showToast(`Failed to save recap${errDetail(err)}`);
    } finally {
      setIsSavingRecap(false);
    }
  };

  const selectedGroup = useMemo(() => groups.find(g => g.id === selectedGroupId) || null, [groups, selectedGroupId]);
  // Every member is an admin (rename, invite, remove members). Deleting the
  // whole group and transferring the creator role are reserved for the creator.
  const canAdmin = !!selectedGroup;
  const isOwner = selectedGroup?.role === 'owner';

  // The theme class lives on <html> (not the app root) so the body
  // background — visible wherever the matrix overflows the viewport —
  // matches the theme instead of flashing white around the edges.
  const isDarkTheme = users[user?.uid ?? '']?.settings?.theme === 'dark';
  useEffect(() => {
    document.documentElement.classList.toggle('theme-dark', isDarkTheme);
  }, [isDarkTheme]);

  useEffect(() => {
    if (showSettings && user) {
      const displayLocation = activeUsers.find(u => u.id === user.uid)?.settings?.displayLocation || '';
      setLocalLocationInput(displayLocation);
      setLocalNameInput(profile?.name || '');
      if (selectedGroupId) {
        setManageGroupName(selectedGroup?.name || '');
        api.fetchGroupMemberRoles(selectedGroupId)
          .then(setGroupMemberRoles)
          .catch(err => console.error('Failed to load group members:', err));
      }
    }
  }, [showSettings, user, activeUsers, profile?.name, selectedGroupId, selectedGroup?.name]);

  const timeSlots = useMemo(() => {
    const isHour12 = activeUsers.find(u => u.id === user?.uid)?.settings?.timeFormat !== '24h';
    return groupPhotosByHour(photos, activeUsers, referenceTimezone, selectedDate, isHour12);
  }, [photos, activeUsers, referenceTimezone, selectedDate, user?.uid]);

  const isSelectedDateToday = selectedDate.toDateString() === new Date().toDateString();

  const displayedSlots = useMemo(() => {
    return timeSlots.filter(slot => {
      if (isSelectedDateToday) return true;
      return Object.values(slot.photos).some(p => !!p);
    });
  }, [timeSlots, isSelectedDateToday]);

  // Matrix columns = current members, plus anyone who has a photo on the
  // displayed date (so a member who left still shows their past photos in
  // history, but has no column going forward). Members always keep a column.
  const columnUsers: AppUser[] = useMemo(() => {
    const memberSet = new Set(memberIds);
    const formerIds = new Set<string>();
    displayedSlots.forEach(slot => {
      Object.keys(slot.photos).forEach(uid => {
        if (!memberSet.has(uid)) formerIds.add(uid);
      });
    });
    const members = memberIds.map(id => users[id]).filter(Boolean);
    const formers = [...formerIds].map(id => users[id]).filter(Boolean);
    return [...members, ...formers];
  }, [memberIds, displayedSlots, users]);

  const sortedPhotos = useMemo(() => {
    return [...photos].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [photos]);

  const getSiblingLocation = (sibling: AppUser) => {
    // The most recent photo's GPS location wins, so the header tracks where
    // each user actually last captured a moment.
    const latestPhoto = sortedPhotos.find(p => p.userId === sibling.id && p.metadata?.location && p.metadata.location !== 'Unknown Location');
    if (latestPhoto && latestPhoto.metadata?.location) return latestPhoto.metadata.location;
    if (sibling.settings?.displayLocation) return sibling.settings.displayLocation;
    return sibling.timezone.split('/').pop()?.replace(/_/g, ' ');
  };

  const renderTemperature = (tempC: number) => {
    if (!user) return `${tempC}°C`;
    const unit = activeUsers.find(u => u.id === user.uid)?.settings?.temperatureUnit || 'F';
    if (unit === 'F') {
      return `${Math.round(tempC * 9/5 + 32)}°F`;
    }
    return `${tempC}°C`;
  };

  const renderTime = (isoString: string) => {
    const isHour12 = activeUsers.find(u => u.id === user?.uid)?.settings?.timeFormat !== '24h';
    return new Date(isoString).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: isHour12 });
  };

  const handleNextPhoto = () => {
    if (!selectedPhoto) return;
    const currentIndex = sortedPhotos.findIndex(p => p.id === selectedPhoto.id);
    if (currentIndex > 0) {
      setSelectedPhoto(sortedPhotos[currentIndex - 1]);
    }
  };

  const handlePrevPhoto = () => {
    if (!selectedPhoto) return;
    const currentIndex = sortedPhotos.findIndex(p => p.id === selectedPhoto.id);
    if (currentIndex < sortedPhotos.length - 1) {
      setSelectedPhoto(sortedPhotos[currentIndex + 1]);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selectedPhoto) return;
      if (e.key === 'ArrowLeft') {
        handleNextPhoto();
      } else if (e.key === 'ArrowRight') {
        handlePrevPhoto();
      } else if (e.key === 'Escape') {
        setSelectedPhoto(null);
        setIsFullscreenPhoto(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedPhoto, sortedPhotos]);

  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);
  const lastTapTime = useRef<number>(0);
  const isMultiTouch = useRef(false);
  const [showHeartBurst, setShowHeartBurst] = useState(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length > 1) {
      // Two fingers = pinch zoom; don't treat it as a tap or swipe
      isMultiTouch.current = true;
      return;
    }
    isMultiTouch.current = false;
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = () => {
    const start = touchStartX.current;
    const end = touchEndX.current;
    touchStartX.current = null;
    touchEndX.current = null;

    if (isMultiTouch.current) return;

    const distance = start !== null && end !== null ? start - end : 0;
    if (distance > 50) {
      // Swiped left (go to next/newer)
      handlePrevPhoto();
      return;
    }
    if (distance < -50) {
      // Swiped right (go to prev/older)
      handleNextPhoto();
      return;
    }

    // No meaningful movement: this was a tap. Two taps in quick succession
    // heart the photo.
    const now = Date.now();
    if (now - lastTapTime.current < 300) {
      lastTapTime.current = 0;
      handleDoubleTapHeart();
    } else {
      lastTapTime.current = now;
    }
  };

  const handleDoubleTapHeart = () => {
    if (!selectedPhoto || !user) return;
    setShowHeartBurst(true);
    setTimeout(() => setShowHeartBurst(false), 700);
    // Add-only: double-tapping never removes an existing heart
    const hasReacted = (selectedPhoto.reactions?.['❤️'] || []).includes(user.uid);
    if (!hasReacted) handleToggleReaction('❤️');
  };

  const missedSiblings = useMemo(() => {
    // Only check if we are 30 minutes or more into the current hour window
    // (For demo purposes, we'll also trigger it if minutes are 0-29 just so you can test it easily, wait, the prompt says "30 minutes into their respective hour slot", so we should strictly use 30)
    // To make it testable now if the user wants to see it, maybe we just strictly follow the 30m rule. 
    // Wait, the prompt says "30 minutes into their respective hour slot".
    // I will strictly check >= 30.
    if (currentTime.getMinutes() < 30) return [];
    
    const currentHourKey = new Date(currentTime.getFullYear(), currentTime.getMonth(), currentTime.getDate(), currentTime.getHours()).toISOString();
    
    if (dismissedNudgeHour === currentHourKey) return [];

    const currentSlot = timeSlots.find(s => s.hourKey === currentHourKey);

    return activeUsers.filter(sibling => {
      if (sibling.id === user?.uid) return false; // don't count (or nudge) yourself
      if (!currentSlot) return true; // No one has uploaded anything this hour yet
      return !currentSlot.photos[sibling.id];
    });
  }, [currentTime, timeSlots, dismissedNudgeHour, activeUsers, user?.uid]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      setCurrentTime(prevTime => {
        if (prevTime.getHours() !== now.getHours() || prevTime.getDate() !== now.getDate()) {
          refreshHasPostedThisHour();
        }
        return now;
      });

      if (notificationPermission === 'granted') {
        const currentHour = now.getHours();
        const myId = profile?.id;
        const remindersOff = !!myId && usersRef.current[myId]?.settings?.notifyReminders === false;
        // Notify at top of the hour (minute 0)
        if (now.getMinutes() === 0 && lastNotifiedHour.current !== currentHour && !remindersOff) {
          showLocalNotification('The Hourly', 'A new hour has begun. Time to chronicle your moment.');
          lastNotifiedHour.current = currentHour;
        }
      }
    }, 60000);
    return () => clearInterval(timer);
  }, [notificationPermission, refreshHasPostedThisHour, profile?.id]);

  const handleGoogleLogin = async () => {
    try {
      await api.signInWithGoogle();
    } catch (error) {
      console.error('Google sign-in failed:', error);
      const detail = error instanceof Error && error.message ? `: ${error.message.slice(0, 200)}` : '';
      showToast(`Google sign-in failed${detail}`);
    }
  };

  const handleSendMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = loginEmail.trim().toLowerCase();
    // Validate ourselves instead of relying on the browser's native
    // form validation, whose failure tooltip can be silently swallowed by
    // mobile keyboards/autofill, making the button look like it does nothing
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showToast('Please enter a valid email address.');
      return;
    }
    setIsSendingLink(true);
    try {
      await api.sendMagicLink(email);
      setMagicLinkSent(true);
    } catch (error) {
      console.error('Failed to send login link:', error);
      const detail = error instanceof Error && error.message ? `: ${error.message.slice(0, 200)}` : '';
      showToast(`Could not send the login link${detail}`);
    } finally {
      setIsSendingLink(false);
    }
  };

  const handleLogout = () => {
    if (window.confirm('Are you sure you want to log out?')) {
      supabase.auth.signOut();
    }
  };

  const handleNudge = async () => {
    if (!user || missedSiblings.length === 0) return;
    setIsNudging(true);

    try {
      const currentHourKey = new Date(currentTime.getFullYear(), currentTime.getMonth(), currentTime.getDate(), currentTime.getHours()).toISOString();
      // Skip anyone who turned reminder notifications off
      await api.sendNudges(user.uid, missedSiblings.filter(s => s.settings?.notifyReminders !== false).map(s => s.id), currentHourKey);
      showToast('Nudge sent', 'success');
    } catch (err) {
      console.error('Failed to send nudges:', err);
      showToast(`Failed to send nudge${errDetail(err)}`);
    }

    setTimeout(() => setIsNudging(false), 2000);
  };

  const handleDismissNudge = () => {
    const currentHourKey = new Date(currentTime.getFullYear(), currentTime.getMonth(), currentTime.getDate(), currentTime.getHours()).toISOString();
    setDismissedNudgeHour(currentHourKey);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleCaptureClick = () => {
    fileInputRef.current?.click();
  };

  const performCapture = async (file: File, profileId: string, groupIds: string[]) => {
    if (groupIds.length === 0) {
      showToast('Select at least one group to share this to.');
      return;
    }
    setIsCapturing(true);
    try {
      const imageBlob = await compressImageToBlob(file);
      const thumbBlob = await makeThumbnailBlob(file).catch(() => null);
      const userDisplayLocation = activeUsers.find(u => u.id === profileId)?.settings?.displayLocation;
      // Prefer the GPS coordinates embedded in the photo itself; fall back to
      // the device's current position inside fetchEnvironmentalMetadata.
      const exifCoords = await extractExifGps(file);
      const metadata = await fetchEnvironmentalMetadata(userDisplayLocation || undefined, exifCoords || undefined);

      await api.uploadPhotoToGroups(profileId, imageBlob, thumbBlob, metadata, groupIds);
      setHasPostedThisHour(true);
      await refreshData();
      showToast('Moment captured', 'success');
    } catch (err) {
      console.error('Capture error:', err);
      showToast(`Photo failed to upload${errDetail(err)}`);
    } finally {
      setIsCapturing(false);
      setPendingCaptureFile(null);
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file || !user) return;

    if (groups.length <= 1) {
      // Only one group to share to (or none, which performCapture will
      // reject with a clear message) — skip the picker for the common case
      await performCapture(file, user.uid, groups.map(g => g.id));
      return;
    }

    // Multiple groups: let the user choose before uploading — everything
    // starts checked, unticking is the exception
    setPendingCaptureFile(file);
    setCaptureGroupIds(new Set(groups.map(g => g.id)));
  };

  const handleConfirmCaptureGroups = () => {
    if (!pendingCaptureFile || !user) return;
    performCapture(pendingCaptureFile, user.uid, Array.from(captureGroupIds));
  };

  const handleSaveSettings = async (updates: Partial<AppUser['settings']>) => {
    if (!user) return;
    try {
      const defaults: UserSettings = { temperatureUnit: 'F', timeFormat: '12h' };
      const newSettings: UserSettings = { ...(users[user.uid]?.settings || defaults), ...updates };

      // Optimistic update
      setUsers(prev => ({
        ...prev,
        [user.uid]: {
          ...prev[user.uid],
          settings: newSettings
        }
      }));

      await api.saveProfileSettings(user.uid, newSettings);
    } catch (err) {
      console.error('Failed to save settings:', err);
      showToast(`Failed to save settings${errDetail(err)}`);
    }
  };

  const handleAccountDeletion = async () => {
    if (!user) return;
    if (!window.confirm('Are you sure you want to delete your account, all your photos, and your comments and reactions? This cannot be undone.')) return;

    try {
      // Deleting the profile cascades to photos, comments, reactions, and
      // group memberships across every group, not just the currently viewed one
      await api.deleteAccount(user.uid);
      setShowSettings(false);
    } catch (err) {
      console.error('Failed to delete account:', err);
      showToast(`Failed to delete account${errDetail(err)}`);
    }
  };

  const handleSaveName = async () => {
    if (!profile) return;
    const name = localNameInput.trim();
    if (!name || name === profile.name) return;
    try {
      await api.saveProfileName(profile.id, name);
      setProfile(prev => (prev ? { ...prev, name } : prev));
      setUsers(prev => ({ ...prev, [profile.id]: { ...prev[profile.id], name } }));
    } catch (err) {
      console.error('Failed to save name:', err);
      showToast(`Failed to save your name${errDetail(err)}`);
    }
  };

  const handleCreateGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      const group = await api.createGroup(name);
      setNewGroupName('');
      setShowCreateGroup(false);
      await refreshGroups();
      setSelectedGroupId(group.id);
      showToast(`"${group.name}" created`, 'success');
    } catch (err) {
      console.error('Failed to create group:', err);
      showToast(`Failed to create group${errDetail(err)}`);
    }
  };

  const handleRenameGroup = async () => {
    if (!selectedGroup) return;
    const name = manageGroupName.trim();
    if (!name || name === selectedGroup.name) return;
    try {
      await api.renameGroup(selectedGroup.id, name);
      await refreshGroups();
      showToast('Group renamed', 'success');
    } catch (err) {
      console.error('Failed to rename group:', err);
      showToast(`Failed to rename group${errDetail(err)}`);
    }
  };

  const handleCopyInviteLink = async () => {
    if (!selectedGroup) return;
    const url = `${window.location.origin}/?join=${selectedGroup.inviteCode}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Invite link copied', 'success');
    } catch (err) {
      console.error('Failed to copy invite link:', err);
      showToast('Failed to copy link.');
    }
  };

  const handleRegenerateInvite = async () => {
    if (!selectedGroup) return;
    if (!window.confirm('This invalidates the current invite link — anyone with the old link will no longer be able to join. Continue?')) return;
    try {
      await api.regenerateInviteCode(selectedGroup.id);
      await refreshGroups();
      showToast('New invite link generated', 'success');
    } catch (err) {
      console.error('Failed to regenerate invite code:', err);
      showToast(`Failed to regenerate invite link${errDetail(err)}`);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!selectedGroup) return;
    if (!window.confirm('Remove this person from the group? They will lose access to its photos.')) return;
    try {
      await api.removeGroupMember(selectedGroup.id, memberId);
      setGroupMemberRoles(prev => prev.filter(m => m.profileId !== memberId));
      await refreshData();
      showToast('Member removed', 'success');
    } catch (err) {
      console.error('Failed to remove member:', err);
      showToast(`Failed to remove member${errDetail(err)}`);
    }
  };

  const handleTransferOwnership = async (memberId: string) => {
    if (!selectedGroup) return;
    const memberName = users[memberId]?.name || 'this member';
    if (!window.confirm(`Make ${memberName} the creator of "${selectedGroup.name}"? They'll be able to delete the group; you'll become a regular member.`)) return;
    try {
      await api.transferOwnership(selectedGroup.id, memberId);
      await refreshGroups();
      const roles = await api.fetchGroupMemberRoles(selectedGroup.id);
      setGroupMemberRoles(roles);
      showToast('Creator role transferred', 'success');
    } catch (err) {
      console.error('Failed to transfer ownership:', err);
      showToast(`Failed to transfer creator role${errDetail(err)}`);
    }
  };

  const handleImportPhotos = async () => {
    if (!selectedGroup || !importSourceGroupId) return;
    setIsImportingPhotos(true);
    try {
      const count = await api.importMyPhotos(importSourceGroupId, selectedGroup.id);
      await refreshData();
      showToast(count > 0 ? `Imported ${count} photo${count === 1 ? '' : 's'}` : 'No new photos to import', 'success');
      setImportSourceGroupId('');
    } catch (err) {
      console.error('Failed to import photos:', err);
      showToast(`Failed to import photos${errDetail(err)}`);
    } finally {
      setIsImportingPhotos(false);
    }
  };

  const handleLeaveGroup = async () => {
    if (!selectedGroup || !user) return;

    // The creator can't just leave and orphan the group: they must either
    // hand the role to someone else first, or delete the group.
    if (isOwner) {
      const otherMembers = groupMemberRoles.filter(m => m.profileId !== user.uid);
      if (otherMembers.length > 0) {
        showToast('As the creator, transfer the creator role to another member first, or delete the group.');
        return;
      }
      // Sole member: leaving means deleting the (now-empty) group
      if (!window.confirm(`You're the only member of "${selectedGroup.name}". Leaving will delete it. Continue?`)) return;
      try {
        await api.deleteGroup(selectedGroup.id);
        setShowSettings(false);
        await refreshGroups();
        showToast('Left and deleted group', 'success');
      } catch (err) {
        console.error('Failed to delete group on leave:', err);
        showToast(`Failed to leave group${errDetail(err)}`);
      }
      return;
    }

    if (!window.confirm(`Leave "${selectedGroup.name}"? You'll lose access to its photos.`)) return;
    try {
      await api.removeGroupMember(selectedGroup.id, user.uid);
      setShowSettings(false);
      await refreshGroups();
      showToast('Left group', 'success');
    } catch (err) {
      console.error('Failed to leave group:', err);
      showToast(`Failed to leave group${errDetail(err)}`);
    }
  };

  const handleDeleteGroup = async () => {
    if (!selectedGroup) return;
    if (!window.confirm(`Permanently delete "${selectedGroup.name}" and all its shared photos? This cannot be undone for any member.`)) return;
    try {
      await api.deleteGroup(selectedGroup.id);
      setShowSettings(false);
      await refreshGroups();
      showToast('Group deleted', 'success');
    } catch (err) {
      console.error('Failed to delete group:', err);
      showToast(`Failed to delete group${errDetail(err)}`);
    }
  };

  // Tell the photo's owner they got a reaction — only when one was added
  // (not removed), never for your own photo, and only if the owner hasn't
  // turned like notifications off.
  const maybeSendLikeNotification = (photo: Photo | undefined, emoji: string, wasAdded: boolean) => {
    if (!wasAdded || !photo || !user || photo.userId === user.uid) return;
    if (users[photo.userId]?.settings?.notifyLikes === false) return;
    const fromName = user.displayName?.split(' ')[0] || 'Someone';
    api.sendNotifications([{ toProfileId: photo.userId, fromName, photoId: photo.id, text: emoji, type: 'like' }])
      .catch(err => console.warn('Failed to send like notification:', err));
  };

  const handleReaction = async (photoId: string, emoji: string = '❤️') => {
    if (!user) return;
    try {
      const photo = photos.find(p => p.id === photoId);
      const hasReacted = (photo?.reactions?.[emoji] || []).includes(user.uid);
      await api.setReaction(photoId, user.uid, emoji, !hasReacted);
      maybeSendLikeNotification(photo, emoji, !hasReacted);
      await refreshData();
    } catch (err) {
      console.error('Failed to react:', err);
      showToast(`Failed to add reaction${errDetail(err)}`);
    }
  };

  const handleExportCollage = async () => {
    if (!collageRef.current) return;
    setIsGeneratingCollage(true);
    try {
      const canvas = await html2canvas(collageRef.current, {
        scale: 2,
        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-paper').trim() || '#F9F8F5',
        logging: false,
        useCORS: true
      });
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      const link = document.createElement('a');
      link.download = `The-Hourly-${selectedDate.toLocaleDateString().replace(/\//g, '-')}.jpg`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error('Export failed', err);
      showToast(`Failed to export collage${errDetail(err)}`);
    } finally {
      setIsGeneratingCollage(false);
    }
  };

  const handleSharePhoto = async () => {
    if (!selectedPhoto) return;
    const url = new URL(window.location.href);
    url.searchParams.set('photo', selectedPhoto.id);
    
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'The Hourly',
          text: 'Check out this moment on The Hourly',
          url: url.toString(),
        });
        return;
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          console.error('Error sharing:', err);
        }
      }
    }
    
    try {
      await navigator.clipboard.writeText(url.toString());
      showToast('Link copied to clipboard', 'success');
    } catch (err) {
      console.error('Failed to copy link', err);
      showToast('Failed to copy link.');
    }
  };

  const handleAddComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPhoto || !user || !commentText.trim()) return;

    try {
      const text = commentText.trim();
      await api.addComment(selectedPhoto.id, user.uid, text);

      const mentionedUsers = activeUsers.filter(u =>
        text.includes(`@${u.name.split(' ')[0]}`) ||
        text.includes(`@${u.name}`)
      );

      const notifyUsers = new Set<string>();
      mentionedUsers.forEach(u => notifyUsers.add(u.id));
      if (selectedPhoto.userId !== user.uid) {
        notifyUsers.add(selectedPhoto.userId);
      }
      notifyUsers.delete(user.uid);

      const fromName = user.displayName?.split(' ')[0] || 'Someone';
      await api.sendNotifications(
        [...notifyUsers]
          // Respect each recipient's own preference
          .filter(id => users[id]?.settings?.notifyComments !== false)
          .map(toProfileId => ({
            toProfileId,
            fromName,
            photoId: selectedPhoto.id,
            text,
            type: mentionedUsers.some(u => u.id === toProfileId) ? 'mention' as const : 'comment' as const,
          }))
      );

      setCommentText('');
      await refreshData();
    } catch (err) {
      console.error('Failed to add comment:', err);
      showToast(`Failed to post comment${errDetail(err)}`);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!selectedPhoto || !user) return;
    try {
      await api.deleteComment(commentId);
      await refreshData();
    } catch (err) {
      console.error('Failed to delete comment:', err);
      showToast(`Failed to delete comment${errDetail(err)}`);
    }
  };

  const handleToggleReaction = async (emoji: string) => {
    if (!selectedPhoto || !user) return;
    try {
      const hasReacted = (selectedPhoto.reactions?.[emoji] || []).includes(user.uid);
      await api.setReaction(selectedPhoto.id, user.uid, emoji, !hasReacted);
      maybeSendLikeNotification(selectedPhoto, emoji, !hasReacted);
      await refreshData();
    } catch (err) {
      console.error('Failed to toggle reaction:', err);
      showToast(`Failed to update reaction${errDetail(err)}`);
    }
  };

  // Narrower time column + tighter gaps reclaim room for photo columns so
  // small groups (2-3 people) fit on a phone screen without horizontal
  // scrolling, rather than being forced wider than the viewport.
  const gridStyle = { gridTemplateColumns: `48px repeat(${columnUsers.length > 0 ? columnUsers.length : 1}, 1fr)` };

  const STANDARD_TIMEZONES = [
    { label: 'New York (EST)', value: 'America/New_York' },
    { label: 'London (GMT)', value: 'Europe/London' },
    { label: 'Paris (CET)', value: 'Europe/Paris' },
    { label: 'Tokyo (JST)', value: 'Asia/Tokyo' },
    { label: 'Sydney (AEST)', value: 'Australia/Sydney' },
    { label: 'Los Angeles (PST)', value: 'America/Los_Angeles' },
  ];

  if (!isSupabaseConfigured) {
    return (
      <div className="h-screen bg-paper text-ink font-serif flex flex-col items-center justify-center p-4">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-4xl tracking-tight leading-none italic">The Hourly</h1>
          <p className="font-sans text-xs uppercase tracking-[0.2em] opacity-60">Setup required</p>
          <p className="font-sans text-sm opacity-80">Add your Supabase project URL and anon key to supabase-config.json, then rebuild.</p>
        </div>
      </div>
    );
  }

  if (!isAuthLoading && !user) {
    return (
      <div className="h-screen bg-paper text-ink font-serif flex flex-col items-center justify-center p-4 selection:bg-ink selection:text-paper">
        <div className="max-w-md text-center space-y-8">
          <div>
            <h1 className="text-4xl md:text-6xl tracking-tight leading-none mb-4 italic">The Hourly</h1>
            <p className="font-sans text-xs md:text-sm uppercase tracking-[0.2em] opacity-60">A Synchronized Visual Journal</p>
            {hasPendingInvite && (
              <p className="font-sans text-[10px] uppercase tracking-[0.2em] text-gold mt-3">You've been invited — sign in to join</p>
            )}
          </div>
          {magicLinkSent ? (
            <div className="space-y-3">
              <p className="font-serif text-xl italic">Check your email</p>
              <p className="font-sans text-[11px] uppercase tracking-[0.2em] opacity-60 leading-relaxed">
                We sent a login link to {loginEmail.trim()}.<br />Tap it on this device to sign in.
              </p>
              <button
                onClick={() => setMagicLinkSent(false)}
                className="font-sans text-[10px] uppercase tracking-widest underline underline-offset-4 opacity-60 hover:opacity-100 transition-opacity"
              >
                Use a different email
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-5">
              <button
                onClick={handleGoogleLogin}
                className="mx-auto flex items-center gap-2 bg-ink text-paper px-6 py-3 hover:opacity-90 transition-colors font-sans text-[10px] uppercase tracking-widest cursor-pointer w-64 justify-center"
              >
                <LogIn size={14} />
                Continue with Google
              </button>

              <div className="flex items-center gap-3 w-64 opacity-40">
                <div className="h-px flex-1 bg-ink" />
                <span className="font-sans text-[9px] uppercase tracking-widest">or</span>
                <div className="h-px flex-1 bg-ink" />
              </div>

              <form onSubmit={handleSendMagicLink} noValidate className="flex flex-col items-center gap-5">
                <input
                  type="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="you@email.com"
                  autoComplete="email"
                  className="bg-transparent border-b-[0.5px] border-ink px-2 py-2 font-sans text-sm outline-none focus:border-opacity-50 transition-colors text-center w-64 placeholder:opacity-30"
                />
                <button
                  type="submit"
                  disabled={isSendingLink}
                  className="mx-auto flex items-center gap-2 border-[0.5px] border-ink px-6 py-3 hover:bg-ink hover:text-paper transition-colors font-sans text-[10px] uppercase tracking-widest cursor-pointer disabled:opacity-50"
                >
                  <LogIn size={14} />
                  {isSendingLink ? 'Sending...' : 'Email Me a Login Link'}
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    );
  }

  const handlePrevDay = () => {
    setSelectedDate(prev => {
      const d = new Date(prev);
      d.setDate(d.getDate() - 1);
      return d;
    });
  };

  const handleNextDay = () => {
    setSelectedDate(prev => {
      const d = new Date(prev);
      d.setDate(d.getDate() + 1);
      if (d > new Date()) return prev; // don't go to future
      return d;
    });
  };

  return (
    <div className="h-screen bg-paper text-ink font-serif flex flex-col selection:bg-ink selection:text-paper overflow-hidden print:overflow-visible print:bg-card print:h-auto">
      {/* Top Right Settings Button */}
      {!isAuthLoading && user && (
        <button 
          onClick={() => setShowSettings(true)} 
          className="absolute top-4 right-4 md:top-10 md:right-10 z-50 p-2 opacity-60 hover:opacity-100 transition-opacity print:hidden bg-paper/80 backdrop-blur-sm rounded-full"
        >
          <Settings size={20} strokeWidth={1.5} />
        </button>
      )}

      {/* Header Section */}
      <header className="flex flex-col md:flex-row md:justify-between md:items-end border-b-[0.5px] border-ink print:border-black p-4 md:px-10 md:pt-10 pb-6 gap-4 shrink-0 z-20 bg-paper print:bg-card">
        <div>
          <h1 className="text-4xl md:text-5xl tracking-tight leading-none mb-2 italic print:text-5xl print:mb-4">The Hourly</h1>
          <p className="font-sans text-[10px] uppercase tracking-[0.2em] opacity-60 print:text-[12px] print:opacity-80">A Synchronized Visual Journal</p>
          {groupsLoaded && groups.length > 0 && (
            <div className="flex items-center gap-2 mt-3 flex-wrap print:hidden">
              {groups.map(g => (
                <button
                  key={g.id}
                  onClick={() => setSelectedGroupId(g.id)}
                  className={`font-sans text-[10px] uppercase tracking-widest px-3 py-1.5 border-[0.5px] transition-colors ${
                    g.id === selectedGroupId
                      ? 'bg-ink text-paper border-ink'
                      : 'border-ink border-opacity-30 opacity-60 hover:opacity-100'
                  }`}
                >
                  {g.name}
                </button>
              ))}
              <button
                onClick={() => setShowCreateGroup(true)}
                className="font-sans text-[10px] uppercase tracking-widest px-3 py-1.5 border-[0.5px] border-dashed border-ink border-opacity-30 opacity-50 hover:opacity-100 transition-opacity"
              >
                + New Group
              </button>
            </div>
          )}
        </div>
        <div className="text-left md:text-right">
          <div className="text-2xl font-light print:text-black flex items-center md:justify-end gap-3">
            <div className="flex items-center gap-2 print:hidden">
              <button onClick={handlePrevDay} className="opacity-40 hover:opacity-100 transition-opacity"><ChevronLeft size={16} /></button>
              <span className="text-lg">
                {isSelectedDateToday ? 'Today' : selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
              <button onClick={handleNextDay} disabled={isSelectedDateToday} className={`transition-opacity ${isSelectedDateToday ? 'opacity-10 cursor-not-allowed' : 'opacity-40 hover:opacity-100'}`}><ChevronRight size={16} /></button>
            </div>
            
            {isSelectedDateToday && (
              <span className="print:hidden border-l border-ink border-opacity-20 pl-3">
                {currentTime.toLocaleTimeString('en-US', { 
                  hour12: activeUsers.find(u => u.id === user?.uid)?.settings?.timeFormat !== '24h', 
                  hour: '2-digit', 
                  minute: '2-digit', 
                  ...(referenceTimezone ? { timeZone: referenceTimezone } : {}) 
                })} 
              </span>
            )}
            <span className="hidden print:inline">{selectedDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} Chronicle</span>
            {isSelectedDateToday && (
              <span className="text-xs uppercase align-top ml-1 font-sans opacity-40 print:hidden">
                {referenceTimezone ? referenceTimezone.split('/').pop()?.replace(/_/g, ' ') : (Intl.DateTimeFormat().resolvedOptions().timeZone.split('/').pop()?.replace(/_/g, ' ') || 'LOCAL')}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* iOS install hint: without home-screen install, iPhones get no push */}
      {showIosHint && (
        <div className="flex items-center justify-between gap-3 bg-gold/15 border-b-[0.5px] border-gold/40 px-4 md:px-10 py-2.5 shrink-0 print:hidden">
          <span className="font-sans text-[11px] leading-snug">
            Get nudges on your iPhone: tap <span className="font-medium">Share</span> → <span className="font-medium">Add to Home Screen</span>, then open The Hourly from the icon.
          </span>
          <button
            onClick={() => { localStorage.setItem('iosHintDismissed', '1'); setShowIosHint(false); }}
            className="p-1.5 opacity-60 hover:opacity-100 transition-opacity shrink-0"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Main Matrix View */}
      <main className="flex-grow overflow-auto relative print:overflow-visible">
        {groupsLoaded && groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <ImageIcon size={48} strokeWidth={1} className="mb-4 opacity-60" />
            <p className="font-serif text-2xl italic mb-2">You're not in a group yet</p>
            <p className="font-sans text-[10px] uppercase tracking-[0.2em] opacity-50 mb-6">Create one, or ask someone to send you an invite link</p>
            <button
              onClick={() => setShowCreateGroup(true)}
              className="border-[0.5px] border-ink px-6 py-3 hover:bg-ink hover:text-paper transition-colors font-sans text-[10px] uppercase tracking-widest cursor-pointer"
            >
              Create a Group
            </button>
          </div>
        ) : (
        <div
          ref={collageRef}
          style={{ minWidth: Math.max(200, 48 + columnUsers.length * 88) }}
          className="max-w-4xl mx-auto px-2 md:px-10 pb-24 w-full print:px-0 print:pb-0"
        >
          {/* Column Headers (X-Axis: Names) */}
          <div className="sticky top-0 z-20 bg-paper pt-6 grid gap-2 md:gap-4 mb-4 border-b-[0.5px] border-ink pb-2 print:relative print:bg-card print:border-black print:pt-4" style={gridStyle}>
            <div className="sticky left-0 z-30 bg-paper font-sans text-[10px] uppercase tracking-widest self-end hidden md:block print:bg-card print:text-black">Hour / Slot</div>
            <div className="sticky left-0 z-30 bg-paper font-sans text-[10px] uppercase tracking-widest self-end md:hidden print:hidden">Time</div>
            {columnUsers.map(sibling => {
              // Split on any whitespace (incl. non-breaking spaces) so every
              // name renders as first name over last name.
              const nameParts = sibling.name.trim().split(/\s+/);
              return (
                <div key={sibling.id} className="flex flex-col items-center text-center">
                  <div className="relative w-fit">
                    <span className="block text-sm md:text-lg font-normal print:text-black leading-tight">
                      {nameParts[0]}
                      {nameParts.length > 1 && <br />}
                      {nameParts.slice(1).join(' ')}
                    </span>
                    <div className={`absolute -right-2 top-0 w-1.5 h-1.5 md:w-2 md:h-2 rounded-full transition-colors duration-1000 print:hidden ${isSiblingOnline(sibling.id) ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-ink opacity-20'}`} />
                  </div>
                  <span className="font-sans text-[8px] md:text-[9px] uppercase opacity-40 tracking-tighter truncate block max-w-full px-1 print:text-black print:opacity-60 mt-1">
                    {getSiblingLocation(sibling)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Content area */}
          <div className="space-y-6 md:space-y-4 print:space-y-8 relative">
            {displayedSlots.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-ink opacity-60">
                <ImageIcon size={48} strokeWidth={1} className="mb-4" />
                <p className="font-serif text-2xl italic mb-2">No photos yet</p>
                <p className="font-sans text-[10px] uppercase tracking-[0.2em]">Check back later or choose another date</p>
              </div>
            ) : (
              displayedSlots.map((slot, idx) => {
              // Assume first slot is current for demo purposes if it matches current hour, otherwise just style standard
              const isCurrent = isSelectedDateToday && new Date().getHours() === new Date(slot.hourKey).getHours();
              
              return (
                <div 
                  id={isCurrent ? 'current-hour-slot' : undefined}
                  key={slot.hourKey} 
                  className={`grid gap-2 md:gap-4 transition-colors print:page-break-inside-avoid print:h-[200px] ${
                    isCurrent ? 'outline outline-1 outline-offset-4 outline-gold bg-gold/5 print:outline-none print:bg-transparent' : ''
                  }`} 
                  style={gridStyle}
                >
                  <div className="sticky left-0 z-10 flex flex-col justify-center border-r-[0.5px] border-ink border-opacity-10 bg-paper print:border-black print:border-opacity-20 print:bg-card">
                    <span className={`text-lg md:text-xl font-light italic leading-tight print:text-2xl print:text-black ${isCurrent ? 'text-gold print:text-black' : ''}`}>
                      {slot.displayTime}
                    </span>
                    <span className={`font-sans text-[8px] md:text-[9px] uppercase mt-1 print:text-[10px] print:text-black print:opacity-60 ${isCurrent ? 'tracking-wide text-gold font-bold print:font-normal' : 'tracking-widest opacity-50'}`}>
                      {isCurrent ? <><span className="print:hidden whitespace-nowrap">Live Now</span><span className="hidden print:inline">{slot.displayDate}</span></> : slot.displayDate}
                    </span>
                  </div>
                  
                  {columnUsers.map(sibling => {
                    const photo = slot.photos[sibling.id];
                    return (
                      <div key={sibling.id} className="w-full max-w-[140px] md:max-w-[220px] aspect-square mx-auto">
                        {photo ? (
                          <div 
                            className={`h-full bg-card border-[0.5px] border-ink border-opacity-20 p-1 flex flex-col hover:border-opacity-60 transition-all duration-1000 cursor-pointer print:border-black print:border-opacity-30 ${
                              newPhotoIds.has(photo.id) ? 'ring-2 ring-gold ring-offset-2 ring-offset-paper animate-pulse shadow-[0_0_15px_rgba(197,160,89,0.3)] z-10 relative' : ''
                            }`}
                            onClick={() => setSelectedPhoto(photo)}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              handleReaction(photo.id, '❤️');
                            }}
                          >
                            <div className="bg-muted flex-grow relative overflow-hidden group print:bg-transparent">
                              {!loadedImages.has(photo.id) && (
                                <div className="absolute inset-0 bg-muted animate-pulse print:hidden" />
                              )}
                              <img
                                src={photo.thumbUrl || photo.imageUrl}
                                alt={`${sibling.name}'s photo at ${slot.displayTime}`}
                                onLoad={() => setLoadedImages(prev => new Set(prev).add(photo.id))}
                                className={`absolute inset-0 w-full h-full object-cover transition-all duration-700 print:opacity-100 ${loadedImages.has(photo.id) ? 'opacity-100' : 'opacity-0'}`}
                              />
                              <div className="absolute top-2 left-2 flex items-center gap-1 bg-black/40 backdrop-blur-sm rounded-full px-1.5 py-0.5 text-xs text-white opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                                <span className="font-sans text-[8px]">{getRelativeTime(photo.timestamp)}</span>
                              </div>
                              {photo.reactions && photo.reactions['❤️']?.length > 0 && (
                                <div className="absolute top-2 right-2 flex items-center gap-1 bg-card/80 backdrop-blur-sm rounded-full px-1.5 py-0.5 text-xs text-red-500 shadow-sm">
                                  <Heart size={10} className="fill-current" />
                                  <span className="font-sans text-[8px]">{photo.reactions['❤️'].length}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div
                            className={`h-full flex flex-col items-center justify-center transition-colors duration-500 print:bg-transparent print:border print:border-dashed print:border-black/20 ${isCurrent ? 'border-[0.5px] border-dashed border-gold' : 'border-[0.5px] border-dashed border-ink/15'} ${isCurrent && isNudging ? 'bg-gold/20 animate-pulse print:animate-none print:bg-transparent' : ''} ${(isCurrent && sibling.id === user?.uid) ? 'cursor-pointer hover:bg-gold/10' : ''}`}
                            onClick={() => { if (isCurrent && sibling.id === user?.uid) handleCaptureClick(); }}
                          >
                            {isCurrent && sibling.id === user?.uid && <Camera size={20} strokeWidth={1.5} className="text-gold mb-1 md:mb-2 opacity-60" />}
                            <span className={`font-sans text-[8px] md:text-[9px] uppercase tracking-widest transition-colors duration-500 text-center print:text-black/40 ${isCurrent ? 'text-gold opacity-60' : 'text-ink opacity-25'} ${isCurrent && isNudging ? 'opacity-100 font-bold' : ''}`}>
                              {isCurrent && sibling.id === user?.uid ? 'Upload' : (isCurrent && isNudging ? 'Nudged!' : (isCurrent ? 'Pending' : 'Missed'))}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            }))}
          </div>
        </div>
        )}
      </main>

      {/* Floating Action Button */}
      {user && !hasPostedThisHour && groups.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 print:hidden">
          <input 
            type="file" 
            accept="image/*" 
            capture="environment" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            className="hidden" 
          />
          <button 
            onClick={handleCaptureClick}
            disabled={isCapturing}
            className="bg-ink text-paper px-8 py-4 rounded-none flex items-center space-x-3 hover:opacity-90 transition-all shadow-2xl hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100 cursor-pointer disabled:cursor-wait"
          >
            <Camera size={16} strokeWidth={1.5} className={isCapturing ? "animate-pulse" : ""} />
            <span className="text-[10px] font-sans font-medium tracking-[0.2em] uppercase">
              {isCapturing ? 'Capturing...' : 'Capture'}
            </span>
          </button>
        </div>
      )}

      {/* Weekly Recap Button */}
      {groups.length > 0 && (
        <div className="fixed bottom-[4.75rem] right-6 z-50 print:hidden">
          <button
            onClick={() => setShowRecap(true)}
            className="bg-card/80 backdrop-blur-sm border-[0.5px] border-ink text-ink p-3 rounded-full hover:bg-card transition-all shadow-lg hover:scale-110 active:scale-95"
            title="This week's recap"
          >
            <Newspaper size={20} strokeWidth={1.5} />
          </button>
        </div>
      )}

      {/* Jump to Now Button */}
      <div className="fixed bottom-6 right-6 z-50 print:hidden">
        <button
          onClick={() => {
            if (!isSelectedDateToday) {
              setSelectedDate(new Date());
              setTimeout(() => {
                document.getElementById('current-hour-slot')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }, 100);
            } else {
              document.getElementById('current-hour-slot')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }}
          className="bg-card/80 backdrop-blur-sm border-[0.5px] border-ink text-ink p-3 rounded-full hover:bg-card transition-all shadow-lg hover:scale-110 active:scale-95 group flex items-center gap-2"
          title={isSelectedDateToday ? "Jump to current hour" : "Jump to today"}
        >
          {isSelectedDateToday ? <Clock size={20} strokeWidth={1.5} /> : <Calendar size={20} strokeWidth={1.5} />}
          <span className="text-[10px] font-sans font-medium tracking-[0.2em] uppercase hidden md:group-hover:inline max-w-0 md:group-hover:max-w-[100px] overflow-hidden transition-all duration-300 ease-in-out whitespace-nowrap">
            {isSelectedDateToday ? "Now" : "Today"}
          </span>
        </button>
      </div>

      {/* Missed Sync Toast */}
      {missedSiblings.length > 0 && (
        <div className="fixed bottom-24 right-6 md:bottom-28 md:right-10 z-50 animate-in slide-in-from-bottom-8 fade-in duration-500 print:hidden">
          <div className="bg-ink text-paper shadow-2xl p-4 md:p-5 flex flex-col gap-3 max-w-[280px] md:max-w-sm relative">
            <button 
              onClick={handleDismissNudge}
              className="absolute top-2 right-2 p-1 opacity-50 hover:opacity-100 transition-opacity"
              aria-label="Dismiss nudge"
            >
              <X size={14} />
            </button>
            <div className="flex items-start gap-3 mt-1">
              <Bell size={16} className="text-gold animate-pulse shrink-0 mt-0.5" />
              <div className="flex flex-col gap-1 pr-4">
                <span className="font-sans text-[10px] md:text-[11px] uppercase tracking-widest leading-tight text-gold font-bold">Sync Missed</span>
                <span className="font-serif text-sm opacity-90 leading-snug">
                  {missedSiblings.map(s => s.name).join(', ')} {missedSiblings.length > 1 ? 'are' : 'is'} 30m+ late to the {currentTime.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })} window.
                </span>
              </div>
            </div>
            {user && (
              <button onClick={handleNudge} disabled={isNudging} className="mt-1 border border-paper border-opacity-20 hover:border-opacity-100 bg-card/5 hover:bg-card/10 px-4 py-2 font-sans text-[9px] uppercase tracking-[0.2em] transition-all disabled:opacity-50 text-center">
                {isNudging ? 'Nudging...' : 'Send Auto-Nudge'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Full Screen Photo Modal */}
      {selectedPhoto && (
        <div className="fixed inset-0 z-[100] bg-paper flex flex-col items-center justify-center p-4 md:p-10 animate-in fade-in duration-300 print:hidden">
          <button 
            onClick={() => { setSelectedPhoto(null); setIsFullscreenPhoto(false); }}
            className="absolute top-6 left-6 md:top-10 md:left-10 z-50 flex items-center gap-2 font-sans text-[10px] uppercase tracking-[0.2em] hover:opacity-60 transition-opacity cursor-pointer"
          >
            <span className="text-xl leading-none">&larr;</span> Back to Matrix
          </button>
          
          <div className="absolute top-6 right-6 md:top-10 md:right-10 flex items-center gap-4 md:gap-8 z-50">
            {(selectedPhoto.metadata?.lat || (selectedPhoto.metadata?.location && selectedPhoto.metadata.location !== 'Unknown Location')) && (
              <button
                onClick={() => {
                  const m = selectedPhoto.metadata!;
                  // Prefer exact coordinates; fall back to searching the city name
                  const mapQuery = m.lat && m.lng ? `${m.lat},${m.lng}` : encodeURIComponent(m.location!);
                  window.open(`https://www.google.com/maps/search/?api=1&query=${mapQuery}`, '_blank');
                }}
                className="flex items-center gap-2 font-sans text-[10px] uppercase tracking-[0.2em] hover:opacity-100 transition-opacity cursor-pointer opacity-60"
              >
                <MapPin size={16} />
                <span className="hidden md:inline">Map</span>
              </button>
            )}
            <button
              onClick={handleSharePhoto}
              className="flex items-center gap-2 font-sans text-[10px] uppercase tracking-[0.2em] hover:opacity-100 transition-opacity cursor-pointer opacity-60"
            >
              <Share size={16} />
              <span className="hidden md:inline">Share</span>
            </button>
          </div>

          <div className={`${isFullscreenPhoto ? 'w-full h-full flex flex-col items-center justify-center p-0' : 'max-w-4xl w-full flex flex-col items-center gap-8 overflow-y-auto max-h-[90vh] py-10 px-4'} relative transition-all duration-300`}>
            {!isFullscreenPhoto && (
              <div className="flex flex-col items-center gap-2 mb-2 text-center">
                <span className="font-sans text-[10px] uppercase tracking-[0.2em] opacity-60">Chronicle by</span>
                <span className="font-serif text-3xl md:text-4xl italic">
                  {activeUsers.find(s => s.id === selectedPhoto.userId)?.name || 'Unknown'}
                </span>
              </div>
            )}
            
            <div 
              className={`relative flex items-center justify-center w-full group ${isFullscreenPhoto ? 'h-full' : ''}`}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              <button
                onClick={handleNextPhoto}
                disabled={sortedPhotos.findIndex(p => p.id === selectedPhoto.id) === 0}
                className="absolute left-0 md:left-4 z-10 p-4 opacity-0 group-hover:opacity-100 disabled:opacity-0 transition-opacity disabled:cursor-not-allowed hidden md:block"
                aria-label="Newer photo"
              >
                <ChevronLeft size={48} strokeWidth={1} className="text-ink drop-shadow-md hover:scale-110 transition-transform" />
              </button>

              <button
                onClick={handleNextPhoto}
                disabled={sortedPhotos.findIndex(p => p.id === selectedPhoto.id) === 0}
                className="absolute -left-2 z-10 p-2 md:hidden opacity-60 disabled:opacity-0"
              >
                <ChevronLeft size={32} strokeWidth={1} className="text-ink" />
              </button>

              <div className={`relative inline-block md:mx-20 ${isFullscreenPhoto ? 'w-full h-full flex items-center justify-center' : 'mx-8 max-w-full'}`}>
                <TransformWrapper doubleClick={{ disabled: true }} pinch={{ step: 5 }}>
                  <TransformComponent wrapperStyle={isFullscreenPhoto ? { width: '100%', height: '100%' } : {}}>
                    <img
                      src={selectedPhoto.imageUrl}
                      alt="Full screen view"
                      onDoubleClick={(e) => { e.stopPropagation(); handleDoubleTapHeart(); }}
                      className={`${isFullscreenPhoto ? 'h-screen w-auto max-w-full object-contain border-none p-0' : 'max-h-[50vh] md:max-h-[60vh] w-auto object-contain border-[0.5px] border-ink p-3 shadow-xl'} bg-card cursor-zoom-in transition-all`}
                    />
                  </TransformComponent>
                </TransformWrapper>

                {showHeartBurst && (
                  <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none">
                    <Heart size={96} className="text-red-500 fill-red-500 drop-shadow-lg animate-in zoom-in-50 fade-in duration-300" />
                  </div>
                )}

                <button
                  onClick={() => setIsFullscreenPhoto(!isFullscreenPhoto)}
                  className={`absolute ${isFullscreenPhoto ? 'top-4 right-4' : 'top-4 right-4'} z-50 p-2 bg-card/80 backdrop-blur-sm rounded-full opacity-60 hover:opacity-100 transition-opacity`}
                >
                  <Maximize size={16} className="text-ink" />
                </button>

              {!isFullscreenPhoto && (
                <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-card px-3 py-2 border-[0.5px] border-ink shadow-md rounded-full z-20">
                {['❤️', '🔥', '😂', '😮'].map(emoji => {
                  const count = (selectedPhoto.reactions?.[emoji] || []).length;
                  const hasReacted = (selectedPhoto.reactions?.[emoji] || []).includes(user?.uid || '');
                  return (
                    <button 
                      key={emoji}
                      onClick={() => handleToggleReaction(emoji)}
                      className={`flex items-center gap-1 px-2 py-1 rounded-full transition-colors ${hasReacted ? 'bg-paper' : 'hover:bg-ink/5'}`}
                    >
                      <span className="text-base leading-none">{emoji}</span>
                      {count > 0 && <span className="font-sans text-[10px] font-bold">{count}</span>}
                    </button>
                  );
                })}
              </div>
              )}
            </div>

              <button
                onClick={handlePrevPhoto}
                disabled={sortedPhotos.findIndex(p => p.id === selectedPhoto.id) === sortedPhotos.length - 1}
                className="absolute right-0 md:right-4 z-10 p-4 opacity-0 group-hover:opacity-100 disabled:opacity-0 transition-opacity disabled:cursor-not-allowed hidden md:block"
                aria-label="Older photo"
              >
                <ChevronRight size={48} strokeWidth={1} className="text-ink drop-shadow-md hover:scale-110 transition-transform" />
              </button>

              <button
                onClick={handlePrevPhoto}
                disabled={sortedPhotos.findIndex(p => p.id === selectedPhoto.id) === sortedPhotos.length - 1}
                className="absolute -right-2 z-10 p-2 md:hidden opacity-60 disabled:opacity-0"
              >
                <ChevronRight size={32} strokeWidth={1} className="text-ink" />
              </button>
            </div>
            
            <div className="flex flex-col items-center gap-3 text-center transition-all duration-500 mt-4">
              <div className="font-sans text-[10px] uppercase tracking-[0.2em] opacity-60">
                {renderTime(selectedPhoto.timestamp)}
              </div>
              {selectedPhoto.metadata && (
                <div className="flex flex-wrap items-center justify-center gap-4 md:gap-8 mt-6 font-sans text-[10px] uppercase tracking-widest border-t-[0.5px] border-ink pt-6 w-full max-w-lg animate-in fade-in slide-in-from-top-2">
                  {selectedPhoto.metadata.location && (
                    <div className="flex items-center gap-2">
                      {selectedPhoto.metadata.lat && selectedPhoto.metadata.lng ? (
                        <a 
                          href={`https://www.google.com/maps?q=${selectedPhoto.metadata.lat},${selectedPhoto.metadata.lng}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 hover:text-gold transition-colors"
                          title="Open in Google Maps"
                        >
                          <MapPin size={14} strokeWidth={1.5} className="opacity-70" />
                          <span className="underline decoration-[0.5px] underline-offset-2">{selectedPhoto.metadata.location}</span>
                        </a>
                      ) : (
                        <>
                          <MapPin size={14} strokeWidth={1.5} className="opacity-70" />
                          <span>{selectedPhoto.metadata.location}</span>
                        </>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Thermometer size={14} strokeWidth={1.5} className="opacity-70" />
                    <span>{renderTemperature(selectedPhoto.metadata.temperature)}</span>
                  </div>
                  {selectedPhoto.metadata.humidity !== undefined && (
                    <div className="flex items-center gap-2">
                      <Droplets size={14} strokeWidth={1.5} className="opacity-70" />
                      <span>{selectedPhoto.metadata.humidity}%</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Activity size={14} strokeWidth={1.5} className="opacity-70" />
                    <span>{selectedPhoto.metadata.noiseLevel} dB</span>
                  </div>
                </div>
              )}

              {/* Comments Section */}
              <div className="w-full max-w-md mt-6 text-left">
                <div className="flex flex-col gap-3 mb-6">
                  {(selectedPhoto.comments || []).map(comment => (
                    <div key={comment.id} className="bg-card p-3 border-[0.5px] border-ink shadow-sm flex flex-col gap-1 relative group">
                      <div className="flex items-center justify-between">
                        <span className="font-serif font-bold italic text-sm">{comment.userName}</span>
                        <div className="flex items-center gap-2">
                          <span className="font-sans text-[8px] uppercase tracking-widest opacity-40">
                            {renderTime(comment.timestamp)}
                          </span>
                          {user && user.uid === comment.userId && (
                            <button
                              onClick={() => handleDeleteComment(comment.id)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity text-red-600 hover:text-red-800"
                              aria-label="Delete comment"
                            >
                              <X size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                      <p className="font-sans text-xs pr-4">{comment.text}</p>
                    </div>
                  ))}
                </div>
                
                <form onSubmit={handleAddComment} className="flex gap-2 w-full">
                  <input
                    type="text"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Add a comment..."
                    className="flex-1 bg-transparent border-b-[0.5px] border-ink px-2 py-2 font-sans text-xs outline-none focus:border-opacity-50 transition-colors"
                  />
                  <button type="submit" disabled={!commentText.trim()} className="font-sans text-[10px] uppercase tracking-[0.2em] px-4 opacity-60 hover:opacity-100 transition-opacity disabled:opacity-30">
                    Post
                  </button>
                </form>

                {/* Tap-to-mention: typing @Name exactly is fragile on phones */}
                {activeUsers.filter(u => u.id !== user?.uid).length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    {activeUsers.filter(u => u.id !== user?.uid).map(u => {
                      const first = u.name.split(' ')[0];
                      return (
                        <button
                          key={u.id}
                          type="button"
                          onClick={() => setCommentText(prev => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}@${first} `)}
                          className="font-sans text-[10px] px-2.5 py-1 border-[0.5px] border-ink border-opacity-30 rounded-full opacity-50 hover:opacity-100 transition-opacity"
                        >
                          @{first}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Toasts */}
      {toasts.length > 0 && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[300] flex flex-col items-center gap-2 print:hidden">
          {toasts.map(t => (
            <div
              key={t.id}
              className={`px-5 py-3 shadow-2xl font-sans text-[10px] uppercase tracking-[0.2em] text-center animate-in fade-in slide-in-from-top-2 duration-300 ${
                t.type === 'error' ? 'bg-red-700 text-white' : 'bg-ink text-paper'
              }`}
            >
              {t.message}
            </div>
          ))}
        </div>
      )}

      {/* Capture: choose which group(s) to share to */}
      {pendingCaptureFile && (
        <div className="fixed inset-0 z-[250] bg-black/40 flex items-center justify-center p-4">
          <div className="bg-paper p-6 md:p-8 w-full max-w-sm shadow-2xl border-[0.5px] border-ink animate-in fade-in zoom-in-95 duration-200">
            <h2 className="font-serif text-xl italic mb-1">Share to</h2>
            <p className="font-sans text-[10px] uppercase tracking-widest opacity-50 mb-4">Choose which group(s) see this moment</p>
            {pendingPreviewUrl && (
              <div className="mb-5 bg-card border-[0.5px] border-ink border-opacity-20 p-1 w-28 h-28 mx-auto">
                <img src={pendingPreviewUrl} alt="Photo to share" className="w-full h-full object-cover" />
              </div>
            )}
            <div className="flex flex-col gap-3 mb-8">
              {groups.map(g => (
                <label key={g.id} className="flex items-center gap-3 cursor-pointer font-sans text-sm">
                  <input
                    type="checkbox"
                    checked={captureGroupIds.has(g.id)}
                    onChange={(e) => {
                      setCaptureGroupIds(prev => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(g.id); else next.delete(g.id);
                        return next;
                      });
                    }}
                  />
                  {g.name}
                </label>
              ))}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setPendingCaptureFile(null)}
                disabled={isCapturing}
                className="flex-1 border-[0.5px] border-ink py-2 font-sans text-[10px] uppercase tracking-widest opacity-60 hover:opacity-100 transition-opacity disabled:opacity-30"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmCaptureGroups}
                disabled={captureGroupIds.size === 0 || isCapturing}
                className="flex-1 bg-ink text-paper py-2 font-sans text-[10px] uppercase tracking-widest hover:opacity-90 transition-colors disabled:opacity-40"
              >
                {isCapturing ? 'Sharing...' : 'Share'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Group */}
      {showCreateGroup && (
        <div className="fixed inset-0 z-[250] bg-black/40 flex items-center justify-center p-4">
          <div className="bg-paper p-6 md:p-8 w-full max-w-sm shadow-2xl border-[0.5px] border-ink animate-in fade-in zoom-in-95 duration-200">
            <h2 className="font-serif text-xl italic mb-6">New Group</h2>
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateGroup(); }}
              placeholder="e.g. Friends"
              autoFocus
              className="w-full bg-transparent border-b-[0.5px] border-ink px-2 py-2 font-sans text-sm outline-none mb-8 placeholder:opacity-30"
            />
            <div className="flex gap-3">
              <button
                onClick={() => { setShowCreateGroup(false); setNewGroupName(''); }}
                className="flex-1 border-[0.5px] border-ink py-2 font-sans text-[10px] uppercase tracking-widest opacity-60 hover:opacity-100 transition-opacity"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateGroup}
                disabled={!newGroupName.trim()}
                className="flex-1 bg-ink text-paper py-2 font-sans text-[10px] uppercase tracking-widest hover:opacity-90 transition-colors disabled:opacity-40"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Weekly Recap — "The Weekly" */}
      {showRecap && recapData && (
        <div className="fixed inset-0 z-[150] bg-paper overflow-y-auto print:hidden animate-in fade-in duration-300">
          <button
            onClick={() => setShowRecap(false)}
            className="fixed top-5 right-5 z-[160] p-2 bg-paper/80 backdrop-blur-sm rounded-full opacity-70 hover:opacity-100 transition-opacity border-[0.5px] border-ink/20"
            aria-label="Close recap"
          >
            <X size={18} />
          </button>

          <div className="max-w-2xl mx-auto px-5 py-12">
            <div ref={recapRef} className="bg-paper px-1 py-2">
              {/* Masthead */}
              <div className="text-center mb-8">
                <p className="font-sans text-[9px] uppercase tracking-[0.35em] opacity-50 mb-2">The Hourly Presents</p>
                <h1 className="font-serif italic text-5xl leading-none mb-3">The Weekly</h1>
                <p className="font-sans text-[10px] uppercase tracking-[0.2em] opacity-60">
                  {selectedGroup?.name} · {recapData.rangeLabel}
                </p>
                <div className="mt-5 border-t-2 border-ink" />
                <div className="mt-[3px] border-t-[0.5px] border-ink" />
              </div>

              {recapData.weekPhotos.length === 0 ? (
                <div className="text-center py-16">
                  <p className="font-serif italic text-2xl mb-2">A quiet week</p>
                  <p className="font-sans text-[10px] uppercase tracking-[0.2em] opacity-50">No moments were chronicled these seven days</p>
                </div>
              ) : (
                <>
                  {/* Stats band */}
                  <div className="grid grid-cols-3 text-center mb-10">
                    <div>
                      <p className="font-serif text-3xl">{recapData.weekPhotos.length}</p>
                      <p className="font-sans text-[9px] uppercase tracking-[0.2em] opacity-50 mt-1">Moments</p>
                    </div>
                    <div className="border-x-[0.5px] border-ink/20">
                      <p className="font-serif text-3xl">{recapData.totalHearts}</p>
                      <p className="font-sans text-[9px] uppercase tracking-[0.2em] opacity-50 mt-1">Reactions</p>
                    </div>
                    <div>
                      <p className="font-serif text-3xl">{recapData.busiestHourLabel || '—'}</p>
                      <p className="font-sans text-[9px] uppercase tracking-[0.2em] opacity-50 mt-1">Golden Hour</p>
                    </div>
                  </div>

                  {/* Moment of the Week */}
                  {recapData.hero && (
                    <div className="mb-12 text-center">
                      <p className="font-sans text-[10px] uppercase tracking-[0.3em] text-gold mb-4">Moment of the Week</p>
                      <div className="bg-card border-[0.5px] border-ink/30 p-2 shadow-xl inline-block max-w-full">
                        <img
                          src={recapData.hero.imageUrl}
                          alt="Moment of the week"
                          crossOrigin="anonymous"
                          className="max-h-[420px] w-auto max-w-full object-contain"
                        />
                      </div>
                      <p className="font-serif italic text-lg mt-4">
                        {users[recapData.hero.userId]?.name.split(' ')[0] || 'Someone'}
                        {recapData.heartCount(recapData.hero) > 0 && (
                          <span className="font-sans not-italic text-xs opacity-60 ml-2">
                            {recapData.heartCount(recapData.hero)} ❤️
                          </span>
                        )}
                      </p>
                    </div>
                  )}

                  {/* Day by day */}
                  <div className="space-y-6 mb-12">
                    {recapData.days.map(day => (
                      <div key={day.label}>
                        <div className="flex items-baseline justify-between border-b-[0.5px] border-ink/20 pb-1 mb-3">
                          <span className="font-serif italic text-base">{day.label}</span>
                          <span className="font-sans text-[9px] uppercase tracking-[0.2em] opacity-40">
                            {day.dayPhotos.length > 0 ? `${day.dayPhotos.length} moment${day.dayPhotos.length === 1 ? '' : 's'}` : 'quiet day'}
                          </span>
                        </div>
                        {day.dayPhotos.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {day.dayPhotos.map(p => (
                              <div key={p.id} className="w-14 h-14 md:w-16 md:h-16 bg-card border-[0.5px] border-ink/20 p-0.5">
                                <img
                                  src={p.thumbUrl || p.imageUrl}
                                  alt=""
                                  crossOrigin="anonymous"
                                  className="w-full h-full object-cover"
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Contributors */}
                  <div className="mb-10">
                    <p className="font-sans text-[10px] uppercase tracking-[0.3em] opacity-50 text-center mb-4">The Contributors</p>
                    <div className="space-y-2">
                      {recapData.perPerson.map(({ user: u, count, hearts, daysPosted }) => (
                        <div key={u.id} className="flex items-baseline justify-between border-b-[0.5px] border-ink/10 pb-2">
                          <span className="font-serif italic text-base">{u.name}</span>
                          <span className="font-sans text-[10px] uppercase tracking-widest opacity-60">
                            {count} moment{count === 1 ? '' : 's'} · {hearts} ❤️ · {daysPosted}/7 days
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* Colophon */}
              <div className="text-center pt-2">
                <div className="border-t-[0.5px] border-ink mb-[3px]" />
                <div className="border-t-2 border-ink mb-5" />
                <p className="font-serif italic text-sm opacity-70">
                  Chronicled hour by hour, together.
                </p>
                <p className="font-sans text-[9px] uppercase tracking-[0.3em] opacity-40 mt-2">The Hourly</p>
              </div>
            </div>

            <div className="flex justify-center gap-3 mt-8 pb-6">
              <button
                onClick={handleSaveRecap}
                disabled={isSavingRecap}
                className="bg-ink text-paper px-6 py-3 font-sans text-[10px] uppercase tracking-widest hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {isSavingRecap ? 'Saving...' : 'Save as Image'}
              </button>
              <button
                onClick={() => setShowRecap(false)}
                className="border-[0.5px] border-ink px-6 py-3 font-sans text-[10px] uppercase tracking-widest opacity-70 hover:opacity-100 transition-opacity"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && user && (
        <div className="fixed inset-0 z-[200] bg-black/40 flex items-center justify-center p-4">
          <div className="bg-paper p-6 md:p-10 w-full max-w-md max-h-[90vh] overflow-y-auto shadow-2xl relative animate-in fade-in zoom-in-95 duration-200 border-[0.5px] border-ink">
            <button
              onClick={() => {
                handleSaveSettings({ displayLocation: localLocationInput });
                handleSaveName();
                setShowSettings(false);
              }}
              className="absolute top-4 right-4 opacity-60 hover:opacity-100 transition-opacity"
            >
              <X size={20} />
            </button>
            <h2 className="font-serif text-2xl italic mb-6">Settings</h2>

            <div className="space-y-1">
              {/* ---- Profile ---- */}
              <button
                onClick={() => setOpenSettingsSection(prev => (prev === 'profile' ? '' : 'profile'))}
                className="w-full flex items-center justify-between py-3 border-b-[0.5px] border-ink/20"
              >
                <span className="font-sans text-[11px] uppercase tracking-[0.2em]">Profile &amp; Display</span>
                <ChevronRight size={14} className={`opacity-50 transition-transform ${openSettingsSection === 'profile' ? 'rotate-90' : ''}`} />
              </button>
              {openSettingsSection === 'profile' && (
              <div className="space-y-6 py-4">
              <div className="flex flex-col gap-2">
                <label className="font-sans text-[10px] uppercase tracking-widest opacity-60">Display Name</label>
                <input
                  type="text"
                  value={localNameInput}
                  onChange={(e) => setLocalNameInput(e.target.value)}
                  onBlur={handleSaveName}
                  placeholder="First Last"
                  className="bg-transparent border-b-[0.5px] border-ink px-2 py-2 font-sans text-sm outline-none focus:border-opacity-50 transition-colors placeholder:opacity-30"
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="font-sans text-[10px] uppercase tracking-widest opacity-60">Display Location</label>
                <input
                  type="text"
                  value={localLocationInput}
                  onChange={(e) => setLocalLocationInput(e.target.value)}
                  onBlur={() => handleSaveSettings({ displayLocation: localLocationInput })}
                  placeholder="e.g. San Francisco"
                  className="bg-transparent border-b-[0.5px] border-ink px-2 py-2 font-sans text-sm outline-none focus:border-opacity-50 transition-colors placeholder:opacity-30"
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="font-sans text-[10px] uppercase tracking-widest opacity-60">Appearance</label>
                <div className="flex gap-4 font-sans text-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="theme"
                      value="light"
                      checked={users[user.uid]?.settings?.theme !== 'dark'}
                      onChange={(e) => e.target.checked && handleSaveSettings({ theme: 'light' })}
                    />
                    Light
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="theme"
                      value="dark"
                      checked={users[user.uid]?.settings?.theme === 'dark'}
                      onChange={(e) => e.target.checked && handleSaveSettings({ theme: 'dark' })}
                    />
                    Dark
                  </label>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label className="font-sans text-[10px] uppercase tracking-widest opacity-60">Temperature Unit</label>
                <div className="flex gap-4 font-sans text-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input 
                      type="radio" 
                      name="tempUnit" 
                      value="C"
                      checked={activeUsers.find(u => u.id === user.uid)?.settings?.temperatureUnit === 'C'}
                      onChange={(e) => e.target.checked && handleSaveSettings({ temperatureUnit: 'C' })}
                    />
                    Celsius (°C)
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input 
                      type="radio" 
                      name="tempUnit"
                      value="F" 
                      checked={(activeUsers.find(u => u.id === user.uid)?.settings?.temperatureUnit || 'F') === 'F'}
                      onChange={(e) => e.target.checked && handleSaveSettings({ temperatureUnit: 'F' })}
                    />
                    Fahrenheit (°F)
                  </label>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label className="font-sans text-[10px] uppercase tracking-widest opacity-60">Time Format</label>
                <div className="flex gap-4 font-sans text-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input 
                      type="radio" 
                      name="timeFormat"
                      value="12h" 
                      checked={activeUsers.find(u => u.id === user.uid)?.settings?.timeFormat !== '24h'}
                      onChange={(e) => e.target.checked && handleSaveSettings({ timeFormat: '12h' })}
                    />
                    12-hour
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input 
                      type="radio" 
                      name="timeFormat"
                      value="24h" 
                      checked={activeUsers.find(u => u.id === user.uid)?.settings?.timeFormat === '24h'}
                      onChange={(e) => e.target.checked && handleSaveSettings({ timeFormat: '24h' })}
                    />
                    24-hour
                  </label>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label className="font-sans text-[10px] uppercase tracking-widest opacity-60">Reference Timezone</label>
                <div className="flex items-center gap-2 font-sans text-sm">
                  <Globe size={14} className="opacity-60" />
                  <select 
                    value={referenceTimezone}
                    onChange={(e) => setReferenceTimezone(e.target.value)}
                    className="bg-transparent border-b-[0.5px] border-ink outline-none cursor-pointer w-full py-1"
                  >
                    <option value="">Local Time</option>
                    <optgroup label="Family">
                      {activeUsers.map(s => (
                        <option key={s.id} value={s.timezone}>{s.name}'s Time</option>
                      ))}
                    </optgroup>
                    <optgroup label="Global">
                      {STANDARD_TIMEZONES.map(tz => (
                        <option key={tz.value} value={tz.value}>{tz.label}</option>
                      ))}
                    </optgroup>
                  </select>
                </div>
              </div>
              </div>
              )}

              {/* ---- Group ---- */}
              {selectedGroup && (
                <>
                <button
                  onClick={() => setOpenSettingsSection(prev => (prev === 'group' ? '' : 'group'))}
                  className="w-full flex items-center justify-between py-3 border-b-[0.5px] border-ink/20"
                >
                  <span className="font-sans text-[11px] uppercase tracking-[0.2em]">Group — {selectedGroup.name}</span>
                  <ChevronRight size={14} className={`opacity-50 transition-transform ${openSettingsSection === 'group' ? 'rotate-90' : ''}`} />
                </button>
                {openSettingsSection === 'group' && (
                <div className="flex flex-col gap-4 py-4">
                  {/* Everyone is an admin — all controls available to all members */}
                  <input
                    type="text"
                    value={manageGroupName}
                    onChange={(e) => setManageGroupName(e.target.value)}
                    onBlur={handleRenameGroup}
                    className="bg-transparent border-b-[0.5px] border-ink px-2 py-2 font-sans text-sm outline-none focus:border-opacity-50 transition-colors"
                  />

                  <button onClick={handleCopyInviteLink} className="flex items-center gap-2 text-sm opacity-80 hover:opacity-100 transition-opacity w-fit">
                    <Share size={14} />
                    <span>Copy Invite Link</span>
                  </button>

                  <button onClick={handleRegenerateInvite} className="flex items-center gap-2 text-sm opacity-80 hover:opacity-100 transition-opacity w-fit">
                    <RefreshCw size={14} />
                    <span>Generate New Invite Link</span>
                  </button>

                  <div className="flex flex-col gap-1">
                    {groupMemberRoles.map(m => (
                      <div key={m.profileId} className="flex items-center justify-between font-sans text-sm py-1 gap-2">
                        <span className="truncate">
                          {users[m.profileId]?.name || 'Unknown'}
                          {m.role === 'owner' && <span className="opacity-40 text-[10px] uppercase ml-2">Creator</span>}
                        </span>
                        <div className="flex items-center gap-3 shrink-0">
                          {/* Only the creator can hand off the role */}
                          {isOwner && m.profileId !== user.uid && (
                            <button onClick={() => handleTransferOwnership(m.profileId)} className="font-sans text-[9px] uppercase tracking-widest opacity-50 hover:opacity-100 transition-opacity">
                              Make Creator
                            </button>
                          )}
                          {/* Admins can remove any non-creator member (not themselves) */}
                          {canAdmin && m.profileId !== user.uid && m.role !== 'owner' && (
                            <button onClick={() => handleRemoveMember(m.profileId)} className="text-red-600 opacity-60 hover:opacity-100 transition-opacity" aria-label="Remove member">
                              <X size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {groups.length > 1 && (
                    <div className="flex flex-col gap-2">
                      <label className="font-sans text-[10px] uppercase tracking-widest opacity-60">Import My Photos From</label>
                      <div className="flex gap-2">
                        <select
                          value={importSourceGroupId}
                          onChange={(e) => setImportSourceGroupId(e.target.value)}
                          className="flex-1 bg-transparent border-b-[0.5px] border-ink outline-none py-1 font-sans text-sm cursor-pointer"
                        >
                          <option value="">Choose a group...</option>
                          {groups.filter(g => g.id !== selectedGroup.id).map(g => (
                            <option key={g.id} value={g.id}>{g.name}</option>
                          ))}
                        </select>
                        <button
                          onClick={handleImportPhotos}
                          disabled={!importSourceGroupId || isImportingPhotos}
                          className="font-sans text-[10px] uppercase tracking-widest px-3 border-[0.5px] border-ink opacity-80 hover:opacity-100 transition-opacity disabled:opacity-30"
                        >
                          {isImportingPhotos ? '...' : 'Import'}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-6">
                    <button onClick={handleLeaveGroup} className="flex items-center gap-2 text-sm text-red-600 opacity-80 hover:opacity-100 transition-colors w-fit">
                      <LogOut size={14} />
                      <span>Leave Group</span>
                    </button>
                    {/* Deleting the whole group is creator-only */}
                    {isOwner && (
                      <button onClick={handleDeleteGroup} className="flex items-center gap-2 text-sm text-red-600 opacity-80 hover:opacity-100 transition-colors w-fit">
                        <Trash2 size={14} />
                        <span>Delete Group</span>
                      </button>
                    )}
                  </div>
                </div>
                )}
                </>
              )}

              {/* ---- Notifications ---- */}
              <button
                onClick={() => setOpenSettingsSection(prev => (prev === 'notifications' ? '' : 'notifications'))}
                className="w-full flex items-center justify-between py-3 border-b-[0.5px] border-ink/20"
              >
                <span className="font-sans text-[11px] uppercase tracking-[0.2em]">Notifications</span>
                <ChevronRight size={14} className={`opacity-50 transition-transform ${openSettingsSection === 'notifications' ? 'rotate-90' : ''}`} />
              </button>
              {openSettingsSection === 'notifications' && (
              <div className="flex flex-col gap-4 py-4">
                <div className="flex flex-col gap-3">
                  <button onClick={handleNudge} disabled={isNudging} className="flex items-center gap-2 text-sm opacity-80 hover:opacity-100 transition-opacity disabled:opacity-30 w-fit">
                    <Bell size={14} className={isNudging ? 'animate-bounce text-gold' : ''} />
                    <span>Send Nudge to Family</span>
                  </button>

                  {notificationPermission === 'default' && (
                    <button onClick={requestNotificationPermission} className="flex items-center gap-2 text-sm text-gold hover:opacity-100 transition-opacity w-fit">
                      <Bell size={14} />
                      <span>Enable Browser Alerts</span>
                    </button>
                  )}
                  {notificationPermission === 'granted' && (
                    <button
                      onClick={async () => {
                        if (profile) {
                          await api.registerPushSubscription(profile.id);
                          showToast('This device is registered for alerts', 'success');
                        }
                      }}
                      className="flex items-center gap-2 text-sm opacity-80 hover:opacity-100 transition-opacity w-fit"
                    >
                      <Bell size={14} className="text-green-600" />
                      <span>Alerts Enabled — Tap to Re-sync</span>
                    </button>
                  )}
                  {notificationPermission === 'denied' && (
                    <div className="flex items-center gap-2 text-sm opacity-60">
                      <Bell size={14} className="text-red-600" />
                      <span>Alerts blocked — allow notifications for this site in your browser settings</span>
                    </div>
                  )}

                  <div className="flex flex-col gap-2">
                    <label className="font-sans text-[10px] uppercase tracking-widest opacity-60">Notify Me About</label>
                    <div className="flex flex-col gap-2 font-sans text-sm">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={users[user.uid]?.settings?.notifyLikes !== false}
                          onChange={(e) => handleSaveSettings({ notifyLikes: e.target.checked })}
                        />
                        Likes on my photos
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={users[user.uid]?.settings?.notifyComments !== false}
                          onChange={(e) => handleSaveSettings({ notifyComments: e.target.checked })}
                        />
                        Comments &amp; mentions
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={users[user.uid]?.settings?.notifyReminders !== false}
                          onChange={(e) => handleSaveSettings({ notifyReminders: e.target.checked })}
                        />
                        Reminders to post (nudges &amp; new hour)
                      </label>
                    </div>
                  </div>
                </div>
              </div>
              )}

              {/* ---- Data & Account ---- */}
              <button
                onClick={() => setOpenSettingsSection(prev => (prev === 'data' ? '' : 'data'))}
                className="w-full flex items-center justify-between py-3 border-b-[0.5px] border-ink/20"
              >
                <span className="font-sans text-[11px] uppercase tracking-[0.2em]">Data &amp; Account</span>
                <ChevronRight size={14} className={`opacity-50 transition-transform ${openSettingsSection === 'data' ? 'rotate-90' : ''}`} />
              </button>
              {openSettingsSection === 'data' && (
              <div className="flex flex-col gap-4 py-4">
                <button onClick={() => window.print()} className="flex items-center gap-2 text-sm opacity-80 hover:opacity-100 transition-opacity w-fit">
                  <Download size={14} />
                  <span>Download Chronicle PDF</span>
                </button>
                <button onClick={handleExportCollage} disabled={isGeneratingCollage} className="flex items-center gap-2 text-sm opacity-80 hover:opacity-100 transition-opacity disabled:opacity-30 w-fit">
                  <ImageIcon size={14} />
                  <span>{isGeneratingCollage ? 'Exporting...' : 'Export Collage Image'}</span>
                </button>

                <div className="flex flex-col gap-4 pt-6 mt-2 border-t-[0.5px] border-ink/20">
                  <button onClick={handleLogout} className="flex items-center gap-2 text-sm opacity-60 hover:opacity-100 transition-opacity w-fit">
                    <LogOut size={14} />
                    <span>Logout</span>
                  </button>

                  <button onClick={handleAccountDeletion} className="flex items-center gap-2 text-sm text-red-600 opacity-80 hover:opacity-100 transition-colors w-fit">
                    <Trash2 size={14} />
                    <span>Delete My Account & Photos</span>
                  </button>
                </div>
              </div>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

