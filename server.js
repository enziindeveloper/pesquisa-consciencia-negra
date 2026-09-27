const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');
const SURVEYS = require('./surveys');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'aline01';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'aline01';
const RESET_PASSWORD = process.env.RESET_PASSWORD || '290908';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'troque-esta-chave-em-producao',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 12 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Banco de dados ----------
const ID_PK = db.isPostgres ? 'id SERIAL PRIMARY KEY' : 'id INTEGER PRIMARY KEY AUTOINCREMENT';
const CREATED = db.isPostgres
  ? 'created_at TIMESTAMP NOT NULL DEFAULT NOW()'
  : "created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))";

async function initDb() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS surveys (
      ${ID_PK},
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS questions (
      ${ID_PK},
      survey_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      options TEXT NOT NULL,
      correct INTEGER NULL,
      qtype TEXT NOT NULL DEFAULT 'single',
      required INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS responses (
      ${ID_PK},
      survey_id INTEGER NOT NULL,
      ${CREATED}
    )`,
    `CREATE TABLE IF NOT EXISTS answers (
      response_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      option_index INTEGER NULL,
      text_value TEXT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`
  ]);

  // Seed das pesquisas
  for (const s of SURVEYS) {
    const exists = (await db.execute({ sql: 'SELECT id FROM surveys WHERE slug = ?', args: [s.slug] })).rows[0];
    if (!exists) {
      await db.execute({ sql: 'INSERT INTO surveys (slug, title, description) VALUES (?, ?, ?)', args: [s.slug, s.title, s.description] });
    }
  }
  // Seed das perguntas (por pesquisa, só na primeira vez)
  for (const s of SURVEYS) {
    const survey = await getSurvey(s.slug);
    const n = Number((await db.execute({ sql: 'SELECT COUNT(*) AS c FROM questions WHERE survey_id = ?', args: [survey.id] })).rows[0].c);
    if (n === 0) {
      await db.batch(s.questions.map(q => ({
        sql: 'INSERT INTO questions (survey_id, text, options, correct, qtype, required) VALUES (?, ?, ?, ?, ?, ?)',
        args: [survey.id, q.text, JSON.stringify(q.options), q.correct, q.type, q.required ? 1 : 0]
      })));
      console.log(`Seed: ${s.questions.length} perguntas (${s.slug}).`);
    }
    const epKey = 'epoch_' + s.slug;
    const hasEp = (await db.execute({ sql: "SELECT 1 FROM meta WHERE key = ?", args: [epKey] })).rows[0];
    if (!hasEp) {
      await db.execute({ sql: 'INSERT INTO meta (key, value) VALUES (?, ?)', args: [epKey, '1'] });
    }
  }

  // Seed do admin (só na primeira vez)
  const adminExists = (await db.execute({ sql: 'SELECT 1 FROM users WHERE username = ?', args: [ADMIN_USER] })).rows[0];
  if (!adminExists) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    await db.execute({ sql: 'INSERT INTO users (username, password_hash) VALUES (?, ?)', args: [ADMIN_USER, hash] });
    console.log(`Seed: usuário admin criado (login: ${ADMIN_USER})`);
  }
}

async function getSurvey(slug) {
  const rs = await db.execute({ sql: 'SELECT * FROM surveys WHERE slug = ?', args: [slug] });
  return rs.rows[0] || null;
}

async function getQuestions(surveyId) {
  const rs = await db.execute({ sql: 'SELECT id, text, options, correct, qtype, required FROM questions WHERE survey_id = ? ORDER BY id', args: [surveyId] });
  return rs.rows.map(r => ({
    id: Number(r.id), text: r.text, options: JSON.parse(r.options),
    correct: r.correct === null ? null : Number(r.correct),
    qtype: r.qtype, required: Number(r.required) === 1
  }));
}

function epochKey(slug) { return 'epoch_' + slug; }

async function getEpoch(slug) {
  const row = (await db.execute({ sql: 'SELECT value AS v FROM meta WHERE key = ?', args: [epochKey(slug)] })).rows[0];
  return row ? String(row.v) : '1';
}

async function bumpEpoch(slug) {
  const next = String(Number(await getEpoch(slug)) + 1);
  await db.execute({ sql: 'UPDATE meta SET value = ? WHERE key = ?', args: [next, epochKey(slug)] });
  return next;
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').filter(Boolean).map(c => {
      const i = c.indexOf('=');
      return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
    })
  );
}

// ---------- Rotas públicas ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/surveys', async (req, res) => {
  const rs = await db.execute('SELECT slug, title, description FROM surveys ORDER BY id');
  const info = Object.fromEntries(SURVEYS.map((s, i) => [s.slug, { page: '/' + s.page, order: i }]));
  res.json(rs.rows
    .filter(r => info[r.slug])
    .map(r => ({ slug: r.slug, title: r.title, description: r.description, page: info[r.slug].page }))
    .sort((a, b) => info[a.slug].order - info[b.slug].order));
});

app.get('/api/surveys/:slug/questions', async (req, res) => {
  const survey = await getSurvey(req.params.slug);
  if (!survey) return res.status(404).json({ error: 'Pesquisa não encontrada.' });
  const list = (await getQuestions(survey.id)).map(({ correct, ...rest }) => rest);
  res.json({ survey: { slug: survey.slug, title: survey.title, description: survey.description }, questions: list });
});

app.get('/api/surveys/:slug/epoch', async (req, res) => {
  const survey = await getSurvey(req.params.slug);
  if (!survey) return res.status(404).json({ error: 'Pesquisa não encontrada.' });
  res.json({ epoch: await getEpoch(survey.slug) });
});

// Confirmação real: o navegador pergunta ao servidor se este dispositivo já votou
app.get('/api/surveys/:slug/status', async (req, res) => {
  const survey = await getSurvey(req.params.slug);
  if (!survey) return res.status(404).json({ error: 'Pesquisa não encontrada.' });
  const epoch = await getEpoch(survey.slug);
  const cookies = parseCookies(req);
  res.json({ voted: cookies['respondido_' + survey.slug] === epoch, epoch });
});

app.post('/api/surveys/:slug/submit', async (req, res) => {
  const survey = await getSurvey(req.params.slug);
  if (!survey) return res.status(404).json({ error: 'Pesquisa não encontrada.' });
  const epoch = await getEpoch(survey.slug);
  const cookies = parseCookies(req);
  if (cookies['respondido_' + survey.slug] === epoch) {
    return res.status(403).json({ error: 'Este dispositivo já respondeu à pesquisa.' });
  }

  const { answers } = req.body || {};
  const questions = await getQuestions(survey.id);
  if (!Array.isArray(answers)) return res.status(400).json({ error: 'Resposta inválida.' });

  const byId = new Map(questions.map(q => [q.id, q]));
  if (answers.length !== questions.length) {
    return res.status(400).json({ error: `Responda todas as ${questions.length} perguntas.` });
  }
  const seen = new Set();
  const rows = [];
  for (const a of answers) {
    const q = byId.get(a.questionId);
    if (!q || seen.has(a.questionId)) return res.status(400).json({ error: 'Resposta inválida.' });
    seen.add(a.questionId);
    if (q.qtype === 'single') {
      if (a.optionIndex === null || a.optionIndex === undefined) {
        if (q.required) return res.status(400).json({ error: 'Resposta inválida.' });
        continue;
      }
      if (!Number.isInteger(a.optionIndex) || a.optionIndex < 0 || a.optionIndex >= q.options.length) {
        return res.status(400).json({ error: 'Resposta inválida.' });
      }
      rows.push({ qid: q.id, opt: a.optionIndex, text: null });
    } else if (q.qtype === 'multiple') {
      const idxs = Array.isArray(a.optionIndexes) ? [...new Set(a.optionIndexes)] : [];
      if (q.required && !idxs.length) return res.status(400).json({ error: 'Resposta inválida.' });
      for (const o of idxs) {
        if (!Number.isInteger(o) || o < 0 || o >= q.options.length) return res.status(400).json({ error: 'Resposta inválida.' });
        rows.push({ qid: q.id, opt: o, text: null });
      }
    } else if (q.qtype === 'text') {
      const t = typeof a.text === 'string' ? a.text.trim().slice(0, 2000) : '';
      if (q.required && !t) return res.status(400).json({ error: 'Resposta inválida.' });
      if (t) rows.push({ qid: q.id, opt: null, text: t });
    }
  }

  const r = await db.execute({ sql: 'INSERT INTO responses (survey_id) VALUES (?) RETURNING id', args: [survey.id] });
  const responseId = Number(r.rows[0].id);
  if (rows.length) {
    const ph = [];
    const flat = [];
    for (const row of rows) {
      ph.push('(?, ?, ?, ?)');
      flat.push(responseId, row.qid, row.opt, row.text);
    }
    await db.execute({
      sql: `INSERT INTO answers (response_id, question_id, option_index, text_value) VALUES ${ph.join(',')}`,
      args: flat
    });
  }
  res.cookie('respondido_' + survey.slug, epoch, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true });
});

// ---------- Auth admin ----------
function requireAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ error: 'Não autenticado.' });
}

app.get('/api/admin/me', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.admin), username: req.session.admin || null });
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  const rs = username
    ? await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] })
    : { rows: [] };
  const user = rs.rows[0];
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }
  req.session.admin = user.username;
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.post('/api/admin/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'A nova senha deve ter ao menos 4 caracteres.' });
  }
  const rs = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [req.session.admin] });
  const user = rs.rows[0];
  if (!bcrypt.compareSync(currentPassword || '', user.password_hash)) {
    return res.status(401).json({ error: 'Senha atual incorreta.' });
  }
  await db.execute({
    sql: 'UPDATE users SET password_hash = ? WHERE username = ?',
    args: [bcrypt.hashSync(newPassword, 10), req.session.admin]
  });
  res.json({ ok: true });
});

// ---------- Resultados ----------
async function buildResults(survey) {
  const questions = await getQuestions(survey.id);
  const totalResponses = Number((await db.execute({ sql: 'SELECT COUNT(*) AS c FROM responses WHERE survey_id = ?', args: [survey.id] })).rows[0].c);
  const data = await Promise.all(questions.map(async (q) => {
    if (q.qtype === 'text') {
      const rs = await db.execute({
        sql: 'SELECT text_value AS t FROM answers WHERE question_id = ? AND text_value IS NOT NULL ORDER BY response_id DESC LIMIT 100',
        args: [q.id]
      });
      const gs = await db.execute({
        sql: 'SELECT TRIM(text_value) AS v, COUNT(*) AS c FROM answers WHERE question_id = ? AND text_value IS NOT NULL GROUP BY TRIM(text_value) ORDER BY COUNT(*) DESC',
        args: [q.id]
      });
      const groups = gs.rows.map(r => ({
        value: r.v,
        votes: Number(r.c),
        pct: totalResponses ? Math.round((Number(r.c) / totalResponses) * 1000) / 10 : 0
      }));
      return {
        id: q.id, text: q.text, qtype: q.qtype, required: q.required,
        total: groups.reduce((a, g) => a + g.votes, 0),
        texts: rs.rows.map(r => r.t), groups
      };
    }
    const votes = new Array(q.options.length).fill(0);
    const rows = (await db.execute({
      sql: 'SELECT option_index AS o, COUNT(*) AS c FROM answers WHERE question_id = ? AND option_index IS NOT NULL GROUP BY option_index',
      args: [q.id]
    })).rows;
    for (const row of rows) {
      const o = Number(row.o);
      if (o >= 0 && o < votes.length) votes[o] = Number(row.c);
    }
    const total = votes.reduce((a, b) => a + b, 0);
    const percentages = votes.map(v => (totalResponses ? Math.round((v / totalResponses) * 1000) / 10 : 0));
    const correctRate = q.correct === null || total === 0
      ? null
      : Math.round((votes[q.correct] / total) * 1000) / 10;
    return {
      id: q.id, text: q.text, options: q.options, correct: q.correct,
      qtype: q.qtype, required: q.required, votes, total, percentages, correctRate
    };
  }));
  return { totalResponses, questions: data };
}

app.get('/api/admin/results', requireAuth, async (req, res) => {
  const survey = await getSurvey(req.query.survey || '');
  if (!survey) return res.status(404).json({ error: 'Pesquisa não encontrada.' });
  res.json(await buildResults(survey));
});

app.post('/api/admin/reset', requireAuth, async (req, res) => {
  const survey = await getSurvey(req.query.survey || req.body.survey || '');
  if (!survey) return res.status(404).json({ error: 'Pesquisa não encontrada.' });
  if (!req.body || req.body.password !== RESET_PASSWORD) {
    return res.status(403).json({ error: 'Senha de exclusão incorreta.' });
  }
  await db.execute({ sql: 'DELETE FROM answers WHERE response_id IN (SELECT id FROM responses WHERE survey_id = ?)', args: [survey.id] });
  await db.execute({ sql: 'DELETE FROM responses WHERE survey_id = ?', args: [survey.id] });
  await bumpEpoch(survey.slug); // libera os dispositivos para votar de novo
  res.json({ ok: true });
});

app.post('/api/admin/sync-questions', requireAuth, async (req, res) => {
  const slug = req.query.survey || '';
  const survey = await getSurvey(slug);
  if (!survey) return res.status(404).json({ error: 'Pesquisa não encontrada.' });
  delete require.cache[require.resolve('./surveys')];
  const fresh = require('./surveys').find(s => s.slug === slug);
  if (!fresh) return res.status(404).json({ error: 'Pesquisa não encontrada no arquivo.' });
  const current = await getQuestions(survey.id);
  const normQ = q => [q.text, q.options, q.correct, q.type || q.qtype, Number(q.required)];
  const same = current.length === fresh.questions.length &&
    current.every((q, i) => JSON.stringify(normQ({ ...q, type: q.qtype })) === JSON.stringify(normQ(fresh.questions[i])));
  if (same) {
    return res.json({ ok: true, changed: false, message: 'As perguntas já estão atualizadas.' });
  }
  const total = Number((await db.execute({ sql: 'SELECT COUNT(*) AS c FROM responses WHERE survey_id = ?', args: [survey.id] })).rows[0].c);
  if (total > 0) {
    return res.status(400).json({ error: `Há ${total} resposta(s) registrada(s). Apague as respostas antes de trocar as perguntas.` });
  }
  await db.execute({ sql: 'DELETE FROM answers WHERE response_id IN (SELECT id FROM responses WHERE survey_id = ?)', args: [survey.id] });
  await db.execute({ sql: 'DELETE FROM responses WHERE survey_id = ?', args: [survey.id] });
  await db.execute({ sql: 'DELETE FROM questions WHERE survey_id = ?', args: [survey.id] });
  if (!db.isPostgres) {
    await db.execute("DELETE FROM sqlite_sequence WHERE name='questions'").catch(() => {});
  }
  await db.batch(fresh.questions.map(q => ({
    sql: 'INSERT INTO questions (survey_id, text, options, correct, qtype, required) VALUES (?, ?, ?, ?, ?, ?)',
    args: [survey.id, q.text, JSON.stringify(q.options), q.correct, q.type, q.required ? 1 : 0]
  })));
  await bumpEpoch(slug);
  res.json({ ok: true, changed: true, message: 'Perguntas atualizadas com sucesso!' });
});

app.get('/api/admin/export', requireAuth, async (req, res) => {
  const survey = await getSurvey(req.query.survey || '');
  if (!survey) return res.status(404).json({ error: 'Pesquisa não encontrada.' });
  const { totalResponses, questions } = await buildResults(survey);
  const lines = ['pergunta;tipo;alternativa;votos;porcentagem'];
  for (const q of questions) {
    if (q.qtype === 'text') {
      for (const t of q.texts) {
        lines.push(`"${q.text.replace(/"/g, '""')}";texto;"${String(t).replace(/"/g, '""')}";1;`);
      }
    } else {
      q.options.forEach((opt, i) => {
        lines.push(`"${q.text.replace(/"/g, '""')}";${q.qtype};"${opt.replace(/"/g, '""')}";${q.votes[i]};${q.percentages[i]}`);
      });
    }
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="pesquisa-${survey.slug}.csv"`);
  res.send('\uFEFF' + `Pesquisa: ${survey.title}\nTotal de respostas: ${totalResponses}\n` + lines.join('\n'));
});

async function main() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Servidor no ar: http://localhost:${PORT}`);
  });
}
main().catch(err => { console.error(err); process.exit(1); });
