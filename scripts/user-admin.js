#!/usr/bin/env node
// CLI for managing user accounts in trade.db
// Usage:
//   npm run user:create -- <username>
//   npm run user:list

const { DatabaseSync } = require('node:sqlite');
const { scryptSync, randomBytes } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'trade.db');
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Format: scrypt:<hex-salt>:<hex-hash>
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

// Read password from terminal without echoing characters
function promptPassword(prompt) {
  return new Promise((resolve) => {
    process.stderr.write(prompt);

    if (process.stdin.isTTY) {
      let password = '';
      try { process.stdin.setRawMode(true); } catch {
        // setRawMode not available; fall back to visible input
        const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stderr });
        rl.question('', (answer) => { rl.close(); resolve(answer); });
        return;
      }
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      function onData(char) {
        if (char === '\r' || char === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stderr.write('\n');
          resolve(password);
        } else if (char === '') { // Ctrl+C
          process.exit(0);
        } else if (char === '' || char === '\b') { // Backspace
          password = password.slice(0, -1);
        } else {
          password += char;
        }
      }
      process.stdin.on('data', onData);
    } else {
      // Non-TTY (piped input)
      const rl = require('node:readline').createInterface({ input: process.stdin });
      rl.once('line', (line) => { rl.close(); resolve(line.trim()); });
    }
  });
}

async function cmdCreate(username) {
  if (!username) {
    console.error('Usage: npm run user:create -- <username>');
    process.exit(1);
  }

  const password = await promptPassword('Password: ');
  const confirm  = await promptPassword('Confirm:  ');

  if (password !== confirm) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  try {
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
    console.log(`User "${username}" created.`);
  } catch (err) {
    if (err.message?.includes('UNIQUE')) {
      console.error(`Error: user "${username}" already exists.`);
    } else {
      console.error('Error:', err.message);
    }
    process.exit(1);
  }
}

function cmdList() {
  const users = db.prepare('SELECT id, username, created_at FROM users ORDER BY id').all();
  if (users.length === 0) {
    console.log('No users found.');
    return;
  }
  console.log(`\nUsers (${users.length}):`);
  for (const u of users) {
    console.log(`  ${u.id}. ${u.username}  (created: ${u.created_at})`);
  }
  console.log();
}

async function main() {
  const [,, command, arg] = process.argv;

  if (command === 'create') {
    await cmdCreate(arg);
  } else if (command === 'list') {
    cmdList();
  } else {
    console.log('Commands:');
    console.log('  npm run user:create -- <username>');
    console.log('  npm run user:list');
    process.exit(1);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
