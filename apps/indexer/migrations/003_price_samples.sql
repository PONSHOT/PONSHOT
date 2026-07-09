-- Price series backing the candlestick chart.
--
-- Round boundaries alone cannot make candles: they give one reading per round, so every
-- candle would be a single point with open == high == low == close. A chart needs the
-- price *between* boundaries, so the indexer samples the oracle on its own tick and
-- stores both figures.
--
-- Both are kept deliberately. `spot` is what a chart should plot -- it moves with every
-- trade and is what a trader recognises. `twap` is what actually settles rounds. Storing
-- only one would force the UI to either show a chart that disagrees with settlement, or a
-- flat line that looks broken.
CREATE TABLE IF NOT EXISTS price_samples (
    chain_id   BIGINT         NOT NULL,
    ts         BIGINT         NOT NULL,  -- chain time, not wall clock
    spot       NUMERIC(78, 0) NOT NULL,
    twap       NUMERIC(78, 0),
    tick       INTEGER,
    PRIMARY KEY (chain_id, ts)
);
CREATE INDEX IF NOT EXISTS price_samples_ts_idx ON price_samples (chain_id, ts DESC);
