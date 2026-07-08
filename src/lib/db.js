import { createClient } from "@supabase/supabase-js";
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
});

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

export async function createGroup({ name, managerEmail }) {
  const { data, error } = await supabase
    .from("groups")
    .insert({ name, manager_email: managerEmail })
    .select()
    .single();
  if (error) throw error;
  return rowToGroup(data);
}

export async function deleteGroup(id) {
  const { error } = await supabase.from("groups").delete().eq("id", id);
  if (error) throw error;
}

// Aggiorna i campi di PROFILO di un utente (nome, email-profilo, gruppo, ruolo).
// NB: l'email di LOGIN vive in auth.users e NON viene toccata qui: cambiarla per
// un altro utente richiede la service role (Edge Function). Vedi README/CONTEXT.
export async function updateProfile(id, fields) {
  const patch = {};
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.email !== undefined) patch.email = fields.email;
  if (fields.group !== undefined) patch.group_id = fields.group || null;
  if (fields.role !== undefined) patch.role = fields.role;
  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return rowToUser(data);
}

// Elimina il profilo. NB: l'utente di autenticazione resta in auth.users
// (la sua rimozione richiede la service role → farla dalla dashboard o
// con una Edge Function). Vedi README.
export async function deleteProfile(id) {
  const { error } = await supabase.from("profiles").delete().eq("id", id);
  if (error) throw error;
}

/* ---------------------- AUTH: creazione utente -------------------- *
 *  Usiamo un client "usa e getta" (persistSession:false) così la      *
 *  registrazione del nuovo utente NON sovrascrive la sessione admin   *
 *  aperta nel browser.                                                *
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

  const tmp = createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  const { data, error } = await tmp.auth.signUp({
    email: email.trim(),
    password,
    options: { data: { name: name.trim(), group_id: group, role, avatar: initials, color } },
  });
  if (error) throw error;

  // Ritorna la forma "user" per aggiornare subito lo stato locale
  return {
    id: data.user?.id,
    name: name.trim(),
    email: email.trim(),
    group,
    role,
    avatar: initials,
    color,
  };
}
