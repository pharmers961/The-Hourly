import { Photo, TimeSlot, User, PhotoMetadata } from './types';

// "America/Argentina/Buenos_Aires" -> "Buenos Aires"
export function formatTimezoneCity(timezone: string): string {
  if (!timezone) return 'Local';
  const parts = timezone.split('/');
  return (parts[parts.length - 1] || timezone).replace(/_/g, ' ');
}

// Current abbreviation for a zone (e.g. "PDT" in summer, "PST" in winter)
export function getTimezoneAbbreviation(timezone: string, date: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' }).formatToParts(date);
    return parts.find(p => p.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
}

// Fetch real environmental metadata at the moment of capture.
// Only fields we can actually measure are populated — nothing is fabricated.
export async function fetchEnvironmentalMetadata(): Promise<PhotoMetadata> {
  if (!('geolocation' in navigator)) return {};

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const metadata: PhotoMetadata = {};
        try {
          const { latitude, longitude } = position.coords;

          const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m`);
          const weatherData = await weatherRes.json();
          if (typeof weatherData.current?.temperature_2m === 'number') {
            metadata.temperature = weatherData.current.temperature_2m;
          }
          if (typeof weatherData.current?.relative_humidity_2m === 'number') {
            metadata.humidity = weatherData.current.relative_humidity_2m;
          }

          const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`);
          const geoData = await geoRes.json();
          const city = geoData.address?.city || geoData.address?.town || geoData.address?.village || geoData.address?.county;
          if (city) {
            metadata.location = city;
          }
        } catch (e) {
          console.warn('Failed to fetch environmental metadata', e);
        }
        resolve(metadata);
      },
      (error) => {
        console.warn('Geolocation error:', error);
        resolve({});
      },
      { timeout: 5000 }
    );
  });
}

// Local hour (0-23) in a given IANA timezone
export function getHourInTimezone(timezone: string, date: Date = new Date()): number {
  try {
    const hourStr = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).format(date);
    return parseInt(hourStr, 10) % 24;
  } catch {
    return date.getHours();
  }
}

// Night-time in the given zone — used to avoid nudging sleeping family members
export function isQuietHours(timezone: string, date: Date = new Date()): boolean {
  const hour = getHourInTimezone(timezone, date);
  return hour >= 22 || hour < 7;
}

export function formatRelativeTime(isoString: string, now: Date = new Date()): string {
  const then = new Date(isoString);
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${then.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
}

export function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800;
        const MAX_HEIGHT = 800;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.6));
      };
      img.onerror = (error) => reject(error);
    };
    reader.onerror = (error) => reject(error);
  });
}

export function groupPhotosByHour(photos: Photo[], users: User[], timeZone?: string, currentTime: Date = new Date()): TimeSlot[] {
  const slots = new Map<string, TimeSlot>();

  // Pre-fill today's slots from midnight to current hour
  const startOfDay = new Date(currentTime.getFullYear(), currentTime.getMonth(), currentTime.getDate(), 0);
  const currentHour = new Date(currentTime.getFullYear(), currentTime.getMonth(), currentTime.getDate(), currentTime.getHours());
  
  let iterDate = new Date(startOfDay.getTime());
  while (iterDate.getTime() <= currentHour.getTime()) {
    const hourKey = iterDate.toISOString();
    const displayTime = iterDate.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      hour12: true,
      ...(timeZone ? { timeZone } : {})
    });
    const dateString = iterDate.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      ...(timeZone ? { timeZone } : {})
    });

    slots.set(hourKey, {
      hourKey,
      displayTime,
      displayDate: dateString,
      photos: {}
    });
    
    // Add 1 hour
    iterDate.setHours(iterDate.getHours() + 1);
  }

  photos.forEach(photo => {
    const date = new Date(photo.timestamp);
    // Floor to the nearest hour to align into the same slot (e.g. 8:07am -> 8:00am)
    const hourKey = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).toISOString();

    if (!slots.has(hourKey)) {
      const displayDate = new Date(hourKey);
      const displayTime = displayDate.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        hour12: true,
        ...(timeZone ? { timeZone } : {})
      });
      const dateString = displayDate.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric',
        ...(timeZone ? { timeZone } : {})
      });

      slots.set(hourKey, {
        hourKey,
        displayTime,
        displayDate: dateString,
        photos: {}
      });
    }

    const slot = slots.get(hourKey)!;
    slot.photos[photo.userId] = photo;
  });

  // Convert to array and sort descending (newest first)
  return Array.from(slots.values()).sort((a, b) => new Date(b.hourKey).getTime() - new Date(a.hourKey).getTime());
}
