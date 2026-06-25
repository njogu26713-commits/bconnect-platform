
'use strict';

const TTL_MS = 30 * 60 * 1000;

const sessions = new Map();

function getSession(jid) {
  const s = sessions.get(jid);
  if (s) { s.lastActivity = Date.now(); return s; }
  const fresh = { step: 'main', data: {}, lastActivity: Date.now() };
  sessions.set(jid, fresh);
  return fresh;
}

function setStep(jid, step, data = {}) {
  const s = getSession(jid);
  s.step = step;
  Object.assign(s.data, data);
  s.lastActivity = Date.now();
}

function clearSession(jid) {
  sessions.delete(jid);
}

setInterval(() => {
  const now = Date.now();
  for (const [jid, s] of sessions.entries()) {
    if (now - s.lastActivity > TTL_MS) sessions.delete(jid);
  }
}, 5 * 60 * 1000);

module.exports = { getSession, setStep, clearSession };
