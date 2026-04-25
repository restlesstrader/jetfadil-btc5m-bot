# JetFadil BTC 5m Bot v3.2 Railway Dashboard

## How to run locally

```bash
npm install
npm start
```

Then open:

```txt
http://localhost:3000
```

## Railway

1. Upload/push these files to GitHub.
2. In Railway, connect the GitHub repo.
3. Make sure Start Command is:

```bash
npm start
```

4. Click **Generate Domain**.
5. Open the Railway domain.

## Important

The bot strategy logic was not changed. This version only adds an HTTP dashboard server using `process.env.PORT || 3000`.

Dashboard routes:

```txt
/
 /api/state
 /api/status.txt
 /health
```

Main file:

```txt
jetfadil_style_btc5m_paper_v3_2_dashboard.js
```
