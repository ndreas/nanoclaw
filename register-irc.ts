#!/usr/bin/env npx tsx

import { initDatabase, setRegisteredGroup } from './dist/db.js';

// Initialize database
initDatabase();

// Register #home IRC channel
const ircHomeGroup = {
  name: '#home',
  folder: 'irc-home',
  trigger: '',  // No trigger needed since bot responds when mentioned
  added_at: new Date().toISOString(),
  requiresTrigger: false,  // Responds to all mentions
  isMain: false,
};

setRegisteredGroup('irc:#home', ircHomeGroup);

console.log('Registered IRC channel: irc:#home -> groups/irc-home');
console.log('The bot will now respond when mentioned in #home');
