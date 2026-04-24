JETFADIL BTC 5M BOT + DASHBOARD - RAILWAY DEPLOY

IMPORTANT:
This bundle is for a normal Railway Node.js app, NOT Railway Function.
Do not paste the bot into Railway Source Code Function.

FILES INSIDE THIS BUNDLE:
- package.json
- railway.json
- prepare_dashboard_patch.js
- .gitignore

YOU MUST ADD YOUR ORIGINAL BOT FILE:
- jetfadil_style_btc5m_paper_v1.js

The file name must be exactly:
jetfadil_style_btc5m_paper_v1.js

==================================================
OPTION A - EASIEST WITH GITHUB
==================================================

1. On your computer, create a folder:
   jetfadil-btc-5m-dashboard

2. Put these files inside that folder:
   package.json
   railway.json
   prepare_dashboard_patch.js
   .gitignore
   jetfadil_style_btc5m_paper_v1.js

3. Upload that folder to a new GitHub repository.

4. In Railway:
   New Project
   Deploy from GitHub repo
   Select your repository

5. Railway should install dependencies automatically.

6. When deployment finishes, open Deploy Logs.
   You should see:
   Dashboard bot ready: jetfadil_style_btc5m_paper_v1_dashboard.js
   DASHBOARD_RUNNING | port=xxxx
   BOOT
   ACTIVE_SLUG
   ws subscribed

7. Go to:
   Settings -> Networking -> Public Networking -> Generate Domain

8. Open your Railway URL.
   Example:
   https://your-project.up.railway.app

==================================================
OPTION B - TEST LOCALLY FIRST
==================================================

In the folder, run:

npm install
npm start

Then open:

http://localhost:3000

==================================================
WHAT THE DASHBOARD SHOWS
==================================================

- Bot status
- Realized P&L
- Unrealized P&L
- Available cash
- Locked capital
- UP/DOWN price
- Slug timer
- Score
- Winrate
- Open lots
- Recent actions
- Recent logs
- P&L chart

==================================================
IF RAILWAY DOES NOT OPEN THE PAGE
==================================================

Check these things:

1. You deployed from GitHub repo, not Function.
2. The file jetfadil_style_btc5m_paper_v1.js exists.
3. Deploy Logs say DASHBOARD_RUNNING.
4. Networking has a generated public domain.
5. Do not manually set npm install in Start Command.

The package.json already contains the correct start command:

node prepare_dashboard_patch.js jetfadil_style_btc5m_paper_v1.js && node jetfadil_style_btc5m_paper_v1_dashboard.js
