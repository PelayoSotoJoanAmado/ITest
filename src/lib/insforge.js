import { createClient } from '@insforge/sdk';

const baseUrl = import.meta.env.VITE_INSFORGE_URL || 'https://3j7i3wv9.us-east.insforge.app';
const anonKey = import.meta.env.VITE_INSFORGE_ANON_KEY || 'anon_b230028c00d10bbc0b54f8603d9c56658734f111e64906602aa8f09003cb8686';

export const insforge = createClient({
  baseUrl,
  anonKey,
});

export default insforge;
