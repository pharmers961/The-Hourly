export interface User {
  id: string;
  name: string;
  timezone: string;
  lastActive?: string;
}

export interface PhotoMetadata {
  temperature: number; // in Celsius
  noiseLevel: number; // in dB
}

export interface Photo {
  id: string;
  userId: string;
  timestamp: string; // ISO string
  imageUrl: string;
  metadata?: PhotoMetadata;
}

export interface TimeSlot {
  hourKey: string; 
  displayTime: string; 
  displayDate: string;
  photos: Record<string, Photo>; // Map of userId -> Photo
}
