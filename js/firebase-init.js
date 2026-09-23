import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, runTransaction,
  collection, query, where, onSnapshot, serverTimestamp, deleteField
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// authReady never rejects — it just takes longer. It used to reject on a
// failed sign-in (dropped connection, transient outage), and because it's
// one shared promise, that single rejection permanently poisoned every
// future `await authReady` anywhere in the app for the rest of the page's
// life, even after connectivity came back, with no way to recover short of
// a reload. Instead it retries quietly with backoff until sign-in succeeds;
// callers that need a bounded wait use authReadyWithin() below rather than
// awaiting this directly, so a genuinely offline visitor still gets timely
// feedback instead of hanging forever.
export const authReady = new Promise((resolve) => {
  onAuthStateChanged(auth, (user) => {
    if (user) resolve(user);
  });
  let delay = 2000;
  const attempt = () => {
    signInAnonymously(auth).catch((err) => {
      console.error("Anonymous sign-in failed, retrying:", err);
      setTimeout(attempt, delay);
      delay = Math.min(delay * 2, 30000);
    });
  };
  attempt();
});

// Resolves true once authReady resolves, or false after `ms` — never
// rejects. Lets a caller give up on a genuinely stuck connection with a
// clear message instead of awaiting authReady directly and hanging (or,
// before this file's fix, throwing) indefinitely.
export function authReadyWithin(ms) {
  return Promise.race([
    authReady.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

export {
  doc, getDoc, getDocs, setDoc, updateDoc, runTransaction,
  collection, query, where, onSnapshot, serverTimestamp, deleteField
};
