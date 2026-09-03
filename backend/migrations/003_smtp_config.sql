-- SMTP configuration, editable from the console UI. A single row.
CREATE TABLE IF NOT EXISTS config (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    smtp_host           TEXT NOT NULL DEFAULT '',
    smtp_port           INTEGER NOT NULL DEFAULT 587,
    smtp_username       TEXT NOT NULL DEFAULT '',
    smtp_password_enc   TEXT NOT NULL DEFAULT '',
    smtp_from           TEXT NOT NULL DEFAULT '',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);