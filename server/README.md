# Neelkora server

Serves the site in `../rawmango` and the API under `/api`, with a SQLite database. No packages to install.

## Run it

Needs Node.js 22.5 or newer (built-in `node:sqlite`).

```
node server/server.js
```

Open http://localhost:5173. The database file `server/neelkora.db` is created on first run. Delete it to start fresh.

## What works without any keys (development)

| Feature | Without keys |
|---|---|
| Accounts, email + password | Fully working (scrypt-hashed passwords, httpOnly session cookie) |
| Phone sign-in | Code is printed in this console and shown on the login page |
| Payments | Test payment window, no money moves |
| Order email | Built and saved in the `emails` table, viewable as the receipt |
| Google sign-in | Off |

With `NODE_ENV=production`, the development shortcuts are refused: no on-screen codes and no test payments.

## Going live

Copy `.env.example` to `.env` and fill in:

1. **Razorpay**: `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`. The server creates each Razorpay order for the amount it calculated and checks Razorpay's signature before marking an order paid.
2. **Resend** (email): `RESEND_API_KEY` and a `MAIL_FROM` on a domain you verified in Resend.
3. **Twilio** (SMS codes): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.
4. **Google**: `GOOGLE_CLIENT_ID`. The server verifies every Google token with Google before signing anyone in.
5. Set `NODE_ENV=production` and run behind HTTPS (cookies are then marked Secure).

Restart the server after editing `.env`. The startup line shows which services are live.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/me` | Current user, profile, wishlist, orders |
| POST | `/api/auth/signup`, `/api/auth/login`, `/api/auth/logout` | Email accounts |
| POST | `/api/auth/google` | Sign in with a Google ID token |
| POST | `/api/auth/otp/send`, `/api/auth/otp/verify` | Phone sign-in codes |
| PUT | `/api/profile`, `/api/wishlist` | Save addresses, UPI IDs, cards (last 4 only), name, wishlist |
| POST | `/api/orders` | Create an order; the server prices it from `rawmango/catalog.js` |
| POST | `/api/orders/pay` | Confirm a payment (signature checked) |
| GET | `/api/orders/receipt?id=&t=` | The order email, needs the order's secret token |

## Limits worth knowing

- Rate limits are kept in memory, so they reset on restart and do not span several server processes.
- Password reset by email is not built yet.
- Cancelled payments leave an order in `pending_payment`; nothing is charged for those.
