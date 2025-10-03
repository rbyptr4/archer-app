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

const imageUploader = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // max 5 MB
  fileFilter: imageFilter
});

module.exports = imageUploader;
