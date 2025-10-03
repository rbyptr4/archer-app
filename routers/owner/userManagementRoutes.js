const express = require('express');
const {
  getMembers,
  deleteMember
} = require('../../controllers/owner/userManagementController');
const router = express.Router();

const validateToken = require('../../utils/tokenHandler');
const requireRole = require('../../utils/requireRole');

// router.use(validateToken, requireRole('owner'));

router.get('/all-member', getMembers);

router.delete('/remove/:id', deleteMember);

module.exports = router;
