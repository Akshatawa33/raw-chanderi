// Firebase phone sign-in (official modular SDK, served by Google; the same code as the `firebase` npm package).
// The config comes from server/.env through /config.js, so no keys are written into the site.
// Flow: sendCode() texts a code via Firebase -> confirmCode() checks it -> returns an ID token the server verifies.
import {initializeApp} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {getAuth, RecaptchaVerifier, signInWithPhoneNumber, signOut} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const config = (window.NK_CONFIG || {}).firebase;
if (!config) throw new Error('Firebase is not configured');

const auth = getAuth(initializeApp(config));
auth.useDeviceLanguage();   // the SMS text arrives in the visitor's language

// invisible reCAPTCHA: Google checks the visitor is a person without showing a puzzle (it may show one if unsure)
let verifier = null;
const getVerifier = () => verifier || (verifier = new RecaptchaVerifier(auth, 'recaptcha-container', {size: 'invisible'}));
const resetVerifier = () => { try { verifier && verifier.clear(); } catch {} verifier = null; };

// plain-language messages for every error a shopper can actually hit
const MESSAGES = {
  'auth/invalid-phone-number': 'That number does not look right. Check the country code and the number.',
  'auth/missing-phone-number': 'Enter your mobile number.',
  'auth/too-many-requests': 'Too many attempts from this device. Please wait a few minutes and try again.',
  'auth/quota-exceeded': 'We cannot send codes right now. Please use email to sign in for the moment.',
  'auth/captcha-check-failed': 'The security check did not pass. Please try again.',
  'auth/invalid-app-credential': 'The security check did not pass. Please reload the page and try again.',
  'auth/network-request-failed': 'You seem to be offline. Check your connection and try again.',
  'auth/invalid-verification-code': 'That code is not right. Check the text message and try again.',
  'auth/code-expired': 'That code has expired. Tap Resend to get a new one.',
  'auth/session-expired': 'That code has expired. Tap Resend to get a new one.',
  'auth/missing-verification-code': 'Enter the 6-digit code.',
  'auth/operation-not-allowed': 'Phone sign-in is switched off for this shop. Please use email for now.',
  'auth/unauthorized-domain': 'Phone sign-in is not allowed on this address yet. Add it under Firebase > Authentication > Settings > Authorized domains.',
};
const friendly = err => Object.assign(new Error(MESSAGES[err && err.code] || 'Something went wrong with phone sign-in. Please try again.'), {code: err && err.code});

// phone must be E.164, e.g. +919876543210. Resolves a confirmation to pass to confirmCode().
export async function sendCode(phone) {
  resetVerifier();   // a fresh check for every send, including Resend
  try { return await signInWithPhoneNumber(auth, phone, getVerifier()); }
  catch (err) { resetVerifier(); throw friendly(err); }   // a used or failed reCAPTCHA cannot be reused
}

// Resolves the Firebase ID token for the server. The Firebase session itself is closed straight away:
// the shop's own session (an httpOnly cookie from our server) is the one that matters.
export async function confirmCode(confirmation, code) {
  try {
    const cred = await confirmation.confirm(code);
    const idToken = await cred.user.getIdToken();
    signOut(auth).catch(() => {});
    return idToken;
  } catch (err) { throw friendly(err); }
}
