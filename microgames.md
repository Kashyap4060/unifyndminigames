# SYSTEM ARCHITECTURE & PROMPTING BLUEPRINT: MODULAR IN-APP GAMING ECOSYSTEM
**Target System:** High-Scalability, API-Driven WebViews within an existing Mobile App
**Database Engine:** MySQL (Strict ACID Compliant)
**AI Prompting Strategy:** Extensible Game-Engine Architecture

---

## 1. TECH STACK & SYSTEM INFRASTRUCTURE

To achieve seamless scaling, absolute security against point manipulation, and the ability to drop in new games without refactoring, the system must split the presentation layer from the transactional layer.

### Frontend Layer (The Gaming Client)
*   **Skill/Logic Games:** Phaser.js (HTML5 game engine). Renders lightweight canvas assets, runs local frame ticks, and captures user inputs.
*   **Luck/Betting Games & Core UI:** React.js / Vue.js + Tailwind CSS. Ideal for handling menus, forms (bet entries), data tables (Leaderboards), and CSS-driven luck animations (Spin wheels, cards, roulette cylinders).
*   **Mobile App Hook:** Standard Mobile WebView Component (`react-native-webview` or native iOS/Android WebViews). The app injects a secure JWT (JSON Web Token) inside the headers or URL parameters upon launch.

### Backend & API Layer (The Economy Engine)
*   **Runtime:** Node.js (Express/Fastify) or Python (FastAPI). Fast, asynchronous I/O to handle thousands of concurrent requests.
*   **Communication:** Restful JSON APIs + WebSockets (only for real-time multiplayer features like chat or live invite status).

### Database & Cache Layer (The Source of Truth)
*   **Primary DB:** MySQL 8.x+. Handles user points accounts, coupon management, ledger transactions, and referral logging. Relies heavily on **InnoDb Row-Level Locking** to prevent race conditions during betting events.
*   **Caching Core:** Redis. Handles ephemeral user sessions and high-read live leaderboards via Sorted Sets (`ZADD`, `ZREVRANGE`).

---

## 2. THE EXTENSIBLE EXTENSION ARCHITECTURE (How to Add Games Later)

To add more games seamlessly in the future without altering core logic, the system uses a **Plugin-Based Factory Pattern**. 

Instead of writing custom backend tables for every individual game, the engine views every game as a uniform transaction entity through an abstract interface:



# PRODUCT SPECIFICATION DIRECTORY: 30 MODULAR IN-APP MICRO-GAMES

This document contains the exact technical mechanics, client interface designs, and backend API logic for all 30 games in the ecosystem. 

---

## PART A: RISK & BETTING GAMES (LUCK/PROBABILITY BASED)

### 1. Russian Roulette (The Chamber)
*   **Client Interface:** React/Tailwind. A stylized 3D or flat vector graphic of a 6-slot revolver cylinder. 
*   **API Logic:** User passes their entry stake to `/api/game/initiate`. The backend generates an array of 6 elements where one random index contains a `1` (bullet) and five contain `0`. This state is hashed and stored in the database's `game_metadata` JSON field. For every trigger pull, the user hits `/api/game/process`. If they land on a 0, their payout multiplier increases. They can choose to execute a `settle` request to claim their accumulated points or pull the trigger again, risking everything.

### 2. Crash (The Rocket)
*   **Client Interface:** React Canvas. A rocket vector taking off, accelerating upwards along an exponential curve graph as a multiplier text grows (`1.1x`, `1.5x`, `3.0x`, etc.).
*   **API Logic:** When the game starts, the backend server uses a random number generator to pick a pre-determined "crash point" multiplier (e.g., `2.43x`). As the user watches the rocket fly, they must send a `/settle` request before the game ticker matches or exceeds the backend's hidden crash point. If the server receives the `settle` request at `2.1x`, the player wins. If they wait too long, the rocket explodes, and the backend marks the status as `failed`.

### 3. Plinko (The Peg Board)
*   **Client Interface:** Phaser.js. A series of pegs arranged in a triangle. A circular token drops from the apex, bouncing left or right based on physical calculations.
*   **API Logic:** The visual movement can happen on the client side, but the final resting slot must be calculated on the backend. When `/initiate` is called, the server uses a random walk algorithm (Galton Board calculation) to determine the exact ending bucket (e.g., `Slot 4, Multiplier 0.5x` or `Slot 0, Multiplier 10x`). The backend saves this outcome and tells the frontend which trajectory to animate.

### 4. Hi-Lo (Next Card)
*   **Client Interface:** React UI. Displays a clean graphic of a playing card (e.g., 7 of Spades) and two prominent buttons: "Higher" or "Lower".
*   **API Logic:** The server populates `game_metadata` with a randomized, shuffled card array. The user bets points and guesses. Every successful guess updates the session state in the database and increments their prospective multiplier. An incorrect guess immediately closes the session and clears their bet.

### 5. The Dice Tower
*   **Client Interface:** React. Elegant 3D CSS dice container.
*   **API Logic:** The user submits a wager and picks a condition (e.g., "Sum greater than 7", "Double Sixes"). The backend instantly generates two random integers between 1 and 6, writes the record to the ledger, and sends the final dice faces back to the UI to trigger the animation.

### 6. Shell Game (Three Cups)
*   **Client Interface:** Phaser.js. Displays three identical inverted cups that rapidly cross over each other in an animation sequence.
*   **API Logic:** The shuffling is completely cosmetic. The backend decides which cup index (`0`, `1`, or `2`) holds the reward token at the moment `/initiate` is processed. The user clicks a cup, sending their choice via API. The backend compares the index and returns the win/loss state.

### 7. Minesweeper Betting (Diamond Hunt)
*   **Client Interface:** React Grid. A clean 5x5 collection of unrevealed grey tiles.
*   **API Logic:** The user specifies how many hidden mines they want on the board (e.g., 3 mines out of 25 tiles) along with their wager. The backend populates a hidden matrix of tiles containing gems and mines. Each tile the user flips makes an API call to verify it is clear. Finding a gem increases the multiplier and unlocks a "Cash Out" button. Hitting a mine instantly terminates the active session.

### 8. Coin Flip Double-or-Nothing
*   **Client Interface:** React CSS 3D Transform animation. A metallic gold coin spinning along its Y-axis.
*   **API Logic:** Pure 50/50 binary choice request. The server flips a digital coin, calculates the transaction, updates the MySQL ledger, and returns the result to display "Heads" or "Tails".

### 9. Coin Pusher (The Arcade Dozer)
*   **Client Interface:** Phaser.js. A 2D perspective of an automated platform moving forward and backward, sliding coins toward a ledge.
*   **API Logic:** Each click costs the user points. The backend acts as a regulator, evaluating the probability of item drops and coin spillover using a standardized rate limit to balance point entry vs. reward payouts.

### 10. Baccarat Mini
*   **Client Interface:** React table view. Simple options to place point stacks on "Player", "Banker", or "Tie".
*   **API Logic:** The system draws digital cards according to standard regulatory Baccarat draw conditions entirely on the backend server, calculating the winning side in milliseconds and updating balances instantly.

### 11. Horse/Car Derby Tracker
*   **Client Interface:** React Canvas. Six simple colorful vehicles or characters lined up on horizontal race tracks.
*   **API Logic:** Every vehicle is assigned pseudo-random acceleration values across a simulated timeline on the backend. The user bets points on an index. The server saves the winning index, tracks the placement orders, and sends the relative positioning vectors to the frontend client to play back as a smooth race.

### 12. The Vault (Key Cracker)
*   **Client Interface:** React UI. A safe handle surrounded by a sequence of five digital keys.
*   **API Logic:** A tiered probability game. The entry point cost is set. The server randomly tags one key as the success key. The user selects a key; the backend checks if it matches and updates point balances or grants a coupon item if successful.

### 13. Plinko-Pachinko Hybrid
*   **Client Interface:** Phaser.js. A peg board that includes capture pockets along the walls that redirect tokens.
*   **API Logic:** Similar to Plinko, the path vectors and intercept conditions are handled as discrete random variable tables generated on the server side to protect against client memory injections.

### 14. Up or Down (Market Simulator)
*   **Client Interface:** React canvas chart line updating every second based on simulated market noise.
*   **API Logic:** The backend runs a tick interval loop that shifts a dummy value up or down. Users place bets inside a specific window. At the end of the countdown, the backend freezes the value and settles bets for users who picked correctly.

### 15. Target Shootout (Penalty Kick)
*   **Client Interface:** Phaser.js. A goalie moving back and forth in front of a divided target net.
*   **API Logic:** The user chooses a corner to shoot. The server calculates an intersection chance weighted against any point multipliers active on the user's account, determining whether the ball hits the back of the net or gets blocked.

---

## PART B: ENGAGEMENT & RETENTION GAMES (SKILL/LOGIC BASED)

### 16. Wordle Clone (Grid Word Hunt)
*   **Client Interface:** React input boxes. A 5x6 character input grid.
*   **API Logic:** The server selects a daily word token. As the user submits guesses, the backend checks individual characters and returns positional validity arrays (e.g., `[Correct, Absent, Misplaced]`), matching the response to prevent client-side inspection from revealing the solution.

### 17. 2048 (Block Merger)
*   **Client Interface:** Phaser.js or React UI. A 4x4 sliding grid of numeric cards.
*   **API Logic:** The user plays locally to optimize performance. When the user runs out of possible moves, the client submits the complete move logs or the final layout score matrix to `/api/game/settle`. The server validates the telemetry logic and logs the high score to the Redis leaderboard.

### 18. Block Drop Puzzle (10x10 Tetris-style Grid)
*   **Client Interface:** Phaser.js. Drag-and-drop mechanics for grid blocks.
*   **API Logic:** The local client handles grid state transitions and line clearing. Upon failure, the final calculated score is validated by checking total active playing time against reasonable maximum score bounds on the server before updating user points.

### 19. Endless Runner (The Mascot Dash)
*   **Client Interface:** Phaser.js. Side-scrolling obstacle avoidance framework running at 60 FPS.
*   **API Logic:** To minimize latency, the client handles the active gameplay. The server provides a cryptographically signed timestamp seed when the game starts. When the player crashes, the score along with the verified timestamp seed is sent back to prevent users from fabricating scores via proxy inspection tools.

### 20. Hexa-Sort (Color Stack)
*   **Client Interface:** Phaser.js. A collection of interlocking hexagonal slots where colored plates align and stack automatically.
*   **API Logic:** The client handles matching animations. Upon game completion, it posts the session performance data to the backend API to award loyalty currency.

### 21. Tower Builder (Stacker)
*   **Client Interface:** Phaser.js. A crane block swinging horizontally; clicking releases the block onto a growing stack.
*   **API Logic:** The client measures alignment variances. Once the tower falls over, the total height count is transmitted to the server to compute the final reward tier.

### 22. Anagram Word Connect
*   **Client Interface:** React SVG circle link interface. Users swipe across a character circle to discover word patterns.
*   **API Logic:** The available words are validated on the backend. When a user creates a string, the word is sent to the server to check against an internal dictionary database, ensuring clients cannot inject custom strings to bypass validation.

### 23. Memory Match (Audio/Sequence)
Client Interface: React grid interface. Four color quadrants that flash sequentially.API Logic: The sequence array is generated step-by-step by the server or generated locally using a deterministic random seed verified by the API upon completion to track score validity.24. Bubble Shooter Match-3Client Interface: Phaser.js. A bubble launcher array pointing toward an overhead cluster grid.API Logic: The system processes active bubble matches locally. Once the game ends, the score is sent to the server via an authenticated API endpoint to distribute experience points or marketplace coupons.25. Knife Hit (Target Throw)Client Interface: Phaser.js. A rotating circle target vector that shifts speed and direction dynamically.API Logic: The client engine registers hit collisions. The final score is transmitted via API and cross-checked against standard game run length limits to flag anomalies.26. Traffic Control (Unblock Me)Client Interface: React/Tailwind. A sliding grid configuration of horizontal and vertical vehicle blocks.API Logic: The system serves pre-defined puzzle layouts from a master MySQL directory table. Once the solution path is completed, the API marks that level ID as resolved for the user and issues a fixed completion payout.27. Color FloodClient Interface: React table grid. A complex array of multi-colored tile coordinates.API Logic: The API serves the initial color distribution map. The user submits their step-by-step color change inputs, allowing the backend to reconstruct the game path to verify it was solved within the move limit.28. Fruit Slice (Ninja style)Client Interface: Phaser.js canvas. Registered touch vectors slice through ascending target meshes.API Logic: The client engine monitors combos and tracks scoring events. Upon game termination, the score payload is securely dispatched to the backend api for point validation.29. Math/Logic SprintClient Interface: React UI. A fast-moving progress bar displaying basic mathematical equations with True/False buttons.API Logic: Equations are served sequentially or verified via a seed value on the backend to measure response times, preventing scripted bots from farming points instantly.30. Connect Four (PvE or PvP)Client Interface: React/WebSockets. A classic 7x6 slot vertical chip board interface.API Logic: For Player-vs-Environment (PvE), a server-side script calculates the optimal next move. For Player-vs-Player (PvP), an open WebSocket gateway syncs chip placements between both active user session tokens in real time, validating wins and updating leaderboards upon victory.