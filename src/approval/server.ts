// The page where a human approves a planned migration with an authenticator code.
// Server-rendered, no client-side JavaScript, and nothing loaded from other origins.
import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync } from 'fs';
import * as crypto from 'crypto';
import hljs from 'highlight.js/lib/core';
import pgsql from 'highlight.js/lib/languages/pgsql';
import { APPROVAL_ORIGIN, APPROVAL_PORT } from './constants';
import { checkCode } from './totp';
import { executeMigration } from '../tools/applyMigration';
import { expired, expiresAt, Plan, plans, PlanStatus } from '../tools/planMigration';

hljs.registerLanguage('pgsql', pgsql);

const MAX_ATTEMPTS_PER_PLAN = 3;
const ALLOWED_HOSTS = [`127.0.0.1:${APPROVAL_PORT}`, `localhost:${APPROVAL_PORT}`];

const hljsTheme = (name: string) => readFileSync(require.resolve(`highlight.js/styles/${name}.css`), 'utf8');
const STYLESHEET = `${hljsTheme('github')}
@media (prefers-color-scheme: dark) { ${hljsTheme('github-dark')} }
:root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --border: #d1d9e0; --panel: #f6f8fa;
  --danger: #cf222e; --danger-bg: #ffebe9; --ok: #1a7f37; --accent: #0969da; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --border: #3d444d; --panel: #151b23;
    --danger: #f85149; --danger-bg: #2d1214; --ok: #3fb950; --accent: #4493f8; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 16px; }
h2 { font-size: 15px; margin: 24px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.target { border: 1px solid var(--danger); background: var(--danger-bg); color: var(--danger);
  border-radius: 6px; padding: 10px 14px; font-weight: 600; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 16px 0 0; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
pre { margin: 0; padding: 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel);
  overflow-x: auto; font: 13px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
pre code.hljs { padding: 0; background: transparent; }
.diff-add { color: var(--ok); } .diff-del { color: var(--danger); }
form { margin-top: 24px; display: flex; flex-wrap: wrap; gap: 12px; align-items: end; }
label { display: flex; flex-direction: column; gap: 4px; color: var(--muted); }
input[name=code] { font: 22px ui-monospace, Consolas, monospace; letter-spacing: .2em; width: 9em;
  padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); }
button { font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--panel); color: var(--fg); cursor: pointer; }
button.approve { background: var(--danger); border-color: var(--danger); color: #fff; }
.msg { margin-top: 16px; padding: 10px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--panel); }
.msg.error { border-color: var(--danger); color: var(--danger); }
.msg.ok { border-color: var(--ok); color: var(--ok); }
`;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const time = (iso: string | number) => new Date(iso).toLocaleString();

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><link rel="stylesheet" href="/static/app.css"></head>
<body><main>${body}</main></body></html>`;
}

function renderDiff(diff: string) {
  if (!diff) return '<pre>(no column or table changes)</pre>';
  return `<pre>${diff.split('\n').map((line) => {
    const cls = line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : '';
    return cls ? `<span class="${cls}">${escapeHtml(line)}</span>` : escapeHtml(line);
  }).join('\n')}</pre>`;
}

function approvalPage(plan: Plan, message?: { text: string; kind: 'error' | 'ok' }) {
  const attemptsLeft = MAX_ATTEMPTS_PER_PLAN - plan.failedAttempts;
  return page(`Approve ${plan.name}`, `
<h1>Approve migration</h1>
<div class="target">Runs on the real database: ${escapeHtml(process.env.DATABASE_NAME ?? '?')} on ${escapeHtml(process.env.DATABASE_HOST ?? '?')}</div>
<dl>
  <dt>Name</dt><dd>${escapeHtml(plan.name)}</dd>
  <dt>Timestamp</dt><dd>${escapeHtml(plan.timestamp)}</dd>
  <dt>Planned</dt><dd>${time(plan.createdAt)}</dd>
  <dt>Expires</dt><dd>${time(expiresAt(plan))}</dd>
  <dt>Shadow copy from</dt><dd>${plan.snapshotTakenAt ? time(plan.snapshotTakenAt) : 'unknown'}</dd>
  <dt>Plan ID</dt><dd><code>${plan.id}</code></dd>
</dl>
<h2>SQL</h2>
<pre><code class="hljs language-pgsql">${hljs.highlight(plan.sql, { language: 'pgsql' }).value}</code></pre>
<h2>Schema changes on the shadow copy</h2>
${renderDiff(plan.diff)}
${message ? `<div class="msg ${message.kind}">${escapeHtml(message.text)}</div>` : ''}
<form method="post">
  <input type="hidden" name="planId" value="${plan.id}">
  <label>Authenticator code (${attemptsLeft} ${attemptsLeft === 1 ? 'attempt' : 'attempts'} left)
    <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" autofocus>
  </label>
  <button class="approve" name="action" value="approve">Approve and run</button>
  <button name="action" value="reject" formnovalidate>Reject</button>
</form>`);
}

function resultPage(plan: Plan) {
  const text = {
    [PlanStatus.applied]: { kind: 'ok', text: `Applied ${plan.name}.` },
    [PlanStatus.failed]: { kind: 'error', text: `Failed, nothing was committed: ${plan.error}` },
    [PlanStatus.rejected]: { kind: 'error', text: `Rejected. ${plan.name} won't be run.` },
  }[plan.status as PlanStatus.applied | PlanStatus.failed | PlanStatus.rejected] ?? { kind: 'error', text: `Plan is ${plan.status}.` };
  return page(plan.name, `<h1>${escapeHtml(plan.name)}</h1><div class="msg ${text.kind}">${escapeHtml(text.text)}</div>`);
}

const notFound = (c: Context) => c.html(page('Not found', '<h1>Not found</h1><p>This approval link is unknown, expired or already used.</p>'), 404);

// Compares hashes so the lookup takes the same time whether or not a prefix of the token matches
function findPendingPlan(token: string): Plan | undefined {
  const wanted = crypto.createHash('sha256').update(token).digest();
  for (const plan of plans.values()) {
    if (!plan.approvalToken) continue;
    const candidate = crypto.createHash('sha256').update(plan.approvalToken).digest();
    if (!crypto.timingSafeEqual(wanted, candidate)) continue;
    if (plan.status !== PlanStatus.pending_approval) return undefined;
    if (expired(plan)) {
      plan.status = PlanStatus.expired;
      plan.approvalToken = undefined;
      return undefined;
    }
    return plan;
  }
  return undefined;
}

export function createApprovalApp() {
  const app = new Hono();

  app.use('*', async (c, next) => {
    // Blocks DNS rebinding: a website pointing its own domain at 127.0.0.1
    if (!ALLOWED_HOSTS.includes(c.req.header('host') ?? '')) return c.text('Forbidden', 403);
    // Blocks cross-site form posts. Browsers always send Origin on POST.
    if (c.req.method !== 'GET' && !ALLOWED_HOSTS.some((h) => c.req.header('origin') === `http://${h}`)) {
      return c.text('Forbidden', 403);
    }
    await next();
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
  });

  app.get('/static/app.css', (c) => c.body(STYLESHEET, 200, { 'Content-Type': 'text/css; charset=utf-8' }));

  app.get('/approve/:token', (c) => {
    const plan = findPendingPlan(c.req.param('token'));
    return plan ? c.html(approvalPage(plan)) : notFound(c);
  });

  app.post('/approve/:token', async (c) => {
    const plan = findPendingPlan(c.req.param('token'));
    if (!plan) return notFound(c);
    const form = await c.req.parseBody();
    const field = (name: string) => (typeof form[name] === 'string' ? (form[name] as string) : '');

    if (field('action') === 'reject') {
      plan.status = PlanStatus.rejected;
      plan.approvalToken = undefined;
      return c.html(resultPage(plan));
    }
    if (field('action') !== 'approve') return c.text('Bad request', 400);

    // No await between the status check above and executeMigration setting `applying`,
    // so two concurrent approvals can't both run the migration.
    const check = checkCode(field('code').trim());
    if (!check.ok) {
      if (check.reason === 'locked') {
        return c.html(approvalPage(plan, { kind: 'error', text: `Too many wrong codes. Approvals are locked until ${time(check.lockedUntil!)}.` }), 429);
      }
      plan.failedAttempts++;
      if (plan.failedAttempts >= MAX_ATTEMPTS_PER_PLAN) {
        plan.status = PlanStatus.rejected;
        plan.approvalToken = undefined;
        plan.error = 'Rejected after too many wrong codes.';
        return c.html(resultPage(plan), 403);
      }
      return c.html(approvalPage(plan, { kind: 'error', text: 'Wrong or already used code.' }), 403);
    }

    await executeMigration(plan, field('planId'));
    return c.html(resultPage(plan));
  });

  app.notFound(notFound);
  return app;
}

export function startApprovalServer() {
  serve({ fetch: createApprovalApp().fetch, port: APPROVAL_PORT, hostname: '127.0.0.1' }, () => {
    console.log(`Migration approval page listening on ${APPROVAL_ORIGIN}`);
  });
}
