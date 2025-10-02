const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const connectDb = require('./config/dbConnection');
const errorHandler = require('./utils/errorHandler');
const validateToken = require('./utils/tokenHandler');

const app = express();
const port = process.env.PORT || 3001;

// ---------- DB ----------
connectDb();

// ---------- App setup ----------
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ---------- CORS ----------
const allowedOrigins = [
  process.env.FRONTEND_URL || 'https://soilab-app.vercel.app',
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
      'requiresAuth'
    ],
    credentials: true
  })
);

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    // header CORS sudah dipasang oleh cors() di atas
    return res.sendStatus(204); // No Content
  }
  next();
});

// ---------------- PROTECTED ROUTES (global) ----------------
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  next();
});

// ---------------- PROTECTED ROUTES (global) ----------------
app.use(validateToken);
app.use(errorHandler);

app.listen(port, () => {
  console.log(`Server is running at port : ${port}`);
});
