require('dotenv').config();

const DRIVE_FOLDERS = {
  menu: process.env.MENU,
  invoice: process.env.INVOICE
};

function getDriveFolder(type) {
  const folderId = DRIVE_FOLDERS[type];
  if (!folderId) throw new Error(`Folder type "${type}" belum diset di .env`);
  return folderId;
}

module.exports = { getDriveFolder };
