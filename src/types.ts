export interface User {
  id: string;
  name: string;
  timezone: string;
  lastActive?: string;
}

export interface PhotoMetadata {
  temperature: number; // in Celsius
  humidity?: number;
  location?: string;
  noiseLevel: number; // in dB
}

export interface Comment {
  id: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: string;
}

export interface Photo {
  id: string;
  userId: string;
  timestamp: string; // ISO string
  imageUrl: string;
  metadata?: PhotoMetadata;
  comments?: Comment[];
  reactions?: Record<string, string[]>; // map of emoji to userIds
}

export interface TimeSlot {
  hourKey: string; 
  displayTime: string; 
  displayDate: string;
  photos: Record<string, Photo>; // Map of userId -> Photo
}
