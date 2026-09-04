// Native file dialogs for the localhost web app.
//
// A sandboxed browser can NEVER reveal a file's absolute path (<input type=file>
// only exposes the bare name). But this tool's backend runs on the *same*
// machine as the browser, so we spawn the OS file picker and hand the real path
// back to the UI. That is what lets the mid panel "open a local folder" and then
// "display the full filepath".
//
// Pickers, in preference order per platform:
//   linux   -> zenity, then kdialog
//   darwin  -> osascript (choose file / folder / file name)
//   win32   -> PowerShell (WinForms OpenFileDialog / SaveFileDialog)
// If none is installed the route returns { ok:false } and the UI falls back to
// manual path entry, so nothing ever hard-breaks.
//
// SECURITY: linux pickers are spawned with argv arrays (no shell), so the
// user-supplied title/patterns/startDir can never inject a command. The
// script-based pickers (darwin/win32) interpolate into a string, so those values
// are sanitized (quotes/backslashes/newlines stripped) first.
import { spawn } from 'node:child_process';

// Run a picker; resolve with its exit code + trimmed stdout. A missing binary
// surfaces as notFound (ENOENT) so we can try the next candidate.
function run(cmd, args) {
  return new Promise((res) => {
    let out = '';
    let err = '';
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    c.on('error', () => res({ code: -1, out: '', err: 'spawn failed', notFound: true }));
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => res({ code, out: out.trim(), err: err.trim(), notFound: false }));
  });
}

const sanitize = (s) => String(s == null ? '' : s).replace(/["'`\\\r\n]/g, '');

// zenity/kdialog filter spec from an extension list, e.g. ['glb'] -> '*.glb'.
const globs = (patterns) => patterns.map((p) => `*.${String(p).replace(/^\./, '')}`);

function candidates(mode, { title, patterns, filterName, startDir, defaultName }) {
  const t = title || (mode === 'save' ? 'Choose a destination' : 'Select a file');
  const g = globs(patterns || []);

  if (process.platform === 'linux') {
    const z = ['--file-selection', `--title=${t}`];
    if (mode === 'save') z.push('--save', '--confirm-overwrite');
    if (mode === 'dir') z.push('--directory');
    const zFilter = g.length ? ['--file-filter', `${filterName || 'Files'} | ${g.join(' ')}`] : [];
    // --filename pre-opens the dialog at a directory (trailing '/') or a file.
    const seed = mode === 'save' && defaultName
      ? `${startDir}/${defaultName}`
      : `${startDir}/`;
    const zStart = startDir ? ['--filename', seed] : [];

    const kFilter = g.length ? `${filterName || 'Files'} (${g.join(' ')})` : '';
    const k = mode === 'save'
      ? ['--getsavefilename', startDir || '', kFilter, '--title', t]
      : mode === 'dir'
        ? ['--getexistingdirectory', startDir || '', '--title', t]
        : ['--getopenfilename', startDir || '', kFilter, '--title', t];

    return [{ cmd: 'zenity', args: [...z, ...zFilter, ...zStart] }, { cmd: 'kdialog', args: k }];
  }

  if (process.platform === 'darwin') {
    const st = sanitize(startDir);
    const types = g.length ? ` of type {${(patterns || []).map((p) => `"${sanitize(p).replace(/^\./, '')}"`).join(', ')}}` : '';
    const loc = st ? ` default location "${st}"` : '';
    const script = mode === 'save'
      ? `POSIX path of (choose file name with prompt "${sanitize(t)}"${loc})`
      : mode === 'dir'
        ? `POSIX path of (choose folder with prompt "${sanitize(t)}"${loc})`
        : `POSIX path of (choose file with prompt "${sanitize(t)}"${types}${loc})`;
    return [{ cmd: 'osascript', args: ['-e', script] }];
  }

  if (process.platform === 'win32') {
    const dlg = mode === 'save' ? 'SaveFileDialog' : 'OpenFileDialog';
    const filter = g.length
      ? `${sanitize(filterName || 'Files')} (${g.join(';')})|${g.join(';')}`
      : 'All files (*.*)|*.*';
    const init = sanitize(startDir) ? `$d.InitialDirectory='${sanitize(startDir)}';` : '';
    const ps = `Add-Type -AssemblyName System.Windows.Forms;`
      + `$d=New-Object System.Windows.Forms.${dlg};`
      + `$d.Title='${sanitize(t)}';$d.Filter='${filter}';${init}`
      + `if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){$d.FileName}`;
    return [{ cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps] }];
  }

  return [];
}

export function fsRoutes(app, kernel) {
  const repoRoot = kernel.host.repoRoot;

  // POST /api/fs/pick { mode:'open'|'save'|'dir', title, patterns:[ext], filterName, startDir, defaultName }
  // -> { ok:true, path } | { ok:true, canceled:true } | { ok:false, error }
  app.post('/api/fs/pick', async (req, reply) => {
    const {
      mode = 'open', title = '', patterns = [], filterName = '',
      startDir = null, defaultName = '',
    } = req.body || {};

    if (!['open', 'save', 'dir'].includes(mode)) {
      return reply.code(400).send({ ok: false, error: 'mode must be one of: open, save, dir' });
    }

    const start = startDir || repoRoot;
    const list = candidates(mode, { title, patterns, filterName, startDir: start, defaultName });
    if (!list.length) {
      return { ok: false, error: 'No native file dialog on this platform — type the path manually.' };
    }

    let lastErr = null;
    for (const c of list) {
      const r = await run(c.cmd, c.args);
      if (r.notFound) { lastErr = `${c.cmd} is not installed`; continue; }        // try the next picker
      if (r.code === 0 && r.out) return { ok: true, path: r.out, picker: c.cmd }; // chosen
      if (r.code === 1 || (r.code === 0 && !r.out)) return { ok: true, canceled: true, picker: c.cmd }; // user canceled
      lastErr = r.err || `${c.cmd} exited with code ${r.code}`;                   // real error: try next
    }
    return { ok: false, error: `${lastErr || 'Dialog unavailable'} — type the path manually.` };
  });
}
