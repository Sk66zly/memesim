# MemeSim — memecoin paper-trading game

Trade real, trending Solana memecoins with **100% fake money**. Live prices come from DexScreener and GeckoTerminal; every trade is simulated.

## Run it on Windows (about 5 minutes)

1. **Install Node.js** — go to https://nodejs.org and download the **LTS** version. Run the installer and click Next through it.
2. **Unzip** `memesim.zip` somewhere easy, like `Documents\memesim`.
3. Open the `memesim` folder in File Explorer, click the address bar, type `cmd`, and press Enter. A black window opens in that folder.
4. Type this and press Enter:
   ```
   npm start
   ```
5. Open **http://localhost:3000** in Chrome or Edge. Make an account and start trading.

To stop the server, click the black window and press `Ctrl + C`. Your accounts and trades are saved in the `data` folder.

There is nothing to install with npm — the app uses only what comes with Node.js (version 22.13 or newer).

**No internet / testing?** Run `npm run demo` instead. It uses made-up coins and keeps its own separate save data.

## Try it on your phone

While the server runs on your PC, your phone (on the same Wi-Fi) can open `http://YOUR-PC-IP:3000`. Find your PC's IP by typing `ipconfig` in the black window (look for "IPv4 Address"). Windows may ask to allow Node.js through the firewall — allow it on private networks.

"Add to Home Screen" (installing it as an app) needs **https**, which you get once it's hosted online (see below).

## Settings

You can change these by putting them before the command, or in a file and running `node --env-file=yourfile server/index.js`:

| Setting | Default | What it does |
|---|---|---|
| `PORT` | 3000 | Web address port |
| `STARTING_USD` | 1000 | Mock USD for new accounts |
| `FAUCET_SOL` | 5 | Mock SOL per faucet claim |
| `FAUCET_COOLDOWN_MIN` | 10 | Minutes between faucet claims |
| `SNAPSHOT_MINUTES` | 15 | How often account values are logged |
| `TRENDING_COUNT` | 20 | How many trending coins to show |
| `MOCK_MARKET` | off | `1` = demo market with fake coins |
| `SECURE_COOKIES` | off | Set to `1` when hosted on https |
| `TRUST_PROXY` | off | Set to `1` behind a host like Render |
| `TURSO_DATABASE_URL` | — | Your Turso database URL (`libsql://…`) to keep data in the cloud |
| `TURSO_AUTH_TOKEN` | — | Token for that database |
| `DATA_DIR` | `./data` | Where the local database file lives |

## How the game works

- **Wallet:** new players get $1,000 mock USD. The faucet adds mock SOL valued at the live SOL price.
- **Trades:** buy or sell at the live market price, paying in mock USD or mock SOL.
- **Leaderboard:** ranks trading profit only. Profit = portfolio value − everything you were given (start money + faucet), so the faucet can't be used to climb the board. 24h / 30d / 60d use logged account snapshots.
- **Badges:**
  - 💎 Diamond Hands — hold one position 48h+ without selling any of it
  - 🐋 Whale Status — portfolio passes $50,000
  - 🧻 Paper Hands — sell within 5 minutes of buying
  - 🚀 Moonshot — a single sell locked in at more than +500%

## Project layout

```
server/index.js    web server + API + live price stream
server/market.js   live market data (trending, prices, candles, on-chain trades)
server/game.js     accounts, wallet, trades, badges, leaderboard
server/db.js       SQLite database tables
server/cloud.js    copies data to/from Turso so it survives restarts
public/            the app (HTML, CSS, JS, PWA files, icons)
```

## Put it online for free (Render + Turso)

Render runs the website. Turso keeps the player data. Both have free plans with no credit card.

**1. Make the database (Turso)**
1. Go to https://turso.tech and sign up (signing in with GitHub is easiest).
2. Create a database named `memesim`. Pick the US East region if you're asked (Render's free servers are in the US).
3. On the database's page, copy its **URL** (starts with `libsql://`).
4. Create a **token** for the database (read & write access) and copy it. Keep it private — it works like a password.

**2. Put the code on GitHub**
1. Make a free account at https://github.com. Click **+ → New repository**, name it `memesim`, and create it.
2. On the new repo page, click **uploading an existing file**. Drag in everything *inside* the unzipped `memesim` folder (the `server` and `public` folders, `package.json`, `render.yaml`, and the rest). Click **Commit changes**.

**3. Start the website (Render)**
1. Make a free account at https://render.com using **Sign in with GitHub**.
2. Click **New → Blueprint**, pick your `memesim` repo.
3. Render asks for `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Paste the URL and token from Turso, then click **Apply**.
4. After a few minutes your link appears at the top of the service page, like `https://memesim-xxxx.onrender.com`.

The site sleeps after 15 minutes with no visitors; the first visit after that takes about a minute while it wakes up. Accounts, trades, badges and the leaderboard are kept in Turso, so nothing resets.

**Check it's saving:** open `https://your-link.onrender.com/api/health`. It should show `"cloudSave":{"on":true`. If the server can't reach Turso when it starts, it stops with a message in Render's **Logs** tab (usually a mistyped URL or token) rather than starting with empty data.

### Update the site

Upload changed files to the GitHub repo the same way. Render redeploys automatically.

Once it's on https, phones can install it from the browser ("Add to Home Screen"), and tools like PWABuilder can wrap it for the app stores.
