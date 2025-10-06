const http = require('http');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const connectDb = require('./config/dbConnection');
const errorHandler = require('./utils/errorHandler');

// Routes (existing)
const authRoutes = require('./routers/authRoutes');
const authMemberRoutes = require('./routers/member/authMemberRoutes');
const employeeRoutes = require('./routers/owner/employeeRoutes');
const menuRoutes = require('./routers/owner/menuRoutes');
const memberManagementRoutes = require('./routers/owner/memberManagementRoutes');
const selfOrderRoutes = require('./routers/selfOrderRoutes'); // QR dine-in (punyamu)

// Routes (baru)
const orderRoutes = require('./routers/orderRoutes'); // order list/detail/kitchen/pay/status/cancel (punyamu yg sudah dirapikan)
const orderOpsRoutes = require('./routers/orderOpsRoutes'); // payment & delivery ops (baru kita buat)
const onlineRoutes = require('./routers/onlineRoutes'); // cart online + checkout online (baru kita buat)

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

// CORS
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  'http://localhost:5173'
];
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
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
      'X-Table-Number'
    ],
    credentials: true
  })
);
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ==== Public/Auth/Owner ==== */
app.use('/auth', authRoutes);
app.use('/employees', employeeRoutes);
app.use('/menu', menuRoutes);
app.use('/member-management', memberManagementRoutes);
app.use('/member', authMemberRoutes);
app.use('/self-order', selfOrderRoutes);
app.use('/online', onlineRoutes);

app.use('/orders', orderOpsRoutes);
app.use('/orders', orderRoutes);

app.use(errorHandler);

const server = http.createServer(app);
const { initSocket } = require('./controllers/socket/socketInit');
initSocket(server);

const { startJobs } = require('./jobs/index');
startJobs();

server.listen(port, () => console.log(`Server running on : ${port}`));
