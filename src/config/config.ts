import dotenvFlow from 'dotenv-flow';

dotenvFlow.config({
    default_node_env: 'development'
});

export default {
    ENV: process.env.ENV || 'development',
    PORT: process.env.PORT || 4000,
    SERVER_URL: process.env.SERVER_URL || `http://localhost:${process.env.PORT || 4000}`,
    DATABASE_URL: process.env.DATABASE_URL || '',
    JWT_SECRET: process.env.JWT_SECRET || '',
    REFRESH_TOKEN_SECRET: process.env.REFRESH_TOKEN_SECRET || '',
    JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN || '',
    JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '',
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_SECURE: process.env.SMTP_SECURE,
    GMAIL: process.env.GMAIL || '',
    PASSWORD: process.env.PASSWORD || '',
    STRIPE_SECRET: process.env.STRIPE_SECRET || '',
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
    FRONTEND_URL: process.env.FRONTEND_URL || 'https://mern-frontend-seven-iota.vercel.app',
    SUPPORT_WEBHOOK_URL: process.env.SUPPORT_WEBHOOK_URL || '',
}