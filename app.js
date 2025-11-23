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
const closingShiftRoutes = require('./routers/closingShiftRoutes');
const orderRoutes = require('./routers/orderRoutes'); // order list/detail/kitchen/pay/status/cancel (punyamu yg sudah dirapikan)
const paymentRoutes = require('./routers/paymentRoutes');
const guestSession = require('./routers/guestSessionRouter');
const promoRoutes = require('./routers/owner/promoRouter');

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
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// CORS
const allowedOrigins = [
  process.env.APP_URL || 'https://archer-app.vercel.app',
  'http://localhost:5173'
];
app.use(
  cors({
    origin(origin, cb) {
      console.log('[CORS] incoming origin ->', origin);
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      console.warn('[CORS] rejected origin ->', origin);
      return cb(new Error('Not allowed by CORS: ' + origin));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'requiresAuth',
      'X-QR-Session',
      'X-Online-Session',
      'X-Table-Number',
      'X-Order-Source',
      'X-Device-Id',
      'X-Fulfillment-Type',
      'x-callback-token'
    ],
    credentials: true
  })
);

app.use((req, res, next) => {
  try {
    const origin = req.get('Origin') || req.get('origin');
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET,POST,PUT,PATCH,DELETE,OPTIONS'
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization,Content-Type,Accept,X-Requested-With,Origin'
      );
    }

    if (
      req.path.includes('/orders/') &&
      (req.method === 'PATCH' || req.method === 'OPTIONS')
    ) {
      console.log('[REQ_DEBUG]', {
        method: req.method,
        path: req.path,
        origin,
        hasAuth: !!req.get('Authorization'),
        headers: {
          'content-type': req.get('content-type'),
          'access-control-request-headers': req.get(
            'access-control-request-headers'
          )
        }
      });
    }

    if (req.method === 'OPTIONS') return res.sendStatus(204);
  } catch (err) {
    console.error('[CORS_DEBUG_MW]', err?.message || err);
  }
  next();
});

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/guest', guestSession);
app.use('/auth', authRoutes);
app.use('/employees', employeeRoutes);
app.use('/closing-shift', closingShiftRoutes);
app.use('/menu', menuRoutes);
app.use('/menu/packages', menuPackagesRoutes);
app.use('/menu/category', categoryRoutes);
app.use('/expense', expenseRoutes);
app.use('/member-management', memberManagementRoutes);
app.use('/member', authMemberRoutes);
app.use('/member/menu', menuMemberRoutes);
app.use('/member/voucher', voucherMemberRoutes);
app.use('/voucher', voucherRoutes);
app.use('/promo', promoRoutes);
app.use('/history', orderHistoryRoutes);
app.use('/orders', orderRoutes);
app.use('/payments', paymentRoutes);

app.use((err, req, res, next) => {
  const origin = req.get('Origin');
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  next(err);
});

app.use(errorHandler);

const server = http.createServer(app);
const { initSocket } = require('./controllers/socket/socketInit');
initSocket(server);

const { startJobs } = require('./jobs/index');
startJobs();

server.listen(port, () => console.log(`Server running on : ${port}`));
