import { Photo, TimeSlot, User, PhotoMetadata } from './types';

// Helper function to simulate fetching environmental metadata at the moment of capture
export async function fetchEnvironmentalMetadata(): Promise<PhotoMetadata> {
  // In a real app, this might access device sensors, geolocation weather APIs, or microphone data.
  // We simulate a slight network delay and return reasonable randomized values.
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        temperature: Math.floor(Math.random() * (35 - 10) + 10), // Random temp between 10C and 35C
        noiseLevel: Math.floor(Math.random() * (90 - 30) + 30), // Random noise level between 30dB (quiet room) and 90dB (city street)
      });
    }, 400);
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
