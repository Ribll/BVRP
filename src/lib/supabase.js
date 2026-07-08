import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Messaggio chiaro in console se le env non sono configurate
  console.error(
    "⚠️  Variabili Supabase mancanti. Crea un file .env (vedi .env.example) " +
      "con VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY."
  );
}

export const supabase = createClient(url, anonKey);
