const { db } = require('./db');

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_BACKUP_REPO;
const API = 'https://api.github.com';
const FILE = 'data.json';
const OLD_FILE = 'users.json';

const enabled = () => Boolean(TOKEN && REPO);

const gh = async (method, url, body) => {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'otaku-family-backup',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

// Lit un fichier du dépôt (gère aussi les fichiers volumineux via le blob Git)
const readRepoFile = async (name) => {
  const file = await gh('GET', `/repos/${REPO}/contents/${name}`);
  if (!file) return null;
  let b64 = file.content;
  if (!b64 || file.encoding === 'none') {
    const blob = await gh('GET', `/repos/${REPO}/git/blobs/${file.sha}`);
    b64 = blob.content;
  }
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
};

// Exporte tout ce qui doit survivre. Les liens passent par pseudo + titre (pas par id).
const exportAll = () => ({
  users: db.prepare(
    'SELECT username, email, password, role, banned, created_at, last_login FROM users'
  ).all(),
  animes: db.prepare(
    'SELECT title, synopsis, genres, year, status, created_at FROM animes'
  ).all(),
  comments: db.prepare(`
    SELECT u.username AS username, a.title AS anime_title, c.content, c.created_at
    FROM comments c
    JOIN users u ON u.id = c.user_id
    JOIN animes a ON a.id = c.anime_id
    ORDER BY c.id`).all(),
  ratings: db.prepare(`
    SELECT u.username AS username, a.title AS anime_title, r.score
    FROM ratings r
    JOIN users u ON u.id = r.user_id
    JOIN animes a ON a.id = r.anime_id`).all()
});

const backup = async () => {
  if (!enabled()) throw new Error('Sauvegarde non configurée (GITHUB_TOKEN / GITHUB_BACKUP_REPO)');
  const data = exportAll();
  const date = new Date().toISOString();
  const payload = { date, version: 2, ...data };
  const counts = {
    users: data.users.length, animes: data.animes.length,
    comments: data.comments.length, ratings: data.ratings.length
  };

  const content = Buffer.from(JSON.stringify(payload, null, 2));
  if (content.length > 90 * 1024 * 1024) throw new Error('La sauvegarde dépasse 90 Mo');

  const url = `/repos/${REPO}/contents/${FILE}`;
  const existing = await gh('GET', url);
  await gh('PUT', url, {
    message: `Sauvegarde : ${counts.users} membres, ${counts.comments} commentaires, ${counts.ratings} notes`,
    content: content.toString('base64'),
    sha: existing ? existing.sha : undefined
  });
  return { date, ...counts };
};

// Restaure sans jamais écraser ni dupliquer l'existant
const restore = async () => {
  if (!enabled()) throw new Error('Sauvegarde non configurée');

  let data = await readRepoFile(FILE);
  if (!data) {
    // Ancien format (utilisateurs seulement)
    const old = await readRepoFile(OLD_FILE);
    if (!old) throw new Error('Aucune sauvegarde trouvée sur GitHub');
    data = { users: old.users || [], animes: [], comments: [], ratings: [] };
  }

  const res = { users: 0, animes: 0, comments: 0, ratings: 0 };

  db.transaction(() => {
    // 1) Utilisateurs
    const insUser = db.prepare(`
      INSERT OR IGNORE INTO users (username, email, password, role, banned, created_at, last_login)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const u of data.users || []) {
      res.users += insUser.run(u.username, u.email, u.password, u.role || 'user',
        u.banned ? 1 : 0, u.created_at, u.last_login).changes;
    }

    // 2) Animes (sans doublon sur le titre)
    const findAnime = db.prepare('SELECT id FROM animes WHERE title = ?');
    const insAnime = db.prepare(`
      INSERT INTO animes (title, synopsis, genres, year, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const a of data.animes || []) {
      if (!findAnime.get(a.title)) {
        insAnime.run(a.title, a.synopsis, a.genres || '', a.year, a.status || 'En cours', a.created_at);
        res.animes++;
      }
    }

    const userId = db.prepare('SELECT id FROM users WHERE username = ?');
    const animeId = db.prepare('SELECT id FROM animes WHERE title = ?');

    // 3) Commentaires (sans doublon : même auteur, même anime, même texte, même date)
    const hasComment = db.prepare(
      'SELECT 1 FROM comments WHERE user_id = ? AND anime_id = ? AND content = ? AND created_at = ?');
    const insComment = db.prepare(
      'INSERT INTO comments (anime_id, user_id, content, created_at) VALUES (?, ?, ?, ?)');
    for (const c of data.comments || []) {
      const u = userId.get(c.username), a = animeId.get(c.anime_title);
      if (!u || !a || hasComment.get(u.id, a.id, c.content, c.created_at)) continue;
      insComment.run(a.id, u.id, c.content, c.created_at);
      res.comments++;
    }

    // 4) Notes (une note par membre et par anime)
    const insRating = db.prepare(
      'INSERT OR IGNORE INTO ratings (anime_id, user_id, score) VALUES (?, ?, ?)');
    for (const r of data.ratings || []) {
      const u = userId.get(r.username), a = animeId.get(r.anime_title);
      if (!u || !a) continue;
      res.ratings += insRating.run(a.id, u.id, r.score).changes;
    }
  })();

  return res;
};

let lastResult = null;
let timer = null;
let running = false;

const runBackup = async () => {
  if (running) return lastResult;
  running = true;
  try {
    lastResult = { ok: true, ...(await backup()) };
    console.log(`Sauvegarde OK : ${lastResult.users} membres, ${lastResult.comments} commentaires, ${lastResult.ratings} notes`);
  } catch (e) {
    lastResult = { ok: false, error: e.message, date: new Date().toISOString() };
    console.error('Sauvegarde échouée :', e.message);
  }
  running = false;
  return lastResult;
};

// Appelée à chaque changement : regroupe les envois sur 15 secondes
const scheduleBackup = () => {
  if (!enabled()) return;
  clearTimeout(timer);
  timer = setTimeout(runBackup, 15 * 1000);
};

const start = async () => {
  if (!enabled()) return console.log('Sauvegarde GitHub désactivée (variables manquantes)');

  // Base vide (disque perdu) : restauration automatique
  const empty = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0 &&
                db.prepare('SELECT COUNT(*) c FROM animes').get().c === 0;
  if (empty) {
    try {
      const r = await restore();
      console.log(`Restauré depuis GitHub : ${r.users} membres, ${r.animes} animes, ${r.comments} commentaires, ${r.ratings} notes`);
    } catch (e) {
      console.log('Pas de restauration :', e.message);
    }
  }

  const hours = parseFloat(process.env.BACKUP_INTERVAL_HOURS || '6');
  setTimeout(runBackup, 60 * 1000);
  setInterval(runBackup, hours * 60 * 60 * 1000);
  console.log(`Sauvegarde GitHub activée (à chaque changement + toutes les ${hours} h)`);
};

module.exports = { enabled, runBackup, restore, scheduleBackup, start, getLast: () => lastResult };
