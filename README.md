# Calendario Presenze

Gestionale presenze aziendali: calendario settimanale, riepilogo mensile con
contatori ferie, vista team, pannello di amministrazione, festività italiane,
export Excel e segnalazioni ai responsabili.

**Stack:** React + Vite (frontend) · Supabase (database Postgres + autenticazione)
· Vercel (hosting). Repository su GitHub.

---

## 1. Requisiti

- [Node.js](https://nodejs.org) 18 o superiore
- Un account gratuito su [Supabase](https://supabase.com)
- Un account gratuito su [Vercel](https://vercel.com)
- Un account [GitHub](https://github.com)

---

## 2. Setup Supabase (il backend)

1. Crea un nuovo progetto su Supabase.
2. Vai su **SQL Editor → New query**, incolla tutto il contenuto di
   [`supabase/schema.sql`](./supabase/schema.sql) e premi **Run**.
   Questo crea le tabelle (`groups`, `profiles`, `attendance`), il trigger che
   genera il profilo alla registrazione, le regole di sicurezza (RLS) e due
   gruppi di esempio.
3. Recupera URL e chiave. Supabase ha un **nuovo sistema di chiavi**: al posto
   della vecchia *anon key* trovi la **Publishable key**.
   - **Project URL** → `VITE_SUPABASE_URL`
     Lo trovi nel pulsante verde **Connect** in alto, oppure in
     **Settings → General / Data API**. Forma: `https://xxxx.supabase.co`

         https://vdfxiuydnigbfprpmabm.supabase.co


   - **Publishable key** (`sb_publishable_...`) → `VITE_SUPABASE_ANON_KEY`
         
         sb_publishable_-mMASAnkMnUH_axMr5lQsw_wWC5vg0m


     In **Settings → API Keys**, scheda *Publishable and secret API keys*,
     riga "default". È sicura nel browser perché abbiamo attivato RLS.
   - ⚠️ La **Secret key** (`sb_secret_...`) **non** va mai nel frontend: è ad
     accesso privilegiato (come la vecchia service_role) e serve solo lato
     server / Edge Function.

   > Su progetti più vecchi puoi ancora usare la *anon key* dalla scheda
   > *Legacy API keys*: funziona allo stesso modo. Le chiavi legacy verranno
   > comunque dismesse da Supabase entro fine 2026.
4. **Solo per lo sviluppo** — disattiva la conferma email così gli utenti creati
   dall'admin possono accedere subito: **Authentication → Providers → Email** →
   togli *Confirm email*. (In produzione lasciala attiva.)

### Creare il primo amministratore

Poiché all'inizio non esiste nessun utente, crea il primo a mano:

1. **Authentication → Users → Add user** → inserisci email e password.
   Il trigger crea automaticamente il profilo con ruolo `user`.
2. Vai su **Table Editor → profiles**, trova la riga e:
   - metti `role` = `admin`
   - imposta `group_id` scegliendo l'id di un gruppo dalla tabella `groups`

Da ora, una volta effettuato l'accesso come admin, puoi creare gli altri utenti
e i gruppi direttamente dall'app (sezione **Amministrazione**).

---

## 3. Avvio in locale

```bash
npm install
cp .env.example .env      # poi inserisci URL e anon key nel file .env
npm run dev
```

L'app parte su http://localhost:5173

---

## 4. GitHub

```bash
git init
git add .
git commit -m "Primo commit: calendario presenze"
git branch -M main
git remote add origin https://github.com/<tuo-utente>/calendario-presenze.git
git push -u origin main
```

> Il file `.env` è già in `.gitignore`: le chiavi **non** finiscono su GitHub.

---

## 5. Deploy su Vercel (il frontend)

1. Su Vercel: **Add New → Project** e importa il repo GitHub.
2. Vercel riconosce Vite in automatico (build `npm run build`, output `dist`).
3. In **Environment Variables** aggiungi le due variabili:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. **Deploy.** Ad ogni `git push` su `main`, Vercel ripubblica da solo.

Ultimo passo: copia il dominio Vercel (es. `https://tuo-progetto.vercel.app`)
e su Supabase mettilo in **Authentication → URL Configuration → Site URL**
(e tra i *Redirect URLs*).

---

## Struttura del progetto

```
├── index.html
├── vercel.json                 # rewrite SPA
├── .env.example                # modello variabili d'ambiente
├── supabase/
│   └── schema.sql              # tabelle + RLS + trigger (da eseguire su Supabase)
└── src/
    ├── main.jsx                # entry point
    ├── App.jsx                 # tutta l'interfaccia (calendario, admin, ecc.)
    ├── styles/global.css       # stili globali
    └── lib/
        ├── supabase.js         # client Supabase
        └── db.js               # lettura/scrittura dati (traduce le tabelle)
```

Tutta l'interfaccia è ancora in un unico `App.jsx`: funziona bene così, ma quando
vorrai crescere il passo naturale è spezzarlo in componenti (`CalendarView`,
`MonthlyView`, `TeamView`, `AdminView`, `StatusModal`…) dentro `src/components/`.
La logica dati è già isolata in `src/lib/db.js`, quindi le viste non vanno toccate
per cambiare il backend.

---

## Note e limiti attuali

- **Creazione utenti dall'admin**: avviene con una registrazione Supabase da
  browser. Funziona per iniziare; la via robusta in produzione è una *Edge
  Function* con service role (così l'admin non tocca mai la propria sessione e
  puoi anche eliminare del tutto un utente).
- **Eliminazione utente dall'app**: rimuove il *profilo*, ma l'utente di
  autenticazione resta in **Authentication → Users**. Eliminalo da lì (o via
  Edge Function) per rimuoverlo completamente.
- **Sicurezza dati**: le regole RLS fanno sì che ogni persona possa modificare
  solo le proprie presenze; gli admin possono agire su tutti. Sono nello schema
  e puoi affinarle secondo le tue esigenze.
