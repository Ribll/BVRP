// supabase/functions/manage-users/index.ts
//
// Edge Function: gestione utenti con privilegi amministrativi.
//
// COSA FA
//   - action: "create"  -> crea un account GIA' confermato (email_confirm: true),
//                           senza inviare alcuna email. Il trigger handle_new_user()
//                           crea la riga in "profiles" dai metadati.
//   - action: "update"  -> cambia l'email di login e/o la password sull'account
//                           auth.users; se cambia l'email, allinea anche profiles.email.
//   - action: "delete"  -> elimina davvero l'account auth. Profilo e presenze
//                           spariscono in cascata (vincoli ON DELETE CASCADE).
//
// SICUREZZA
//   La funzione usa la chiave service_role (bypassa l'RLS), quindi autorizza il
//   chiamante nel codice: valida il suo token e verifica che sia role = 'admin'.
//
// DEPLOY (dal Dashboard, senza CLI)
//   Edge Functions > Deploy a new function > Via Editor > incolla questo codice,
//   nome funzione: manage-users. Disattiva "Verify JWT" per questa funzione
//   (l'autorizzazione avviene qui sotto). Nessun segreto da aggiungere:
//   SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sono già disponibili.

import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  // Preflight CORS
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Metodo non consentito" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Client con privilegi elevati: vive solo dentro la funzione, mai nel browser.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1) Autenticazione: ricavo l'utente dal token allegato dal browser.
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Non autenticato" }, 401);

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: "Token non valido" }, 401);
  const callerId = userData.user.id;

  // 2) Autorizzazione: il chiamante dev'essere admin.
  const { data: caller, error: profErr } = await admin
    .from("profiles")
    .select("role")
    .eq("id", callerId)
    .single();
  if (profErr || caller?.role !== "admin") {
    return json({ error: "Permesso negato: solo admin" }, 403);
  }

  // 3) Corpo della richiesta.
  let payload: Record<string, any>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "JSON non valido" }, 400);
  }
  const action = payload?.action;

  try {
    if (action === "create") {
      const { email, password, name, group_id, role, avatar, color } = payload;
      if (!email || !password) {
        return json({ error: "email e password sono obbligatorie" }, 400);
      }
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // account già confermato, nessuna email inviata
        user_metadata: { name, group_id, role, avatar, color },
      });
      if (error) return json({ error: error.message }, 400);
      return json({ id: data.user.id });
    }

    if (action === "update") {
      const { id, email, password } = payload;
      if (!id) return json({ error: "id obbligatorio" }, 400);

      const attrs: Record<string, unknown> = {};
      if (email) {
        attrs.email = email;
        attrs.email_confirm = true; // niente email di conferma sul cambio
      }
      if (password) attrs.password = password;

      if (Object.keys(attrs).length > 0) {
        const { error } = await admin.auth.admin.updateUserById(id, attrs);
        if (error) return json({ error: error.message }, 400);
      }
      // Se cambia l'email di login, tengo allineata anche profiles.email.
      if (email) {
        const { error: e2 } = await admin
          .from("profiles")
          .update({ email })
          .eq("id", id);
        if (e2) return json({ error: e2.message }, 400);
      }
      return json({ ok: true });
    }

    if (action === "delete") {
      const { id } = payload;
      if (!id) return json({ error: "id obbligatorio" }, 400);
      // Elimina l'account auth: profilo e presenze spariscono in cascata.
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Azione sconosciuta" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
