const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

router.get('/me', requireAuth, (req, res) => {
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id);
  if (!wallet) return res.status(404).json({ error: 'WALLET_NOT_FOUND' });
  res.json({
    id: wallet.id,
    availableBalance: wallet.available_balance,
    lockedBalance: wallet.locked_balance,
    version: wallet.version,
    updatedAt: wallet.updated_at,
  });
});

router.get('/me/entries', requireAuth, (req, res) => {
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id);
  if (!wallet) return res.status(404).json({ error: 'WALLET_NOT_FOUND' });
  const entries = db
    .prepare('SELECT * FROM wallet_entries WHERE wallet_id = ? ORDER BY created_at DESC, id DESC LIMIT 200')
    .all(wallet.id);
  res.json({
    entries: entries.map((e) => ({
      id: e.id,
      transactionId: e.transaction_id,
      entryType: e.entry_type,
      availableDelta: e.available_delta,
      lockedDelta: e.locked_delta,
      availableAfter: e.available_after,
      lockedAfter: e.locked_after,
      description: e.description,
      createdAt: e.created_at,
    })),
  });
});

module.exports = router;
