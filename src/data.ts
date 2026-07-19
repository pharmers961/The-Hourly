import { User, Photo } from './types';

export const SIBLINGS: User[] = [
  { id: 'u1', name: 'Akram', timezone: 'America/New_York' },
];

// Generate some mock photos centered around current time
const now = new Date();
const currentHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());

const hourMinus1 = new Date(currentHour.getTime() - 1 * 60 * 60 * 1000);
const hourMinus2 = new Date(currentHour.getTime() - 2 * 60 * 60 * 1000);

export const MOCK_PHOTOS: Photo[] = [
  { id: 'p1', userId: 'u1', timestamp: new Date(currentHour.getTime() + 7 * 60000).toISOString(), imageUrl: 'https://images.unsplash.com/photo-1512418490979-9ce98810ea7d?q=80&w=400&auto=format&fit=crop', metadata: { temperature: 22, noiseLevel: 45 } },

  { id: 'p3', userId: 'u1', timestamp: new Date(hourMinus1.getTime() + 2 * 60000).toISOString(), imageUrl: 'https://images.unsplash.com/photo-1445205170230-053b83016050?q=80&w=400&auto=format&fit=crop', metadata: { temperature: 21, noiseLevel: 38 } },
];
