-- Records which *instance* of a chain the read model was built from.
--
-- A chain id is not an identity. A local devnet torn down and recreated, or a network
-- replayed from genesis, reuses the same id and — with deterministic deployment — the
-- same contract addresses, while every block and every event underneath is different.
-- Comparing cursor position cannot detect that: the new chain simply grows past the old
-- cursor and the indexer carries on appending to a history that never happened.
--
-- The genesis block hash does identify the instance, so it is stored and checked.
ALTER TABLE indexer_state ADD COLUMN IF NOT EXISTS genesis_hash TEXT;
