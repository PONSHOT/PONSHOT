-- Burn tokenomics: the protocol fee is no longer a treasury take.
--
-- Under the launch tokenomics a contested round pays 90% of the pot to the winning side
-- and books the remaining 10% for buyback and burn, split evenly between PONS and the
-- project token. A round where every entry was on the losing side books the whole pot,
-- and carries the new outcome 'ALL_LOST'.
--
-- The columns are renamed rather than added because they never meant "treasury" in the
-- new deployment, and leaving a column called treasury_fee holding burn allocations is
-- how a reporting query ends up saying something false.
--
-- `outcome` is TEXT, so 'ALL_LOST' needs no type change. Existing rows keep their values.

ALTER TABLE rounds RENAME COLUMN treasury_fee     TO burn_fee;
ALTER TABLE rounds RENAME COLUMN treasury_fee_bps TO burn_fee_bps;

ALTER TABLE treasury_events RENAME TO burn_events;

-- Buybacks executed by PonsBuybackBurner. One row per burn, so the burned supply shown
-- anywhere is a sum over observed events rather than a number somebody typed.
CREATE TABLE IF NOT EXISTS burns (
    chain_id     BIGINT         NOT NULL,
    tx_hash      TEXT           NOT NULL,
    log_index    INTEGER        NOT NULL,
    block_number BIGINT         NOT NULL,
    target_index SMALLINT       NOT NULL,
    token        TEXT           NOT NULL,
    eth_in       NUMERIC(78, 0) NOT NULL,
    burned       NUMERIC(78, 0) NOT NULL,
    floor_amount NUMERIC(78, 0) NOT NULL DEFAULT 0,
    block_time   TIMESTAMPTZ,
    PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS burns_target_idx ON burns (chain_id, target_index);
CREATE INDEX IF NOT EXISTS burns_block_idx  ON burns (chain_id, block_number DESC);
