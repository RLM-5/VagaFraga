// Config for the SEPARATE test Firebase project (vagafraga-test), kept here
// for future local testing so it never gets mixed up with the real
// production project (vagafraga) that the live site actually points to.
//
// To test locally against this project instead of production: copy this
// file's contents over js/firebase-config.js before running a local server,
// and copy them back (or `git checkout js/firebase-config.js`) before
// committing anything — never let a commit point the live site at the test
// project.
export const firebaseConfig = {
  apiKey: "AIzaSyAQyI6CC3x41WU-7OjuTJ5ZyNNjhwonFsg",
  authDomain: "vagafraga-test.firebaseapp.com",
  projectId: "vagafraga-test",
  storageBucket: "vagafraga-test.firebasestorage.app",
  messagingSenderId: "835790241060",
  appId: "1:835790241060:web:3a1f33f325fd1939ae87b1"
};
