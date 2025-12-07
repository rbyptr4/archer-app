require('dotenv').config();

const DRIVE_FOLDERS = {
  menu: process.env.MENU,
  invoice: process.env.INVOICE,
  banner: process.env.BANNER,
  expense: process.env.EXPENSE,
  delivery: process.env.DELIVERY
};

function getDriveFolder(type) {
  const folderId = DRIVE_FOLDERS[type];
  if (!folderId) throw new Error(`Folder type "${type}" belum diset di .env`);
  return folderId;
}

module.exports = { getDriveFolder };
