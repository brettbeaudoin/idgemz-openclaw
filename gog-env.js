const fs = require('fs');

const PASSWORD_FILE = '/Users/bbeaudoin/.config/gogcli-keyring-password';

function configureGogEnv() {
  process.env.HOME ||= '/Users/bbeaudoin';
  process.env.USER ||= 'bbeaudoin';
  process.env.LOGNAME ||= 'bbeaudoin';
  process.env.SHELL ||= '/bin/bash';
  process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`;

  if (!process.env.GOG_KEYRING_PASSWORD) {
    try {
      process.env.GOG_KEYRING_PASSWORD = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
    } catch {
      // Leave unset; gog will report a clear auth/keyring error.
    }
  }
}

configureGogEnv();

module.exports = { configureGogEnv };
