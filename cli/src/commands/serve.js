import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb, allRows, getRow, saveDb, refreshDb } from '../data/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PWA_PATH = join(__dirname, '..', '..', 'pwa', 'index.html');

async function handleApi(req, res, db) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/projects' && req.method === 'GET') {
    const projects = allRows(db, `
      SELECT p.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) as total_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') as done_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'pending') as pending_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'in_progress') as active_tasks
      FROM projects p ORDER BY p.name
    `);
    res.writeHead(200);
    res.end(JSON.stringify(projects));
    return;
  }

  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    const projectId = url.searchParams.get('project');
    const status = url.searchParams.get('status');
    let sql = `SELECT t.*, p.name as project_name FROM tasks t JOIN projects p ON t.project_id = p.id WHERE 1=1`;
    const params = [];
    if (projectId) { sql += ' AND t.project_id = ?'; params.push(projectId); }
    if (status) { sql += ' AND t.status = ?'; params.push(status); }
    sql += ' ORDER BY t.created_at DESC';
    const tasks = allRows(db, sql, params);
    res.writeHead(200);
    res.end(JSON.stringify(tasks));
    return;
  }

  if (url.pathname.startsWith('/api/tasks/') && req.method === 'PATCH') {
    const id = url.pathname.split('/').pop();
    const existing = getRow(db, 'SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not_found', message: `Task ${id} not found` }));
      return;
    }
    const body = await readBody(req);
    const data = JSON.parse(body);

    if (data.status) {
      const completedAt = data.status === 'done' ? `datetime('now', 'localtime')` : 'NULL';
      db.run(`UPDATE tasks SET status = ?, completed_at = ${completedAt}, updated_at = datetime('now', 'localtime') WHERE id = ?`, [data.status, id]);
      saveDb();
    }

    const task = getRow(db, 'SELECT * FROM tasks WHERE id = ?', [id]);
    res.writeHead(200);
    res.end(JSON.stringify(task));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
  });
}

export async function serveCommand(opts) {
  await getDb(); // initial load + migrations
  const port = parseInt(opts.port, 10);

  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      try {
        // Re-read DB from disk on each API request to pick up CLI changes
        const db = await refreshDb();
        await handleApi(req, res, db);
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Serve PWA
    try {
      const html = readFileSync(PWA_PATH, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('PWA file not found');
    }
  });

  server.listen(port, () => {
    console.log(`🫘 taskbean running at http://localhost:${port}`);
    console.log(`   API: http://localhost:${port}/api/projects`);
    console.log(`   Press Ctrl+C to stop`);
  });
}
