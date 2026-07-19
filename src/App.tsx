import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Camera, Thermometer, Activity, LogIn, LogOut, Bell, Download, Globe, X } from 'lucide-react';
import { groupPhotosByHour, fetchEnvironmentalMetadata, compressImage } from './utils';
import { db, auth } from './firebase';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, User as FirebaseUser } from 'firebase/auth';
import { collection, query, onSnapshot, setDoc, doc, doc as firestoreDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { Photo, User as AppUser } from './types';

export default function App() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [users, setUsers] = useState<Record<string, FirebaseUser & { lastActive?: string }>>({});
  const [isCapturing, setIsCapturing] = useState(false);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [isNudging, setIsNudging] = useState(false);
  const [referenceTimezone, setReferenceTimezone] = useState<string>('');
  const [newPhotoIds, setNewPhotoIds] = useState<Set<string>>(new Set());
  const [dismissedNudgeHour, setDismissedNudgeHour] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsAuthLoading(false);
      
      if (currentUser) {
        // Register or update user in Firestore
        const userRef = doc(db, 'users', currentUser.uid);
        const userDoc = await getDoc(userRef);
        
        // Find matching sibling to get their timezone, or default to generic
        const matchedUser = Object.values(usersData).find((s: any) => s.name?.toLowerCase() === currentUser.displayName?.split(' ')[0].toLowerCase());
        
        await setDoc(userRef, {
          id: currentUser.uid,
          name: currentUser.displayName || 'Unknown',
          email: currentUser.email,
          timezone: (matchedUser as any)?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
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

    return () => {
      unsubscribePhotos();
      unsubscribeUsers();
    };
  }, [user]);

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
    const timer = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  const handleLogout = () => signOut(auth);

  const handleNudge = () => {
    setIsNudging(true);
    setTimeout(() => {
      setIsNudging(false);
    }, 2000);
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

  const gridStyle = { gridTemplateColumns: `100px repeat(${activeUsers.length > 0 ? activeUsers.length : 1}, 1fr)` };

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
                    className="bg-transparent border-b border-[#1A1A1A] outline-none cursor-pointer"
                  >
                    <option value="">Local Time</option>
                    {activeUsers.map(s => (
                      <option key={s.id} value={s.timezone}>{s.name}'s Time</option>
                    ))}
                  </select>
                </div>
                <button onClick={() => window.print()} className="flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity">
                  <Download size={12} />
                  <span className="hidden md:inline">Chronicle PDF</span>
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
              {referenceTimezone ? referenceTimezone.split('/')[1] : (Intl.DateTimeFormat().resolvedOptions().timeZone.split('/')[1] || 'LOCAL')}
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
                  {sibling.timezone.replace('_', ' ')}
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
            onClick={() => setSelectedPhoto(null)}
            className="absolute top-6 left-6 md:top-10 md:left-10 flex items-center gap-2 font-sans text-[10px] uppercase tracking-[0.2em] hover:opacity-60 transition-opacity cursor-pointer"
          >
            <span className="text-xl leading-none">&larr;</span> Back to Matrix
          </button>
          
          <div className="max-w-4xl w-full flex flex-col items-center gap-8">
            <img 
              src={selectedPhoto.imageUrl} 
              alt="Full screen view" 
              className="max-h-[60vh] md:max-h-[70vh] w-auto object-contain border-[0.5px] border-[#1A1A1A] p-3 bg-white shadow-xl" 
            />
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="font-serif text-3xl italic">
                {activeUsers.find(s => s.id === selectedPhoto.userId)?.name || 'Unknown'}
              </div>
              <div className="font-sans text-[10px] uppercase tracking-[0.2em] opacity-60">
                {new Date(selectedPhoto.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
              </div>
              {selectedPhoto.metadata && (
                <div className="flex items-center gap-8 mt-6 font-sans text-[10px] uppercase tracking-widest border-t-[0.5px] border-[#1A1A1A] pt-6">
                  <div className="flex items-center gap-2">
                    <Thermometer size={14} strokeWidth={1.5} className="opacity-70" />
                    <span>{selectedPhoto.metadata.temperature}°C Ambient</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Activity size={14} strokeWidth={1.5} className="opacity-70" />
                    <span>{selectedPhoto.metadata.noiseLevel} dB Noise</span>
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

