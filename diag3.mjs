import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { getDatabase, ref, get, query, orderByChild, startAt, endAt } from "firebase/database";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => {
    const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)];
  })
);
const app = initializeApp({
  apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
});
const auth = getAuth(app);
const db = getDatabase(app);
const unameSnap = await get(ref(db, "usernames/lena_hoffmann"));
await signInWithEmailAndPassword(auth, unameSnap.val().email, "DemoPass123!");

for (const term of ["chris", "tobi", "mara", "xyz"]) {
  const q = query(ref(db, "newusers"), orderByChild("username"), startAt(term), endAt(term + ""));
  const snap = await get(q);
  const val = snap.val() || {};
  console.log(`Suche "${term}":`, Object.values(val).map(u => u.username));
}
