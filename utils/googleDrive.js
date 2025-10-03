const { google } = require('googleapis');
const { Readable } = require('stream');

const jwtClient = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/drive']
});

const drive = google.drive({ version: 'v3', auth: jwtClient });

async function uploadBuffer(fileBuffer, fileName, mimeType, folderId) {
  console.log('[DEBUG] Upload to folderId:', folderId);
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId] // kalau ini undefined/empty, error quota muncul
    },
    media: {
      mimeType,
      body: Readable.from(fileBuffer)
    },
    fields: 'id, webViewLink, webContentLink'
  });
  return res.data;
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

module.exports = { uploadBuffer, getFile, deleteFile };
