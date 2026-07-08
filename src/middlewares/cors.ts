import cors from 'cors';
import config from '../config/config.js';

const allowedOrigins = [
  'https://aljostore.com',
  'https://www.aljostore.com',
  'http://localhost:5000'
];


if (config.ENV === 'development') {
  allowedOrigins.push('http://localhost:3000');
  allowedOrigins.push('http://localhost:5173');
  allowedOrigins.push('http://localhost:5000');
}

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});