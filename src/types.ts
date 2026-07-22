export interface UserSettings {
  temperatureUnit: 'C' | 'F';
  timeFormat: '12h' | '24h';
  displayLocation?: string;
  // Notification preferences — absent means enabled (opt-out model)
  notifyLikes?: boolean;
  notifyComments?: boolean;
  notifyReminders?: boolean;
  theme?: 'light' | 'dark';
}

export interface User {
  id: string;
  name: string;
  timezone: string;
  lastActive?: string;
  settings?: UserSettings;
  whatsappPhone?: string; // digits-only E.164, links WhatsApp captures to this profile
}

export interface PhotoMetadata {
  temperature: number; // in Celsius
  humidity?: number;
  location?: string;
  lat?: number;
  lng?: number;
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
  imagePath?: string; // storage object path (Supabase)
  thumbUrl?: string; // small version for matrix tiles; absent on older photos
  metadata?: PhotoMetadata;
  comments?: Comment[];
  reactions?: Record<string, string[]>; // map of emoji to userIds
  viewedBy?: string[]; // profile ids (excluding the author) who opened this photo
}

export interface TimeSlot {
  hourKey: string;
  displayTime: string;
  displayDate: string;
  photos: Record<string, Photo>; // Map of userId -> Photo
}

export interface Group {
  id: string;
  name: string;
  role: 'owner' | 'member';
  inviteCode: string;
}
