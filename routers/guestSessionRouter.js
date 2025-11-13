// routes/guestSession.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const GuestSession = require('../models/guestSessionModel');

// konfigurasi TTL (jam)
const GUEST_TTL_HOURS = parseInt(process.env.GUEST_TTL_HOURS || '24', 10);

router.post('/session', async (req, res) => {
  try {
    const token = uuidv4();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + GUEST_TTL_HOURS * 60 * 60 * 1000
    );

    const doc = await GuestSession.create({
      token,
      createdAt: now,
      expiresAt,
      ip: req.ip,
      ua: req.get('user-agent') || null,
      meta: req.body?.meta || {}
    });

    return res
      .status(201)
      .json({ ok: true, guestToken: doc.token, expiresAt: doc.expiresAt });
  } catch (err) {
    console.error('POST error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// optional: check token validity endpoint
router.get('/session/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const doc = await GuestSession.findOne({ token }).lean();
    if (!doc) return res.status(404).json({ ok: false, error: 'not_found' });
    if (new Date(doc.expiresAt) < new Date())
      return res.status(410).json({ ok: false, error: 'expired' });
    return res.json({ ok: true, token: doc.token, expiresAt: doc.expiresAt });
  } catch (err) {
    console.error('GET  error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
