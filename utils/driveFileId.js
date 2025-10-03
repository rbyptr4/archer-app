// utils/driveFileId.js
function extractDriveFileId(url = '') {
  if (!url) return null;
  // format umum: ...?id=<ID>
  const m1 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m1) return m1[1];
  // format share link: /file/d/<ID>/view
  const m2 = url.match(/\/d\/([a-zA-Z0-9_-]+)\//);
  if (m2) return m2[1];
  return null;
}

module.exports = { extractDriveFileId };
