const http = require('http');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const connectDb = require('./config/dbConnection');
const errorHandler = require('./utils/errorHandler');

const authRoutes = require('./routers/authRoutes');
const authMemberRoutes = require('./routers/member/authMemberRoutes');
const menuMemberRoutes = require('./routers/member/menuMemberRoutes');
const voucherMemberRoutes = require('./routers/member/voucherMemberRoutes');
const voucherRoutes = require('./routers/owner/voucherRoutes');
const employeeRoutes = require('./routers/owner/employeeRoutes');
const orderHistoryRoutes = require('./routers/owner/orderHistoryRoutes');
const menuRoutes = require('./routers/owner/menuRoutes');
const menuPackagesRoutes = require('./routers/owner/packageMenuRoutes');
const categoryRoutes = require('./routers/owner/menuCategoryRoutes');
const memberManagementRoutes = require('./routers/owner/memberManagementRoutes');
const expenseRoutes = require('./routers/expenseRoutes');
const orderRoutes = require('./routers/orderRoutes'); // order list/detail/kitchen/pay/status/cancel (punyamu yg sudah dirapikan)

// Models (load sekali di awal)
require('./models/orderModel');
require('./models/menuModel');
require('./models/memberModel');
require('./models/cartModel');

const app = express();
const port = process.env.PORT || 3001;

connectDb();

app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true })); // biar form non-file juga kebaca
app.use(cookieParser());

const STATIC_ALLOWED_ORIGINS = [
  process.env.APP_URL || 'https://archer-app.vercel.app'
];

// helper: cek apakah origin boleh
const isOriginAllowed = (origin) => {
  if (!origin) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  if (/^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/.test(origin)) return true;
  return STATIC_ALLOWED_ORIGINS.includes(origin);
};

const BASE_ALLOWED_HEADERS = [
  'content-type',
  'authorization',
  'x-requested-with',
  'requiresauth',
  'x-qr-session',
  'x-online-session',
  'x-table-number',
  'x-order-source',
  'x-device-id',
  'x-fulfillment-type'
];

const EXPOSE_HEADERS = [];

const corsOptionsDelegate = (req, cb) => {
  const origin = req.header('Origin');
  const allowed = isOriginAllowed(origin);

  const requested = (req.header('Access-Control-Request-Headers') || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const allowedHeaders = Array.from(
    new Set([...BASE_ALLOWED_HEADERS, ...requested])
  );

  cb(null, {
    origin: allowed ? origin : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders,
    exposedHeaders: EXPOSE_HEADERS,
    optionsSuccessStatus: 204,
    preflightContinue: false
  });
};

app.use(cors(corsOptionsDelegate));
app.options(/.*/, cors(corsOptionsDelegate));
/* =============================================================================== */

/* ==== Public/Auth/Owner ==== */
app.use('/auth', authRoutes);
app.use('/employees', employeeRoutes);
app.use('/menu', menuRoutes);
app.use('/menu/packages', menuPackagesRoutes);
app.use('/menu/category', categoryRoutes);
app.use('/expense', expenseRoutes);
app.use('/member-management', memberManagementRoutes);
app.use('/member', authMemberRoutes);
app.use('/member/menu', menuMemberRoutes);
app.use('/member/voucher', voucherMemberRoutes);
app.use('/voucher', voucherRoutes);
app.use('/history', orderHistoryRoutes);
app.use('/orders', orderRoutes);

app.use(errorHandler);

const server = http.createServer(app);
const { initSocket } = require('./controllers/socket/socketInit');
initSocket(server);

const { startJobs } = require('./jobs/index');
startJobs();

server.listen(port, () => console.log(`Server running on : ${port}`));
