import { supabase } from "./supabase";

/* ------------------------------------------------------------------ *
 *  Mapping: le tabelle Supabase usano snake_case, il componente usa   *
 *  la forma originale ({group, managerEmail, ...}). Qui traduciamo.   *
 * ------------------------------------------------------------------ */

const rowToUser = (r) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  group: r.group_id,
  role: r.role,
  avatar: r.avatar,
  color: r.color,
});

const rowToGroup = (r) => ({
  id: r.id,
  name: r.name,
  managerEmail: r.manager_email,
  parent: r.parent_id || null,
});

/* --------------------- Edge Function: manage-users ---------------- *
 *  Le operazioni privilegiate (creare/eliminare account, cambiare    *
 *  l'email di login) girano nella Edge Function "manage-users", che   *
 *  usa la service role. Il browser NON tocca mai la service role.     *
 *  functions.invoke allega automaticamente il token dell'admin        *
 *  loggato: la funzione verifica lato server che sia davvero admin.   *
 * ------------------------------------------------------------------ */
async function callAdminFn(body) {
  const { data, error } = await supabase.functions.invoke("manage-users", { body });
  if (error) {
    // Con un errore HTTP, supabase-js mette il messaggio nel corpo della
    // risposta (error.context), non in error.message: proviamo a leggerlo.
    let msg = error.message;
    try {
      const j = await error.context.json();
      if (j?.error) msg = j.error;
    } catch {
      /* corpo non-JSON: teniamo error.message */
    }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

/* ------------------------------- READ ----------------------------- */

export async function fetchProfiles() {
  const { data, error } = await supabase.from("profiles").select("*").order("name");
  if (error) throw error;
  return data.map(rowToUser);
}

export async function fetchGroups() {
  const { data, error } = await supabase.from("groups").select("*").order("created_at");
  if (error) throw error;
  return data.map(rowToGroup);
}

// Ritorna un oggetto { `${user_id}_${date}`: {status, location} }
export async function fetchAttendance() {
  const { data, error } = await supabase.from("attendance").select("user_id,date,status,location");
  if (error) throw error;
  const map = {};
  for (const row of data) {
    map[`${row.user_id}_${row.date}`] = { status: row.status, location: row.location || "" };
  }
  return map;
}

/* ------------------------------ WRITE ----------------------------- */

// dateStr = 'YYYY-MM-DD'
export async function upsertAttendance(userId, dateStr, status, location = "") {
  const { error } = await supabase
    .from("attendance")
    .upsert(
      { user_id: userId, date: dateStr, status, location, updated_at: new Date().toISOString() },
      { onConflict: "user_id,date" }
    );
  if (error) throw error;
}

export async function createGroup({ name, managerEmail, parent = null }) {
  const { data, error } = await supabase
    .from("groups")
    .insert({ name, manager_email: managerEmail, parent_id: parent || null })
    .select()
    .single();
  if (error) throw error;
  return rowToGroup(data);
}

export async function deleteGroup(id) {
  const { error } = await supabase.from("groups").delete().eq("id", id);
  if (error) throw error;
}

// Aggiorna i campi di un utente. Nome/gruppo/ruolo sono aggiornabili
// direttamente (l'RLS admin lo consente). Se cambia l'EMAIL, quella è
// l'email di LOGIN: passa dalla Edge Function, che aggiorna auth.users e
// sincronizza profiles.email. Chi chiama (saveEdit) include il campo
// "email" nei fields solo quando è effettivamente cambiata.
export async function updateProfile(id, fields) {
  // 1) Cambio email di login (se richiesto) → Edge Function.
  if (fields.email !== undefined) {
    await callAdminFn({ action: "update", id, email: fields.email });
  }

  // 2) Campi di solo profilo → update diretto.
  const patch = {};
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.group !== undefined) patch.group_id = fields.group || null;
  if (fields.role !== undefined) patch.role = fields.role;

  let row;
  if (Object.keys(patch).length > 0) {
    const { data, error } = await supabase
      .from("profiles")
      .update(patch)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    row = data;
  } else {
    // Solo email cambiata: rileggo la riga per restituire lo stato aggiornato.
    const { data, error } = await supabase.from("profiles").select("*").eq("id", id).single();
    if (error) throw error;
    row = data;
  }
  return rowToUser(row);
}

// Elimina DAVVERO l'utente: la Edge Function rimuove l'account in
// auth.users; profilo e presenze spariscono in cascata (ON DELETE CASCADE).
export async function deleteProfile(id) {
  await callAdminFn({ action: "delete", id });
}

/* ---------------------- AUTH: creazione utente -------------------- *
 *  Passa dalla Edge Function (admin.createUser con email_confirm:true):*
 *  l'account nasce già confermato e senza inviare alcuna email. Il     *
 *  trigger handle_new_user() crea la riga profiles dai metadati.       *
 * ------------------------------------------------------------------ */
export async function adminCreateUser({ name, email, password, group, role }) {
  const initials = name
    .trim()
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const cols = ["#60a5fa", "#34d399", "#a78bfa", "#fbbf24", "#f472b6", "#fb923c"];
  const color = cols[Math.floor(Math.random() * cols.length)];

  const data = await callAdminFn({
    action: "create",
    email: email.trim(),
    password,
    name: name.trim(),
    group_id: group,
    role,
    avatar: initials,
    color,
  });

  // Ritorna la forma "user" per aggiornare subito lo stato locale.
  return {
    id: data.id,
    name: name.trim(),
    email: email.trim(),
    group,
    role,
    avatar: initials,
    color,
  };
}
