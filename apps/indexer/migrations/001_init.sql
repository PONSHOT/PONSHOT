-- PONS Prediction read model.
--
-- Two rules shape this schema:
--
--  1. **The chain is the source of truth.** Nothing here decides an outcome; every row
--     is derived from a log the contract emitted. If this database were dropped it could
--     be rebuilt from chain state alone, which is why there is no bookkeeping that is not
--     also recoverable.
--
--  2. **Every write is idempotent.** Reorgs, restarts and overlapping backfills all
--     replay logs the indexer has already seen. Each table is therefore keyed by the
--     log's own identity (chain, block, transaction, log index), so a replay collides
--     rather than duplicating.

CREATE TABLE IF NOT EXISTS indexer_state (
    id                TEXT PRIMARY KEY,
    chain_id          BIGINT      NOT NULL,
    contract          TEXT        NOT NULL,
    last_block        BIGINT      NOT NULL,
    last_block_hash   TEXT,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw log identity, so any event can be traced back and de-duplicated.
CREATE TABLE IF NOT EXISTS events (
    chain_id      BIGINT      NOT NULL,
    block_number  BIGINT      NOT NULL,
    block_hash    TEXT        NOT NULL,
    tx_hash       TEXT        NOT NULL,
    log_index     INTEGER     NOT NULL,
    name          TEXT        NOT NULL,
    epoch         NUMERIC(78, 0),
    payload       JSONB       NOT NULL,
    block_time    TIMESTAMPTZ,
    PRIMARY KEY (chain_id, block_number, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS events_name_idx  ON events (chain_id, name, block_number DESC);
CREATE INDEX IF NOT EXISTS events_epoch_idx ON events (chain_id, epoch);
CREATE INDEX IF NOT EXISTS events_block_idx ON events (chain_id, block_number DESC);

CREATE TABLE IF NOT EXISTS markets (
    chain_id        BIGINT PRIMARY KEY,
    prediction      TEXT        NOT NULL,
    oracle          TEXT        NOT NULL,
    pons            TEXT        NOT NULL,
    weth            TEXT        NOT NULL,
    pool            TEXT        NOT NULL,
    deployed_block  BIGINT      NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rounds (
    chain_id          BIGINT         NOT NULL,
    epoch             NUMERIC(78, 0) NOT NULL,
    start_timestamp   BIGINT         NOT NULL,
    lock_timestamp    BIGINT         NOT NULL,
    close_timestamp   BIGINT         NOT NULL,
    lock_price        NUMERIC(78, 0),
    close_price       NUMERIC(78, 0),
    lock_tick         INTEGER,
    close_tick        INTEGER,
    -- Execution times are kept apart from scheduled times on purpose: the difference is
    -- keeper lateness, and hiding it would hide the one thing worth monitoring.
    locked_at         BIGINT,
    settled_at        BIGINT,
    total_amount      NUMERIC(78, 0) NOT NULL DEFAULT 0,
    bull_amount       NUMERIC(78, 0) NOT NULL DEFAULT 0,
    bear_amount       NUMERIC(78, 0) NOT NULL DEFAULT 0,
    reward_base       NUMERIC(78, 0) NOT NULL DEFAULT 0,
    reward_amount     NUMERIC(78, 0) NOT NULL DEFAULT 0,
    treasury_fee      NUMERIC(78, 0) NOT NULL DEFAULT 0,
    status            TEXT           NOT NULL DEFAULT 'OPEN',
    outcome           TEXT,
    cancel_reason     TEXT,
    oracle_address    TEXT,
    twap_window       INTEGER,
    treasury_fee_bps  INTEGER,
    oracle_version    BIGINT,
    PRIMARY KEY (chain_id, epoch)
);
CREATE INDEX IF NOT EXISTS rounds_status_idx ON rounds (chain_id, status);
CREATE INDEX IF NOT EXISTS rounds_lock_idx   ON rounds (chain_id, lock_timestamp DESC);

CREATE TABLE IF NOT EXISTS bets (
    chain_id      BIGINT         NOT NULL,
    epoch         NUMERIC(78, 0) NOT NULL,
    account       TEXT           NOT NULL,
    position      TEXT           NOT NULL,
    amount        NUMERIC(78, 0) NOT NULL,
    block_number  BIGINT         NOT NULL,
    tx_hash       TEXT           NOT NULL,
    log_index     INTEGER        NOT NULL,
    block_time    TIMESTAMPTZ,
    -- One position per wallet per round is a contract-level rule; making it the primary
    -- key means a bug that violated it would fail loudly here instead of double-counting.
    PRIMARY KEY (chain_id, epoch, account)
);
CREATE INDEX IF NOT EXISTS bets_account_idx ON bets (chain_id, account, epoch DESC);

CREATE TABLE IF NOT EXISTS claims (
    chain_id      BIGINT         NOT NULL,
    epoch         NUMERIC(78, 0) NOT NULL,
    account       TEXT           NOT NULL,
    amount        NUMERIC(78, 0) NOT NULL,
    kind          TEXT           NOT NULL,
    block_number  BIGINT         NOT NULL,
    tx_hash       TEXT           NOT NULL,
    log_index     INTEGER        NOT NULL,
    block_time    TIMESTAMPTZ,
    PRIMARY KEY (chain_id, epoch, account, kind)
);
CREATE INDEX IF NOT EXISTS claims_account_idx ON claims (chain_id, account, epoch DESC);

-- Rolled up from bets and claims so leaderboard and profile queries stay cheap.
CREATE TABLE IF NOT EXISTS users (
    chain_id       BIGINT NOT NULL,
    account        TEXT   NOT NULL,
    rounds_entered INTEGER        NOT NULL DEFAULT 0,
    rounds_won     INTEGER        NOT NULL DEFAULT 0,
    total_staked   NUMERIC(78, 0) NOT NULL DEFAULT 0,
    total_claimed  NUMERIC(78, 0) NOT NULL DEFAULT 0,
    total_refunded NUMERIC(78, 0) NOT NULL DEFAULT 0,
    first_seen     TIMESTAMPTZ,
    last_seen      TIMESTAMPTZ,
    PRIMARY KEY (chain_id, account)
);

CREATE TABLE IF NOT EXISTS oracle_observations (
    chain_id      BIGINT         NOT NULL,
    epoch         NUMERIC(78, 0) NOT NULL,
    kind          TEXT           NOT NULL,
    instant       BIGINT         NOT NULL,
    price         NUMERIC(78, 0) NOT NULL,
    tick          INTEGER,
    executed_at   BIGINT         NOT NULL,
    -- Seconds between the instant being priced and the transaction that recorded it.
    -- This is the seal lag, and it is the headline health metric for the whole system.
    lag_seconds   BIGINT         NOT NULL,
    tx_hash       TEXT           NOT NULL,
    PRIMARY KEY (chain_id, epoch, kind)
);

CREATE TABLE IF NOT EXISTS keeper_executions (
    chain_id      BIGINT  NOT NULL,
    tx_hash       TEXT    NOT NULL,
    block_number  BIGINT  NOT NULL,
    sender        TEXT    NOT NULL,
    action        TEXT    NOT NULL,
    epoch         NUMERIC(78, 0),
    block_time    TIMESTAMPTZ,
    PRIMARY KEY (chain_id, tx_hash, action, epoch)
);

CREATE TABLE IF NOT EXISTS treasury_events (
    chain_id      BIGINT         NOT NULL,
    tx_hash       TEXT           NOT NULL,
    log_index     INTEGER        NOT NULL,
    block_number  BIGINT         NOT NULL,
    kind          TEXT           NOT NULL,
    amount        NUMERIC(78, 0),
    detail        JSONB,
    block_time    TIMESTAMPTZ,
    PRIMARY KEY (chain_id, tx_hash, log_index)
);
