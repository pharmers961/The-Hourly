import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Camera, Thermometer, Activity, LogIn, LogOut, Bell, Download, Globe, X, Trash2, Info, MapPin, Droplets, Share, Settings, Moon } from 'lucide-react';
import { groupPhotosByHour, fetchEnvironmentalMetadata, compressImage, formatTimezoneCity, getTimezoneAbbreviation, isQuietHours, formatRelativeTime } from './utils';
import { db, auth } from './firebase';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, User as FirebaseUser } from 'firebase/auth';
import { collection, query, onSnapshot, setDoc, doc, doc as firestoreDoc, getDoc, serverTimestamp, writeBatch, where, addDoc, updateDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import { Photo, User as AppUser } from './types';

const DEVICE_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TZ_PROMPT_DISMISSED_KEY = 'hourly-tz-prompt-dismissed';

// Abbreviations (EST/EDT etc.) are derived at render time so they stay correct year-round
const STANDARD_TIMEZONES = [
  { label: 'New York', value: 'America/New_York' },
  { label: 'London', value: 'Europe/London' },
  { label: 'Paris', value: 'Europe/Paris' },
  { label: 'Tokyo', value: 'Asia/Tokyo' },
  { label: 'Sydney', value: 'Australia/Sydney' },
  { label: 'Los Angeles', value: 'America/Los_Angeles' },
];

export default function App() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [users, setUsers] = useState<Record<string, FirebaseUser & { lastActive?: string }>>({});
  const [isCapturing, setIsCapturing] = useState(false);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [showPhotoInfo, setShowPhotoInfo] = useState(false);
  const [isNudging, setIsNudging] = useState(false);
  const [referenceTimezone, setReferenceTimezone] = useState<string>('');
  const [showMenu, setShowMenu] = useState(false);
  const [tzPromptDismissed, setTzPromptDismissed] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const toastTimer = useRef<number | null>(null);

  const showToast = (message: string) => {
    setToastMessage(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMessage(null), 2500);
  };
  const [newPhotoIds, setNewPhotoIds] = useState<Set<string>>(new Set());
  const [dismissedNudgeHour, setDismissedNudgeHour] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const initialPhotoLoaded = useRef(false);
  const lastNotifiedHour = useRef<number | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    'Notification' in window ? Notification.permission : 'default'
  );

  const requestNotificationPermission = async () => {
    if ('Notification' in window) {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsAuthLoading(false);
      
      if (currentUser) {
        // Register or update user in Firestore
        const userRef = doc(db, 'users', currentUser.uid);
        const userDoc = await getDoc(userRef);
        
        let tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (userDoc.exists()) {
          tz = userDoc.data().timezone || tz;
        }

        await setDoc(userRef, {
          id: currentUser.uid,
          name: currentUser.displayName || 'Unknown',
          email: currentUser.email,
          timezone: tz,
          lastActive: new Date().toISOString()
        }, { merge: true });
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setPhotos([]);
      setUsers({});
      return;
    }

    let isFirstPhotosLoad = true;
    const photosQuery = query(collection(db, 'photos'));
    const unsubscribePhotos = onSnapshot(photosQuery, (snapshot) => {
      const photosData: Photo[] = [];
      const incomingNewIds = new Set<string>();
      
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' && !isFirstPhotosLoad) {
          incomingNewIds.add(change.doc.id);
        }
      });
      
      snapshot.forEach((doc) => {
        photosData.push({ id: doc.id, ...doc.data() } as Photo);
      });
      
      setPhotos(photosData);
      
      if (!initialPhotoLoaded.current) {
        const params = new URLSearchParams(window.location.search);
        const pId = params.get('photo');
        if (pId) {
          const p = photosData.find(x => x.id === pId);
          if (p) {
            setSelectedPhoto(p);
          }
        }
        initialPhotoLoaded.current = true;
      }
      
      if (incomingNewIds.size > 0) {
        setNewPhotoIds(prev => {
          const next = new Set(prev);
          incomingNewIds.forEach(id => next.add(id));
          return next;
        });
        setTimeout(() => {
          setNewPhotoIds(prev => {
            const next = new Set(prev);
            incomingNewIds.forEach(id => next.delete(id));
            return next;
          });
        }, 5000); // Pulse for 5 seconds
      }
      
      isFirstPhotosLoad = false;
    });

    const usersQuery = query(collection(db, 'users'));
    const unsubscribeUsers = onSnapshot(usersQuery, (snapshot) => {
      const usersData: Record<string, any> = {};
      snapshot.forEach((doc) => {
        usersData[doc.id] = doc.data();
      });
      setUsers(usersData);
    });

    let isFirstNudgesLoad = true;
    const nudgesQuery = query(collection(db, 'nudges'), where('toUserId', '==', user.uid));
    const unsubscribeNudges = onSnapshot(nudgesQuery, (snapshot) => {
      if (isFirstNudgesLoad) {
        isFirstNudgesLoad = false;
        return;
      }
      
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const nudge = change.doc.data();
          if (notificationPermission === 'granted') {
            new Notification('The Hourly: Nudge!', {
              body: `${nudge.fromUserName} nudged you to capture your moment!`,
              icon: '/favicon.svg'
            });
          }
        }
      });
    });

    return () => {
      unsubscribePhotos();
      unsubscribeUsers();
      unsubscribeNudges();
    };
  }, [user, notificationPermission]);

  useEffect(() => {
    if (initialPhotoLoaded.current) {
      const url = new URL(window.location.href);
      if (selectedPhoto) {
        url.searchParams.set('photo', selectedPhoto.id);
      } else {
        url.searchParams.delete('photo');
      }
      window.history.replaceState({}, '', url.toString());
    }
  }, [selectedPhoto]);

  useEffect(() => {
    if (selectedPhoto) {
      const updated = photos.find(p => p.id === selectedPhoto.id);
      if (updated && updated !== selectedPhoto) {
        setSelectedPhoto(updated);
      }
    }
  }, [photos, selectedPhoto]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirmClearOpen) {
        setConfirmClearOpen(false);
      } else if (selectedPhoto) {
        setSelectedPhoto(null);
        setShowPhotoInfo(false);
      } else if (showMenu) {
        setShowMenu(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirmClearOpen, selectedPhoto, showMenu]);

  const isSiblingOnline = (siblingId: string) => {
    if (user && user.uid === siblingId) return true;

    const dbUser = users[siblingId];
    if (dbUser?.lastActive) {
      const activeTime = new Date(dbUser.lastActive).getTime();
      return (Date.now() - activeTime) <= 60 * 60 * 1000; // Active within last hour
    }
    return false;
  };

  const [currentTime, setCurrentTime] = useState(new Date());

  const activeUsers: AppUser[] = useMemo(() => {
    return Object.values(users).map((u: any) => ({
      id: u.id || u.uid || '',
      name: u.name || 'Unknown',
      timezone: u.timezone || DEVICE_TIMEZONE,
      lastActive: u.lastActive
    }));
  }, [users]);

  const timeSlots = useMemo(() => groupPhotosByHour(photos, activeUsers, referenceTimezone, currentTime), [photos, activeUsers, referenceTimezone, currentTime]);

  // Profile timezone (stored in Firestore) vs the timezone this device is actually in
  const myStoredTimezone: string | undefined = user ? (users[user.uid] as any)?.timezone : undefined;
  const timezoneMismatch = !!myStoredTimezone && myStoredTimezone !== DEVICE_TIMEZONE;
  const tzDismissKey = `${myStoredTimezone}|${DEVICE_TIMEZONE}`;
  const showTimezoneBanner = timezoneMismatch && !tzPromptDismissed &&
    localStorage.getItem(TZ_PROMPT_DISMISSED_KEY) !== tzDismissKey;

  const profileTimezoneOptions = useMemo(() => {
    const options = [{ value: DEVICE_TIMEZONE, label: `Device — ${formatTimezoneCity(DEVICE_TIMEZONE)}` }];
    if (myStoredTimezone && myStoredTimezone !== DEVICE_TIMEZONE) {
      options.push({ value: myStoredTimezone, label: formatTimezoneCity(myStoredTimezone) });
    }
    STANDARD_TIMEZONES.forEach(tz => {
      if (!options.some(o => o.value === tz.value)) {
        options.push({ value: tz.value, label: tz.label });
      }
    });
    return options;
  }, [myStoredTimezone]);

  const handleUpdateProfileTimezone = async (timezone: string) => {
    if (!user) return;
    try {
      await updateDoc(doc(db, 'users', user.uid), { timezone });
      setTzPromptDismissed(true);
    } catch (err) {
      console.error('Failed to update profile timezone:', err);
    }
  };

  const handleKeepProfileTimezone = () => {
    localStorage.setItem(TZ_PROMPT_DISMISSED_KEY, tzDismissKey);
    setTzPromptDismissed(true);
  };

  const missedSiblings = useMemo(() => {
    // Only flag people once we're 30+ minutes into the current hour window
    if (currentTime.getMinutes() < 30) return [];

    const currentHourKey = new Date(currentTime.getFullYear(), currentTime.getMonth(), currentTime.getDate(), currentTime.getHours()).toISOString();

    if (dismissedNudgeHour === currentHourKey) return [];

    const currentSlot = timeSlots.find(s => s.hourKey === currentHourKey);

    return activeUsers.filter(sibling => {
      if (user && sibling.id === user.uid) return false;
      // Don't nudge family members during their local night
      if (isQuietHours(sibling.timezone, currentTime)) return false;
      if (!currentSlot) return true;
      return !currentSlot.photos[sibling.id];
    });
  }, [currentTime, timeSlots, dismissedNudgeHour, activeUsers, user]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      setCurrentTime(now);

      if (notificationPermission === 'granted') {
        const currentHour = now.getHours();
        // Notify at top of the hour (minute 0)
        if (now.getMinutes() === 0 && lastNotifiedHour.current !== currentHour) {
          new Notification('The Hourly', {
            body: 'A new hour has begun. Time to chronicle your moment.',
            icon: '/favicon.svg'
          });
          lastNotifiedHour.current = currentHour;
        }
      }
    }, 60000);
    return () => clearInterval(timer);
  }, [notificationPermission]);

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  const handleLogout = () => signOut(auth);

  const handleNudge = async () => {
    if (!user || missedSiblings.length === 0) return;
    setIsNudging(true);
    
    try {
      const batch = writeBatch(db);
      const currentHourKey = new Date(currentTime.getFullYear(), currentTime.getMonth(), currentTime.getDate(), currentTime.getHours()).toISOString();
      
      missedSiblings.forEach(sibling => {
        const nudgeRef = doc(collection(db, 'nudges'));
        batch.set(nudgeRef, {
          fromUserId: user.uid,
          fromUserName: user.displayName?.split(' ')[0] || 'Someone',
          toUserId: sibling.id,
          hourKey: currentHourKey,
          timestamp: serverTimestamp()
        });
      });
      
      await batch.commit();
      showToast(`Nudged ${missedSiblings.map(s => s.name).join(', ')}`);
    } catch (err) {
      console.error('Failed to send nudges:', err);
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

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !user) return;
    
    setIsCapturing(true);
    try {
      const compressedImageUrl = await compressImage(file);
      const metadata = await fetchEnvironmentalMetadata();
      const photoId = `p${Date.now()}`;
      const newPhoto: Record<string, unknown> = {
        id: photoId,
        userId: user.uid,
        timestamp: new Date().toISOString(),
        imageUrl: compressedImageUrl,
      };
      if (Object.keys(metadata).length > 0) {
        newPhoto.metadata = metadata;
      }

      await setDoc(doc(db, 'photos', photoId), newPhoto);
    } catch (err) {
      console.error('Capture error:', err);
    } finally {
      setIsCapturing(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleClearAllPhotos = async () => {
    try {
      const batch = writeBatch(db);
      // Only delete photos belonging to this user
      photos.filter(p => p.userId === user?.uid).forEach(photo => {
        batch.delete(doc(db, 'photos', photo.id));
      });
      await batch.commit();
      showToast('Your photos were cleared');
    } catch (err) {
      console.error('Failed to clear photos:', err);
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
      showToast('Link copied to clipboard');
    } catch (err) {
      console.error('Failed to copy link', err);
    }
  };

  const handleAddComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPhoto || !user || !commentText.trim()) return;

    try {
      const newComment = {
        id: Date.now().toString(),
        userId: user.uid,
        userName: user.displayName?.split(' ')[0] || 'Unknown',
        text: commentText.trim(),
        timestamp: new Date().toISOString()
      };

      await updateDoc(doc(db, 'photos', selectedPhoto.id), {
        comments: arrayUnion(newComment)
      });
      setCommentText('');
    } catch (err) {
      console.error('Failed to add comment:', err);
    }
  };

  const handleToggleReaction = async (emoji: string) => {
    if (!selectedPhoto || !user) return;
    try {
      const currentReactions = selectedPhoto.reactions || {};
      const emojiUsers = currentReactions[emoji] || [];
      const hasReacted = emojiUsers.includes(user.uid);
      
      if (hasReacted) {
        const newEmojiUsers = emojiUsers.filter(id => id !== user.uid);
        const newReactions = { ...currentReactions };
        if (newEmojiUsers.length === 0) {
          delete newReactions[emoji];
        } else {
          newReactions[emoji] = newEmojiUsers;
        }
        await updateDoc(doc(db, 'photos', selectedPhoto.id), {
          reactions: newReactions
        });
      } else {
        const newReactions = { ...currentReactions, [emoji]: [...emojiUsers, user.uid] };
        await updateDoc(doc(db, 'photos', selectedPhoto.id), {
          reactions: newReactions
        });
      }
    } catch (err) {
      console.error('Failed to toggle reaction:', err);
    }
  };

  const gridStyle = { gridTemplateColumns: `100px repeat(${activeUsers.length > 0 ? activeUsers.length : 1}, 1fr)` };

  if (isAuthLoading) {
    return (
      <div className="h-screen bg-[#F9F8F5] text-[#1A1A1A] font-serif flex flex-col items-center justify-center p-4">
        <h1 className="text-4xl tracking-tight italic animate-pulse">The Hourly</h1>
        <p className="font-sans text-[10px] uppercase tracking-[0.2em] opacity-40 mt-4">Opening the chronicle&hellip;</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen bg-[#F9F8F5] text-[#1A1A1A] font-serif flex flex-col items-center justify-center p-4 selection:bg-[#1A1A1A] selection:text-[#F9F8F5]">
        <div className="max-w-md text-center space-y-8">
          <div>
            <h1 className="text-4xl md:text-6xl tracking-tight leading-none mb-4 italic">The Hourly</h1>
            <p className="font-sans text-xs md:text-sm uppercase tracking-[0.2em] opacity-60">A Synchronized Visual Journal</p>
          </div>
          <button onClick={handleLogin} className="mx-auto flex items-center gap-2 border-[0.5px] border-[#1A1A1A] px-6 py-3 hover:bg-[#1A1A1A] hover:text-[#F9F8F5] transition-colors font-sans text-[10px] uppercase tracking-widest cursor-pointer">
            <LogIn size={14} />
            Sign In to Chronicle
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[#F9F8F5] text-[#1A1A1A] font-serif flex flex-col selection:bg-[#1A1A1A] selection:text-[#F9F8F5] overflow-hidden print:overflow-visible print:bg-white print:h-auto">
      {/* Header Section */}
      <header className="flex flex-col md:flex-row md:justify-between md:items-end border-b-[0.5px] border-[#1A1A1A] print:border-black p-4 md:px-10 md:pt-10 pb-6 gap-4 shrink-0 z-20 bg-[#F9F8F5] print:bg-white">
        <div>
          <h1 className="text-4xl md:text-5xl tracking-tight leading-none mb-2 italic print:text-5xl print:mb-4">The Hourly</h1>
          <p className="font-sans text-[10px] uppercase tracking-[0.2em] opacity-60 print:text-[12px] print:opacity-80">A Synchronized Visual Journal</p>
        </div>
        <div className="text-left md:text-right">
          <div className="font-sans text-[11px] uppercase tracking-widest flex items-center justify-start md:justify-end gap-4 mb-2 print:hidden">
            {!isAuthLoading && user && (
              <>
                <div className="flex items-center gap-1 opacity-60">
                  <Globe size={12} />
                  <select
                    value={referenceTimezone}
                    onChange={(e) => setReferenceTimezone(e.target.value)}
                    aria-label="View journal in timezone"
                    className="bg-transparent border-b border-[#1A1A1A] outline-none cursor-pointer max-w-[120px]"
                  >
                    <option value="">Local Time</option>
                    <optgroup label="Family">
                      {activeUsers.map(s => (
                        <option key={s.id} value={s.timezone}>{s.name}'s Time — {formatTimezoneCity(s.timezone)}</option>
                      ))}
                    </optgroup>
                    <optgroup label="Global">
                      {STANDARD_TIMEZONES.map(tz => (
                        <option key={tz.value} value={tz.value}>{tz.label} ({getTimezoneAbbreviation(tz.value)})</option>
                      ))}
                    </optgroup>
                  </select>
                </div>
                {missedSiblings.length > 0 && (
                  <button
                    onClick={handleNudge}
                    disabled={isNudging}
                    aria-label={`Nudge ${missedSiblings.length} family member${missedSiblings.length > 1 ? 's' : ''}`}
                    className="flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity disabled:opacity-30"
                  >
                    <Bell size={12} className={isNudging ? 'animate-bounce' : ''} />
                    <span>Nudge ({missedSiblings.length})</span>
                  </button>
                )}
                <div className="relative">
                  <button
                    onClick={() => setShowMenu(s => !s)}
                    aria-label="Menu"
                    aria-expanded={showMenu}
                    className={`flex items-center gap-1 transition-opacity ${showMenu ? 'opacity-100' : 'opacity-60 hover:opacity-100'}`}
                  >
                    <Settings size={12} />
                    <span className="hidden md:inline">Menu</span>
                  </button>
                  {showMenu && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                      <div className="absolute left-0 md:left-auto md:right-0 top-full mt-3 z-50 bg-[#F9F8F5] border-[0.5px] border-[#1A1A1A] shadow-xl w-64 text-left">
                        <div className="p-4 border-b-[0.5px] border-[#1A1A1A] border-opacity-20">
                          <div className="text-[9px] uppercase tracking-widest opacity-50 mb-2">Profile Timezone</div>
                          <select
                            value={myStoredTimezone || DEVICE_TIMEZONE}
                            onChange={(e) => handleUpdateProfileTimezone(e.target.value)}
                            aria-label="Profile timezone"
                            className="w-full bg-transparent border-b border-[#1A1A1A] outline-none cursor-pointer py-1 text-[11px] uppercase tracking-widest"
                          >
                            {profileTimezoneOptions.map(o => (
                              <option key={o.value} value={o.value}>{o.label} ({getTimezoneAbbreviation(o.value)})</option>
                            ))}
                          </select>
                          <p className="mt-2 text-[9px] tracking-wide opacity-50 leading-relaxed normal-case">
                            Shown under your name in the grid, and used when family members view the journal in your time.
                          </p>
                        </div>
                        <div className="p-2 flex flex-col">
                          <button onClick={() => { setShowMenu(false); window.print(); }} className="flex items-center gap-2 px-2 py-2 text-[10px] uppercase tracking-widest opacity-70 hover:opacity-100 hover:bg-[#1A1A1A]/5 transition-all text-left">
                            <Download size={12} />
                            Chronicle PDF
                          </button>
                          {notificationPermission === 'default' && (
                            <button onClick={() => { setShowMenu(false); requestNotificationPermission(); }} className="flex items-center gap-2 px-2 py-2 text-[10px] uppercase tracking-widest text-[#C5A059] opacity-80 hover:opacity-100 hover:bg-[#1A1A1A]/5 transition-all text-left">
                              <Bell size={12} />
                              Enable Alerts
                            </button>
                          )}
                          <button onClick={() => { setShowMenu(false); setConfirmClearOpen(true); }} className="flex items-center gap-2 px-2 py-2 text-[10px] uppercase tracking-widest opacity-70 hover:opacity-100 hover:text-red-600 hover:bg-red-600/5 transition-all text-left">
                            <Trash2 size={12} />
                            Clear My Photos
                          </button>
                          <button onClick={() => { setShowMenu(false); handleLogout(); }} className="flex items-center gap-2 px-2 py-2 text-[10px] uppercase tracking-widest opacity-70 hover:opacity-100 hover:bg-[#1A1A1A]/5 transition-all text-left">
                            <LogOut size={12} />
                            Logout
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="text-2xl font-light print:text-black">
            <span className="print:hidden">{currentTime.toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', ...(referenceTimezone ? { timeZone: referenceTimezone } : {}) })} </span>
            <span className="hidden print:inline">{new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} Chronicle</span>
            <span className="text-xs uppercase align-top ml-1 font-sans opacity-40 print:hidden">
              {formatTimezoneCity(referenceTimezone || DEVICE_TIMEZONE)}
            </span>
          </div>
        </div>
      </header>

      {/* Timezone Mismatch Banner */}
      {user && showTimezoneBanner && (
        <div className="shrink-0 z-10 border-b-[0.5px] border-[#C5A059] bg-[#C5A059]/10 px-4 md:px-10 py-3 flex flex-col md:flex-row md:items-center gap-2 md:gap-6 font-sans print:hidden">
          <div className="flex items-start md:items-center gap-2 text-[10px] md:text-[11px] uppercase tracking-widest leading-relaxed">
            <Globe size={12} className="text-[#C5A059] shrink-0 mt-0.5 md:mt-0" />
            <span>
              Your profile timezone is {formatTimezoneCity(myStoredTimezone!)} ({getTimezoneAbbreviation(myStoredTimezone!)}), but this device is in {formatTimezoneCity(DEVICE_TIMEZONE)} ({getTimezoneAbbreviation(DEVICE_TIMEZONE)}).
            </span>
          </div>
          <div className="flex items-center gap-4 md:ml-auto shrink-0">
            <button
              onClick={() => handleUpdateProfileTimezone(DEVICE_TIMEZONE)}
              className="border-[0.5px] border-[#1A1A1A] px-3 py-1.5 text-[9px] uppercase tracking-[0.2em] hover:bg-[#1A1A1A] hover:text-[#F9F8F5] transition-colors"
            >
              Update to {formatTimezoneCity(DEVICE_TIMEZONE)}
            </button>
            <button
              onClick={handleKeepProfileTimezone}
              className="text-[9px] uppercase tracking-[0.2em] opacity-60 hover:opacity-100 transition-opacity"
            >
              Keep {formatTimezoneCity(myStoredTimezone!)}
            </button>
          </div>
        </div>
      )}

      {/* Main Matrix View */}
      <main className="flex-grow overflow-auto relative print:overflow-visible">
        <div className="min-w-[600px] md:min-w-0 max-w-7xl mx-auto px-4 md:px-10 pb-24 w-full print:px-0 print:pb-0">
          {/* Column Headers (X-Axis: Names) */}
          <div className="sticky top-0 z-20 bg-[#F9F8F5] pt-6 grid gap-4 mb-4 border-b-[0.5px] border-[#1A1A1A] pb-2 print:relative print:bg-white print:border-black print:pt-4" style={gridStyle}>
            <div className="sticky left-0 z-30 bg-[#F9F8F5] font-sans text-[10px] uppercase tracking-widest self-end hidden md:block print:bg-white print:text-black">
              Hour
              <span className="block text-[8px] opacity-40 mt-0.5">{formatTimezoneCity(referenceTimezone || DEVICE_TIMEZONE)}</span>
            </div>
            <div className="sticky left-0 z-30 bg-[#F9F8F5] font-sans text-[10px] uppercase tracking-widest self-end md:hidden print:hidden">
              Time
              <span className="block text-[8px] opacity-40 mt-0.5">{formatTimezoneCity(referenceTimezone || DEVICE_TIMEZONE)}</span>
            </div>
            {activeUsers.map(sibling => (
              <div key={sibling.id} className="text-center">
                <div className="flex items-center justify-center gap-2">
                  <span className="block text-sm md:text-lg font-normal print:text-black">{sibling.name}</span>
                  <div className={`w-1.5 h-1.5 md:w-2 md:h-2 rounded-full transition-colors duration-1000 print:hidden ${isSiblingOnline(sibling.id) ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-[#1A1A1A] opacity-20'}`} />
                </div>
                <span className="font-sans text-[8px] md:text-[9px] uppercase opacity-40 tracking-tighter truncate block px-1 print:text-black print:opacity-60">
                  {formatTimezoneCity(sibling.timezone)} ({getTimezoneAbbreviation(sibling.timezone)})
                </span>
              </div>
            ))}
          </div>

          {/* Content area */}
          {photos.length === 0 && (
            <div className="text-center py-10 font-sans text-[10px] uppercase tracking-[0.2em] opacity-40 print:hidden">
              No moments captured yet &mdash; tap Capture below to begin today's chronicle
            </div>
          )}
          <div className="space-y-6 md:space-y-4 print:space-y-8">
            {timeSlots.map((slot, idx) => {
              // Assume first slot is current for demo purposes if it matches current hour, otherwise just style standard
              const isCurrent = new Date().getHours() === new Date(slot.hourKey).getHours() && new Date().getDate() === new Date(slot.hourKey).getDate();
              
              return (
                <div 
                  key={slot.hourKey} 
                  className={`grid gap-4 h-[120px] md:h-[160px] p-2 md:p-0 transition-colors print:page-break-inside-avoid print:h-[200px] ${
                    isCurrent ? 'outline outline-1 outline-offset-4 outline-[#C5A059] bg-[#C5A059] bg-opacity-5 print:outline-none print:bg-transparent' : ''
                  }`} 
                  style={gridStyle}
                >
                  <div className={`sticky left-0 z-10 flex flex-col justify-center border-r-[0.5px] border-[#1A1A1A] border-opacity-10 print:border-black print:border-opacity-20 print:bg-white ${isCurrent ? 'pl-2 bg-[#F6F4EE] print:pl-0' : 'bg-[#F9F8F5]'}`}>
                    <span className={`text-lg md:text-xl font-light italic leading-tight print:text-2xl print:text-black ${isCurrent ? 'text-[#C5A059] print:text-black' : ''}`}>
                      {slot.displayTime}
                    </span>
                    <span className={`font-sans text-[8px] md:text-[9px] uppercase tracking-widest mt-1 print:text-[10px] print:text-black print:opacity-60 ${isCurrent ? 'text-[#C5A059] font-bold print:font-normal' : 'opacity-50'}`}>
                      {isCurrent ? <><span className="print:hidden">Live Now</span><span className="hidden print:inline">{slot.displayDate}</span></> : slot.displayDate}
                    </span>
                  </div>
                  
                  {activeUsers.map(sibling => {
                    const photo = slot.photos[sibling.id];
                    return (
                      <div key={sibling.id} className="h-full">
                        {photo ? (
                          <div 
                            className={`h-full bg-white border-[0.5px] border-[#1A1A1A] border-opacity-20 p-1 flex flex-col hover:border-opacity-60 transition-all duration-1000 cursor-pointer print:border-black print:border-opacity-30 ${
                              newPhotoIds.has(photo.id) ? 'ring-2 ring-[#C5A059] ring-offset-2 ring-offset-[#F9F8F5] animate-pulse shadow-[0_0_15px_rgba(197,160,89,0.3)] z-10 relative' : ''
                            }`}
                            onClick={() => setSelectedPhoto(photo)}
                          >
                            <div className="bg-[#EAE8E4] flex-grow relative overflow-hidden group print:bg-transparent">
                              <img
                                src={photo.imageUrl}
                                alt={`${sibling.name}'s photo at ${slot.displayTime}`}
                                className="absolute inset-0 w-full h-full object-cover grayscale opacity-80 group-hover:grayscale-0 group-hover:opacity-100 transition-all duration-700 print:grayscale-0 print:opacity-100"
                              />
                              {photo.metadata && (photo.metadata.temperature !== undefined || photo.metadata.location) && (
                                <div className="absolute inset-x-0 bottom-0 p-2 md:p-3 bg-gradient-to-t from-black/60 via-black/30 to-transparent opacity-80 group-hover:opacity-100 transition-opacity duration-500 flex justify-between items-end print:opacity-100 print:bg-none print:bg-white/90">
                                  {photo.metadata.temperature !== undefined && (
                                    <div className="flex items-center space-x-1 text-white print:text-black">
                                      <Thermometer size={10} className="md:w-3 md:h-3 print:w-3 print:h-3" strokeWidth={2} />
                                      <span className="font-sans text-[8px] md:text-[10px]">{Math.round(photo.metadata.temperature)}°C</span>
                                    </div>
                                  )}
                                  {photo.metadata.location && (
                                    <div className="flex items-center space-x-1 text-white print:text-black ml-auto min-w-0">
                                      <span className="font-sans text-[8px] md:text-[10px] truncate">{photo.metadata.location}</span>
                                      <MapPin size={10} className="md:w-3 md:h-3 print:w-3 print:h-3 shrink-0" strokeWidth={2} />
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        ) : (() => {
                          const isResting = isCurrent && isQuietHours(sibling.timezone, currentTime);
                          return (
                            <div className={`h-full flex items-center justify-center gap-1.5 transition-colors duration-500 print:bg-transparent print:border print:border-dashed print:border-black/20 ${isCurrent ? 'border-[0.5px] border-dashed border-[#C5A059]' : 'border-[0.5px] border-dashed border-[#1A1A1A] border-opacity-15 bg-[#1A1A1A]/[0.03]'} ${isCurrent && isNudging && !isResting ? 'bg-[#C5A059] bg-opacity-20 animate-pulse print:animate-none print:bg-transparent' : ''}`}>
                              {isResting && <Moon size={10} className="text-[#C5A059] opacity-60 print:hidden" strokeWidth={1.5} />}
                              <span className={`font-sans text-[8px] md:text-[9px] uppercase tracking-widest transition-colors duration-500 print:text-black/40 ${isCurrent ? 'text-[#C5A059]' : 'text-[#1A1A1A] opacity-30'} ${isCurrent && isNudging && !isResting ? 'opacity-100 font-bold' : isCurrent ? 'opacity-60' : ''}`}>
                                {isCurrent ? (isResting ? 'Resting' : (isNudging ? 'Nudged!' : 'Pending...')) : 'Missed'}
                              </span>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </main>

      {/* Floating Action Button */}
      {user && (
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
            className="bg-[#1A1A1A] text-[#F9F8F5] px-8 py-4 rounded-none flex items-center space-x-3 hover:bg-black transition-all shadow-2xl hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100 cursor-pointer disabled:cursor-wait"
          >
            <Camera size={16} strokeWidth={1.5} className={isCapturing ? "animate-pulse" : ""} />
            <span className="text-[10px] font-sans font-medium tracking-[0.2em] uppercase">
              {isCapturing ? 'Capturing...' : 'Capture'}
            </span>
          </button>
        </div>
      )}

      {/* Missed Sync Toast */}
      {missedSiblings.length > 0 && (
        <div className="fixed bottom-24 right-4 md:bottom-10 md:right-10 z-50 animate-in slide-in-from-bottom-8 fade-in duration-500 print:hidden">
          <div className="bg-[#1A1A1A] text-[#F9F8F5] shadow-2xl p-4 md:p-5 flex flex-col gap-3 max-w-[280px] md:max-w-sm relative">
            <button 
              onClick={handleDismissNudge}
              className="absolute top-2 right-2 p-1 opacity-50 hover:opacity-100 transition-opacity"
              aria-label="Dismiss nudge"
            >
              <X size={14} />
            </button>
            <div className="flex items-start gap-3 mt-1">
              <Bell size={16} className="text-[#C5A059] animate-pulse shrink-0 mt-0.5" />
              <div className="flex flex-col gap-1 pr-4">
                <span className="font-sans text-[10px] md:text-[11px] uppercase tracking-widest leading-tight text-[#C5A059] font-bold">Sync Missed</span>
                <span className="font-serif text-sm opacity-90 leading-snug">
                  {missedSiblings.map(s => s.name).join(', ')} {missedSiblings.length > 1 ? 'are' : 'is'} 30m+ late to the {currentTime.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })} window.
                </span>
              </div>
            </div>
            {user && (
              <button onClick={handleNudge} disabled={isNudging} className="mt-1 border border-[#F9F8F5] border-opacity-20 hover:border-opacity-100 bg-white/5 hover:bg-white/10 px-4 py-2 font-sans text-[9px] uppercase tracking-[0.2em] transition-all disabled:opacity-50 text-center">
                {isNudging ? 'Nudging...' : 'Send Auto-Nudge'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Full Screen Photo Modal */}
      {selectedPhoto && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Photo detail"
          onClick={(e) => { if (e.target === e.currentTarget) { setSelectedPhoto(null); setShowPhotoInfo(false); } }}
          className="fixed inset-0 z-[100] bg-[#F9F8F5] flex flex-col items-center justify-center p-4 md:p-10 animate-in fade-in duration-300 print:hidden"
        >
          <button
            onClick={() => { setSelectedPhoto(null); setShowPhotoInfo(false); }}
            className="absolute top-6 left-6 md:top-10 md:left-10 flex items-center gap-2 font-sans text-[10px] uppercase tracking-[0.2em] hover:opacity-60 transition-opacity cursor-pointer"
          >
            <span className="text-xl leading-none">&larr;</span> Back to Matrix
          </button>

          <button
            onClick={handleSharePhoto}
            aria-label="Share photo"
            className={`absolute top-6 right-24 md:top-10 md:right-32 flex items-center gap-2 font-sans text-[10px] uppercase tracking-[0.2em] hover:opacity-100 transition-opacity cursor-pointer opacity-60`}
          >
            <Share size={16} />
            <span className="hidden md:inline">Share</span>
          </button>

          <button
            onClick={() => setShowPhotoInfo(!showPhotoInfo)}
            aria-label="Toggle photo info"
            aria-pressed={showPhotoInfo}
            className={`absolute top-6 right-6 md:top-10 md:right-10 flex items-center gap-2 font-sans text-[10px] uppercase tracking-[0.2em] hover:opacity-100 transition-opacity cursor-pointer ${showPhotoInfo ? 'opacity-100' : 'opacity-60'}`}
          >
            <Info size={16} />
            <span className="hidden md:inline">Info</span>
          </button>

          <div className="max-w-4xl w-full flex flex-col items-center gap-8 overflow-y-auto max-h-[90vh] py-10 px-4">
            <div className="relative inline-block">
              <img 
                src={selectedPhoto.imageUrl} 
                alt="Full screen view" 
                className="max-h-[50vh] md:max-h-[60vh] w-auto object-contain border-[0.5px] border-[#1A1A1A] p-3 bg-white shadow-xl" 
              />
              <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-white px-3 py-2 border-[0.5px] border-[#1A1A1A] shadow-md rounded-full">
                {['❤️', '🔥', '😂', '😮'].map(emoji => {
                  const count = (selectedPhoto.reactions?.[emoji] || []).length;
                  const hasReacted = (selectedPhoto.reactions?.[emoji] || []).includes(user?.uid || '');
                  return (
                    <button
                      key={emoji}
                      onClick={() => handleToggleReaction(emoji)}
                      aria-label={`React with ${emoji}${count > 0 ? ` (${count})` : ''}`}
                      aria-pressed={hasReacted}
                      className={`flex items-center gap-1 px-2 py-1 rounded-full transition-colors ${hasReacted ? 'bg-[#F9F8F5]' : 'hover:bg-gray-50'}`}
                    >
                      <span className="text-base leading-none">{emoji}</span>
                      {count > 0 && <span className="font-sans text-[10px] font-bold">{count}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-col items-center gap-3 text-center transition-all duration-500 mt-4">
              <div className="font-serif text-3xl italic">
                {activeUsers.find(s => s.id === selectedPhoto.userId)?.name || 'Unknown'}
              </div>
              <div className="font-sans text-[10px] uppercase tracking-[0.2em] opacity-60">
                {new Date(selectedPhoto.timestamp).toDateString() !== new Date().toDateString() &&
                  `${new Date(selectedPhoto.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · `}
                {new Date(selectedPhoto.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
              </div>
              {showPhotoInfo && selectedPhoto.metadata && Object.keys(selectedPhoto.metadata).length > 0 && (
                <div className="flex flex-wrap items-center justify-center gap-4 md:gap-8 mt-6 font-sans text-[10px] uppercase tracking-widest border-t-[0.5px] border-[#1A1A1A] pt-6 w-full max-w-lg animate-in fade-in slide-in-from-top-2">
                  {selectedPhoto.metadata.location && (
                    <div className="flex items-center gap-2">
                      <MapPin size={14} strokeWidth={1.5} className="opacity-70" />
                      <span>{selectedPhoto.metadata.location}</span>
                    </div>
                  )}
                  {selectedPhoto.metadata.temperature !== undefined && (
                    <div className="flex items-center gap-2">
                      <Thermometer size={14} strokeWidth={1.5} className="opacity-70" />
                      <span>{Math.round(selectedPhoto.metadata.temperature)}°C</span>
                    </div>
                  )}
                  {selectedPhoto.metadata.humidity !== undefined && (
                    <div className="flex items-center gap-2">
                      <Droplets size={14} strokeWidth={1.5} className="opacity-70" />
                      <span>{selectedPhoto.metadata.humidity}%</span>
                    </div>
                  )}
                  {selectedPhoto.metadata.noiseLevel !== undefined && (
                    <div className="flex items-center gap-2">
                      <Activity size={14} strokeWidth={1.5} className="opacity-70" />
                      <span>{selectedPhoto.metadata.noiseLevel} dB</span>
                    </div>
                  )}
                </div>
              )}

              {/* Comments Section */}
              <div className="w-full max-w-md mt-6 text-left">
                <div className="flex flex-col gap-3 mb-6">
                  {(selectedPhoto.comments || []).map(comment => (
                    <div key={comment.id} className="bg-white p-3 border-[0.5px] border-[#1A1A1A] shadow-sm flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <span className="font-serif font-bold italic text-sm">{comment.userName}</span>
                        <span className="font-sans text-[8px] uppercase tracking-widest opacity-40">
                          {formatRelativeTime(comment.timestamp, currentTime)}
                        </span>
                      </div>
                      <p className="font-sans text-xs">{comment.text}</p>
                    </div>
                  ))}
                </div>
                
                <form onSubmit={handleAddComment} className="flex gap-2 w-full">
                  <input
                    type="text"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Add a comment..."
                    aria-label="Add a comment"
                    className="flex-1 bg-transparent border-b-[0.5px] border-[#1A1A1A] px-2 py-2 font-sans text-xs outline-none focus:border-opacity-50 transition-colors"
                  />
                  <button type="submit" disabled={!commentText.trim()} className="font-sans text-[10px] uppercase tracking-[0.2em] px-4 opacity-60 hover:opacity-100 transition-opacity disabled:opacity-30">
                    Post
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Clear Photos Dialog */}
      {confirmClearOpen && (
        <div
          className="fixed inset-0 z-[120] bg-[#1A1A1A]/40 flex items-center justify-center p-6 print:hidden animate-in fade-in duration-200"
          onClick={(e) => { if (e.target === e.currentTarget) setConfirmClearOpen(false); }}
        >
          <div role="alertdialog" aria-modal="true" aria-label="Clear your photos" className="bg-[#F9F8F5] border-[0.5px] border-[#1A1A1A] shadow-2xl p-6 max-w-sm w-full">
            <h2 className="font-serif italic text-xl mb-2">Clear your photos?</h2>
            <p className="font-sans text-xs opacity-70 mb-6 leading-relaxed">
              This permanently deletes every photo you've captured. It cannot be undone.
            </p>
            <div className="flex justify-end items-center gap-4 font-sans text-[10px] uppercase tracking-[0.2em]">
              <button onClick={() => setConfirmClearOpen(false)} className="opacity-60 hover:opacity-100 transition-opacity">
                Cancel
              </button>
              <button
                onClick={() => { setConfirmClearOpen(false); handleClearAllPhotos(); }}
                className="border-[0.5px] border-red-600 text-red-600 px-3 py-1.5 hover:bg-red-600 hover:text-white transition-colors"
              >
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transient Toast */}
      {toastMessage && (
        <div role="status" className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[130] bg-[#1A1A1A] text-[#F9F8F5] px-4 py-2.5 font-sans text-[10px] uppercase tracking-[0.2em] shadow-xl print:hidden animate-in fade-in slide-in-from-bottom-2 duration-300">
          {toastMessage}
        </div>
      )}
    </div>
  );
}

