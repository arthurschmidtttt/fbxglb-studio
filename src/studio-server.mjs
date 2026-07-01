import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const studioDir = path.join(rootDir, 'studio');

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length
  });
  res.end(body);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

async function collectFiles(root, suffix = '') {
  const results = [];

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && (!suffix || full.toLowerCase().endsWith(suffix))) {
        results.push(full);
      }
    }
  }

  await walk(root);
  results.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return results;
}

async function pickFolder() {
  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = "Select the project folder"',
    '$dialog.UseDescriptionForTitle = $true',
    '$dialog.ShowNewFolderButton = $false',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  Write-Output $dialog.SelectedPath',
    '}'
  ].join('; ');

  return await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', psScript], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Folder picker exited with code ${code}`));
        return;
      }

      const picked = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      resolve(picked);
    });
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isSafeAbsolutePath(targetPath) {
  return path.isAbsolute(targetPath) && !targetPath.includes('\0');
}

function resolveBlenderCommand() {
  return [
    process.env.BLENDER_PATH,
    'blender',
    'C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 5.0\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.4\\blender.exe'
  ].filter(Boolean);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stdout += text;
        process.stdout.write(text);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stderr += text;
        process.stderr.write(text);
      });
    }

    child.on('error', (error) => {
      reject(error);
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error((stderr || stdout).trim() || `${command} exited with code ${code}`));
      }
    });
  });
}

async function runBlenderScript(scriptPath, scriptArgs, options = {}) {
  const args = ['--background', '--python', scriptPath, '--', ...scriptArgs];
  let lastError = null;

  for (const command of resolveBlenderCommand()) {
    try {
      await runProcess(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options
      });
      return;
    } catch (error) {
      lastError = error;
      if (error && error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  throw lastError || new Error('Blender executable not found.');
}

function serveFile(res, filePath) {
  const stream = fs.createReadStream(filePath);
  res.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Cache-Control': 'no-store'
  });
  stream.pipe(res);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(404);
    }
    res.end('Not found');
  });
}

async function main() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname;

      if (pathname === '/') {
        serveFile(res, path.join(studioDir, 'index.html'));
        return;
      }

      if (pathname.startsWith('/studio/')) {
        const filePath = path.join(rootDir, pathname.slice(1));
        serveFile(res, filePath);
        return;
      }

      if (pathname.startsWith('/node_modules/')) {
        const filePath = path.join(rootDir, pathname.slice(1));
        serveFile(res, filePath);
        return;
      }

      if (pathname === '/logo.png') {
        serveFile(res, path.join(rootDir, 'logo.png'));
        return;
      }

      if (pathname === '/api/scan') {
        const dir = url.searchParams.get('dir');
        if (!dir || !isSafeAbsolutePath(dir)) {
          sendJson(res, 400, { error: 'Invalid directory.' });
          return;
        }

        const files = await collectFiles(dir);
        sendJson(res, 200, { dir, files });
        return;
      }

      if (pathname === '/api/pick-folder') {
        const picked = await pickFolder();
        if (!picked) {
          sendJson(res, 200, { canceled: true });
          return;
        }

        sendJson(res, 200, { path: picked });
        return;
      }

      if (pathname === '/api/file') {
        const filePath = url.searchParams.get('path');
        if (!filePath || !isSafeAbsolutePath(filePath)) {
          res.writeHead(400);
          res.end('Invalid path.');
          return;
        }

        serveFile(res, filePath);
        return;
      }

      if (pathname === '/api/export' && req.method === 'POST') {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body);
        const { inputDir, outputPath, settings = {}, baseFilePath = '' } = payload;

        if (!inputDir || !isSafeAbsolutePath(inputDir)) {
          sendJson(res, 400, { error: 'Invalid inputDir.' });
          return;
        }

        const finalOutput = outputPath && isSafeAbsolutePath(outputPath)
          ? outputPath
          : path.join(inputDir, 'merged.glb');

        const configPath = path.join(rootDir, '.tmp', 'studio-export-config.json');
        await fsp.mkdir(path.dirname(configPath), { recursive: true });
        await fsp.writeFile(configPath, JSON.stringify({ settings, baseFilePath }, null, 2), 'utf8');

        await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [
            path.join(rootDir, 'src', 'merge-fbx-folder.mjs'),
            inputDir,
            finalOutput
          ], {
            stdio: 'inherit',
            env: {
              ...process.env,
              FBX_GLB_CONFIG_PATH: configPath
            }
          });

          child.on('error', reject);
          child.on('exit', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Export exited with code ${code}`));
            }
          });
        });

        sendJson(res, 200, { ok: true, outputPath: finalOutput });
        return;
      }

      if (pathname === '/api/export-mixamo' && req.method === 'POST') {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body);
        const { inputFile, outputPath } = payload;

        if (!inputFile || !isSafeAbsolutePath(inputFile)) {
          sendJson(res, 400, { error: 'Invalid inputFile.' });
          return;
        }

        const finalOutput = outputPath && isSafeAbsolutePath(outputPath)
          ? outputPath
          : path.join(path.dirname(inputFile), 'z-avatar-mixamo.fbx');

        await runBlenderScript(
          path.join(rootDir, 'src', 'blender_mixamo_export.py'),
          [inputFile, finalOutput],
          { cwd: rootDir }
        );

        sendJson(res, 200, { ok: true, outputPath: finalOutput });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Studio running at ${url}`);
    console.log('Open this URL in your browser.');
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
