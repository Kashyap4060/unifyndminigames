-- =============================================================================
-- Demo seed — run once against a freshly loaded schema (npm run db:seed).
-- Creates one player (user_id 1) and Game #1 = Russian Roulette so the client's
-- default (gameId=1) works out of the box. game_key MUST match a registered
-- engine ('russian_roulette').
-- =============================================================================

INSERT INTO users (external_uid, points_balance, status)
VALUES (UUID(), 5000, 'ACTIVE');

INSERT INTO games_directory (game_key, display_name, game_type, status, min_bet, max_bet)
VALUES ('russian_roulette', 'Russian Roulette', 'LUCK', 'ACTIVE', 10, 500);

-- Optional: uncomment to also seed the other Part A betting games (ids 2+).
-- INSERT INTO games_directory (game_key, display_name, game_type, status, min_bet, max_bet) VALUES
--   ('crash',            'Crash',            'LUCK', 'ACTIVE', 10, 500),
--   ('hi_lo',            'Hi-Lo',            'LUCK', 'ACTIVE', 10, 500),
--   ('dice_tower',       'Dice Tower',       'LUCK', 'ACTIVE', 10, 500),
--   ('shell_game',       'Shell Game',       'LUCK', 'ACTIVE', 10, 500),
--   ('coin_flip',        'Coin Flip',        'LUCK', 'ACTIVE', 10, 500),
--   ('vault',            'The Vault',        'LUCK', 'ACTIVE', 10, 500),
--   ('derby',            'Derby',            'LUCK', 'ACTIVE', 10, 500),
--   ('penalty_shootout', 'Penalty Shootout', 'LUCK', 'ACTIVE', 10, 500),
--   ('plinko',           'Plinko',           'LUCK', 'ACTIVE', 10, 500),
--   ('minesweeper',      'Minesweeper',      'LUCK', 'ACTIVE', 10, 500);
