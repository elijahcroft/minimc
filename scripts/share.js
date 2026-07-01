import net from 'node:net';
import { spawn } from 'node:child_process';

const port = Number(process.env.PORT || 8099);
const origin = `http://127.0.0.1:${port}`;
const tunnelPref = (process.env.TUNNEL || 'auto').toLowerCase();

let serverProcess = null;
let tunnelProcess = null;
let shuttingDown = false;

function log(message = '') {
  process.stdout.write(`${message}\n`);
}

function isListening(host, targetPort) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: targetPort });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServerIfNeeded() {
  if (await isListening('127.0.0.1', port)) {
    log(`Using existing Mini Minecraft server on ${origin}`);
    return;
  }

  log(`Starting Mini Minecraft server on ${origin} ...`);
  serverProcess = spawn(process.execPath, ['server.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port) },
  });

  serverProcess.stdout.on('data', (chunk) => process.stdout.write(chunk));
  serverProcess.stderr.on('data', (chunk) => process.stderr.write(chunk));
  serverProcess.on('exit', (code, signal) => {
    if (!shuttingDown) {
      log(`Server exited${signal ? ` with ${signal}` : ` with code ${code}`}.`);
      cleanup(1);
    }
  });

  for (let i = 0; i < 20; i++) {
    if (await isListening('127.0.0.1', port)) return;
    await wait(250);
  }

  throw new Error(`Server did not start on ${origin}`);
}

function printPublicUrl(url) {
  log('');
  log('Public join URL:');
  log(`  ${url}`);
  log('Teacher URL:');
  log(`  ${url}${url.includes('?') ? '&' : '?'}teacher=1`);
  log('');
  log('Keep this terminal open while people are playing.');
}

function spawnTunnel(command, args, urlPattern) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let printed = false;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    tunnelProcess = child;

    const handleText = (chunk, write) => {
      const text = String(chunk);
      write(chunk);
      const match = text.match(urlPattern);
      if (match && !printed) {
        printed = true;
        printPublicUrl(match[0]);
      }
    };

    child.stdout.on('data', (chunk) => handleText(chunk, process.stdout.write.bind(process.stdout)));
    child.stderr.on('data', (chunk) => handleText(chunk, process.stderr.write.bind(process.stderr)));

    child.once('spawn', () => {
      settled = true;
      resolve(child);
    });
    child.once('error', (error) => {
      if (!settled) reject(error);
    });
    child.once('exit', (code, signal) => {
      if (!shuttingDown) {
        log(`Tunnel exited${signal ? ` with ${signal}` : ` with code ${code}`}.`);
        cleanup(code || 1);
      }
    });
  });
}

async function startTunnel() {
  if (tunnelPref !== 'localtunnel') {
    try {
      log(`Opening Cloudflare Tunnel to ${origin} ...`);
      await spawnTunnel('cloudflared', ['tunnel', '--url', origin], /https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/g);
      return;
    } catch (error) {
      if (tunnelPref === 'cloudflared') throw error;
      log('cloudflared is not available; falling back to npx localtunnel.');
    }
  }

  log(`Opening localtunnel to ${origin} ...`);
  await spawnTunnel('npx', ['--yes', 'localtunnel', '--port', String(port)], /https:\/\/[a-zA-Z0-9.-]+\.loca\.lt/g);
}

function cleanup(code = 0) {
  shuttingDown = true;
  if (tunnelProcess && !tunnelProcess.killed) tunnelProcess.kill('SIGTERM');
  if (serverProcess && !serverProcess.killed) serverProcess.kill('SIGTERM');
  process.exit(code);
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

try {
  await startServerIfNeeded();
  await startTunnel();
} catch (error) {
  log('');
  log(`Could not open a tunnel: ${error.message}`);
  log('');
  log('Install Cloudflare Tunnel and try again, or let the fallback download localtunnel:');
  log('  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  cleanup(1);
}
