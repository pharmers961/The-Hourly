import { Photo, TimeSlot, User, PhotoMetadata } from './types';

// Helper function to simulate fetching environmental metadata at the moment of capture
export async function fetchEnvironmentalMetadata(customLocation?: string): Promise<PhotoMetadata> {
  return new Promise((resolve) => {
    const defaultData = {
      temperature: Math.floor(Math.random() * (35 - 10) + 10),
      noiseLevel: Math.floor(Math.random() * (90 - 30) + 30),
      humidity: 50,
      location: customLocation || 'Unknown Location',
    };

    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          try {
            const { latitude, longitude } = position.coords;
            
            // Fetch weather from open-meteo
            const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m`);
            const weatherData = await weatherRes.json();
            
            let city = customLocation;
            if (!city) {
              // Fetch location name from openstreetmap nominatim
              const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`);
              const geoData = await geoRes.json();
              city = geoData.address.city || geoData.address.town || geoData.address.village || geoData.address.county || 'Unknown Location';
            }
            
            resolve({
              temperature: weatherData.current?.temperature_2m || defaultData.temperature,
              humidity: weatherData.current?.relative_humidity_2m || defaultData.humidity,
              location: city,
              lat: latitude,
              lng: longitude,
              noiseLevel: defaultData.noiseLevel, // We can't get this easily from browser
            });
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
    } else {
      resolve(defaultData);
    }
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
