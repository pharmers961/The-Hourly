import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Camera, Thermometer, Activity, LogIn, LogOut, Bell, Download, Globe, X, Trash2, Info, MapPin, Droplets, Share, ChevronLeft, ChevronRight } from 'lucide-react';
import { groupPhotosByHour, fetchEnvironmentalMetadata, compressImage } from './utils';
import { db, auth } from './firebase';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, User as FirebaseUser } from 'firebase/auth';
import { collection, query, onSnapshot, setDoc, doc, doc as firestoreDoc, getDoc, serverTimestamp, writeBatch, where, addDoc, updateDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import { Photo, User as AppUser } from './types';

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
      if (currentUser) {
        // Register or update user in Firestore
        const userRef = doc(db, 'users', currentUser.uid);
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

        await setDoc(userRef, {
          id: currentUser.uid,
          name: currentUser.displayName || 'Unknown',
          email: currentUser.email,
          timezone: tz,
          lastActive: new Date().toISOString()
        }, { merge: true });
        
        setUser(currentUser);
      } else {
        setUser(null);
      }
      setIsAuthLoading(false);
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
    }, (error) => {
      console.error('Error fetching photos:', error);
    });

    const usersQuery = query(collection(db, 'users'));
    const unsubscribeUsers = onSnapshot(usersQuery, (snapshot) => {
      const usersData: Record<string, any> = {};
      snapshot.forEach((doc) => {
        usersData[doc.id] = doc.data();
      });
      setUsers(usersData);
    }, (error) => {
      console.error('Error fetching users:', error);
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

  const isSiblingOnline = (siblingId: string, siblingName: string) => {
    // If it's the current user, they are online.
    if (user && (user.uid === siblingId || user.displayName?.toLowerCase().includes(siblingName.toLowerCase()))) {
      return true;
    }
    
    // Find the user in our fetched users by id, or loosely by name (for mock data mapping)
    const dbUser = users[siblingId] || Object.values(users).find(u => u.name?.toLowerCase().includes(siblingName.toLowerCase()));
    
    if (dbUser && dbUser.lastActive) {
      const activeTime = new Date(dbUser.lastActive).getTime();
      const now = new Date().getTime();
      return (now - activeTime) <= 60 * 60 * 1000; // Active within last hour
    }
    return false;
  };

  const [currentTime, setCurrentTime] = useState(new Date());

  const activeUsers: AppUser[] = useMemo(() => {
    return Object.values(users).map(u => ({
      id: (u as any).id || u.uid || '',
      name: (u as any).name || 'Unknown',
      timezone: (u as any).timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      lastActive: u.lastActive
    }));
  }, [users]);

  const timeSlots = useMemo(() => groupPhotosByHour(photos, activeUsers, referenceTimezone, currentTime), [photos, activeUsers, referenceTimezone, currentTime]);

  const sortedPhotos = useMemo(() => {
    return [...photos].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [photos]);

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

  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = () => {
    if (!touchStartX.current || !touchEndX.current) return;
    const distance = touchStartX.current - touchEndX.current;
    
    if (distance > 50) {
      // Swiped left (go to next/newer)
      handlePrevPhoto();
    } else if (distance < -50) {
      // Swiped right (go to prev/older)
      handleNextPhoto();
    }
    
    touchStartX.current = null;
    touchEndX.current = null;
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
      if (!currentSlot) return true; // No one has uploaded anything this hour yet
      return !currentSlot.photos[sibling.id];
    });
  }, [currentTime, timeSlots, dismissedNudgeHour, activeUsers]);

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
      const newPhoto = {
        id: photoId,
        userId: user.uid,
        timestamp: new Date().toISOString(),
        imageUrl: compressedImageUrl,
        metadata
      };
      
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
    if (!window.confirm('Are you sure you want to delete all your photos? This cannot be undone.')) return;
    
    try {
      const batch = writeBatch(db);
      // Only delete photos belonging to this user
      photos.filter(p => p.userId === user?.uid).forEach(photo => {
        batch.delete(doc(db, 'photos', photo.id));
      });
      await batch.commit();
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
      alert('Link copied to clipboard!');
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

  const handleDeleteComment = async (commentId: string) => {
    if (!selectedPhoto || !user) return;
    try {
      const commentToRemove = selectedPhoto.comments?.find(c => c.id === commentId);
      if (!commentToRemove) return;
      
      await updateDoc(doc(db, 'photos', selectedPhoto.id), {
        comments: arrayRemove(commentToRemove)
      });
    } catch (err) {
      console.error('Failed to delete comment:', err);
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

  const gridStyle = { gridTemplateColumns: `64px repeat(${activeUsers.length > 0 ? activeUsers.length : 1}, 1fr)` };

  const STANDARD_TIMEZONES = [
    { label: 'New York (EST)', value: 'America/New_York' },
    { label: 'London (GMT)', value: 'Europe/London' },
    { label: 'Paris (CET)', value: 'Europe/Paris' },
    { label: 'Tokyo (JST)', value: 'Asia/Tokyo' },
    { label: 'Sydney (AEST)', value: 'Australia/Sydney' },
    { label: 'Los Angeles (PST)', value: 'America/Los_Angeles' },
  ];

  if (!isAuthLoading && !user) {
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
                    className="bg-transparent border-b border-[#1A1A1A] outline-none cursor-pointer max-w-[120px]"
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
                <button onClick={() => window.print()} className="flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity">
                  <Download size={12} />
                  <span className="hidden md:inline">Chronicle PDF</span>
                </button>
                {notificationPermission === 'default' && (
                  <button onClick={requestNotificationPermission} className="flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity text-[#C5A059]">
                    <Bell size={12} />
                    <span className="hidden md:inline">Enable Alerts</span>
                  </button>
                )}
                <button onClick={handleClearAllPhotos} className="flex items-center gap-1 opacity-60 hover:text-red-600 hover:opacity-100 transition-colors">
                  <Trash2 size={12} />
                  <span className="hidden md:inline">Clear My Photos</span>
                </button>
                <button onClick={handleNudge} disabled={isNudging} className="flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity disabled:opacity-30">
                  <Bell size={12} className={isNudging ? 'animate-bounce' : ''} />
                  <span>Nudge</span>
                </button>
              </>
            )}
            {!isAuthLoading && (
              user ? (
                <button onClick={handleLogout} className="flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity">
                  <LogOut size={12} />
                  <span className="hidden md:inline">Logout</span>
                </button>
              ) : (
                <button onClick={handleLogin} className="flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity">
                  <LogIn size={12} />
                  <span>Login</span>
                </button>
              )
            )}
          </div>
          <div className="text-2xl font-light print:text-black">
            <span className="print:hidden">{currentTime.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', ...(referenceTimezone ? { timeZone: referenceTimezone } : {}) })} </span>
            <span className="hidden print:inline">{new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} Chronicle</span>
            <span className="text-xs uppercase align-top ml-1 font-sans opacity-40 print:hidden">
              {referenceTimezone ? referenceTimezone.split('/').pop()?.replace(/_/g, ' ') : (Intl.DateTimeFormat().resolvedOptions().timeZone.split('/').pop()?.replace(/_/g, ' ') || 'LOCAL')}
            </span>
          </div>
        </div>
      </header>

      {/* Main Matrix View */}
      <main className="flex-grow overflow-auto relative print:overflow-visible">
        <div className="min-w-[600px] md:min-w-0 max-w-7xl mx-auto px-4 md:px-10 pb-24 w-full print:px-0 print:pb-0">
          {/* Column Headers (X-Axis: Names) */}
          <div className="sticky top-0 z-20 bg-[#F9F8F5] pt-6 grid gap-4 mb-4 border-b-[0.5px] border-[#1A1A1A] pb-2 print:relative print:bg-white print:border-black print:pt-4" style={gridStyle}>
            <div className="sticky left-0 z-30 bg-[#F9F8F5] font-sans text-[10px] uppercase tracking-widest self-end hidden md:block print:bg-white print:text-black">Hour / Slot</div>
            <div className="sticky left-0 z-30 bg-[#F9F8F5] font-sans text-[10px] uppercase tracking-widest self-end md:hidden print:hidden">Time</div>
            {activeUsers.map(sibling => (
              <div key={sibling.id} className="text-center">
                <div className="flex items-center justify-center gap-2">
                  <span className="block text-sm md:text-lg font-normal print:text-black">{sibling.name}</span>
                  <div className={`w-1.5 h-1.5 md:w-2 md:h-2 rounded-full transition-colors duration-1000 print:hidden ${isSiblingOnline(sibling.id, sibling.name) ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-[#1A1A1A] opacity-20'}`} />
                </div>
                <span className="font-sans text-[8px] md:text-[9px] uppercase opacity-40 tracking-tighter truncate block px-1 print:text-black print:opacity-60">
                  {sibling.timezone.split('/').pop()?.replace(/_/g, ' ')}
                </span>
              </div>
            ))}
          </div>

          {/* Content area */}
          <div className="space-y-6 md:space-y-4 print:space-y-8">
            {timeSlots.map((slot, idx) => {
              // Assume first slot is current for demo purposes if it matches current hour, otherwise just style standard
              const isCurrent = new Date().getHours() === new Date(slot.hourKey).getHours() && new Date().getDate() === new Date(slot.hourKey).getDate();
              
              return (
                <div 
                  key={slot.hourKey} 
                  className={`grid gap-4 p-2 md:p-0 transition-colors print:page-break-inside-avoid print:h-[200px] ${
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
                      <div key={sibling.id} className="w-full max-w-[140px] md:max-w-[220px] aspect-square mx-auto">
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
                                className="absolute inset-0 w-full h-full object-cover transition-all duration-700 print:opacity-100"
                              />
                              {photo.metadata && (
                                <div className="absolute inset-x-0 bottom-0 p-2 md:p-3 bg-gradient-to-t from-black/60 via-black/30 to-transparent opacity-80 group-hover:opacity-100 transition-opacity duration-500 flex justify-between items-end print:opacity-100 print:bg-none print:bg-white/90">
                                  <div className="flex items-center space-x-1 text-white print:text-black">
                                    <Thermometer size={10} className="md:w-3 md:h-3 print:w-3 print:h-3" strokeWidth={2} />
                                    <span className="font-sans text-[8px] md:text-[10px]">{photo.metadata.temperature}°C</span>
                                  </div>
                                  <div className="flex items-center space-x-1 text-white print:text-black">
                                    <span className="font-sans text-[8px] md:text-[10px]">{photo.metadata.noiseLevel} dB</span>
                                    <Activity size={10} className="md:w-3 md:h-3 print:w-3 print:h-3" strokeWidth={2} />
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div className={`h-full flex items-center justify-center transition-colors duration-500 print:bg-transparent print:border print:border-dashed print:border-black/20 ${isCurrent ? 'border-[0.5px] border-dashed border-[#C5A059]' : 'bg-[#1A1A1A]'} ${isCurrent && isNudging ? 'bg-[#C5A059] bg-opacity-20 animate-pulse print:animate-none print:bg-transparent' : ''}`}>
                            <span className={`font-sans text-[8px] md:text-[9px] uppercase tracking-widest transition-colors duration-500 print:text-black/40 ${isCurrent ? 'text-[#C5A059]' : 'text-[#F9F8F5]'} ${isCurrent && isNudging ? 'opacity-100 font-bold' : 'opacity-60'}`}>
                              {isCurrent && isNudging ? 'Nudged!' : (isCurrent ? 'Pending...' : 'Missed Moment')}
                            </span>
                          </div>
                        )}
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
        <div className="fixed bottom-6 right-6 md:bottom-10 md:right-10 z-50 animate-in slide-in-from-bottom-8 fade-in duration-500 print:hidden">
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
        <div className="fixed inset-0 z-[100] bg-[#F9F8F5] flex flex-col items-center justify-center p-4 md:p-10 animate-in fade-in duration-300 print:hidden">
          <button 
            onClick={() => { setSelectedPhoto(null); setShowPhotoInfo(false); }}
            className="absolute top-6 left-6 md:top-10 md:left-10 flex items-center gap-2 font-sans text-[10px] uppercase tracking-[0.2em] hover:opacity-60 transition-opacity cursor-pointer"
          >
            <span className="text-xl leading-none">&larr;</span> Back to Matrix
          </button>
          
          <button
            onClick={handleSharePhoto}
            className={`absolute top-6 right-24 md:top-10 md:right-32 flex items-center gap-2 font-sans text-[10px] uppercase tracking-[0.2em] hover:opacity-100 transition-opacity cursor-pointer opacity-60`}
          >
            <Share size={16} />
            <span className="hidden md:inline">Share</span>
          </button>

          <button
            onClick={() => setShowPhotoInfo(!showPhotoInfo)}
            className={`absolute top-6 right-6 md:top-10 md:right-10 flex items-center gap-2 font-sans text-[10px] uppercase tracking-[0.2em] hover:opacity-100 transition-opacity cursor-pointer ${showPhotoInfo ? 'opacity-100' : 'opacity-60'}`}
          >
            <Info size={16} />
            <span className="hidden md:inline">Info</span>
          </button>

          <div className="max-w-4xl w-full flex flex-col items-center gap-8 overflow-y-auto max-h-[90vh] py-10 px-4 relative">
            <div className="flex flex-col items-center gap-2 mb-2 text-center">
              <span className="font-sans text-[10px] uppercase tracking-[0.2em] opacity-60">Chronicle by</span>
              <span className="font-serif text-3xl md:text-4xl italic">
                {activeUsers.find(s => s.id === selectedPhoto.userId)?.name || 'Unknown'}
              </span>
            </div>
            
            <div 
              className="relative flex items-center justify-center w-full group"
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
                <ChevronLeft size={48} strokeWidth={1} className="text-[#1A1A1A] drop-shadow-md hover:scale-110 transition-transform" />
              </button>

              <button
                onClick={handleNextPhoto}
                disabled={sortedPhotos.findIndex(p => p.id === selectedPhoto.id) === 0}
                className="absolute -left-2 z-10 p-2 md:hidden opacity-60 disabled:opacity-0"
              >
                <ChevronLeft size={32} strokeWidth={1} className="text-[#1A1A1A]" />
              </button>

              <div className="relative inline-block mx-8 md:mx-20">
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
                      className={`flex items-center gap-1 px-2 py-1 rounded-full transition-colors ${hasReacted ? 'bg-[#F9F8F5]' : 'hover:bg-gray-50'}`}
                    >
                      <span className="text-base leading-none">{emoji}</span>
                      {count > 0 && <span className="font-sans text-[10px] font-bold">{count}</span>}
                    </button>
                  );
                })}
              </div>
            </div>

              <button
                onClick={handlePrevPhoto}
                disabled={sortedPhotos.findIndex(p => p.id === selectedPhoto.id) === sortedPhotos.length - 1}
                className="absolute right-0 md:right-4 z-10 p-4 opacity-0 group-hover:opacity-100 disabled:opacity-0 transition-opacity disabled:cursor-not-allowed hidden md:block"
                aria-label="Older photo"
              >
                <ChevronRight size={48} strokeWidth={1} className="text-[#1A1A1A] drop-shadow-md hover:scale-110 transition-transform" />
              </button>

              <button
                onClick={handlePrevPhoto}
                disabled={sortedPhotos.findIndex(p => p.id === selectedPhoto.id) === sortedPhotos.length - 1}
                className="absolute -right-2 z-10 p-2 md:hidden opacity-60 disabled:opacity-0"
              >
                <ChevronRight size={32} strokeWidth={1} className="text-[#1A1A1A]" />
              </button>
            </div>
            
            <div className="flex flex-col items-center gap-3 text-center transition-all duration-500 mt-4">
              <div className="font-sans text-[10px] uppercase tracking-[0.2em] opacity-60">
                {new Date(selectedPhoto.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
              </div>
              {showPhotoInfo && selectedPhoto.metadata && (
                <div className="flex flex-wrap items-center justify-center gap-4 md:gap-8 mt-6 font-sans text-[10px] uppercase tracking-widest border-t-[0.5px] border-[#1A1A1A] pt-6 w-full max-w-lg animate-in fade-in slide-in-from-top-2">
                  {selectedPhoto.metadata.location && (
                    <div className="flex items-center gap-2">
                      <MapPin size={14} strokeWidth={1.5} className="opacity-70" />
                      <span>{selectedPhoto.metadata.location}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Thermometer size={14} strokeWidth={1.5} className="opacity-70" />
                    <span>{selectedPhoto.metadata.temperature}°C</span>
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
                    <div key={comment.id} className="bg-white p-3 border-[0.5px] border-[#1A1A1A] shadow-sm flex flex-col gap-1 relative group">
                      <div className="flex items-center justify-between">
                        <span className="font-serif font-bold italic text-sm">{comment.userName}</span>
                        <div className="flex items-center gap-2">
                          <span className="font-sans text-[8px] uppercase tracking-widest opacity-40">
                            {new Date(comment.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
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
    </div>
  );
}

