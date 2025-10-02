const multer = require('multer');
const storage = multer.memoryStorage();

const imageFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png/;
  const isMimeTypeValid = allowedTypes.test(file.mimetype.toLowerCase());
  const isExtValid = allowedTypes.test(file.originalname.toLowerCase());

  if (isMimeTypeValid && isExtValid) {
    cb(null, true);
  } else {
    cb(new Error('File gambar hanya boleh jpg, jpeg, atau png!'));
  }
};

const pdfFilter = (req, file, cb) => {
  const allowedTypes = /pdf/;
  const isMimeTypeValid = allowedTypes.test(file.mimetype.toLowerCase());
  const isExtValid = allowedTypes.test(file.originalname.toLowerCase());

  if (isMimeTypeValid && isExtValid) {
    cb(null, true);
  } else {
    cb(new Error('File hanya boleh dalam format PDF!'));
  }
};

const imageUploader = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // max 5 MB
  fileFilter: imageFilter
});

const pdfUploader = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // max 10 MB
  fileFilter: pdfFilter
});

module.exports = { imageUploader, pdfUploader };
