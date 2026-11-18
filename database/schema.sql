
CREATE EXTENSION IF NOT EXISTS pgcrypto;
    
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(30) UNIQUE,
    password_hash TEXT NOT NULL,
    role VARCHAR(30) NOT NULL DEFAULT 'CUSTOMER',
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_user_status
      CHECK (status IN ('ACTIVE', 'SUSPENDED', 'PENDING'))
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id),
    balance_kobo BIGINT NOT NULL DEFAULT 0,
    currency CHAR(3) NOT NULL DEFAULT 'NGN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT wallet_balance_nonnegative
      CHECK (balance_kobo >= 0)
);

CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    reference VARCHAR(120) NOT NULL UNIQUE,
    type VARCHAR(40) NOT NULL,
    amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    provider VARCHAR(40),
    provider_reference VARCHAR(150),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES transactions(id),
    account_code VARCHAR(60) NOT NULL,
    entry_type VARCHAR(10) NOT NULL,
    amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_entry_type
      CHECK (entry_type IN ('DEBIT', 'CREDIT'))
);

CREATE INDEX IF NOT EXISTS transactions_user_created_idx
ON transactions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ledger_transaction_idx
ON ledger_entries (transaction_id);

-- DATA PURCHASE SAFETY FIELDS
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(120);

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- PREVENT DUPLICATE PURCHASE REQUESTS
CREATE UNIQUE INDEX IF NOT EXISTS transactions_user_idempotency_unique
ON transactions (user_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

-- SPEED UP PENDING TRANSACTION LOOKUPS
CREATE INDEX IF NOT EXISTS transactions_pending_idx
ON transactions (status, created_at)
WHERE status = 'PENDING';
-- DATA PURCHASE REFUND PROTECTION

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS refund_of_transaction_id UUID
REFERENCES transactions(id);

-- Prevent multiple refunds for one transaction
CREATE UNIQUE INDEX IF NOT EXISTS transactions_single_refund_unique
ON transactions (refund_of_transaction_id)
WHERE refund_of_transaction_id IS NOT NULL;
