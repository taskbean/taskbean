import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb, allRows, getRow, run } from '../data/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PWA_PATH = join(__dirname, '..', '..', 'pwa', 'index.html');

function handleApi(req, res) {
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
    const projects = allRows(`
      SELECT p.*,
        (SELECT COUNT(*) FROM todos t WHERE t.project = p.name) as total_tasks,
        (SELECT COUNT(*) FROM todos t WHERE t.project = p.name AND t.completed = 1) as done_tasks,
        (SELECT COUNT(*) FROM todos t WHERE t.project = p.name AND t.completed = 0) as pending_tasks
      FROM projects p WHERE p.tracked = 1 ORDER BY p.name
    `);
    res.writeHead(200);
    res.end(JSON.stringify(projects));
    return;
  }

  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    const project = url.searchParams.get('project');
    const status = url.searchParams.get('status');
    let sql = `SELECT * FROM todos WHERE 1=1`;
    const params = [];
    if (project) { sql += ' AND project = ?'; params.push(project); }
    if (status === 'done') { sql += ' AND completed = 1'; }
    else if (status === 'pending') { sql += ' AND completed = 0'; }
    sql += ' ORDER BY created_at DESC';
    const tasks = allRows(sql, params);
    res.writeHead(200);
    res.end(JSON.stringify(tasks));
    return;
  }

  if (url.pathname.startsWith('/api/tasks/') && req.method === 'PATCH') {
    const id = url.pathname.split('/').pop();
    const existing = getRow('SELECT * FROM todos WHERE id = ?', [id]);
    if (!existing) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not_found', message: `Task ${id} not found` }));
      return;
    }
    readBody(req).then(body => {
      const data = JSON.parse(body);
      if (data.completed !== undefined) {
        run('UPDATE todos SET completed = ? WHERE id = ?', [data.completed ? 1 : 0, id]);
      }
      const task = getRow('SELECT * FROM todos WHERE id = ?', [id]);
      res.writeHead(200);
      res.end(JSON.stringify(task));
    }).catch(err => {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'bad_request', message: err.message }));
    });
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

export function serveCommand(opts) {
  getDb(); // ensure DB is initialized
  const port = parseInt(opts.port, 10);

  const server = createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      try {
        handleApi(req, res);
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
