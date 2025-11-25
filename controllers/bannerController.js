const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');

const Banner = require('../models/bannerModel');
const throwError = require('../utils/throwError');
const {
  uploadBuffer,
  deleteFile,
  extractDriveIdFromUrl
} = require('../utils/googleDrive');
const { getDriveFolder } = require('../utils/driveFolders');

// build file name simple helper
function buildBannerFileName(titleOrId, dateObj, originalName, mimetype) {
  const now = dateObj || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const ss = pad(now.getSeconds());

  const safeTitle = String(titleOrId || '')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-]/g, '')
    .slice(0, 40);

  const extMatch = (originalName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = extMatch
    ? `.${extMatch[1]}`
    : (mimetype || '').split('/').pop()
    ? `.${(mimetype || '').split('/').pop()}`
    : '.jpg';
  const rand = Math.random().toString(36).slice(2, 8);

  return `BANNER_${safeTitle}_${yyyy}${mm}${dd}_${hh}${mi}${ss}_${rand}${ext}`;
}

/**
 * POST /banners
 * body: { title, isActive? }
 * file: image (required)
 */
exports.createBanner = asyncHandler(async (req, res) => {
  const { title, isActive } = req.body || {};

  if (!title || !String(title).trim()) throwError('Field "title" wajib', 400);

  if (!req.file) throwError('File banner (image) wajib diunggah', 400);

  // determine active flag
  const activeFlag =
    isActive === undefined
      ? true
      : isActive === true ||
        String(isActive).toLowerCase() === 'true' ||
        String(isActive) === '1';

  if (activeFlag) {
    const activeCount = await Banner.countDocuments({ isActive: true });
    if (activeCount >= 5) {
      throwError(
        'Maks 5 Banner. Nonaktifkan salah satu banner terlebih dahulu',
        400
      );
    }
  }

  // upload file
  let imageUrl = '';
  try {
    const folderId = getDriveFolder('banner');
    const desiredName = buildBannerFileName(
      title,
      new Date(),
      req.file.originalname,
      req.file.mimetype
    );

    const uploaded = await uploadBuffer(
      req.file.buffer,
      desiredName,
      req.file.mimetype || 'image/jpeg',
      folderId
    );
    const id = uploaded && (uploaded.id || uploaded.fileId || uploaded._id);
    if (!id) throwError('Gagal mendapatkan file id setelah upload', 500);

    imageUrl = `https://drive.google.com/uc?export=view&id=${id}`;
  } catch (err) {
    console.error('[createBanner][upload]', err);
    throwError('Gagal mengunggah file banner', 500);
  }

  const doc = await Banner.create({
    title: String(title).trim(),
    imageUrl,
    isActive: activeFlag,
    createdBy: req.user ? req.user.id : null
  });

  res.status(201).json({ data: doc });
});

exports.listBanners = asyncHandler(async (req, res) => {
  const { q, limit = 20, cursor, isActive } = req.query || {};
  const start = req.query.start ? new Date(req.query.start) : null;
  const end = req.query.end ? new Date(req.query.end) : null;

  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  const pipeline = [];

  if ((start && !isNaN(start.getTime())) || (end && !isNaN(end.getTime()))) {
    const m = {};
    if (start && !isNaN(start.getTime())) m.$gte = start;
    if (end && !isNaN(end.getTime())) m.$lte = end;
    pipeline.push({ $match: { createdAt: m } });
  }

  if (cursor) {
    const d = new Date(cursor);
    if (!isNaN(d.getTime()))
      pipeline.push({ $match: { createdAt: { $lt: d } } });
  }

  if (q && String(q).trim()) {
    const regex = new RegExp(String(q).trim(), 'i');
    pipeline.push({
      $match: {
        $or: [{ title: { $regex: regex } }, { notes: { $regex: regex } }]
      }
    });
  }

  if (isActive !== undefined) {
    const b = String(isActive).toLowerCase();
    if (['1', 'true', 'yes'].includes(b))
      pipeline.push({ $match: { isActive: true } });
    else if (['0', 'false', 'no'].includes(b))
      pipeline.push({ $match: { isActive: false } });
  }

  pipeline.push({ $sort: { isActive: -1, createdAt: -1 } });
  pipeline.push({ $limit: lim + 1 });

  pipeline.push({
    $project: {
      _id: 1,
      title: 1,
      imageUrl: 1,
      isActive: 1,
      createdBy: 1,
      createdAt: 1,
      updatedAt: 1
    }
  });

  const rows = await Banner.aggregate(pipeline).allowDiskUse(true);
  const hasMore = rows.length > lim;
  const data = rows.slice(0, lim);
  const next_cursor = hasMore
    ? new Date(rows[lim - 1].createdAt).toISOString()
    : null;

  res.json({
    period: { start: start || null, end: end || null },
    data,
    next_cursor,
    limit: lim
  });
});

exports.getBannerById = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) throwError('ID tidak valid', 400);

  const doc = await Banner.findById(id).lean();
  if (!doc) throwError('Banner tidak ditemukan', 404);
  res.json({ data: doc });
});

exports.updateBanner = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) throwError('ID tidak valid', 400);

  const doc = await Banner.findById(id);
  if (!doc) throwError('Banner tidak ditemukan', 404);

  const { title, isActive } = req.body || {};

  if (title !== undefined) {
    if (!String(title).trim()) throwError('title tidak valid', 400);
    doc.title = String(title).trim();
  }

  if (isActive !== undefined) {
    const newActive =
      isActive === true ||
      String(isActive).toLowerCase() === 'true' ||
      String(isActive) === '1';
    if (newActive && doc.isActive === false) {
      const activeCount = await Banner.countDocuments({ isActive: true });
      if (activeCount >= 5) {
        throwError(
          'Maks 5 Banner. Nonaktifkan salah satu banner terlebih dahulu',
          400
        );
      }
    }
    doc.isActive = !!newActive;
  }

  // handle file replace
  if (req.file) {
    let uploaded;
    try {
      const folderId = getDriveFolder('banner');
      const desiredName = buildBannerFileName(
        doc.title || doc._id || 'banner',
        new Date(),
        req.file.originalname,
        req.file.mimetype
      );

      uploaded = await uploadBuffer(
        req.file.buffer,
        desiredName,
        req.file.mimetype || 'image/jpeg',
        folderId
      );
    } catch (err) {
      console.error('[updateBanner][uploadBuffer]', err);
      throwError('Gagal mengunggah file banner', 500);
    }

    const newFileId =
      uploaded && (uploaded.id || uploaded.fileId || uploaded._id);
    if (!newFileId) throwError('Gagal mendapatkan file id setelah upload', 500);
    const newUrl = `https://drive.google.com/uc?export=view&id=${newFileId}`;

    const oldUrl = doc.imageUrl;
    doc.imageUrl = newUrl;

    await doc.save();

    if (oldUrl) {
      const oldId = extractDriveIdFromUrl(oldUrl);
      if (oldId) {
        try {
          await deleteFile(oldId);
        } catch (err) {
          console.error('[updateBanner][delete old file]', err);
        }
      }
    }

    return res.json({ data: doc });
  }

  await doc.save();
  res.json({ data: doc });
});

// controllers/bannerController.js (tambahkan export ini)

exports.activateBanner = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) throwError('ID tidak valid', 400);

  const doc = await Banner.findById(id);
  if (!doc) throwError('Banner tidak ditemukan', 404);

  // jika sudah aktif, balikin response sukses (idempotent)
  if (doc.isActive) {
    return res.json({ message: 'Banner sudah aktif', data: doc });
  }

  // cek limit aktif (exclude current banner)
  const activeCount = await Banner.countDocuments({
    isActive: true,
    _id: { $ne: doc._id }
  });
  if (activeCount >= 5) {
    throwError(
      'Maks 5 Banner. Nonaktifkan salah satu banner terlebih dahulu',
      400
    );
  }

  doc.isActive = true;
  await doc.save();

  res.json({ message: 'Banner berhasil diaktifkan', data: doc });
});

exports.deactivateBanner = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) throwError('ID tidak valid', 400);

  const doc = await Banner.findById(id);
  if (!doc) throwError('Banner tidak ditemukan', 404);

  if (!doc.isActive) {
    return res.json({ message: 'Banner sudah non-aktif', data: doc });
  }

  doc.isActive = false;
  await doc.save();

  res.json({ message: 'Banner berhasil dinonaktifkan', data: doc });
});

exports.removeBanner = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) throwError('ID tidak valid', 400);

  const doc = await Banner.findById(id);
  if (!doc) throwError('Banner tidak ditemukan', 404);

  if (doc.imageUrl) {
    const fileId = extractDriveIdFromUrl(doc.imageUrl);
    if (fileId) {
      try {
        await deleteFile(fileId);
      } catch (err) {
        console.error('[removeBanner][deleteFile]', err);
      }
    }
  }

  await doc.deleteOne();
  res.json({ ok: true });
});
