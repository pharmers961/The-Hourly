import { Photo, TimeSlot, User, PhotoMetadata } from './types';

// Extract GPS coordinates from a JPEG's EXIF data, so the photo's actual
// capture location is used even when it was taken earlier or somewhere else.
export function extractExifGps(file: File): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      try {
        const view = new DataView(reader.result as ArrayBuffer);
        if (view.getUint16(0) !== 0xFFD8) return resolve(null); // not a JPEG
        let offset = 2;
        while (offset + 4 <= view.byteLength) {
          const marker = view.getUint16(offset);
          if (marker === 0xFFE1) return resolve(parseExifGps(view, offset + 4));
          if ((marker & 0xFF00) !== 0xFF00) break;
          offset += 2 + view.getUint16(offset + 2);
        }
        resolve(null);
      } catch {
        resolve(null);
      }
    };
    // EXIF lives in the first segments of the file
    reader.readAsArrayBuffer(file.slice(0, 256 * 1024));
  });
}

function parseExifGps(view: DataView, start: number): { lat: number; lng: number } | null {
  if (view.getUint32(start) !== 0x45786966) return null; // "Exif"
  const tiff = start + 6;
  const little = view.getUint16(tiff) === 0x4949;
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);

  const ifd0 = tiff + u32(tiff + 4);
  let gpsIfd = 0;
  for (let i = 0, n = u16(ifd0); i < n; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (u16(entry) === 0x8825) {
      gpsIfd = tiff + u32(entry + 8);
      break;
    }
  }
  if (!gpsIfd) return null;

  // Degrees/minutes/seconds are stored as three rationals (numerator/denominator pairs)
  const readRationals = (entry: number) => {
    const valueOffset = tiff + u32(entry + 8);
    const values: number[] = [];
    for (let i = 0; i < 3; i++) {
      values.push(u32(valueOffset + i * 8) / u32(valueOffset + i * 8 + 4));
    }
    return values;
  };

  let latRef = '', lngRef = '';
  let latVals: number[] | null = null, lngVals: number[] | null = null;
  for (let i = 0, n = u16(gpsIfd); i < n; i++) {
    const entry = gpsIfd + 2 + i * 12;
    const tag = u16(entry);
    if (tag === 1) latRef = String.fromCharCode(view.getUint8(entry + 8));
    else if (tag === 2) latVals = readRationals(entry);
    else if (tag === 3) lngRef = String.fromCharCode(view.getUint8(entry + 8));
    else if (tag === 4) lngVals = readRationals(entry);
  }
  if (!latVals || !lngVals) return null;

  const toDecimal = ([d, m, s]: number[]) => d + m / 60 + s / 3600;
  const lat = toDecimal(latVals) * (latRef === 'S' ? -1 : 1);
  const lng = toDecimal(lngVals) * (lngRef === 'W' ? -1 : 1);
  if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

// Helper function to fetch environmental metadata at the moment of capture.
// Prefers the photo's own EXIF GPS coordinates when provided; otherwise falls
// back to the device's current position. The city is always reverse-geocoded
// from the coordinates so it reflects where the photo was actually taken;
// fallbackLocation is only used when no coordinates are available.
export async function fetchEnvironmentalMetadata(fallbackLocation?: string, coords?: { lat: number; lng: number }): Promise<PhotoMetadata> {
  const defaultData: PhotoMetadata = {
    temperature: Math.floor(Math.random() * (35 - 10) + 10),
    noiseLevel: Math.floor(Math.random() * (90 - 30) + 30),
    humidity: 50,
    location: fallbackLocation || 'Unknown Location',
  };

  const buildFromCoords = async (latitude: number, longitude: number): Promise<PhotoMetadata> => {
    // Fetch weather from open-meteo
    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m`);
    const weatherData = await weatherRes.json();

    let city: string | undefined;
    try {
      // Fetch location name from openstreetmap nominatim
      const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`);
      const geoData = await geoRes.json();
      city = geoData.address?.city || geoData.address?.town || geoData.address?.village || geoData.address?.county;
    } catch (e) {
      console.warn('Reverse geocoding failed', e);
    }

    return {
      temperature: weatherData.current?.temperature_2m || defaultData.temperature,
      humidity: weatherData.current?.relative_humidity_2m || defaultData.humidity,
      location: city || fallbackLocation || 'Unknown Location',
      lat: latitude,
      lng: longitude,
      noiseLevel: defaultData.noiseLevel, // We can't get this easily from browser
    };
  };

  if (coords) {
    try {
      return await buildFromCoords(coords.lat, coords.lng);
    } catch (e) {
      console.error('Failed to fetch real data', e);
      return { ...defaultData, lat: coords.lat, lng: coords.lng };
    }
  }

  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve(defaultData);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          resolve(await buildFromCoords(position.coords.latitude, position.coords.longitude));
        } catch (e) {
          console.error('Failed to fetch real data', e);
          resolve(defaultData);
        }
      },
      (error) => {
        console.warn('Geolocation error:', error);
        resolve(defaultData);
      },
      { timeout: 5000 }
    );
  });
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
        const MAX_WIDTH = 2000;
        const MAX_HEIGHT = 2000;
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
        resolve(canvas.toDataURL('image/jpeg', 0.9));
      };
      img.onerror = (error) => reject(error);
    };
    reader.onerror = (error) => reject(error);
  });
}

export function getRelativeTime(timestamp: string): string {
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const timeMs = new Date(timestamp).getTime();
  const diffDays = Math.round((timeMs - Date.now()) / (1000 * 60 * 60 * 24));
  const diffHours = Math.round((timeMs - Date.now()) / (1000 * 60 * 60));
  const diffMinutes = Math.round((timeMs - Date.now()) / (1000 * 60));
  
  if (Math.abs(diffMinutes) < 1) return 'Just now';
  if (Math.abs(diffMinutes) < 60) return rtf.format(diffMinutes, 'minute');
  if (Math.abs(diffHours) < 24) return rtf.format(diffHours, 'hour');
  return rtf.format(diffDays, 'day');
}

export function groupPhotosByHour(photos: Photo[], users: User[], timeZone?: string, selectedDate: Date = new Date(), hour12: boolean = true): TimeSlot[] {
  const slots = new Map<string, TimeSlot>();

  const isToday = selectedDate.toDateString() === new Date().toDateString();
  const startOfDay = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), 0);
  const endHour = isToday ? new Date().getHours() : 23;
  const currentHour = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), endHour);
  
  let iterDate = new Date(startOfDay.getTime());
  while (iterDate.getTime() <= currentHour.getTime()) {
    const hourKey = iterDate.toISOString();
    const displayTime = iterDate.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      hour12,
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
        hour12,
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
