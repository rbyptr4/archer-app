// utils/googleDrive.js
const { google } = require('googleapis');
const { Readable } = require('stream');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  process.env.GOOGLE_OAUTH_REDIRECT_URI
);

// refresh_token => lib akan auto-refresh access token
oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });

function extractDriveIdFromUrl(url = '') {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.searchParams && u.searchParams.get('id'))
      return u.searchParams.get('id');
    const seg = u.pathname.split('/').filter(Boolean);
    return seg.length ? seg[seg.length - 1] : null;
  } catch (err) {
    const m = url.match(/(?:id=)([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    const parts = url.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  }
}

async function uploadBuffer(fileBuffer, fileName, mimeType, folderId) {
  if (!folderId) throw new Error('Missing folderId');

  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: Readable.from(fileBuffer) },
    fields: 'id, name, webViewLink, webContentLink'
  });

  const file = res.data;

  // Opsional: bikin bisa diakses publik biar <img src> langsung jalan
  if (String(process.env.DRIVE_PUBLIC).toLowerCase() === 'true') {
    try {
      await drive.permissions.create({
        fileId: file.id,
        requestBody: { role: 'reader', type: 'anyone' } // anyone with the link
      });
    } catch (e) {
      console.warn('[drive] set public failed:', e?.message || e);
    }
  }

  return file; // { id, ... }
}

async function getFile(fileId) {
  const res = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, webViewLink, webContentLink'
  });
  return res.data;
}

async function deleteFile(fileId) {
  await drive.files.delete({ fileId });
  return true;
}

// (opsional) stream konten file privat lewat backend
async function streamFile(res, fileId) {
  const dl = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );
  dl.data.pipe(res);
}

module.exports = {
  uploadBuffer,
  getFile,
  deleteFile,
  streamFile,
  extractDriveIdFromUrl
};
