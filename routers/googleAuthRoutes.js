// authRoutes.js
const express = require('express');
const { google } = require('googleapis');

const router = express.Router();

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  process.env.GOOGLE_OAUTH_REDIRECT_URI
);

router.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive']
  });
  res.redirect(url);
});

router.get('/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  console.log('TOKENS:', tokens);
  res.send(
    'OK. Cek server log untuk refresh_token. Simpan ke .env lalu restart.'
  );
});

module.exports = router;
