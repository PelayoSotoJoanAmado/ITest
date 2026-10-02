import { createClient } from '@insforge/sdk';

const baseUrl = import.meta.env.VITE_INSFORGE_URL;
const anonKey = import.meta.env.VITE_INSFORGE_ANON_KEY;

if (!baseUrl || !anonKey) {
  console.warn('⚠️ Faltan variables de entorno de InsForge (VITE_INSFORGE_URL o VITE_INSFORGE_ANON_KEY).');
}

export const insforge = createClient({
  baseUrl,
  anonKey,
});

export default insforge;
