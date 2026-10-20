-- Departments for VPN users (v1.0.23). Free-form names; a user belongs to at
-- most one department. Idempotent: migrations run on every boot.
CREATE TABLE IF NOT EXISTS departments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_name_unique
    ON departments (lower(name));
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_department_id
    ON users (department_id) WHERE department_id IS NOT NULL;
