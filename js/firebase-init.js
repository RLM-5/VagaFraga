import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, runTransaction,
  collection, query, where, onSnapshot, serverTimestamp, deleteField
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

export const authReady = new Promise((resolve, reject) => {
  onAuthStateChanged(auth, (user) => {
    if (user) resolve(user);
  });
  signInAnonymously(auth).catch(reject);
});

export {
  doc, getDoc, setDoc, updateDoc, runTransaction,
  collection, query, where, onSnapshot, serverTimestamp, deleteField
};
