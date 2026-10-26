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
    // AI shopping agent — checked lazily by getAgentConfig() in src/agent/config.ts
    AGENT_ENABLED: process.env.AGENT_ENABLED || 'false',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
    VOYAGE_API_KEY: process.env.VOYAGE_API_KEY || '',
    LANGSMITH_TRACING: process.env.LANGSMITH_TRACING || 'false',
    LANGSMITH_API_KEY: process.env.LANGSMITH_API_KEY || '',
    LANGSMITH_PROJECT: process.env.LANGSMITH_PROJECT || 'aljo-store-agent',
    // Optional (spec 017): a general tracing backend. The exporter also reads the standard
    // OTEL_EXPORTER_OTLP_HEADERS itself (e.g. an API key header).
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '',
    // Optional (spec 016): urgent agent alerts are also POSTed here as { text } (Slack or Make.com)
    ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL || '',
    // Spec 021: the share of finished agent turns saved for the online judge (0 turns it off)
    AGENT_EVAL_SAMPLE_RATE: process.env.AGENT_EVAL_SAMPLE_RATE || '0.1',
    // TEMPORARY (spec 004): mounts POST /api/v1/agent/_stream-probe
    STREAM_PROBE_ENABLED: process.env.STREAM_PROBE_ENABLED || 'false',
}