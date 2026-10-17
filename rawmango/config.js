// Fallback only. When the site runs through the server (node server/server.js), the server answers /config.js itself
// with the public keys from server/.env, and this file is never used. All keys now live in server/.env.
window.NK_CONFIG = {razorpayKey: '', googleClientId: '', live: {pay: false, mail: false, sms: false, google: false}, api: false};
