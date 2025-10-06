const express = require('express');
const {
  loginMember,
  registerMember,
  logoutMember,
  member,
  refreshMember
} = require('../../controllers/member/authMemberController');
const authMember = require('../../middlewares/authMember');

const router = express.Router();

router.post('/login', loginMember);
router.post('/refresh-token', refreshMember);
router.post('/register', registerMember);
router.get('/me', authMember, member);
router.post('/logout', logoutMember);

module.exports = router;
