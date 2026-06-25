'use strict';

const INTENTS = [
  { pattern: /^(hi|hello|hey|start|hujambo|habari|sasa|niaje)/i, intent: 'greeting' },
  { pattern: /^(menu|back|home|main|start over)/i, intent: 'menu' },
  { pattern: /^(0|cancel|stop|quit|exit)/i, intent: 'menu' },
  { pattern: /(product|shop|buy|sell|item|phone|laptop|sofa|electronics|clothes|shoes)/i, intent: 'products' },
  { pattern: /(service|plumb|electric|clean|mov|techni|paint|carpen|fundi)/i, intent: 'services' },
  { pattern: /(hous|rent|bedsit|studio|bedroom|apartment|flat|room|property|landlord|tenant)/i, intent: 'housing' },
  { pattern: /(event|concert|show|expo|confer|ticket|festival)/i, intent: 'events' },
  { pattern: /(account|profile|dashboard|my order|my listing|my propert|my rent|seller|landlord portal|tenant portal)/i, intent: 'account' },
  { pattern: /(ai|chat|help|ask|question|assist|bot)/i, intent: 'ai' },
];

function detectIntent(text) {
  const t = text.trim();
  for (const { pattern, intent } of INTENTS) {
    if (pattern.test(t)) return intent;
  }
  return null;
}

function isNumericChoice(text) {
  return /^[1-9]$/.test(text.trim());
}

module.exports = { detectIntent, isNumericChoice };
